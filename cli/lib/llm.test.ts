import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError, NoObjectGeneratedError } from 'ai';
import { z } from 'zod';
import { CATEGORY_SLUGS } from './categories.js';
import type {
  chatObject as ChatObjectFn,
  chatObjectStream as ChatObjectStreamFn,
  chatStream as ChatStreamFn,
  getModelId as GetModelIdFn,
  withResponseActivityTap as WithResponseActivityTapFn,
} from './llm.js';

// Only streamText is replaced (the seam the chatObjectStream real-path tests
// drive); everything else — Output, NoObjectGeneratedError — stays real so
// error-identity assertions exercise the genuine classes. No model is ever
// run: the mock-mode tests never reach streamText, and the real-path tests
// always queue a canned return first.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, streamText: vi.fn(), generateObject: vi.fn() };
});

// `mockLlm` inside ./llm.js is a module-level const read once at import
// time, so ACE_E2E_MOCK_LLM must be set BEFORE the module is first
// imported — a static top-level `import` is hoisted ahead of any statement
// in this file, so we set the env var in beforeAll and import dynamically
// (same pattern used by cli/server/workspace-reset.test.ts).
let chatObject: typeof ChatObjectFn;
let chatObjectStream: typeof ChatObjectStreamFn;
let chatStream: typeof ChatStreamFn;
let getModelId: typeof GetModelIdFn;
let withResponseActivityTap: typeof WithResponseActivityTapFn;

beforeAll(async () => {
  process.env.ACE_E2E_MOCK_LLM = '1';
  ({ chatObject, chatObjectStream, chatStream, getModelId, withResponseActivityTap } = await import(
    './llm.js'
  ));
});

// Mirrors cli/lib/gen-pipeline.ts's GeneratedQuestionSchema (kept local: a
// static import of gen-pipeline.js would hoist llm.js ahead of the env-var
// setup above). Required-and-nullable fields, like the canonical schema —
// the mock payload must satisfy the strict shape for dispatch to work.
const GeneratedQuestionSchema = z.object({
  title: z.string(),
  slug: z.string().nullable(),
  description: z.string().nullable(),
  signature: z.string().nullable(),
  testCode: z.string().nullable(),
  supportCode: z.string().nullable(),
  solutionCode: z.string().nullable(),
  referenceSolution: z.string().nullable(),
  interviewerPacket: z.string().nullable(),
  estimatedMinutes: z.number().nullable(),
  competency: z.string().nullable(),
  followUps: z.array(z.string()).nullable(),
});

// Mirrors the planned brainstorm-engine IdeaListSchema.
const IdeaListSchema = z.object({
  reply: z.string(),
  ideas: z
    .array(
      z.object({
        title: z.string(),
        category: z.enum(CATEGORY_SLUGS),
        difficulty: z.enum(['easy', 'medium', 'hard']),
        pitch: z.string(),
        topic: z.string(),
      }),
    )
    .max(5),
});

// Mirrors cli/server/probes.ts's ProbeResultSchema (kept local for the same
// hoisting reason as the schemas above).
const ProbeResultSchema = z.object({
  probes: z
    .array(z.object({ question: z.string(), source: z.enum(['bank', 'derived']) }))
    .min(2)
    .max(4),
});

// Loose enough to validate against ANY plain object — used to prove that an
// explicit ACE_MOCK_LLM_MODE override wins even when schema-dispatch would
// otherwise have matched a different (earlier-tried) candidate.
const PermissiveSchema = z.record(z.string(), z.unknown());

// Matches none of the mock candidates (generate/dispute/brainstorm/probe/
// review-extraction all lack a `foo` field), so it exercises the existing
// parse-failure fallback.
const UnmatchedSchema = z.object({ foo: z.string() });

const originalMode = process.env.ACE_MOCK_LLM_MODE;

beforeEach(() => {
  delete process.env.ACE_MOCK_LLM_MODE;
});

afterEach(() => {
  if (originalMode === undefined) {
    delete process.env.ACE_MOCK_LLM_MODE;
  } else {
    process.env.ACE_MOCK_LLM_MODE = originalMode;
  }
});

