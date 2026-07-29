import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { flushFileSave, getFile, postAttemptEvent, putFile } from '../api';
import type { FileState } from '../components/EditorPane';
import { useSseEvent } from '../sse';
import type { AttemptRow, QuestionDetail, QuestionFileInfo, TestRunTrigger } from '../types';
import { useCancellableEffect } from './useCancellableEffect';
import { useLatestRef } from './useLatestRef';

const SAVE_DEBOUNCE_MS = 600;

function initialFileState(info: QuestionFileInfo): FileState {
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

/**
 * The Room's file-buffer slice: the per-file buffer/save-state map, initial
 * loads, the 600ms autosave debounce, flush-on-leave (SPA navigation and
 * pagehide), external-change conflict handling, and the active editor tab.
 */
export function useFileBuffers({
  detail,
  readonly,
  attempt,
  autorun,
  startRunRef,
}: {
  detail: QuestionDetail;
  readonly: boolean;
  attempt: AttemptRow | null;
  autorun: boolean;
  /** Filled by the caller once useTestRuns mints startRun (render-order cycle). */
  startRunRef: RefObject<(trigger: TestRunTrigger) => void>;
}) {
  const editorFiles = useMemo(
    () =>
      detail.files
        .filter((f) => f.kind !== 'readme')
        .map((f) => (readonly ? { ...f, readonly: true } : f)),
    [detail.files, readonly],
  );
  const hasTests = useMemo(() => editorFiles.some((f) => f.kind === 'test'), [editorFiles]);

  const [files, setFiles] = useState<Record<string, FileState>>(() =>
    Object.fromEntries(editorFiles.map((f) => [f.relPath, initialFileState(f)])),
  );
  const filesRef = useLatestRef(files);

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
    [filesRef],
  );

  /**
   * Fetches `relPath` from disk and adopts it as the buffer + saved state.
   * With `onlyIfClean`, a buffer that went dirty since the caller looked is
   * left alone and flagged as a conflict instead of being clobbered.
   */
  const loadFileInto = useCallback(
    (relPath: string, opts?: { onlyIfClean?: boolean }) =>
      getFile(relPath).then(({ content, hash }) => {
        updateFile(relPath, (cur) =>
          opts?.onlyIfClean && cur.buffer !== cur.savedContent
            ? { conflict: true }
            : {
                buffer: content,
                savedContent: content,
                savedHash: hash,
                saveState: 'saved',
                conflict: false,
                loaded: true,
                loadError: null,
                saveError: null,
              },
        );
      }),
    [updateFile],
  );

  useCancellableEffect((cancelled) => {
    for (const info of editorFiles) {
      loadFileInto(info.relPath).catch((e: unknown) => {
        if (cancelled()) return;
        updateFile(info.relPath, {
          loadError: e instanceof Error ? e.message : `Failed to load ${info.name}`,
        });
      });
    }
    // editorFiles is stable per mount (RoomInner is keyed by question+attempt)
  }, []);

  // ---- autosave -----------------------------------------------------------
  const autorunRef = useLatestRef(autorun);
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
    [filesRef, updateFile, hasTests, autorunRef, startRunRef],
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
  }, [saveFile, filesRef]);
  const flushSavesRef = useLatestRef(flushSaves);

  useEffect(() => {
    // readonly mode: every file is readonly, so nothing can ever be dirty —
    // skip registering the flush (a keepalive PATCH/PUT here would be inert
    // anyway, but there's also no attempt to end).
    if (readonly) return;
    return () => {
      // leaving the room: push any dirty buffers to disk (cancels the timers)
      void flushSavesRef.current();
    };
  }, [readonly, flushSavesRef]);

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
  }, [readonly, filesRef]);

  const firstEditSent = useRef(false);
  const handleChange = useCallback(
    (relPath: string, value: string) => {
      // Belt-and-suspenders: every file is readonly in this mode so Monaco
      // shouldn't fire onChange at all, but guard against attempt.id anyway.
      if (attempt == null) return;
      // Defense in depth (NEE-334): EditorPane resolves relPath from the
      // emitting model's own URI and already drops readonly targets, but
      // refuse them here too so a misattributed or otherwise-stray change
      // can never mark a readonly file's buffer dirty or schedule a save.
      if (filesRef.current[relPath]?.info.readonly) return;
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
      loadFileInto(relPath, { onlyIfClean: true }).catch(() => {});
    } else {
      updateFile(relPath, { conflict: true });
    }
  });

  const resolveConflictReload = useCallback(
    (relPath: string) => {
      loadFileInto(relPath).catch((e: unknown) => {
        updateFile(relPath, {
          saveError: e instanceof Error ? e.message : 'reload failed',
        });
      });
    },
    [loadFileInto, updateFile],
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
    [filesRef, updateFile, hasTests, autorunRef, startRunRef],
  );

  return {
    editorFiles,
    hasTests,
    files,
    activeTab,
    setActiveTab,
    loadFileInto,
    flushSaves,
    handleChange,
    resolveConflictReload,
    resolveConflictKeep,
  };
}
