import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Library } from './Library';
import type { GenerationJobRow, QuestionWithStats, SseEventMap, SseEventName, WorkspaceInfo } from '../types';

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

const { getWorkspace, getQuestions, getGenerationJobs } = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  getQuestions: vi.fn(),
  getGenerationJobs: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, getWorkspace, getQuestions, getGenerationJobs };
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
    expect(screen.getByText(WORKSPACE_INFO.root)).toBeInTheDocument();
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
});
