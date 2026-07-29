// Server-side attempt end for prose categories (NEE-356).
//
// design/behavioral questions have `testFiles: []`, so the client's
// claim-'solved'-on-leave (useTestRuns) can never fire for them and their
// attempts used to stay open forever — which in turn made readonly
// reference mode, "Start new attempt" and a second round of follow-up
// probes unreachable. The review completing is now what ends the attempt,
// with an end reason that follows the same positive-verdict rule
// isQuestionSolved/listQuestions use.
//
// The review engine has no injectable llm seam (see engine-activity.test.ts)
// — these tests drive it through ACE_E2E_MOCK_LLM + dynamic import and
// assert straight off the db and the bus.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { isQuestionSolved as IsQuestionSolvedFn } from './app.js';
import { openDb } from './db.js';
import type {
  createReviewEngine as CreateReviewEngineFn,
  endProseAttemptOnReview as EndProseAttemptOnReviewFn,
} from './reviews.js';
import { createBus, type Bus } from './sse.js';
import type { AceDb, AttemptRow, QuestionRow } from './types.js';
import { getCategoryConfig } from '../lib/categories.js';

// lib/llm.js's mock-vs-real behavior is a module-level const read at import
// time — set the env var in beforeAll BEFORE importing anything that
// transitively reaches it. app.js counts: it reaches llm.js through the
// route modules, so a static import of isQuestionSolved would silently put
// the review engine back on the real-provider path.
let createReviewEngine: typeof CreateReviewEngineFn;
let endProseAttemptOnReview: typeof EndProseAttemptOnReviewFn;
let isQuestionSolved: typeof IsQuestionSolvedFn;

beforeAll(async () => {
  process.env.ACE_E2E_MOCK_LLM = '1';
  ({ createReviewEngine, endProseAttemptOnReview } = await import('./reviews.js'));
  ({ isQuestionSolved } = await import('./app.js'));
});

let tempRoot = '';
let db: AceDb;
let bus: Bus;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-review-attempt-end-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  db = openDb(tempRoot);
  bus = createBus();
});

