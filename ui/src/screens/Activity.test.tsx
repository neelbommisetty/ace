import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Activity, type AiRunWithSteps } from './Activity';
import type { AiRunRow, AiStepRow, AiStepSummary, SseEventMap, SseEventName } from '../types';

// Same seam as GenerationJobStrip.test.tsx: `useSseEvent` registers into a
// module-level handler registry that `emitSse` can drive directly.
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

const { getAiRuns, getAiStep } = vi.hoisted(() => ({
  getAiRuns: vi.fn(),
  getAiStep: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, getAiRuns, getAiStep };
});

function emit<K extends SseEventName>(name: K, payload: SseEventMap[K]) {
  act(() => {
    emitSse(name, payload);
  });
}

const T0 = '2026-07-27T10:00:00.000Z';
const T1 = '2026-07-27T10:00:05.000Z';

function run(overrides: Partial<AiRunRow> = {}): AiRunRow {
  return {
    id: 'r1',
    kind: 'generation',
    refId: 'job-1',
    questionId: null,
    label: 'js-ts · medium · closures',
    status: 'running',
    errorMessage: null,
    startedAt: T0,
    finishedAt: null,
    ...overrides,
  };
}

function stepSummary(overrides: Partial<AiStepSummary> = {}): AiStepSummary {
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
    startedAt: T0,
    finishedAt: null,
    ...overrides,
  };
}

function fullStep(overrides: Partial<AiStepRow> = {}): AiStepRow {
  return {
    ...stepSummary(),
    promptText: 'the masked prompt',
    responseText: 'the persisted response',
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  sseHandlers.clear();
});

