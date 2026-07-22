import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  CATEGORIES,
  CATEGORY_SLUGS,
  type CategoryConfig,
  type CategorySlug,
  type Difficulty,
} from '../lib/categories.js';
import { getQuestionsDir } from '../lib/paths.js';
import { getStubContent } from '../lib/scaffold.js';
import { readBlob, saveBlob } from './blobs.js';
import { applyDispute, DisputeApplyError, getDisputeGuardError } from './disputes.js';
import {
  ScopeError,
  readWorkspaceFile,
  resolveWorkspacePath,
  toWorkspaceRelPath,
  writeWorkspaceFile,
} from './files.js';
import { getReviewGuardError } from './reviews.js';
import { performWorkspaceReset } from './reset-orchestrator.js';
import type { EngineFactories, WorkspaceSession } from './session.js';
import {
  getSettingsInfo,
  resolveProvider,
  SettingsValidationError,
  updateSettings,
  type SettingsPatch,
} from './settings.js';
import type { Bus } from './sse.js';
import type {
  AceDb,
  AttemptEndReason,
  AttemptEventType,
  AttemptRow,
  ImportPreviewItem,
  ImportResult,
  QuestionDetail,
  QuestionFileInfo,
  QuestionRow,
  TestRunTrigger,
  WorkspaceInfo,
  WorkspaceResetMode,
} from './types.js';

export interface ImporterApi {
  previewImport(db: AceDb, root: string): ImportPreviewItem[];
  runImport(db: AceDb, root: string): ImportResult;
}

export interface CreateAppOptions {
  bus: Bus;
  workspaceRoot: string;
  token: string;
  uiDir: string | null;
  version: string;
  importer: ImporterApi;
  /** Accessor for the current WorkspaceSession — handlers read db/engines from it at entry. */
  getSession: () => WorkspaceSession;
  /** True while a workspace reset is in flight. Defaults to always false. */
  isResetting?: () => boolean;
  /** Swaps the live session — called by POST /api/workspace/reset after a successful reset. */
  swapSession?: (session: WorkspaceSession) => void;
  /** Flips the resetting flag; read by both the mid-reset 503 gate and this route's own guard. */
  setResetting?: (resetting: boolean) => void;
  /** Defaults to the real engine factories; tests inject fakes for the reset route too. */
  engines?: EngineFactories;
}

const HOST_RE = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const HEARTBEAT_MS = 25_000;

const ATTEMPT_EVENT_TYPES: ReadonlySet<string> = new Set<AttemptEventType>([
  'reveal',
  'first_edit',
  'test_run',
  'all_green',
  'pause',
  'resume',
]);
const END_REASONS: ReadonlySet<string> = new Set<AttemptEndReason>([
  'solved',
  'submitted',
  'abandoned',
  'superseded',
]);
const TRIGGERS: ReadonlySet<string> = new Set<TestRunTrigger>(['manual', 'save']);

/**
 * Question-level solved check: the latest *completed* run (by the same
 * ORDER BY as `listQuestions`' latestDone subquery) exists and passed
 * everything. Deliberately NOT the 'all_green' attempt event (runner.ts):
 * that event persists after later failing runs, so it would report solved
 * while the question's derived status reads in-progress — this predicate
 * keeps end-verify and status derivation consistent.
 */
export function isQuestionSolved(db: AceDb, questionId: string): boolean {
  const run = db.getLatestCompletedTestRun(questionId);
  return run != null && run.total != null && run.total > 0 && run.passed === run.total;
}

/**
 * Attempt-scoped solved check: the question is solved AND the passing run
 * does not predate the attempt being ended. This is what stops a stale green
 * run left over from a previous attempt (e.g. before a fresh re-attempt was
 * started) from closing a new attempt as 'solved' the instant it's created.
 */
