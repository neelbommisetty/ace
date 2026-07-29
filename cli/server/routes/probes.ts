import type { Hono } from 'hono';
import { getProbeGuardError, hasProbeSetForAttempt } from '../probes.js';
import { questionLookup, requireProvider } from '../route-helpers.js';
import type { RouteContext } from './context.js';

export function registerProbeRoutes(app: Hono, ctx: RouteContext): void {
  const lookupQuestion = questionLookup(ctx);

  app.post('/api/questions/:category/:slug/probes', lookupQuestion, (c) => {
    const { db, probes } = ctx.requireSession();
    const question = c.get('question');

    const guardError = getProbeGuardError(question);
    if (guardError) return c.json({ error: guardError }, 400);
    if (probes.isRunning(question.id)) {
      return c.json({ error: 'a probe run is already in progress for this question' }, 409);
    }
    const attempt = db.getActiveAttempt(question.id);
    if (hasProbeSetForAttempt(db, question.id, attempt?.id ?? null)) {
      return c.json(
        { error: 'follow-up probes have already been generated for this attempt' },
        409,
      );
    }
    const noProvider = requireProvider(c);
    if (noProvider) return noProvider;

    const { probeJobId } = probes.start(question, attempt?.id ?? null);
    return c.json({ probeJobId }, 202);
  });

  // Scoped to a single attempt (NEE-345 follow-up): the POST bound
  // (hasProbeSetForAttempt) is per-attempt, but without this the GET handed
  // back every attempt's probe sets — the UI had no way to tell "already
  // generated for attempt 2" from "attempt 1's probes are still sitting
  // here". `attemptId` mirrors the same `string | null` bucketing
  // hasProbeSetForAttempt uses: omit the query param for the null bucket
  // (no active attempt), pass the id otherwise.
  app.get('/api/questions/:category/:slug/probes', lookupQuestion, (c) => {
    const { db } = ctx.requireSession();
    const attemptId = c.req.query('attemptId') ?? null;
    const sets = db
      .listProbeSets(c.get('question').id)
      .filter((p) => p.attemptId === attemptId);
    return c.json(sets);
  });
}
