import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter, Route, Routes, useNavigate, useSearchParams } from 'react-router';
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
    feedback: null,
    sourceQuestionId: null,
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

function renderLibrary(initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Library />
    </MemoryRouter>,
  );
}

/** Renders next to Library in the same route so the two share one location —
 * lets a test read back the URL params Library's filter/search/sort UI writes. */
function LocationProbe() {
  const [params] = useSearchParams();
  return <div data-testid="url-params">{params.toString()}</div>;
}

function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      Go back
    </button>
  );
}

/**
 * Scopes a title lookup to the table row's own Link. Once a question is also
 * suggested by the Practice next card (NEE-310), a bare text query for its
 * title ambiguously matches both the row and the card's <span> — the row's
 * accessible link name stays the one unique anchor (the card's own link text
 * is "Start →", never the title).
 */
function findRoomLink(title: string) {
  return screen.findByRole('link', { name: title });
}
function roomLink(title: string) {
  return screen.getByRole('link', { name: title });
}
function queryRoomLink(title: string) {
  return screen.queryByRole('link', { name: title });
}

/** Mirrors App.tsx's Library ⇄ room routing, with a probe for the current
 * search string and a manual Back trigger to simulate the browser Back
 * button a real room's own '← Library' link (or history swipe) would fire. */
