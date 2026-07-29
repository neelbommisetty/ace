import { Link } from 'react-router';
import type { PracticeNextSuggestion } from '../lib/practiceNext';
import { CategoryChip, DifficultyChip } from './Chip';

/**
 * Library's "Practice next" card (NEE-310) — sits next to the Resume card and
 * suggests ONE question with a one-line reason. The caller (Library) decides
 * whether to render this at all: null out `suggestion` and it renders
 * nothing, so "hidden when there's no unsolved question left" is the
 * caller's responsibility, not this component's.
 */
export function PracticeNextCard({
  suggestion,
  linkQuery,
}: {
  suggestion: PracticeNextSuggestion;
  /** The Library's current filter/search/sort query string (NEE-310), minus the leading '?'. */
  linkQuery?: string;
}) {
  const { question, reason } = suggestion;
  return (
    <div className="practice-next-card">
      <div className="resume-info">
        <span className="resume-label">Practice next</span>
        <span className="resume-title">{question.title}</span>
        <span className="resume-meta">
          <CategoryChip category={question.category} />
          <DifficultyChip difficulty={question.difficulty} />
          <span className="resume-detail">{reason}</span>
        </span>
      </div>
      <Link
        className="btn btn-accent"
        to={`/q/${question.category}/${question.slug}${linkQuery ? `?${linkQuery}` : ''}`}
      >
        Start →
      </Link>
    </div>
  );
}
