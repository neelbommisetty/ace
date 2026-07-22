/**
 * True when a finished test run passed every test — the client-side signal
 * used to decide whether leaving the room should claim the attempt as
 * 'solved'. This is only ever a hint: the server re-verifies from
 * `test_runs` (see `isAttemptSolved` in cli/server/app.ts) before honoring
 * the claim, so a stale or forged value here is harmless.
 */
export function isFullyPassing(
  run: { status: string; summary: { total: number; passed: number } | null } | null,
): boolean {
  return (
    run != null &&
    run.status === 'done' &&
    run.summary != null &&
    run.summary.total > 0 &&
    run.summary.passed === run.summary.total
  );
}
