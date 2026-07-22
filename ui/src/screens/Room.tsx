import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import { useParams } from 'react-router-dom';
import {
  ApiError,
  createOrResumeAttempt,
  flushAttemptEnd,
  flushFileSave,
  getDisputes,
  getFile,
  getQuestionDetail,
  getReviews,
  getTestRuns,
  patchAttempt,
  postAttemptEvent,
  putFile,
  startFreshAttempt,
  startReview,
  startTestRun,
} from '../api';
import { AiPanel, type ReviewNotice, type ReviewStream } from '../components/AiPanel';
import { DisputeModal } from '../components/DisputeModal';
import { EditorPane, type FileState } from '../components/EditorPane';
import { FreshAttemptDialog } from '../components/FreshAttemptDialog';
import { ProblemPane } from '../components/ProblemPane';
import { TestConsole, type RunDisplay } from '../components/TestConsole';
import { TopBar } from '../components/TopBar';
import { useActiveTimer } from '../hooks/useActiveTimer';
import { isFullyPassing } from '../lib/run';
import { useSseConnected, useSseEvent } from '../sse';
import type {
  AttemptRow,
  DisputeRow,
  QuestionDetail,
  ReviewRow,
  TestRunRow,
  TestRunTrigger,
} from '../types';
import { NotFound } from './NotFound';

const SAVE_DEBOUNCE_MS = 600;
const OUTPUT_MAX_LINES = 2000;
const HISTORY_LIMIT = 50;

