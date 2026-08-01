// Escalation rule (NEE-303 / plan ticket 4): a review escalates iff the
// target attempt already has a persisted review — a re-review of revised
// work is the high-stakes judgment call. isEscalatedReview is pure over the
// db (no LLM involved). reviewSlotFor additionally consults llm.js's
// resolveSlot('review-escalated') — mock mode (the top-level describe below,
// same beforeAll pattern as engine-activity.test.ts) reports its default
// regardless of keys, so a second isolated-env section exercises the real,
// key-gated collapse (anthropic-keyless installs have no escalation tier).
// The persisted-model + step-label assertions for a running review job (via
// the actual engine) are in the "escalation end-to-end" describe below.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupCategoryConfig, type CategoryConfig } from '../lib/categories.js';
import { openDb } from './db.js';
import type { createAiLog as CreateAiLogFn } from './ai-log.js';
import type {
  createReviewEngine as CreateReviewEngineFn,
  isEscalatedReview as IsEscalatedReviewFn,
  reviewSlotFor as ReviewSlotForFn,
} from './reviews.js';
import { createBus, type Bus } from './sse.js';
import type { AceDb, QuestionRow } from './types.js';

let tempRoot = '';
let db: AceDb;

/** The category every fixture below uses unless it says otherwise. */
const CODING = lookupCategoryConfig('js-ts') as CategoryConfig;
const BEHAVIORAL = lookupCategoryConfig('behavioral') as CategoryConfig;

function writeQuestion(slug: string, category = 'js-ts'): QuestionRow {
  return db.upsertQuestion({
    category,
    slug,
    title: slug,
    difficulty: 'easy',
    suggestedMinutes: 15,
    dirPath: path.join(tempRoot, 'questions', category, slug),
    source: 'manual',
  });
}

