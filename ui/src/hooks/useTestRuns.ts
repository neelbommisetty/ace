import { useCallback, useEffect, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import { cancelTestRun, flushAttemptEnd, getTestRuns, patchAttempt, startTestRun } from '../api';
import type { RunDisplay } from '../components/TestConsole';
import { isFullyPassing } from '../lib/run';
import { useSseEvent } from '../sse';
import type { AttemptRow, TestRunRow, TestRunTrigger } from '../types';
import { useCancellableEffect } from './useCancellableEffect';
import { useLatestRef } from './useLatestRef';

const OUTPUT_MAX_LINES = 2000;
const HISTORY_LIMIT = 50;

function runRowToDisplay(row: TestRunRow): RunDisplay {
  return {
    runId: row.id,
    at: row.at,
    status: row.status,
    summary:
      row.total != null
        ? {
            total: row.total,
            passed: row.passed ?? 0,
            failed: row.failed ?? 0,
            skipped: row.skipped ?? 0,
            durationMs: row.durationMs ?? 0,
          }
        : null,
    results: row.results,
    errorMessage: row.errorMessage,
  };
}

function appendCapped(prev: string, chunk: string): string {
  const next = prev + chunk;
  const lines = next.split('\n');
  if (lines.length <= OUTPUT_MAX_LINES) return next;
  return lines.slice(lines.length - OUTPUT_MAX_LINES).join('\n');
}

/**
 * The Room's test-run slice: the in-flight run, last finished run, run
 * history, streamed output, the run-related SSE handlers, the Cmd+Enter /
 * Cmd+S shortcuts (window + Monaco), and the claim-'solved'-on-leave
 * attempt end.
 */
export function useTestRuns({
  questionId,
  attempt,
  hasTests,
  initialLastRun,
  flushSaves,
}: {
  questionId: string;
  attempt: AttemptRow | null;
  hasTests: boolean;
  /** detail.lastRun — seeds lastRun so a finished run survives a reload. */
  initialLastRun: TestRunRow | null;
  flushSaves: () => Promise<void>;
}) {
  const flushSavesRef = useLatestRef(flushSaves);

  const [running, setRunning] = useState<{ runId: string; trigger: TestRunTrigger } | null>(null);
  const runningRef = useLatestRef(running);
  const [lastRun, setLastRun] = useState<RunDisplay | null>(() =>
    initialLastRun != null && initialLastRun.status !== 'running'
      ? runRowToDisplay(initialLastRun)
      : null,
  );
  const lastRunRef = useLatestRef(lastRun);
  const [history, setHistory] = useState<TestRunRow[]>([]);
  const [output, setOutput] = useState('');
  const [runError, setRunError] = useState<string | null>(null);

  useCancellableEffect(
    (cancelled) => {
      if (!hasTests) return;
      getTestRuns(questionId, HISTORY_LIMIT)
        .then((rows) => {
          if (cancelled()) return;
          setHistory(rows);
          const latestFinished = rows.find((r) => r.status !== 'running');
          if (latestFinished) {
            setLastRun((cur) => cur ?? runRowToDisplay(latestFinished));
          }
        })
        .catch(() => {});
    },
    [questionId, hasTests],
  );

  const startRun = useCallback(
    (trigger: TestRunTrigger) => {
      if (!hasTests || attempt == null) return;
      setRunError(null);
      void (async () => {
        try {
          // A manual run must test what's in the buffer, not what the 600ms
          // debounce last happened to write — flush pending saves first.
          if (trigger === 'manual') await flushSavesRef.current();
          await startTestRun(attempt.id, trigger);
        } catch (e) {
          setRunError(e instanceof Error ? e.message : 'Failed to start the run');
        }
      })();
    },
    [attempt, hasTests, flushSavesRef],
  );
  const startRunRef = useLatestRef(startRun);

  /**
   * Stops the currently in-flight run (NEE-295) — the server kills the
   * process tree and marks it 'cancelled'; 'run-done' (already wired above)
   * then clears `running` and renders the existing "Run was cancelled."
   * state. A no-op if nothing is running or the run already finished (404,
   * swallowed — the UI will settle via run-done/hello either way).
   */
  const stopRun = useCallback(() => {
    const cur = runningRef.current;
    if (cur == null) return;
    cancelTestRun(cur.runId).catch(() => {});
  }, [runningRef]);

  useSseEvent('run-started', (p) => {
    if (p.questionId !== questionId) return;
    setRunning({ runId: p.runId, trigger: p.trigger });
    setOutput('');
    setRunError(null);
  });

  useSseEvent('run-output', (p) => {
    if (runningRef.current?.runId !== p.runId) return;
    setOutput((prev) => appendCapped(prev, p.chunk));
  });

  useSseEvent('run-done', (p) => {
    if (p.questionId !== questionId) return;
    const cur = runningRef.current;
    if (cur != null && cur.runId !== p.runId) return; // a superseded run finishing late
    setRunning(null);
    setLastRun({
      runId: p.runId,
      at: new Date().toISOString(),
      status: p.status,
      summary: p.summary,
      results: p.results,
      errorMessage: p.errorMessage,
    });
    if (p.status === 'error' && p.errorMessage != null) {
      setOutput((prev) => appendCapped(prev, `${prev ? '\n' : ''}[run error] ${p.errorMessage}\n`));
    }
    getTestRuns(questionId, HISTORY_LIMIT).then(setHistory).catch(() => {});
  });

  // SSE reconnected (each connect sends hello): a run-done may have been
  // missed while offline — reconcile so the console can't be stuck "running".
  useSseEvent('hello', () => {
    if (!hasTests || runningRef.current == null) return;
    getTestRuns(questionId, HISTORY_LIMIT)
      .then((rows) => {
        setHistory(rows);
        const cur = runningRef.current;
        if (cur == null) return;
        const row = rows.find((r) => r.id === cur.runId);
        if (row != null && row.status !== 'running') {
          setRunning(null);
          setLastRun(runRowToDisplay(row));
        }
      })
      .catch(() => {});
  });

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        startRunRef.current('manual');
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        flushSavesRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [startRunRef, flushSavesRef]);

  const handleEditorMount: OnMount = useCallback(
    (editor, monacoInstance) => {
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter, () => {
        startRunRef.current('manual');
      });
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
        flushSavesRef.current();
      });
      editor.focus();
    },
    [startRunRef, flushSavesRef],
  );

  // ---- claim 'solved' on leaving the room ----------------------------------
  // Deliberately NOT the moment tests go green — only leaving the room ends
  // the attempt (ticket decision), so the user can keep polishing within the
  // attempt after tests pass. The `r.at >= attempt.startedAt` gate guards the
  // Start-new-attempt case: the fresh attempt N+1 seeds lastRun from the OLD
  // passing run (see the lastRun initializer above), so without this gate,
  // leaving before any new run would instantly close the brand-new attempt.
  // Either way this is only a client-side hint — the server re-verifies from
  // test_runs (isAttemptSolved) before honoring the claim, so a stale or
  // forged value here is harmless.
  const shouldClaimSolved = useCallback(() => {
    if (attempt == null) return false;
    const r = lastRunRef.current;
    return r != null && isFullyPassing(r) && r.at >= attempt.startedAt;
  }, [attempt, lastRunRef]);

  useEffect(() => {
    if (attempt == null) return;
    const attemptId = attempt.id;
    const onPageHide = () => {
      if (shouldClaimSolved()) flushAttemptEnd(attemptId, 'solved');
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      // SPA navigation away. Accepted race: an auto-run still in flight at
      // leave time can finish failing right after the attempt closes
      // 'solved' — left as-is, same as any other end-reason race.
      if (shouldClaimSolved()) {
        patchAttempt(attemptId, { end: { reason: 'solved' } }).catch(() => {});
      }
    };
  }, [attempt, shouldClaimSolved]);

  return { running, lastRun, history, output, runError, startRun, stopRun, handleEditorMount };
}
