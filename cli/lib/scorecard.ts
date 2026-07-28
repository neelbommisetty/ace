import fs from 'node:fs';
import path from 'node:path';
import type { Scorecard, CategorySlug, Difficulty } from './categories.js';
import { getSuggestedTime } from './categories.js';
import { getQuestionsDir } from './paths.js';

/**
 * scorecard.json is the LEGACY per-question state file from the pre-SQLite
 * CLI. Nothing writes one during normal operation any more — attempt history,
 * reviews and disputes live in `.ace/ace.db`, and `scaffoldQuestionAt`
 * defaults to `writeScorecard: false`.
 *
 * What survives here is only what still has a live caller:
 *   - the two functions below, used by `scaffoldQuestionAt`'s opt-in
 *     `writeScorecard: true` path (tests use it to synthesise a legacy-shaped
 *     question dir)
 *
 * READING legacy scorecards is deliberately NOT done through this module —
 * `cli/server/importer.ts` (history import) and `cli/server/reconciler.ts`
 * (provenance: a dir with a scorecard.json reconciles as 'generated', without
 * as 'manual') both parse the raw JSON themselves, since they must tolerate
 * arbitrary malformed input from old workspaces rather than assume this shape.
 */

/**
 * Writes scorecard.json under the GIVEN workspace root, never resolving the
 * root from process.cwd(). Used by the server (bound to workspaceRoot at
 * boot) so scaffolded questions land under the right workspace regardless of
 * the server process's cwd.
 */
export function writeScorecardAt(
  root: string,
  category: CategorySlug,
  slug: string,
  scorecard: Scorecard,
): void {
  const questionsDir = getQuestionsDir(root);
  const filepath = path.join(questionsDir, category, slug, 'scorecard.json');
  fs.writeFileSync(filepath, JSON.stringify(scorecard, null, 2) + '\n', 'utf-8');
}

export function createScorecard(
  title: string,
  category: CategorySlug,
  difficulty: Difficulty,
): Scorecard {
  return {
    title,
    category,
    difficulty,
    suggestedTime: getSuggestedTime(category, difficulty),
    status: 'untouched',
    attempts: [],
    llmFeedback: null,
  };
}