// Mock mode reports each slot's own default without consulting keys — the
// one resolution path that never reads config, so it pins the default half
// of SLOT_ROUTES here; the drift guard below pins defaults AND alternates.
describe('slot routing in mock mode', () => {
  it('resolves every slot to its hardcoded default', () => {
    expect(getModelId('draft-problem')).toBe('gpt-5.6-terra');
    expect(getModelId('repair')).toBe('claude-fable-5');
    expect(getModelId('review-escalated')).toBe('claude-opus-5');
  });
});

describe('chatObject mock schema-dispatch', () => {
  it('returns the generate payload for a GeneratedQuestionSchema-shaped call, no mode var set', async () => {
    const result = await chatObject('draft-problem', [], GeneratedQuestionSchema);
    expect(result.title).toBe('Two Sum');
    expect(result.slug).toBe('two-sum');
    // Required-and-nullable (NEE-263) — present as explicit nulls, never omitted.
    expect(result.estimatedMinutes).toBeNull();
    expect(result.supportCode).toBeNull();
  });

  it('returns the brainstorm payload for an IdeaListSchema-shaped call, no mode var set', async () => {
    const result = await chatObject('draft-problem', [], IdeaListSchema);
    expect(typeof result.reply).toBe('string');
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.ideas.length).toBeGreaterThan(0);
    for (const idea of result.ideas) {
      expect(CATEGORY_SLUGS).toContain(idea.category);
      expect(['easy', 'medium', 'hard']).toContain(idea.difficulty);
    }
  });

  it('returns the probe payload for a ProbeResultSchema-shaped call, no mode var set', async () => {
    const result = await chatObject('draft-problem', [], ProbeResultSchema);
    expect(result.probes.length).toBeGreaterThanOrEqual(2);
    expect(result.probes.some((p) => p.source === 'derived')).toBe(true);
  });

  it('honors an explicit ACE_MOCK_LLM_MODE override even when the schema would otherwise match generate', async () => {
    process.env.ACE_MOCK_LLM_MODE = 'dispute';
    const result = (await chatObject('draft-problem', [], PermissiveSchema)) as Record<string, unknown>;
    expect(result.verdict).toBe('test_incorrect');
    expect(result.title).toBeUndefined();
  });

  it('falls through to the existing parse-failure behavior when no candidate matches', async () => {
    await expect(chatObject('draft-problem', [], UnmatchedSchema)).rejects.toThrow();
  });
});

describe('chatObjectStream mock mode', () => {
  it('matches chatObject on the schema-dispatch branch, no mode var set', async () => {
    const streamed = await chatObjectStream('draft-problem', [], GeneratedQuestionSchema);
    const nonStreamed = await chatObject('draft-problem', [], GeneratedQuestionSchema);
    expect(streamed).toEqual(nonStreamed);
    expect(streamed.title).toBe('Two Sum');
  });

  it('honors an explicit ACE_MOCK_LLM_MODE override, matching chatObject', async () => {
    process.env.ACE_MOCK_LLM_MODE = 'dispute';
    const result = (await chatObjectStream('draft-problem', [], PermissiveSchema)) as Record<string, unknown>;
    expect(result.verdict).toBe('test_incorrect');
    expect(result.title).toBeUndefined();
  });

  it('rejects when no candidate matches, same as chatObject', async () => {
    await expect(chatObjectStream('draft-problem', [], UnmatchedSchema)).rejects.toThrow();
  });

  it('fires onPartial at least once with the payload', async () => {
    const partials: Array<Record<string, unknown>> = [];
    const result = await chatObjectStream('draft-problem', [], GeneratedQuestionSchema, {
      onPartial: (partial) => partials.push(partial),
    });
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(partials[0].title).toBe('Two Sum');
    expect(result.slug).toBe('two-sum');
  });

  it('swallows onPartial throws — a logging bug never kills the call', async () => {
    const result = await chatObjectStream('draft-problem', [], GeneratedQuestionSchema, {
      onPartial: () => {
        throw new Error('logging bug');
      },
    });
    expect(result.title).toBe('Two Sum');
  });

  it('fires onStreamActivity once alongside onPartial (NEE-322)', async () => {
    const activity = vi.fn();
    const partials: Array<Record<string, unknown>> = [];
    const result = await chatObjectStream('draft-problem', [], GeneratedQuestionSchema, {
      onPartial: (partial) => partials.push(partial),
      onStreamActivity: activity,
    });
    expect(activity).toHaveBeenCalledTimes(1);
    expect(partials).toHaveLength(1);
    expect(result.title).toBe('Two Sum');
  });

  it('swallows onStreamActivity throws — same contract as onPartial', async () => {
    const result = await chatObjectStream('draft-problem', [], GeneratedQuestionSchema, {
      onStreamActivity: () => {
        throw new Error('logging bug');
      },
    });
    expect(result.title).toBe('Two Sum');
  });
});

