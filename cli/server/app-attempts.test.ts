// @vitest-environment node
//
// Route-level tests for PATCH /api/attempts/:id, focused on the 'solved' end
// reason: the server re-verifies from test_runs rather than trusting the
// client, and the check is attempt-scoped (a stale passing run from a
// PREVIOUS attempt must never close a fresh re-attempt). Mirrors
// app-session.test.ts's harness: a real Hono app + real Request/Response
// over a real (temp-dir) db, with fake engines injected so nothing touches
// the LLM or spawns vitest.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, makeWorkspace, type WorkspaceHandle } from './test-support.js';
import type { AttemptRow, QuestionRow, TestRunSummary } from './types.js';

let ws: WorkspaceHandle;

beforeEach(() => {
  ws = makeWorkspace('app-attempts');
});

afterEach(() => {
  ws.cleanup();
});

function buildApp() {
  return makeApp({ getWorkspaceRoot: () => ws.root, getSession: () => ws.session }).fetch;
}

function patchAttempt(fetch: ReturnType<typeof buildApp>, attemptId: string, body: unknown) {
  return fetch(`/api/attempts/${attemptId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postAttempts(fetch: ReturnType<typeof buildApp>, category: string, slug: string) {
  return fetch(`/api/questions/${category}/${slug}/attempts`, { method: 'POST' });
}

function makeQuestion(): QuestionRow {
  return ws.session.db.upsertQuestion({
    category: 'js-ts',
    slug: 'debounce',
    title: 'Debounce',
    difficulty: 'medium',
    suggestedMinutes: 30,
    dirPath: path.join(ws.root, 'questions', 'js-ts', 'debounce'),
    source: 'manual',
  });
}

/** Same as `makeQuestion`, but for a no-test category (NEE-353). */
function makeProseQuestion(category: string, slug: string): QuestionRow {
  return ws.session.db.upsertQuestion({
    category,
    slug,
    title: slug,
    difficulty: 'medium',
    suggestedMinutes: 20,
    dirPath: path.join(ws.root, 'questions', category, slug),
    source: 'manual',
  });
}

/** Creates and finishes a 'done' test run, stamped `at` = now. */
function makeDoneRun(questionId: string, summary: TestRunSummary): void {
  const run = ws.session.db.createTestRun({ questionId, attemptId: null, trigger: 'manual' });
  ws.session.db.finishTestRun(run.id, { status: 'done', summary });
}

const PASSING: TestRunSummary = { total: 2, passed: 2, failed: 0, skipped: 0, durationMs: 5 };
const FAILING: TestRunSummary = { total: 2, passed: 1, failed: 1, skipped: 0, durationMs: 5 };

describe('PATCH /api/attempts/:id — end reason "solved"', () => {
  it('ends the attempt when the latest done run is fully passing and postdates it', async () => {
    const q = makeQuestion();
    const attempt = ws.session.db.createAttempt(q.id);
    makeDoneRun(q.id, PASSING);

    const fetch = buildApp();
    const res = await patchAttempt(fetch, attempt.id, { end: { reason: 'solved' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.endedAt).not.toBeNull();
    expect(body.attempt.endReason).toBe('solved');
  });

  it('is ignored (200, attempt stays open) when the latest done run has failures', async () => {
    const q = makeQuestion();
    const attempt = ws.session.db.createAttempt(q.id);
    makeDoneRun(q.id, FAILING);

    const fetch = buildApp();
    const res = await patchAttempt(fetch, attempt.id, { end: { reason: 'solved' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.endedAt).toBeNull();
    expect(body.attempt.endReason).toBeNull();
  });

  it('is ignored when the latest done run has total=0', async () => {
    const q = makeQuestion();
    const attempt = ws.session.db.createAttempt(q.id);
    makeDoneRun(q.id, { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 1 });

    const fetch = buildApp();
    const res = await patchAttempt(fetch, attempt.id, { end: { reason: 'solved' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.endedAt).toBeNull();
  });

  it('is ignored when no runs exist at all', async () => {
    const q = makeQuestion();
    const attempt = ws.session.db.createAttempt(q.id);

    const fetch = buildApp();
    const res = await patchAttempt(fetch, attempt.id, { end: { reason: 'solved' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.endedAt).toBeNull();
  });

  it('is ignored when a newer failing done run follows an older green one', async () => {
    const q = makeQuestion();
    const attempt = ws.session.db.createAttempt(q.id);
    makeDoneRun(q.id, PASSING);
    makeDoneRun(q.id, FAILING);

    const fetch = buildApp();
    const res = await patchAttempt(fetch, attempt.id, { end: { reason: 'solved' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.endedAt).toBeNull();
  });

  it('is ignored when the only fully-passing done run predates the attempt (stale run from a prior attempt)', async () => {
    const q = makeQuestion();

    // First attempt solves the question...
    const firstAttempt = ws.session.db.createAttempt(q.id);
    const run = ws.session.db.createTestRun({
      questionId: q.id,
      attemptId: firstAttempt.id,
      trigger: 'manual',
    });
    ws.session.db.finishTestRun(run.id, { status: 'done', summary: PASSING });
    ws.session.db.patchAttempt(firstAttempt.id, { end: { reason: 'solved' } });

    // ...then, strictly later in real time, a fresh re-attempt starts. Both
    // createAttempt and createTestRun stamp `at`/`startedAt` with nowIso()
    // (millisecond resolution), so a short real delay guarantees the new
    // attempt's startedAt sorts after the old passing run's `at`.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondAttempt = ws.session.db.createAttempt(q.id);
    expect(secondAttempt.startedAt > run.at).toBe(true);

    const fetch = buildApp();
    const res = await patchAttempt(fetch, secondAttempt.id, { end: { reason: 'solved' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.endedAt).toBeNull();
    expect(body.attempt.endReason).toBeNull();
  });

  it('still applies activeSecondsDelta from a combined body even when the end is rejected', async () => {
    const q = makeQuestion();
    const attempt = ws.session.db.createAttempt(q.id);
    makeDoneRun(q.id, FAILING);

    const fetch = buildApp();
    const res = await patchAttempt(fetch, attempt.id, {
      activeSecondsDelta: 12,
      end: { reason: 'solved' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.activeSeconds).toBe(12);
    expect(body.attempt.endedAt).toBeNull();
  });
});

describe('PATCH /api/attempts/:id — other end reasons', () => {
  it.each(['abandoned', 'submitted', 'superseded'] as const)(
    'ends the attempt unconditionally for reason=%s',
    async (reason) => {
      const q = makeQuestion();
      const attempt = ws.session.db.createAttempt(q.id);
      // no passing run at all — these reasons must not care
      const fetch = buildApp();
      const res = await patchAttempt(fetch, attempt.id, { end: { reason } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { attempt: AttemptRow };
      expect(body.attempt.endedAt).not.toBeNull();
      expect(body.attempt.endReason).toBe(reason);
    },
  );

  it('rejects the old "green" reason as invalid (400)', async () => {
    const q = makeQuestion();
    const attempt = ws.session.db.createAttempt(q.id);
    const fetch = buildApp();
    const res = await patchAttempt(fetch, attempt.id, { end: { reason: 'green' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/questions/:category/:slug/attempts', () => {
  it('returns a readonly response with the latest attempt for a solved question with no active attempt', async () => {
    const q = makeQuestion();
    const first = ws.session.db.createAttempt(q.id);
    makeDoneRun(q.id, PASSING);
    ws.session.db.patchAttempt(first.id, { end: { reason: 'solved' } });

    const fetch = buildApp();
    const res = await postAttempts(fetch, q.category, q.slug);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attempt: AttemptRow | null;
      readonly?: boolean;
      latestAttempt?: AttemptRow | null;
    };
    expect(body.attempt).toBeNull();
    expect(body.readonly).toBe(true);
    expect(body.latestAttempt?.id).toBe(first.id);

    // No new attempt was minted — the latest attempt on the question is
    // still the one that was just solved.
    expect(ws.session.db.getLatestAttempt(q.id)?.id).toBe(first.id);
  });

  it('resumes the open attempt on a solved question that still has one active', async () => {
    const q = makeQuestion();
    const attempt = ws.session.db.createAttempt(q.id);
    makeDoneRun(q.id, PASSING);
    // Deliberately do NOT end the attempt — solved-but-still-open, the
    // "keep polishing" case: resumes rather than going readonly.

    const fetch = buildApp();
    const res = await postAttempts(fetch, q.category, q.slug);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.id).toBe(attempt.id);
    expect(body.attempt.endedAt).toBeNull();
  });

  it('creates attempt #1 and captures the scaffold baseline for an unsolved question', async () => {
    const q = makeQuestion();
    const dir = path.join(ws.root, 'questions', 'js-ts', 'debounce');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'solution.js'), 'module.exports = () => {};\n');

    const fetch = buildApp();
    const res = await postAttempts(fetch, q.category, q.slug);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.number).toBe(1);
    expect(body.attempt.endedAt).toBeNull();
  });
});

// NEE-353: no-test categories (design/behavioral, testFiles: []) can never
// produce a test run, so isQuestionSolved/isAttemptSolved (app.ts) derive
// solved from a review instead — the same rule listQuestions applies
// (db.ts). These route-level tests exercise the actual regression:
// before this fix, isQuestionSolved/isAttemptSolved stayed on the
// test-run-only definition even though listQuestions had already moved to
// the review-based one, so a reviewed prose question read 'solved' in the
// Library but PATCH .../attempts could never accept reason: 'solved' for it
// and POST .../attempts never returned { readonly: true }.
//
// NEE-356 made every one of those derivations verdict-aware: only a review
// at the Hire tier or above solves the question, so a 'No Hire' can no
// longer flip it to solved (and out of "Practice next") behind the user's
// back.
describe('prose (no-test category) solved derivation — PATCH/POST /api/attempts (NEE-353, NEE-356)', () => {
  it('a reviewed behavioral question ends solved and reopens readonly', async () => {
    const q = makeProseQuestion('behavioral', 'greatest-failure');
    const attempt = ws.session.db.createAttempt(q.id);
    ws.session.db.createReview({
      questionId: q.id,
      attemptId: null,
      bodyMd: 'Solid story, clear ownership.',
      verdict: 'Hire',
      source: 'user',
    });

    const fetch = buildApp();

    // The end-verify route accepts reason: 'solved' now that a review exists.
    const endRes = await patchAttempt(fetch, attempt.id, { end: { reason: 'solved' } });
    expect(endRes.status).toBe(200);
    const endBody = (await endRes.json()) as { attempt: AttemptRow };
    expect(endBody.attempt.endedAt).not.toBeNull();
    expect(endBody.attempt.endReason).toBe('solved');

    // Reopening the question (no active attempt left) returns the readonly
    // reference view instead of minting a fresh, editable attempt.
    const postRes = await postAttempts(fetch, q.category, q.slug);
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as {
      attempt: AttemptRow | null;
      readonly?: boolean;
      latestAttempt?: AttemptRow | null;
    };
    expect(postBody.attempt).toBeNull();
    expect(postBody.readonly).toBe(true);
    expect(postBody.latestAttempt?.id).toBe(attempt.id);
  });

  it('a "No Hire" review never solves a design question: the claim is dropped and reopening mints a fresh, editable attempt (NEE-356)', async () => {
    const q = makeProseQuestion('design-fe', 'infinite-scroll');
    const attempt = ws.session.db.createAttempt(q.id);
    // A completed review is NOT a pass. Solved needs a positive verdict, so
    // this question stays unsolved and stays in the practice rotation.
    ws.session.db.createReview({
      questionId: q.id,
      attemptId: null,
      bodyMd: 'Missed several trade-offs.',
      verdict: 'No Hire',
      source: 'user',
    });

    const fetch = buildApp();
    // The client's 'solved' claim is re-verified and silently dropped.
    const endRes = await patchAttempt(fetch, attempt.id, { end: { reason: 'solved' } });
    expect(endRes.status).toBe(200);
    const endBody = (await endRes.json()) as { attempt: AttemptRow };
    expect(endBody.attempt.endedAt).toBeNull();
    expect(endBody.attempt.endReason).toBeNull();

    // The server-side end (endProseAttemptOnReview) uses 'submitted' for a
    // sub-bar verdict; the question is still unsolved, so reopening mints
    // attempt #2 to revise in rather than a readonly reference.
    ws.session.db.patchAttempt(attempt.id, { end: { reason: 'submitted' } });
    const postRes = await postAttempts(fetch, q.category, q.slug);
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as {
      attempt: AttemptRow | null;
      readonly?: boolean;
    };
    expect(postBody.readonly).toBeUndefined();
    expect(postBody.attempt?.number).toBe(2);
    expect(postBody.attempt?.endedAt).toBeNull();
  });

  it('a "Lean Hire" review sits below the bar too — same unsolved treatment as "No Hire"', async () => {
    const q = makeProseQuestion('design-be', 'rate-limiter');
    const attempt = ws.session.db.createAttempt(q.id);
    ws.session.db.createReview({
      questionId: q.id,
      attemptId: null,
      bodyMd: 'Almost there.',
      verdict: 'Lean Hire',
      source: 'user',
    });

    const fetch = buildApp();
    const endRes = await patchAttempt(fetch, attempt.id, { end: { reason: 'solved' } });
    const endBody = (await endRes.json()) as { attempt: AttemptRow };
    expect(endBody.attempt.endedAt).toBeNull();
  });

  it('an attempted-but-unreviewed prose question is not solved: end reason "solved" is ignored and the attempt stays open/editable', async () => {
    const q = makeProseQuestion('behavioral', 'conflict-story');
    const attempt = ws.session.db.createAttempt(q.id);

    const fetch = buildApp();
    const endRes = await patchAttempt(fetch, attempt.id, { end: { reason: 'solved' } });
    expect(endRes.status).toBe(200);
    const endBody = (await endRes.json()) as { attempt: AttemptRow };
    expect(endBody.attempt.endedAt).toBeNull();
    expect(endBody.attempt.endReason).toBeNull();

    // Reopening resumes the still-active, editable attempt rather than going
    // readonly.
    const postRes = await postAttempts(fetch, q.category, q.slug);
    const postBody = (await postRes.json()) as { attempt: AttemptRow; readonly?: boolean };
    expect(postBody.attempt.id).toBe(attempt.id);
    expect(postBody.readonly).toBeUndefined();
  });

  it('a review recorded before the attempt started must not close that attempt as solved (recency)', async () => {
    const q = makeProseQuestion('behavioral', 'proud-moment');

    // A prior attempt gets reviewed and superseded by a fresh one, the same
    // way a stale passing test run is guarded against for coding questions.
    ws.session.db.createAttempt(q.id);
    const review = ws.session.db.createReview({
      questionId: q.id,
      attemptId: null,
      bodyMd: 'Fine.',
      verdict: 'Hire',
      source: 'user',
    });

    // Strictly later in real time, a fresh re-attempt starts (createAttempt
    // auto-supersedes the still-open firstAttempt). Both createAttempt and
    // createReview stamp with nowIso() (millisecond resolution), so a short
    // real delay guarantees the new attempt's startedAt sorts after the old
    // review's `at`.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondAttempt = ws.session.db.createAttempt(q.id);
    expect(secondAttempt.startedAt > review.at).toBe(true);

    const fetch = buildApp();
    const res = await patchAttempt(fetch, secondAttempt.id, { end: { reason: 'solved' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.endedAt).toBeNull();
    expect(body.attempt.endReason).toBeNull();
  });
});
