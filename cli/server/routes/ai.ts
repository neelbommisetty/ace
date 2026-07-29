import type { Hono } from 'hono';
import { parseLimit } from '../route-helpers.js';
import type { AiRunKind } from '../types.js';
import type { RouteContext } from './context.js';

const AI_RUN_KINDS: ReadonlySet<string> = new Set<AiRunKind>([
  'generation',
  'review',
  'dispute',
  'brainstorm',
  'probe',
]);

export function registerAiRoutes(app: Hono, ctx: RouteContext): void {
  app.get('/api/ai/runs', (c) => {
    const { db } = ctx.requireSession();
    const limit = parseLimit(c, { default: 30, max: 100 });
    if (!limit.ok) return limit.response;
    const rawKind = c.req.query('kind');
    if (rawKind !== undefined && rawKind !== '' && !AI_RUN_KINDS.has(rawKind)) {
      return c.json({ error: `kind must be one of: ${[...AI_RUN_KINDS].join(', ')}` }, 400);
    }
    const kind = rawKind ? (rawKind as AiRunKind) : undefined;
    const refId = c.req.query('refId') || undefined;
    // Steps ride along in summary shape (no promptText/responseText) — the
    // full text is only ever served by GET /api/ai/steps/:id below.
    const runs = db
      .listAiRuns({ limit: limit.limit, kind, refId })
      .map((run) => ({ ...run, steps: db.listAiSteps(run.id) }));
    return c.json({ runs });
  });

  app.get('/api/ai/runs/:id', (c) => {
    const { db } = ctx.requireSession();
    const run = db.getAiRun(c.req.param('id'));
    if (!run) return c.json({ error: 'ai run not found' }, 404);
    return c.json({ run, steps: db.listAiSteps(run.id) });
  });

  // The ONLY endpoint that returns promptText/responseText (both already
  // masked at write time — see ai-log.ts); clients fetch it lazily on expand.
  app.get('/api/ai/steps/:id', (c) => {
    const { db } = ctx.requireSession();
    const step = db.getAiStep(c.req.param('id'));
    if (!step) return c.json({ error: 'ai step not found' }, 404);
    return c.json({ step });
  });
}
