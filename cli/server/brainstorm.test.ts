import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NoObjectGeneratedError } from 'ai';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LLMMessage, LLMProvider } from '../lib/llm.js';
import type { createAiLog as CreateAiLogFn } from './ai-log.js';
import type { createBrainstormEngine as CreateBrainstormEngineFn } from './brainstorm.js';
import { openDb } from './db.js';
import { createBus, type Bus } from './sse.js';
import type { AceDb } from './types.js';

// `resolveProvider` (called by the engine) transitively imports lib/llm.js,
// whose mock-vs-real behavior is a module-level const read at import time —
// same reason cli/lib/llm.test.ts and workspace-reset.test.ts set the env var
// in beforeAll before a dynamic import, rather than a static top-level one.
// (ai-log.js reaches llm.js through gen-pipeline.js, so it rides along.)
let createBrainstormEngine: typeof CreateBrainstormEngineFn;
let IdeaListSchema: (typeof import('./brainstorm.js'))['IdeaListSchema'];
let createAiLog: typeof CreateAiLogFn;

beforeAll(async () => {
  process.env.ACE_E2E_MOCK_LLM = '1';
  ({ createBrainstormEngine, IdeaListSchema } = await import('./brainstorm.js'));
  ({ createAiLog } = await import('./ai-log.js'));
});

let tempRoot = '';
let db: AceDb;
let bus: Bus;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-brainstorm-test-'));
  db = openDb(tempRoot);
  bus = createBus();
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const VALID_IDEA_PAYLOAD = {
  reply: 'Here are a few ideas.',
  ideas: [
    {
      title: 'Debounced Search',
      category: 'react-apps',
      difficulty: 'medium',
      pitch: 'Debounce API calls in a search box.',
      topic: 'Implement a debounced search box.',
    },
  ],
};

/**
 * Queue-based fake `chatObjectStream`: each invocation pops the next handler.
 * Handlers return a raw payload — surfaced once through `onPartial` (not
 * schema-validated, mirroring the real partial stream) and then validated
 * against the CALLER's own schema, mirroring what `streamText`'s output
 * really does — or throw directly (used to simulate
 * `NoObjectGeneratedError` and generic failures without going through
 * schema validation at all).
 */
function makeFakeLlm(
  handlers: Array<
    (provider: LLMProvider, messages: LLMMessage[]) => unknown | Promise<unknown>
  >,
) {
  const calls: Array<{ provider: LLMProvider; messages: LLMMessage[] }> = [];
  let i = 0;
  const chatObjectStream = async (
    provider: LLMProvider,
    messages: LLMMessage[],
    schema: any,
    opts?: { onPartial?: (partial: Record<string, unknown>) => void },
  ) => {
    calls.push({ provider, messages });
    const handler = handlers[i++];
    if (!handler) throw new Error('fake llm: no more handlers queued');
    const payload = await handler(provider, messages);
    opts?.onPartial?.(payload as Record<string, unknown>);
    return schema.parse(payload);
  };
  return {
    llm: { chatObjectStream } as unknown as Parameters<
      typeof CreateBrainstormEngineFn
    >[0]['llm'],
    calls,
  };
}

function waitFor<N extends string>(name: N): Promise<any> {
  return new Promise((resolve) => {
    const unsub = bus.subscribe((eventName, data) => {
      if (eventName === name) {
        unsub();
        resolve(data);
      }
    });
  });
}

