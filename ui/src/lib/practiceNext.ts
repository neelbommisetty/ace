/**
 * "Practice next" heuristic (NEE-310): a single suggested question for the
 * Library card, computed over the already-fetched `QuestionWithStats[]` —
 * no new model, no LLM, no schema change. Pure function, unit-tested in
 * isolation from the component that renders it.
 */

import { categoryShortName } from './categories';
import { relTime } from './format';
import type { QuestionWithStats } from '../types';

export interface PracticeNextSuggestion {
  question: QuestionWithStats;
  /** One-line reason, e.g. "not attempted · LC-Algo · ~30m" / "failed last attempt 3d ago". */
  reason: string;
}

/**
 * First unattempted question (oldest by createdAt, for a stable pick), else
 * the oldest failed attempt (earliest last-run timestamp among questions
 * whose last run didn't fully pass), else the least-recently-touched
 * in-progress question. Archived, missing-on-disk (reconciler-flagged), and
 * already-solved questions are never suggested. Returns null when nothing is
 * left to suggest — the Library hides the card in that case.
 */
export function pickPracticeNext(questions: QuestionWithStats[]): PracticeNextSuggestion | null {
  const candidates = questions.filter(
    (q) => q.archivedAt == null && q.missingAt == null && q.stats.status !== 'solved',
  );
  if (candidates.length === 0) return null;

  const unattempted = candidates.filter((q) => q.stats.status === 'not-attempted');
  if (unattempted.length > 0) {
    const pick = [...unattempted].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    return {
      question: pick,
      reason: `not attempted · ${categoryShortName(pick.category)} · ~${pick.suggestedMinutes}m`,
    };
  }

  const failed = candidates.filter(
    (q) =>
      q.stats.lastRun != null &&
      (q.stats.lastRun.status === 'compile-error' || q.stats.lastRun.passed < q.stats.lastRun.total),
  );
  if (failed.length > 0) {
    const pick = [...failed].sort((a, b) => a.stats.lastRun!.at.localeCompare(b.stats.lastRun!.at))[0];
    return { question: pick, reason: `failed last attempt ${relTime(pick.stats.lastRun!.at)}` };
  }

  // in-progress, no failing run on record (e.g. every run so far passed but
  // the attempt was never closed out) — fall back to the least-recently-
  // touched candidate so the card still has something to say.
  const pick = [...candidates].sort((a, b) => {
    const at = a.stats.lastActivityAt ?? a.createdAt;
    const bt = b.stats.lastActivityAt ?? b.createdAt;
    return at.localeCompare(bt);
  })[0];
  return { question: pick, reason: `in progress · last touched ${relTime(pick.stats.lastActivityAt)}` };
}
