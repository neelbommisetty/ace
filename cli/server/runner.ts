import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Bus } from './sse.js';
import type {
  AceDb,
  QuestionRow,
  TestCaseResult,
  TestRunRow,
  TestRunSummary,
  TestRunTrigger,
} from './types.js';

const RUN_TIMEOUT_MS = 180_000;
const OUTPUT_CAP = 200 * 1024;
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
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
 * durationMs is a per-case sum; the runner replaces it with wall time.
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

export interface Runner {
  start(question: QuestionRow, attemptId: string | null, trigger: TestRunTrigger): TestRunRow;
  /** True while any test run is in flight, across all questions. */
  isBusy(): boolean;
  dispose(): void;
}

interface InFlightRun {
  runId: string;
  questionId: string;
  attemptId: string | null;
  child: ChildProcess;
  timer: NodeJS.Timeout;
  startedAt: number;
  stdout: string;
  stderr: string;
  outputFile: string;
  superseded: boolean;
  timedOut: boolean;
  finished: boolean;
}

export function createRunner(opts: {
  db: AceDb;
  bus: Bus;
  workspaceRoot: string;
}): Runner {
  const { db, bus, workspaceRoot } = opts;
  const inFlight = new Map<string, InFlightRun>();

  function appendCapped(existing: string, chunk: string): string {
    const combined = existing + chunk;
    return combined.length > OUTPUT_CAP ? combined.slice(combined.length - OUTPUT_CAP) : combined;
  }

  function emitDone(run: TestRunRow): void {
    bus.emit('run-done', {
      runId: run.id,
      questionId: run.questionId,
      status: run.status,
      summary:
        run.status === 'done' && run.total !== null
          ? {
              total: run.total,
              passed: run.passed ?? 0,
              failed: run.failed ?? 0,
              skipped: run.skipped ?? 0,
              durationMs: run.durationMs ?? 0,
            }
          : null,
      results: run.results,
      errorMessage: run.errorMessage,
    });
  }

  function killTree(child: ChildProcess): void {
    // Vitest spawns pool workers; killing only the orchestrator can orphan a
    // worker stuck in a synchronous loop at 100% CPU. The child is spawned
    // detached on POSIX so the whole process group can be killed at once.
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

  function supersede(entry: InFlightRun): void {
    entry.superseded = true;
    entry.finished = true;
    clearTimeout(entry.timer);
    inFlight.delete(entry.questionId);
    killTree(entry.child);
    const row = db.finishTestRun(entry.runId, {
      status: 'cancelled',
      stdout: entry.stdout,
      stderr: entry.stderr,
    });
    emitDone(row);
    cleanupOutputFile(entry);
  }

  function finishEntry(
    entry: InFlightRun,
    patch: Parameters<AceDb['finishTestRun']>[1],
  ): TestRunRow {
    entry.finished = true;
    clearTimeout(entry.timer);
    if (inFlight.get(entry.questionId) === entry) inFlight.delete(entry.questionId);
    const row = db.finishTestRun(entry.runId, {
      ...patch,
      stdout: entry.stdout,
      stderr: entry.stderr,
    });
    emitDone(row);
    return row;
  }

  function handleExit(entry: InFlightRun, exitCode: number | null): void {
    if (entry.finished) return;

    if (entry.timedOut) {
      finishEntry(entry, {
        status: 'error',
        errorMessage: `test run timed out after ${RUN_TIMEOUT_MS / 1000}s`,
      });
      cleanupOutputFile(entry);
      return;
    }

    let raw: string | null = null;
    try {
      raw = fs.readFileSync(entry.outputFile, 'utf8');
    } catch {
      raw = null;
    }
    const parsed = raw === null ? null : parseVitestJson(raw);

    if (parsed) {
      const summary: TestRunSummary = {
        ...parsed.summary,
        durationMs: Date.now() - entry.startedAt,
      };
      finishEntry(entry, { status: 'done', summary, results: parsed.results });
      if (
        entry.attemptId &&
        summary.total > 0 &&
        summary.passed === summary.total &&
        !db.hasAttemptEvent(entry.attemptId, 'all_green')
      ) {
        db.addAttemptEvent(entry.attemptId, 'all_green', { runId: entry.runId });
      }
    } else {
      const stderrTail = stripAnsi(entry.stderr).trim().slice(-2000);
      finishEntry(entry, {
        status: 'error',
        errorMessage:
          stderrTail ||
          `vitest exited with code ${exitCode ?? 'null'} and produced no JSON output`,
      });
    }
    cleanupOutputFile(entry);
  }

  function cleanupOutputFile(entry: InFlightRun): void {
    try {
      fs.rmSync(entry.outputFile, { force: true });
    } catch {
      // best-effort cleanup
    }
  }

  return {
    start(question, attemptId, trigger) {
      const existing = inFlight.get(question.id);
      if (existing) supersede(existing);

      const run = db.createTestRun({ questionId: question.id, attemptId, trigger });
      if (attemptId) {
        db.addAttemptEvent(attemptId, 'test_run', { runId: run.id, trigger });
      }
      bus.emit('run-started', {
        runId: run.id,
        questionId: question.id,
        attemptId,
        trigger,
      });

      const vitestBin = path.join(workspaceRoot, 'node_modules', '.bin', 'vitest');
      if (!fs.existsSync(vitestBin)) {
        const row = db.finishTestRun(run.id, {
          status: 'error',
          errorMessage: 'vitest not installed in workspace — run npm install',
        });
        emitDone(row);
        return row;
      }

      const tmpDir = path.join(workspaceRoot, '.ace', 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const relOutputFile = `.ace/tmp/${run.id}.json`;
      const relQuestionDir = path.relative(workspaceRoot, question.dirPath);

      // Vite resolves absolute virtual module paths (e.g. `/@fs/<root>/...`
      // for setupFiles) against a canonicalized form of `--root` internally,
      // but does NOT canonicalize the `--root` value we pass it. If
      // workspaceRoot itself contains a symlinked path segment — notably
      // macOS, where `os.tmpdir()` (and therefore any workspace under it,
      // e.g. in e2e tests) lives under `/var/...`, itself a symlink to
      // `/private/var/...` — the two disagree and every run fails with
      // "Cannot find module .../vitest.setup.ts" before any test executes.
      // Resolving once here keeps `--root` and the child's cwd on the same
      // (real) path Vite computes internally. Falls back to workspaceRoot
      // as-is if it can't be resolved (should not happen — the server has
      // this root open — but a spawn must never throw synchronously here).
      let vitestRoot = workspaceRoot;
      try {
        vitestRoot = fs.realpathSync(workspaceRoot);
      } catch {
        // keep the original value
      }

      const child = spawn(
        vitestBin,
        [
          'run',
          relQuestionDir,
          '--reporter=json',
          `--outputFile=${relOutputFile}`,
          '--root',
          vitestRoot,
        ],
        {
          cwd: vitestRoot,
          env: { ...process.env, CI: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          // Own process group on POSIX so killTree can kill pool workers too.
          detached: process.platform !== 'win32',
        },
      );

      const entry: InFlightRun = {
        runId: run.id,
        questionId: question.id,
        attemptId,
        child,
        startedAt: Date.now(),
        stdout: '',
        stderr: '',
        outputFile: path.join(workspaceRoot, relOutputFile),
        superseded: false,
        timedOut: false,
        finished: false,
        timer: setTimeout(() => {
          entry.timedOut = true;
          killTree(child);
        }, RUN_TIMEOUT_MS),
      };
      inFlight.set(question.id, entry);

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString('utf8');
        entry.stdout = appendCapped(entry.stdout, chunk);
        bus.emit('run-output', { runId: run.id, stream: 'stdout', chunk });
      });
      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString('utf8');
        entry.stderr = appendCapped(entry.stderr, chunk);
        bus.emit('run-output', { runId: run.id, stream: 'stderr', chunk });
      });

      child.on('error', (err) => {
        if (entry.finished) return;
        finishEntry(entry, {
          status: 'error',
          errorMessage: `failed to spawn vitest: ${err.message}`,
        });
        cleanupOutputFile(entry);
      });
      child.on('close', (code) => {
        handleExit(entry, code);
      });

      return run;
    },

    isBusy() {
      return inFlight.size > 0;
    },

    dispose() {
      for (const entry of [...inFlight.values()]) {
        try {
          supersede(entry);
        } catch {
          // db may already be closing during shutdown
        }
      }
      inFlight.clear();
    },
  };
}
