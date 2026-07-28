import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationJobStrip } from './GenerationJobStrip';
import { ApiError } from '../api';
import type {
  AiRunRow,
  AiStepSummary,
  GenerationJobRow,
  QuestionRow,
  SseEventMap,
  SseEventName,
} from '../types';

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

const { getGenerationJobs, retryGenerationJob, getAiRuns } = vi.hoisted(() => ({
  getGenerationJobs: vi.fn(),
  retryGenerationJob: vi.fn(),
  getAiRuns: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, getGenerationJobs, retryGenerationJob, getAiRuns };
});

function emit<K extends SseEventName>(name: K, payload: SseEventMap[K]) {
  act(() => {
    emitSse(name, payload);
  });
}

function job(overrides: Partial<GenerationJobRow> = {}): GenerationJobRow {
  const createdAt = new Date().toISOString();
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
    createdAt,
    runStartedAt: createdAt,
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

function aiRun(overrides: Partial<AiRunRow> = {}): AiRunRow {
  return {
    id: 'r1',
    kind: 'generation',
    refId: 'job-1',
    questionId: null,
    label: 'closures and scope',
    status: 'running',
    errorMessage: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

function aiStep(overrides: Partial<AiStepSummary> = {}): AiStepSummary {
  return {
    id: 's1',
    runId: 'r1',
    seq: 1,
    kind: 'llm',
    slug: 'generate',
    label: 'write question',
    status: 'running',
    attempt: 1,
    promptWithheld: false,
    withheldKeys: null,
    detail: null,
    errorMessage: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
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

  describe('retry elapsed clock (NEE-277)', () => {
    // A job that first ran 100 minutes ago: anchored to createdAt the clock
    // would read 1:40:0x, anchored to a fresh runStartedAt it reads 00:0x.
    const LONG_AGO = () => new Date(Date.now() - 100 * 60 * 1000).toISOString();

    it('restarts the clock at 0:00 when the retried row arrives with a fresh runStartedAt', async () => {
      const createdAt = LONG_AGO();
      getGenerationJobs.mockResolvedValue({
        jobs: [job({ status: 'error', errorMessage: 'boom', createdAt, runStartedAt: createdAt })],
      });
      renderStrip();
      await screen.findByRole('button', { name: 'Retry' });

      // The server re-emits 'generation-started' with the SAME row, re-stamped.
      emit('generation-started', {
        job: job({ status: 'running', createdAt, runStartedAt: new Date().toISOString() }),
      });

      expect(await screen.findByText(/00:0\d/)).toBeInTheDocument();
      expect(screen.queryByText(/1:40:/)).toBeNull();
    });

    it('survives a reload mid-retry: the seed fetch row anchors the clock to runStartedAt', async () => {
      // Reload after a retry: the server row still has the original createdAt
      // but a runStartedAt from the retry ~1 minute ago.
      getGenerationJobs.mockResolvedValue({
        jobs: [
          job({
            createdAt: LONG_AGO(),
            runStartedAt: new Date(Date.now() - 60 * 1000).toISOString(),
          }),
        ],
      });
      renderStrip();

      expect(await screen.findByText(/01:0\d/)).toBeInTheDocument();
      expect(screen.queryByText(/1:40:/)).toBeNull();
    });

    it('falls back to createdAt when runStartedAt is absent (server predates the field)', async () => {
      getGenerationJobs.mockResolvedValue({
        jobs: [job({ createdAt: LONG_AGO(), runStartedAt: null })],
      });
      renderStrip();

      expect(await screen.findByText(/1:40:0\d/)).toBeInTheDocument();
    });
  });

  describe('step-log drawer (NEE-272)', () => {
    it('fetches the refId-filtered run list on first expand only', async () => {
      getGenerationJobs.mockResolvedValue({ jobs: [job()] });
      getAiRuns.mockResolvedValue({ runs: [{ ...aiRun(), steps: [aiStep()] }] });
      renderStrip();
      await screen.findByText('closures and scope');
      expect(getAiRuns).not.toHaveBeenCalled(); // lazy: nothing until first open

      fireEvent.click(screen.getByRole('button', { name: 'Show step log' }));
      expect(await screen.findByText('write question')).toBeInTheDocument();
      expect(getAiRuns).toHaveBeenCalledTimes(1);
      expect(getAiRuns).toHaveBeenCalledWith({ refId: 'job-1', limit: 5 });

      // Collapse hides the still-mounted drawer; re-expand must NOT refetch.
      fireEvent.click(screen.getByRole('button', { name: 'Hide step log' }));
      expect(screen.getByTestId('job-drawer-job-1')).not.toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Show step log' }));

      expect(screen.getByTestId('job-drawer-job-1')).toBeVisible();
      expect(screen.getByText('write question')).toBeInTheDocument();
      expect(getAiRuns).toHaveBeenCalledTimes(1);
    });

    it('stays live on SSE while open: a retry run with the same refId lists newest first', async () => {
      getGenerationJobs.mockResolvedValue({
        jobs: [job({ status: 'error', errorMessage: 'boom' })],
      });
      getAiRuns.mockResolvedValue({
        runs: [
          {
            ...aiRun({ status: 'error', errorMessage: 'boom', finishedAt: new Date().toISOString() }),
            steps: [aiStep({ status: 'error', errorMessage: 'boom' })],
          },
        ],
      });
      renderStrip();
      fireEvent.click(await screen.findByRole('button', { name: 'Show step log' }));
      await screen.findByTestId('ai-run-card-r1');

      // retry() mints a NEW ai_runs row with the same refId…
      emit('ai-run-started', { run: aiRun({ id: 'r2' }) });
      emit('ai-step-started', {
        runId: 'r2',
        refId: 'job-1',
        step: aiStep({ id: 's2', runId: 'r2', kind: 'scaffold', slug: 'scaffold', label: 'scaffold files' }),
      });
      // …while runs for other jobs never enter this drawer.
      emit('ai-run-started', { run: aiRun({ id: 'r9', refId: 'job-other' }) });

      const cards = screen.getAllByTestId(/^ai-run-card-/);
      expect(cards.map((c) => c.getAttribute('data-testid'))).toEqual([
        'ai-run-card-r2',
        'ai-run-card-r1',
      ]);
      expect(screen.getByText('scaffold files')).toBeInTheDocument();
    });

    it('drops other jobs\' step-level events but still applies raced patches for its own run', async () => {
      // Seed GET held in flight: our own run's terminal events race ahead of
      // it (the mock-mode microtask shape) while another job streams too.
      let resolveSeed!: (v: { runs: unknown[] }) => void;
      getGenerationJobs.mockResolvedValue({ jobs: [job()] });
      getAiRuns.mockReturnValue(
        new Promise((res) => {
          resolveSeed = res;
        }),
      );
      renderStrip();
      fireEvent.click(await screen.findByRole('button', { name: 'Show step log' }));
      await waitFor(() => expect(getAiRuns).toHaveBeenCalled());

      const T1 = new Date().toISOString();
      // Own run r1: step + run go terminal before the seed resolves.
      emit('ai-step-done', {
        runId: 'r1',
        refId: 'job-1',
        stepId: 's1',
        status: 'done',
        detail: '9/9 passed',
        errorMessage: null,
        finishedAt: T1,
      });
      emit('ai-run-done', {
        runId: 'r1',
        refId: 'job-1',
        status: 'done',
        errorMessage: null,
        finishedAt: T1,
      });
      // Another job's full lifecycle rides the same shared SSE stream; none
      // of it may enter (or stick to) this refId-filtered drawer.
      emit('ai-run-started', { run: aiRun({ id: 'r9', refId: 'job-other' }) });
      emit('ai-step-started', {
        runId: 'r9',
        refId: 'job-other',
        step: aiStep({ id: 's9', runId: 'r9', label: 'foreign step' }),
      });
      emit('ai-step-chunk', {
        runId: 'r9',
        refId: 'job-other',
        stepId: 's9',
        ops: [{ key: 'text', op: 'append', text: 'foreign text' }],
      });
      emit('ai-step-done', {
        runId: 'r9',
        refId: 'job-other',
        stepId: 's9',
        status: 'done',
        detail: null,
        errorMessage: null,
        finishedAt: T1,
      });
      emit('ai-run-done', {
        runId: 'r9',
        refId: 'job-other',
        status: 'done',
        errorMessage: null,
        finishedAt: T1,
      });

      await act(async () => {
        resolveSeed({ runs: [{ ...aiRun(), steps: [aiStep()] }] });
      });

      // The raced own-run patches applied on seed; the foreign run never landed.
      expect(screen.getByTestId('ai-run-card-r1')).toHaveClass('ai-run-card-done');
      expect(screen.getByText(/9\/9 passed/)).toBeInTheDocument();
      expect(screen.queryByTestId('ai-run-card-r9')).toBeNull();
      expect(screen.queryByText('foreign step')).toBeNull();
    });

    it('shows the pre-activity-logging message for a job with no runs', async () => {
      getGenerationJobs.mockResolvedValue({ jobs: [job({ status: 'done', title: 'Closures', slug: 'closures' })] });
      getAiRuns.mockResolvedValue({ runs: [] });
      renderStrip();

      fireEvent.click(await screen.findByRole('button', { name: 'Show step log' }));

      expect(
        await screen.findByText('No step log for this job (it ran before activity logging).'),
      ).toBeInTheDocument();
    });
  });
});
