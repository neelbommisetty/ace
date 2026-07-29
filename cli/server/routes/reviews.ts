import path from 'node:path';
import type { Hono } from 'hono';
import { readFileOr } from '../../lib/read-file-or.js';
import { readBlob } from '../blobs.js';
import { questionLookup, requireProvider } from '../route-helpers.js';
import { getReviewGuardError } from '../reviews.js';
import type { RouteContext } from './context.js';

export function registerReviewRoutes(app: Hono, ctx: RouteContext): void {
  const lookupQuestion = questionLookup(ctx);

  app.post('/api/questions/:category/:slug/reviews', lookupQuestion, (c) => {
    const { db, reviews } = ctx.requireSession();
    const question = c.get('question');

    if (reviews.isRunning(question.id)) {
      return c.json({ error: 'a review is already running for this question' }, 409);
    }
    const guardError = getReviewGuardError(question, db);
    if (guardError) return c.json({ error: guardError }, 400);
    const noProvider = requireProvider(c);
    if (noProvider) return noProvider;

    const attempt = db.getActiveAttempt(question.id);
    const { jobId } = reviews.start(question, attempt?.id ?? null);
    return c.json({ jobId }, 202);
  });

  app.get('/api/questions/:category/:slug/reviews', lookupQuestion, (c) => {
    const { db } = ctx.requireSession();
    return c.json(db.listReviews(c.get('question').id));
  });

  app.get('/api/reviews/:id', (c) => {
    const { db } = ctx.requireSession();
    const review = db.getReview(c.req.param('id'));
    if (!review) return c.json({ error: 'review not found' }, 404);
    const question = db.getQuestionById(review.questionId);
    if (!question) return c.json({ error: 'question not found for review' }, 404);
    const snapshotContent = review.snapshotHash
      ? readBlob(ctx.requireWorkspaceRoot(), review.snapshotHash)
      : null;
    // `question` embedded (NEE-306) so a reload of /history/review/:id has
    // everything the detail view needs without a second round trip.
    return c.json({ ...review, snapshotContent, question });
  });

  // Post-review debrief: the hidden interviewer packet + reference solution
  // written at generation time. Server-side gated — 404 until the question
  // has at least one review, so nothing can render it pre-review. Empty
  // strings for manual/pre-overhaul questions that have no debrief files.
  app.get('/api/questions/:category/:slug/debrief', lookupQuestion, (c) => {
    const { db } = ctx.requireSession();
    const question = c.get('question');
    if (db.listReviews(question.id).length === 0) {
      return c.json({ error: 'the debrief unlocks after your first review' }, 404);
    }
    return c.json({
      interviewerPacket: readFileOr(path.join(question.dirPath, '.interviewer.md')),
      referenceSolution: readFileOr(path.join(question.dirPath, '.reference.md')),
    });
  });
}
