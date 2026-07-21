import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NoObjectGeneratedError } from 'ai';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LLMMessage, LLMProvider } from '../lib/llm.js';
import type { createBrainstormEngine as CreateBrainstormEngineFn } from './brainstorm.js';
import { openDb } from './db.js';
import { createBus, type Bus } from './sse.js';
import type { AceDb } from './types.js';

// `resolveProvider` (called by the engine) transitively imports lib/llm.js,
// whose mock-vs-real behavior is a module-level const read at import time —
// same reason cli/lib/llm.test.ts and workspace-reset.test.ts set the env var
// in beforeAll before a dynamic import, rather than a static top-level one.
let createBrainstormEngine: typeof CreateBrainstormEngineFn;

beforeAll(async () => {
  process.env.ACE_E2E_MOCK_LLM = '1';
  ({ createBrainstormEngine } = await import('./brainstorm.js'));
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
 * Queue-based fake `chatObject`: each invocation pops the next handler.
 * Handlers return a raw payload — validated against the CALLER's own schema,
 * mirroring what `generateObject` really does — or throw directly (used to
 * simulate `NoObjectGeneratedError` and generic failures without going
 * through schema validation at all).
 */
function makeFakeLlm(
  handlers: Array<
    (provider: LLMProvider, messages: LLMMessage[]) => unknown | Promise<unknown>
  >,
) {
  const calls: Array<{ provider: LLMProvider; messages: LLMMessage[] }> = [];
  let i = 0;
  const chatObject = async (provider: LLMProvider, messages: LLMMessage[], schema: any) => {
    calls.push({ provider, messages });
    const handler = handlers[i++];
    if (!handler) throw new Error('fake llm: no more handlers queued');
    const payload = await handler(provider, messages);
    return schema.parse(payload);
  };
  return {
    llm: { chatObject } as unknown as Parameters<typeof CreateBrainstormEngineFn>[0]['llm'],
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
    expect(calls[0].messages[0].content).toContain('Collaborative Interview Question Designer');

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
