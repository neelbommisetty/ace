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

// Mock payloads for keyless testing, keyed by the shape of structured-output
// call each one impersonates. `getMockResponse()` is used by both `chatStream`
// (env-var-selected, unstructured text) and `chatObject`'s explicit-mode
// override path; `chatObject`'s no-mode-var path instead dispatches on the
// caller's zod schema (see MOCK_OBJECT_CANDIDATES below) so one keyless
// server process can serve multiple structured-output shapes.
function getGenerateMockPayload() {
  return {
    title: 'Two Sum',
    slug: 'two-sum',
    description: 'Return indices of the two numbers such that they add up to target.',
    signature: 'export function twoSum(nums: number[], target: number): number[]',
  };
}

function getDisputeMockPayload() {
  return {
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
  };
}

function getBrainstormMockPayload() {
  return {
    reply: 'Here are a few ideas to get you started — let me know if you want variations.',
    ideas: [
      {
        title: 'Debounced Search Box',
        category: 'react-apps',
        difficulty: 'medium',
        pitch: 'Build a search input that debounces API calls and cancels stale requests.',
        topic: 'Implement a React search box component with debounced, cancelable API calls.',
      },
      {
        title: 'LRU Cache',
        category: 'leetcode-ds',
        difficulty: 'medium',
        pitch: 'Classic data structure question combining a hash map and a doubly linked list.',
        topic: 'Design and implement an LRU cache with O(1) get/put.',
      },
    ],
  };
}

function getReviewExtractionMockPayload() {
  return {
    score: 4,
    verdict: 'Hire',
    dimensions: { Correctness: 4, 'Code Quality': 4, 'Edge Case Handling': 3 },
  };
}

function getMockResponse(): string {
  const mode = process.env.ACE_MOCK_LLM_MODE || '';

  if (mode === 'generate') {
    return JSON.stringify(getGenerateMockPayload(), null, 2);
  }

  if (mode === 'dispute') {
    return JSON.stringify(getDisputeMockPayload(), null, 2);
  }

  if (mode === 'brainstorm') {
    return JSON.stringify(getBrainstormMockPayload(), null, 2);
  }

  if (mode === 'feedback') {
    return 'Overall 4/5\n\nClear solution structure and correct approach. Add a brief complexity note.';
  }

  return 'OK';
}

// Tried in order, against the caller's schema, when chatObject runs in mock
// mode with no explicit ACE_MOCK_LLM_MODE override — first validated wins.
const MOCK_OBJECT_CANDIDATES: Array<() => unknown> = [
  getGenerateMockPayload,
  getDisputeMockPayload,
  getBrainstormMockPayload,
  getReviewExtractionMockPayload,
];

// Load config once at module level
let cachedConfig: AceConfig | null = null;

function getConfig(): AceConfig {
  if (!cachedConfig) {
    cachedConfig = loadAceConfig();
  }
  return cachedConfig;
}

/** Long-running processes (ace ui) must call this after writing ~/.ace/config.json. */
export function clearConfigCache(): void {
  cachedConfig = null;
}

