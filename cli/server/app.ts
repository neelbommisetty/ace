import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { CATEGORIES, type CategoryConfig } from '../lib/categories.js';
import { getQuestionsDir } from '../lib/paths.js';
import {
  ScopeError,
  readWorkspaceFile,
  resolveWorkspacePath,
  toWorkspaceRelPath,
  writeWorkspaceFile,
} from './files.js';
import type { Runner } from './runner.js';
import type { Bus } from './sse.js';
import type {
  AceDb,
  AttemptEndReason,
  AttemptEventType,
  ImportPreviewItem,
  ImportResult,
  QuestionDetail,
  QuestionFileInfo,
  TestRunTrigger,
  WorkspaceInfo,
} from './types.js';

export interface ImporterApi {
  previewImport(db: AceDb, root: string): ImportPreviewItem[];
  runImport(db: AceDb, root: string): ImportResult;
}

export interface CreateAppOptions {
  db: AceDb;
  bus: Bus;
  workspaceRoot: string;
  token: string;
  uiDir: string | null;
  version: string;
  runner: Runner;
  importer: ImporterApi;
  /** Latest reconcile's skipped dirs (dirs under unknown categories). */
  getSkippedDirs?: () => string[];
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
  'green',
  'submitted',
  'abandoned',
  'superseded',
]);
const TRIGGERS: ReadonlySet<string> = new Set<TestRunTrigger>(['manual', 'save']);

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
  const { db, bus, workspaceRoot, token, uiDir, version, runner, importer } = opts;
  const getSkippedDirs = opts.getSkippedDirs ?? (() => []);
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

  app.get('/api/workspace', (c) => {
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

    const info: WorkspaceInfo = {
      root: workspaceRoot,
      questionsDir: getQuestionsDir(workspaceRoot),
      version,
      counts: { questions: questions.length, attempts, testRuns },
      skippedDirs: getSkippedDirs(),
      legacyImport,
      activeAttempt: db.getLatestActiveAttempt(),
    };
    return c.json(info);
  });

  app.get('/api/questions', (c) => c.json(db.listQuestions()));

  app.get('/api/questions/:category/:slug', (c) => {
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

  app.post('/api/questions/:category/:slug/attempts', (c) => {
    const question = db.getQuestion(c.req.param('category'), c.req.param('slug'));
    if (!question) return c.json({ error: 'question not found' }, 404);

    const existing = db.getActiveAttempt(question.id);
    if (existing) return c.json({ attempt: existing });

    const attempt = db.createAttempt(question.id);
    db.addAttemptEvent(attempt.id, 'reveal');
    return c.json({ attempt });
  });

  app.get('/api/attempts/:id', (c) => {
    const attempt = db.getAttempt(c.req.param('id'));
    if (!attempt) return c.json({ error: 'attempt not found' }, 404);
    return c.json({ attempt, events: db.listAttemptEvents(attempt.id) });
  });

  app.patch('/api/attempts/:id', async (c) => {
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
      patch.end = { reason: reason as AttemptEndReason };
    }

    return c.json({ attempt: db.patchAttempt(attempt.id, patch) });
  });

  app.post('/api/attempts/:id/events', async (c) => {
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

  app.put('/api/file', async (c) => {
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const { path: rel, content } = body;
    if (typeof rel !== 'string' || typeof content !== 'string') {
      return c.json({ error: 'path and content must be strings' }, 400);
    }
    const hash = writeWorkspaceFile(workspaceRoot, rel, content); // throws ScopeError → 400
    return c.json({ hash });
  });

  app.post('/api/attempts/:id/test-runs', async (c) => {
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
    c.json({ items: importer.previewImport(db, workspaceRoot) }),
  );

  app.post('/api/import/run', (c) => c.json(importer.runImport(db, workspaceRoot)));

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
          data: JSON.stringify({ version, workspaceRoot }),
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