describe('createBrainstormEngine', () => {
  it('persists the user turn (and flips to thinking) before calling the llm, and persists the assistant turn (idle) before emitting brainstorm-done', async () => {
    let assertedBeforeCall = false;
    const { llm, calls } = makeFakeLlm([
      () => {
        const [session] = db.listBrainstormSessions();
        expect(session.status).toBe('thinking');
        expect(session.messages).toEqual([{ role: 'user', content: 'idea about arrays' }]);
        assertedBeforeCall = true;
        return VALID_IDEA_PAYLOAD;
      },
    ]);

    const doneEvents: any[] = [];
    bus.subscribe((name, data) => {
      if (name === 'brainstorm-done') {
        // Reads the db synchronously inside the emit callback: proves the
        // assistant turn + idle status are committed BEFORE the SSE fires.
        const { sessionId } = data as { sessionId: string };
        const session = db.getBrainstormSession(sessionId)!;
        expect(session.status).toBe('idle');
        expect(session.messages).toHaveLength(2);
        expect(session.messages[1].role).toBe('assistant');
        doneEvents.push(data);
      }
    });

    const engine = createBrainstormEngine({ db, bus, workspaceRoot: tempRoot, llm });
    const done = waitFor('brainstorm-done');

    const { sessionId } = engine.startTurn(null, 'idea about arrays');
    expect(assertedBeforeCall).toBe(true);

    const turnData = await done;
    expect(turnData.sessionId).toBe(sessionId);
    expect(turnData.turn).toEqual({
      role: 'assistant',
      content: VALID_IDEA_PAYLOAD.reply,
      ideas: VALID_IDEA_PAYLOAD.ideas,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].messages[0].role).toBe('system');
    // Builder-assembled prompt: charter first, then the brainstorm skeleton,
    // with the structured-output addendum appended by the engine.
    expect(calls[0].messages[0].content).toContain('# Interviewer Charter');
    expect(calls[0].messages[0].content).toContain('Question Design Partner');
    expect(calls[0].messages[0].content).toContain('## Output Format');

    expect(engine.isThinking(sessionId)).toBe(false);
    expect(engine.isAnyRunning()).toBe(false);
    expect(doneEvents).toHaveLength(1);
  });

  it('passes the full turn history to the llm in order with roles intact on a follow-up turn', async () => {
    const { llm, calls } = makeFakeLlm([
      () => ({ reply: 'first reply', ideas: [] }),
      () => ({ reply: 'second reply', ideas: [] }),
    ]);
    const engine = createBrainstormEngine({ db, bus, workspaceRoot: tempRoot, llm });

    const firstDone = waitFor('brainstorm-done');
    const { sessionId } = engine.startTurn(null, 'first message');
    await firstDone;

    const secondDone = waitFor('brainstorm-done');
    engine.startTurn(sessionId, 'second message');
    await secondDone;

    expect(calls).toHaveLength(2);
    expect(calls[1].messages.slice(1)).toEqual([
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'second message' },
    ]);
  });

  it('folds a prior assistant turn\'s structured ideas back into the history sent to the llm', async () => {
    const { llm, calls } = makeFakeLlm([
      () => VALID_IDEA_PAYLOAD,
      () => ({ reply: 'second reply', ideas: [] }),
    ]);
    const engine = createBrainstormEngine({ db, bus, workspaceRoot: tempRoot, llm });

    const firstDone = waitFor('brainstorm-done');
    const { sessionId } = engine.startTurn(null, 'first message');
    await firstDone;

    const secondDone = waitFor('brainstorm-done');
    engine.startTurn(sessionId, 'make the idea harder');
    await secondDone;

    // The assistant's ideas from turn 1 must be visible to the llm on turn
    // 2 — otherwise a follow-up like "make the second one harder" has no
    // record of what was proposed (see VALID_IDEA_PAYLOAD's idea title).
    const assistantMsg = calls[1].messages.find(
      (m) => m.role === 'assistant',
    )!;
    expect(assistantMsg.content).toContain(VALID_IDEA_PAYLOAD.reply);
    expect(assistantMsg.content).toContain('Debounced Search');
    expect(assistantMsg.content).toContain('react-apps/medium');
    expect(assistantMsg.content).toContain('Implement a debounced search box.');
  });

  it('preserves raw text with an empty ideas list and returns to idle on NoObjectGeneratedError', async () => {
    const { llm } = makeFakeLlm([
      () => {
        throw new NoObjectGeneratedError({
          message: 'could not parse a structured object',
          text: 'raw salvage text from the model',
        } as ConstructorParameters<typeof NoObjectGeneratedError>[0]);
      },
    ]);
    const engine = createBrainstormEngine({ db, bus, workspaceRoot: tempRoot, llm });

    const done = waitFor('brainstorm-done');
    const { sessionId } = engine.startTurn(null, 'give me weird ideas');
    const { turn } = await done;

    expect(turn).toEqual({
      role: 'assistant',
      content: 'raw salvage text from the model',
      ideas: [],
    });

    const session = db.getBrainstormSession(sessionId)!;
    expect(session.status).toBe('idle');
    expect(session.messages[1]).toEqual(turn);
  });

  it('sets status error + errorMessage and emits brainstorm-error on a generic failure', async () => {
    const { llm } = makeFakeLlm([
      () => {
        throw new Error('the model API is down');
      },
    ]);
    const engine = createBrainstormEngine({ db, bus, workspaceRoot: tempRoot, llm });

    const errored = waitFor('brainstorm-error');
    const { sessionId } = engine.startTurn(null, 'idea');
    const { message } = await errored;

    expect(message).toBe('the model API is down');

    const session = db.getBrainstormSession(sessionId)!;
    expect(session.status).toBe('error');
    expect(session.errorMessage).toBe('the model API is down');
    expect(session.messages).toHaveLength(1); // no assistant turn appended
    expect(engine.isThinking(sessionId)).toBe(false);
  });

  it('throws synchronously when startTurn is called again on a thinking session before the first turn settles', async () => {
    const { llm, calls } = makeFakeLlm([() => VALID_IDEA_PAYLOAD]);
    const engine = createBrainstormEngine({ db, bus, workspaceRoot: tempRoot, llm });

    const done = waitFor('brainstorm-done');
    const { sessionId } = engine.startTurn(null, 'first');
    expect(engine.isThinking(sessionId)).toBe(true);

    expect(() => engine.startTurn(sessionId, 'second')).toThrow(
      /a brainstorm turn is already running for this session/,
    );

    await done;
    expect(calls).toHaveLength(1); // the throwing second call never reached the llm
    expect(engine.isThinking(sessionId)).toBe(false);
  });

  it('emits nothing and writes nothing after dispose(), even though the llm resolves later', async () => {
    let resolvePayload!: (v: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      resolvePayload = resolve;
    });
    const { llm, calls } = makeFakeLlm([async () => pending]);
    const engine = createBrainstormEngine({ db, bus, workspaceRoot: tempRoot, llm });

    const events: string[] = [];
    bus.subscribe((name) => events.push(name));

    const { sessionId } = engine.startTurn(null, 'idea');
    expect(calls).toHaveLength(1);

    engine.dispose();
    const countAtDispose = events.length;

    resolvePayload(VALID_IDEA_PAYLOAD);
    // Let the microtask/timer queue drain so runTurn's continuation runs.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events.length).toBe(countAtDispose);

    // Mirrors the disputes/reviews engines' convention: once disposed, a
    // settling call must not write through the db either (session teardown
    // may already be closing or have closed it) — only the persisted user
    // turn from before dispose is there.
    const session = db.getBrainstormSession(sessionId)!;
    expect(session.status).toBe('thinking');
    expect(session.messages).toHaveLength(1);
  });

  it('rejects an out-of-enum idea category via schema validation on the generic-error path; the session recovers on a later turn', async () => {
    const { llm, calls } = makeFakeLlm([
      () => ({
        reply: 'oops',
        ideas: [
          {
            title: 'Bad Category Idea',
            category: 'not-a-real-category',
            difficulty: 'medium',
            pitch: 'p',
            topic: 't',
          },
        ],
      }),
      () => VALID_IDEA_PAYLOAD,
    ]);
    const engine = createBrainstormEngine({ db, bus, workspaceRoot: tempRoot, llm });

    const errored = waitFor('brainstorm-error');
    const { sessionId } = engine.startTurn(null, 'weird idea');
    await errored;

    const erroredSession = db.getBrainstormSession(sessionId)!;
    expect(erroredSession.status).toBe('error');
    expect(erroredSession.errorMessage).not.toBeNull();

    const done = waitFor('brainstorm-done');
    engine.startTurn(sessionId, 'try again');
    await done;

    const recovered = db.getBrainstormSession(sessionId)!;
    expect(recovered.status).toBe('idle');
    // The stale error from turn 1 must not linger once the session recovers.
    expect(recovered.errorMessage).toBeNull();
    expect(calls).toHaveLength(2);
  });
});