describe('chatStream onStreamActivity (NEE-361)', () => {
  it('fires onStreamActivity once in mock mode, same contract as chatObjectStream', async () => {
    const activity = vi.fn();
    const stream = await chatStream('draft-problem', [], { onStreamActivity: activity });
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(activity).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual(['OK']);
  });

  it('swallows onStreamActivity throws — same contract as chatObjectStream', async () => {
    const stream = await chatStream('draft-problem', [], {
      onStreamActivity: () => {
        throw new Error('logging bug');
      },
    });
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks).toEqual(['OK']);
  });
});

describe('withResponseActivityTap (NEE-322)', () => {
  const encoder = new TextEncoder();

  function chunkedResponse(chunks: string[], init?: ResponseInit): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      init,
    );
  }

  async function readAll(body: ReadableStream<Uint8Array>): Promise<{ reads: number; text: string }> {
    const reader = body.getReader();
    const parts: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    return { reads: parts.length, text: Buffer.concat(parts).toString('utf-8') };
  }

  it('passes chunks through byte-identical, firing the callback once per chunk', async () => {
    const chunks = ['event: ping\n\n', '{"title":', '"Two Sum"}'];
    const onChunk = vi.fn();
    const tap = withResponseActivityTap(onChunk, async () =>
      chunkedResponse(chunks, {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const response = await tap('http://localhost:4242/v1/messages');

    expect(response.status).toBe(200);
    expect(response.statusText).toBe('OK');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const { reads, text } = await readAll(response.body!);
    expect(text).toBe(chunks.join(''));
    expect(reads).toBe(chunks.length);
    expect(onChunk).toHaveBeenCalledTimes(chunks.length);
  });

  it('a throwing callback neither corrupts the stream nor rejects the read', async () => {
    const onChunk = vi.fn(() => {
      throw new Error('logging bug');
    });
    const tap = withResponseActivityTap(onChunk, async () => chunkedResponse(['abc', 'def']));

    const response = await tap('http://localhost:4242/v1/messages');
    const { text } = await readAll(response.body!);

    expect(text).toBe('abcdef');
    expect(onChunk).toHaveBeenCalledTimes(2);
  });

  it('passes a bodyless response through unchanged', async () => {
    const onChunk = vi.fn();
    const bare = new Response(null, { status: 200 });
    const tap = withResponseActivityTap(onChunk, async () => bare);

    expect(await tap('http://localhost:4242/v1/messages')).toBe(bare);
    expect(onChunk).not.toHaveBeenCalled();
  });

  it('passes a null-body-status response through untouched even if a body is present', async () => {
    // The Response constructor rejects any body on 204/205/304, so wrapping
    // such a response would throw — it must be returned as-is instead.
    const fake = {
      status: 304,
      statusText: 'Not Modified',
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>(),
    } as unknown as Response;
    const tap = withResponseActivityTap(vi.fn(), async () => fake);

    expect(await tap('http://localhost:4242/v1/messages')).toBe(fake);
  });
});

// ---------------------------------------------------------------------------
// Non-mock routing. Every describe below needs a fresh module graph with
// ACE_E2E_MOCK_LLM unset AND a temp HOME, so resolveSlot reads exactly the
// config the test wrote and never the developer's real ~/.ace/config.json
// (same hygiene as llm.baseurl.test.ts) — env-sourced keys included.
// ---------------------------------------------------------------------------
const ISOLATED_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'ACE_E2E_MOCK_LLM',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
];