export function isAttemptSolved(db: AceDb, attempt: AttemptRow): boolean {
  if (!isQuestionSolved(db, attempt.questionId)) return false;
  const run = db.getLatestCompletedTestRun(attempt.questionId);
  return run != null && run.at >= attempt.startedAt;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function constantTimeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createApp(opts: CreateAppOptions): Hono {
  const { bus, workspaceRoot, token, uiDir, version, importer, getSession, engines } = opts;
  const isResetting = opts.isResetting ?? (() => false);
  const swapSession = opts.swapSession ?? (() => {});
  const setResetting = opts.setResetting ?? (() => {});
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof ScopeError) {
      return c.json({ error: err.message }, 400);
    }
    console.error('[ace] unhandled server error:', err);
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500);
  });

  // DNS-rebinding guard: only loopback hosts may talk to this server.
  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (!host || !HOST_RE.test(host)) {
      return c.json({ error: 'forbidden host' }, 403);
    }
    await next();
  });

  // Token auth for the whole API (bearer header, or ?t= for EventSource).
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('authorization');
    const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    const candidate = bearer ?? c.req.query('t') ?? '';
    if (!candidate || !constantTimeEqual(candidate, token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  // While a workspace reset is in flight, block all other /api/* traffic —
  // except health checks (so the UI can still poll) and the reset route
  // itself, whose own route-level guard answers a concurrent reset with a
  // more specific 409 instead of being swallowed here.
  app.use('/api/*', async (c, next) => {
    if (isResetting()) {
      const isHealth = c.req.path === '/api/health';
      const isResetRoute = c.req.path === '/api/workspace/reset' && c.req.method === 'POST';
      if (!isHealth && !isResetRoute) {
        return c.json({ error: 'workspace reset in progress — retry in a moment' }, 503);
      }
    }
    await next();
  });

  // Tracks requests that passed the gate above and are actively running
  // handler code against the *current* session (db/engines) — everything
  // except the long-lived SSE stream (never expected to drain), the health
  // check, and the reset route's own request (which would otherwise wait on
  // itself). This is what lets performWorkspaceReset's beforeDbClose hook
  // wait out a request that was already mid-flight (e.g. suspended in
  // `await c.req.json()`) when `resetting` flipped to true, instead of that
  // request resuming against a session whose db/watcher have already been
  // torn down. See closeWorkspaceSession's `beforeDbClose` doc comment.
  let inFlightRequests = 0;
  app.use('/api/*', async (c, next) => {
    const isHealth = c.req.path === '/api/health';
    const isSSE = c.req.path === '/api/events';
    const isResetRoute = c.req.path === '/api/workspace/reset' && c.req.method === 'POST';
    if (isHealth || isSSE || isResetRoute) {
      await next();
      return;
    }
    inFlightRequests += 1;
    try {
      await next();
    } finally {
      inFlightRequests -= 1;
    }
  });

  /**
   * Waits for requests already past the gate above to finish, so
   * performWorkspaceReset can be sure nothing still holds a reference to the
   * about-to-be-closed session's db. Polls rather than tracking individual
   * promises — simplest correct option for what's expected to be 0 or 1
   * stragglers — and gives up after `timeoutMs` so a wedged handler can never
   * hang a reset forever (best-effort, matching the rest of this file's
   * reset-failure recovery posture).
   */
  async function waitForRequestDrain(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (inFlightRequests > 0 && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function readJsonBody(c: {
    req: { json(): Promise<unknown> };
  }): Promise<Record<string, unknown> | null> {
    try {
      const body = await c.req.json();
      return typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // REST API
  // -------------------------------------------------------------------------

  app.get('/api/health', (c) => c.json({ ok: true, version }));

  /** Shared by GET /api/workspace and the reset route's 200 response. */
  function computeWorkspaceInfo(): WorkspaceInfo {
    const { db, skippedDirs } = getSession();
    const questions = db.listQuestions();
    let attempts = 0;
    let testRuns = 0;
    for (const q of questions) {
      attempts += q.stats.attemptCount;
      testRuns += db.listTestRuns(q.id, 100000).length;
    }

    let legacyImport = { available: false, questionCount: 0 };
    try {
      const pending = importer
        .previewImport(db, workspaceRoot)
        .filter((item) => !item.alreadyImported);
      legacyImport = { available: pending.length > 0, questionCount: pending.length };
    } catch {
      // a broken legacy tree must not take down the workspace endpoint
    }

    return {
      root: workspaceRoot,
      questionsDir: getQuestionsDir(workspaceRoot),
      version,
      counts: { questions: questions.length, attempts, testRuns },
      skippedDirs,
      legacyImport,
      activeAttempt: db.getLatestActiveAttempt(),
      confirmName: path.basename(workspaceRoot),
    };
  }

  app.get('/api/workspace', (c) => c.json(computeWorkspaceInfo()));

  app.get('/api/questions', (c) => c.json(getSession().db.listQuestions()));

  app.get('/api/questions/:category/:slug', (c) => {
    const { db } = getSession();
    const question = db.getQuestion(c.req.param('category'), c.req.param('slug'));
    if (!question) return c.json({ error: 'question not found' }, 404);

    let readme = '';
    try {
      readme = fs.readFileSync(path.join(question.dirPath, 'README.md'), 'utf8');
    } catch {
      // missing README → ''
    }

    const config = (CATEGORIES as Record<string, CategoryConfig | undefined>)[question.category];
    const files: QuestionFileInfo[] = [];
    if (config) {
      for (const name of config.solutionFiles) {
        files.push({
          name,
          relPath: toWorkspaceRelPath(workspaceRoot, path.join(question.dirPath, name)),
          kind: name === 'notes.md' ? 'notes' : 'solution',
          readonly: false,
        });
      }
      for (const name of config.testFiles) {
        files.push({
          name,
          relPath: toWorkspaceRelPath(workspaceRoot, path.join(question.dirPath, name)),
          kind: 'test',
          readonly: true,
        });
      }
    }

    const detail: QuestionDetail = {
      question,
      readme,
      files,
      activeAttempt: db.getActiveAttempt(question.id),
      lastRun: db.getLatestTestRun(question.id),
    };
    return c.json(detail);
  });

  /**
   * On a question's FIRST-ever attempt, record its files as 'scaffold'
   * snapshots — the pristine baseline the review guard and fresh-attempt
   * reset compare against / restore from.
   */
  function captureScaffoldBaseline(question: QuestionRow): void {
    const { db } = getSession();
    const config = (CATEGORIES as Record<string, CategoryConfig | undefined>)[question.category];
    if (!config) return;
    for (const name of [...config.solutionFiles, ...config.testFiles]) {
      const abs = path.join(question.dirPath, name);
      const rel = toWorkspaceRelPath(workspaceRoot, abs);
      try {
        if (db.getLatestSnapshot(question.id, rel) != null) continue;
        const content = fs.readFileSync(abs, 'utf8');
        const hash = saveBlob(workspaceRoot, content);
        db.addSnapshot({
          questionId: question.id,
          attemptId: null,
          relPath: rel,
          hash,
          trigger: 'scaffold',
        });
      } catch {
        // missing file or blob failure — baseline is best-effort
      }
    }
  }

  app.post('/api/questions/:category/:slug/attempts', (c) => {
    const { db } = getSession();
    const question = db.getQuestion(c.req.param('category'), c.req.param('slug'));
    if (!question) return c.json({ error: 'question not found' }, 404);

    const existing = db.getActiveAttempt(question.id);
    if (existing) return c.json({ attempt: existing });

    // Solved with no active attempt: open read-only on the latest attempt
    // instead of minting a fresh one — the user explicitly starts a new
    // attempt from the Room's "Start new attempt" button. Deliberately uses
    // the question-level isQuestionSolved (no attempt-recency clause), to
    // match listQuestions' status derivation of "solved".
    if (isQuestionSolved(db, question.id)) {
      const latestAttempt = db.getLatestAttempt(question.id);
      if (latestAttempt) {
        return c.json({ attempt: null, readonly: true, latestAttempt });
      }
      // Solved with zero attempts (hand-edited data only) — fall through to
      // normal creation below.
    }

    const attempt = db.createAttempt(question.id);
    db.addAttemptEvent(attempt.id, 'reveal');
    // number 1 = first-ever attempt (imported history counts, so a legacy
    // question's own solved code is never mistaken for a scaffold).
    if (attempt.number === 1) captureScaffoldBaseline(question);
    return c.json({ attempt });
  });

  app.get('/api/attempts/:id', (c) => {
    const { db } = getSession();
    const attempt = db.getAttempt(c.req.param('id'));
    if (!attempt) return c.json({ error: 'attempt not found' }, 404);
    return c.json({ attempt, events: db.listAttemptEvents(attempt.id) });
  });

  app.patch('/api/attempts/:id', async (c) => {
    const { db } = getSession();
    const attempt = db.getAttempt(c.req.param('id'));
    if (!attempt) return c.json({ error: 'attempt not found' }, 404);

    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);

    const patch: { activeSecondsDelta?: number; end?: { reason: AttemptEndReason } } = {};
    if (body.activeSecondsDelta !== undefined) {
      const delta = body.activeSecondsDelta;
      if (typeof delta !== 'number' || !Number.isFinite(delta) || delta < 0 || delta > 3600) {
        return c.json({ error: 'activeSecondsDelta must be a number between 0 and 3600' }, 400);
      }
      patch.activeSecondsDelta = delta;
    }
    if (body.end !== undefined) {
      const end = body.end as { reason?: unknown } | null;
      const reason = end && typeof end === 'object' ? end.reason : undefined;
      if (typeof reason !== 'string' || !END_REASONS.has(reason)) {
        return c.json({ error: 'end.reason must be a valid attempt end reason' }, 400);
      }
      // 'solved' is never trusted from the client — re-verify from
      // test_runs here. If the check fails, LOAD-BEARING: silently drop the
      // end (do not 400). The client fires this via a fire-and-forget
      // keepalive fetch on pagehide/unmount and cannot react to an error
      // response, and a combined delta+end body must still apply the delta
      // even when the end itself is rejected. A future "stricter validation"
      // pass must not turn this into a 400.
      if (reason !== 'solved' || isAttemptSolved(db, attempt)) {
        patch.end = { reason: reason as AttemptEndReason };
      }
    }

    return c.json({ attempt: db.patchAttempt(attempt.id, patch) });
  });

  app.post('/api/attempts/:id/events', async (c) => {
    const { db } = getSession();
    const attempt = db.getAttempt(c.req.param('id'));
    if (!attempt) return c.json({ error: 'attempt not found' }, 404);

    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const type = body.type;
    if (typeof type !== 'string' || !ATTEMPT_EVENT_TYPES.has(type)) {
      return c.json({ error: 'invalid event type' }, 400);
    }
    const payload = body.payload;
    if (payload !== undefined && (typeof payload !== 'object' || payload === null)) {
      return c.json({ error: 'payload must be an object' }, 400);
    }

    const eventType = type as AttemptEventType;
    if (eventType === 'first_edit' && db.hasAttemptEvent(attempt.id, 'first_edit')) {
      const existing = db
        .listAttemptEvents(attempt.id)
        .find((event) => event.type === 'first_edit');
      return c.json({ event: existing });
    }

    const event = db.addAttemptEvent(
      attempt.id,
      eventType,
      payload as Record<string, unknown> | undefined,
    );
    return c.json({ event });
  });

  app.get('/api/resume', (c) => {
    const { db } = getSession();
    const latest = db.getLatestActiveAttempt();
    if (!latest) return c.json({ attempt: null });
    return c.json({ attempt: latest.attempt, question: latest.question });
  });

  app.get('/api/file', (c) => {
    const rel = c.req.query('path');
    if (!rel) return c.json({ error: 'path query param is required' }, 400);
    const abs = resolveWorkspacePath(workspaceRoot, rel); // throws ScopeError → 400
    const file = readWorkspaceFile(workspaceRoot, rel);
    if (!file) return c.json({ error: 'file not found' }, 404);
    return c.json({ path: toWorkspaceRelPath(workspaceRoot, abs), ...file });
  });

  /** Records a 'save' snapshot when the written content is new for that file. */
  function snapshotOnWrite(relPath: string, content: string, hash: string): void {
    // Everything below — including the initial getSession()/getQuestion()
    // lookup — is inside the try/catch: snapshot bookkeeping must never fail
    // the save itself (the file is already safely on disk), and a session
    // torn down mid-request (e.g. a reset racing this write) throws on the
    // very first db call just as easily as on a later one.
    try {
      const { db } = getSession();
      // relPath shape: questions/<category>/<slug>/<file...>
      const segments = relPath.split('/');
      if (segments.length < 4 || segments[0] !== 'questions') return;
      const question = db.getQuestion(segments[1], segments[2]);
      if (!question) return;
      const latest = db.getLatestSnapshot(question.id, relPath);
      if (latest && latest.hash === hash) return;
      saveBlob(workspaceRoot, content);
      db.addSnapshot({
        questionId: question.id,
        attemptId: db.getActiveAttempt(question.id)?.id ?? null,
        relPath,
        hash,
        trigger: 'save',
      });
    } catch (err) {
      console.error('[ace] snapshot-on-write failed:', err);
    }
  }

  app.put('/api/file', async (c) => {
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const { path: rel, content } = body;
    if (typeof rel !== 'string' || typeof content !== 'string') {
      return c.json({ error: 'path and content must be strings' }, 400);
    }
    const abs = resolveWorkspacePath(workspaceRoot, rel); // throws ScopeError → 400
    const hash = writeWorkspaceFile(workspaceRoot, rel, content);
    snapshotOnWrite(toWorkspaceRelPath(workspaceRoot, abs), content, hash);
    return c.json({ hash });
  });

  app.post('/api/attempts/:id/test-runs', async (c) => {
    const { db, runner } = getSession();
    const attempt = db.getAttempt(c.req.param('id'));
    if (!attempt) return c.json({ error: 'attempt not found' }, 404);

    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const trigger = body.trigger;
    if (typeof trigger !== 'string' || !TRIGGERS.has(trigger)) {
      return c.json({ error: 'trigger must be "manual" or "save"' }, 400);
    }

    const question = db.getQuestionById(attempt.questionId);
    if (!question) return c.json({ error: 'question not found for attempt' }, 404);

    const run = runner.start(question, attempt.id, trigger as TestRunTrigger);
    return c.json({ runId: run.id });
  });

  app.get('/api/test-runs', (c) => {
    const { db } = getSession();
    const questionId = c.req.query('questionId');
    if (!questionId) return c.json({ error: 'questionId query param is required' }, 400);
    const rawLimit = c.req.query('limit');
    let limit: number | undefined;
    if (rawLimit !== undefined) {
      const parsed = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return c.json({ error: 'limit must be a positive integer' }, 400);
      }
      limit = Math.min(parsed, 200);
    }
    return c.json(db.listTestRuns(questionId, limit));
  });

  app.get('/api/import/preview', (c) =>
    c.json({ items: importer.previewImport(getSession().db, workspaceRoot) }),
  );

  app.post('/api/import/run', (c) => c.json(importer.runImport(getSession().db, workspaceRoot)));

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------

  app.post('/api/questions/:category/:slug/reviews', (c) => {
    const { db, reviews } = getSession();
    const question = db.getQuestion(c.req.param('category'), c.req.param('slug'));
    if (!question) return c.json({ error: 'question not found' }, 404);

    if (reviews.isRunning(question.id)) {
      return c.json({ error: 'a review is already running for this question' }, 409);
    }
    const guardError = getReviewGuardError(question, db);
    if (guardError) return c.json({ error: guardError }, 400);
    if (!resolveProvider()) {
      return c.json({ error: 'no LLM API key configured — add one in Settings' }, 503);
    }

    const attempt = db.getActiveAttempt(question.id);
    const { jobId } = reviews.start(question, attempt?.id ?? null);
    return c.json({ jobId }, 202);
  });

  app.get('/api/questions/:category/:slug/reviews', (c) => {
    const { db } = getSession();
    const question = db.getQuestion(c.req.param('category'), c.req.param('slug'));
    if (!question) return c.json({ error: 'question not found' }, 404);
    return c.json(db.listReviews(question.id));
  });

  app.get('/api/reviews/:id', (c) => {
    const { db } = getSession();
    const review = db.getReview(c.req.param('id'));
    if (!review) return c.json({ error: 'review not found' }, 404);
    const snapshotContent = review.snapshotHash
      ? readBlob(workspaceRoot, review.snapshotHash)
      : null;
    return c.json({ ...review, snapshotContent });
  });

  // -------------------------------------------------------------------------
  // Disputes
  // -------------------------------------------------------------------------

  app.post('/api/test-runs/:runId/disputes', async (c) => {
    const { db, disputes } = getSession();
    const run = db.getTestRun(c.req.param('runId'));
    if (!run) return c.json({ error: 'test run not found' }, 404);
    const question = db.getQuestionById(run.questionId);
    if (!question) return c.json({ error: 'question not found for test run' }, 404);

    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    if (body.argument !== undefined && typeof body.argument !== 'string') {
      return c.json({ error: 'argument must be a string' }, 400);
    }
    const argument =
      typeof body.argument === 'string' && body.argument.trim().length > 0
        ? body.argument.trim()
        : null;

    const guardError = getDisputeGuardError(question, run);
    if (guardError) return c.json({ error: guardError }, 400);
    if (disputes.isRunning(question.id)) {
      return c.json({ error: 'a dispute analysis is already running for this question' }, 409);
    }
    if (!resolveProvider()) {
      return c.json({ error: 'no LLM API key configured — add one in Settings' }, 503);
    }

    const { disputeJobId } = disputes.start(question, run, argument);
    return c.json({ disputeJobId }, 202);
  });

  app.get('/api/questions/:category/:slug/disputes', (c) => {
    const { db } = getSession();
    const question = db.getQuestion(c.req.param('category'), c.req.param('slug'));
    if (!question) return c.json({ error: 'question not found' }, 404);
    return c.json(db.listDisputes(question.id));
  });

  app.post('/api/disputes/:id/apply', (c) => {
    const { db } = getSession();
    const dispute = db.getDispute(c.req.param('id'));
    if (!dispute) return c.json({ error: 'dispute not found' }, 404);
    try {
      return c.json({ dispute: applyDispute({ db, workspaceRoot, dispute }) });
    } catch (err) {
      if (err instanceof DisputeApplyError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // Generation jobs
  // -------------------------------------------------------------------------

  const DIFFICULTIES: ReadonlySet<string> = new Set<Difficulty>(['easy', 'medium', 'hard']);
  const GENERATION_CAP_ERROR = 'three generations are already running — let one finish first';

  app.post('/api/generation/jobs', async (c) => {
    const { db, generation } = getSession();
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);

    const category = body.category;
    if (typeof category !== 'string' || !CATEGORY_SLUGS.includes(category as CategorySlug)) {
      return c.json({ error: `category must be one of: ${CATEGORY_SLUGS.join(', ')}` }, 400);
    }
    const difficulty = body.difficulty;
    if (typeof difficulty !== 'string' || !DIFFICULTIES.has(difficulty)) {
      return c.json({ error: 'difficulty must be "easy", "medium", or "hard"' }, 400);
    }
    const topic = body.topic;
    if (typeof topic !== 'string' || topic.length < 1 || topic.length > 4000) {
      return c.json({ error: 'topic must be a string between 1 and 4000 characters' }, 400);
    }

    let brainstormSessionId: string | null = null;
    if (body.brainstormSessionId !== undefined && body.brainstormSessionId !== null) {
      if (typeof body.brainstormSessionId !== 'string') {
        return c.json({ error: 'brainstormSessionId must be a string' }, 400);
      }
      if (!db.getBrainstormSession(body.brainstormSessionId)) {
        return c.json({ error: 'brainstorm session not found' }, 404);
      }
      brainstormSessionId = body.brainstormSessionId;
    }

    if (generation.runningCount() >= 3) {
      return c.json({ error: GENERATION_CAP_ERROR }, 409);
    }
    if (!resolveProvider()) {
      return c.json({ error: 'no LLM API key configured — add one in Settings' }, 503);
    }

    const { jobId } = generation.start({
      category: category as CategorySlug,
      difficulty: difficulty as Difficulty,
      topic,
      brainstormSessionId,
    });
    return c.json({ jobId }, 202);
  });

  app.get('/api/generation/jobs', (c) => {
    const { db } = getSession();
    const rawLimit = c.req.query('limit');
    let limit = 20;
    if (rawLimit !== undefined && rawLimit !== '') {
      const parsed = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return c.json({ error: 'limit must be a positive integer' }, 400);
      }
      limit = Math.min(parsed, 100);
    }
    return c.json({ jobs: db.listGenerationJobs(limit) });
  });

  app.get('/api/generation/jobs/:id', (c) => {
    const { db } = getSession();
    const job = db.getGenerationJob(c.req.param('id'));
    if (!job) return c.json({ error: 'generation job not found' }, 404);
    return c.json({ job });
  });

  app.post('/api/generation/jobs/:id/retry', (c) => {
    const { db, generation } = getSession();
    const job = db.getGenerationJob(c.req.param('id'));
    if (!job) return c.json({ error: 'generation job not found' }, 404);
    if (job.status !== 'error') {
      return c.json(
        { error: `generation job is not in an error state (status: ${job.status})` },
        409,
      );
    }

    // Retries obey the same concurrency cap as new jobs — even a
    // scaffold-only resume occupies an engine slot, and a full re-run also
    // consumes an LLM slot.
    if (generation.runningCount() >= 3) {
      return c.json({ error: GENERATION_CAP_ERROR }, 409);
    }
    // A scaffold-only resume (job.result already persisted from a prior LLM
    // call) never calls the llm again, so a keyless workspace can still
    // retry it — the 503 gate only applies when a full re-run is needed.
    if (job.result == null && !resolveProvider()) {
      return c.json({ error: 'no LLM API key configured — add one in Settings' }, 503);
    }

    const { jobId } = generation.retry(job);
    return c.json({ jobId }, 202);
  });

  // -------------------------------------------------------------------------
  // Brainstorm
  // -------------------------------------------------------------------------

  app.post('/api/brainstorm/turns', async (c) => {
    const { db, brainstorm } = getSession();
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);

    const message = body.message;
    if (typeof message !== 'string' || message.length < 1 || message.length > 4000) {
      return c.json({ error: 'message must be a string between 1 and 4000 characters' }, 400);
    }

    let sessionId: string | null = null;
    if (body.sessionId !== undefined && body.sessionId !== null) {
      if (typeof body.sessionId !== 'string') {
        return c.json({ error: 'sessionId must be a string' }, 400);
      }
      if (!db.getBrainstormSession(body.sessionId)) {
        return c.json({ error: 'brainstorm session not found' }, 404);
      }
      if (brainstorm.isThinking(body.sessionId)) {
        return c.json(
          { error: 'a brainstorm turn is already running for this session' },
          409,
        );
      }
      sessionId = body.sessionId;
    }

    if (!resolveProvider()) {
      return c.json({ error: 'no LLM API key configured — add one in Settings' }, 503);
    }

    const { sessionId: id } = brainstorm.startTurn(sessionId, message);
    return c.json({ sessionId: id }, 202);
  });

  app.get('/api/brainstorm/sessions', (c) => {
    const { db } = getSession();
    const rawLimit = c.req.query('limit');
    let limit = 20;
    if (rawLimit !== undefined && rawLimit !== '') {
      const parsed = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return c.json({ error: 'limit must be a positive integer' }, 400);
      }
      limit = Math.min(parsed, 100);
    }
    const sessions = db.listBrainstormSessions(limit).map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      updatedAt: s.updatedAt,
    }));
    return c.json({ sessions });
  });

  app.get('/api/brainstorm/sessions/:id', (c) => {
    const { db } = getSession();
    const session = db.getBrainstormSession(c.req.param('id'));
    if (!session) return c.json({ error: 'brainstorm session not found' }, 404);
    return c.json({ session });
  });

  // -------------------------------------------------------------------------
  // Fresh attempt
  // -------------------------------------------------------------------------

  app.post('/api/attempts/:id/fresh', async (c) => {
    const { db } = getSession();
    const attempt = db.getAttempt(c.req.param('id'));
    if (!attempt) return c.json({ error: 'attempt not found' }, 404);

    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    if (typeof body.resetToStub !== 'boolean') {
      return c.json({ error: 'resetToStub must be a boolean' }, 400);
    }

    const question = db.getQuestionById(attempt.questionId);
    if (!question) return c.json({ error: 'question not found for attempt' }, 404);
    const config = (CATEGORIES as Record<string, CategoryConfig | undefined>)[question.category];
    if (!config) return c.json({ error: `unknown category "${question.category}"` }, 400);

    if (!attempt.endedAt) {
      db.patchAttempt(attempt.id, { end: { reason: 'abandoned' } });
    }

    // Snapshot every solution file BEFORE any stub write. A snapshot failure
    // aborts the whole request (500) so the reset can never lose code.
    for (const name of config.solutionFiles) {
      const abs = path.join(question.dirPath, name);
      let content: string;
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        continue; // file never created — nothing to preserve
      }
      const hash = saveBlob(workspaceRoot, content);
      db.addSnapshot({
        questionId: question.id,
        attemptId: attempt.id,
        relPath: toWorkspaceRelPath(workspaceRoot, abs),
        hash,
        trigger: 'reset',
      });
    }

    if (body.resetToStub) {
      for (const name of config.solutionFiles) {
        const rel = toWorkspaceRelPath(workspaceRoot, path.join(question.dirPath, name));
        // Restore the ORIGINAL scaffold (with its real signature/title) when we
        // have it — getStubContent renders with empty placeholders and would
        // drop the exported signature the test file imports.
        const baseline = db.getFirstSnapshot(question.id, rel, 'scaffold');
        const original = baseline ? readBlob(workspaceRoot, baseline.hash) : null;
        const stubContent =
          original ?? getStubContent(question.category as CategorySlug, name);
        writeWorkspaceFile(workspaceRoot, rel, stubContent);
        // What we just wrote is the new pristine baseline for the guard.
        try {
          const h = saveBlob(workspaceRoot, stubContent);
          db.addSnapshot({
            questionId: question.id,
            attemptId: null,
            relPath: rel,
            hash: h,
            trigger: 'scaffold',
          });
        } catch {
          // non-fatal: guard falls back to its heuristics
        }
      }
    }

    const fresh = db.createAttempt(question.id);
    db.addAttemptEvent(fresh.id, 'reveal');
    return c.json({ attempt: fresh });
  });

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  app.get('/api/history', (c) => {
    const { db } = getSession();
    const q = c.req.query('q');
    const category = c.req.query('category');

    // Optional "<category>/<slug>" filter so a question's full history is
    // server-side, not a client-side slice of the newest page.
    const rawQuestion = c.req.query('question');
    let questionId: string | undefined;
    if (rawQuestion !== undefined && rawQuestion !== '') {
      const slash = rawQuestion.indexOf('/');
      const qrow =
        slash > 0
          ? db.getQuestion(rawQuestion.slice(0, slash), rawQuestion.slice(slash + 1))
          : null;
      if (!qrow) return c.json({ items: [] });
      questionId = qrow.id;
    }

    const rawType = c.req.query('type');
    let type: 'review' | 'dispute' | undefined;
    if (rawType !== undefined && rawType !== '') {
      if (rawType !== 'review' && rawType !== 'dispute') {
        return c.json({ error: 'type must be "review" or "dispute"' }, 400);
      }
      type = rawType;
    }

    const rawLimit = c.req.query('limit');
    let limit: number | undefined;
    if (rawLimit !== undefined && rawLimit !== '') {
      const parsed = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return c.json({ error: 'limit must be a positive integer' }, 400);
      }
      limit = Math.min(parsed, 500);
    }

    return c.json({
      items: db.searchHistory({
        q: q || undefined,
        category: category || undefined,
        type,
        questionId,
        limit,
      }),
    });
  });

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  app.get('/api/settings', (c) => c.json(getSettingsInfo()));

  app.put('/api/settings', async (c) => {
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);

    const patch: SettingsPatch = {};
    if (body.openaiKey !== undefined) {
      if (typeof body.openaiKey !== 'string' || body.openaiKey.trim().length === 0) {
        return c.json({ error: 'openaiKey must be a non-empty string' }, 400);
      }
      patch.openaiKey = body.openaiKey.trim();
    }
    if (body.anthropicKey !== undefined) {
      if (typeof body.anthropicKey !== 'string' || body.anthropicKey.trim().length === 0) {
        return c.json({ error: 'anthropicKey must be a non-empty string' }, 400);
      }
      patch.anthropicKey = body.anthropicKey.trim();
    }
    if (body.defaultProvider !== undefined) {
      if (body.defaultProvider !== 'openai' && body.defaultProvider !== 'anthropic') {
        return c.json({ error: 'defaultProvider must be "openai" or "anthropic"' }, 400);
      }
      patch.defaultProvider = body.defaultProvider;
    }

    try {
      return c.json(await updateSettings(patch));
    } catch (err) {
      if (err instanceof SettingsValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // Workspace reset (NEE-165 — "clear workspace")
  // -------------------------------------------------------------------------

  const VALID_RESET_MODES: ReadonlySet<string> = new Set<WorkspaceResetMode>(['progress', 'full']);

  app.post('/api/workspace/reset', async (c) => {
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);

    const rawMode = body.mode;
    if (typeof rawMode !== 'string' || !VALID_RESET_MODES.has(rawMode)) {
      return c.json({ error: 'mode must be "progress" or "full"' }, 400);
    }
    const mode = rawMode as WorkspaceResetMode;

    const expectedConfirm = path.basename(workspaceRoot);
    const confirm = body.confirm;
    if (typeof confirm !== 'string' || confirm !== expectedConfirm) {
      return c.json(
        { error: `type the workspace folder name "${expectedConfirm}" to confirm` },
        400,
      );
    }

    // Echoed back in the `workspace-reset` broadcast so the initiating tab
    // can tell its own reset's broadcast apart from one a different tab
    // triggered (the HTTP response and the SSE broadcast race independently
    // and can arrive in either order). A caller that omits it still gets a
    // working reset — it just gets a server-minted id back with no client
    // to match it against.
    const requestId =
      typeof body.requestId === 'string' && body.requestId.length > 0
        ? body.requestId
        : crypto.randomUUID();

    // Checked at route entry — reachable only because this route is exempt
    // from the mid-reset 503 gate above (a concurrent reset POST answers
    // from here, not the gate).
    if (isResetting()) {
      return c.json({ error: 'a workspace reset is already in progress' }, 409);
    }

    const { runner, reviews, disputes, generation, brainstorm } = getSession();
    if (runner.isBusy()) {
      return c.json(
        { error: 'a test run is in progress — wait for it to finish and try again' },
        409,
      );
    }
    if (reviews.isAnyRunning()) {
      return c.json(
        { error: 'a review is streaming — wait for it to finish and try again' },
        409,
      );
    }
    if (disputes.isAnyRunning()) {
      return c.json(
        { error: 'a dispute analysis is in progress — wait for it to finish and try again' },
        409,
      );
    }
    if (generation.isAnyRunning()) {
      return c.json(
        { error: 'a generation is in progress — wait for it to finish and try again' },
        409,
      );
    }
    if (brainstorm.isAnyRunning()) {
      return c.json(
        { error: 'a brainstorm turn is in progress — wait for it to finish and try again' },
        409,
      );
    }

    try {
      const result = await performWorkspaceReset({
        workspaceRoot,
        bus,
        getSession,
        swapSession,
        setResetting,
        mode,
        confirm,
        requestId,
        engines,
        drainRequests: waitForRequestDrain,
      });
      return c.json({
        mode,
        archivedTo: result.archivedTo,
        restored: result.restored,
        workspace: computeWorkspaceInfo(),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'workspace reset failed' }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // SSE
  // -------------------------------------------------------------------------

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let alive = true;
      let unsubscribe: () => void = () => {};
      let heartbeat: NodeJS.Timeout | null = null;
      let release!: () => void;
      const closed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stop = () => {
        if (!alive) return;
        alive = false;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        release();
      };
      stream.onAbort(stop);

      try {
        await stream.writeSSE({
          event: 'hello',
          data: JSON.stringify({ version, workspaceRoot, epoch: getSession().epoch }),
        });
      } catch {
        stop();
        return;
      }
      // The client may have aborted during the hello write; registering the
      // listener/heartbeat after stop() ran would leak them forever.
      if (!alive) return;

      unsubscribe = bus.subscribe((name, data) => {
        if (!alive) return;
        stream.writeSSE({ event: name, data: JSON.stringify(data) }).catch(stop);
      });
      heartbeat = setInterval(() => {
        if (!alive) return;
        stream.write(': heartbeat\n\n').catch(stop);
      }, HEARTBEAT_MS);

      await closed;
    }),
  );

  // Unknown API routes are JSON 404s, never the SPA fallback.
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // -------------------------------------------------------------------------
  // Static UI (no token required; GET only, SPA fallback to index.html)
  // -------------------------------------------------------------------------

  app.get('*', (c) => {
    if (!uiDir) return c.text('ACE UI not built. Run: npm run build');

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.json({ error: 'bad request' }, 400);
    }
    if (pathname.includes('..') || pathname.includes('\\') || pathname.includes('\0')) {
      return c.json({ error: 'not found' }, 404);
    }

    const ext = path.extname(pathname);
    if (ext) {
      const contentType = CONTENT_TYPES[ext];
      const filePath = path.join(uiDir, pathname);
      if (!contentType || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return c.json({ error: 'not found' }, 404);
      }
      const cacheControl =
        pathname === '/index.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
      return c.body(new Uint8Array(fs.readFileSync(filePath)), 200, {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
      });
    }

    const indexPath = path.join(uiDir, 'index.html');
    if (!fs.existsSync(indexPath)) return c.text('ACE UI not built. Run: npm run build');
    return c.body(fs.readFileSync(indexPath, 'utf8'), 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
  });

  return app;
}
