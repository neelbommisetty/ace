// Activity-log instrumentation for the review and dispute engines (NEE-271).
// These engines have NO injectable llm seam (by design — see the ticket's
// seam note), so the tests drive them through ACE_E2E_MOCK_LLM + dynamic
// import, the workspace-reset.test.ts pattern, and assert the rows the
// shared recorder wrote straight off the db.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WITHHELD_MARKER } from '../lib/spoilers.js';
import type { createAiLog as CreateAiLogFn } from './ai-log.js';
import { openDb } from './db.js';
import type { createDisputeEngine as CreateDisputeEngineFn } from './disputes.js';
import type { createReviewEngine as CreateReviewEngineFn } from './reviews.js';
import { createBus, type Bus } from './sse.js';
import type { AceDb, QuestionRow, TestRunRow } from './types.js';

// lib/llm.js's mock-vs-real behavior is a module-level const read at import
// time — set the env var in beforeAll BEFORE dynamically importing anything
// that transitively reaches it (ai-log.js does too, via gen-pipeline.js).
let createReviewEngine: typeof CreateReviewEngineFn;
let createDisputeEngine: typeof CreateDisputeEngineFn;
let createAiLog: typeof CreateAiLogFn;

beforeAll(async () => {
  process.env.ACE_E2E_MOCK_LLM = '1';
  ({ createReviewEngine } = await import('./reviews.js'));
  ({ createDisputeEngine } = await import('./disputes.js'));
  ({ createAiLog } = await import('./ai-log.js'));
});

let tempRoot = '';
let db: AceDb;
let bus: Bus;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-engine-activity-'));
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

const SOLUTION_BODY =
  'export function solveEverything() { return 42; } // CANDIDATE_SOLUTION_MARKER\n';
const PACKET = '## Capability Tested\n\nHIDDEN_PACKET_MARKER guidance for the interviewer.\n';

function writeQuestion(slug: string, opts: { packet?: boolean } = {}): QuestionRow {
  const dir = path.join(tempRoot, 'questions', 'js-ts', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${slug}\n\nSolve it.\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'solution.ts'), SOLUTION_BODY, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'solution.test.ts'),
    "it('handles duplicate values', () => { expect(1).toBe(2); });\n",
    'utf8',
  );
  if (opts.packet) fs.writeFileSync(path.join(dir, '.interviewer.md'), PACKET, 'utf8');
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

describe('review engine activity log', () => {
  it('records a done run with review + review-extract steps; the prompt shows the candidate code but never the interviewer packet', async () => {
    const question = writeQuestion('reviewed', { packet: true });
    const engine = createReviewEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      aiLog: createAiLog({ db, bus }),
    });

    const done = waitFor('review-done');
    const { jobId } = engine.start(question, null);
    const { review: reviewRow } = await done;

    const runs = db.listAiRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'review',
      refId: jobId,
      questionId: question.id,
      label: 'Solve Everything',
      status: 'done',
    });

    const steps = db.listAiSteps(runs[0].id);
    expect(steps.map((s) => [s.slug, s.status])).toEqual([
      ['review', 'done'],
      ['review-extract', 'done'],
    ]);

    const review = db.getAiStep(steps[0].id)!;
    // The prompt is shown — it's the user's own code…
    expect(review.promptText).toContain('CANDIDATE_SOLUTION_MARKER');
    expect(review.promptText).toContain("Candidate's Solution Code");
    // …but the interviewer packet never reaches the recorded prompt: the
    // masked twin is constructed at the call site (packets embed their own
    // `## ` headings, so a parse-based mask alone would leak them).
    expect(review.promptText).not.toContain('HIDDEN_PACKET_MARKER');
    expect(review.promptText).toContain(WITHHELD_MARKER);
    // The streamed body rode append() into the step response ('OK' is the
    // modeless mock chatStream reply).
    expect(review.responseText).toBe('OK');

    const extract = db.getAiStep(steps[1].id)!;
    // The extraction prompt is the (already user-visible) review body itself.
    expect(extract.promptText).toBe('OK');
    expect(extract.detail).toBe('score 4/5 · Hire');
    expect(extract.responseText).toContain('Hire');

    // Extraction won over the regex fallback ('OK' matches nothing).
    expect(reviewRow.score).toBe(4);
    expect(reviewRow.verdict).toBe('Hire');
  });

  it('a failed extraction records an errored review-extract step without degrading the run — the regex fallback still lands the score', async () => {
    // 'feedback' makes the mock return prose: chatStream streams a real
    // review body, while the extraction chatObject call throws on it.
    process.env.ACE_MOCK_LLM_MODE = 'feedback';
    const question = writeQuestion('review-fallback');
    const engine = createReviewEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      aiLog: createAiLog({ db, bus }),
    });

    const done = waitFor('review-done');
    engine.start(question, null);
    const { review } = await done;

    // Regex fallback parsed 'Overall 4/5' out of the prose body.
    expect(review.score).toBe(4);

    const [run] = db.listAiRuns();
    expect(run.status).toBe('done');
    const steps = db.listAiSteps(run.id);
    expect(steps.map((s) => [s.slug, s.status])).toEqual([
      ['review', 'done'],
      ['review-extract', 'error'],
    ]);
    expect(steps[1].errorMessage).not.toBeNull();
  });
});

