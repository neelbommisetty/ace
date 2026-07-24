import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getCategoryConfig, type CategorySlug } from './categories.js';
import { parseVitestJson, stripAnsi, type TestCaseResult, type TestRunSummary } from './vitest-json.js';

const RUN_TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 200 * 1024;
const FAILURE_REPORT_CAP = 6 * 1024;

export interface VerifyArtifacts {
  /** Complete hidden solution file — the tests must all pass against it. */
  referenceSolution: string;
  /** Complete test file. */
  testCode: string;
  /** The signature-rendered starter stub — at least one test must FAIL against it. */
  stubSolution: string;
}

export interface VerifyResult {
  green: boolean;
  /** Summary of the reference-solution run when it parsed, else null. */
  summary: TestRunSummary | null;
  /** Why verification is red (per-failed-test report / synthetic reason); null when green. */
  failureReport: string | null;
}

/** Signature of verifyGeneratedQuestion — the injectable seam the pipeline uses. */
export type VerifyFn = (
  workspaceRoot: string,
  category: CategorySlug,
  artifacts: VerifyArtifacts,
) => Promise<VerifyResult>;

interface RunOutcome {
  parsed: { summary: TestRunSummary; results: TestCaseResult[] } | null;
  /** Raw report.json content when one was written, for suite-level errors. */
  raw: string | null;
  stderrTail: string;
  timedOut: boolean;
}

function killTree(child: ChildProcess): void {
  // Mirrors cli/server/runner.ts: vitest spawns pool workers; the child is
  // spawned detached on POSIX so the whole process group dies at once.
  try {
    if (process.platform !== 'win32' && child.pid != null) {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // already dead
  }
}

function runVitest(opts: {
  vitestBin: string;
  sandboxReal: string;
  configPath: string;
  reportPath: string;
}): Promise<RunOutcome> {
  const { vitestBin, sandboxReal, configPath, reportPath } = opts;
  fs.rmSync(reportPath, { force: true });

  return new Promise((resolve) => {
    let stderr = '';
    let timedOut = false;

    const child = spawn(
      vitestBin,
      [
        'run',
        '--config',
        configPath,
        '--root',
        sandboxReal,
        '--reporter=json',
        `--outputFile=${reportPath}`,
      ],
      {
        cwd: sandboxReal,
        env: { ...process.env, CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      },
    );

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, RUN_TIMEOUT_MS);

    const cap = (existing: string, chunk: string) => {
      const combined = existing + chunk;
      return combined.length > OUTPUT_CAP ? combined.slice(combined.length - OUTPUT_CAP) : combined;
    };
    child.stdout?.on('data', () => {
      // JSON goes to the output file; stdout is drained so the child never
      // blocks on a full pipe, but its content is not needed.
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr = cap(stderr, data.toString('utf8'));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        parsed: null,
        raw: null,
        stderrTail: `failed to spawn vitest: ${err.message}`,
        timedOut,
      });
    });
    child.on('close', () => {
      clearTimeout(timer);
      let raw: string | null = null;
      try {
        raw = fs.readFileSync(reportPath, 'utf8');
      } catch {
        raw = null;
      }
      resolve({
        parsed: raw === null ? null : parseVitestJson(raw),
        raw,
        stderrTail: stripAnsi(stderr).trim().slice(-FAILURE_REPORT_CAP),
        timedOut,
      });
    });
  });
}

/**
 * When a run collects zero tests, the real cause (a transform/load error in
 * the solution or test file) lives in the report's per-file `message` field,
 * which parseVitestJson does not surface — pull it out for the report.
 */
function collectSuiteErrors(raw: string | null): string {
  if (!raw) return '';
  try {
    const report = JSON.parse(raw) as { testResults?: Array<{ message?: string }> };
    return (report.testResults ?? [])
      .map((r) => (typeof r.message === 'string' ? stripAnsi(r.message).trim() : ''))
      .filter(Boolean)
      .join('\n\n')
      .slice(0, FAILURE_REPORT_CAP);
  } catch {
    return '';
  }
}

function buildFailureReport(results: TestCaseResult[]): string {
  const failed = results.filter((r) => r.status === 'failed');
  const report = failed
    .map((r) => {
      const name = r.suite ? `${r.suite} › ${r.name}` : r.name;
      return r.error ? `✕ ${name}\n${r.error}` : `✕ ${name}`;
    })
    .join('\n\n');
  return report.length > FAILURE_REPORT_CAP
    ? `${report.slice(0, FAILURE_REPORT_CAP)}\n… (truncated)`
    : report;
}

/**
 * Verifies a generated question's tests in a disposable sandbox under
 * `<workspaceRoot>/.ace/tmp/`, with two vitest runs per call:
 *
 * 1. tests vs `referenceSolution` — every test must pass (and there must be
 *    at least one test; a zero-test suite is a failure, not a pass);
 * 2. tests vs `stubSolution` — at least one test must be observed to fail.
 *    An all-green stub run means the suite is vacuous; a timed-out, crashed,
 *    or zero-test stub run proves nothing (and usually means the starter
 *    stub itself is broken) — every such outcome is red, never green.
 *
 * The sandbox gets its own vitest config (the workspace config only includes
 * `questions/**`, which would silently run 0 tests here); module resolution
 * walks up from the sandbox into the workspace's node_modules. Throws only
 * for environment problems (missing vitest binary); test problems come back
 * as `{ green: false, failureReport }`.
 */