export function isMockLlm(): boolean {
  return mockLlm;
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

/** What a given LLM call is for — selects the model via MODELS below. */
export type LLMPurpose =
  | 'generate'
  | 'edge-audit'
  | 'review'
  | 'review-extract'
  | 'brainstorm'
  | 'dispute';

// Per-purpose model map: flagship models for every generative step. The sole
// non-flagship entry is anthropic 'review-extract' (mechanical extraction of
// already-written review prose — quality lives in the review call itself).
// Swapping a step's model is a one-line change here.
// NOTE: claude-opus-4-8 rejects temperature/top_p/top_k with a 400 — never
// add sampling params to these calls (none are set anywhere today).
const MODELS: Record<LLMProvider, Record<LLMPurpose, string>> = {
  openai: {
    generate: 'gpt-5.6-sol',
    'edge-audit': 'gpt-5.6-sol',
    review: 'gpt-5.6-sol',
    'review-extract': 'gpt-5.6-sol',
    brainstorm: 'gpt-5.6-sol',
    dispute: 'gpt-5.6-sol',
  },
  anthropic: {
    generate: 'claude-opus-4-8',
    'edge-audit': 'claude-opus-4-8',
    review: 'claude-opus-4-8',
    'review-extract': 'claude-haiku-4-5',
    brainstorm: 'claude-opus-4-8',
    dispute: 'claude-opus-4-8',
  },
};

/**
 * The model id a provider/purpose pair resolves to — for callers that persist
 * which model produced an output (e.g. review rows) without re-stating ids.
 */
export function getModelId(provider: LLMProvider, purpose: LLMPurpose): string {
  return MODELS[provider][purpose];
}

function getModel(provider: LLMProvider, purpose: LLMPurpose): LanguageModel {
  const config = getConfig();
  if (provider === 'openai') {
    // .chat() pins the Chat Completions API rather than the Responses API.
    return createOpenAI({
      apiKey: config.OPENAI_API_KEY,
      ...(config.OPENAI_BASE_URL ? { baseURL: config.OPENAI_BASE_URL } : {}),
    }).chat(MODELS.openai[purpose]);
  }
  // A base URL (e.g. a local proxy exposing /v1/messages) still speaks the
  // native Anthropic wire protocol, so the same SDK client is used either way.
  return createAnthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    ...(config.ANTHROPIC_BASE_URL ? { baseURL: config.ANTHROPIC_BASE_URL } : {}),
  })(MODELS.anthropic[purpose]);
}

function toCallInput(
  messages: LLMMessage[],
  maxOutputTokens = 4096,
): {
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
    maxOutputTokens,
  };
}

export async function chatStream(
  provider: LLMProvider,
  messages: LLMMessage[],
  opts?: { abortSignal?: AbortSignal; purpose?: LLMPurpose },
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
    model: getModel(provider, opts?.purpose ?? 'generate'),
    ...toCallInput(messages),
    abortSignal: opts?.abortSignal,
  });
  return result.textStream;
}

export async function chatObject<T>(
  provider: LLMProvider,
  messages: LLMMessage[],
  schema: z.ZodType<T>,
  opts?: { abortSignal?: AbortSignal; maxOutputTokens?: number; purpose?: LLMPurpose },
): Promise<T> {
  if (mockLlm) {
    if (process.env.ACE_MOCK_LLM_MODE) {
      // Explicit override: honored first, exactly as before.
      return schema.parse(JSON.parse(getMockResponse()));
    }
    // No mode var: dispatch on the schema itself, so a single keyless
    // process can serve differently-shaped structured-output calls (e.g.
    // brainstorm turns and question generation) without per-call config.
    for (const candidate of MOCK_OBJECT_CANDIDATES) {
      const result = schema.safeParse(candidate());
      if (result.success) return result.data;
    }
    // No candidate matched this schema — fall through to today's
    // parse-failure behavior.
    return schema.parse('OK');
  }

  const result = await generateObject({
    model: getModel(provider, opts?.purpose ?? 'generate'),
    ...toCallInput(messages, opts?.maxOutputTokens),
    schema,
    abortSignal: opts?.abortSignal,
    // OpenAI strict mode rejects optional schema properties.
    providerOptions: { openai: { strictJsonSchema: false } },
  });
  return result.object;
}

export async function validateOpenAIKey(
  apiKey: string,
  baseUrl?: string,
): Promise<{ valid: boolean; error?: string }> {
  if (mockLlm) {
    return { valid: true };
  }

  try {
    const response = await fetch(`${baseUrl ?? 'https://api.openai.com/v1'}/models`, {
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

export async function validateAnthropicKey(
  apiKey: string,
  baseUrl?: string,
): Promise<{ valid: boolean; error?: string }> {
  if (mockLlm) {
    return { valid: true };
  }

  try {
    const response = await fetch(`${baseUrl ?? 'https://api.anthropic.com/v1'}/models`, {
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