/** Same as writeQuestion, plus the on-disk files runJob actually reads. */
function writeQuestionWithFiles(slug: string, category = 'js-ts'): QuestionRow {
  const question = writeQuestion(slug, category);
  const config = lookupCategoryConfig(category) as CategoryConfig;
  fs.mkdirSync(question.dirPath, { recursive: true });
  fs.writeFileSync(path.join(question.dirPath, 'README.md'), `# ${slug}\n\nSolve it.\n`, 'utf8');
  for (const name of config.solutionFiles) {
    fs.writeFileSync(
      path.join(question.dirPath, name),
      'export function solveEverything() { return 42; }\n',
      'utf8',
    );
  }
  for (const name of config.testFiles) {
    fs.writeFileSync(
      path.join(question.dirPath, name),
      "it('works', () => { expect(1).toBe(1); });\n",
      'utf8',
    );
  }
  return question;
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

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-review-escalation-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  db = openDb(tempRoot);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// lib/llm.js's mock-vs-real behavior is a module-level const read at import
// time — set the env var in beforeAll BEFORE importing reviews.js (same
// pattern as engine-activity.test.ts / review-attempt-end.test.ts).
let isEscalatedReview: typeof IsEscalatedReviewFn;
let reviewSlotFor: typeof ReviewSlotForFn;
let createReviewEngine: typeof CreateReviewEngineFn;
let createAiLog: typeof CreateAiLogFn;

beforeAll(async () => {
  process.env.ACE_E2E_MOCK_LLM = '1';
  ({ isEscalatedReview, reviewSlotFor, createReviewEngine } = await import('./reviews.js'));
  ({ createAiLog } = await import('./ai-log.js'));
});

describe('isEscalatedReview', () => {
  it('is routine for the first review of an attempt (no prior review row)', () => {
    const question = writeQuestion('first-review');
    const attempt = db.createAttempt(question.id);

    expect(isEscalatedReview(db, CODING, question.id, attempt.id)).toBe(false);
  });

  it('escalates a second review of the same attempt', () => {
    const question = writeQuestion('second-review');
    const attempt = db.createAttempt(question.id);
    db.createReview({
      questionId: question.id,
      attemptId: attempt.id,
      bodyMd: 'first pass',
      source: 'user',
    });

    expect(isEscalatedReview(db, CODING, question.id, attempt.id)).toBe(true);
  });

  it('de-escalates back to routine on a fresh attempt, even with a prior review on the question', () => {
    const question = writeQuestion('fresh-attempt');
    const reviewed = db.createAttempt(question.id);
    db.createReview({
      questionId: question.id,
      attemptId: reviewed.id,
      bodyMd: 'first pass',
      source: 'user',
    });
    // createAttempt supersedes the previous one — this is a new attempt with
    // no review of its own yet.
    const fresh = db.createAttempt(question.id);

    expect(isEscalatedReview(db, CODING, question.id, fresh.id)).toBe(false);
  });

  it('is always routine for a null attemptId (readonly room, no active attempt)', () => {
    const question = writeQuestion('readonly-review');
    const attempt = db.createAttempt(question.id);
    db.createReview({
      questionId: question.id,
      attemptId: attempt.id,
      bodyMd: 'first pass',
      source: 'user',
    });

    expect(isEscalatedReview(db, CODING, question.id, null)).toBe(false);
  });

  // Prose categories end the reviewed attempt inside the review job itself
  // (endProseAttemptOnReview), so an attempt can never hold two reviews and
  // the attempt-scoped test above could never fire for them — the escalated
  // tier would be dead code for design and behavioral. There the revision IS
  // the next attempt.
  describe('prose categories (attempt ends on review #1)', () => {
    it('is routine for the first review of a behavioral question', () => {
      const question = writeQuestion('prose-first', 'behavioral');
      const attempt = db.createAttempt(question.id);

      expect(isEscalatedReview(db, BEHAVIORAL, question.id, attempt.id)).toBe(false);
    });

    it('escalates the next review after one is on record, on a FRESH attempt', () => {
      const question = writeQuestion('prose-second', 'behavioral');
      const reviewed = db.createAttempt(question.id);
      db.createReview({
        questionId: question.id,
        attemptId: reviewed.id,
        bodyMd: 'first pass',
        source: 'user',
      });
      // What the room does after the review ends `reviewed`: a new attempt,
      // with no review of its own.
      const fresh = db.createAttempt(question.id);

      expect(isEscalatedReview(db, BEHAVIORAL, question.id, fresh.id)).toBe(true);
    });

    it('escalates even with no active attempt to target', () => {
      const question = writeQuestion('prose-null-attempt', 'behavioral');
      const reviewed = db.createAttempt(question.id);
      db.createReview({
        questionId: question.id,
        attemptId: reviewed.id,
        bodyMd: 'first pass',
        source: 'user',
      });

      expect(isEscalatedReview(db, BEHAVIORAL, question.id, null)).toBe(true);
    });
  });
});

describe('reviewSlotFor (mock mode — resolveSlot reports its default regardless of keys)', () => {
  it('routes the routine slot for a first review', () => {
    const question = writeQuestion('routine-slot');
    const attempt = db.createAttempt(question.id);

    expect(reviewSlotFor(db, CODING, question.id, attempt.id)).toBe('review');
  });

  it('routes the escalated slot for a re-review, when the escalated route resolves', () => {
    const question = writeQuestion('escalated-slot');
    const attempt = db.createAttempt(question.id);
    db.createReview({
      questionId: question.id,
      attemptId: attempt.id,
      bodyMd: 'first pass',
      source: 'user',
    });

    expect(reviewSlotFor(db, CODING, question.id, attempt.id)).toBe('review-escalated');
  });
});

describe('escalation end-to-end (persisted model + step label)', () => {
  it('a routine (first) review persists the review slot\'s model under a plain step label', async () => {
    const question = writeQuestionWithFiles('e2e-routine');
    const attempt = db.createAttempt(question.id);
    const bus = createBus();
    const aiLog = createAiLog({ db, bus });
    const engine = createReviewEngine({ db, bus, workspaceRoot: tempRoot, aiLog });

    const done = waitFor(bus, 'review-done');
    engine.start(question, attempt.id);
    const { review } = await done;

    // Mock mode's SLOT_ROUTES default for 'review' — see llm.ts.
    expect(review.model).toBe('claude-sonnet-5');
    const [run] = db.listAiRuns();
    const [step] = db.listAiSteps(run.id);
    expect(step.label).toBe('Writing the review');
    engine.dispose();
  });

  it('a re-review of the same attempt persists the escalated slot\'s model, labeled as escalated', async () => {
    const question = writeQuestionWithFiles('e2e-escalated');
    const attempt = db.createAttempt(question.id);
    db.createReview({
      questionId: question.id,
      attemptId: attempt.id,
      bodyMd: 'first pass',
      source: 'user',
    });
    const bus = createBus();
    const aiLog = createAiLog({ db, bus });
    const engine = createReviewEngine({ db, bus, workspaceRoot: tempRoot, aiLog });

    const done = waitFor(bus, 'review-done');
    engine.start(question, attempt.id);
    const { review } = await done;

    // Mock mode's SLOT_ROUTES default for 'review-escalated' — see llm.ts.
    expect(review.model).toBe('claude-opus-5');
    expect(review.version).toBe(2);
    const [run] = db.listAiRuns();
    const [step] = db.listAiSteps(run.id);
    expect(step.label).toBe('Writing the review (escalated)');
    engine.dispose();
  });

  // The escalated tier used to be unreachable for design/behavioral: review #1
  // ends the attempt it just assessed, so every later review targeted either a
  // brand-new attempt or none at all, and the attempt-scoped rule read routine
  // forever. This drives the exact sequence a behavioral room produces.
  it('a behavioral re-review escalates even though review #1 ended its attempt', async () => {
    const question = writeQuestionWithFiles('e2e-behavioral', 'behavioral');
    const attempt = db.createAttempt(question.id);
    const bus = createBus();
    const aiLog = createAiLog({ db, bus });
    const engine = createReviewEngine({ db, bus, workspaceRoot: tempRoot, aiLog });

    const firstDone = waitFor(bus, 'review-done');
    engine.start(question, attempt.id);
    const first = await firstDone;
    expect(first.review.model).toBe('claude-sonnet-5');
    // The review closed the attempt it assessed — that is what used to make
    // every subsequent review routine.
    expect(db.getActiveAttempt(question.id)).toBeNull();

    // The room reopens on a fresh attempt (the user revises the story).
    const revised = db.createAttempt(question.id);
    const secondDone = waitFor(bus, 'review-done');
    engine.start(question, revised.id);
    const second = await secondDone;

    expect(second.review.model).toBe('claude-opus-5');
    const labels = db.listAiRuns().flatMap((run) => db.listAiSteps(run.id).map((s) => s.label));
    expect(labels).toContain('Writing the review (escalated)');
    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// Real, key-gated collapse: an openai-only install has no route for
// 'review-escalated' (llm.ts's SLOT_ROUTES has no alternate for it), so
// reviewSlotFor must fall back to 'review' even though the escalation rule
// itself fires. Needs ACE_E2E_MOCK_LLM UNSET and a temp HOME so resolveSlot
// reads exactly the config this section writes — same hygiene as
// llm.test.ts's "Non-mock routing" section.
// ---------------------------------------------------------------------------
describe('reviewSlotFor — anthropic-keyless collapse', () => {
  const ISOLATED_ENV_KEYS = ['HOME', 'USERPROFILE', 'ACE_E2E_MOCK_LLM', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  const saved: Record<string, string | undefined> = {};
  let isolatedHome = '';

  beforeEach(() => {
    for (const key of ISOLATED_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-review-escalation-env-'));
    process.env.HOME = isolatedHome;
    fs.mkdirSync(path.join(isolatedHome, '.ace'), { recursive: true });
    fs.writeFileSync(
      path.join(isolatedHome, '.ace', 'config.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-oai' }),
      'utf-8',
    );
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  });

  it('falls back to the routine slot for a re-review when only an openai key is configured', async () => {
    // Fresh module graph so llm.js's module-level mockLlm const and cached
    // config are re-evaluated against the isolated env set up above.
    vi.resetModules();
    const { isEscalatedReview: realIsEscalatedReview, reviewSlotFor: realReviewSlotFor } =
      await import('./reviews.js');

    const question = writeQuestion('keyless-collapse');
    const attempt = db.createAttempt(question.id);
    db.createReview({
      questionId: question.id,
      attemptId: attempt.id,
      bodyMd: 'first pass',
      source: 'user',
    });

    // The rule itself still fires (this IS a re-review)…
    expect(realIsEscalatedReview(db, CODING, question.id, attempt.id)).toBe(true);
    // …but with no anthropic key, 'review-escalated' has no route at all
    // (it is the one slot with no alternate), so the job stays on 'review'.
    expect(realReviewSlotFor(db, CODING, question.id, attempt.id)).toBe('review');
  });
});
