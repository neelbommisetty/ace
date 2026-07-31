import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegenerateModal } from './RegenerateModal';
import { ApiError } from '../api';
import type { QuestionRow } from '../types';

const { regenerateQuestion } = vi.hoisted(() => ({ regenerateQuestion: vi.fn() }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, regenerateQuestion };
});

afterEach(() => {
  vi.clearAllMocks();
});

function question(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: 'q-1',
    category: 'js-ts',
    slug: 'two-sum',
    title: 'Two Sum',
    difficulty: 'easy',
    suggestedMinutes: 20,
    dirPath: 'questions/js-ts/two-sum',
    source: 'generated',
    createdAt: new Date().toISOString(),
    archivedAt: null,
    missingAt: null,
    ...overrides,
  };
}

function renderModal(onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <RegenerateModal question={question()} onClose={onClose} />
    </MemoryRouter>,
  );
  return onClose;
}

describe('RegenerateModal', () => {
  it('disables Regenerate while the feedback textarea is empty or whitespace-only', () => {
    renderModal();
    const submit = screen.getByRole('button', { name: 'Regenerate' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: '   ' } });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'too easy' } });
    expect(submit).not.toBeDisabled();
  });

  it('submits the trimmed feedback for this question exactly once', async () => {
    regenerateQuestion.mockResolvedValue({ jobId: 'job-1' });
    renderModal();

    fireEvent.change(screen.getByLabelText('Feedback'), {
      target: { value: '  too easy — needs an O(n) constraint  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

    await screen.findByText(/Go to Library/i);
    expect(regenerateQuestion).toHaveBeenCalledTimes(1);
    expect(regenerateQuestion).toHaveBeenCalledWith(
      'js-ts',
      'two-sum',
      'too easy — needs an O(n) constraint',
    );
  });

  it('flips to the started confirmation state on success, with the textarea gone', async () => {
    regenerateQuestion.mockResolvedValue({ jobId: 'job-1' });
    renderModal();

    fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'too easy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(await screen.findByRole('link', { name: /Go to Library/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Feedback')).not.toBeInTheDocument();
  });

  it('shows the ApiError message and keeps the form editable on failure', async () => {
    regenerateQuestion.mockRejectedValue(
      new ApiError(409, 'three generations are already running — wait for one to finish'),
    );
    renderModal();

    fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'too easy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(
      await screen.findByText('three generations are already running — wait for one to finish'),
    ).toBeInTheDocument();
    const textarea = screen.getByLabelText('Feedback') as HTMLTextAreaElement;
    expect(textarea).not.toBeDisabled();
    expect(textarea.value).toBe('too easy');
    expect(screen.getByRole('button', { name: 'Regenerate' })).not.toBeDisabled();
  });
});
