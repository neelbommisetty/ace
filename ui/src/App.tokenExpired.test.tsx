import { act, render, screen } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Deliberately does NOT mock './api' (unlike App.test.tsx / App.rail.test.tsx)
// — this file exercises the real request()/unauthorizedHandler wiring against
// a stubbed `fetch` that always 401s, to cover the "Token expired" screen's
// exact-relaunch-URL text (NEE-308) end to end.

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

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
  sseHandlers.clear();
  window.history.pushState({}, '', '/');
});

describe('Token expired screen (NEE-308)', () => {
  it('shows the exact relaunch URL built from the last-known token once a real request 401s', async () => {
    localStorage.setItem('ace-token', 'stale-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)),
    );

    const { App } = await import('./App');
    render(<App />);
    act(() => {
      emitSse('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-a' });
    });

    expect(await screen.findByText('Token expired')).toBeInTheDocument();
    const expectedUrl = `${window.location.origin}/?t=stale-token`;
    expect(screen.getByText(expectedUrl)).toBeInTheDocument();
  });
});
