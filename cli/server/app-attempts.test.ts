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
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { runImport, previewImport } from './importer.js';
import { createWorkspaceSession, type EngineFactories, type WorkspaceSession } from './session.js';
import { createBus } from './sse.js';
import type { AttemptRow, QuestionRow, TestRunSummary } from './types.js';

const TOKEN = 'test-token';

let tempRoot = '';
let session: WorkspaceSession;

/** Fake engine factories — never touch the LLM or spawn vitest. */
function fakeEngines(): EngineFactories {
  return {
    createRunner: (() => ({
      start: vi.fn(),
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createRunner'],
    createReviewEngine: (() => ({
      start: vi.fn(),
      isRunning: vi.fn(() => false),
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createReviewEngine'],
    createDisputeEngine: (() => ({
      start: vi.fn(),
      isRunning: vi.fn(() => false),
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createDisputeEngine'],
    createGenerationEngine: (() => ({
      start: vi.fn(),
      retry: vi.fn(),
      runningCount: vi.fn(() => 0),
      isAnyRunning: vi.fn(() => false),
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createGenerationEngine'],
    createBrainstormEngine: (() => ({
      startTurn: vi.fn(),
      isThinking: vi.fn(() => false),
      isAnyRunning: vi.fn(() => false),
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createBrainstormEngine'],
  };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-app-attempts-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  const bus = createBus();
  session = createWorkspaceSession({
    workspaceRoot: tempRoot,
    bus,
    watch: false,
    engines: fakeEngines(),
  });
});

afterEach(() => {
  session.db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function buildApp() {
  const bus = createBus();
  return createApp({
    bus,
    workspaceRoot: tempRoot,
    token: TOKEN,
    uiDir: null,
    version: '0.0.0-test',
    importer: { previewImport, runImport },
    getSession: () => session,
    isResetting: () => false,
  });
}

/**
 * app.request() builds a Request in-process, so nothing populates the `Host`
 * header from the URL automatically — the DNS-rebinding guard requires it.
 */
function request(app: ReturnType<typeof buildApp>, url: string, init: RequestInit = {}) {
  return app.request(url, {
    ...init,
    headers: { host: 'localhost', ...(init.headers as Record<string, string> | undefined) },
  });
}

function patchAttempt(app: ReturnType<typeof buildApp>, attemptId: string, body: unknown) {
  return request(app, `http://localhost/api/attempts/${attemptId}?t=${TOKEN}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeQuestion(): QuestionRow {
  return session.db.upsertQuestion({
    category: 'js-ts',
    slug: 'debounce',
    title: 'Debounce',
    difficulty: 'medium',
    suggestedMinutes: 30,
    dirPath: path.join(tempRoot, 'questions', 'js-ts', 'debounce'),
    source: 'manual',
  });
}

/** Creates and finishes a 'done' test run, stamped `at` = now. */
function makeDoneRun(questionId: string, summary: TestRunSummary): void {
  const run = session.db.createTestRun({ questionId, attemptId: null, trigger: 'manual' });
  session.db.finishTestRun(run.id, { status: 'done', summary });
}

const PASSING: TestRunSummary = { total: 2, passed: 2, failed: 0, skipped: 0, durationMs: 5 };
const FAILING: TestRunSummary = { total: 2, passed: 1, failed: 1, skipped: 0, durationMs: 5 };

describe('PATCH /api/attempts/:id — end reason "solved"', () => {
  it('ends the attempt when the latest done run is fully passing and postdates it', async () => {
    const q = makeQuestion();
    const attempt = session.db.createAttempt(q.id);
    makeDoneRun(q.id, PASSING);

    const app = buildApp();
    const res = await patchAttempt(app, attempt.id, { end: { reason: 'solved' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.endedAt).not.toBeNull();
    expect(body.attempt.endReason).toBe('solved');
  });

  it('is ignored (200, attempt stays open) when the latest done run has failures', async () => {
    const q = makeQuestion();
    const attempt = session.db.createAttempt(q.id);
    makeDoneRun(q.id, FAILING);

    const app = buildApp();
    const res = await patchAttempt(app, attempt.id, { end: { reason: 'solved' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.endedAt).toBeNull();
    expect(body.attempt.endReason).toBeNull();
  });

  it('is ignored when the latest done run has total=0', async () => {
    const q = makeQuestion();
    const attempt = session.db.createAttempt(q.id);
    makeDoneRun(q.id, { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 1 });

    const app = buildApp();
    const res = await patchAttempt(app, attempt.id, { end: { reason: 'solved' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.endedAt).toBeNull();
  });

  it('is ignored when no runs exist at all', async () => {
    const q = makeQuestion();
    const attempt = session.db.createAttempt(q.id);

    const app = buildApp();
    const res = await patchAttempt(app, attempt.id, { end: { reason: 'solved' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.endedAt).toBeNull();
  });

  it('is ignored when a newer failing done run follows an older green one', async () => {
    const q = makeQuestion();
    const attempt = session.db.createAttempt(q.id);
    makeDoneRun(q.id, PASSING);
    makeDoneRun(q.id, FAILING);

    const app = buildApp();
    const res = await patchAttempt(app, attempt.id, { end: { reason: 'solved' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.endedAt).toBeNull();
  });

  it('is ignored when the only fully-passing done run predates the attempt (stale run from a prior attempt)', async () => {
    const q = makeQuestion();

    // First attempt solves the question...
    const firstAttempt = session.db.createAttempt(q.id);
    const run = session.db.createTestRun({
      questionId: q.id,
      attemptId: firstAttempt.id,
      trigger: 'manual',
    });
    session.db.finishTestRun(run.id, { status: 'done', summary: PASSING });
    session.db.patchAttempt(firstAttempt.id, { end: { reason: 'solved' } });

    // ...then, strictly later in real time, a fresh re-attempt starts. Both
    // createAttempt and createTestRun stamp `at`/`startedAt` with nowIso()
    // (millisecond resolution), so a short real delay guarantees the new
    // attempt's startedAt sorts after the old passing run's `at`.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondAttempt = session.db.createAttempt(q.id);
    expect(secondAttempt.startedAt > run.at).toBe(true);

    const app = buildApp();
    const res = await patchAttempt(app, secondAttempt.id, { end: { reason: 'solved' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempt: AttemptRow };
    expect(body.attempt.endedAt).toBeNull();
    expect(body.attempt.endReason).toBeNull();
  });

  it('still applies activeSecondsDelta from a combined body even when the end is rejected', async () => {
    const q = makeQuestion();
    const attempt = session.db.createAttempt(q.id);
    makeDoneRun(q.id, FAILING);

    const app = buildApp();
    const res = await patchAttempt(app, attempt.id, {
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
      const attempt = session.db.createAttempt(q.id);
      // no passing run at all — these reasons must not care
      const app = buildApp();
      const res = await patchAttempt(app, attempt.id, { end: { reason } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { attempt: AttemptRow };
      expect(body.attempt.endedAt).not.toBeNull();
      expect(body.attempt.endReason).toBe(reason);
    },
  );

  it('rejects the old "green" reason as invalid (400)', async () => {
    const q = makeQuestion();
    const attempt = session.db.createAttempt(q.id);
    const app = buildApp();
    const res = await patchAttempt(app, attempt.id, { end: { reason: 'green' } });
    expect(res.status).toBe(400);
  });
});
