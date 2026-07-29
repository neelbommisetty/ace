import type { MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { relTime } from '../lib/format';
import type { QuestionWithStats } from '../types';
import { CategoryChip, DifficultyChip, StatusChip } from './Chip';

export interface QuestionTableProps {
  questions: QuestionWithStats[];
  /** Row action (NEE-296): archives a not-yet-archived row, including 'missing' ones. */
  onArchive?: (question: QuestionWithStats) => void;
  /** Row action (NEE-296): the Archived filter's Restore. */
  onUnarchive?: (question: QuestionWithStats) => void;
}

export function QuestionTable({ questions, onArchive, onUnarchive }: QuestionTableProps) {
  const navigate = useNavigate();
  const showActions = onArchive != null || onUnarchive != null;
  return (
    <div className="table-wrap">
      <table className="question-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Category</th>
            <th>Difficulty</th>
            <th>Status</th>
            <th className="num">Attempts</th>
            <th className="num">Last run</th>
            <th>Last activity</th>
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
                        navigate(`/q/${q.category}/${q.slug}`);
                      }
                }
                title={missing ? 'Question directory is missing on disk' : undefined}
              >
                <td className="cell-title">
                  {missing ? (
                    q.title
                  ) : (
                    <Link className="row-link" to={`/q/${q.category}/${q.slug}`}>
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
