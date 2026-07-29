import { act, render, screen } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo } from './types';

// Same registry seam as App.test.tsx: the routed app only renders after the
// first SSE hello (NEE-164), so the mock must let renderApp emit one.
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
  };
});

vi.mock('./screens/NewQuestion', () => ({
  NewQuestion: () => <div>New Question Stub</div>,
}));

afterEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  sseHandlers.clear();
  window.history.pushState({}, '', '/');
});

async function renderApp(expectMainText = 'Library') {
  localStorage.setItem('ace-token', 'test-token');
  const { App } = await import('./App');
  render(<App />);
  act(() => {
    emitSse('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-a' });
  });
  await screen.findByText(expectMainText);
}

describe('IconRail top-group order', () => {
  it('has a New question link to /new and a History link to /history', async () => {
    await renderApp();

    const newQuestionLink = screen.getByTitle('New question');
    expect(newQuestionLink).toHaveAttribute('href', '/new');

    const historyLink = screen.getByTitle('History');
    expect(historyLink).toHaveAttribute('href', '/history');

    const activityLink = screen.getByTitle('Activity');
    expect(activityLink).toHaveAttribute('href', '/activity');
  });

  it('orders Library, New question, History, Activity, then Settings (no dead Stats placeholder, NEE-309)', async () => {
    await renderApp();

    const libraryLink = screen.getByTitle('Library');
    const newQuestionLink = screen.getByTitle('New question');
    const historyLink = screen.getByTitle('History');
    const activityLink = screen.getByTitle('Activity');
    const settingsLink = screen.getByTitle('Settings');

    // DOCUMENT_POSITION_FOLLOWING (4) means the argument node comes after `this` node.
    expect(libraryLink.compareDocumentPosition(newQuestionLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(newQuestionLink.compareDocumentPosition(historyLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(historyLink.compareDocumentPosition(activityLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activityLink.compareDocumentPosition(settingsLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTitle('Stats — coming in M3')).toBeNull();
  });

  it('places New question, History and Activity before the rail spacer (top group)', async () => {
    await renderApp();

    const newQuestionLink = screen.getByTitle('New question');
    const historyLink = screen.getByTitle('History');
    const activityLink = screen.getByTitle('Activity');
    const spacer = document.querySelector('.rail-spacer');
    expect(spacer).not.toBeNull();

    expect(newQuestionLink.compareDocumentPosition(spacer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(historyLink.compareDocumentPosition(spacer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activityLink.compareDocumentPosition(spacer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('marks New question active (and Library inactive) when on /new', async () => {
    window.history.pushState({}, '', '/new');
    await renderApp('New Question Stub');

    const newQuestionLink = screen.getByTitle('New question');
    const libraryLink = screen.getByTitle('Library');

    expect(newQuestionLink).toHaveClass('active');
    expect(libraryLink).not.toHaveClass('active');
  });
});
