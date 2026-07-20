import { Link } from 'react-router-dom';
import { formatClock, relTime } from '../lib/format';
import type { AttemptRow, QuestionRow } from '../types';
import { CategoryChip, DifficultyChip } from './Chip';

export function ResumeCard({
  attempt,
  question,
}: {
  attempt: AttemptRow;
  question: QuestionRow;
}) {
  return (
    <div className="resume-card">
      <div className="resume-info">
        <span className="resume-label">In progress</span>
        <span className="resume-title">{question.title}</span>
        <span className="resume-meta">
          <CategoryChip category={question.category} />
          <DifficultyChip difficulty={question.difficulty} />
          <span className="resume-detail">
            attempt #{attempt.number} · <span className="mono">{formatClock(attempt.activeSeconds)}</span>{' '}
            active · started {relTime(attempt.startedAt)}
          </span>
        </span>
      </div>
      <Link className="btn btn-accent" to={`/q/${question.category}/${question.slug}`}>
        Resume →
      </Link>
    </div>
  );
}
