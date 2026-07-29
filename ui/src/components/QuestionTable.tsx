import { useNavigate } from 'react-router';
import { relTime } from '../lib/format';
import type { QuestionWithStats } from '../types';
import { CategoryChip, DifficultyChip, StatusChip } from './Chip';

export function QuestionTable({ questions }: { questions: QuestionWithStats[] }) {
  const navigate = useNavigate();
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
          </tr>
        </thead>
        <tbody>
          {questions.map((q) => {
            const missing = q.missingAt != null;
            return (
              <tr
                key={q.id}
                className={missing ? 'row-missing' : 'row-clickable'}
                onClick={missing ? undefined : () => navigate(`/q/${q.category}/${q.slug}`)}
                title={missing ? 'Question directory is missing on disk' : undefined}
              >
                <td className="cell-title">
                  {q.title}
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
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
