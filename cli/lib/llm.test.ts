import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoObjectGeneratedError } from 'ai';
import { z } from 'zod';
import { CATEGORY_SLUGS } from './categories.js';
import type {
  chatObject as ChatObjectFn,
  chatObjectStream as ChatObjectStreamFn,
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
  return { ...actual, streamText: vi.fn() };
});

// `mockLlm` inside ./llm.js is a module-level const read once at import
// time, so ACE_E2E_MOCK_LLM must be set BEFORE the module is first
// imported — a static top-level `import` is hoisted ahead of any statement
// in this file, so we set the env var in beforeAll and import dynamically
// (same pattern used by cli/server/workspace-reset.test.ts).
let chatObject: typeof ChatObjectFn;
let chatObjectStream: typeof ChatObjectStreamFn;
let getModelId: typeof GetModelIdFn;
let withResponseActivityTap: typeof WithResponseActivityTapFn;

beforeAll(async () => {
  process.env.ACE_E2E_MOCK_LLM = '1';
  ({ chatObject, chatObjectStream, getModelId, withResponseActivityTap } = await import('./llm.js'));
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
  solutionCode: z.string().nullable(),
  referenceSolution: z.string().nullable(),
  interviewerPacket: z.string().nullable(),
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

// Pins the NEE-274 tier policy: top for generate/review/dispute, mid for
// edge-audit/brainstorm, basic for review-extract — resolved per provider.
// getModelId is what review rows persist, so a drift here is a data change,
// not just a routing one.
describe('per-purpose model map (NEE-274)', () => {
  it('resolves every purpose to the tier policy on both providers', () => {
    expect(getModelId('anthropic', 'generate')).toBe('claude-opus-5');
    expect(getModelId('anthropic', 'review')).toBe('claude-opus-5');
    expect(getModelId('anthropic', 'dispute')).toBe('claude-opus-5');
    expect(getModelId('anthropic', 'edge-audit')).toBe('claude-sonnet-5');
    expect(getModelId('anthropic', 'brainstorm')).toBe('claude-sonnet-5');
    expect(getModelId('anthropic', 'probe')).toBe('claude-sonnet-5');
    expect(getModelId('anthropic', 'review-extract')).toBe('claude-haiku-4-5');

    expect(getModelId('openai', 'generate')).toBe('gpt-5.6-sol');
    expect(getModelId('openai', 'review')).toBe('gpt-5.6-sol');
    expect(getModelId('openai', 'dispute')).toBe('gpt-5.6-sol');
    expect(getModelId('openai', 'edge-audit')).toBe('gpt-5.6-terra');
    expect(getModelId('openai', 'brainstorm')).toBe('gpt-5.6-terra');
    expect(getModelId('openai', 'probe')).toBe('gpt-5.6-terra');
    expect(getModelId('openai', 'review-extract')).toBe('gpt-5.6-luna');
  });
});

describe('chatObject mock schema-dispatch', () => {
  it('returns the generate payload for a GeneratedQuestionSchema-shaped call, no mode var set', async () => {
    const result = await chatObject('openai', [], GeneratedQuestionSchema);
    expect(result.title).toBe('Two Sum');
    expect(result.slug).toBe('two-sum');
  });

  it('returns the brainstorm payload for an IdeaListSchema-shaped call, no mode var set', async () => {
    const result = await chatObject('openai', [], IdeaListSchema);
    expect(typeof result.reply).toBe('string');
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.ideas.length).toBeGreaterThan(0);
    for (const idea of result.ideas) {
      expect(CATEGORY_SLUGS).toContain(idea.category);
      expect(['easy', 'medium', 'hard']).toContain(idea.difficulty);
    }
  });

  it('returns the probe payload for a ProbeResultSchema-shaped call, no mode var set', async () => {
    const result = await chatObject('openai', [], ProbeResultSchema);
    expect(result.probes.length).toBeGreaterThanOrEqual(2);
    expect(result.probes.some((p) => p.source === 'derived')).toBe(true);
  });

  it('honors an explicit ACE_MOCK_LLM_MODE override even when the schema would otherwise match generate', async () => {
    process.env.ACE_MOCK_LLM_MODE = 'dispute';
    const result = (await chatObject('openai', [], PermissiveSchema)) as Record<string, unknown>;
    expect(result.verdict).toBe('test_incorrect');
    expect(result.title).toBeUndefined();
  });

  it('falls through to the existing parse-failure behavior when no candidate matches', async () => {
    await expect(chatObject('openai', [], UnmatchedSchema)).rejects.toThrow();
  });
});

describe('chatObjectStream mock mode', () => {
  it('matches chatObject on the schema-dispatch branch, no mode var set', async () => {
    const streamed = await chatObjectStream('openai', [], GeneratedQuestionSchema);
    const nonStreamed = await chatObject('openai', [], GeneratedQuestionSchema);
    expect(streamed).toEqual(nonStreamed);
    expect(streamed.title).toBe('Two Sum');
  });

  it('honors an explicit ACE_MOCK_LLM_MODE override, matching chatObject', async () => {
    process.env.ACE_MOCK_LLM_MODE = 'dispute';
    const result = (await chatObjectStream('openai', [], PermissiveSchema)) as Record<string, unknown>;
    expect(result.verdict).toBe('test_incorrect');
    expect(result.title).toBeUndefined();
  });

  it('rejects when no candidate matches, same as chatObject', async () => {
    await expect(chatObjectStream('openai', [], UnmatchedSchema)).rejects.toThrow();
  });

  it('fires onPartial at least once with the payload', async () => {
    const partials: Array<Record<string, unknown>> = [];
    const result = await chatObjectStream('openai', [], GeneratedQuestionSchema, {
      onPartial: (partial) => partials.push(partial),
    });
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(partials[0].title).toBe('Two Sum');
    expect(result.slug).toBe('two-sum');
  });

  it('swallows onPartial throws — a logging bug never kills the call', async () => {
    const result = await chatObjectStream('openai', [], GeneratedQuestionSchema, {
      onPartial: () => {
        throw new Error('logging bug');
      },
    });
    expect(result.title).toBe('Two Sum');
  });

  it('fires onStreamActivity once alongside onPartial (NEE-322)', async () => {
    const activity = vi.fn();
    const partials: Array<Record<string, unknown>> = [];
    const result = await chatObjectStream('openai', [], GeneratedQuestionSchema, {
      onPartial: (partial) => partials.push(partial),
      onStreamActivity: activity,
    });
    expect(activity).toHaveBeenCalledTimes(1);
    expect(partials).toHaveLength(1);
    expect(result.title).toBe('Two Sum');
  });

  it('swallows onStreamActivity throws — same contract as onPartial', async () => {
    const result = await chatObjectStream('openai', [], GeneratedQuestionSchema, {
      onStreamActivity: () => {
        throw new Error('logging bug');
      },
    });
    expect(result.title).toBe('Two Sum');
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

describe('chatObjectStream real path (mocked ai seam)', () => {
  // These need a NON-mock llm instance: fresh module graph with
  // ACE_E2E_MOCK_LLM unset, plus a temp HOME so the module never reads the
  // developer's real ~/.ace/config.json (same hygiene as llm.baseurl.test.ts).
  let tempHome = '';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['HOME', 'ACE_E2E_MOCK_LLM', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-llm-stream-'));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // resetModules() re-runs the vi.mock factory on re-import, so the fresh llm
  // instance and the streamText mock reference must be picked up together.
  async function loadRealLlm() {
    vi.resetModules();
    const llm = await import('./llm.js');
    const { streamText } = await import('ai');
    return { llm, streamText: vi.mocked(streamText) };
  }

  it('drains the partial stream, fires onPartial per partial, and resolves the final output', async () => {
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
      'openai',
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
      .chatObjectStream('openai', [{ role: 'user', content: 'hi' }], z.object({ title: z.string() }))
      .catch((e: unknown) => e);

    // Exactly what generation.ts's error handler (and the CLI commands)
    // match on: isInstance plus .text for the raw-response job column.
    expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
    expect((err as NoObjectGeneratedError).text).toBe(rawText);
  });
});
