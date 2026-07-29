import { fireEvent, render, screen, within } from '@testing-library/react';
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

// NEE-298: click-to-sort headers. QuestionTable itself just renders the
// affordance and reports clicks — the actual ordering of `questions` is the
// caller's (Library's) job, per its `visible` useMemo.
describe('QuestionTable — sortable headers (NEE-298)', () => {
  it('renders plain, non-interactive headers when no sort/onSortChange is passed', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <QuestionTable questions={[question()]} />
      </MemoryRouter>,
    );

    const header = screen.getByRole('columnheader', { name: 'Title' });
    expect(header).not.toHaveAttribute('aria-sort');
    expect(within(header).queryByRole('button')).toBeNull();
  });

  it('marks only the active column with aria-sort and a visual indicator, and reports clicks by key', () => {
    const onSortChange = vi.fn();
    render(
      <MemoryRouter initialEntries={['/']}>
        <QuestionTable
          questions={[question()]}
          sort={{ key: 'lastActivity', dir: 'desc' }}
          onSortChange={onSortChange}
        />
      </MemoryRouter>,
    );

    const activeHeader = screen.getByRole('columnheader', { name: 'Last activity' });
    expect(activeHeader).toHaveAttribute('aria-sort', 'descending');
    expect(within(activeHeader).getByText('▼')).toBeInTheDocument();

    const titleHeader = screen.getByRole('columnheader', { name: 'Title' });
    expect(titleHeader).toHaveAttribute('aria-sort', 'none');
    expect(within(titleHeader).queryByText('▲')).toBeNull();
    expect(within(titleHeader).queryByText('▼')).toBeNull();

    fireEvent.click(within(titleHeader).getByRole('button', { name: 'Title' }));
    expect(onSortChange).toHaveBeenCalledWith('title');

    fireEvent.click(within(screen.getByRole('columnheader', { name: 'Attempts' })).getByRole('button', {
      name: 'Attempts',
    }));
    expect(onSortChange).toHaveBeenCalledWith('attempts');
  });

  it('does not navigate the row when a sort header is clicked', () => {
    const onSortChange = vi.fn();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <QuestionTable
                questions={[question()]}
                sort={{ key: 'lastActivity', dir: 'desc' }}
                onSortChange={onSortChange}
              />
            }
          />
          <Route path="/q/:category/:slug" element={<div>Room for question</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Last run' }));
    expect(onSortChange).toHaveBeenCalledWith('lastRun');
    expect(screen.queryByText('Room for question')).toBeNull();
  });
});

// NEE-353: design/behavioral questions never produce a test run, so the
// "Last run" cell must say something honest instead of a bare '—' (which
// reads as "unknown", not "not applicable").
describe('QuestionTable — Last run column for no-test categories (NEE-353)', () => {
  it('shows "reviewed" for a solved (reviewed) prose row instead of a dash', () => {
    renderTable([
      question({
        category: 'behavioral',
        stats: { attemptCount: 1, lastRun: null, lastActivityAt: null, status: 'solved', imported: false },
      }),
    ]);
    expect(screen.getByText('reviewed')).toBeInTheDocument();
  });

  it('shows "no tests" for an unreviewed prose row instead of a dash', () => {
    renderTable([
      question({
        category: 'design-fe',
        stats: { attemptCount: 1, lastRun: null, lastActivityAt: null, status: 'in-progress', imported: false },
      }),
    ]);
    expect(screen.getByText('no tests')).toBeInTheDocument();
  });

  it('still shows a dash for an untouched coding row (has tests, no run yet)', () => {
    renderTable([question()]); // default: js-ts, not-attempted, lastRun null
    // Attempts and Last run are both '—' for an untouched row.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });
});