describe('brainstorm playground exclusion (NEE-387)', () => {
  // Both pins guard the same one-line hazard: brainstorm.ts importing
  // CATEGORY_SLUGS instead of GENERATABLE_CATEGORY_SLUGS (a plausible merge
  // resolution — Library/History legitimately use the full list). That
  // revert typechecks and every other test stays green, but the LLM would
  // then mint playground idea cards whose Generate click 400s server-side
  // ('category must be one of: …' — routes/generation.ts).

  it('IdeaListSchema rejects an otherwise-valid idea carrying a playground category', () => {
    const withCategory = (category: string) => ({
      ...VALID_IDEA_PAYLOAD,
      ideas: [{ ...VALID_IDEA_PAYLOAD.ideas[0], category }],
    });
    // Anchor: the same payload with a generatable category parses — so the
    // rejections below can only come from the category enum itself.
    expect(IdeaListSchema.safeParse(withCategory('react-apps')).success).toBe(true);
    expect(IdeaListSchema.safeParse(withCategory('playground')).success).toBe(false);
    expect(IdeaListSchema.safeParse(withCategory('playground-ts')).success).toBe(false);
  });

  it('never advertises the playground categories in the system prompt sent to the llm', async () => {
    const { llm, calls } = makeFakeLlm([() => VALID_IDEA_PAYLOAD]);
    const engine = createBrainstormEngine({ db, bus, workspaceRoot: tempRoot, llm });

    const done = waitFor('brainstorm-done');
    engine.startTurn(null, 'idea about arrays');
    await done;

    const systemPrompt = calls[0].messages[0].content;
    // Anchor: the addendum's category list really is in this prompt…
    expect(systemPrompt).toContain('react-apps');
    // …and nothing in it (builder output or addendum) names a playground.
    expect(systemPrompt).not.toContain('playground');
  });
});

