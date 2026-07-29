// NEE-361: the review/dispute watchdogs must reset on raw response-body
// activity, not on text-chunk arrival — a buffering local proxy (or a long
// adaptive-thinking pause) can hold back every text delta for a whole turn
// while still forwarding bytes. These tests drive both engines with a fully
// mocked '../lib/llm.js' so the watchdog's 15s-interval / 180s-idle-window
// timing can be controlled with fake timers, independent of any real model
// call. (Contrast with engine-activity.test.ts, which drives the engines
// through the real ACE_E2E_MOCK_LLM path — that path resolves synchronously
// and can't exercise a stalled-vs-alive stream.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from './db.js';
import { createBus, type Bus } from './sse.js';
import type { AceDb, QuestionRow, TestRunRow } from './types.js';

vi.mock('../lib/llm.js', () => ({
  isMockLlm: vi.fn(() => true),
  chatStream: vi.fn(),
  chatObject: vi.fn(async () => ({ score: null, verdict: null, dimensions: null })),
  chatObjectStream: vi.fn(),
  getModelId: vi.fn(() => 'test-model'),
}));

import { chatObject, chatObjectStream, chatStream } from '../lib/llm.js';
import { createDisputeEngine } from './disputes.js';
import { createReviewEngine } from './reviews.js';

const mockChatStream = vi.mocked(chatStream);
const mockChatObject = vi.mocked(chatObject);
const mockChatObjectStream = vi.mocked(chatObjectStream);

/**
 * A controllable async-iterable stand-in for chatStream's real return value.
 * `activity()` simulates a raw response-body tick WITHOUT ever yielding a
 * text chunk (exactly the buffering-proxy/thinking-pause scenario) by
 * calling the onStreamActivity callback chatStream was given directly.
 * `push`/`finish` simulate real text chunks arriving. Aborting the signal
 * (the watchdog's own doing) rejects any pending read, mirroring how the
 * real AI SDK stream dies once its underlying fetch is aborted.
 */
function makeControllableTextStream(abortSignal: AbortSignal) {
  const queue: string[] = [];
  let waiter: (() => void) | null = null;
  let finished = false;
  let abortErr: Error | null = null;

  abortSignal.addEventListener('abort', () => {
    abortErr =
      abortSignal.reason instanceof Error ? abortSignal.reason : new Error('aborted');
    waiter?.();
  });

  return {
    push(chunk: string) {
      queue.push(chunk);
      waiter?.();
    },
    finish() {
      finished = true;
      waiter?.();
    },
    stream: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (abortErr) throw abortErr;
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          if (finished) return;
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
        }
      },
    },
  };
}

