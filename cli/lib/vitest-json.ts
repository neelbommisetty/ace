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

interface VitestJsonOutput {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  testResults?: Array<{ assertionResults?: VitestAssertionResult[] }>;
}

/**
 * Maps vitest's jest-style JSON reporter output to our shapes. Returns null
 * when the input is not parseable as a vitest JSON report. The summary's
 * durationMs is a per-case sum; callers that track wall time replace it.
 */
export function parseVitestJson(
  raw: string,
): { summary: TestRunSummary; results: TestCaseResult[] } | null {
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
  return { summary, results };
}
