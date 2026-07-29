import { describe, expect, it, vi } from 'vitest';

import {
  clearStaleReloadGuard,
  scheduleGuardClear,
  triggerStaleReload,
  type GuardClearWindow,
  type ReloadGuardStorage,
} from './stale-reload';

function fakeStorage(): ReloadGuardStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe('triggerStaleReload (NEE-330)', () => {
  it('reloads on the first stale-deploy symptom', () => {
    const storage = fakeStorage();
    const reload = vi.fn();

    const reloaded = triggerStaleReload(storage, reload);

    expect(reloaded).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload again while the guard is still set, so a genuinely-missing chunk cannot loop', () => {
    const storage = fakeStorage();
    const reload = vi.fn();

    triggerStaleReload(storage, reload);
    const reloadedAgain = triggerStaleReload(storage, reload);

    expect(reloadedAgain).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('allows one more reload after a successful load clears the guard, so a later rebuild is still recovered from', () => {
    const storage = fakeStorage();
    const reload = vi.fn();

    triggerStaleReload(storage, reload);
    clearStaleReloadGuard(storage);
    const reloadedAfterClear = triggerStaleReload(storage, reload);

    expect(reloadedAfterClear).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

function fakeWindow(readyState: DocumentReadyState): {
  win: GuardClearWindow;
  fireLoad: () => void;
} {
  let loadListener: (() => void) | undefined;
  const win: GuardClearWindow = {
    document: { readyState },
    addEventListener: (_type, listener) => {
      loadListener = listener;
    },
  };
  return {
    win,
    fireLoad: () => loadListener?.(),
  };
}

describe('scheduleGuardClear (NEE-330)', () => {
  it('does not clear the guard synchronously, so a same-tick worker failure right after render still re-sets it', () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    triggerStaleReload(storage, reload);
    const { win } = fakeWindow('complete');
    const scheduleTimeout = vi.fn();

    scheduleGuardClear(storage, win, scheduleTimeout);

    // Guard must still be set immediately after the call returns: a worker
    // constructed during the initial render that fails right away must see
    // the guard still up and refuse to reload a second time.
    expect(triggerStaleReload(storage, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(scheduleTimeout).toHaveBeenCalledWith(expect.any(Function), 3000);
  });

  it('waits for window.load before scheduling the delayed clear when the document is still loading', () => {
    const storage = fakeStorage();
    const { win, fireLoad } = fakeWindow('loading');
    const scheduleTimeout = vi.fn();

    scheduleGuardClear(storage, win, scheduleTimeout);
    expect(scheduleTimeout).not.toHaveBeenCalled();

    fireLoad();
    expect(scheduleTimeout).toHaveBeenCalledTimes(1);
  });

  it('only clears the guard once the scheduled delay actually elapses', () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    triggerStaleReload(storage, reload);
    const { win } = fakeWindow('complete');
    let scheduledCallback: (() => void) | undefined;
    const scheduleTimeout = (cb: () => void) => {
      scheduledCallback = cb;
    };

    scheduleGuardClear(storage, win, scheduleTimeout);
    expect(triggerStaleReload(storage, reload)).toBe(false);

    scheduledCallback?.();

    expect(triggerStaleReload(storage, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