describe('brainstorm activity log (NEE-271)', () => {
  it('records one done run per turn with a single brainstorm step — prompt is the user message, streamed reply/ideas persist as the response', async () => {
    const { llm } = makeFakeLlm([() => VALID_IDEA_PAYLOAD]);
    const engine = createBrainstormEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      aiLog: createAiLog({ db, bus }),
    });

    const done = waitFor('brainstorm-done');
    const { sessionId } = engine.startTurn(null, 'idea about arrays');
    await done;

    const runs = db.listAiRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'brainstorm',
      refId: sessionId,
      questionId: null,
      label: 'idea about arrays',
      status: 'done',
    });

    const steps = db.listAiSteps(runs[0].id);
    expect(steps.map((s) => [s.slug, s.status])).toEqual([['brainstorm', 'done']]);
    expect(steps[0].detail).toBe('1 idea proposed');

    const step = db.getAiStep(steps[0].id)!;
    expect(step.promptText).toBe('idea about arrays');
    // IdeaListSchema is entirely wire-safe — the streamed partial landed.
    expect(step.responseText).toContain('Here are a few ideas.');
    expect(step.responseText).toContain('Debounced Search');
  });

  it('a NoObjectGeneratedError turn lands run=done with an errored step — the turn completed for the user (raw reply preserved)', async () => {
    const { llm } = makeFakeLlm([
      () => {
        throw new NoObjectGeneratedError({
          message: 'could not parse a structured object',
          text: 'raw salvage text from the model',
        } as ConstructorParameters<typeof NoObjectGeneratedError>[0]);
      },
    ]);
    const engine = createBrainstormEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      aiLog: createAiLog({ db, bus }),
    });

    const done = waitFor('brainstorm-done');
    engine.startTurn(null, 'give me weird ideas');
    await done;

    const [run] = db.listAiRuns();
    expect(run.status).toBe('done');
    const steps = db.listAiSteps(run.id);
    expect(steps.map((s) => [s.slug, s.status])).toEqual([['brainstorm', 'error']]);
    expect(steps[0].errorMessage).toContain('could not parse');
  });

  it('a generic failure lands run=error carrying the message on both the step and the run', async () => {
    const { llm } = makeFakeLlm([
      () => {
        throw new Error('the model API is down');
      },
    ]);
    const engine = createBrainstormEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      aiLog: createAiLog({ db, bus }),
    });

    const errored = waitFor('brainstorm-error');
    engine.startTurn(null, 'idea');
    await errored;

    const [run] = db.listAiRuns();
    expect(run.status).toBe('error');
    expect(run.errorMessage).toBe('the model API is down');
    const steps = db.listAiSteps(run.id);
    expect(steps.map((s) => [s.slug, s.status])).toEqual([['brainstorm', 'error']]);
    expect(steps[0].errorMessage).toBe('the model API is down');
  });
});
