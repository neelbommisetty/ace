import type { MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { relTime } from '../lib/format';
import type { SortDir, SortKey } from '../lib/libraryOrder';
import type { QuestionWithStats } from '../types';
import { CategoryChip, DifficultyChip, StatusChip } from './Chip';

/** Re-exported from lib/libraryOrder (NEE-310) so existing `from '../components/QuestionTable'` imports keep working. */
export type { SortDir, SortKey };

export interface QuestionTableProps {
  questions: QuestionWithStats[];
  /** Current sort + click-to-sort handler (NEE-298). Omitting both renders plain,
   * non-interactive headers — used by tests that don't care about ordering. */
  sort?: { key: SortKey; dir: SortDir };
  onSortChange?: (key: SortKey) => void;
  /** Row action (NEE-296): archives a not-yet-archived row, including 'missing' ones. */
  onArchive?: (question: QuestionWithStats) => void;
  /** Row action (NEE-296): the Archived filter's Restore. */
  onUnarchive?: (question: QuestionWithStats) => void;
  /**
   * The Library's current filter/search/sort query string (NEE-310), minus
   * the leading '?'. Appended to each row's room link/navigate so the room
   * can recompute this exact ordering for prev/next and "Next question"
   * without a Library round trip. Omitted (or empty) renders a plain link.
   */
  linkQuery?: string;
}

function SortableHeader({
  label,
  sortKey,
  className,
  sort,
  onSortChange,
}: {
  label: string;
  sortKey: SortKey;
  className?: string;
  sort?: { key: SortKey; dir: SortDir };
  onSortChange?: (key: SortKey) => void;
}) {
  if (onSortChange == null) {
    return <th className={className}>{label}</th>;
  }
  const active = sort?.key === sortKey;
  const dir = active ? sort?.dir : undefined;
  return (
    <th className={className} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort-header-btn" onClick={() => onSortChange(sortKey)}>
        {label}
        <span className="sort-indicator" aria-hidden="true">
          {active ? (dir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </th>
  );
}

export function QuestionTable({
  questions,
  sort,
  onSortChange,
  onArchive,
  onUnarchive,
  linkQuery,
}: QuestionTableProps) {
  const navigate = useNavigate();
  const showActions = onArchive != null || onUnarchive != null;
  const roomHref = (q: QuestionWithStats) =>
    `/q/${q.category}/${q.slug}${linkQuery ? `?${linkQuery}` : ''}`;
  return (
    <div className="table-wrap">
      <table className="question-table">
        <thead>
          <tr>
            <SortableHeader label="Title" sortKey="title" sort={sort} onSortChange={onSortChange} />
            <th>Category</th>
            <th>Difficulty</th>
            <th>Status</th>
            <SortableHeader
              label="Attempts"
              sortKey="attempts"
              className="num"
              sort={sort}
              onSortChange={onSortChange}
            />
            <SortableHeader
              label="Last run"
              sortKey="lastRun"
              className="num"
              sort={sort}
              onSortChange={onSortChange}
            />
            <SortableHeader
              label="Last activity"
              sortKey="lastActivity"
              sort={sort}
              onSortChange={onSortChange}
            />
            {showActions && <th className="col-actions">
              <span className="sr-only">Actions</span>
            </th>}
          </tr>
        </thead>
        <tbody>
          {questions.map((q) => {
            const missing = q.missingAt != null;
            const archived = q.archivedAt != null;
            return (
              <tr
                key={q.id}
                className={missing ? 'row-missing' : 'row-clickable'}
                onClick={
                  missing
                    ? undefined
                    : (e: MouseEvent<HTMLTableRowElement>) => {
                        // The title cell is a real <Link> now — let its own
                        // click handling (incl. cmd/middle-click new tab) win
                        // rather than racing it with an imperative navigate().
                        // The row action button lives in its own cell and
                        // stops propagation itself, so it never reaches here.
                        if (e.target instanceof Element && e.target.closest('a')) return;
                        navigate(roomHref(q));
                      }
                }
                title={missing ? 'Question directory is missing on disk' : undefined}
              >
                <td className="cell-title">
                  {missing ? (
                    q.title
                  ) : (
                    <Link className="row-link" to={roomHref(q)}>
                      {q.title}
                    </Link>
                  )}
                  {missing && <span className="badge badge-missing">missing</span>}
                </td>
                <td>
                  <CategoryChip category={q.category} />
                </td>
                <td>
                  <DifficultyChip difficulty={q.difficulty} />
                </td>
                <td>
                  <StatusChip status={q.stats.status} />
                </td>
                <td className="num mono">{q.stats.attemptCount || '—'}</td>
                <td className="num mono">
                  {q.stats.lastRun ? (
                    q.stats.lastRun.status === 'compile-error' ? (
                      <span className="run-fail" title="Latest run failed to compile">
                        compile error
                      </span>
                    ) : q.stats.lastRun.total === 0 ? (
                      <span className="cell-dim">no tests</span>
                    ) : (
                      <span
                        className={
                          q.stats.lastRun.passed === q.stats.lastRun.total
                            ? 'run-pass'
                            : 'run-fail'
                        }
                      >
                        {q.stats.lastRun.passed}/{q.stats.lastRun.total}
                      </span>
                    )
                  ) : (
                    '—'
                  )}
                </td>
                <td className="cell-dim">{relTime(q.stats.lastActivityAt)}</td>
                {showActions && (
                  <td className="col-actions">
                    {archived ? (
                      onUnarchive != null && (
                        <button
                          type="button"
                          className="btn btn-small row-action"
                          onClick={(e) => {
                            // Its own focusable control — stops propagation
                            // so it never triggers the row's own navigation.
                            e.stopPropagation();
                            onUnarchive(q);
                          }}
                        >
                          Restore
                        </button>
                      )
                    ) : (
                      onArchive != null && (
                        <button
                          type="button"
                          className="btn btn-small row-action"
                          title={missing ? 'Clear this dead row (files already gone from disk)' : undefined}
                          onClick={(e) => {
                            e.stopPropagation();
                            onArchive(q);
                          }}
                        >
                          Archive
                        </button>
                      )
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