afterEach(() => {
  delete process.env.ACE_MOCK_LLM_MODE;
  try {
    db.close();
  } catch {
    // already closed
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** A question on disk with exactly the files its category's config declares. */
function writeQuestion(category: 'behavioral' | 'js-ts', slug: string): QuestionRow {
  const config = getCategoryConfig(category);
  const dir = path.join(tempRoot, 'questions', category, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${slug}\n\nTell me about it.\n`, 'utf8');
  for (const name of config.solutionFiles) {
    fs.writeFileSync(path.join(dir, name), `content for ${name}\n`, 'utf8');
  }
  for (const name of config.testFiles) {
    fs.writeFileSync(path.join(dir, name), "it('works', () => {});\n", 'utf8');
  }
  return db.upsertQuestion({
    category,
    slug,
    title: slug,
    difficulty: 'medium',
    suggestedMinutes: 10,
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

describe('prose attempt ends when its review completes (NEE-356)', () => {
  it('a behavioral attempt closes as solved on review completion and announces itself over SSE', async () => {
    const question = writeQuestion('behavioral', 'greatest-failure');
    const attempt = db.createAttempt(question.id);
    const engine = createReviewEngine({ db, bus, workspaceRoot: tempRoot });

    // The mock extraction payload verdicts 'Hire' — at the bar.
    const ended = waitFor('attempt-ended');
    engine.start(question, attempt.id);
    const payload = (await ended) as { attemptId: string; questionId: string; attempt: AttemptRow };

    expect(payload.attemptId).toBe(attempt.id);
    expect(payload.questionId).toBe(question.id);
    expect(payload.attempt.endedAt).not.toBeNull();
    expect(payload.attempt.endReason).toBe('solved');

    const stored = db.getAttempt(attempt.id)!;
    expect(stored.endedAt).not.toBeNull();
    expect(stored.endReason).toBe('solved');
    expect(db.getActiveAttempt(question.id)).toBeNull();
    expect(isQuestionSolved(db, question.id)).toBe(true);
    expect(db.listQuestions()[0].stats.status).toBe('solved');
    engine.dispose();
  });

  it('a review with no positive verdict still closes the attempt — as "submitted", leaving the question unsolved', async () => {
    // 'feedback' mode streams a review body with a score but no hire-scale
    // verdict, and fails the structured extraction (it is not JSON) — the
    // regex fallback then parses verdict: null.
    process.env.ACE_MOCK_LLM_MODE = 'feedback';
    const question = writeQuestion('behavioral', 'conflict-story');
    const attempt = db.createAttempt(question.id);
    const engine = createReviewEngine({ db, bus, workspaceRoot: tempRoot });

    const ended = waitFor('attempt-ended');
    engine.start(question, attempt.id);
    const payload = (await ended) as { attempt: AttemptRow };

    expect(payload.attempt.endReason).toBe('submitted');
    expect(db.getLatestReview(question.id)!.verdict).toBeNull();
    expect(isQuestionSolved(db, question.id)).toBe(false);
    // Still in the rotation: unsolved, and now with a closed attempt the
    // Room can mint attempt #2 to revise in.
    expect(db.listQuestions()[0].stats.status).toBe('in-progress');
    engine.dispose();
  });

  it('a coding attempt is untouched by its review — the test run, not the review, ends those', async () => {
    const question = writeQuestion('js-ts', 'debounce');
    const attempt = db.createAttempt(question.id);
    const engine = createReviewEngine({ db, bus, workspaceRoot: tempRoot });

    const seen: string[] = [];
    const unsub = bus.subscribe((name) => seen.push(name));
    const done = waitFor('review-done');
    engine.start(question, attempt.id);
    await done;
    // 'attempt-ended' would be emitted synchronously right after
    // 'review-done', so it is already decided by the time this resolves.
    unsub();

    expect(seen).not.toContain('attempt-ended');
    expect(db.getAttempt(attempt.id)!.endedAt).toBeNull();
    expect(db.getActiveAttempt(question.id)!.id).toBe(attempt.id);
    engine.dispose();
  });
});

describe('endProseAttemptOnReview guards', () => {
  const review = (verdict: string | null) => ({
    id: 'r-1',
    questionId: 'q-1',
    attemptId: null,
    version: 1,
    at: new Date().toISOString(),
    model: null,
    verdict,
    score: null,
    dimensions: null,
    bodyMd: 'body',
    snapshotHash: null,
    source: 'user' as const,
  });

  it('leaves an attempt started after the review was requested alone', () => {
    const question = writeQuestion('behavioral', 'proud-moment');
    const reviewed = db.createAttempt(question.id);
    // createAttempt supersedes the previous one, so this is the live attempt
    // now — but it is NOT the attempt the review assessed.
    const fresh = db.createAttempt(question.id);

    const result = endProseAttemptOnReview({
      db,
      bus,
      question,
      config: getCategoryConfig('behavioral'),
      attemptId: reviewed.id,
      review: review('Hire'),
    });

    expect(result).toBeNull();
    expect(db.getAttempt(fresh.id)!.endedAt).toBeNull();
  });

  it('does nothing when the review was requested with no active attempt (readonly room)', () => {
    const question = writeQuestion('behavioral', 'readonly-review');
    const attempt = db.createAttempt(question.id);

    const result = endProseAttemptOnReview({
      db,
      bus,
      question,
      config: getCategoryConfig('behavioral'),
      attemptId: null,
      review: review('Hire'),
    });

    expect(result).toBeNull();
    expect(db.getAttempt(attempt.id)!.endedAt).toBeNull();
  });

  it('does nothing for a category that has tests', () => {
    const question = writeQuestion('js-ts', 'two-sum');
    const attempt = db.createAttempt(question.id);

    const result = endProseAttemptOnReview({
      db,
      bus,
      question,
      config: getCategoryConfig('js-ts'),
      attemptId: attempt.id,
      review: review('Strong Hire'),
    });

    expect(result).toBeNull();
    expect(db.getAttempt(attempt.id)!.endedAt).toBeNull();
  });
});
