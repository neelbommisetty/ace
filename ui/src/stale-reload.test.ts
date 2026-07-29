import { describe, expect, it, vi } from 'vitest';

import {
  clearStaleReloadGuard,
  triggerStaleReload,
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