function useIsolatedEnv(): { writeConfig: (config: Record<string, unknown>) => void } {
  let tempHome = '';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    // resetModules() in loadRealLlm() re-imports, but vitest caches the
    // factory-created mock fns — call history AND queued once-values must be
    // cleared per test or one test's leftovers serve the next one's call.
    vi.resetAllMocks();
    for (const key of ISOLATED_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-llm-route-'));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  return {
    writeConfig(config) {
      fs.mkdirSync(path.join(tempHome, '.ace'), { recursive: true });
      fs.writeFileSync(path.join(tempHome, '.ace', 'config.json'), JSON.stringify(config), 'utf-8');
    },
  };
}

// resetModules() re-runs the vi.mock factory on re-import, so the fresh llm
// instance and the mocked `ai` entry points must be picked up together.
async function loadRealLlm() {
  vi.resetModules();
  const llm = await import('./llm.js');
  const { generateObject, streamText } = await import('ai');
  return { llm, generateObject: vi.mocked(generateObject), streamText: vi.mocked(streamText) };
}

/** The model id the SDK client was actually constructed for, per call. */
function calledModel(call: unknown): string {
  return ((call as { model: { modelId: string } }).model).modelId;
}

const modelsOf = (
  routes: Record<string, { route: { model: string } | null }>,
): Record<string, string | null> =>
  Object.fromEntries(Object.entries(routes).map(([slot, r]) => [slot, r.route?.model ?? null]));

// SLOT_ROUTES is the entire routing policy, and getModelId is what review and
// probe rows persist — a drift here is a data change, not just a routing one.
// Resolving the whole table under ONE provider key pins both halves at once:
// a slot whose default that provider serves shows the default, one it does
// not shows the keyless-provider alternate.
describe('SLOT_ROUTES drift guard', () => {
  const env = useIsolatedEnv();

  it('routes every slot under an anthropic-only key', async () => {
    env.writeConfig({ ANTHROPIC_API_KEY: 'sk-ant' });
    const { llm } = await loadRealLlm();

    expect(modelsOf(llm.getSlotRoutes())).toEqual({
      'draft-problem': 'claude-sonnet-5', // alternate (default is openai)
      'author-solution': 'claude-opus-4-8',
      'author-tests': 'claude-opus-5', // alternate
      'author-packet': 'claude-sonnet-5',
      'edge-audit': 'claude-opus-4-6',
      calibrate: 'claude-haiku-4-5', // alternate
      repair: 'claude-fable-5',
      review: 'claude-sonnet-5',
      'review-escalated': 'claude-opus-5',
      'review-extract': 'claude-haiku-4-5',
      probe: 'claude-sonnet-5',
      dispute: 'claude-opus-5',
      brainstorm: 'claude-sonnet-5',
    });
  });

  it('routes every slot under an openai-only key, leaving escalation unavailable', async () => {
    env.writeConfig({ OPENAI_API_KEY: 'sk-oai' });
    const { llm } = await loadRealLlm();

    expect(modelsOf(llm.getSlotRoutes())).toEqual({
      'draft-problem': 'gpt-5.6-terra',
      'author-solution': 'gpt-5.6-sol', // alternate (default is anthropic)
      'author-tests': 'gpt-5.6-sol',
      'author-packet': 'gpt-5.6-terra', // alternate
      'edge-audit': 'gpt-5.6-sol', // alternate
      calibrate: 'gpt-5.6-luna',
      repair: 'gpt-5.6-sol', // alternate
      review: 'gpt-5.6-sol', // alternate
      // The one slot with no alternate: an openai-only install has no
      // stronger tier to escalate a re-review to, so it has no route at all.
      'review-escalated': null,
      'review-extract': 'gpt-5.6-luna', // alternate
      probe: 'gpt-5.6-terra', // alternate
      dispute: 'gpt-5.6-sol', // alternate
      brainstorm: 'gpt-5.6-terra', // alternate
    });
  });
});

