import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AiStepList } from './AiStepList';
import type { AiStepSummary } from '../types';

function step(overrides: Partial<AiStepSummary> = {}): AiStepSummary {
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
    startedAt: '2026-07-27T10:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

describe('AiStepList', () => {
  it('renders the right glyph for each step status', () => {
    render(
      <AiStepList
        steps={[
          step({ id: 'a', seq: 1, status: 'done', label: 'write question' }),
          step({ id: 'b', seq: 2, status: 'error', label: 'run tests' }),
          step({ id: 'c', seq: 3, status: 'skipped', label: 'fix tests' }),
          step({ id: 'd', seq: 4, status: 'running', label: 'scaffold files' }),
        ]}
        liveText={new Map()}
      />,
    );

    expect(screen.getByText('✓')).toBeInTheDocument();
    expect(screen.getByText('✕')).toBeInTheDocument();
    expect(screen.getByText('○')).toBeInTheDocument();
    expect(screen.getByText('●')).toBeInTheDocument();
  });

  it('shows a skipped step reason from its detail', () => {
    render(
      <AiStepList
        steps={[
          step({
            status: 'skipped',
            detail: 'tests already green — nothing to repair',
            finishedAt: '2026-07-27T10:00:01.000Z',
          }),
        ]}
        liveText={new Map()}
      />,
    );

    expect(screen.getByText(/tests already green — nothing to repair/)).toBeInTheDocument();
  });

  it('renders one stepper segment per known-so-far step (no percentage bar)', () => {
    const { container } = render(
      <AiStepList
        steps={[
          step({ id: 'a', seq: 1, status: 'done' }),
          step({ id: 'b', seq: 2, status: 'running' }),
        ]}
        liveText={new Map()}
      />,
    );

    expect(container.querySelectorAll('.ai-stepper-seg')).toHaveLength(2);
    expect(container.querySelector('.ai-stepper-running .pulse-dot')).not.toBeNull();
  });

  it('renders nothing for a zero-step run', () => {
    const { container } = render(<AiStepList steps={[]} liveText={new Map()} />);
    expect(container.firstChild).toBeNull();
  });
});
