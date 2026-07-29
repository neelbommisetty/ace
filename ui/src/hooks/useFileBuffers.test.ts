import { useEffect, useRef } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { useFileBuffers } from './useFileBuffers';
import type { AttemptRow, QuestionDetail, QuestionFileInfo, TestRunTrigger } from '../types';

const { ApiErrorMock, getFile, putFile, flushFileSave, postAttemptEvent, sseHandlers } = vi.hoisted(
  () => {
    class ApiErrorMock extends Error {
      constructor(
        readonly status: number,
        message: string,
        readonly code: string | null = null,
      ) {
        super(message);
        this.name = 'ApiError';
      }
    }
    return {
      ApiErrorMock,
      getFile: vi.fn(),
      putFile: vi.fn(),
      flushFileSave: vi.fn(),
      postAttemptEvent: vi.fn(),
      sseHandlers: new Map<string, Set<(payload: unknown) => void>>(),
    };
  },
);

vi.mock('../api', () => ({
  ApiError: ApiErrorMock,
  getFile,
  putFile,
  flushFileSave,
  postAttemptEvent,
}));

// A real (if tiny) SSE registry: the file-changed handler is the whole
// external-change path, so a no-op stub would leave NEE-359's fix untested.
vi.mock('../sse', () => ({
  useSseEvent: (name: string, handler: (payload: unknown) => void) => {
    const ref = useRef(handler);
    ref.current = handler;
    useEffect(() => {
      let set = sseHandlers.get(name);
      if (!set) {
        set = new Set();
        sseHandlers.set(name, set);
      }
      const fn = (payload: unknown) => ref.current(payload);
      set.add(fn);
      return () => {
        set!.delete(fn);
      };
    }, [name]);
  },
}));

function fireSse(name: string, payload: unknown) {
  act(() => {
    for (const fn of sseHandlers.get(name) ?? []) fn(payload);
  });
}

