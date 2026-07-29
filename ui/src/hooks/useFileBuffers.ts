import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ApiError, flushFileSave, getFile, postAttemptEvent, putFile } from '../api';
import type { FileState } from '../components/EditorPane';
import { useSseEvent } from '../sse';
import type { AttemptRow, QuestionDetail, QuestionFileInfo, TestRunTrigger } from '../types';
import { useCancellableEffect } from './useCancellableEffect';
import { useLatestRef } from './useLatestRef';

const SAVE_DEBOUNCE_MS = 600;
/** First retry delay after a transient save failure; doubles up to the cap (NEE-358). */
const SAVE_RETRY_BASE_MS = 1000;
const SAVE_RETRY_MAX_MS = 30_000;

/**
 * Buffers parked in localStorage by the unload flush (NEE-358).
 *
 * The pagehide flush is fire-and-forget by necessity — the tab is going away,
 * nothing is left to read the response — so its PUT can be rejected (a 409
 * from the stale-write precondition, because a background server write moved
 * disk in the window before that write's file-changed even reached us) or
 * simply never arrive, and the user's last typing would exist nowhere. The
 * closing tab therefore writes the buffer here FIRST; the next load of the
 * same file compares it against disk and either drops it (the flush landed) or
 * puts the text back in front of the user.
 */
const UNLOAD_STASH_PREFIX = 'ace-unload-buffer:';
/** Bounds abandoned keys (question deleted, workspace gone) rather than growing forever. */
const UNLOAD_STASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface UnloadStash {
  /** Attempt the text was typed under; a different one means the file may have been reset. */
  attemptId: string | null;
  content: string;
  /** Disk hash the buffer was based on — how the restore tells "never landed" from "disk moved". */
  savedHash: string;
  at: number;
}

function stashKey(relPath: string): string {
  return `${UNLOAD_STASH_PREFIX}${relPath}`;
}

/** Best-effort: a full or disabled localStorage must never break the unload path. */
function writeUnloadStash(relPath: string, entry: UnloadStash): void {
  try {
    window.localStorage.setItem(stashKey(relPath), JSON.stringify(entry));
  } catch {
    // quota exceeded / storage disabled — the keepalive PUT is still the primary path
  }
}

/**
 * Drops the stash for `relPath`. Called on every successful write: a pagehide
 * that did NOT end in an unload (bfcache, a hidden-then-restored tab) leaves a
 * stash behind that the still-mounted tab goes on to supersede, and a stale
 * one would otherwise resurface as a bogus conflict in the next tab.
 */
function clearUnloadStash(relPath: string): void {
  try {
    window.localStorage.removeItem(stashKey(relPath));
  } catch {
    // storage disabled — nothing was ever stashed either
  }
}

/** Reads and REMOVES the stash for `relPath`; a single restore attempt is all it gets. */
function takeUnloadStash(relPath: string): UnloadStash | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(stashKey(relPath));
    if (raw != null) window.localStorage.removeItem(stashKey(relPath));
  } catch {
    return null;
  }
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<UnloadStash>;
    if (typeof parsed?.content !== 'string' || typeof parsed?.savedHash !== 'string') return null;
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > UNLOAD_STASH_TTL_MS) return null;
    return {
      attemptId: typeof parsed.attemptId === 'string' ? parsed.attemptId : null,
      content: parsed.content,
      savedHash: parsed.savedHash,
      at: parsed.at,
    };
  } catch {
    return null;
  }
}

/** Reload GETs still outstanding, keyed by relPath (NEE-355). */
type ReloadMap = Map<string, Set<Promise<void>>>;

function isReloading(map: ReloadMap, relPath: string): boolean {
  return (map.get(relPath)?.size ?? 0) > 0;
}

