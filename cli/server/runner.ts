import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseVitestJson, stripAnsi } from '../lib/vitest-json.js';
import type { Bus } from './sse.js';
import type {
  AceDb,
  QuestionRow,
  TestRunRow,
  TestRunSummary,
  TestRunTrigger,
} from './types.js';

const RUN_TIMEOUT_MS = 180_000;
const OUTPUT_CAP = 200 * 1024;
// parseVitestJson/stripAnsi moved to cli/lib/vitest-json.ts (shared with the
// generation verifier); re-exported so existing importers keep working.
export { parseVitestJson, stripAnsi };

export interface Runner {
  start(question: QuestionRow, attemptId: string | null, trigger: TestRunTrigger): TestRunRow;
  /**
   * Stops the in-flight run identified by runId (killTree + finishTestRun
   * 'cancelled' + run-done broadcast) WITHOUT starting a replacement.
   * Returns false if runId isn't currently in flight (already finished, or
   * unknown) — a no-op, not an error.
   */
  cancel(runId: string): boolean;
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

    if (parsed && parsed.compileError != null) {
      // vitest ran, emitted its JSON envelope, but the suite never
      // collected (syntax error / broken import) — surface this as its own
      // status rather than a vacuous "0/0 passed" done run (NEE-332).
      finishEntry(entry, { status: 'compile-error', errorMessage: parsed.compileError });
    } else if (parsed) {
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
          '--reporter=default',
          `--outputFile.json=${relOutputFile}`,
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

    cancel(runId) {
      for (const entry of inFlight.values()) {
        if (entry.runId !== runId) continue;
        // supersede() already does exactly "kill this in-flight run and mark
        // it cancelled" — it does NOT itself start a replacement (that's
        // start()'s job, for the *next* run). Reused as-is for a plain
        // cancel with no replacement.
        supersede(entry);
        return true;
      }
      return false;
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
