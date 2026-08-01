/**
 * The review-escalation rule (NEE-303 / plan ticket 4), shared by the server
 * (cli/server/reviews.ts picks the slot a review job runs on) and the SPA
 * (AiPanel names the model *before* the user pays for it) so the
 * pre-invocation label can never disagree with what actually runs.
 */
import { hasTests, type CategoryConfig } from './categories.js';

/** All the escalation rule needs off a persisted review row. */
export interface EscalationReview {
  attemptId: string | null;
}

/**
 * A review escalates iff the work in front of it has ALREADY been reviewed
 * once — a re-review of revised work is the high-stakes judgment call.
 *
 * What "already reviewed" means follows the attempt lifecycle, which differs
 * by question type:
 *
 * - Categories WITH tests keep one attempt open across many reviews, so "the
 *   target attempt already has a review of its own" is exactly the test. A
 *   fresh attempt de-escalates back to routine.
 * - Prose categories (design/behavioral, `testFiles: []`) END the attempt the
 *   instant a review lands (`endProseAttemptOnReview`), so an attempt can
 *   never hold two reviews and the attempt-scoped test could never fire —
 *   that is the "never fires for design/behavioral" failure the plan rejected
 *   the post-all_green rule over. There the revision IS the next attempt, so
 *   any prior review on the question makes this one a re-review.
 */
export function isEscalatedReview(opts: {
  config: CategoryConfig;
  /** Every review persisted for the question, in any order. */
  reviews: readonly EscalationReview[];
  /** The attempt this review targets; null in a readonly room. */
  attemptId: string | null;
}): boolean {
  const { config, reviews, attemptId } = opts;
  if (!hasTests(config)) return reviews.length > 0;
  if (attemptId === null) return false;
  return reviews.some((r) => r.attemptId === attemptId);
}
