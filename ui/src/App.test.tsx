import { act, render, screen } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo } from './types';

// Test seam replacing the real SSE client: `useSseEvent` registers into a
// module-level handler registry that `emitSse` can drive directly, mirroring
// the real hook's mount/unmount lifecycle (via useEffect) so multiple
// mounted components can each subscribe/unsubscribe correctly.
const { sseHandlers, emitSse } = vi.hoisted(() => {
  const sseHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const emitSse = (name: string, payload: unknown) => {
    const set = sseHandlers.get(name);
    if (set) for (const fn of [...set]) fn(payload);
  };
  return { sseHandlers, emitSse };
});

vi.mock('./sse', () => ({
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
  useSseConnected: () => true,
}));

const WORKSPACE_INFO: WorkspaceInfo = {
  root: '/Users/neel/my-prep',
  questionsDir: '/Users/neel/my-prep/questions',
  version: '0.2.1',
  counts: { questions: 0, attempts: 0, testRuns: 0 },
  skippedDirs: [],
  legacyImport: { available: false, questionCount: 0 },
  activeAttempt: null,
};

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    getWorkspace: vi.fn().mockResolvedValue(WORKSPACE_INFO),
    getQuestions: vi.fn().mockResolvedValue([]),
  };
});

/**
 * `api.ts` reads the SSE/auth token from `sessionStorage` at module-eval
 * time, and App.tsx tracks "first hello epoch seen" in a module-level
 * variable — both need a fresh module instance per test. `vi.resetModules`
 * plus a dynamic re-import (after `vi.mock` registrations, which persist
 * across resets) gives each test an isolated App + resetSuppress instance.
 */
async function renderApp() {
  sessionStorage.setItem('ace-token', 'test-token');
  vi.resetModules();
  const [{ App }, resetSuppress] = await Promise.all([
    import('./App'),
    import('./lib/resetSuppress'),
  ]);
  render(<App />);
  await screen.findByText('Library');
  return resetSuppress;
}

let originalLocation: Location | undefined;

function stubLocationReplace() {
  originalLocation = window.location;
  const replaceSpy = vi.fn();
  // @ts-expect-error -- happy-dom allows redefining location for the test
  delete window.location;
  // @ts-expect-error -- stub with a proxy so BrowserRouter's other location
  // reads (href, origin, pathname, ...) keep working via the original.
  window.location = new Proxy(originalLocation, {
    get(target, prop) {
      if (prop === 'replace') return replaceSpy;
      const value = (target as unknown as Record<string, unknown>)[prop as string];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { replaceSpy };
}

afterEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  sseHandlers.clear();
  if (originalLocation != null) {
    window.location = originalLocation;
    originalLocation = undefined;
  }
});

describe('App SSE reset handling', () => {
  it('clears ace-last-room and reloads to / on a workspace-reset broadcast', async () => {
    await renderApp();
    sessionStorage.setItem('ace-last-room', '/q/arrays/two-sum');
    const { replaceSpy } = stubLocationReplace();

    act(() => {
      emitSse('workspace-reset', { mode: 'progress', archivedTo: '/tmp/.ace-archive-2026-07-20' });
    });

    expect(sessionStorage.getItem('ace-last-room')).toBeNull();
    expect(replaceSpy).toHaveBeenCalledWith('/');
  });

  it('suppresses the reload when the initiating tab armed the suppress flag', async () => {
    const { setSuppressNextReset } = await renderApp();
    sessionStorage.setItem('ace-last-room', '/q/arrays/two-sum');
    const { replaceSpy } = stubLocationReplace();

    setSuppressNextReset(true);
    act(() => {
      emitSse('workspace-reset', { mode: 'full', archivedTo: '/tmp/.ace-archive-2026-07-20' });
    });

    expect(sessionStorage.getItem('ace-last-room')).toBe('/q/arrays/two-sum');
    expect(replaceSpy).not.toHaveBeenCalled();

    // The flag is one-shot: a second broadcast (nothing suppressing it) reloads.
    act(() => {
      emitSse('workspace-reset', { mode: 'full', archivedTo: '/tmp/.ace-archive-2026-07-20' });
    });
    expect(replaceSpy).toHaveBeenCalledWith('/');
  });

  it('takes no action on the first hello (records the epoch only)', async () => {
    await renderApp();
    sessionStorage.setItem('ace-last-room', '/q/arrays/two-sum');
    const { replaceSpy } = stubLocationReplace();

    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-a' });
    });

    expect(sessionStorage.getItem('ace-last-room')).toBe('/q/arrays/two-sum');
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('takes no action on a later hello carrying the same epoch', async () => {
    await renderApp();
    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-a' });
    });
    sessionStorage.setItem('ace-last-room', '/q/arrays/two-sum');
    const { replaceSpy } = stubLocationReplace();

    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-a' });
    });

    expect(sessionStorage.getItem('ace-last-room')).toBe('/q/arrays/two-sum');
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('reloads on a later hello carrying a different epoch (missed the one-shot event)', async () => {
    await renderApp();
    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-a' });
    });
    sessionStorage.setItem('ace-last-room', '/q/arrays/two-sum');
    const { replaceSpy } = stubLocationReplace();

    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-b' });
    });

    expect(sessionStorage.getItem('ace-last-room')).toBeNull();
    expect(replaceSpy).toHaveBeenCalledWith('/');
  });

  it('honors the suppress flag on an epoch-mismatch hello too', async () => {
    const { setSuppressNextReset } = await renderApp();
    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-a' });
    });
    sessionStorage.setItem('ace-last-room', '/q/arrays/two-sum');
    const { replaceSpy } = stubLocationReplace();

    setSuppressNextReset(true);
    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-b' });
    });

    expect(sessionStorage.getItem('ace-last-room')).toBe('/q/arrays/two-sum');
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});
