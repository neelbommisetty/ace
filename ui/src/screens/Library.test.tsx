import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWorkspaceSwitchOpener } from '../lib/switchSignal';
import { Library } from './Library';
import type {
  GenerationJobRow,
  QuestionWithStats,
  SettingsInfo,
  SseEventMap,
  SseEventName,
  WorkspaceInfo,
} from '../types';

// Same seam as App.test.tsx / GenerationJobStrip.test.tsx: `useSseEvent`
// registers into a module-level handler registry that `emitSse` can drive
// directly, mirroring the real hook's mount/unmount lifecycle.
const { sseHandlers, emitSse } = vi.hoisted(() => {
  const sseHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const emitSse = (name: string, payload: unknown) => {
    const set = sseHandlers.get(name);
    if (set) for (const fn of [...set]) fn(payload);
  };
  return { sseHandlers, emitSse };
});

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

const {
  getWorkspace,
  getQuestions,
  getGenerationJobs,
  getSettings,
  installStarterPack,
  archiveQuestion,
  unarchiveQuestion,
} = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  getQuestions: vi.fn(),
  getGenerationJobs: vi.fn(),
  getSettings: vi.fn(),
  installStarterPack: vi.fn(),
  archiveQuestion: vi.fn(),
  unarchiveQuestion: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    getWorkspace,
    getQuestions,
    getGenerationJobs,
    getSettings,
    installStarterPack,
    archiveQuestion,
    unarchiveQuestion,
  };
});

function emit<K extends SseEventName>(name: K, payload: SseEventMap[K]) {
  act(() => {
    emitSse(name, payload);
  });
}

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

function job(overrides: Partial<GenerationJobRow> = {}): GenerationJobRow {
  return {
    id: 'job-1',
    status: 'running',
    category: 'js-ts',
    difficulty: 'medium',
    topic: 'closures and scope',
    brainstormSessionId: null,
    title: null,
    slug: null,
    result: null,
    rawText: null,
    errorMessage: null,
    questionId: null,
    createdAt: new Date().toISOString(),
    runStartedAt: new Date().toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

function question(overrides: Partial<QuestionWithStats> = {}): QuestionWithStats {
  return {
    id: 'q-1',
    category: 'js-ts',
    slug: 'closures-and-scope',
    title: 'Closures and Scope',
    difficulty: 'medium',
    suggestedMinutes: 30,
    dirPath: 'questions/js-ts/closures-and-scope',
    source: 'generated',
    createdAt: new Date().toISOString(),
    archivedAt: null,
    missingAt: null,
    stats: {
      attemptCount: 0,
      lastRun: null,
      lastActivityAt: null,
      status: 'not-attempted',
      imported: false,
    },
    ...overrides,
  };
}

function renderLibrary() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Library />
    </MemoryRouter>,
  );
}

function settings(overrides: Partial<SettingsInfo> = {}): SettingsInfo {
  return {
    openai: { configured: true, masked: '...abcd', baseUrl: null },
    anthropic: { configured: false, masked: null, baseUrl: null },
    defaultProvider: 'openai',
    mockMode: false,
    ...overrides,
  };
}

const KEYLESS: SettingsInfo = settings({
  openai: { configured: false, masked: null, baseUrl: null },
  defaultProvider: null,
});

beforeEach(() => {
  getSettings.mockResolvedValue(settings());
  installStarterPack.mockResolvedValue({ installed: [], skipped: [], unavailable: [] });
  archiveQuestion.mockResolvedValue({ question: question({ archivedAt: new Date().toISOString() }) });
  unarchiveQuestion.mockResolvedValue({ question: question() });
});

afterEach(() => {
  vi.clearAllMocks();
  sseHandlers.clear();
});