describe('Activity', () => {
  it('seeds from getAiRuns on mount and renders a run card with its steps', async () => {
    getAiRuns.mockResolvedValue({
      runs: [{ ...run(), steps: [stepSummary({ status: 'done', detail: 'ok', finishedAt: T1 })] }],
    });
    render(<Activity />);

    expect(await screen.findByText('js-ts · medium · closures')).toBeInTheDocument();
    expect(screen.getByText('write question')).toBeInTheDocument();
    expect(screen.getByTestId('ai-run-card-r1')).toHaveClass('ai-run-card-running');
  });

  it('renders a whole run that started and finished before the seed fetch resolved', async () => {
    let resolveSeed!: (v: { runs: AiRunWithSteps[] }) => void;
    getAiRuns.mockReturnValue(
      new Promise((res) => {
        resolveSeed = res;
      }),
    );
    render(<Activity />);
    await waitFor(() => expect(getAiRuns).toHaveBeenCalled());

    // Mock mode resolves in a microtask: the full lifecycle beats the seed.
    emit('ai-run-started', { run: run() });
    emit('ai-step-started', { runId: 'r1', step: stepSummary() });
    emit('ai-step-done', {
      runId: 'r1',
      stepId: 's1',
      status: 'done',
      detail: '12/12 passed',
      errorMessage: null,
      finishedAt: T1,
    });
    emit('ai-run-done', { runId: 'r1', status: 'done', errorMessage: null, finishedAt: T1 });

    await act(async () => {
      resolveSeed({ runs: [] }); // snapshot predates the run entirely
    });

    expect(screen.getAllByTestId('ai-run-card-r1')).toHaveLength(1);
    expect(screen.getByTestId('ai-run-card-r1')).toHaveClass('ai-run-card-done');
    expect(screen.getByText(/12\/12 passed/)).toBeInTheDocument();
  });

  it('stashes step and run patches for a not-yet-seeded run and applies them on seed', async () => {
    let resolveSeed!: (v: { runs: AiRunWithSteps[] }) => void;
    getAiRuns.mockReturnValue(
      new Promise((res) => {
        resolveSeed = res;
      }),
    );
    render(<Activity />);
    await waitFor(() => expect(getAiRuns).toHaveBeenCalled());

    // The run began before mount, so no 'ai-run-started' arrives — its step
    // and terminal events race ahead of the in-flight seed GET instead.
    emit('ai-step-started', {
      runId: 'r1',
      step: stepSummary({ id: 's2', seq: 2, slug: 'verify', label: 'run tests' }),
    });
    emit('ai-step-done', {
      runId: 'r1',
      stepId: 's2',
      status: 'done',
      detail: '8/8 passed',
      errorMessage: null,
      finishedAt: T1,
    });
    emit('ai-run-done', { runId: 'r1', status: 'done', errorMessage: null, finishedAt: T1 });

    await act(async () => {
      resolveSeed({
        runs: [{ ...run(), steps: [stepSummary({ status: 'done', finishedAt: T1 })] }],
      });
    });

    expect(screen.getByTestId('ai-run-card-r1')).toHaveClass('ai-run-card-done');
    expect(screen.getByText('write question')).toBeInTheDocument();
    expect(screen.getByText('run tests')).toBeInTheDocument();
    expect(screen.getByText(/8\/8 passed/)).toBeInTheDocument();
  });

  it('appends ai-step-chunk text into the expanded step body', async () => {
    getAiRuns.mockResolvedValue({ runs: [{ ...run(), steps: [stepSummary()] }] });
    getAiStep.mockReturnValue(new Promise(() => {})); // lazy fetch still in flight
    render(<Activity />);
    await screen.findByText('write question');

    emit('ai-step-chunk', {
      runId: 'r1',
      stepId: 's1',
      ops: [{ key: 'text', op: 'append', text: 'hello ' }],
    });
    emit('ai-step-chunk', {
      runId: 'r1',
      stepId: 's1',
      ops: [{ key: 'text', op: 'append', text: 'world' }],
    });

    fireEvent.click(screen.getByText('write question'));

    expect(await screen.findByText(/hello world/)).toBeInTheDocument();
  });

  it('renders inert █ withheld █ lines for withheld response keys', async () => {
    getAiRuns.mockResolvedValue({
      runs: [
        {
          ...run(),
          steps: [
            stepSummary({
              status: 'done',
              finishedAt: T1,
              withheldKeys: ['referenceSolution', 'interviewerPacket'],
            }),
          ],
        },
      ],
    });
    getAiStep.mockResolvedValue({
      step: fullStep({ status: 'done', finishedAt: T1, responseText: '{ "title": "Closures" }' }),
    });
    render(<Activity />);
    await screen.findByText('write question');

    fireEvent.click(screen.getByText('write question'));

    const withheld = await screen.findByText('"referenceSolution": █ withheld █');
    expect(withheld).toHaveClass('withheld');
    expect(withheld.tagName).toBe('SPAN'); // no click handler, no reveal affordance
    expect(withheld).toHaveAttribute('title', 'hidden so the question stays solvable');
    expect(screen.getByText('"interviewerPacket": █ withheld █')).toBeInTheDocument();
  });

  it('lazy-fetches the full step exactly once across expand/collapse/expand', async () => {
    getAiRuns.mockResolvedValue({
      runs: [{ ...run(), steps: [stepSummary({ status: 'done', finishedAt: T1 })] }],
    });
    getAiStep.mockResolvedValue({ step: fullStep({ status: 'done', finishedAt: T1 }) });
    render(<Activity />);
    await screen.findByText('write question');

    fireEvent.click(screen.getByText('write question'));
    expect(await screen.findByText('the persisted response')).toBeInTheDocument();

    fireEvent.click(screen.getByText('write question')); // collapse
    fireEvent.click(screen.getByText('write question')); // expand again

    expect(await screen.findByText('the persisted response')).toBeInTheDocument();
    expect(getAiStep).toHaveBeenCalledTimes(1);
    expect(getAiStep).toHaveBeenCalledWith('s1');
  });

  it('refreshes a mid-stream snapshot once the step goes terminal (SSE-gap recovery)', async () => {
    getAiRuns.mockResolvedValue({ runs: [{ ...run(), steps: [stepSummary()] }] });
    // Expanded while streaming: the lazy fetch returns a ≤1s-stale running
    // snapshot whose status would otherwise stay frozen forever.
    getAiStep.mockResolvedValue({ step: fullStep({ status: 'running', responseText: null }) });
    render(<Activity />);
    await screen.findByText('write question');

    emit('ai-step-chunk', {
      runId: 'r1',
      stepId: 's1',
      ops: [{ key: 'text', op: 'append', text: 'pre-gap text' }],
    });
    fireEvent.click(screen.getByText('write question'));
    expect(await screen.findByText('pre-gap text')).toBeInTheDocument();
    expect(getAiStep).toHaveBeenCalledTimes(1);

    // The stream dropped and chunks were lost in the gap; the step then ends.
    // The persisted row (written before ai-step-done) must supersede the
    // incomplete live buffer via a single background re-fetch.
    getAiStep.mockResolvedValue({
      step: fullStep({
        status: 'done',
        finishedAt: T1,
        responseText: 'pre-gap text plus the tail lost in the gap',
      }),
    });
    emit('ai-step-done', {
      runId: 'r1',
      stepId: 's1',
      status: 'done',
      detail: null,
      errorMessage: null,
      finishedAt: T1,
    });

    expect(
      await screen.findByText('pre-gap text plus the tail lost in the gap'),
    ).toBeInTheDocument();
    expect(getAiStep).toHaveBeenCalledTimes(2);
  });

  it('renders a zero-step errored run gracefully (the missing-API-key shape)', async () => {
    getAiRuns.mockResolvedValue({
      runs: [
        {
          ...run({
            status: 'error',
            errorMessage: 'No OpenAI API key configured — add one in Settings.',
            finishedAt: T1,
          }),
          steps: [],
        },
      ],
    });
    render(<Activity />);

    expect(await screen.findByText('js-ts · medium · closures')).toBeInTheDocument();
    expect(screen.getByTestId('ai-run-card-r1')).toHaveClass('ai-run-card-error');
    expect(
      screen.getByText('No OpenAI API key configured — add one in Settings.'),
    ).toBeInTheDocument();
  });

  it('re-fetches the run list on every SSE hello (no replay on the stream)', async () => {
    getAiRuns.mockResolvedValue({ runs: [{ ...run(), steps: [] }] });
    render(<Activity />);
    await screen.findByText('js-ts · medium · closures');

    getAiRuns.mockResolvedValue({
      runs: [{ ...run({ status: 'done', finishedAt: T1 }), steps: [] }],
    });
    emit('hello', { version: '0.2.1', workspaceRoot: '/w', epoch: 'epoch-a' });

    await waitFor(() => expect(getAiRuns).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId('ai-run-card-r1')).toHaveClass('ai-run-card-done'),
    );
  });
});
