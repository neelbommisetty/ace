import { generateObject, streamText, Output, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { z } from 'zod';
import { loadAceConfig, type AceConfig } from './config.js';
import type { LLMPurpose } from '../../shared/wire-types.js';

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
    // GeneratedQuestionSchema's optional fields are required-and-nullable
    // (strict structured outputs, NEE-263) — omitting the keys would fail
    // schema dispatch, so the unused artifacts are explicit nulls. This
    // payload is shared across every category in mock mode (there is only
    // one 'generate'-shaped candidate), so competency/followUps (NEE-343,
    // behavioral-only) and estimatedMinutes/supportCode stay null here too —
    // a keyless e2e run exercises the schema/scaffold plumbing, not real
    // content (mock mode also never reaches the calibrate stage, which is
    // what would otherwise fill estimatedMinutes in).
    testCode: null,
    supportCode: null,
    solutionCode: null,
    referenceSolution: null,
    interviewerPacket: null,
    estimatedMinutes: null,
    competency: null,
    followUps: null,
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

function getProbeMockPayload() {
  return {
    probes: [
      {
        question: 'What would the other engineer say about how you handled it?',
        source: 'derived',
      },
      {
        question: 'How would your approach change if this happened at 10x the team size?',
        source: 'derived',
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

  if (mode === 'probe') {
    return JSON.stringify(getProbeMockPayload(), null, 2);
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
  getProbeMockPayload,
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

/**
 * What a given LLM call is for — selects the model via PURPOSE_TIERS +
 * TIER_MODELS below. Declared in shared/wire-types.ts (GET /api/settings
 * exposes the resolved map, NEE-303) and re-exported here so the existing
 * `./llm.js` importers are untouched.
 */
export type { LLMPurpose };

/** Capability tier a purpose resolves to — the policy half of the model map. */
type ModelTier = 'top' | 'mid' | 'basic';

// Per-purpose model policy (NEE-274), expressed as purpose → tier plus
// provider × tier → model id, so a policy change is one edit and the two
// provider halves cannot silently diverge (twelve hand-maintained literals
// is how the openai half lost its review-extract carve-out).
//
// Tier rationale:
// - top:   'generate' and 'review' produce the artifacts the product is
//   judged on; 'dispute' is rare, high-stakes adjudication where the cost
//   delta is negligible.
// - mid:   'edge-audit' critiques a bounded artifact and the sandbox
//   verify/repair loop backstops it; 'brainstorm' is idea turns, not the
//   verified artifact; 'probe' selects/derives follow-up questions from a
//   story already on the page — selection and derivation, not the graded
//   review itself (NEE-345).
// - basic: 'review-extract' mechanically extracts scores from already-
//   written review prose — quality lives in the review call itself.
//
// The anthropic top tier is deliberately Opus 5, NOT Fable 5: Fable is 2x
// the cost, unavailable under zero data retention (every request 400s),
// runs always-on thinking, and its safety classifiers can return
// stop_reason "refusal" on an HTTP 200 — operational risks with no measured
// quality delta for this workload.
//
// gpt-5.6-terra / gpt-5.6-luna verified against the OpenAI model docs on
// 2026-07-27: both exist (1.05M context, 128K max output, $2.50/$15 and
// $1/$6 per MTok) and are served on Chat Completions, which .chat() below
// pins — and luna's context comfortably holds a full review transcript for
// 'review-extract'. claude-haiku-4-5 (200K context, 64K output) likewise
// still fits review-extract inputs.
//
// NOTE: the Claude 5-series (claude-opus-5, claude-sonnet-5) rejects
// temperature/top_p/top_k with a 400, exactly like claude-opus-4-8 before
// it — never add sampling params to these calls (none are set anywhere
// today). Adaptive thinking is also ON by default on Opus 5 / Sonnet 5 and
// counts against maxOutputTokens — see toCallInput below for the sizing.
const PURPOSE_TIERS: Record<LLMPurpose, ModelTier> = {
  generate: 'top',
  review: 'top',
  dispute: 'top',
  'edge-audit': 'mid',
  brainstorm: 'mid',
  probe: 'top',
  // calibrate is a structured-output call like probe — the same NEE-364
  // reliability problem (the mid tier's proxy double-emitted a JSON object,
  // breaking structured parse) applies here, so it takes the same top-tier fix.
  calibrate: 'top',
  'review-extract': 'basic',
};

const TIER_MODELS: Record<LLMProvider, Record<ModelTier, string>> = {
  openai: {
    top: 'gpt-5.6-sol',
    mid: 'gpt-5.6-terra',
    basic: 'gpt-5.6-luna',
  },
  anthropic: {
    top: 'claude-opus-5',
    mid: 'claude-sonnet-5',
    basic: 'claude-haiku-4-5',
  },
};

/**
 * The model id a provider/purpose pair resolves to — for callers that persist
 * which model produced an output (e.g. review rows) without re-stating ids.
 */
export function getModelId(provider: LLMProvider, purpose: LLMPurpose): string {
  return TIER_MODELS[provider][PURPOSE_TIERS[purpose]];
}

/** Every purpose PURPOSE_TIERS resolves — iterated to build the full model map below. */
const ALL_PURPOSES = Object.keys(PURPOSE_TIERS) as LLMPurpose[];

/**
 * The full per-purpose model map for one provider — what GET /api/settings
 * exposes (NEE-303) so paid actions can state their model before invocation
 * instead of only recording it after the fact.
 */
export function getModelMap(provider: LLMProvider): Record<LLMPurpose, string> {
  const map = {} as Record<LLMPurpose, string>;
  for (const purpose of ALL_PURPOSES) {
    map[purpose] = getModelId(provider, purpose);
  }
  return map;
}

// When no fetchImpl is given the factories must receive no `fetch` key at
// all — default construction stays exactly as before NEE-322.
function getModel(
  provider: LLMProvider,
  purpose: LLMPurpose,
  fetchImpl?: typeof fetch,
): LanguageModel {
  const config = getConfig();
  if (provider === 'openai') {
    // .chat() pins the Chat Completions API rather than the Responses API.
    return createOpenAI({
      apiKey: config.OPENAI_API_KEY,
      ...(config.OPENAI_BASE_URL ? { baseURL: config.OPENAI_BASE_URL } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    }).chat(getModelId('openai', purpose));
  }
  // A base URL (e.g. a local proxy exposing /v1/messages) still speaks the
  // native Anthropic wire protocol, so the same SDK client is used either way.
  return createAnthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    ...(config.ANTHROPIC_BASE_URL ? { baseURL: config.ANTHROPIC_BASE_URL } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })(getModelId('anthropic', purpose));
}

// Statuses whose Response constructor rejects a body outright — those (and
// bodyless responses) must pass through untouched or the wrap itself throws.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Wraps a fetch so every raw chunk of the response body fires `onChunk` and
 * passes through byte-identical (NEE-322). Raw bytes are the only liveness
 * signal that survives a buffering proxy: it can hold back every partial
 * object for an entire healthy turn while SSE pings keep the socket alive.
 * Callback throws are swallowed — a logging bug must never kill a paid call.
 */
export function withResponseActivityTap(
  onChunk: () => void,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.body || NULL_BODY_STATUSES.has(response.status)) return response;
    const tapped = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          try {
            onChunk();
          } catch {
            // Swallowed by contract — see the doc comment.
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(tapped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function toCallInput(
  messages: LLMMessage[],
  // Default doubled from 4096 (NEE-274): adaptive thinking is on by default
  // on claude-opus-5/claude-sonnet-5 and counts against maxOutputTokens, so
  // a cap sized tightly around the visible answer can truncate mid-response.
  maxOutputTokens = 8192,
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
  opts?: {
    abortSignal?: AbortSignal;
    purpose?: LLMPurpose;
    /** Same contract as chatObjectStream's onStreamActivity (NEE-322):
     *  fired on every raw chunk of the underlying HTTP response body,
     *  including frames that never materialise a text delta — the only
     *  liveness signal that survives a buffering proxy or a long
     *  adaptive-thinking pause (NEE-361). Swallow contract identical to
     *  onPartial elsewhere: a logging bug must never kill a paid call. */
    onStreamActivity?: () => void;
  },
): Promise<AsyncIterable<string>> {
  const fireActivity = (): void => {
    try {
      opts?.onStreamActivity?.();
    } catch {
      // Swallowed by contract — a logging bug must never kill a paid call.
    }
  };

  if (mockLlm) {
    const response = getMockResponse();
    return {
      async *[Symbol.asyncIterator]() {
        fireActivity();
        yield response;
      },
    };
  }

  const result = streamText({
    // The tapped fetch is scoped to THIS call's model — same threading as
    // chatObjectStream; without the callback getModel receives no fetch at
    // all and construction is unchanged.
    model: getModel(
      provider,
      opts?.purpose ?? 'generate',
      opts?.onStreamActivity ? withResponseActivityTap(fireActivity) : undefined,
    ),
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
    // Opt out of OpenAI strict mode: several caller schemas still carry
    // optional properties, which strict mode rejects. Do NOT rely on this
    // flag for correctness — the codex backend enforces strict mode
    // regardless (NEE-263), so schemas used on the openai path must be
    // strict-compatible by construction: every property required, with
    // optionality expressed as `.nullable()` (see GeneratedQuestionSchema).
    providerOptions: { openai: { strictJsonSchema: false } },
  });
  return result.object;
}

/**
 * Streaming variant of chatObject: same validated-final-object contract, but
 * surfaces each partial object as the JSON materialises so callers (e.g. the
 * Activity Log) can render a response arriving live. Ships beside chatObject —
 * review-extract and the CLI commands stay on the non-streaming call.
 */
export async function chatObjectStream<T>(
  provider: LLMProvider,
  messages: LLMMessage[],
  schema: z.ZodType<T>,
  opts?: {
    abortSignal?: AbortSignal;
    maxOutputTokens?: number;
    purpose?: LLMPurpose;
    /** Each partial as the JSON materialises. NOT schema-validated —
     *  every field may be truncated mid-string. Throws are swallowed:
     *  a logging bug must never kill a paid call. */
    onPartial?: (partial: Record<string, unknown>) => void;
    /** Fired on every raw chunk of the underlying HTTP response body —
     *  including frames that never materialise a partial: a buffering proxy
     *  can send only pings for a whole turn (NEE-322), so this is the only
     *  liveness signal that never goes silent on a healthy call. Same
     *  swallow contract as onPartial. */
    onStreamActivity?: () => void;
  },
): Promise<T> {
  const firePartial = (partial: unknown): void => {
    try {
      opts?.onPartial?.(partial as Record<string, unknown>);
    } catch {
      // Swallowed by contract — a logging bug must never kill a paid call.
    }
  };
  const fireActivity = (): void => {
    try {
      opts?.onStreamActivity?.();
    } catch {
      // Swallowed by contract — a logging bug must never kill a paid call.
    }
  };

  if (mockLlm) {
    if (process.env.ACE_MOCK_LLM_MODE) {
      // Explicit override: honored first, exactly like chatObject.
      const parsed = schema.parse(JSON.parse(getMockResponse()));
      fireActivity();
      firePartial(parsed);
      return parsed;
    }
    // No mode var: same schema dispatch as chatObject, firing onPartial at
    // least once so keyless e2e still renders a stream.
    for (const candidate of MOCK_OBJECT_CANDIDATES) {
      const result = schema.safeParse(candidate());
      if (result.success) {
        fireActivity();
        firePartial(result.data);
        return result.data;
      }
    }
    // No candidate matched this schema — fall through to today's
    // parse-failure behavior.
    return schema.parse('OK');
  }

  const result = streamText({
    // The tapped fetch is scoped to THIS call's model; without the callback
    // getModel receives no fetch at all and construction is unchanged.
    model: getModel(
      provider,
      opts?.purpose ?? 'generate',
      opts?.onStreamActivity ? withResponseActivityTap(fireActivity) : undefined,
    ),
    ...toCallInput(messages, opts?.maxOutputTokens),
    output: Output.object({ schema }),
    abortSignal: opts?.abortSignal,
    // Same strict-mode opt-out as chatObject — see the comment there.
    providerOptions: { openai: { strictJsonSchema: false } },
  });

  // The partial stream must be FULLY drained or `result.output` below never
  // settles. Never read result.textStream here — that is the raw JSON
  // including referenceSolution; only the partial-object stream may be
  // surfaced, filtered downstream.
  for await (const partial of result.partialOutputStream) {
    firePartial(partial);
  }

  // The schema-validated final object. Parse/validation failure rejects with
  // NoObjectGeneratedError carrying .text — the same contract chatObject's
  // callers already match on.
  return await result.output;
}

/**
 * HTTP/2 responses carry no reason phrase, so the vendor APIs report a bare
 * "401" while an HTTP/1.1 proxy reports "401 Unauthorized". Naming the host
 * that answered is what makes a wrong-host validation self-evident.
 */
function probeFailure(response: Response, base: string): string {
  const reason = response.statusText ? `${response.status} ${response.statusText}` : `${response.status}`;
  return `${reason} from ${base}`;
}

/**
 * A 2xx status alone is not proof a provider answered: ace's own SPA
 * catch-all (cli/server/routes/static.ts) serves index.html with a 200 for
 * ANY extension-less GET, so a misconfigured base URL that loops back into
 * ace itself (or a proxy that renders an error page) would otherwise
 * green-check the key and every subsequent paid call would die with a bare
 * 404 (NEE-360). The real /v1/models endpoint always answers with a JSON
 * object carrying a `data` array — demand that shape and name what was
 * actually found when it's missing.
 */
async function describeUnexpectedBody(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return 'the response body could not be read';
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'an empty body';
  if (/^<(!doctype|html)/i.test(trimmed)) return 'an HTML page, not a provider API response';
  try {
    JSON.parse(trimmed);
    return 'JSON that is not a models-list response (no "data" array)';
  } catch {
    return 'a non-JSON body';
  }
}

async function validateModelsListResponse(
  response: Response,
  base: string,
): Promise<{ valid: boolean; error?: string }> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    const description = await describeUnexpectedBody(response);
    return {
      valid: false,
      error:
        `${base} returned a 2xx status but ${description} — check that this is the ` +
        'right provider (or proxy) address and that something is actually listening on it.',
    };
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>).data)
  ) {
    return {
      valid: false,
      error:
        `${base} returned a 2xx status but the body is not a models-list response ` +
        '(no "data" array) — check that this is the right provider (or proxy) address.',
    };
  }
  return { valid: true };
}

export async function validateOpenAIKey(
  apiKey: string,
  baseUrl?: string,
): Promise<{ valid: boolean; error?: string }> {
  if (mockLlm) {
    return { valid: true };
  }

  // Env-sourced base URLs bypass normalizeBaseUrl, so strip trailing
  // slashes here too — the SDK clients do the same internally.
  const base = (baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      return { valid: false, error: probeFailure(response, base) };
    }
    return await validateModelsListResponse(response, base);
  } catch (err: any) {
    const message = err?.message || 'Unknown error';
    return { valid: false, error: `${message} (${base})` };
  }
}

export async function validateAnthropicKey(
  apiKey: string,
  baseUrl?: string,
): Promise<{ valid: boolean; error?: string }> {
  if (mockLlm) {
    return { valid: true };
  }

  const base = anthropicProbeBase(baseUrl);
  try {
    const response = await fetch(`${base}/models`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (response.status === 401) {
      return { valid: false, error: `Invalid API key (401) from ${base}` };
    }
    if (!response.ok) {
      return { valid: false, error: probeFailure(response, base) };
    }
    return await validateModelsListResponse(response, base);
  } catch (err: any) {
    const message = err?.message || 'Unknown error';
    return { valid: false, error: `${message} (${base})` };
  }
}

/**
 * @ai-sdk/anthropic appends /v1 to a bare host at call time, so a base URL of
 * http://localhost:4242 hits /v1/messages during generation. Match that here —
 * otherwise a config that works at runtime is rejected at save time.
 */
function anthropicProbeBase(baseUrl?: string): string {
  const base = (baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  try {
    if (new URL(base).pathname === '/') return `${base}/v1`;
  } catch {
    // Unparseable; let fetch surface the failure rather than guessing.
  }
  return base;
}
