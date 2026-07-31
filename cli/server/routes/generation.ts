import type { Hono } from 'hono';
import { CATEGORY_SLUGS, type CategorySlug, type Difficulty } from '../../lib/categories.js';
import { redactGenerationJob } from '../generation.js';
import { parseLimit, questionLookup, readJsonBody, requireProvider } from '../route-helpers.js';
import type { RouteContext } from './context.js';

const DIFFICULTIES: ReadonlySet<string> = new Set<Difficulty>(['easy', 'medium', 'hard']);
const GENERATION_CAP_ERROR = 'three generations are already running — let one finish first';

export function registerGenerationRoutes(app: Hono, ctx: RouteContext): void {
  const lookupQuestion = questionLookup(ctx);

  app.post('/api/generation/jobs', async (c) => {
    const { db, generation } = ctx.requireSession();
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
    const noProvider = requireProvider(c);
    if (noProvider) return noProvider;

    const { jobId } = generation.start({
      category: category as CategorySlug,
      difficulty: difficulty as Difficulty,
      topic,
      brainstormSessionId,
    });
    return c.json({ jobId }, 202);
  });

  app.get('/api/generation/jobs', (c) => {
    const { db } = ctx.requireSession();
    const limit = parseLimit(c, { default: 20, max: 100 });
    if (!limit.ok) return limit.response;
    // Redacted: job results carry the hidden reference solution/interviewer
    // packet, which must only ever surface through the review-gated debrief.
    return c.json({ jobs: db.listGenerationJobs(limit.limit).map(redactGenerationJob) });
  });

  app.get('/api/generation/jobs/:id', (c) => {
    const { db } = ctx.requireSession();
    const job = db.getGenerationJob(c.req.param('id'));
    if (!job) return c.json({ error: 'generation job not found' }, 404);
    return c.json({ job: redactGenerationJob(job) });
  });

  app.post('/api/generation/jobs/:id/retry', (c) => {
    const { db, generation } = ctx.requireSession();
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
    if (job.result == null) {
      const noProvider = requireProvider(c);
      if (noProvider) return noProvider;
    }

    const { jobId } = generation.retry(job);
    return c.json({ jobId }, 202);
  });

  // Regenerate-with-feedback (NEE-386): question-scoped rather than
  // job-scoped — the Room/Library only have (category, slug), and
  // questionLookup gives the 404 for free. Reuses the same cap-3 +
  // provider gating as POST /api/generation/jobs; category/difficulty/topic
  // are copied verbatim from the source question's own latest done job
  // (the ticket's "same topic" call), never re-supplied by the client.
  app.post('/api/questions/:category/:slug/regenerate', lookupQuestion, async (c) => {
    const { db, generation } = ctx.requireSession();
    const question = c.get('question');

    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);

    const feedback = body.feedback;
    if (typeof feedback !== 'string' || feedback.length < 1 || feedback.length > 4000) {
      return c.json({ error: 'feedback must be a string between 1 and 4000 characters' }, 400);
    }

    if (question.source !== 'generated') {
      return c.json({ error: 'only generated questions can be regenerated with feedback' }, 409);
    }

    // The prior result is answer key — resolved here (server-side, never
    // sent to the client) purely to confirm it still exists and to hand the
    // engine the (category, difficulty, topic) to reuse; the engine
    // re-resolves it again at run time from the row alone.
    const sourceJob = db.getLatestDoneGenerationJobForQuestion(question.id);
    if (sourceJob?.result == null) {
      return c.json(
        {
          error:
            'the original generation result is no longer available — generate a new question instead',
        },
        409,
      );
    }

    if (generation.runningCount() >= 3) {
      return c.json({ error: GENERATION_CAP_ERROR }, 409);
    }
    const noProvider = requireProvider(c);
    if (noProvider) return noProvider;

    // brainstormSessionId is deliberately omitted (null) — a regenerate job
    // never traces back to a brainstorm turn.
    const { jobId } = generation.start({
      category: sourceJob.category as CategorySlug,
      difficulty: sourceJob.difficulty,
      topic: sourceJob.topic,
      feedback,
      sourceQuestionId: question.id,
    });
    return c.json({ jobId }, 202);
  });
}
