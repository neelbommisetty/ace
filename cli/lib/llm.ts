import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
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

async function callOpenAI(messages: LLMMessage[], jsonMode = false): Promise<string> {
  const config = getConfig();
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

  const response = await client.chat.completions.create({
    model: 'gpt-5.2',
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: 0.7,
    // Some newer OpenAI models reject `max_tokens` in Chat Completions and require `max_completion_tokens`.
    ...( { max_completion_tokens: 4096 } as any ),
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });

  return response.choices[0]?.message?.content ?? '';
}

async function callAnthropic(messages: LLMMessage[], _jsonMode = false): Promise<string> {
  const config = getConfig();
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const systemMsg = messages.find((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 4096,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages: nonSystemMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  });

  const block = response.content[0];
  if (block.type === 'text') return block.text;
  return '';
}

export async function chat(
  provider: LLMProvider,
  messages: LLMMessage[],
  jsonMode = false,
): Promise<string> {
  if (mockLlm) {
    return getMockResponse();
  }

  if (provider === 'openai') {
    return callOpenAI(messages, jsonMode);
  }
  return callAnthropic(messages, jsonMode);
}

async function streamOpenAI(messages: LLMMessage[]): Promise<AsyncIterable<string>> {
  const config = getConfig();
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

  const stream = await client.chat.completions.create({
    model: 'gpt-5.2',
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: 0.7,
    ...( { max_completion_tokens: 4096 } as any ),
    stream: true,
  });

  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    },
  };
}

async function streamAnthropic(messages: LLMMessage[]): Promise<AsyncIterable<string>> {
  const config = getConfig();
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const systemMsg = messages.find((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 4096,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages: nonSystemMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  });

  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if ('text' in delta) yield delta.text;
        }
      }
    },
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

  if (provider === 'openai') {
    return streamOpenAI(messages);
  }
  return streamAnthropic(messages);
}

export async function validateOpenAIKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  if (mockLlm) {
    return { valid: true };
  }

  try {
    const client = new OpenAI({ apiKey });
    await client.models.list();
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
    const client = new Anthropic({ apiKey });
    await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return { valid: true };
  } catch (err: any) {
    if (err?.status === 401) {
      return { valid: false, error: 'Invalid API key (401 Unauthorized)' };
    }
    const message = err?.message || 'Unknown error';
    return { valid: false, error: message };
  }
}
