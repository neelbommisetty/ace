import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { History } from './History';
import type { DisputeRow, HistoryItem, QuestionRow, ReviewRow } from '../types';

const { getHistory, getReviews, getReview, getFile } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getReviews: vi.fn(),
  getReview: vi.fn(),
  getFile: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    getHistory,
    getReviews,
    getReview,
    getFile,
  };
});

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

function reviewItem(overrides: Partial<ReviewRow> = {}): HistoryItem {
  return {
    type: 'review',
    at: new Date().toISOString(),
    question: question(),
    review: {
      id: 'rev-1',
      questionId: 'q-1',
      attemptId: null,
      version: 1,
      at: new Date().toISOString(),
      model: null,
      verdict: 'Hire',
      score: null,
      dimensions: null,
      bodyMd: '## Ways to improve\n\n- Extract the helper\n- Add a test',
      snapshotHash: null,
      source: 'user',
      ...overrides,
    },
  };
}

function disputeItem(overrides: Partial<DisputeRow> = {}): HistoryItem {
  return {
    type: 'dispute',
    at: new Date().toISOString(),
    question: question({ id: 'q-2', slug: 'debounce', title: 'Debounce with Cancel' }),
    dispute: {
      id: 'dis-1',
      questionId: 'q-2',
      attemptId: null,
      testRunId: 'tr-1',
      at: new Date().toISOString(),
      argument: 'The test asserts the wrong call count.',
      verdict: 'test_incorrect',
      summary: 'The test undercounts trailing calls.',
      detailsMd: 'details',
      fixedTestCode: null,
      testRelPath: 'questions/js-ts/debounce/test.ts',
      hint: null,
      appliedAt: null,
      ...overrides,
    },
  };
}

function renderHistory() {
  return render(
    <MemoryRouter initialEntries={['/history']}>
      <History />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('History', () => {
  // NEE-292: card bodies must be real, focusable <button>s (the detail view
  // isn't routed yet — NEE-306 — so a button is the correct primitive now,
  // not a Link).
  it('exposes each card as a focusable button that opens the detail view on click', async () => {
    getHistory.mockResolvedValue({ items: [reviewItem(), disputeItem()] });
    getReviews.mockResolvedValue([]);
    renderHistory();

    const reviewButton = await screen.findByRole('button', { name: /Closures and Scope/ });
    const disputeButton = screen.getByRole('button', { name: /Debounce with Cancel/ });
    expect(reviewButton.tagName).toBe('BUTTON');
    expect(disputeButton.tagName).toBe('BUTTON');

    reviewButton.focus();
    expect(reviewButton).toHaveFocus();

    fireEvent.click(reviewButton);
    expect(await screen.findByRole('heading', { name: 'Closures and Scope' })).toBeInTheDocument();
    // The back button returns to the list, confirming we entered the detail
    // view rather than navigating away.
    expect(screen.getByRole('button', { name: /History/ })).toBeInTheDocument();
  });

  it('opens the dispute detail on Enter-equivalent activation (native button click)', async () => {
    getHistory.mockResolvedValue({ items: [disputeItem()] });
    renderHistory();

    const card = await screen.findByRole('button', { name: /Debounce with Cancel/ });
    fireEvent.click(card);

    expect(await screen.findByRole('heading', { name: 'Debounce with Cancel' })).toBeInTheDocument();
    expect(
      screen.getByText('The test undercounts trailing calls.', { exact: false }),
    ).toBeInTheDocument();
  });
});
