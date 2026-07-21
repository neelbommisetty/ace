import { act, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationJobStrip } from './GenerationJobStrip';
import { ApiError } from '../api';
import type { GenerationJobRow, QuestionRow, SseEventMap, SseEventName } from '../types';

// Same seam as App.test.tsx: `useSseEvent` registers into a module-level
// handler registry that `emitSse` can drive directly.
const { sseHandlers, emitSse } = vi.hoisted(() => {
  const sseHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const emitSse = <K extends string>(name: K, payload: unknown) => {
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

const { getGenerationJobs, retryGenerationJob } = vi.hoisted(() => ({
  getGenerationJobs: vi.fn(),
  retryGenerationJob: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, getGenerationJobs, retryGenerationJob };
});

function emit<K extends SseEventName>(name: K, payload: SseEventMap[K]) {
  act(() => {
    emitSse(name, payload);
  });
}

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

function question(overrides: Partial<QuestionRow> = {}): QuestionRow {
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
    ...overrides,
  };
}

function renderStrip() {
  return render(
    <MemoryRouter>
      <GenerationJobStrip />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  sseHandlers.clear();
});

describe('GenerationJobStrip', () => {
  it('seeds from getGenerationJobs on mount and renders a running card', async () => {
    getGenerationJobs.mockResolvedValue({ jobs: [job()] });
    renderStrip();

    await waitFor(() => expect(getGenerationJobs).toHaveBeenCalled());
    expect(await screen.findByText('closures and scope')).toBeInTheDocument();
    expect(screen.getByText(/generating…/)).toBeInTheDocument();
  });

  it('renders nothing when there are no jobs', async () => {
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    const { container } = renderStrip();

    await waitFor(() => expect(getGenerationJobs).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('transitions running -> done and renders an Open room link', async () => {
    getGenerationJobs.mockResolvedValue({ jobs: [job()] });
    renderStrip();
    await screen.findByText('closures and scope');

    emit('generation-done', { jobId: 'job-1', question: question() });

    const link = await screen.findByRole('link', { name: /open room/i });
    expect(link).toHaveAttribute('href', '/q/js-ts/closures-and-scope');
    expect(screen.getByText('Closures and Scope')).toBeInTheDocument();
  });

  it('transitions running -> error and shows a Retry button', async () => {
    getGenerationJobs.mockResolvedValue({ jobs: [job()] });
    renderStrip();
    await screen.findByText('closures and scope');

    emit('generation-error', { jobId: 'job-1', message: 'the model timed out' });

    expect(await screen.findByText('the model timed out')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders a complete card straight from a generation-started payload with no prior seed', async () => {
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    renderStrip();
    await waitFor(() => expect(getGenerationJobs).toHaveBeenCalled());

    emit('generation-started', {
      job: job({ id: 'cross-tab-job', category: 'design-fe', topic: 'a modal dialog' }),
    });

    expect(await screen.findByText('a modal dialog')).toBeInTheDocument();
    expect(screen.getByText(/Design-FE/)).toBeInTheDocument();
  });

  it('upserts in place (no duplicate) when generation-started fires for an already-seeded job', async () => {
    getGenerationJobs.mockResolvedValue({ jobs: [job({ id: 'job-1' })] });
    renderStrip();
    await screen.findByText('closures and scope');

    emit('generation-started', { job: job({ id: 'job-1', topic: 'closures and scope (retry)' }) });

    expect(await screen.findByText('closures and scope (retry)')).toBeInTheDocument();
    expect(screen.getAllByTestId('job-card-job-1')).toHaveLength(1);
  });

  it('calls retryGenerationJob with the job id when Retry is clicked', async () => {
    retryGenerationJob.mockResolvedValue({ jobId: 'job-1' });
    getGenerationJobs.mockResolvedValue({
      jobs: [job({ status: 'error', errorMessage: 'boom' })],
    });
    renderStrip();
    const retryBtn = await screen.findByRole('button', { name: 'Retry' });

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(retryBtn);

    await waitFor(() => expect(retryGenerationJob).toHaveBeenCalledWith('job-1'));
  });

  it('renders the 409 cap message on the card when retry is rejected', async () => {
    retryGenerationJob.mockRejectedValue(
      new ApiError(409, 'three generations are already running — let one finish first'),
    );
    getGenerationJobs.mockResolvedValue({
      jobs: [job({ status: 'error', errorMessage: 'boom' })],
    });
    renderStrip();
    const retryBtn = await screen.findByRole('button', { name: 'Retry' });

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(retryBtn);

    expect(
      await screen.findByText('three generations are already running — let one finish first'),
    ).toBeInTheDocument();
  });

  it('shows the no-new-LLM-call retry copy for a post-llm_done failure (title already set)', async () => {
    getGenerationJobs.mockResolvedValue({
      jobs: [job({ status: 'error', title: 'Closures and Scope', errorMessage: 'disk full' })],
    });
    renderStrip();

    expect(
      await screen.findByRole('button', { name: 'Retry (no new LLM call)' }),
    ).toBeInTheDocument();
  });

  it('shows the plain retry copy for a pre-llm_done failure (no title yet)', async () => {
    getGenerationJobs.mockResolvedValue({
      jobs: [job({ status: 'error', title: null, errorMessage: 'the model timed out' })],
    });
    renderStrip();

    const btn = await screen.findByRole('button', { name: 'Retry' });
    expect(within(btn).queryByText(/no new LLM call/)).toBeNull();
  });
});
