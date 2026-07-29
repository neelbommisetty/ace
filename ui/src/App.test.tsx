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
  confirmName: 'my-prep',
};

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    getWorkspace: vi.fn().mockResolvedValue(WORKSPACE_INFO),
    getQuestions: vi.fn().mockResolvedValue([]),
    getGenerationJobs: vi.fn().mockResolvedValue({ jobs: [] }),
    getWorkspaceRecents: vi.fn().mockResolvedValue({ recents: [] }),
  };
});

/**
 * `api.ts` reads the SSE/auth token from `localStorage` at module-eval
 * time (NEE-308), and App.tsx tracks "first hello epoch seen" in a
 * module-level variable — both need a fresh module instance per test.
 * `vi.resetModules` plus a dynamic re-import (after `vi.mock` registrations,
 * which persist across resets) gives each test an isolated App +
 * resetSuppress instance.
 *
 * The routed app only renders once the first hello has been seen (NEE-164),
 * so the helper emits one by default; pass `null` to keep the app in its
 * pre-hello connecting state and drive the hello from the test itself.
 */
async function renderApp(
  firstHello: { workspaceRoot: string | null; epoch: string | null } | null = {
    workspaceRoot: '/w',
    epoch: 'epoch-a',
  },
) {
  localStorage.setItem('ace-token', 'test-token');
  vi.resetModules();
  const [{ App }, resetSuppress] = await Promise.all([
    import('./App'),
    import('./lib/resetSuppress'),
  ]);
  render(<App />);
  if (firstHello != null) {
    act(() => {
      emitSse('hello', { version: '0.2.1', ...firstHello });
    });
    if (firstHello.workspaceRoot != null) await screen.findByText('Library');
  }
  return resetSuppress;
}

let originalLocation: Location | undefined;

function stubLocationReplace() {
  originalLocation = window.location;
  const replaceSpy = vi.fn();
  const reloadSpy = vi.fn();
  // @ts-expect-error -- happy-dom allows redefining location for the test
  delete window.location;
  // @ts-expect-error -- stub with a proxy so BrowserRouter's other location
  // reads (href, origin, pathname, ...) keep working via the original.
  window.location = new Proxy(originalLocation, {
    get(target, prop) {
      if (prop === 'replace') return replaceSpy;
      if (prop === 'reload') return reloadSpy;
      const value = (target as unknown as Record<string, unknown>)[prop as string];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { replaceSpy, reloadSpy };
}

afterEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  sseHandlers.clear();
  if (originalLocation != null) {
    // @ts-expect-error -- restoring the real Location object stubbed above
    window.location = originalLocation;
    originalLocation = undefined;
  }
});

describe('App SSE reset handling', () => {
  it('reloads to / on a workspace-reset broadcast', async () => {
    await renderApp();
    const { replaceSpy } = stubLocationReplace();

    act(() => {
      emitSse('workspace-reset', {
        mode: 'progress',
        archivedTo: '/tmp/.ace-archive-2026-07-20',
        requestId: 'req-1',
      });
    });

    expect(replaceSpy).toHaveBeenCalledWith('/');
  });

  it('suppresses the reload when the broadcast requestId matches what this tab armed', async () => {
    const { armSuppressNextReset } = await renderApp();
    const { replaceSpy } = stubLocationReplace();

    armSuppressNextReset('req-1');
    act(() => {
      emitSse('workspace-reset', {
        mode: 'full',
        archivedTo: '/tmp/.ace-archive-2026-07-20',
        requestId: 'req-1',
      });
    });

    expect(replaceSpy).not.toHaveBeenCalled();

    // The armed id is one-shot: a second broadcast (nothing matching it anymore) reloads.
    act(() => {
      emitSse('workspace-reset', {
        mode: 'full',
        archivedTo: '/tmp/.ace-archive-2026-07-20',
        requestId: 'req-2',
      });
    });
    expect(replaceSpy).toHaveBeenCalledWith('/');
  });

  it('does NOT suppress the reload when the broadcast requestId belongs to a different tab', async () => {
    // Regression coverage for the race where tab A arms suppression for its
    // own in-flight request, but a DIFFERENT tab's reset broadcast lands on
    // A's SSE connection first (e.g. A's own request is about to 409
    // because another tab's reset was already in progress). A must still
    // reload — it must not silently swallow a real reset it didn't cause.
    const { armSuppressNextReset } = await renderApp();
    const { replaceSpy } = stubLocationReplace();

    armSuppressNextReset('req-mine');
    act(() => {
      emitSse('workspace-reset', {
        mode: 'full',
        archivedTo: '/tmp/.ace-archive-2026-07-20',
        requestId: 'req-someone-elses',
      });
    });

    expect(replaceSpy).toHaveBeenCalledWith('/');
  });

  it('takes no action on the first hello beyond mounting the routed app', async () => {
    await renderApp(null);
    const { replaceSpy, reloadSpy } = stubLocationReplace();

    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-a' });
    });

    expect(await screen.findByText('Library')).toBeInTheDocument();
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('takes no action on a later hello carrying the same epoch', async () => {
    await renderApp();
    const { replaceSpy } = stubLocationReplace();

    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-a' });
    });

    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('reloads on a later hello carrying a different epoch (missed the one-shot event)', async () => {
    await renderApp();
    const { replaceSpy } = stubLocationReplace();

    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-b' });
    });

    expect(replaceSpy).toHaveBeenCalledWith('/');
  });

  it('honors an armed suppression on an epoch-mismatch hello too', async () => {
    const { armSuppressNextReset } = await renderApp();
    const { replaceSpy } = stubLocationReplace();

    armSuppressNextReset('req-1');
    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-b' });
    });

    expect(replaceSpy).not.toHaveBeenCalled();
  });
});

