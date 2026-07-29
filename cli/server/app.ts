import crypto from 'node:crypto';
import { Hono } from 'hono';
import { ScopeError } from './files.js';
import * as routes from './routes/index.js';
import type { EngineFactories, WorkspaceSession } from './session.js';
import type { Bus } from './sse.js';
import type { AceDb, AttemptRow, ImportPreviewItem, ImportResult } from './types.js';

export interface ImporterApi {
  previewImport(db: AceDb, root: string): ImportPreviewItem[];
  runImport(db: AceDb, root: string): ImportResult;
}

export interface CreateAppOptions {
  bus: Bus;
  token: string;
  uiDir: string | null;
  version: string;
  importer: ImporterApi;
  /** Accessor for the mounted workspace root — null in picker mode (NEE-164). */
  getWorkspaceRoot: () => string | null;
  /**
   * Accessor for the current WorkspaceSession — handlers read db/engines from
   * it at entry. Null while no workspace is mounted (picker mode, NEE-164).
   */
  getSession: () => WorkspaceSession | null;
  /** True while a workspace reset or switch is in flight. Defaults to always false. */
  isSwapping?: () => boolean;
  /** Atomically swaps the live root+session pair — called by the reset/switch orchestrators. */
  swapWorkspace?: (root: string | null, session: WorkspaceSession | null) => void;
  /** Flips the swapping flag; read by the mid-swap 503 gate and both routes' own guards. */
  setSwapping?: (swapping: boolean) => void;
  /** Defaults to the real engine factories; tests inject fakes for the reset/switch routes too. */
  engines?: EngineFactories;
}

const HOST_RE = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
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
function constantTimeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createApp(opts: CreateAppOptions): Hono {
  const { token, getSession } = opts;
  const isSwapping = opts.isSwapping ?? (() => false);
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ScopeError) return c.json({ error: err.message }, 400);
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

  // Picker mode (NEE-164): while no workspace is mounted, every workspace-
  // bound route answers 409 so the SPA can tell "server up, nothing mounted"
  // apart from a dead server. Only what the picker itself needs passes:
  // health, the SSE stream (its hello carries workspaceRoot: null), the
  // recents list, and the switch route that performs the mount. Auth (above)
  // still applies; static/SPA serving is not under /api/* at all.
  app.use('/api/*', async (c, next) => {
    if (getSession() == null) {
      const p = c.req.path;
      const exempt =
        p === '/api/health' ||
        (p === '/api/events' && c.req.method === 'GET') ||
        (p === '/api/workspace/recents' && c.req.method === 'GET') ||
        (p === '/api/workspace/switch' && c.req.method === 'POST');
      if (!exempt) return c.json({ error: 'no workspace mounted' }, 409);
    }
    await next();
  });

  // While a workspace reset or switch is in flight, block all other /api/*
  // traffic — except health checks (so the UI can still poll) and the
  // reset/switch routes themselves, whose own route-level guards answer a
  // concurrent request with a more specific 409 instead of being swallowed
  // here.
  app.use('/api/*', async (c, next) => {
    if (isSwapping()) {
      const isHealth = c.req.path === '/api/health';
      const isResetRoute = c.req.path === '/api/workspace/reset' && c.req.method === 'POST';
      const isSwitchRoute = c.req.path === '/api/workspace/switch' && c.req.method === 'POST';
      if (!isHealth && !isResetRoute && !isSwitchRoute) {
        return c.json(
          { error: 'a workspace reset or switch is in progress — retry in a moment' },
          503,
        );
      }
    }
    await next();
  });

  // Tracks requests that passed the gate above and are actively running
  // handler code against the *current* session (db/engines) — everything
  // except the long-lived SSE stream (never expected to drain), the health
  // check, and the reset/switch routes' own requests (which would otherwise
  // wait on themselves). This is what lets the reset/switch orchestrators'
  // beforeDbClose hook wait out a request that was already mid-flight (e.g.
  // suspended in `await c.req.json()`) when `swapping` flipped to true,
  // instead of that request resuming against a session whose db/watcher have
  // already been torn down. See closeWorkspaceSession's `beforeDbClose` doc
  // comment.
  let inFlightRequests = 0;
  app.use('/api/*', async (c, next) => {
    const isHealth = c.req.path === '/api/health';
    const isSSE = c.req.path === '/api/events';
    const isResetRoute = c.req.path === '/api/workspace/reset' && c.req.method === 'POST';
    const isSwitchRoute = c.req.path === '/api/workspace/switch' && c.req.method === 'POST';
    if (isHealth || isSSE || isResetRoute || isSwitchRoute) {
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
   * Waits for requests already past the gate above to finish, so the
   * reset/switch orchestrators can be sure nothing still holds a reference to
   * the about-to-be-closed session's db. Polls rather than tracking individual
   * promises — simplest correct option for what's expected to be 0 or 1
   * stragglers — and gives up after `timeoutMs` so a wedged handler can never
   * hang a reset/switch forever (best-effort, matching the rest of this
   * file's failure-recovery posture).
   */
  async function waitForRequestDrain(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (inFlightRequests > 0 && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  // Route modules — order matters only at the tail: static.ts registers the
  // API 404 fallback and the SPA catch-all LAST.
  const ctx = routes.createRouteContext(opts, waitForRequestDrain);
  routes.registerWorkspaceRoutes(app, ctx);
  routes.registerQuestionRoutes(app, ctx);
  routes.registerAttemptRoutes(app, ctx);
  routes.registerFileRoutes(app, ctx);
  routes.registerReviewRoutes(app, ctx);
  routes.registerDisputeRoutes(app, ctx);
  routes.registerGenerationRoutes(app, ctx);
  routes.registerBrainstormRoutes(app, ctx);
  routes.registerAiRoutes(app, ctx);
  routes.registerHistoryRoutes(app, ctx);
  routes.registerSettingsRoutes(app, ctx);
  routes.registerStarterPackRoutes(app, ctx);
  routes.registerResetRoutes(app, ctx);
  routes.registerSseRoutes(app, ctx);
  routes.registerStaticRoutes(app, ctx);
  return app;
}
