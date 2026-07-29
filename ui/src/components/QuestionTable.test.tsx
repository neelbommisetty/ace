import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { QuestionTable } from './QuestionTable';
import type { QuestionWithStats } from '../types';

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

function renderTable(
  questions: QuestionWithStats[],
  handlers: { onArchive?: (q: QuestionWithStats) => void; onUnarchive?: (q: QuestionWithStats) => void } = {},
) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<QuestionTable questions={questions} {...handlers} />} />
        <Route path="/q/:category/:slug" element={<div>Room for question</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('QuestionTable — archive row action (NEE-296)', () => {
  it('renders no actions column when neither handler is passed', () => {
    renderTable([question()]);
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('offers Archive on a normal row and calls onArchive without navigating', () => {
    const onArchive = vi.fn();
    const q = question();
    renderTable([q], { onArchive });

    const button = screen.getByRole('button', { name: 'Archive' });
    fireEvent.click(button);

    expect(onArchive).toHaveBeenCalledWith(q);
    expect(screen.queryByText('Room for question')).toBeNull();
    // The row's own Link is still there and still works — the action button
    // is additive, not a replacement for NEE-292's row navigation.
    expect(screen.getByRole('link', { name: 'Closures and Scope' })).toHaveAttribute(
      'href',
      '/q/js-ts/closures-and-scope',
    );
  });

  it('offers Restore instead of Archive on an already-archived row', () => {
    const onArchive = vi.fn();
    const onUnarchive = vi.fn();
    const archived = question({ archivedAt: new Date().toISOString() });
    renderTable([archived], { onArchive, onUnarchive });

    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    expect(onUnarchive).toHaveBeenCalledWith(archived);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('offers Archive on a missing (dead) row so it can finally be resolved', () => {
    const onArchive = vi.fn();
    const missing = question({ missingAt: new Date().toISOString() });
    renderTable([missing], { onArchive });

    const button = screen.getByRole('button', { name: 'Archive' });
    fireEvent.click(button);

    expect(onArchive).toHaveBeenCalledWith(missing);
  });

  it('is its own focusable control, reachable by keyboard independent of the row Link', () => {
    const onArchive = vi.fn();
    renderTable([question()], { onArchive });

    const button = screen.getByRole('button', { name: 'Archive' });
    button.focus();
    expect(button).toHaveFocus();
  });
});