function renderLibraryWithRoomAndProbe(initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route
          path="/"
          element={
            <>
              <Library />
              <LocationProbe />
            </>
          }
        />
        <Route
          path="/q/:category/:slug"
          element={
            <>
              <div>Room for question</div>
              <BackButton />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function settings(overrides: Partial<SettingsInfo> = {}): SettingsInfo {
  return {
    openai: { configured: true, masked: '...abcd', baseUrl: null },
    anthropic: { configured: false, masked: null, baseUrl: null },
    defaultProvider: 'openai',
    mockMode: false,
    models: null,
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

    await findRoomLink('Closures and Scope');
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
    expect(await findRoomLink('Debounce with Cancel and Flush')).toBeInTheDocument();
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
    expect(roomLink('Not Attempted Question')).toBeInTheDocument();

    const select = screen.getByTitle('Filter by status');
    expect(screen.getByRole('option', { name: 'Not attempted' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'In progress' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Solved' })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'solved' } });

    expect(screen.getByText('Solved Question')).toBeInTheDocument();
    expect(queryRoomLink('Not Attempted Question')).toBeNull();
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

    await findRoomLink('Compile Error Question');

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

      await findRoomLink('Closures and Scope');
      expect(screen.queryByText('Archived Question')).toBeNull();

      const select = screen.getByTitle('Filter by status');
      expect(screen.getByRole('option', { name: 'Archived' })).toBeInTheDocument();
      fireEvent.change(select, { target: { value: 'archived' } });

      expect(await screen.findByText('Archived Question')).toBeInTheDocument();
      expect(queryRoomLink('Closures and Scope')).toBeNull();
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

      await findRoomLink('Closures and Scope');
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

  // NEE-310: the Practice next card next to Resume.
  describe('Practice next card (NEE-310)', () => {
    it('shows a suggestion with a one-line reason when an unsolved question exists', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue([
        question({ id: 'q-unsolved', slug: 'unsolved-question', title: 'Unsolved Question' }),
      ]);
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibrary();

      expect(await screen.findByText('Practice next')).toBeInTheDocument();
      // the card's own title span — the table row link carries the same
      // text, so scope this to the non-link element the card renders.
      expect(screen.getByText('Unsolved Question', { selector: 'span.resume-title' })).toBeInTheDocument();
      expect(screen.getByText(/not attempted/, { selector: 'span.resume-detail' })).toBeInTheDocument();
      const startLink = screen.getByRole('link', { name: 'Start →' });
      expect(startLink).toHaveAttribute('href', '/q/js-ts/unsolved-question');
    });

    it('carries the current filter/search/sort query string onto the Start link', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue([
        question({ id: 'q-unsolved', slug: 'unsolved-question', title: 'Unsolved Question' }),
      ]);
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibrary(['/?category=js-ts&difficulty=hard&sort=title&dir=asc']);

      expect(await screen.findByText('Practice next')).toBeInTheDocument();
      const startLink = screen.getByRole('link', { name: 'Start →' });
      expect(startLink).toHaveAttribute(
        'href',
        '/q/js-ts/unsolved-question?category=js-ts&difficulty=hard&sort=title&dir=asc',
      );
    });

    it('hides the card entirely once every question is solved', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue([
        question({
          id: 'q-solved',
          slug: 'solved-question',
          title: 'Solved Question',
          stats: {
            attemptCount: 1,
            lastRun: { passed: 2, total: 2, at: new Date().toISOString(), status: 'done' },
            lastActivityAt: new Date().toISOString(),
            status: 'solved',
            imported: false,
          },
        }),
      ]);
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibrary();

      await screen.findByText('Solved Question');
      expect(screen.queryByText('Practice next')).toBeNull();
    });

    it('hides the card when the library has no questions at all', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue([]);
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibrary();

      await screen.findByText('No questions yet');
      expect(screen.queryByText('Practice next')).toBeNull();
    });
  });

  // NEE-298: search/filter/sort as URL state.
  describe('search, filter, sort, and URL state (NEE-298)', () => {
    function twoQuestions(): QuestionWithStats[] {
      return [
        question({
          id: 'q-1',
          slug: 'closures-and-scope',
          title: 'Closures and Scope',
          difficulty: 'medium',
          createdAt: '2026-01-01T00:00:00.000Z',
          stats: {
            attemptCount: 2,
            lastRun: { passed: 1, total: 2, at: '2026-01-05T00:00:00.000Z', status: 'done' },
            lastActivityAt: '2026-01-05T00:00:00.000Z',
            status: 'in-progress',
            imported: false,
          },
        }),
        question({
          id: 'q-2',
          slug: 'binary-search-basics',
          title: 'Binary Search Basics',
          difficulty: 'hard',
          createdAt: '2026-01-02T00:00:00.000Z',
          stats: {
            attemptCount: 5,
            lastRun: { passed: 3, total: 3, at: '2026-01-10T00:00:00.000Z', status: 'done' },
            lastActivityAt: '2026-01-10T00:00:00.000Z',
            status: 'solved',
            imported: false,
          },
        }),
      ];
    }

    function rowTitlesInOrder(): string[] {
      return screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0].textContent ?? '');
    }

    it('reads category/status/difficulty/search/sort out of the URL on load', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue(twoQuestions());
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibrary(['/?category=js-ts&status=in-progress&difficulty=medium&q=closures&sort=title&dir=asc']);

      await findRoomLink('Closures and Scope');
      expect(screen.queryByText('Binary Search Basics')).toBeNull();
      expect(screen.getByTitle('Filter by status')).toHaveValue('in-progress');
      expect(screen.getByTitle('Filter by difficulty')).toHaveValue('medium');
      expect(screen.getByPlaceholderText('Search titles…')).toHaveValue('closures');
      expect(screen.getByRole('button', { name: 'JS/TS' })).toHaveClass('active');
      expect(screen.getByRole('columnheader', { name: 'Title' })).toHaveAttribute(
        'aria-sort',
        'ascending',
      );
    });

    it('filters by difficulty, updating the URL', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue(twoQuestions());
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibraryWithRoomAndProbe();

      await findRoomLink('Closures and Scope');
      fireEvent.change(screen.getByTitle('Filter by difficulty'), { target: { value: 'hard' } });

      await waitFor(() => expect(queryRoomLink('Closures and Scope')).toBeNull());
      expect(screen.getByText('Binary Search Basics')).toBeInTheDocument();
      expect(screen.getByTestId('url-params').textContent).toContain('difficulty=hard');
    });

    it('narrows the table via debounced title search and clearing restores it', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue(twoQuestions());
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibraryWithRoomAndProbe();

      await findRoomLink('Closures and Scope');
      expect(screen.getByText('Binary Search Basics')).toBeInTheDocument();

      const search = screen.getByPlaceholderText('Search titles…');
      fireEvent.change(search, { target: { value: 'binary' } });

      // Debounced: not applied on the very next tick...
      expect(roomLink('Closures and Scope')).toBeInTheDocument();
      // ...but is applied (and lands in the URL) once the debounce fires.
      await waitFor(() => expect(queryRoomLink('Closures and Scope')).toBeNull());
      expect(screen.getByText('Binary Search Basics')).toBeInTheDocument();
      expect(screen.getByTestId('url-params').textContent).toContain('q=binary');

      fireEvent.change(search, { target: { value: '' } });
      await waitFor(() => expect(roomLink('Closures and Scope')).toBeInTheDocument());
      expect(screen.getByText('Binary Search Basics')).toBeInTheDocument();
      expect(screen.getByTestId('url-params').textContent).not.toContain('q=');
    });

    it('click-to-sorts the Attempts header, toggling direction with a visual + aria-sort indicator', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue(twoQuestions());
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibraryWithRoomAndProbe();

      await findRoomLink('Closures and Scope');
      // Default order: newest-activity-first (unchanged from before NEE-298).
      expect(rowTitlesInOrder()).toEqual(['Binary Search Basics', 'Closures and Scope']);

      const attemptsHeader = screen.getByRole('columnheader', { name: 'Attempts' });
      expect(attemptsHeader).toHaveAttribute('aria-sort', 'none');
      fireEvent.click(within(attemptsHeader).getByRole('button', { name: 'Attempts' }));

      // First click on a numeric column defaults to descending (most first).
      expect(attemptsHeader).toHaveAttribute('aria-sort', 'descending');
      expect(rowTitlesInOrder()).toEqual(['Binary Search Basics', 'Closures and Scope']);
      expect(screen.getByTestId('url-params').textContent).toContain('sort=attempts');
      expect(screen.getByTestId('url-params').textContent).toContain('dir=desc');

      fireEvent.click(within(attemptsHeader).getByRole('button', { name: 'Attempts' }));
      expect(attemptsHeader).toHaveAttribute('aria-sort', 'ascending');
      expect(rowTitlesInOrder()).toEqual(['Closures and Scope', 'Binary Search Basics']);
      expect(screen.getByTestId('url-params').textContent).toContain('dir=asc');
    });

    it('sorts by Title A→Z on first click (text columns default ascending)', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue(twoQuestions());
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibrary();

      await findRoomLink('Closures and Scope');
      fireEvent.click(screen.getByRole('button', { name: 'Title' }));

      expect(rowTitlesInOrder()).toEqual(['Binary Search Basics', 'Closures and Scope']);
    });

    it('shows an active-filter count and a Clear filters affordance that resets category/status/difficulty/search together', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue(twoQuestions());
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibrary(['/?category=js-ts&status=in-progress&difficulty=medium&q=closures']);

      await findRoomLink('Closures and Scope');
      expect(screen.getByText('4 filters')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

      expect(await screen.findByText('Binary Search Basics')).toBeInTheDocument();
      expect(screen.queryByText(/filters$/)).toBeNull();
      expect(screen.getByRole('button', { name: 'All' })).toHaveClass('active');
      expect(screen.getByTitle('Filter by status')).toHaveValue('all');
      expect(screen.getByTitle('Filter by difficulty')).toHaveValue('all');
      expect(screen.getByPlaceholderText('Search titles…')).toHaveValue('');
    });

    it('round-trips the archived status filter through the URL, keeping the Restore action + undo toast working', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue([question({ archivedAt: new Date().toISOString() })]);
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibraryWithRoomAndProbe(['/?status=archived']);

      await screen.findByText('Closures and Scope');
      expect(screen.getByTitle('Filter by status')).toHaveValue('archived');
      expect(screen.getByTestId('url-params').textContent).toContain('status=archived');

      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
      expect(unarchiveQuestion).toHaveBeenCalledWith('js-ts', 'closures-and-scope');
    });

    it('survives navigating into a room and back — filters, search, and sort are all still applied (shareable URL)', async () => {
      getWorkspace.mockResolvedValue(WORKSPACE_INFO);
      getQuestions.mockResolvedValue(twoQuestions());
      getGenerationJobs.mockResolvedValue({ jobs: [] });
      renderLibraryWithRoomAndProbe();

      await findRoomLink('Closures and Scope');
      fireEvent.click(screen.getByRole('button', { name: 'JS/TS' }));
      fireEvent.click(within(screen.getByRole('columnheader', { name: 'Attempts' })).getByRole('button', {
        name: 'Attempts',
      }));

      await waitFor(() =>
        expect(screen.getByTestId('url-params').textContent).toBe('category=js-ts&sort=attempts&dir=desc'),
      );

      const link = screen.getByRole('link', { name: 'Closures and Scope' });
      fireEvent.click(link);
      expect(await screen.findByText('Room for question')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Go back' }));

      await findRoomLink('Closures and Scope');
      expect(screen.getByTestId('url-params').textContent).toBe(
        'category=js-ts&sort=attempts&dir=desc',
      );
      expect(screen.getByRole('button', { name: 'JS/TS' })).toHaveClass('active');
      expect(screen.getByRole('columnheader', { name: 'Attempts' })).toHaveAttribute(
        'aria-sort',
        'descending',
      );
    });
  });
});