/** A pending promise plus its resolver — the held-promise race technique. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fileInfo(overrides: Partial<QuestionFileInfo> = {}): QuestionFileInfo {
  return {
    name: 'solution.ts',
    relPath: 'solution.ts',
    kind: 'solution',
    readonly: false,
    ...overrides,
  };
}

function questionDetail(files: QuestionFileInfo[]): QuestionDetail {
  return {
    question: {
      id: 'q-1',
      category: 'js-ts',
      slug: 'closures',
      title: 'Closures',
      difficulty: 'medium',
      suggestedMinutes: 30,
      dirPath: '/tmp/q',
      source: 'generated',
      createdAt: new Date().toISOString(),
      archivedAt: null,
      missingAt: null,
    },
    readme: '',
    files,
    activeAttempt: null,
    lastRun: null,
  };
}

function attemptRow(overrides: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: 'att-1',
    questionId: 'q-1',
    number: 1,
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    activeSeconds: 0,
    hintsUsed: 0,
    imported: false,
    ...overrides,
  };
}

function setup(files: QuestionFileInfo[]) {
  const detail = questionDetail(files);
  const startRunRef = { current: vi.fn<(trigger: TestRunTrigger) => void>() };
  const hook = renderHook(() =>
    useFileBuffers({
      detail,
      readonly: false,
      attempt: attemptRow(),
      autorun: false,
      startRunRef,
    }),
  );
  return hook;
}

const SOLUTION = fileInfo({ relPath: 'solution.ts', readonly: false });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  getFile.mockImplementation((relPath: string) =>
    Promise.resolve({ path: relPath, content: `// ${relPath}`, hash: `hash-${relPath}` }),
  );
  putFile.mockResolvedValue({ hash: 'new-hash' });
  postAttemptEvent.mockResolvedValue({ event: {} });
});

afterEach(() => {
  sseHandlers.clear();
});

describe('useFileBuffers handleChange readonly guard (NEE-334)', () => {
  it('ignores a change targeting a readonly file: buffer, dirty state, and autosave all untouched', async () => {
    const solutionInfo = fileInfo({ relPath: 'solution.ts', readonly: false });
    const testInfo = fileInfo({ name: 'solution.test.ts', relPath: 'solution.test.ts', kind: 'test', readonly: true });
    const { result } = setup([solutionInfo, testInfo]);

    await waitFor(() => {
      expect(result.current.files['solution.test.ts'].loaded).toBe(true);
    });
    const originalBuffer = result.current.files['solution.test.ts'].buffer;

    act(() => {
      result.current.handleChange('solution.test.ts', 'sneaked-in content');
    });

    // buffer/save-state untouched
    expect(result.current.files['solution.test.ts'].buffer).toBe(originalBuffer);
    expect(result.current.files['solution.test.ts'].saveState).toBe('saved');

    // give the 600ms autosave debounce a chance to fire, then confirm no PUT
    await new Promise((r) => setTimeout(r, 700));
    expect(putFile).not.toHaveBeenCalled();
  });

  it('still accepts a change targeting an editable file', async () => {
    const solutionInfo = fileInfo({ relPath: 'solution.ts', readonly: false });
    const testInfo = fileInfo({ name: 'solution.test.ts', relPath: 'solution.test.ts', kind: 'test', readonly: true });
    const { result } = setup([solutionInfo, testInfo]);

    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    act(() => {
      result.current.handleChange('solution.ts', 'export const solution = 42;');
    });

    expect(result.current.files['solution.ts'].buffer).toBe('export const solution = 42;');
    expect(result.current.files['solution.ts'].saveState).toBe('unsaved');

    await waitFor(() => {
      expect(putFile).toHaveBeenCalledWith('solution.ts', 'export const solution = 42;', {
        savedHash: 'hash-solution.ts',
      });
    });
  });
});

// NEE-359: echo suppression for file writes used to be process-global — the
// server withheld file-changed from EVERY subscriber, so a second tab never
// learned about the first tab's save and overwrote it on the next keystroke.
// The broadcast is now unconditional and this tab dedupes its own echo by
// hash; a write it can't account for either follows disk or raises a conflict.
describe('useFileBuffers external file-changed (NEE-359)', () => {
  it('adopts disk content when another tab saved and this buffer is clean', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    getFile.mockResolvedValue({
      path: 'solution.ts',
      content: '// written by tab A',
      hash: 'hash-from-tab-a',
    });
    fireSse('file-changed', { relPath: 'solution.ts', hash: 'hash-from-tab-a' });

    await waitFor(() => {
      expect(result.current.files['solution.ts'].buffer).toBe('// written by tab A');
    });
    expect(result.current.files['solution.ts'].savedHash).toBe('hash-from-tab-a');
    expect(result.current.files['solution.ts'].conflict).toBe(false);
  });

  it('raises a conflict instead of clobbering when this buffer is dirty', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    act(() => {
      result.current.handleChange('solution.ts', 'my unsaved work');
    });
    fireSse('file-changed', { relPath: 'solution.ts', hash: 'hash-from-tab-a' });

    await waitFor(() => {
      expect(result.current.files['solution.ts'].conflict).toBe(true);
    });
    expect(result.current.files['solution.ts'].buffer).toBe('my unsaved work');
  });

  it('ignores the echo of its own write (hash === savedHash), leaving the buffer alone', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });
    getFile.mockClear();

    act(() => {
      result.current.handleChange('solution.ts', 'typed but not yet saved');
    });
    fireSse('file-changed', { relPath: 'solution.ts', hash: 'hash-solution.ts' });

    expect(result.current.files['solution.ts'].conflict).toBe(false);
    expect(result.current.files['solution.ts'].buffer).toBe('typed but not yet saved');
    expect(getFile).not.toHaveBeenCalled();
  });

  it('parks an event that lands mid-PUT and re-checks it once savedHash is authoritative', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    const put = deferred<{ hash: string }>();
    putFile.mockReturnValueOnce(put.promise);
    act(() => {
      result.current.handleChange('solution.ts', 'my edit');
    });
    await waitFor(() => {
      expect(putFile).toHaveBeenCalledTimes(1);
    });

    // The watcher's echo of our OWN write can outrun the PUT response. Acting
    // on it then would flag a bogus conflict, since savedHash is still the
    // pre-write value.
    fireSse('file-changed', { relPath: 'solution.ts', hash: 'echo-hash' });
    expect(result.current.files['solution.ts'].conflict).toBe(false);

    await act(async () => {
      put.resolve({ hash: 'echo-hash' });
      await put.promise;
    });

    // Re-checked against the now-authoritative savedHash: same hash, no-op.
    await waitFor(() => {
      expect(result.current.files['solution.ts'].saveState).toBe('saved');
    });
    expect(result.current.files['solution.ts'].conflict).toBe(false);
  });
});

describe('useFileBuffers stale-write 409 (NEE-359)', () => {
  it('marks the file conflicted and keeps the buffer when the server rejects a stale PUT', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    putFile.mockRejectedValueOnce(
      new ApiErrorMock(409, 'file changed on disk since you last loaded it', 'stale-write'),
    );
    act(() => {
      result.current.handleChange('solution.ts', 'B stale buffer');
    });

    await waitFor(() => {
      expect(result.current.files['solution.ts'].conflict).toBe(true);
    });
    expect(result.current.files['solution.ts'].buffer).toBe('B stale buffer');
    // a conflict is not a save failure — no error strip, the banner owns this
    expect(result.current.files['solution.ts'].saveError).toBeNull();
  });

  it('"Keep mine" re-PUTs WITHOUT savedHash, so the precondition it is resolving cannot reject it', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    act(() => {
      result.current.handleChange('solution.ts', 'my unsaved work');
    });
    fireSse('file-changed', { relPath: 'solution.ts', hash: 'hash-from-tab-a' });
    await waitFor(() => {
      expect(result.current.files['solution.ts'].conflict).toBe(true);
    });
    putFile.mockClear();

    act(() => {
      result.current.resolveConflictKeep('solution.ts');
    });

    await waitFor(() => {
      expect(putFile).toHaveBeenCalledWith('solution.ts', 'my unsaved work');
    });
  });
});

// NEE-355: a reload is not atomic — it spans a GET round trip — and the
// autosave debounce can fire inside that window in either order. Both
// directions are held-promise tests: the GET is kept pending across the event
// that used to lose data.
describe('useFileBuffers reload/autosave interlock (NEE-355)', () => {
  it('direction 1: a debounce firing under an open reload does not PUT the stale buffer', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    // A file-changed on a clean buffer issues a reload; hold its GET open.
    const reload = deferred<{ path: string; content: string; hash: string }>();
    getFile.mockReturnValueOnce(reload.promise);
    fireSse('file-changed', { relPath: 'solution.ts', hash: 'hash-after-server-append' });
    await waitFor(() => {
      expect(getFile).toHaveBeenCalledTimes(2);
    });

    // ...then the user types and the 600ms debounce elapses, all while the
    // reload's GET is still in flight. This is the window that used to PUT
    // the pre-append buffer and then adopt what it had just clobbered.
    act(() => {
      result.current.handleChange('solution.ts', 'typed while the reload was open');
    });
    await new Promise((r) => setTimeout(r, 700));
    expect(putFile).not.toHaveBeenCalled();

    // The reload lands last and finds a dirty buffer: conflict, not clobber.
    await act(async () => {
      reload.resolve({
        path: 'solution.ts',
        content: '// solution.ts\n\n## Follow-ups\n',
        hash: 'hash-after-server-append',
      });
      await reload.promise;
    });

    await waitFor(() => {
      expect(result.current.files['solution.ts'].conflict).toBe(true);
    });
    expect(result.current.files['solution.ts'].buffer).toBe('typed while the reload was open');
    // and the server's append is still what disk holds — nothing overwrote it
    expect(putFile).not.toHaveBeenCalled();
  });

  it('direction 1: the save deferred by the reload is re-issued, not dropped', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    const reload = deferred<{ path: string; content: string; hash: string }>();
    getFile.mockReturnValueOnce(reload.promise);
    fireSse('file-changed', { relPath: 'solution.ts', hash: 'hash-elsewhere' });
    await waitFor(() => {
      expect(getFile).toHaveBeenCalledTimes(2);
    });

    act(() => {
      result.current.handleChange('solution.ts', 'typed while the reload was open');
    });
    await new Promise((r) => setTimeout(r, 700));
    expect(putFile).not.toHaveBeenCalled();

    // The reload fails, so nothing was adopted and the buffer is still the
    // only copy of the user's text — the deferred save has to happen.
    await act(async () => {
      reload.reject(new Error('offline'));
      await reload.promise.catch(() => {});
    });

    await waitFor(() => {
      expect(putFile).toHaveBeenCalledWith('solution.ts', 'typed while the reload was open', {
        savedHash: 'hash-solution.ts',
      });
    });
  });

  it('direction 2: a reload resolving after a PUT does not apply its pre-write body', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    // A save goes out and is held open.
    const put = deferred<{ hash: string }>();
    putFile.mockReturnValueOnce(put.promise);
    act(() => {
      result.current.handleChange('solution.ts', 'my new text');
    });
    await waitFor(() => {
      expect(putFile).toHaveBeenCalledTimes(1);
    });

    // A reload is issued while that PUT is still in flight (what the
    // probes-done / file-changed handlers do), and is also held open.
    const reload = deferred<{ path: string; content: string; hash: string }>();
    getFile.mockReturnValueOnce(reload.promise);
    let reloadDone!: Promise<void>;
    act(() => {
      reloadDone = result.current.loadFileInto('solution.ts', { onlyIfClean: true });
    });

    // The PUT resolves first: the buffer is now "clean" against its own
    // just-saved content, which is exactly what made the late GET look safe
    // to apply.
    await act(async () => {
      put.resolve({ hash: 'hash-after-put' });
      await put.promise;
    });
    expect(result.current.files['solution.ts'].savedHash).toBe('hash-after-put');

    // The GET's body predates the write. Applying it would revert the text
    // and stale savedHash, so the next keystroke would re-save the revert.
    await act(async () => {
      reload.resolve({ path: 'solution.ts', content: '// solution.ts', hash: 'hash-solution.ts' });
      await reloadDone;
    });

    expect(result.current.files['solution.ts'].buffer).toBe('my new text');
    expect(result.current.files['solution.ts'].savedContent).toBe('my new text');
    expect(result.current.files['solution.ts'].savedHash).toBe('hash-after-put');
    expect(result.current.files['solution.ts'].conflict).toBe(false);
  });

  it('flushSaves waits for an open reload instead of resolving having written nothing', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    const reload = deferred<{ path: string; content: string; hash: string }>();
    getFile.mockReturnValueOnce(reload.promise);
    fireSse('file-changed', { relPath: 'solution.ts', hash: 'hash-elsewhere' });
    await waitFor(() => {
      expect(getFile).toHaveBeenCalledTimes(2);
    });

    act(() => {
      result.current.handleChange('solution.ts', 'text a paid call must see');
    });

    let flushed = false;
    let flushDone!: Promise<void>;
    act(() => {
      flushDone = result.current.flushSaves().then(() => {
        flushed = true;
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(flushed).toBe(false);

    await act(async () => {
      reload.reject(new Error('offline'));
      await reload.promise.catch(() => {});
      await flushDone;
    });

    expect(flushed).toBe(true);
    expect(putFile).toHaveBeenCalledWith('solution.ts', 'text a paid call must see', {
      savedHash: 'hash-solution.ts',
    });
  });
});

// NEE-358: a failed save used to be terminal — saveError recorded, file
// dropped to 'unsaved', nothing ever tried again. Kill the server, keep
// typing, come back when it is up: everything typed since was gone.
describe('useFileBuffers save retries (NEE-358)', () => {
  it('retries a transient failure with backoff and lands the buffer once the server answers', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    putFile.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    act(() => {
      result.current.handleChange('solution.ts', 'typed while the server was down');
    });

    await waitFor(() => {
      expect(result.current.files['solution.ts'].saveError).toBe('Failed to fetch');
    });
    expect(result.current.files['solution.ts'].buffer).toBe('typed while the server was down');
    // the room-level surface names the file, not just the 12px footer strip
    expect(result.current.unsavedRisk).toMatchObject({ failing: ['solution.ts'] });

    // The first backoff is 1s; no reload, no keystroke — it just lands.
    await waitFor(
      () => {
        expect(putFile).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );
    await waitFor(() => {
      expect(result.current.files['solution.ts'].saveState).toBe('saved');
    });
    expect(result.current.files['solution.ts'].saveError).toBeNull();
    expect(result.current.unsavedRisk).toBeNull();
  });

  it('does NOT retry a 409 conflict — that is a conflict, not a transient failure', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    putFile.mockRejectedValue(
      new ApiErrorMock(409, 'file changed on disk since you last loaded it', 'stale-write'),
    );
    act(() => {
      result.current.handleChange('solution.ts', 'B stale buffer');
    });

    await waitFor(() => {
      expect(result.current.files['solution.ts'].conflict).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(putFile).toHaveBeenCalledTimes(1);
    // a conflict IS surfaced at room level, just not as a failing save
    expect(result.current.unsavedRisk).toMatchObject({
      failing: [],
      conflicted: ['solution.ts'],
    });
  });

  it('does NOT retry a 4xx that will fail identically forever', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    putFile.mockRejectedValue(new ApiErrorMock(400, 'path and content must be strings'));
    act(() => {
      result.current.handleChange('solution.ts', 'whatever');
    });

    await waitFor(() => {
      expect(result.current.files['solution.ts'].saveError).toBe('path and content must be strings');
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(putFile).toHaveBeenCalledTimes(1);
  });

  it('"Retry now" skips the remaining backoff', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    putFile.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    act(() => {
      result.current.handleChange('solution.ts', 'typed while the server was down');
    });
    await waitFor(() => {
      expect(result.current.files['solution.ts'].saveError).not.toBeNull();
    });

    act(() => {
      result.current.retryFailedSaves();
    });

    await waitFor(() => {
      expect(putFile).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.files['solution.ts'].saveState).toBe('saved');
    });
  });
});

describe('useFileBuffers leave guard (NEE-358)', () => {
  function fireBeforeUnload(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    return event.defaultPrevented;
  }

  it('does not prompt when every buffer is clean', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    expect(fireBeforeUnload()).toBe(false);
  });

  it('prompts while a buffer is dirty', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    act(() => {
      result.current.handleChange('solution.ts', 'not saved yet');
    });

    expect(fireBeforeUnload()).toBe(true);
  });

  it('prompts while a buffer is conflicted — the case the pagehide flush deliberately skips', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    act(() => {
      result.current.handleChange('solution.ts', 'my unsaved work');
    });
    fireSse('file-changed', { relPath: 'solution.ts', hash: 'hash-from-tab-a' });
    await waitFor(() => {
      expect(result.current.files['solution.ts'].conflict).toBe(true);
    });

    expect(fireBeforeUnload()).toBe(true);
    // and the flush must NOT push the conflicted buffer over disk
    expect(flushFileSave).not.toHaveBeenCalled();
  });
});

// A second save for the same file starting while the first is still in flight
// would PUT the NEWER text anchored on the SAME (now stale) savedHash, so the
// server rejected it 409 — a conflict this tab inflicted on itself, whose
// "Reload" resolution then discards exactly that newer text.
describe('useFileBuffers overlapping same-tab saves (NEE-359)', () => {
  it('queues the second save behind the first instead of racing two PUTs on one stale hash', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    // Save #1 goes out on hash-solution.ts and is held open (a slow round trip:
    // the PUT writes the file, saves a blob and inserts a snapshot row).
    const put1 = deferred<{ hash: string }>();
    putFile.mockReturnValueOnce(put1.promise);
    act(() => {
      result.current.handleChange('solution.ts', 'C1');
    });
    await waitFor(() => {
      expect(putFile).toHaveBeenCalledTimes(1);
    });

    // The user keeps typing and the next debounce elapses while #1 is still
    // open. No second PUT may go out yet — it could only carry the same stale
    // savedHash.
    act(() => {
      result.current.handleChange('solution.ts', 'C2');
    });
    await new Promise((r) => setTimeout(r, 700));
    expect(putFile).toHaveBeenCalledTimes(1);

    await act(async () => {
      put1.resolve({ hash: 'hash-after-c1' });
      await put1.promise;
    });

    // Now it runs, re-reading the basis the first save established: the newest
    // buffer on the freshest hash, so the server has no reason to 409.
    await waitFor(() => {
      expect(putFile).toHaveBeenCalledTimes(2);
    });
    expect(putFile).toHaveBeenLastCalledWith('solution.ts', 'C2', { savedHash: 'hash-after-c1' });
    await waitFor(() => {
      expect(result.current.files['solution.ts'].saveState).toBe('saved');
    });
    expect(result.current.files['solution.ts'].conflict).toBe(false);
    expect(result.current.files['solution.ts'].buffer).toBe('C2');
  });
});

// The pagehide flush is fire-and-forget: nothing reads its response, so a 409
// (or a dropped request) took the closing tab's last edits with it — even
// though the leave guard had just prompted about them.
describe('useFileBuffers unload stash (NEE-358)', () => {
  const KEY = 'ace-unload-buffer:solution.ts';

  function seedStash(entry: Record<string, unknown>) {
    window.localStorage.setItem(KEY, JSON.stringify(entry));
  }

  function firePageHide() {
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
  }

  it('parks the dirty buffer in localStorage before the fire-and-forget flush', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    act(() => {
      result.current.handleChange('solution.ts', 'my last keystrokes');
    });
    firePageHide();

    expect(flushFileSave).toHaveBeenCalledWith('solution.ts', 'my last keystrokes', 'hash-solution.ts');
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toMatchObject({
      attemptId: 'att-1',
      content: 'my last keystrokes',
      savedHash: 'hash-solution.ts',
    });
  });

  it('parks a CONFLICTED buffer too — the one the flush deliberately never sends', async () => {
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    act(() => {
      result.current.handleChange('solution.ts', 'my unsaved work');
    });
    fireSse('file-changed', { relPath: 'solution.ts', hash: 'hash-from-tab-a' });
    await waitFor(() => {
      expect(result.current.files['solution.ts'].conflict).toBe(true);
    });

    firePageHide();

    expect(flushFileSave).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toMatchObject({
      content: 'my unsaved work',
    });
  });

  it('restores a stash whose flush never landed and saves it, with no bogus conflict', async () => {
    // disk is untouched (same hash the stash was based on) → the PUT was lost
    seedStash({
      attemptId: 'att-1',
      content: 'the text the 409 swallowed',
      savedHash: 'hash-solution.ts',
      at: Date.now(),
    });

    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].buffer).toBe('the text the 409 swallowed');
    });
    expect(result.current.files['solution.ts'].conflict).toBe(false);
    await waitFor(() => {
      expect(putFile).toHaveBeenCalledWith('solution.ts', 'the text the 409 swallowed', {
        savedHash: 'hash-solution.ts',
      });
    });
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('restores it as a conflict when disk moved on since — both versions survive', async () => {
    seedStash({
      attemptId: 'att-1',
      content: 'the text the 409 swallowed',
      savedHash: 'hash-before-the-server-append',
      at: Date.now(),
    });

    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].conflict).toBe(true);
    });
    // the buffer is the closing tab's text; disk's newer version is the
    // savedContent the banner's "Reload" would adopt
    expect(result.current.files['solution.ts'].buffer).toBe('the text the 409 swallowed');
    expect(result.current.files['solution.ts'].savedContent).toBe('// solution.ts');
    expect(putFile).not.toHaveBeenCalled();
  });

  it('drops a stash the flush actually landed, and one from another attempt', async () => {
    seedStash({
      attemptId: 'att-1',
      content: '// solution.ts',
      savedHash: 'hash-before',
      at: Date.now(),
    });
    const first = setup([SOLUTION]);
    await waitFor(() => {
      expect(first.result.current.files['solution.ts'].loaded).toBe(true);
    });
    expect(first.result.current.files['solution.ts'].saveState).toBe('saved');
    expect(first.result.current.files['solution.ts'].conflict).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    first.unmount();

    // A fresh attempt may have reset the file to its stub; text typed under the
    // old attempt must not be resurrected on top of that.
    seedStash({
      attemptId: 'att-999',
      content: 'from a previous attempt',
      savedHash: 'hash-solution.ts',
      at: Date.now(),
    });
    const { result } = setup([SOLUTION]);
    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });
    expect(result.current.files['solution.ts'].buffer).toBe('// solution.ts');
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});

describe('useFileBuffers hasTests derivation', () => {
  it('derives hasTests: false from a file set with no kind "test" entries (design/behavioral)', async () => {
    const storyInfo = fileInfo({
      name: 'story.md',
      relPath: 'story.md',
      kind: 'notes',
      readonly: false,
    });
    const { result } = setup([storyInfo]);

    await waitFor(() => {
      expect(result.current.files['story.md'].loaded).toBe(true);
    });

    expect(result.current.hasTests).toBe(false);
  });
});
