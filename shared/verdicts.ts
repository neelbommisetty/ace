/**
 * The hire-scale verdict vocabulary shared by cli/ and ui/ (NEE-356).
 *
 * These four strings are the whole vocabulary: the review rubrics emit them
 * title-cased, `reviews.ts` constrains its structured extraction to exactly
 * this set (and its regex fallback matches the same alternation), the
 * importer parses the same four out of legacy scorecards, and
 * `ReviewRow.verdict` carries one of them — or null when the review stated
 * none.
 *
 * `POSITIVE_VERDICT` is the *solved bar* for categories with no test suite
 * (design/behavioral): they can never produce a passing test run, so the
 * latest review's verdict is the only signal there is. A Record — never a
 * ternary chain or an `includes` over a literal array — so widening the
 * union forces a decision here instead of silently defaulting a new verdict
 * to "not solved" (the repo's Record<QuestionType, X> convention, same
 * reasoning).
 */
export type HireVerdict = 'Strong Hire' | 'Hire' | 'Lean Hire' | 'No Hire';

export const POSITIVE_VERDICT: Record<HireVerdict, boolean> = {
  'Strong Hire': true,
  Hire: true,
  // Below the bar on purpose (NEE-356): 'Lean Hire' is the reviewer hedging
  // and 'No Hire' is an outright miss. A question whose latest review lands
  // here stays UNSOLVED, so the Library keeps it in-progress and "Practice
  // next" keeps offering exactly the question the user most needs to redo.
  'Lean Hire': false,
  'No Hire': false,
};

export const HIRE_VERDICTS = Object.keys(POSITIVE_VERDICT) as HireVerdict[];

/**
 * True when a review's verdict clears the solved bar. Anything outside the
 * vocabulary — null (no verdict stated), or free text from a hand-edited /
 * imported row — is never positive.
 */
export function isPositiveVerdict(verdict: string | null | undefined): boolean {
  if (verdict == null) return false;
  return POSITIVE_VERDICT[verdict as HireVerdict] === true;
}
