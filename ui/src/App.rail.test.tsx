import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo } from './types';

vi.mock('./sse', () => ({
  useSseEvent: () => {},
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
  window.history.pushState({}, '', '/');
});

async function renderApp(expectMainText = 'Library') {
  sessionStorage.setItem('ace-token', 'test-token');
  const { App } = await import('./App');
  render(<App />);
  await screen.findByText(expectMainText);
}

describe('IconRail top-group order', () => {
  it('has a New question link to /new and a History link to /history', async () => {
    await renderApp();

    const newQuestionLink = screen.getByTitle('New question');
    expect(newQuestionLink).toHaveAttribute('href', '/new');

    const historyLink = screen.getByTitle('History');
    expect(historyLink).toHaveAttribute('href', '/history');
  });

  it('orders Library, New question, History, then Settings and the Stats placeholder', async () => {
    await renderApp();

    const libraryLink = screen.getByTitle('Library');
    const newQuestionLink = screen.getByTitle('New question');
    const historyLink = screen.getByTitle('History');
    const settingsLink = screen.getByTitle('Settings');
    const statsPlaceholder = screen.getByTitle('Stats — coming in M3');

    // DOCUMENT_POSITION_FOLLOWING (4) means the argument node comes after `this` node.
    expect(libraryLink.compareDocumentPosition(newQuestionLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(newQuestionLink.compareDocumentPosition(historyLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(historyLink.compareDocumentPosition(settingsLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(historyLink.compareDocumentPosition(statsPlaceholder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('places New question and History before the rail spacer (top group)', async () => {
    await renderApp();

    const newQuestionLink = screen.getByTitle('New question');
    const historyLink = screen.getByTitle('History');
    const spacer = document.querySelector('.rail-spacer');
    expect(spacer).not.toBeNull();

    expect(newQuestionLink.compareDocumentPosition(spacer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(historyLink.compareDocumentPosition(spacer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
