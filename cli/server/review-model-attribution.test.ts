// The persisted `reviews.model` must name the model that actually WROTE the
// body. Re-resolving the slot after the call gets that wrong exactly when it
// matters: a Fable refusal retry is per-request and deliberately does NOT
// latch (cli/lib/llm.ts), so the slot still resolves to the model that
// refused while claude-opus-5 produced the text. chatStream reports every
// route it takes through `onRoute`; this pins that the engine records THAT.
//
// '../lib/llm.js' is fully mocked (the engine-stream-liveness.test.ts
// pattern) — the review engine has no injectable llm seam.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from './db.js';
import { createBus, type Bus } from './sse.js';
import type { AceDb, QuestionRow } from './types.js';

// Partial mock — see engine-stream-liveness.test.ts for why the pure
// helpers must stay real.
vi.mock('../lib/llm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/llm.js')>()),
  isMockLlm: vi.fn(() => true),
  hasAnyProvider: vi.fn(() => true),
  chatStream: vi.fn(),
  chatObject: vi.fn(async () => ({ score: null, verdict: null, dimensions: null })),
  chatObjectStream: vi.fn(),
  resolveSlot: vi.fn(() => ({
    provider: 'anthropic',
    model: 'claude-fable-5',
    source: 'default',
    warning: null,
  })),
  // What a post-call re-resolution would have recorded — the wrong answer.
  getModelId: vi.fn(() => 'claude-fable-5'),
}));

import { chatStream } from '../lib/llm.js';
import { createReviewEngine } from './reviews.js';

const mockChatStream = vi.mocked(chatStream);

let tempRoot = '';
let db: AceDb;
let bus: Bus;

function writeQuestion(slug: string): QuestionRow {
  const dir = path.join(tempRoot, 'questions', 'js-ts', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${slug}\n\nSolve it.\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'solution.ts'), 'export const x = 1;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'solution.test.ts'), "it('works', () => {});\n", 'utf8');
  return db.upsertQuestion({
    category: 'js-ts',
    slug,
    title: slug,
    difficulty: 'easy',
    suggestedMinutes: 15,
    dirPath: dir,
    source: 'manual',
  });
}

function waitFor(name: string): Promise<any> {
  return new Promise((resolve) => {
    const unsub = bus.subscribe((eventName, data) => {
      if (eventName === name) {
        unsub();
        resolve(data);
      }
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-review-model-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  db = openDb(tempRoot);
  bus = createBus();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('persisted review model', () => {
  it('records the route the call actually ran on, not a re-resolution of the slot', async () => {
    const question = writeQuestion('fable-refused');
    mockChatStream.mockImplementation(async (_slot, _messages, opts) => {
      // The refusal retry: the wrapper reports both routes, fallback last.
      opts?.onRoute?.({
        provider: 'anthropic',
        model: 'claude-fable-5',
        source: 'default',
        warning: null,
      });
      opts?.onRoute?.({
        provider: 'anthropic',
        model: 'claude-opus-5',
        source: 'fable-fallback',
        warning: null,
      });
      return {
        async *[Symbol.asyncIterator]() {
          yield 'Overall 4/5\n\nThe review body Opus wrote.';
        },
      };
    });

    const engine = createReviewEngine({ db, bus, workspaceRoot: tempRoot });
    const done = waitFor('review-done');
    engine.start(question, null);
    const { review } = await done;

    expect(review.model).toBe('claude-opus-5');
    engine.dispose();
  });

  it('falls back to the slot resolution when no route is reported (mock mode)', async () => {
    const question = writeQuestion('no-route-reported');
    mockChatStream.mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {
        yield 'Overall 4/5\n\nCanned mock body.';
      },
    }));

    const engine = createReviewEngine({ db, bus, workspaceRoot: tempRoot });
    const done = waitFor('review-done');
    engine.start(question, null);
    const { review } = await done;

    expect(review.model).toBe('claude-fable-5');
    engine.dispose();
  });
});
