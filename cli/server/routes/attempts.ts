import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { lookupCategoryConfig } from '../../lib/categories.js';
import { getStubContent } from '../../lib/scaffold.js';
import { isAttemptSolved, isQuestionSolved } from '../app.js';
import { readBlob, saveBlob } from '../blobs.js';
import { toWorkspaceRelPath, writeWorkspaceFile } from '../files.js';
import { parseLimit, questionLookup, readJsonBody } from '../route-helpers.js';
import type {
  AttemptEndReason,
  AttemptEventType,
  QuestionRow,
  TestRunTrigger,
} from '../types.js';
import type { RouteContext } from './context.js';

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
 * On a question's FIRST-ever attempt, record its files as 'scaffold'
 * snapshots — the pristine baseline the review guard and fresh-attempt
 * reset compare against / restore from.
 */
function captureScaffoldBaseline(ctx: RouteContext, question: QuestionRow): void {
  const workspaceRoot = ctx.requireWorkspaceRoot();
  const { db } = ctx.requireSession();
  const config = lookupCategoryConfig(question.category);
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

export function registerAttemptRoutes(app: Hono, ctx: RouteContext): void {
  const lookupQuestion = questionLookup(ctx);

  app.post('/api/questions/:category/:slug/attempts', lookupQuestion, (c) => {
    const { db } = ctx.requireSession();
    const question = c.get('question');

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
    if (attempt.number === 1) captureScaffoldBaseline(ctx, question);
    return c.json({ attempt });
  });

  app.get('/api/attempts/:id', (c) => {
    const { db } = ctx.requireSession();
    const attempt = db.getAttempt(c.req.param('id'));
    if (!attempt) return c.json({ error: 'attempt not found' }, 404);
    return c.json({ attempt, events: db.listAttemptEvents(attempt.id) });
  });

  app.patch('/api/attempts/:id', async (c) => {
    const { db } = ctx.requireSession();
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
    const { db } = ctx.requireSession();
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
    const { db } = ctx.requireSession();
    const latest = db.getLatestActiveAttempt();
    if (!latest) return c.json({ attempt: null });
    return c.json({ attempt: latest.attempt, question: latest.question });
  });

  app.post('/api/attempts/:id/test-runs', async (c) => {
    const { db, runner } = ctx.requireSession();
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
    const { db } = ctx.requireSession();
    const questionId = c.req.query('questionId');
    if (!questionId) return c.json({ error: 'questionId query param is required' }, 400);
    const limit = parseLimit(c, { max: 200 });
    if (!limit.ok) return limit.response;
    return c.json(db.listTestRuns(questionId, limit.limit));
  });

  app.post('/api/attempts/:id/fresh', async (c) => {
    const workspaceRoot = ctx.requireWorkspaceRoot();
    const { db } = ctx.requireSession();
    const attempt = db.getAttempt(c.req.param('id'));
    if (!attempt) return c.json({ error: 'attempt not found' }, 404);

    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    if (typeof body.resetToStub !== 'boolean') {
      return c.json({ error: 'resetToStub must be a boolean' }, 400);
    }

    const question = db.getQuestionById(attempt.questionId);
    if (!question) return c.json({ error: 'question not found for attempt' }, 404);
    const config = lookupCategoryConfig(question.category);
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
        const stubContent = original ?? getStubContent(config.slug, name);
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
}