function writeQuestion(db: AceDb, tempRoot: string, slug: string): QuestionRow {
  const dir = path.join(tempRoot, 'questions', 'js-ts', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${slug}\n\nSolve it.\n`, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'solution.ts'),
    'export function solveEverything() { return 42; }\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'solution.test.ts'),
    "it('works', () => { expect(1).toBe(2); });\n",
    'utf8',
  );
  return db.upsertQuestion({
    category: 'js-ts',
    slug,
    title: 'Solve Everything',
    difficulty: 'easy',
    suggestedMinutes: 15,
    dirPath: dir,
    source: 'manual',
  });
}

function waitFor(bus: Bus, name: string): Promise<any> {
  return new Promise((resolve) => {
    const unsub = bus.subscribe((eventName, data) => {
      if (eventName === name) {
        unsub();
        resolve(data);
      }
    });
  });
}

let tempRoot = '';
let db: AceDb;
let bus: Bus;

beforeEach(() => {
  vi.clearAllMocks();
  mockChatObject.mockResolvedValue({ score: null, verdict: null, dimensions: null } as never);
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-stream-liveness-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  db = openDb(tempRoot);
  bus = createBus();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  try {
    db.close();
  } catch {
    // already closed
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('review engine stream liveness (NEE-361)', () => {
  it('raw-byte activity with no text chunks keeps a healthy review alive past the idle window', async () => {
    const question = writeQuestion(db, tempRoot, 'liveness-alive');
    let captured: { onStreamActivity?: () => void } | undefined;
    mockChatStream.mockImplementation(async (_provider, _messages, opts) => {
      captured = opts;
      const ctrl = makeControllableTextStream(opts!.abortSignal!);
      // Ping the watchdog every 60s of a 250s "call" — comfortably past the
      // 180s idle window IF nothing reset it, but each ping keeps it alive.
      (async () => {
        for (let i = 0; i < 4; i++) {
          await vi.advanceTimersByTimeAsync(60_000);
          opts?.onStreamActivity?.();
        }
        ctrl.push('The review body.');
        ctrl.finish();
      })();
      return ctrl.stream;
    });

    const engine = createReviewEngine({ db, bus, workspaceRoot: tempRoot });
    const done = waitFor(bus, 'review-done');
    const errored = waitFor(bus, 'review-error');
    engine.start(question, null);

    const result = await Promise.race([
      done.then((d) => ({ kind: 'done', d })),
      errored.then((d) => ({ kind: 'error', d })),
    ]);

    expect(result.kind).toBe('done');
    expect(captured).toBeDefined();
  });

  it('a genuinely dead stream still aborts, and salvages non-empty fullText, naming the file in the error', async () => {
    const question = writeQuestion(db, tempRoot, 'liveness-dead');
    mockChatStream.mockImplementation(async (_provider, _messages, opts) => {
      const ctrl = makeControllableTextStream(opts!.abortSignal!);
      // One real chunk lands, then the connection goes fully silent — no
      // further text AND no further raw-byte activity at all.
      ctrl.push('Partial review body that was actually paid for.');
      return ctrl.stream;
    });

    const engine = createReviewEngine({ db, bus, workspaceRoot: tempRoot });
    const errored = waitFor(bus, 'review-error');
    const jobId = engine.start(question, null).jobId;

    // Watchdog polls every 15s and trips once idle exceeds 180s.
    await vi.advanceTimersByTimeAsync(200_000);
    const { message } = await errored;

    expect(message).toMatch(/stalled/i);
    const salvagePath = path.join(tempRoot, '.ace', `review-salvage-${jobId}.md`);
    expect(message).toContain(salvagePath);
    expect(fs.existsSync(salvagePath)).toBe(true);
    expect(fs.readFileSync(salvagePath, 'utf8')).toBe(
      'Partial review body that was actually paid for.',
    );
  });
});

describe('dispute engine stream liveness (NEE-361)', () => {
  function seedFailedRun(question: QuestionRow): TestRunRow {
    const run = db.createTestRun({ questionId: question.id, attemptId: null, trigger: 'manual' });
    return db.finishTestRun(run.id, {
      status: 'done',
      summary: { total: 1, passed: 0, failed: 1, skipped: 0, durationMs: 12 },
      results: [
        {
          name: 'works',
          suite: '',
          status: 'failed',
          durationMs: 3,
          error: 'AssertionError: expected 1 to be 2',
        },
      ],
    });
  }

  const DISPUTE_RESULT = {
    verdict: 'test_incorrect' as const,
    summary: 'summary',
    details: 'details',
    failingTests: [],
    fixedTestCode: null,
    hint: null,
  };

  it('raw-byte activity with no partials keeps a healthy dispute call alive past the idle window', async () => {
    const question = writeQuestion(db, tempRoot, 'dispute-alive');
    const run = seedFailedRun(question);
    let captured: { onStreamActivity?: () => void } | undefined;
    mockChatObjectStream.mockImplementation(async (_provider, _messages, _schema, opts) => {
      captured = opts as never;
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(60_000);
        opts?.onStreamActivity?.();
      }
      return DISPUTE_RESULT as never;
    });

    const engine = createDisputeEngine({ db, bus, workspaceRoot: tempRoot });
    const done = waitFor(bus, 'dispute-done');
    const errored = waitFor(bus, 'dispute-error');
    engine.start(question, run, null);

    const result = await Promise.race([
      done.then((d) => ({ kind: 'done', d })),
      errored.then((d) => ({ kind: 'error', d })),
    ]);

    expect(result.kind).toBe('done');
    expect(captured).toBeDefined();
  });

  it('a genuinely dead dispute call still aborts after the idle window', async () => {
    const question = writeQuestion(db, tempRoot, 'dispute-dead');
    const run = seedFailedRun(question);
    mockChatObjectStream.mockImplementation(
      (_provider, _messages, _schema, opts) =>
        new Promise((_resolve, reject) => {
          opts?.abortSignal?.addEventListener('abort', () => {
            reject(opts.abortSignal!.reason ?? new Error('aborted'));
          });
        }),
    );

    const engine = createDisputeEngine({ db, bus, workspaceRoot: tempRoot });
    const errored = waitFor(bus, 'dispute-error');
    engine.start(question, run, null);

    await vi.advanceTimersByTimeAsync(200_000);
    const { message } = await errored;

    expect(message).toMatch(/stalled/i);
  });
});
