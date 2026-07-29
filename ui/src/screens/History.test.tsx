import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { History, HistoryDetail } from './History';
import type { DisputeRow, HistoryItem, QuestionRow, ReviewRow } from '../types';

const { getHistory, getReviews, getReview, getDispute, getFile } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getReviews: vi.fn(),
  getReview: vi.fn(),
  getDispute: vi.fn(),
  getFile: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    getHistory,
    getReviews,
    getReview,
    getDispute,
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

function makeReview(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
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
  };
}

function reviewItem(overrides: Partial<ReviewRow> = {}): HistoryItem {
  return {
    type: 'review',
    at: new Date().toISOString(),
    question: question(),
    review: makeReview(overrides),
  };
}

function makeDispute(overrides: Partial<DisputeRow> = {}): DisputeRow {
  return {
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
  };
}

function disputeQuestion(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return question({ id: 'q-2', slug: 'debounce', title: 'Debounce with Cancel', ...overrides });
}

function disputeItem(overrides: Partial<DisputeRow> = {}): HistoryItem {
  return {
    type: 'dispute',
    at: new Date().toISOString(),
    question: disputeQuestion(),
    dispute: makeDispute(overrides),
  };
}

/** Mirrors App.tsx's route declarations for /history and its two detail routes. */
function renderHistory(initialEntries: string[] = ['/history']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/history" element={<History />} />
        <Route path="/history/review/:id" element={<HistoryDetail type="review" />} />
        <Route path="/history/dispute/:id" element={<HistoryDetail type="dispute" />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('History', () => {
  // NEE-306: card bodies are real, focusable <Link>s now that the detail
  // view is routed — Tab reaches them, they carry a real href (cmd/middle
  // click opens a new tab "for free"), and activating one navigates to
  // /history/review/:id instead of just flipping local state.
  it('exposes each card as a focusable link that opens the detail view and changes the URL', async () => {
    getHistory.mockResolvedValue({ items: [reviewItem(), disputeItem()] });
    getReviews.mockResolvedValue([]);
    getReview.mockResolvedValue({ ...makeReview(), question: question(), snapshotContent: null });
    renderHistory();

    const reviewLink = await screen.findByRole('link', { name: /Closures and Scope/ });
    const disputeLink = screen.getByRole('link', { name: /Debounce with Cancel/ });
    expect(reviewLink.tagName).toBe('A');
    expect(disputeLink.tagName).toBe('A');
    expect(reviewLink).toHaveAttribute('href', '/history/review/rev-1');

    reviewLink.focus();
    expect(reviewLink).toHaveFocus();

    fireEvent.click(reviewLink);
    expect(await screen.findByRole('heading', { name: 'Closures and Scope' })).toBeInTheDocument();
    expect(getReview).toHaveBeenCalledWith('rev-1');
    // The back link returns to the list, confirming we navigated to the
    // detail route rather than just swapping local state.
    expect(screen.getByRole('link', { name: /History/ })).toBeInTheDocument();
  });

  it('carries the current filters onto the card link and back onto the back link', async () => {
    getHistory.mockResolvedValue({ items: [disputeItem()] });
    getDispute.mockResolvedValue({ ...makeDispute(), question: disputeQuestion() });
    renderHistory(['/history?category=js-ts&type=dispute']);

    const link = await screen.findByRole('link', { name: /Debounce with Cancel/ });
    expect(link).toHaveAttribute('href', '/history/dispute/dis-1?category=js-ts&type=dispute');

    fireEvent.click(link);

    expect(await screen.findByRole('heading', { name: 'Debounce with Cancel' })).toBeInTheDocument();
    const backLink = screen.getByRole('link', { name: /History/ });
    expect(backLink).toHaveAttribute('href', '/history?category=js-ts&type=dispute');
  });

  it('opens the dispute detail on click, fetching by id', async () => {
    getHistory.mockResolvedValue({ items: [disputeItem()] });
    getDispute.mockResolvedValue({ ...makeDispute(), question: disputeQuestion() });
    renderHistory();

    const card = await screen.findByRole('link', { name: /Debounce with Cancel/ });
    fireEvent.click(card);

    expect(await screen.findByRole('heading', { name: 'Debounce with Cancel' })).toBeInTheDocument();
    expect(getDispute).toHaveBeenCalledWith('dis-1');
    expect(
      screen.getByText('The test undercounts trailing calls.', { exact: false }),
    ).toBeInTheDocument();
  });

  // Acceptance (NEE-306): the detail URL survives a reload — a fresh mount
  // straight at /history/review/:id (no list ever fetched) must still fetch
  // and render the review by id.
  it('lands directly on the review detail from a fresh reload of its URL', async () => {
    getReview.mockResolvedValue({ ...makeReview(), question: question(), snapshotContent: null });
    getReviews.mockResolvedValue([]);
    renderHistory(['/history/review/rev-1?category=js-ts']);

    expect(await screen.findByRole('heading', { name: 'Closures and Scope' })).toBeInTheDocument();
    expect(getReview).toHaveBeenCalledWith('rev-1');
    expect(getHistory).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /History/ })).toHaveAttribute(
      'href',
      '/history?category=js-ts',
    );
  });

  // Same acceptance, for a dispute.
  it('lands directly on the dispute detail from a fresh reload of its URL', async () => {
    getDispute.mockResolvedValue({ ...makeDispute(), question: disputeQuestion() });
    renderHistory(['/history/dispute/dis-1']);

    expect(await screen.findByRole('heading', { name: 'Debounce with Cancel' })).toBeInTheDocument();
    expect(getDispute).toHaveBeenCalledWith('dis-1');
    expect(getHistory).not.toHaveBeenCalled();
  });
});
