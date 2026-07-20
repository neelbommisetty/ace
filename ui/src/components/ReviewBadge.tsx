import { scoreClass, verdictClass } from '../lib/review';
import type { ReviewRow } from '../types';

/**
 * Verdict badge (design reviews) or 'N/5' score badge (code reviews).
 * Falls back to a neutral 'review' tag when neither was parsed.
 */
export function ReviewBadge({ review }: { review: Pick<ReviewRow, 'verdict' | 'score'> }) {
  if (review.verdict != null) {
    return (
      <span className={`verdict-badge vb-${verdictClass(review.verdict)}`}>{review.verdict}</span>
    );
  }
  if (review.score != null) {
    return (
      <span className={`verdict-badge mono ${scoreClass(review.score)}`}>{review.score}/5</span>
    );
  }
  return <span className="verdict-badge vb-none">review</span>;
}

/** Mini 1..5 bars for design-review rubric dimensions. */
export function DimensionBars({ dimensions }: { dimensions: Record<string, number> }) {
  const entries = Object.entries(dimensions);
  if (entries.length === 0) return null;
  return (
    <div className="dim-bars">
      {entries.map(([label, value]) => (
        <div key={label} className="dim-bar-row" title={`${label}: ${value}/5`}>
          <span className="dim-bar-label">{label}</span>
          <span className="dim-bar-track">
            <span
              className={`dim-bar-fill ${value >= 4 ? 'dim-good' : value >= 3 ? 'dim-mid' : 'dim-bad'}`}
              style={{ width: `${(Math.min(5, Math.max(0, value)) / 5) * 100}%` }}
            />
          </span>
          <span className="dim-bar-val mono">{value}/5</span>
        </div>
      ))}
    </div>
  );
}