describe('resolveSlot', () => {
  const env = useIsolatedEnv();

  it('takes the default when its provider has a key', async () => {
    env.writeConfig({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' });
    const { llm } = await loadRealLlm();

    expect(llm.resolveSlot('dispute')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      source: 'default',
      warning: null,
    });
  });

  it('takes the alternate, marked provider-fallback, when the default provider is keyless', async () => {
    env.writeConfig({ OPENAI_API_KEY: 'k' });
    const { llm } = await loadRealLlm();

    expect(llm.resolveSlot('dispute')).toEqual({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      source: 'provider-fallback',
      warning: null,
    });
  });

  it('honors a saved override over the default', async () => {
    env.writeConfig({
      ANTHROPIC_API_KEY: 'k',
      OPENAI_API_KEY: 'k',
      model_overrides: { review: 'gpt-5.6-luna' },
    });
    const { llm } = await loadRealLlm();

    expect(llm.resolveSlot('review')).toEqual({
      provider: 'openai',
      model: 'gpt-5.6-luna',
      source: 'override',
      warning: null,
    });
  });

  it('warns and falls back to the default when an override names an unknown model', async () => {
    env.writeConfig({ ANTHROPIC_API_KEY: 'k', model_overrides: { review: 'gpt-9-imaginary' } });
    const { llm } = await loadRealLlm();

    const route = llm.resolveSlot('review');
    expect(route?.model).toBe('claude-sonnet-5');
    expect(route?.source).toBe('default');
    expect(route?.warning).toContain('gpt-9-imaginary');
  });

  it('warns and falls back when the override provider has no key', async () => {
    env.writeConfig({ ANTHROPIC_API_KEY: 'k', model_overrides: { review: 'gpt-5.6-sol' } });
    const { llm } = await loadRealLlm();

    const route = llm.resolveSlot('review');
    expect(route?.model).toBe('claude-sonnet-5');
    expect(route?.warning).toContain('no openai API key');
  });

  it('is null for every slot when no provider has a key', async () => {
    env.writeConfig({});
    const { llm } = await loadRealLlm();

    expect(llm.resolveSlot('review')).toBeNull();
    expect(llm.hasAnyProvider()).toBe(false);
    // The persisted-id helper still names the model that WOULD have run.
    expect(llm.getModelId('review')).toBe('claude-sonnet-5');
  });

  it('reports the default in mock mode without consulting keys', async () => {
    env.writeConfig({});
    process.env.ACE_E2E_MOCK_LLM = '1';
    const { llm } = await loadRealLlm();

    expect(llm.resolveSlot('draft-problem')).toEqual({
      provider: 'openai',
      model: 'gpt-5.6-terra',
      source: 'default',
      warning: null,
    });
    expect(llm.hasAnyProvider()).toBe(true);
  });

  // Mock mode has every provider by construction — updateSettings accepts an
  // override on exactly that rule, so resolution has to honor it (it used to
  // return the bare default, making a saved choice look silently rejected)
  // and the selectable catalog has to be non-empty (it used to be [], which
  // rendered every Settings row as an empty, unusable dropdown).
  it('honors a saved override in mock mode, and offers the whole catalog', async () => {
    env.writeConfig({ model_overrides: { review: 'gpt-5.6-luna' } });
    process.env.ACE_E2E_MOCK_LLM = '1';
    const { llm } = await loadRealLlm();

    expect(llm.resolveSlot('review')).toEqual({
      provider: 'openai',
      model: 'gpt-5.6-luna',
      source: 'override',
      warning: null,
    });
    const available = llm.getAvailableModels();
    expect(available).toContainEqual({ provider: 'openai', model: 'gpt-5.6-luna' });
    expect(available).toContainEqual({ provider: 'anthropic', model: 'claude-opus-5' });
    // Every resolvable route is selectable — that is what a non-blank <select> needs.
    const models = new Set(available.map((m) => m.model));
    for (const resolution of Object.values(llm.getSlotRoutes())) {
      expect(models.has(resolution.route!.model)).toBe(true);
    }
  });

  // resolveSlot returns null here, so the warning has nowhere to ride —
  // the rejected override would otherwise be silent, which the plan forbids.
  it('keeps the override warning when the slot resolves to nothing at all', async () => {
    env.writeConfig({
      OPENAI_API_KEY: 'k',
      model_overrides: { 'review-escalated': 'gpt-9-fake' },
    });
    const { llm } = await loadRealLlm();

    const detail = llm.resolveSlotDetail('review-escalated');
    // openai-only: no alternate for this slot, so nothing runs it…
    expect(detail.route).toBeNull();
    // …but the saved override, and why it was rejected, still reach Settings.
    expect(detail.override).toBe('gpt-9-fake');
    expect(detail.warning).toContain('gpt-9-fake');
  });

  it('reports a saved override that could not be honored, so it stays clearable', async () => {
    env.writeConfig({ ANTHROPIC_API_KEY: 'k', model_overrides: { review: 'gpt-5.6-sol' } });
    const { llm } = await loadRealLlm();

    const detail = llm.resolveSlotDetail('review');
    expect(detail.route?.source).toBe('default');
    expect(detail.override).toBe('gpt-5.6-sol');
    expect(detail.warning).toContain('no openai API key');
  });

  it('rejects a call on a slot nothing can serve, rather than picking something', async () => {
    env.writeConfig({ OPENAI_API_KEY: 'k' });
    const { llm } = await loadRealLlm();

    await expect(llm.chatStream('review-escalated', [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /review-escalated/,
    );
  });
});

// claude-fable-5 leads the `repair` slot despite two operational failure
// modes: a ZDR org 400s EVERY request (latched for the session after one),
// and its classifiers can end a turn with stop_reason "refusal" on an HTTP
// 200, which @ai-sdk/anthropic maps to finishReason 'content-filter' (that
// one is per-request and must NOT latch).
describe('Fable fallback', () => {
  const env = useIsolatedEnv();
  const SCHEMA = z.object({ ok: z.boolean() });
  const MESSAGES = [{ role: 'user' as const, content: 'fix it' }];

  function apiError(statusCode: number): APICallError {
    return new APICallError({
      message: 'Bad Request',
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      statusCode,
    });
  }

  function refusalError(): NoObjectGeneratedError {
    return new NoObjectGeneratedError({
      message: 'No object generated: response did not contain an object.',
      text: '',
      response: { id: 'resp-1', timestamp: new Date(0), modelId: 'claude-fable-5' },
      usage: {
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      },
      finishReason: 'content-filter',
    });
  }

  function objectStreamResult(opts: {
    output: Promise<unknown>;
    finishReason?: string;
  }): Record<string, unknown> {
    return {
      partialOutputStream: (async function* () {})(),
      output: opts.output,
      finishReason: Promise.resolve(opts.finishReason ?? 'stop'),
      providerMetadata: Promise.resolve(undefined),
    };
  }

  it('retries a 400 on claude-opus-5 and latches the swap for the session', async () => {
    env.writeConfig({ ANTHROPIC_API_KEY: 'k' });
    const { llm, generateObject } = await loadRealLlm();
    generateObject
      .mockRejectedValueOnce(apiError(400))
      .mockResolvedValueOnce({ object: { ok: true }, finishReason: 'stop' } as never);

    expect(await llm.chatObject('repair', MESSAGES, SCHEMA)).toEqual({ ok: true });
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(calledModel(generateObject.mock.calls[0][0])).toBe('claude-fable-5');
    expect(calledModel(generateObject.mock.calls[1][0])).toBe('claude-opus-5');
    // Latched: every later resolution of the slot skips Fable outright.
    expect(llm.resolveSlot('repair')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      source: 'fable-fallback',
      warning: null,
    });
  });

  it('leaves a non-Fable slot alone — a 400 there propagates', async () => {
    env.writeConfig({ ANTHROPIC_API_KEY: 'k' });
    const { llm, generateObject } = await loadRealLlm();
    generateObject.mockRejectedValueOnce(apiError(400));

    await expect(llm.chatObject('dispute', MESSAGES, SCHEMA)).rejects.toThrow('Bad Request');
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it('retries a refusal finish per call, without latching', async () => {
    env.writeConfig({ ANTHROPIC_API_KEY: 'k' });
    const { llm, generateObject } = await loadRealLlm();
    generateObject
      .mockResolvedValueOnce({ object: { ok: false }, finishReason: 'content-filter' } as never)
      .mockResolvedValueOnce({ object: { ok: true }, finishReason: 'stop' } as never);

    expect(await llm.chatObject('repair', MESSAGES, SCHEMA)).toEqual({ ok: true });
    expect(calledModel(generateObject.mock.calls[1][0])).toBe('claude-opus-5');
    // NOT latched — a refusal is about this request, not the whole org.
    expect(llm.resolveSlot('repair')?.model).toBe('claude-fable-5');
  });

  it('retries chatObjectStream when the output rejects with a refusal finish', async () => {
    env.writeConfig({ ANTHROPIC_API_KEY: 'k' });
    const { llm, streamText } = await loadRealLlm();
    const rejected = Promise.reject(refusalError());
    rejected.catch(() => {});
    streamText
      .mockReturnValueOnce(objectStreamResult({ output: rejected }) as never)
      .mockReturnValueOnce(objectStreamResult({ output: Promise.resolve({ ok: true }) }) as never);

    expect(await llm.chatObjectStream('repair', MESSAGES, SCHEMA)).toEqual({ ok: true });
    expect(calledModel(streamText.mock.calls[1][0])).toBe('claude-opus-5');
    expect(llm.resolveSlot('repair')?.model).toBe('claude-fable-5');
  });

  it('retries chatStream when the drained stream finished on a refusal', async () => {
    env.writeConfig({ ANTHROPIC_API_KEY: 'k' });
    const { llm, streamText } = await loadRealLlm();
    streamText
      .mockReturnValueOnce({
        textStream: (async function* () {})(),
        finishReason: Promise.resolve('content-filter'),
        providerMetadata: Promise.resolve(undefined),
      } as never)
      .mockReturnValueOnce({
        textStream: (async function* () {
          yield 'answered anyway';
        })(),
        finishReason: Promise.resolve('stop'),
        providerMetadata: Promise.resolve(undefined),
      } as never);

    const chunks: string[] = [];
    for await (const chunk of await llm.chatStream('repair', MESSAGES)) chunks.push(chunk);

    expect(chunks).toEqual(['answered anyway']);
    expect(calledModel(streamText.mock.calls[1][0])).toBe('claude-opus-5');
  });

  // A refusal retry does NOT latch (above), so a caller that re-resolves the
  // slot afterwards records claude-fable-5 for text claude-opus-5 wrote —
  // reviews.model / probe_sets.model are exactly such callers. onRoute is the
  // only truthful channel: it reports every route the call actually took.
  describe('onRoute reports the route each attempt actually ran on', () => {
    it('ends on the fallback route after a chatStream refusal retry', async () => {
      env.writeConfig({ ANTHROPIC_API_KEY: 'k' });
      const { llm, streamText } = await loadRealLlm();
      streamText
        .mockReturnValueOnce({
          textStream: (async function* () {})(),
          finishReason: Promise.resolve('content-filter'),
          providerMetadata: Promise.resolve(undefined),
        } as never)
        .mockReturnValueOnce({
          textStream: (async function* () {
            yield 'answered anyway';
          })(),
          finishReason: Promise.resolve('stop'),
          providerMetadata: Promise.resolve(undefined),
        } as never);

      const seen: string[] = [];
      const stream = await llm.chatStream('repair', MESSAGES, {
        onRoute: (route) => seen.push(route.model),
      });
      for await (const _chunk of stream) {
        // drain
      }

      expect(seen).toEqual(['claude-fable-5', 'claude-opus-5']);
      // The slot itself still resolves to Fable — which is why re-resolving
      // after the call is the wrong thing to persist.
      expect(llm.getModelId('repair')).toBe('claude-fable-5');
    });

    it('ends on the fallback route after a chatObjectStream refusal retry', async () => {
      env.writeConfig({ ANTHROPIC_API_KEY: 'k' });
      const { llm, streamText } = await loadRealLlm();
      const rejected = Promise.reject(refusalError());
      rejected.catch(() => {});
      streamText
        .mockReturnValueOnce(objectStreamResult({ output: rejected }) as never)
        .mockReturnValueOnce(objectStreamResult({ output: Promise.resolve({ ok: true }) }) as never);

      const seen: string[] = [];
      await llm.chatObjectStream('repair', MESSAGES, SCHEMA, {
        onRoute: (route) => seen.push(route.model),
      });

      expect(seen).toEqual(['claude-fable-5', 'claude-opus-5']);
      expect(llm.getModelId('repair')).toBe('claude-fable-5');
    });

    it('reports the plain route once on a call that needs no retry', async () => {
      env.writeConfig({ ANTHROPIC_API_KEY: 'k' });
      const { llm, streamText } = await loadRealLlm();
      streamText.mockReturnValueOnce({
        textStream: (async function* () {
          yield 'fine';
        })(),
        finishReason: Promise.resolve('stop'),
        providerMetadata: Promise.resolve(undefined),
      } as never);

      const seen: string[] = [];
      const stream = await llm.chatStream('review', MESSAGES, {
        onRoute: (route) => seen.push(route.model),
      });
      for await (const _chunk of stream) {
        // drain
      }

      expect(seen).toEqual(['claude-sonnet-5']);
    });
  });
});

describe('chatObjectStream real path (mocked ai seam)', () => {
  const env = useIsolatedEnv();

  it('drains the partial stream, fires onPartial per partial, and resolves the final output', async () => {
    env.writeConfig({ OPENAI_API_KEY: 'k1' });
    const { llm, streamText } = await loadRealLlm();
    const partials = [{ title: 'Two S' }, { title: 'Two Sum' }];
    streamText.mockReturnValueOnce({
      partialOutputStream: (async function* () {
        yield* partials;
      })(),
      output: Promise.resolve({ title: 'Two Sum' }),
    } as never);

    const seen: Array<Record<string, unknown>> = [];
    const result = await llm.chatObjectStream(
      'draft-problem',
      [
        { role: 'system', content: 'sys prompt' },
        { role: 'user', content: 'hi' },
      ],
      z.object({ title: z.string() }),
      { onPartial: (partial) => seen.push(partial), maxOutputTokens: 123 },
    );

    expect(result).toEqual({ title: 'Two Sum' });
    expect(seen).toEqual(partials);

    // Call-shape parity with chatObject: system prompt routed through
    // `instructions`, strict-mode opt-out, and NO sampling params
    // (the Claude 5-series 400s on temperature/top_p/top_k).
    const call = streamText.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(call.instructions).toBe('sys prompt');
    expect(call.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(call.maxOutputTokens).toBe(123);
    expect(call.providerOptions).toEqual({ openai: { strictJsonSchema: false } });
    expect(call.output).toBeDefined();
    expect('temperature' in call).toBe(false);
    expect('topP' in call).toBe(false);
    expect('topK' in call).toBe(false);
  });

  it('propagates a parseCompleteOutput failure as NoObjectGeneratedError with .text intact', async () => {
    env.writeConfig({ OPENAI_API_KEY: 'k1' });
    const { llm, streamText } = await loadRealLlm();
    const rawText = '{"title": "Two Su';
    const rejection = new NoObjectGeneratedError({
      message: 'No object generated: could not parse the response.',
      text: rawText,
      response: { id: 'resp-1', timestamp: new Date(0), modelId: 'gpt-5.6-sol' },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      },
      finishReason: 'stop',
    });
    const output = Promise.reject(rejection);
    // Pre-attach a handler: the rejection must not trip vitest's
    // unhandled-rejection detection before chatObjectStream awaits it.
    output.catch(() => {});
    streamText.mockReturnValueOnce({
      partialOutputStream: (async function* () {
        yield { title: 'Two Su' };
      })(),
      output,
    } as never);

    const err: unknown = await llm
      .chatObjectStream('draft-problem', [{ role: 'user', content: 'hi' }], z.object({ title: z.string() }))
      .catch((e: unknown) => e);

    // Exactly what generation.ts's error handler (and the CLI commands)
    // match on: isInstance plus .text for the raw-response job column.
    expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
    expect((err as NoObjectGeneratedError).text).toBe(rawText);
  });
});