export function Room() {
  const { category = '', slug = '' } = useParams();
  const [loaded, setLoaded] = useState<{
    detail: QuestionDetail;
    // null when the question is solved and opened as a readonly reference —
    // there's no active attempt to resume.
    attempt: AttemptRow | null;
    // the ended attempt to base "Start new attempt" off of; only set alongside attempt=null.
    latestAttempt: AttemptRow | null;
  } | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // bumped after a fresh attempt: refetches detail + attempt, remounts RoomInner
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setNotFound(false);
    setError(null);
    (async () => {
      try {
        const detail = await getQuestionDetail(category, slug);
        const res = await createOrResumeAttempt(category, slug);
        if (cancelled) return;
        if (res.readonly) {
          setLoaded({ detail, attempt: null, latestAttempt: res.latestAttempt ?? null });
        } else if (res.attempt) {
          setLoaded({ detail, attempt: res.attempt, latestAttempt: null });
        } else {
          throw new Error('Server did not return an attempt to resume');
        }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else if (!(e instanceof ApiError && e.status === 401)) {
          setError(e instanceof Error ? e.message : 'Failed to open the question');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [category, slug, reloadKey]);

  if (notFound) {
    return <NotFound message={`No question at ${category}/${slug}.`} />;
  }
  if (error != null) {
    return (
      <div className="notfound">
        <p className="notfound-message error-note">{error}</p>
      </div>
    );
  }
  if (loaded == null) {
    return <div className="room-loading">Opening room…</div>;
  }
  return (
    <RoomInner
      key={`${loaded.detail.question.id}:${loaded.attempt?.id ?? 'readonly'}`}
      detail={loaded.detail}
      attempt={loaded.attempt}
      latestAttempt={loaded.latestAttempt}
      onReload={() => setReloadKey((k) => k + 1)}
    />
  );
}

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

function initialFileState(info: QuestionDetail['files'][number]): FileState {
  return {
    info,
    buffer: '',
    savedContent: '',
    savedHash: '',
    loaded: false,
    loadError: null,
    saveState: 'saved',
    lastSavedAt: null,
    saveError: null,
    conflict: false,
  };
}

function appendCapped(prev: string, chunk: string): string {
  const next = prev + chunk;
  const lines = next.split('\n');
  if (lines.length <= OUTPUT_MAX_LINES) return next;
  return lines.slice(lines.length - OUTPUT_MAX_LINES).join('\n');
}

function RoomInner({
  detail,
  attempt,
  latestAttempt,
  onReload,
}: {
  detail: QuestionDetail;
  attempt: AttemptRow | null;
  latestAttempt: AttemptRow | null;
  onReload: () => void;
}) {
  const question = detail.question;
  const questionId = question.id;
  const connected = useSseConnected();

  // Solved question opened as a read-only reference: no active attempt.
  const readonly = attempt == null;

  const editorFiles = useMemo(
    () =>
      detail.files
        .filter((f) => f.kind !== 'readme')
        .map((f) => (readonly ? { ...f, readonly: true } : f)),
    [detail.files, readonly],
  );
  const hasTests = useMemo(() => editorFiles.some((f) => f.kind === 'test'), [editorFiles]);

  // ---- file buffers -------------------------------------------------------
  const [files, setFiles] = useState<Record<string, FileState>>(() =>
    Object.fromEntries(editorFiles.map((f) => [f.relPath, initialFileState(f)])),
  );
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const firstEditable = editorFiles.find((f) => !f.readonly) ?? editorFiles[0];
  const [activeTab, setActiveTab] = useState<string>(firstEditable?.relPath ?? '');

  const updateFile = useCallback(
    (relPath: string, patch: Partial<FileState> | ((f: FileState) => Partial<FileState>)) => {
      setFiles((prev) => {
        const f = prev[relPath];
        if (!f) return prev;
        const p = typeof patch === 'function' ? patch(f) : patch;
        const next = { ...prev, [relPath]: { ...f, ...p } };
        filesRef.current = next;
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    for (const info of editorFiles) {
      getFile(info.relPath)
        .then(({ content, hash }) => {
          if (cancelled) return;
          updateFile(info.relPath, {
            buffer: content,
            savedContent: content,
            savedHash: hash,
            loaded: true,
            loadError: null,
          });
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          updateFile(info.relPath, {
            loadError: e instanceof Error ? e.message : `Failed to load ${info.name}`,
          });
        });
    }
    return () => {
      cancelled = true;
    };
    // editorFiles is stable per mount (RoomInner is keyed by question+attempt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- test runs ----------------------------------------------------------
  const [running, setRunning] = useState<{ runId: string; trigger: TestRunTrigger } | null>(null);
  const runningRef = useRef(running);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  const [lastRun, setLastRun] = useState<RunDisplay | null>(() =>
    detail.lastRun != null && detail.lastRun.status !== 'running'
      ? runRowToDisplay(detail.lastRun)
      : null,
  );
  const lastRunRef = useRef(lastRun);
  useEffect(() => {
    lastRunRef.current = lastRun;
  }, [lastRun]);
  const [history, setHistory] = useState<TestRunRow[]>([]);
  const [output, setOutput] = useState('');
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasTests) return;
    let cancelled = false;
    getTestRuns(questionId, HISTORY_LIMIT)
      .then((rows) => {
        if (cancelled) return;
        setHistory(rows);
        const latestFinished = rows.find((r) => r.status !== 'running');
        if (latestFinished) {
          setLastRun((cur) => cur ?? runRowToDisplay(latestFinished));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [questionId, hasTests]);

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
    [attempt, hasTests],
  );
  const startRunRef = useRef(startRun);
  useEffect(() => {
    startRunRef.current = startRun;
  }, [startRun]);

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

  // ---- autosave -----------------------------------------------------------
  const [autorun, setAutorun] = useState(() => localStorage.getItem('ace-autorun') !== 'false');
  const autorunRef = useRef(autorun);
  useEffect(() => {
    autorunRef.current = autorun;
    localStorage.setItem('ace-autorun', autorun ? 'true' : 'false');
  }, [autorun]);

  const saveTimers = useRef(new Map<string, number>());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const saveFile = useCallback(
    async (relPath: string, opts?: { autorun?: boolean }) => {
      const f = filesRef.current[relPath];
      if (!f || !f.loaded || f.info.readonly || f.conflict) return;
      if (f.buffer === f.savedContent) return;
      const content = f.buffer;
      updateFile(relPath, { saveState: 'saving', saveError: null });
      try {
        const { hash } = await putFile(relPath, content);
        updateFile(relPath, (cur) => ({
          savedContent: content,
          savedHash: hash,
          lastSavedAt: Date.now(),
          saveState: cur.buffer === content ? 'saved' : 'unsaved',
        }));
        // Never fire an auto-run from a flush (manual runs handle their own
        // trigger) or after the room has been left.
        if ((opts?.autorun ?? true) && mountedRef.current && autorunRef.current && hasTests) {
          startRunRef.current('save');
        }
      } catch (e) {
        updateFile(relPath, {
          saveState: 'unsaved',
          saveError: e instanceof Error ? e.message : 'save failed',
        });
      }
    },
    [updateFile, hasTests],
  );

  const scheduleSave = useCallback(
    (relPath: string) => {
      const timers = saveTimers.current;
      const existing = timers.get(relPath);
      if (existing != null) window.clearTimeout(existing);
      timers.set(
        relPath,
        window.setTimeout(() => {
          timers.delete(relPath);
          void saveFile(relPath);
        }, SAVE_DEBOUNCE_MS),
      );
    },
    [saveFile],
  );

  const flushSaves = useCallback((): Promise<void> => {
    const pending: Array<Promise<void>> = [];
    const flushed = new Set<string>();
    const timers = saveTimers.current;
    for (const [relPath, timer] of timers) {
      window.clearTimeout(timer);
      timers.delete(relPath);
      flushed.add(relPath);
      pending.push(saveFile(relPath, { autorun: false }));
    }
    // also catch dirty files whose debounce already fired but save failed
    for (const [relPath, f] of Object.entries(filesRef.current)) {
      if (flushed.has(relPath)) continue;
      if (f.loaded && !f.info.readonly && !f.conflict && f.saveState === 'unsaved') {
        pending.push(saveFile(relPath, { autorun: false }));
      }
    }
    return Promise.all(pending).then(() => undefined);
  }, [saveFile]);
  const flushSavesRef = useRef(flushSaves);
  useEffect(() => {
    flushSavesRef.current = flushSaves;
  }, [flushSaves]);

  useEffect(() => {
    // readonly mode: every file is readonly, so nothing can ever be dirty —
    // skip registering the flush (a keepalive PATCH/PUT here would be inert
    // anyway, but there's also no attempt to end).
    if (readonly) return;
    return () => {
      // leaving the room: push any dirty buffers to disk (cancels the timers)
      void flushSavesRef.current();
    };
  }, [readonly]);

  // Tab close / navigation away: regular fetches may be dropped mid-unload,
  // so push dirty buffers with keepalive requests.
  useEffect(() => {
    if (readonly) return;
    const onPageHide = () => {
      const timers = saveTimers.current;
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      for (const [relPath, f] of Object.entries(filesRef.current)) {
        if (f.loaded && !f.info.readonly && !f.conflict && f.buffer !== f.savedContent) {
          flushFileSave(relPath, f.buffer);
        }
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [readonly]);

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
  }, [attempt]);

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

  const firstEditSent = useRef(false);
  const handleChange = useCallback(
    (relPath: string, value: string) => {
      // Belt-and-suspenders: every file is readonly in this mode so Monaco
      // shouldn't fire onChange at all, but guard against attempt.id anyway.
      if (attempt == null) return;
      updateFile(relPath, (f) => ({
        buffer: value,
        saveState:
          f.saveState === 'saving' ? 'saving' : value === f.savedContent ? 'saved' : 'unsaved',
      }));
      scheduleSave(relPath);
      if (!firstEditSent.current) {
        firstEditSent.current = true;
        // server dedupes first_edit per attempt
        postAttemptEvent(attempt.id, 'first_edit').catch(() => {});
      }
    },
    [attempt, scheduleSave, updateFile],
  );

  // ---- external file changes ---------------------------------------------
  useSseEvent('file-changed', ({ relPath, hash }) => {
    const f = filesRef.current[relPath];
    if (!f || !f.loaded) return;
    if (hash === f.savedHash) return; // echo of our own write
    if (f.buffer === f.savedContent) {
      // clean buffer → silently pick up the disk version
      getFile(relPath)
        .then(({ content, hash: newHash }) => {
          updateFile(relPath, (cur) =>
            cur.buffer === cur.savedContent
              ? {
                  buffer: content,
                  savedContent: content,
                  savedHash: newHash,
                  saveState: 'saved',
                  conflict: false,
                }
              : { conflict: true },
          );
        })
        .catch(() => {});
    } else {
      updateFile(relPath, { conflict: true });
    }
  });

  const resolveConflictReload = useCallback(
    (relPath: string) => {
      getFile(relPath)
        .then(({ content, hash }) => {
          updateFile(relPath, {
            buffer: content,
            savedContent: content,
            savedHash: hash,
            saveState: 'saved',
            conflict: false,
            saveError: null,
          });
        })
        .catch((e: unknown) => {
          updateFile(relPath, {
            saveError: e instanceof Error ? e.message : 'reload failed',
          });
        });
    },
    [updateFile],
  );

  const resolveConflictKeep = useCallback(
    (relPath: string) => {
      const f = filesRef.current[relPath];
      if (!f) return;
      const content = f.buffer;
      updateFile(relPath, { conflict: false, saveState: 'saving', saveError: null });
      putFile(relPath, content)
        .then(({ hash }) => {
          updateFile(relPath, (cur) => ({
            savedContent: content,
            savedHash: hash,
            lastSavedAt: Date.now(),
            saveState: cur.buffer === content ? 'saved' : 'unsaved',
          }));
          if (autorunRef.current && hasTests) startRunRef.current('save');
        })
        .catch((e: unknown) => {
          updateFile(relPath, {
            saveState: 'unsaved',
            saveError: e instanceof Error ? e.message : 'save failed',
          });
        });
    },
    [updateFile, hasTests],
  );

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
  }, []);

  const handleEditorMount: OnMount = useCallback((editor, monacoInstance) => {
    editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter, () => {
      startRunRef.current('manual');
    });
    editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
      flushSavesRef.current();
    });
    editor.focus();
  }, []);

  // ---- reviews (AI panel) -------------------------------------------------
  const [reviews, setReviews] = useState<ReviewRow[] | null>(null);
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [reviewStream, setReviewStream] = useState<ReviewStream | null>(null);
  const [reviewNotice, setReviewNotice] = useState<ReviewNotice | null>(null);
  const [justDoneId, setJustDoneId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getReviews(question.category, question.slug)
      .then((rows) => {
        if (!cancelled) setReviews(rows);
      })
      .catch(() => {
        if (!cancelled) setReviews([]);
      });
    getDisputes(question.category, question.slug)
      .then((rows) => {
        if (!cancelled) setDisputes(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [question.category, question.slug]);

  const requestReview = useCallback(() => {
    setReviewNotice(null);
    void (async () => {
      try {
        // the review reads files from disk — flush dirty buffers first
        await flushSavesRef.current();
        await startReview(question.category, question.slug);
      } catch (e) {
        if (e instanceof ApiError && e.status === 503) {
          setReviewNotice({ kind: 'no-key', message: e.message });
        } else {
          setReviewNotice({
            kind: 'error',
            message: e instanceof Error ? e.message : 'Failed to start the review',
          });
        }
      }
    })();
  }, [question.category, question.slug]);

  const reviewStreamRef = useRef<ReviewStream | null>(null);
  useEffect(() => {
    reviewStreamRef.current = reviewStream;
  }, [reviewStream]);
  const streamStartedAtRef = useRef('');

  useSseEvent('review-started', (p) => {
    if (p.questionId !== questionId) return;
    streamStartedAtRef.current = new Date().toISOString();
    setReviewStream({ jobId: p.jobId, text: '', error: null });
    setReviewNotice(null);
  });

  // SSE reconnected: a review-done may have been missed while offline —
  // reconcile so the panel can't be stuck on "reviewing…" with the result
  // already persisted server-side.
  useSseEvent('hello', () => {
    if (reviewStreamRef.current == null) return;
    getReviews(question.category, question.slug)
      .then((rows) => {
        setReviews(rows);
        const newest = rows[0];
        if (newest != null && newest.at >= streamStartedAtRef.current) {
          setReviewStream(null);
          setJustDoneId(newest.id);
        }
      })
      .catch(() => {});
  });

  useSseEvent('review-chunk', (p) => {
    setReviewStream((cur) =>
      cur != null && cur.jobId === p.jobId ? { ...cur, text: cur.text + p.chunk } : cur,
    );
  });

  useSseEvent('review-done', (p) => {
    if (p.questionId !== questionId) return;
    setReviewStream(null);
    setJustDoneId(p.review.id);
    setReviews((cur) => [p.review, ...(cur ?? []).filter((r) => r.id !== p.review.id)]);
  });

  useSseEvent('review-error', (p) => {
    if (p.questionId !== questionId) return;
    // keep the partial text under the amber banner; nothing was persisted
    setReviewStream((cur) =>
      cur != null && cur.jobId === p.jobId
        ? { ...cur, error: p.message }
        : { jobId: p.jobId, text: '', error: p.message },
    );
  });

  // ---- disputes -----------------------------------------------------------
  const [disputeModal, setDisputeModal] = useState<{ runId: string; testName: string } | null>(
    null,
  );

  useSseEvent('dispute-done', (p) => {
    if (p.questionId !== questionId) return;
    setDisputes((cur) => [p.dispute, ...cur.filter((d) => d.id !== p.dispute.id)]);
  });

  const handleDisputeApplied = useCallback(() => {
    setDisputeModal(null);
    getDisputes(question.category, question.slug).then(setDisputes).catch(() => {});
    // The server's own write is echo-suppressed — no file-changed event will
    // arrive. Reload the test buffers explicitly, then rerun.
    const reloads = editorFiles
      .filter((f) => f.kind === 'test')
      .map((info) =>
        getFile(info.relPath)
          .then(({ content, hash }) => {
            updateFile(info.relPath, {
              buffer: content,
              savedContent: content,
              savedHash: hash,
              saveState: 'saved',
              conflict: false,
              loaded: true,
              loadError: null,
            });
          })
          .catch(() => {}),
      );
    void Promise.all(reloads).then(() => startRunRef.current('manual'));
  }, [question.category, question.slug, editorFiles, updateFile]);

  // ---- fresh attempt ------------------------------------------------------
  // The attempt "Start new attempt" (readonly banner) or "↺ New attempt"
  // (active TopBar) mints attempt N+1 off of: the live attempt when editable,
  // or the ended latestAttempt when this is a readonly reference.
  const refAttempt = attempt ?? latestAttempt;
  const [freshOpen, setFreshOpen] = useState(false);
  const [freshBusy, setFreshBusy] = useState(false);
  const [freshError, setFreshError] = useState<string | null>(null);

  const confirmFresh = useCallback(
    (resetToStub: boolean) => {
      if (refAttempt == null) return;
      setFreshBusy(true);
      setFreshError(null);
      void (async () => {
        try {
          // the snapshot must capture what's on screen, not stale disk state
          // (no-op in readonly mode — nothing can be dirty)
          await flushSavesRef.current();
          await startFreshAttempt(refAttempt.id, resetToStub);
          onReload();
        } catch (e) {
          setFreshBusy(false);
          setFreshError(e instanceof Error ? e.message : 'Failed to start a new attempt');
        }
      })();
    },
    [refAttempt, onReload],
  );

  // ---- timer + layout -----------------------------------------------------
  const timer = useActiveTimer(attempt?.id ?? null, attempt?.activeSeconds ?? 0);
  const [problemOpen, setProblemOpen] = useState(true);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [aiOpen, setAiOpen] = useState(() => localStorage.getItem('ace-ai-open') !== 'false');
  const toggleAi = useCallback((open: boolean) => {
    setAiOpen(open);
    localStorage.setItem('ace-ai-open', open ? 'true' : 'false');
  }, []);

  return (
    <div className="room">
      <TopBar
        question={question}
        seconds={timer.seconds}
        timerActive={timer.active}
        running={running != null}
        readonly={readonly}
        onRun={hasTests && !readonly ? () => startRun('manual') : undefined}
        onFreshAttempt={
          readonly
            ? undefined
            : () => {
                setFreshError(null);
                setFreshOpen(true);
              }
        }
      />
      {readonly && (
        <div className="room-solved-banner">
          <span className="room-solved-banner-text">
            <span className="room-solved-badge">✓ Solved</span> — read-only reference
          </span>
          {latestAttempt != null && (
            <button
              className="btn btn-small btn-accent"
              onClick={() => {
                setFreshError(null);
                setFreshOpen(true);
              }}
            >
              Start new attempt
            </button>
          )}
        </div>
      )}
      {!connected && <div className="sse-strip">reconnecting…</div>}
      <div className="room-body">
        {problemOpen ? (
          <ProblemPane
            readme={detail.readme}
            attemptId={refAttempt?.id ?? ''}
            attemptNumber={refAttempt?.number ?? 0}
            history={history}
            disputes={disputes}
            onCollapse={() => setProblemOpen(false)}
          />
        ) : (
          <button
            className="pane-expander"
            onClick={() => setProblemOpen(true)}
            title="Show problem pane"
          >
            ▸
          </button>
        )}
        <div className="center-col">
          <EditorPane
            order={editorFiles}
            files={files}
            active={activeTab}
            onSelect={setActiveTab}
            onChange={handleChange}
            onMount={handleEditorMount}
            onConflictReload={resolveConflictReload}
            onConflictKeep={resolveConflictKeep}
          />
          {hasTests &&
            (consoleOpen ? (
              <TestConsole
                running={running}
                lastRun={lastRun}
                historyCount={history.length}
                output={output}
                runError={runError}
                autorun={autorun}
                onToggleAutorun={() => setAutorun((v) => !v)}
                onRun={() => startRun('manual')}
                onCollapse={() => setConsoleOpen(false)}
                onDispute={(testName) => {
                  if (lastRun != null) setDisputeModal({ runId: lastRun.runId, testName });
                }}
              />
            ) : (
              <button
                className="console-expander"
                onClick={() => setConsoleOpen(true)}
                title="Show test console"
              >
                Tests ▴
                {lastRun?.summary && (
                  <span className={`mono ${lastRun.summary.failed > 0 ? 'run-fail' : 'run-pass'}`}>
                    {' '}
                    {lastRun.summary.passed}/{lastRun.summary.total}
                  </span>
                )}
              </button>
            ))}
        </div>
        {aiOpen ? (
          <AiPanel
            question={question}
            reviews={reviews}
            stream={reviewStream}
            notice={reviewNotice}
            justDoneId={justDoneId}
            onRequest={readonly ? undefined : requestReview}
            onCollapse={() => toggleAi(false)}
          />
        ) : (
          <button
            className="pane-expander pane-expander-right"
            onClick={() => toggleAi(true)}
            title="Show AI review panel"
          >
            ◂
          </button>
        )}
      </div>
      {disputeModal != null && (
        <DisputeModal
          runId={disputeModal.runId}
          questionId={questionId}
          testName={disputeModal.testName}
          onClose={() => setDisputeModal(null)}
          onApplied={handleDisputeApplied}
        />
      )}
      {freshOpen && refAttempt != null && (
        <FreshAttemptDialog
          nextNumber={refAttempt.number + 1}
          busy={freshBusy}
          error={freshError}
          onConfirm={confirmFresh}
          onCancel={() => {
            if (!freshBusy) setFreshOpen(false);
          }}
        />
      )}
    </div>
  );
}
