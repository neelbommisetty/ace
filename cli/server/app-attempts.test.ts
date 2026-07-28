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