export async function verifyGeneratedQuestion(
  workspaceRoot: string,
  category: CategorySlug,
  artifacts: VerifyArtifacts,
): Promise<VerifyResult> {
  const vitestBin = path.join(workspaceRoot, 'node_modules', '.bin', 'vitest');
  if (!fs.existsSync(vitestBin)) {
    throw new Error('vitest not installed in workspace — run npm install');
  }

  const config = getCategoryConfig(category);
  const solutionFile = config.solutionFiles[0];
  const testFile = config.testFiles[0];
  if (!solutionFile || !testFile) {
    throw new Error(`category "${category}" has no solution/test files to verify`);
  }

  const sandbox = path.join(workspaceRoot, '.ace', 'tmp', `gen-verify-${crypto.randomUUID()}`);
  fs.mkdirSync(sandbox, { recursive: true });

  try {
    // macOS tmp/workspace paths can contain symlinked segments (/var →
    // /private/var); vitest resolves --root internally against the real
    // path, so hand it the real path up front (mirrors cli/server/runner.ts).
    let sandboxReal = sandbox;
    try {
      sandboxReal = fs.realpathSync(sandbox);
    } catch {
      // keep the original value
    }
    let workspaceReal = workspaceRoot;
    try {
      workspaceReal = fs.realpathSync(workspaceRoot);
    } catch {
      // keep the original value
    }

    const setupFile = path.join(workspaceReal, 'vitest.setup.ts');
    const setupLine = fs.existsSync(setupFile)
      ? `    setupFiles: [${JSON.stringify(setupFile)}],\n`
      : '';
    const configPath = path.join(sandbox, 'vitest.config.ts');
    fs.writeFileSync(
      configPath,
      `import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: ${JSON.stringify(sandboxReal)},
  test: {
    include: ['**/*.test.{ts,tsx}'],
    globals: true,
    environment: 'happy-dom',
    testTimeout: 10000,
${setupLine}  },
});
`,
    );
    fs.writeFileSync(path.join(sandbox, solutionFile), artifacts.referenceSolution);
    fs.writeFileSync(path.join(sandbox, testFile), artifacts.testCode);

    const reportPath = path.join(sandbox, 'report.json');
    const runOpts = { vitestBin, sandboxReal, configPath, reportPath };

    // Run 1: tests must be all green against the reference solution.
    const refRun = await runVitest(runOpts);
    if (refRun.timedOut) {
      return {
        green: false,
        summary: refRun.parsed?.summary ?? null,
        failureReport: `verification run timed out after ${RUN_TIMEOUT_MS / 1000}s — look for unresolved promises, real timers, or infinite loops in the tests`,
      };
    }
    if (!refRun.parsed) {
      return {
        green: false,
        summary: null,
        failureReport:
          refRun.stderrTail ||
          'vitest produced no parseable JSON report (likely a syntax/transform error in the generated files)',
      };
    }
    const { summary, results } = refRun.parsed;
    if (summary.total === 0) {
      const suiteErrors = collectSuiteErrors(refRun.raw);
      return {
        green: false,
        summary,
        failureReport: suiteErrors
          ? `no tests ran — the suite failed to load or compile:\n${suiteErrors}`
          : 'the test file contains no tests — write real assertions',
      };
    }
    if (summary.failed > 0 || summary.passed !== summary.total) {
      return { green: false, summary, failureReport: buildFailureReport(results) };
    }

    // Run 2: rewrite the solution with the starter stub — at least one test
    // must now be OBSERVED to fail. Anything else is red: all-green means
    // the suite is vacuous, and a timeout/crash/zero-test run proves nothing
    // (a stub that cannot even load is a broken starter file).
    fs.writeFileSync(path.join(sandbox, solutionFile), artifacts.stubSolution);
    const stubRun = await runVitest(runOpts);
    if (stubRun.timedOut) {
      return {
        green: false,
        summary,
        failureReport: `stub verification run timed out after ${RUN_TIMEOUT_MS / 1000}s — look for unresolved promises, real timers, or infinite loops the stub triggers`,
      };
    }
    if (!stubRun.parsed) {
      return {
        green: false,
        summary,
        failureReport:
          stubRun.stderrTail || 'the stub verification run produced no parseable JSON report',
      };
    }
    if (stubRun.parsed.summary.total === 0) {
      const suiteErrors = collectSuiteErrors(stubRun.raw);
      return {
        green: false,
        summary,
        failureReport: `no tests ran against the starter stub — the stub file itself likely fails to load or compile (check that the signature renders to valid code)${suiteErrors ? `:\n${suiteErrors}` : ''}`,
      };
    }
    if (stubRun.parsed.summary.failed === 0) {
      return {
        green: false,
        summary,
        failureReport:
          'every test passes against the unimplemented starter stub — the suite is vacuous; assert on the actual required behavior so tests fail until the solution is implemented',
      };
    }

    return { green: true, summary, failureReport: null };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}