/** Every reload GET still outstanding, across all files. */
function allReloads(map: ReloadMap): Array<Promise<void>> {
  return [...map.values()].flatMap((set) => [...set]);
}

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

  /**
   * Applies a patch against `filesRef` EAGERLY and hands React the finished
   * map, rather than going through a setState updater. The buffer machinery
   * is a set of interlocked async paths (autosave PUTs, reload GETs, SSE
   * file-changed) that each decide what to do by reading `filesRef.current`
   * right after another path wrote to it; with an updater, that read races
   * React's render scheduling and can see pre-patch state. Assigning first
   * makes the ref authoritative the instant the patch is applied — the
   * ordering every one of those interlocks assumes.
   */
  const updateFile = useCallback(
    (relPath: string, patch: Partial<FileState> | ((f: FileState) => Partial<FileState>)) => {
      const cur = filesRef.current[relPath];
      if (!cur) return;
      const p = typeof patch === 'function' ? patch(cur) : patch;
      if (Object.keys(p).length === 0) return; // no-op patch: don't churn a render
      const next = { ...filesRef.current, [relPath]: { ...cur, ...p } };
      filesRef.current = next;
      setFiles(next);
    },
    [filesRef],
  );

  // ---- reload/autosave interlock (NEE-355) --------------------------------
  /**
   * Reload GETs currently in flight, per relPath. A reload is not atomic —
   * it spans the round trip — and both the autosave debounce and a save
   * already in flight can land inside that window, so every path that writes
   * a buffer has to know one is open.
   */
  const reloadsInFlight = useRef<ReloadMap>(new Map());
  /** Saves that bailed because a reload was open; re-issued when it closes. */
  const savesDeferredByReload = useRef(new Set<string>());
  /** Set below, once saveFile exists — the deferred re-issue needs it. */
  const saveFileRef = useRef<(relPath: string, opts?: { autorun?: boolean }) => Promise<void>>(
    () => Promise.resolve(),
  );

  /**
   * Fetches `relPath` from disk and adopts it as the buffer + saved state.
   * With `onlyIfClean`, a buffer that went dirty since the caller looked is
   * left alone and flagged as a conflict instead of being clobbered.
   *
   * Two races made this lossy before NEE-355, and both are closed here:
   *
   *  1. The cleanliness check ran when the GET RESOLVED, not when it was
   *     issued. Reload requested -> keystroke -> the 600ms debounce fires
   *     before the GET returns -> saveFile sees a dirty, unconflicted buffer
   *     and PUTs the STALE text over disk -> the late reload now finds a
   *     clean buffer and adopts the content it just clobbered. Registering
   *     the reload here, before the GET goes out, lets saveFile stand down
   *     for the whole window (it defers, so nothing is dropped) — and it
   *     covers every loadFileInto caller at once rather than one call site.
   *  2. A reload issued while a PUT was in flight applied the GET's PRE-write
   *     body over the just-saved buffer, reverting the text and staling
   *     savedHash. Capturing savedHash/savedContent at ISSUE time and
   *     refusing to apply a result whose basis moved underneath closes that.
   */
  const loadFileInto = useCallback(
    (relPath: string, opts?: { onlyIfClean?: boolean }): Promise<void> => {
      const at = filesRef.current[relPath];
      const issuedHash = at?.savedHash ?? '';
      const issuedSaved = at?.savedContent ?? '';

      const settle = () => {
        const set = reloadsInFlight.current.get(relPath);
        set?.delete(promise);
        if (set != null && set.size === 0) reloadsInFlight.current.delete(relPath);
        if (isReloading(reloadsInFlight.current, relPath)) return;
        if (savesDeferredByReload.current.delete(relPath)) void saveFileRef.current(relPath);
      };

      const promise: Promise<void> = getFile(relPath).then(
        ({ content, hash }) => {
          updateFile(relPath, (cur) => {
            // Race 2: a write landed while this GET was in flight, so its
            // body is pre-write. Applying it would revert disk content on the
            // next keystroke; drop the stale result instead.
            if (cur.savedHash !== issuedHash || cur.savedContent !== issuedSaved) return {};
            return opts?.onlyIfClean && cur.buffer !== cur.savedContent
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
                };
          });
          settle();
        },
        (err: unknown) => {
          settle();
          throw err;
        },
      );

      const set = reloadsInFlight.current.get(relPath) ?? new Set<Promise<void>>();
      set.add(promise);
      reloadsInFlight.current.set(relPath, set);
      return promise;
    },
    [filesRef, updateFile],
  );

  const attemptIdRef = useLatestRef(attempt?.id ?? null);

  /**
   * Puts a buffer parked by a previous tab's unload flush back in front of the
   * user (NEE-358). Runs right after the initial load, so `savedContent` /
   * `savedHash` are what disk holds NOW:
   *
   *  - stash === disk content → the keepalive flush landed; drop it silently.
   *  - stash's basis hash === the current disk hash → disk never moved, so the
   *    flush was lost (rejected, or never sent). Restore it as an ordinary
   *    dirty buffer and save it immediately.
   *  - otherwise → disk moved on since (the 409 case: another tab, or a
   *    server-side append). Both versions matter, so restore the buffer and
   *    raise the conflict banner rather than picking a winner.
   */
  const restoreUnloadStash = useCallback(
    (relPath: string) => {
      const stash = takeUnloadStash(relPath);
      if (stash == null) return;
      const f = filesRef.current[relPath];
      if (!f || !f.loaded || f.info.readonly) return;
      // Typed under a different attempt — a fresh attempt may have reset this
      // file to the stub, and resurrecting the old text there would be wrong.
      const attemptId = attemptIdRef.current;
      if (stash.attemptId != null && attemptId != null && stash.attemptId !== attemptId) return;
      if (stash.content === f.savedContent) return; // the unload flush landed after all
      const conflict = stash.savedHash !== f.savedHash;
      updateFile(relPath, { buffer: stash.content, saveState: 'unsaved', conflict });
      if (!conflict) void saveFileRef.current(relPath);
    },
    [filesRef, updateFile, attemptIdRef],
  );

  useCancellableEffect((cancelled) => {
    for (const info of editorFiles) {
      loadFileInto(info.relPath)
        .then(() => {
          if (!cancelled()) restoreUnloadStash(info.relPath);
        })
        .catch((e: unknown) => {
          if (cancelled()) return;
          updateFile(info.relPath, {
            loadError: e instanceof Error ? e.message : `Failed to load ${info.name}`,
          });
        });
    }
    // editorFiles is stable per mount (RoomInner is keyed by question+attempt)
  }, []);

  // ---- external file changes ----------------------------------------------
  /** relPaths with a PUT currently in flight. */
  const savesInFlight = useRef(new Set<string>());
  /** file-changed events parked until the in-flight PUT for that path settles. */
  const deferredExternal = useRef(new Map<string, string>());

  /**
   * Reacts to a `file-changed` broadcast. Since NEE-359 the server no longer
   * suppresses echoes process-wide (that suppression silenced OTHER tabs too),
   * so this is also where THIS tab's own writes come back — deduped locally by
   * hash, which is per-tab correct by construction.
   */
  const applyExternalChange = useCallback(
    (relPath: string, hash: string) => {
      const f = filesRef.current[relPath];
      if (!f || !f.loaded) return;
      if (savesInFlight.current.has(relPath)) {
        // Our own PUT hasn't returned yet, so `savedHash` isn't authoritative:
        // this is most likely that write's own echo, and if it isn't, the
        // PUT's savedHash precondition will 409 and route us to the conflict
        // banner anyway. Re-run the check once the save settles.
        deferredExternal.current.set(relPath, hash);
        return;
      }
      if (hash === f.savedHash) return; // echo of our own write
      if (f.buffer === f.savedContent) {
        // clean buffer → silently pick up the disk version
        loadFileInto(relPath, { onlyIfClean: true }).catch(() => {});
      } else {
        updateFile(relPath, { conflict: true });
      }
    },
    [filesRef, loadFileInto, updateFile],
  );
  const applyExternalChangeRef = useLatestRef(applyExternalChange);

  /** Ends the in-flight-write window for `relPath` and drains any parked event. */
  const endSaveWindow = useCallback(
    (relPath: string) => {
      savesInFlight.current.delete(relPath);
      const parked = deferredExternal.current.get(relPath);
      if (parked == null) return;
      deferredExternal.current.delete(relPath);
      applyExternalChangeRef.current(relPath, parked);
    },
    [applyExternalChangeRef],
  );

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

  /**
   * (Re)arms the pending-save timer for `relPath`. One timer per file, shared
   * by the 600ms debounce and the failure backoff (NEE-358), so a retry is
   * cancellable/flushable by exactly the machinery that already handles the
   * debounce — and a keystroke during a long backoff just pulls the next
   * attempt forward instead of queueing a second one.
   */
  const armSave = useCallback((relPath: string, delayMs: number) => {
    const timers = saveTimers.current;
    const existing = timers.get(relPath);
    if (existing != null) window.clearTimeout(existing);
    timers.set(
      relPath,
      window.setTimeout(() => {
        timers.delete(relPath);
        void saveFileRef.current(relPath);
      }, delayMs),
    );
  }, []);

  /** Consecutive failed save attempts per file — drives the backoff. */
  const saveAttempts = useRef(new Map<string, number>());

  /**
   * Save failures used to be terminal: `saveError` was recorded, the file
   * dropped to 'unsaved', and nothing ever tried again — kill the server,
   * keep typing, come back later, and everything typed since was gone
   * (NEE-358). Transient failures now back off and retry indefinitely, so the
   * buffer lands the moment the server answers again. A 4xx is NOT transient
   * (a stale-write 409 is a conflict, handled above; 400/401/403 will fail
   * identically forever), so those stay one-shot errors.
   */
  const isTransientSaveFailure = (e: unknown): boolean => {
    if (e instanceof ApiError) return e.status === 0 || e.status >= 500;
    return true; // network-level throw (fetch TypeError, abort) — worth retrying
  };

  /**
   * Tail of the write queue for each file — one PUT per relPath at a time.
   *
   * Without this, two of THIS tab's own saves could be in flight at once: the
   * debounce fires and PUTs on savedHash H0, the user keeps typing, the next
   * debounce fires before that PUT has answered, and a second PUT goes out
   * anchored on the SAME H0 (nothing has updated it yet). The first write
   * moves disk to H1, so the second — carrying the NEWER text — comes back
   * 409 'stale-write' and lands in the conflict banner, which reads as an
   * external editor and whose ordinary "Reload" resolution then discards that
   * newer text. Serializing means the queued attempt re-reads
   * savedHash/savedContent when it actually runs, so it PUTs the newest buffer
   * on the freshest hash, and a self-inflicted conflict is impossible.
   */
  const writeQueue = useRef(new Map<string, Promise<void>>());

  /** Runs `write` after whatever is already queued for `relPath`. */
  const enqueueWrite = useCallback(
    (relPath: string, write: () => Promise<void>): Promise<void> => {
      const prev = writeQueue.current.get(relPath) ?? Promise.resolve();
      // Run regardless of how the previous write settled; it owns its errors.
      const next = prev.then(write, write);
      writeQueue.current.set(relPath, next);
      void next.catch(() => {}).then(() => {
        if (writeQueue.current.get(relPath) === next) writeQueue.current.delete(relPath);
      });
      return next;
    },
    [],
  );

  const runSave = useCallback(
    async (relPath: string, opts?: { autorun?: boolean }) => {
      const f = filesRef.current[relPath];
      if (!f || !f.loaded || f.info.readonly || f.conflict) return;
      // A reload GET is open for this file (NEE-355): what disk holds right
      // now is precisely what we don't know, so writing would be writing over
      // an unread version — the same reason a conflict blocks the save above.
      // Park it rather than drop it; the reload re-issues it when it closes.
      if (isReloading(reloadsInFlight.current, relPath)) {
        savesDeferredByReload.current.add(relPath);
        return;
      }
      if (f.buffer === f.savedContent) return;
      const content = f.buffer;
      updateFile(relPath, { saveState: 'saving', saveError: null });
      savesInFlight.current.add(relPath);
      try {
        const { hash } = await putFile(relPath, content, { savedHash: f.savedHash });
        saveAttempts.current.delete(relPath);
        clearUnloadStash(relPath);
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
        // 409 stale-write (NEE-359): disk moved under us — another tab saved,
        // or the server appended probes/a dispute fix. The buffer is NOT lost;
        // it goes down the same conflict path an external file-changed takes,
        // so the banner can offer reload vs. keep-mine.
        if (e instanceof ApiError && e.status === 409 && e.code === 'stale-write') {
          saveAttempts.current.delete(relPath);
          updateFile(relPath, { saveState: 'unsaved', saveError: null, conflict: true });
          return;
        }
        const message = e instanceof Error ? e.message : 'save failed';
        if (isTransientSaveFailure(e) && mountedRef.current) {
          const attempt = (saveAttempts.current.get(relPath) ?? 0) + 1;
          saveAttempts.current.set(relPath, attempt);
          armSave(relPath, Math.min(SAVE_RETRY_MAX_MS, SAVE_RETRY_BASE_MS * 2 ** (attempt - 1)));
          updateFile(relPath, { saveState: 'unsaved', saveError: message });
          return;
        }
        saveAttempts.current.delete(relPath);
        updateFile(relPath, { saveState: 'unsaved', saveError: message });
      } finally {
        endSaveWindow(relPath);
      }
    },
    [filesRef, updateFile, hasTests, autorunRef, startRunRef, endSaveWindow],
  );

  /**
   * Public entry point: every autosave/flush/retry goes through the per-file
   * queue, and the promise it returns covers the queued attempt (so flushSaves
   * still resolves only once the buffer is actually on disk).
   */
  const saveFile = useCallback(
    (relPath: string, opts?: { autorun?: boolean }): Promise<void> =>
      enqueueWrite(relPath, () => runSave(relPath, opts)),
    [enqueueWrite, runSave],
  );

  saveFileRef.current = (relPath, opts) => saveFile(relPath, opts);

  const scheduleSave = useCallback(
    (relPath: string) => armSave(relPath, SAVE_DEBOUNCE_MS),
    [armSave],
  );

  const flushSaves = useCallback(async (): Promise<void> => {
    // Let any open reload GET land first (NEE-355). A save issued underneath
    // one stands down, so flushing into that window would resolve having
    // written nothing — and flushSaves is exactly what a paid review/probe
    // call awaits before reading the file off disk.
    const open = allReloads(reloadsInFlight.current);
    if (open.length > 0) await Promise.allSettled(open);

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
    await Promise.all(pending);
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

  /**
   * Leave guard (NEE-358). The pagehide flush below is best-effort and, by
   * design, declines to push a CONFLICTED buffer (that would clobber the disk
   * version the conflict is about) — and a save that is mid-backoff hasn't
   * landed either. Both cases end with the user's text existing only in this
   * tab, so closing or navigating away must ask first rather than drop it.
   *
   * beforeunload only: the app mounts a plain BrowserRouter, and react-router
   * v7's useBlocker requires a data router — retrofitting one just for this
   * guard is a bigger change than the guard. In-app navigation out of the
   * Room still runs the unmount flush, so the uncovered case is narrow
   * (leaving the Room in-app while a conflict is unresolved).
   */
  useEffect(() => {
    if (readonly) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const atRisk = Object.values(filesRef.current).some(
        (f) => f.loaded && !f.info.readonly && (f.conflict || f.buffer !== f.savedContent),
      );
      if (!atRisk) return;
      e.preventDefault();
      // Legacy spelling some browsers still require to raise the prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [readonly, filesRef]);

  // Tab close / navigation away: regular fetches may be dropped mid-unload,
  // so push dirty buffers with keepalive requests.
  useEffect(() => {
    if (readonly) return;
    const onPageHide = () => {
      const timers = saveTimers.current;
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      for (const [relPath, f] of Object.entries(filesRef.current)) {
        if (!f.loaded || f.info.readonly) continue;
        if (!f.conflict && f.buffer === f.savedContent) continue;
        // Park the buffer BEFORE flushing it. The flush is fire-and-forget by
        // necessity, so it can be rejected (409 stale-write) or lost with
        // nothing left to notice, and a conflicted buffer is deliberately not
        // flushed at all — in every one of those cases this stash is the only
        // remaining copy of the user's text, and the next load restores it.
        writeUnloadStash(relPath, {
          attemptId: attemptIdRef.current,
          content: f.buffer,
          savedHash: f.savedHash,
          at: Date.now(),
        });
        if (f.conflict) continue;
        // savedHash rides along (NEE-359): there is no client left to show a
        // conflict banner for an unload flush, so it must not be the one
        // write that silently overwrites a newer version on disk.
        flushFileSave(relPath, f.buffer, f.savedHash);
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [readonly, filesRef, attemptIdRef]);

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

  useSseEvent('file-changed', ({ relPath, hash }) => {
    applyExternalChangeRef.current(relPath, hash);
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
      // Through the same per-file queue as autosave: a conflict raised by a
      // reload can land while an autosave PUT is still in flight, and two
      // overlapping PUTs for one file are exactly what turns the stale-write
      // precondition into a self-inflicted 409.
      void enqueueWrite(relPath, () => {
        savesInFlight.current.add(relPath);
        // Deliberately no `savedHash` (NEE-359): "Keep mine" IS the user's
        // explicit decision to overwrite whatever disk holds now, so it must not
        // be rejected by the stale-write precondition it is resolving.
        return putFile(relPath, content)
          .then(({ hash }) => {
            clearUnloadStash(relPath);
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
          })
          .finally(() => endSaveWindow(relPath));
      });
    },
    [filesRef, updateFile, hasTests, autorunRef, startRunRef, endSaveWindow, enqueueWrite],
  );

  /**
   * Files whose edits are currently reachable only from this browser tab
   * (NEE-358) — a failing save that is still retrying, or a conflict nobody
   * has resolved. The 12px "⚠ save failed" strip in the editor footer was the
   * only signal for either, and it only ever showed the ACTIVE tab's file; the
   * Room lifts these to banner level next to the reconnecting strip.
   */
  const unsavedRisk = useMemo(() => {
    const failing: string[] = [];
    const conflicted: string[] = [];
    for (const f of Object.values(files)) {
      if (!f.loaded || f.info.readonly) continue;
      if (f.conflict) conflicted.push(f.info.name);
      else if (f.saveError != null) failing.push(f.info.name);
    }
    if (failing.length === 0 && conflicted.length === 0) return null;
    const firstError = Object.values(files).find((f) => f.saveError != null)?.saveError ?? null;
    return { failing, conflicted, message: firstError };
  }, [files]);

  /** Names of conflicted editable files — what gates a paid review/probe call. */
  const conflictedFileNames = useMemo(
    () => Object.values(files).filter((f) => f.conflict && !f.info.readonly).map((f) => f.info.name),
    [files],
  );

  /** "Retry now" from the banner: skip the remaining backoff on every failing file. */
  const retryFailedSaves = useCallback(() => {
    for (const [relPath, f] of Object.entries(filesRef.current)) {
      if (f.saveError == null || f.info.readonly) continue;
      saveAttempts.current.delete(relPath);
      armSave(relPath, 0);
    }
  }, [filesRef, armSave]);

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
    unsavedRisk,
    conflictedFileNames,
    retryFailedSaves,
  };
}
