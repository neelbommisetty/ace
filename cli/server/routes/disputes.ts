import type { Hono } from 'hono';
import { applyDispute, DisputeApplyError, getDisputeGuardError } from '../disputes.js';
import { questionLookup, readJsonBody, requireProvider } from '../route-helpers.js';
import type { RouteContext } from './context.js';

export function registerDisputeRoutes(app: Hono, ctx: RouteContext): void {
  const lookupQuestion = questionLookup(ctx);

  app.post('/api/test-runs/:runId/disputes', async (c) => {
    const { db, disputes } = ctx.requireSession();
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
    const noProvider = requireProvider(c);
    if (noProvider) return noProvider;

    const { disputeJobId } = disputes.start(question, run, argument);
    return c.json({ disputeJobId }, 202);
  });

  app.get('/api/questions/:category/:slug/disputes', lookupQuestion, (c) => {
    const { db } = ctx.requireSession();
    return c.json(db.listDisputes(c.get('question').id));
  });

  // Direct-load fetch by id (NEE-306): mirrors GET /api/reviews/:id, with the
  // owning question embedded so a reload of /history/dispute/:id has
  // everything the detail view needs in one round trip.
  app.get('/api/disputes/:id', (c) => {
    const { db } = ctx.requireSession();
    const dispute = db.getDispute(c.req.param('id'));
    if (!dispute) return c.json({ error: 'dispute not found' }, 404);
    const question = db.getQuestionById(dispute.questionId);
    if (!question) return c.json({ error: 'question not found for dispute' }, 404);
    return c.json({ ...dispute, question });
  });

  app.post('/api/disputes/:id/apply', (c) => {
    const { db } = ctx.requireSession();
    const dispute = db.getDispute(c.req.param('id'));
    if (!dispute) return c.json({ error: 'dispute not found' }, 404);
    try {
      return c.json({
        dispute: applyDispute({ db, workspaceRoot: ctx.requireWorkspaceRoot(), dispute }),
      });
    } catch (err) {
      if (err instanceof DisputeApplyError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });
}
