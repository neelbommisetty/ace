import { generateObject, streamText, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import chalk from 'chalk';
import type { z } from 'zod';
import { loadAceConfig, type AceConfig } from './config.js';

export type LLMProvider = 'openai' | 'anthropic';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const mockLlm =
  process.env.ACE_E2E_MOCK_LLM === '1' || process.env.ACE_E2E_MOCK_LLM === 'true';

function getMockResponse(): string {
  const mode = process.env.ACE_MOCK_LLM_MODE || '';

  if (mode === 'generate') {
    return JSON.stringify(
      {
        title: 'Two Sum',
        slug: 'two-sum',
        description: 'Return indices of the two numbers such that they add up to target.',
        signature: 'export function twoSum(nums: number[], target: number): number[]',
      },
      null,
      2,
    );
  }

  if (mode === 'dispute') {
    return JSON.stringify(
      {
        verdict: 'test_incorrect',
        summary: 'The expected output for one case does not match the problem statement.',
        details: 'The failing assertion expects an index order that is not required by the spec.',
        failingTests: [
          {
            testName: 'handles duplicate values',
            verdict: 'test_incorrect',
            explanation: 'Either index order is acceptable, but the test fixes one order.',
            fixedAssertion: 'expect(result.sort()).toEqual([0, 1])',
          },
        ],
        fixedTestCode:
          "import { describe, it, expect } from 'vitest';\n\ndescribe('two sum', () => {\n  it('handles duplicate values', () => {\n    const result = [1, 0];\n    expect(result.sort()).toEqual([0, 1]);\n  });\n});\n",
      },
      null,
      2,
    );
  }

  if (mode === 'feedback') {
    return 'Overall 4/5\n\nClear solution structure and correct approach. Add a brief complexity note.';
  }

  return 'OK';
}

// Load config once at module level
let cachedConfig: AceConfig | null = null;

function getConfig(): AceConfig {
  if (!cachedConfig) {
    cachedConfig = loadAceConfig();
  }
  return cachedConfig;
}

function getAvailableProviders(): LLMProvider[] {
  const config = getConfig();
  const providers: LLMProvider[] = [];
  if (config.OPENAI_API_KEY) providers.push('openai');
  if (config.ANTHROPIC_API_KEY) providers.push('anthropic');
  return providers;
}

export function getDefaultProvider(): LLMProvider | null {
  const config = getConfig();
  const available = getAvailableProviders();
  if (available.length === 0) return null;

  // Respect saved preference if that provider is available
  if (config.default_provider && available.includes(config.default_provider as LLMProvider)) {
    return config.default_provider as LLMProvider;
  }

  // Default to openai if available, otherwise first available
  if (available.includes('openai')) return 'openai';
  return available[0];
}

export function requireProvider(preferred?: string): LLMProvider {
  if (mockLlm) {
    if (preferred === 'openai' || preferred === 'anthropic') {
      return preferred;
    }
    return 'openai';
  }

  const config = getConfig();

  if (preferred === 'openai' || preferred === 'anthropic') {
    const key = preferred === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    if (!config[key]) {
      console.error(chalk.red(`Error: ${key} is not configured.`));
      console.error(chalk.dim('Run `ace setup` to configure API keys.'));
      process.exit(1);
    }
    return preferred;
  }

  const provider = getDefaultProvider();
  if (!provider) {
    console.error(chalk.red('Error: No LLM API key found.'));
    console.error(chalk.dim('Run `ace setup` to configure API keys.'));
    process.exit(1);
  }
  return provider;
}

const OPENAI_MODEL = 'gpt-5.2';
const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';

function getModel(provider: LLMProvider): LanguageModel {
  const config = getConfig();
  if (provider === 'openai') {
    // .chat() pins the Chat Completions API rather than the Responses API.
    return createOpenAI({ apiKey: config.OPENAI_API_KEY }).chat(OPENAI_MODEL);
  }
  return createAnthropic({ apiKey: config.ANTHROPIC_API_KEY })(ANTHROPIC_MODEL);
}

function toCallInput(messages: LLMMessage[]): {
  instructions?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxOutputTokens: number;
} {
  // AI SDK 7 rejects system-role messages inside `messages`; the system
  // prompt must go through the top-level `instructions` param.
  const systemMsg = messages.find((m) => m.role === 'system');
  const nonSystemMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  return {
    ...(systemMsg ? { instructions: systemMsg.content } : {}),
    messages: nonSystemMessages,
    maxOutputTokens: 4096,
  };
}

export async function chatStream(
  provider: LLMProvider,
  messages: LLMMessage[],
): Promise<AsyncIterable<string>> {
  if (mockLlm) {
    const response = getMockResponse();
    return {
      async *[Symbol.asyncIterator]() {
        yield response;
      },
    };
  }

  const result = streamText({
    model: getModel(provider),
    ...toCallInput(messages),
  });
  return result.textStream;
}

export async function chatObject<T>(
  provider: LLMProvider,
  messages: LLMMessage[],
  schema: z.ZodType<T>,
): Promise<T> {
  if (mockLlm) {
    return schema.parse(JSON.parse(getMockResponse()));
  }

  const result = await generateObject({
    model: getModel(provider),
    ...toCallInput(messages),
    schema,
    // OpenAI strict mode rejects optional schema properties.
    providerOptions: { openai: { strictJsonSchema: false } },
  });
  return result.object;
}

export async function validateOpenAIKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  if (mockLlm) {
    return { valid: true };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      return { valid: false, error: `${response.status} ${response.statusText}` };
    }
    return { valid: true };
  } catch (err: any) {
    const message = err?.message || 'Unknown error';
    return { valid: false, error: message };
  }
}

export async function validateAnthropicKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  if (mockLlm) {
    return { valid: true };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (response.status === 401) {
      return { valid: false, error: 'Invalid API key (401 Unauthorized)' };
    }
    if (!response.ok) {
      return { valid: false, error: `${response.status} ${response.statusText}` };
    }
    return { valid: true };
  } catch (err: any) {
    const message = err?.message || 'Unknown error';
    return { valid: false, error: message };
  }
}
