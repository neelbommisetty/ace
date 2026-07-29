const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

// Structural mirrors of cli/server/types.ts's TestCaseResult/TestRunSummary —
// cli/lib must not import cli/server, and server code consumes these shapes
// structurally, so the two stay assignment-compatible by construction.
export interface TestCaseResult {
  name: string;
  suite: string; // ancestor titles joined with ' › ', '' when top-level
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number | null;
  error: string | null; // first failure message, ANSI stripped
}

export interface TestRunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

interface VitestAssertionResult {
  title?: string;
  ancestorTitles?: string[];
  status?: string;
  duration?: number | null;
  failureMessages?: string[];
}

interface VitestFileResult {
  assertionResults?: VitestAssertionResult[];
  // Present on a file that failed to collect at all (syntax error, broken
  // import, etc): vitest's jest-style reporter still emits an entry for it
  // with an empty assertionResults array and the transform/import error
  // here, un-stripped of ANSI color codes.
  message?: string;
}

interface VitestJsonOutput {
  // false when the run as a whole didn't succeed — including a suite that
  // never collected. Absent on report shapes that predate this field
  // (older fixtures / synthetic reports); treated as true when absent so
  // parseVitestJson's success-detection is opt-in, not a regression risk
  // for any caller that never sees `success` in the wild.
  success?: boolean;
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  testResults?: VitestFileResult[];
}

/**
 * Maps vitest's jest-style JSON reporter output to our shapes. Returns null
 * when the input is not parseable as a vitest JSON report. The summary's
 * durationMs is a per-case sum; callers that track wall time replace it.
 *
 * `compileError` is non-null exactly when the suite never collected — the
 * report's top-level `success` is false AND zero tests were collected
 * (`numTotalTests: 0`). That combination is how vitest reports a
 * syntax/transform/import failure: no assertionResults anywhere, but a
 * per-file `message` carrying the actual error. A `success: true` report
 * with `numTotalTests: 0` (a suite that compiles fine but defines no tests)
 * is NOT a compile error — callers should treat that as a neutral
 * "no tests found" outcome, never a failure.
 */
export function parseVitestJson(
  raw: string,
): { summary: TestRunSummary; results: TestCaseResult[]; compileError: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const report = parsed as VitestJsonOutput;
  if (typeof report.numTotalTests !== 'number' || !Array.isArray(report.testResults)) {
    return null;
  }

  const results: TestCaseResult[] = [];
  let durationSum = 0;
  for (const file of report.testResults) {
    if (!Array.isArray(file?.assertionResults)) continue;
    for (const assertion of file.assertionResults) {
      const status: TestCaseResult['status'] =
        assertion.status === 'passed'
          ? 'passed'
          : assertion.status === 'failed'
            ? 'failed'
            : 'skipped'; // pending | skipped | todo | anything else
      const durationMs = typeof assertion.duration === 'number' ? assertion.duration : null;
      if (durationMs !== null) durationSum += durationMs;
      const firstFailure = assertion.failureMessages?.[0];
      results.push({
        name: assertion.title ?? '',
        suite: (assertion.ancestorTitles ?? []).join(' › '),
        status,
        durationMs,
        error: typeof firstFailure === 'string' ? stripAnsi(firstFailure) : null,
      });
    }
  }

  const total = report.numTotalTests;
  const passed = typeof report.numPassedTests === 'number' ? report.numPassedTests : 0;
  const failed = typeof report.numFailedTests === 'number' ? report.numFailedTests : 0;
  const summary: TestRunSummary = {
    total,
    passed,
    failed,
    skipped: Math.max(0, total - passed - failed),
    durationMs: Math.round(durationSum),
  };

  const success = report.success !== false;
  let compileError: string | null = null;
  if (!success && total === 0) {
    const messages = report.testResults
      .map((f) => (typeof f?.message === 'string' ? stripAnsi(f.message).trim() : ''))
      .filter(Boolean);
    compileError =
      messages.length > 0 ? messages.join('\n\n') : 'vitest reported a collection failure';
  }

  return { summary, results, compileError };
}