describe('Library', () => {
  it('does not show a top-bar New question button when questions are present', async () => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([question()]);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    renderLibrary();

    await screen.findByText('Closures and Scope');
    expect(screen.queryByRole('link', { name: 'New question' })).toBeNull();
    // The topbar workspace button shows the basename, keeps the full root
    // in its tooltip, and opens the App-level switch dialog (NEE-164).
    const workspaceButton = screen.getByRole('button', { name: WORKSPACE_INFO.confirmName });
    expect(workspaceButton.getAttribute('title')).toContain(WORKSPACE_INFO.root);
    const opened = vi.fn();
    const unregister = registerWorkspaceSwitchOpener(opened);
    fireEvent.click(workspaceButton);
    expect(opened).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('shows the "Create your first question" empty-state CTA and drops the ace generate reference', async () => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([]);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    renderLibrary();

    await screen.findByText('No questions yet');
    expect(screen.queryByText(/ace generate/)).toBeNull();
    const cta = screen.getByRole('link', { name: 'Create your first question' });
    expect(cta).toHaveAttribute('href', '/new');
  });

  // NEE-301: the first-run dead end. With no provider configured, sending the
  // user to /new sends them to a disabled form, so the primary CTA has to be
  // Settings — and the starter pack has to be reachable either way.
  it('points the primary empty-state CTA at Settings when no provider is configured', async () => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([]);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    getSettings.mockResolvedValue(KEYLESS);
    renderLibrary();

    const cta = await screen.findByRole('link', { name: 'Add an API key' });
    expect(cta).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('link', { name: 'Create your first question' })).toBeNull();
  });

  it('keeps the /new CTA while the provider state is still unknown', async () => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([]);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    getSettings.mockRejectedValue(new Error('offline'));
    renderLibrary();

    await screen.findByText('No questions yet');
    expect(screen.getByRole('link', { name: 'Create your first question' })).toHaveAttribute(
      'href',
      '/new',
    );
  });

  it.each([
    ['configured', settings()],
    ['keyless', KEYLESS],
  ])('offers "Add starter questions" when %s', async (_label, settingsInfo) => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([]);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    getSettings.mockResolvedValue(settingsInfo);
    renderLibrary();

    expect(await screen.findByRole('button', { name: 'Add starter questions' })).toBeInTheDocument();
  });

  it('installs the starter pack and refetches the library', async () => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([]);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    getSettings.mockResolvedValue(KEYLESS);
    installStarterPack.mockResolvedValue({
      installed: ['js-ts/debounce-with-cancel'],
      skipped: [],
      unavailable: [],
    });
    renderLibrary();

    const button = await screen.findByRole('button', { name: 'Add starter questions' });
    getQuestions.mockResolvedValue([question({ title: 'Debounce with Cancel and Flush' })]);
    fireEvent.click(button);

    expect(installStarterPack).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Debounce with Cancel and Flush')).toBeInTheDocument();
  });

  it('explains a no-op install instead of looking broken', async () => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([]);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    installStarterPack.mockResolvedValue({
      installed: [],
      skipped: ['js-ts/debounce-with-cancel'],
      unavailable: [],
    });
    renderLibrary();

    fireEvent.click(await screen.findByRole('button', { name: 'Add starter questions' }));

    expect(
      await screen.findByText('The starter questions are already in this workspace.'),
    ).toBeInTheDocument();
  });

  it('surfaces an install failure', async () => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([]);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    installStarterPack.mockRejectedValue(new Error('no workspace mounted'));
    renderLibrary();

    fireEvent.click(await screen.findByRole('button', { name: 'Add starter questions' }));

    expect(await screen.findByText('no workspace mounted')).toBeInTheDocument();
  });

  it('shows a generating pill seeded from a running job and hides it once done', async () => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([] as QuestionWithStats[]);
    getGenerationJobs.mockResolvedValue({ jobs: [job({ status: 'running' })] });
    renderLibrary();

    expect(await screen.findByText('1 generating…')).toBeInTheDocument();

    emit('generation-done', {
      jobId: 'job-1',
      question: {
        id: 'q-1',
        category: 'js-ts',
        slug: 'closures-and-scope',
        title: 'Closures and Scope',
        difficulty: 'medium',
        suggestedMinutes: 30,
        dirPath: 'questions/js-ts/closures-and-scope',
        source: 'generated',
        createdAt: new Date().toISOString(),
        archivedAt: null,
        missingAt: null,
      },
    });

    await waitFor(() => expect(screen.queryByText('1 generating…')).toBeNull());
  });

  it('increments the pill on a generation-started event with no prior seed', async () => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([]);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    renderLibrary();
    await waitFor(() => expect(getGenerationJobs).toHaveBeenCalled());
    expect(screen.queryByText(/generating…/)).toBeNull();

    emit('generation-started', { job: job({ id: 'job-2' }) });

    expect(await screen.findByText('1 generating…')).toBeInTheDocument();
  });

  it('does not render the pill when there are no active jobs', async () => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([]);
    getGenerationJobs.mockResolvedValue({ jobs: [job({ status: 'done' })] });
    renderLibrary();

    await waitFor(() => expect(getGenerationJobs).toHaveBeenCalled());
    expect(screen.queryByText(/generating…/)).toBeNull();
  });

  it('filters by the user-centric status labels', async () => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([
      question({
        id: 'q-solved',
        slug: 'solved-question',
        title: 'Solved Question',
        stats: {
          attemptCount: 1,
          lastRun: null,
          lastActivityAt: null,
          status: 'solved',
          imported: false,
        },
      }),
      question({
        id: 'q-not-attempted',
        slug: 'not-attempted-question',
        title: 'Not Attempted Question',
        stats: {
          attemptCount: 0,
          lastRun: null,
          lastActivityAt: null,
          status: 'not-attempted',
          imported: false,
        },
      }),
    ] as QuestionWithStats[]);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    renderLibrary();

    await screen.findByText('Solved Question');
    expect(screen.getByText('Not Attempted Question')).toBeInTheDocument();

    const select = screen.getByTitle('Filter by status');
    expect(screen.getByRole('option', { name: 'Not attempted' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'In progress' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Solved' })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'solved' } });

    expect(screen.getByText('Solved Question')).toBeInTheDocument();
    expect(screen.queryByText('Not Attempted Question')).toBeNull();
  });

  it('gives the last-run chip a distinct, non-green style for compile-error and no-tests (NEE-332)', async () => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([
      question({
        id: 'q-compile-error',
        slug: 'compile-error-question',
        title: 'Compile Error Question',
        stats: {
          attemptCount: 1,
          lastRun: { passed: 0, total: 0, at: new Date().toISOString(), status: 'compile-error' },
          lastActivityAt: new Date().toISOString(),
          status: 'in-progress',
          imported: false,
        },
      }),
      question({
        id: 'q-no-tests',
        slug: 'no-tests-question',
        title: 'No Tests Question',
        stats: {
          attemptCount: 1,
          lastRun: { passed: 0, total: 0, at: new Date().toISOString(), status: 'done' },
          lastActivityAt: new Date().toISOString(),
          status: 'in-progress',
          imported: false,
        },
      }),
    ] as QuestionWithStats[]);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    renderLibrary();

    await screen.findByText('Compile Error Question');

    const compileChip = screen.getByText('compile error');
    expect(compileChip.className).toContain('run-fail');
    expect(compileChip.className).not.toContain('run-pass');

    const noTestsChip = screen.getByText('no tests');
    expect(noTestsChip.className).not.toContain('run-pass');
    expect(noTestsChip.className).not.toContain('run-fail');
  });

  // NEE-292: the title cell must be a real, focusable <Link> — Tab reaches
  // it, it carries a real href (cmd/middle-click new tab "for free"), and
  // activating it (Enter and click both fire the same DOM 'click') opens
  // the room.
  it('exposes each question row as a focusable link that opens the room', async () => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([question()]);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/q/:category/:slug" element={<div>Room for question</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const link = await screen.findByRole('link', { name: 'Closures and Scope' });
    expect(link).toHaveAttribute('href', '/q/js-ts/closures-and-scope');

    link.focus();
    expect(link).toHaveFocus();

    fireEvent.click(link);
    expect(await screen.findByText('Room for question')).toBeInTheDocument();
  });

  it('skips the link (and focus) for a row whose question directory is missing on disk', async () => {
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    getQuestions.mockResolvedValue([
      question({ id: 'q-missing', slug: 'missing-question', title: 'Missing Question', missingAt: new Date().toISOString() }),
    ]);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    renderLibrary();

    await screen.findByText('Missing Question');
    expect(screen.queryByRole('link', { name: 'Missing Question' })).toBeNull();
  });

  // NEE-296: archive/unarchive row action + the Archived status filter.
  describe('archive (NEE-296)', () => {
    it('hides archived questions from the default view and offers an Archived filter', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue([
        question(),
        question({
          id: 'q-archived',
          slug: 'archived-question',
          title: 'Archived Question',
          archivedAt: new Date().toISOString(),
        }),
      ]);
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibrary();

      await screen.findByText('Closures and Scope');
      expect(screen.queryByText('Archived Question')).toBeNull();

      const select = screen.getByTitle('Filter by status');
      expect(screen.getByRole('option', { name: 'Archived' })).toBeInTheDocument();
      fireEvent.change(select, { target: { value: 'archived' } });

      expect(await screen.findByText('Archived Question')).toBeInTheDocument();
      expect(screen.queryByText('Closures and Scope')).toBeNull();
    });

    it('archives a row via its own row-action control without navigating the row', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue([question()]);
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Library />} />
            <Route path="/q/:category/:slug" element={<div>Room for question</div>} />
          </Routes>
        </MemoryRouter>,
      );

      await screen.findByText('Closures and Scope');
      const archiveButton = screen.getByRole('button', { name: 'Archive' });
      fireEvent.click(archiveButton);

      expect(archiveQuestion).toHaveBeenCalledWith('js-ts', 'closures-and-scope');
      // Clicking the row action must not also trigger the row's own
      // navigation (NEE-292's Link-based row activation stays intact).
      expect(screen.queryByText('Room for question')).toBeNull();

      // The server broadcasts 'questions-changed' on a real archive; here
      // the mocked route response doesn't, so the refetch is driven the
      // same way the real one would be — via the SSE event.
      getQuestions.mockResolvedValue([]);
      emit('questions-changed', {});

      await waitFor(() => expect(screen.queryByText('Closures and Scope')).toBeNull());
    });

    it('offers Restore on an archived row under the Archived filter', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue([
        question({ archivedAt: new Date().toISOString() }),
      ]);
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibrary();

      // The row is archived, so it's invisible until the filter is applied —
      // wait for the select itself to mount first.
      const select = await screen.findByTitle('Filter by status');
      fireEvent.change(select, { target: { value: 'archived' } });
      const restoreButton = await screen.findByRole('button', { name: 'Restore' });
      fireEvent.click(restoreButton);

      expect(unarchiveQuestion).toHaveBeenCalledWith('js-ts', 'closures-and-scope');
    });

    it('offers the same Archive row action on a "missing" dead row so it can be resolved', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue([
        question({
          id: 'q-missing',
          slug: 'missing-question',
          title: 'Missing Question',
          missingAt: new Date().toISOString(),
        }),
      ]);
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibrary();

      await screen.findByText('Missing Question');
      const archiveButton = screen.getByRole('button', { name: 'Archive' });
      fireEvent.click(archiveButton);

      expect(archiveQuestion).toHaveBeenCalledWith('js-ts', 'missing-question');
    });
  });
});