describe('App workspace switching (NEE-164)', () => {
  it('hard-reloads on a workspace-switched broadcast carrying a different root', async () => {
    await renderApp();
    const { replaceSpy, reloadSpy } = stubLocationReplace();

    act(() => {
      emitSse('workspace-switched', {
        workspaceRoot: '/other',
        epoch: 'epoch-b',
        requestId: 'req-1',
      });
    });

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('ignores a workspace-switched broadcast for the root this tab already shows', async () => {
    await renderApp();
    const { reloadSpy } = stubLocationReplace();

    act(() => {
      emitSse('workspace-switched', {
        workspaceRoot: '/w',
        epoch: 'epoch-a',
        requestId: 'req-1',
      });
    });

    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('hard-reloads on a later hello carrying a different workspaceRoot (missed the one-shot event)', async () => {
    await renderApp();
    const { replaceSpy, reloadSpy } = stubLocationReplace();

    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: '/other', epoch: 'epoch-b' });
    });

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    // The root change wins over the epoch change — no Library replace.
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('shows the connecting placeholder — never the routed app — until the first hello arrives', async () => {
    await renderApp(null);

    // Pre-hello: neither Library (whose fetches would 409 on a picker boot)
    // nor the picker — an honest neutral state.
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByText('Library')).toBeNull();
    expect(screen.queryByText('Pick a workspace')).toBeNull();

    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-a' });
    });
    expect(await screen.findByText('Library')).toBeInTheDocument();
  });

  it('renders the workspace picker instead of the routed app when hello carries a null root', async () => {
    await renderApp(null);

    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: null, epoch: null });
    });

    expect(await screen.findByText('Pick a workspace')).toBeInTheDocument();
    expect(screen.queryByText('Library')).toBeNull();
  });
});

describe('IconRail Room icon removal', () => {
  it('renders no Room icon, even when a stale ace-last-room key is present', async () => {
    sessionStorage.setItem('ace-last-room', '/q/arrays/two-sum');
    await renderApp();

    expect(screen.queryByTitle('Room')).toBeNull();
    expect(screen.queryByTitle('Room — open a question from the library')).toBeNull();
    expect(document.querySelector('a[href="/q/arrays/two-sum"]')).toBeNull();
  });
});
