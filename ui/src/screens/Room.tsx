import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import { useLocation, useParams } from 'react-router-dom';
import {
  ApiError,
  createOrResumeAttempt,
  flushFileSave,
  getFile,
  getQuestionDetail,
  getTestRuns,
  postAttemptEvent,
  putFile,
  startTestRun,
} from '../api';
import { EditorPane, type FileState } from '../components/EditorPane';
import { ProblemPane } from '../components/ProblemPane';
import { TestConsole, type RunDisplay } from '../components/TestConsole';
import { TopBar } from '../components/TopBar';
import { useActiveTimer } from '../hooks/useActiveTimer';
import { useSseConnected, useSseEvent } from '../sse';
import type {
  AttemptRow,
  QuestionDetail,
  TestRunRow,
  TestRunTrigger,
} from '../types';
import { NotFound } from './NotFound';

const SAVE_DEBOUNCE_MS = 600;
const OUTPUT_MAX_LINES = 2000;
const HISTORY_LIMIT = 50;

export function Room() {
  const { category = '', slug = '' } = useParams();
  const location = useLocation();
  const [loaded, setLoaded] = useState<{ detail: QuestionDetail; attempt: AttemptRow } | null>(
    null,
  );
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sessionStorage.setItem('ace-last-room', location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setNotFound(false);
    setError(null);
    (async () => {
      try {
        const detail = await getQuestionDetail(category, slug);
        const { attempt } = await createOrResumeAttempt(category, slug);
        if (!cancelled) setLoaded({ detail, attempt });
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
  }, [category, slug]);

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
      key={`${loaded.detail.question.id}:${loaded.attempt.id}`}
      detail={loaded.detail}
      attempt={loaded.attempt}
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

function RoomInner({ detail, attempt }: { detail: QuestionDetail; attempt: AttemptRow }) {
  const question = detail.question;
  const questionId = question.id;
  const connected = useSseConnected();

  const editorFiles = useMemo(() => detail.files.filter((f) => f.kind !== 'readme'), [detail.files]);
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
      if (!hasTests) return;
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
    [attempt.id, hasTests],
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
    return () => {
      // leaving the room: push any dirty buffers to disk (cancels the timers)
      void flushSavesRef.current();
    };
  }, []);

  // Tab close / navigation away: regular fetches may be dropped mid-unload,
  // so push dirty buffers with keepalive requests.
  useEffect(() => {
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
  }, []);

  const firstEditSent = useRef(false);
  const handleChange = useCallback(
    (relPath: string, value: string) => {
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
    [attempt.id, scheduleSave, updateFile],
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

  // ---- timer + layout -----------------------------------------------------
  const timer = useActiveTimer(attempt.id, attempt.activeSeconds);
  const [problemOpen, setProblemOpen] = useState(true);
  const [consoleOpen, setConsoleOpen] = useState(true);

  return (
    <div className="room">
      <TopBar
        question={question}
        seconds={timer.seconds}
        timerActive={timer.active}
        running={running != null}
        onRun={hasTests ? () => startRun('manual') : undefined}
      />
      {!connected && <div className="sse-strip">reconnecting…</div>}
      <div className="room-body">
        {problemOpen ? (
          <ProblemPane
            readme={detail.readme}
            attemptId={attempt.id}
            attemptNumber={attempt.number}
            history={history}
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
      </div>
    </div>
  );
}