describe('dispute engine activity log', () => {
  function seedFailedRun(question: QuestionRow): TestRunRow {
    const run = db.createTestRun({ questionId: question.id, attemptId: null, trigger: 'manual' });
    return db.finishTestRun(run.id, {
      status: 'done',
      summary: { total: 1, passed: 0, failed: 1, skipped: 0, durationMs: 12 },
      results: [
        {
          name: 'handles duplicate values',
          suite: '',
          status: 'failed',
          durationMs: 3,
          error: 'AssertionError: expected 1 to be 2 — FAILURE_OUTPUT_MARKER',
        },
      ],
    });
  }

  it('records a done run with a single dispute step; prompt shows tests, failure output and argument but withholds the solution body', async () => {
    const question = writeQuestion('disputed');
    const testRun = seedFailedRun(question);
    const engine = createDisputeEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      aiLog: createAiLog({ db, bus }),
    });

    const done = waitFor('dispute-done');
    const { disputeJobId } = engine.start(question, testRun, 'either index order is fine');
    await done;

    const runs = db.listAiRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'dispute',
      refId: disputeJobId,
      questionId: question.id,
      label: 'Solve Everything',
      status: 'done',
    });

    const steps = db.listAiSteps(runs[0].id);
    expect(steps.map((s) => [s.slug, s.status])).toEqual([['dispute', 'done']]);
    expect(steps[0].detail).toBe('test_incorrect');

    const step = db.getAiStep(steps[0].id)!;
    // The user's own failing tests, output and argument are shown…
    expect(step.promptText).toContain('handles duplicate values');
    expect(step.promptText).toContain('FAILURE_OUTPUT_MARKER');
    expect(step.promptText).toContain('either index order is fine');
    // …while the chokepoint's unconditional mask withholds `## Solution Code`
    // (conservative — the section heading matches, so the body is masked).
    expect(step.promptText).not.toContain('CANDIDATE_SOLUTION_MARKER');
    expect(step.promptText).toContain(WITHHELD_MARKER);
    // DisputeResultSchema is entirely wire-safe — fixedTestCode included.
    expect(step.responseText).toContain('test_incorrect');
    expect(step.responseText).toContain('expect(result.sort()).toEqual([0, 1])');
  });

  it('a failed structured call lands run=error with the errored dispute step', async () => {
    // 'feedback' makes the mock return prose — the structured call throws.
    process.env.ACE_MOCK_LLM_MODE = 'feedback';
    const question = writeQuestion('disputed-error');
    const testRun = seedFailedRun(question);
    const engine = createDisputeEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      aiLog: createAiLog({ db, bus }),
    });

    const errored = waitFor('dispute-error');
    engine.start(question, testRun, null);
    await errored;

    const [aiRun] = db.listAiRuns();
    expect(aiRun.status).toBe('error');
    expect(aiRun.errorMessage).not.toBeNull();
    const steps = db.listAiSteps(aiRun.id);
    expect(steps.map((s) => [s.slug, s.status])).toEqual([['dispute', 'error']]);
  });
});
