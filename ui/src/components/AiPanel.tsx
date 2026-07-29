import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router';
import { getDebrief, type DebriefResponse } from '../api';
import { useCancellableEffect } from '../hooks/useCancellableEffect';
import { relTime } from '../lib/format';
import { isKeyless, modelLabel, resolvedModelFor } from '../lib/models';
import type { QuestionRow, ReviewRow, SettingsInfo } from '../types';
import { DimensionBars, ReviewBadge } from './ReviewBadge';

export interface ReviewStream {
  jobId: string;
  text: string;
  error: string | null;
}

export interface ReviewNotice {
  kind: 'no-key' | 'error';
  message: string;
}

export function AiPanel({
  question,
  reviews,
  stream,
  notice,
  justDoneId,
  settings,
  onRequest,
  onCollapse,
}: {
  question: QuestionRow;
  reviews: ReviewRow[] | null;
  stream: ReviewStream | null;
  notice: ReviewNotice | null;
  /** id of a review that finished streaming this session — its body opens expanded */
  justDoneId: string | null;
  /**
   * Provider/keyless state (NEE-303) — null while loading. Gates the
   * "Request review" button the way NewQuestion gates Generate/Brainstorm:
   * with no key configured, no enabled button is ever rendered.
   */
  settings: SettingsInfo | null;
  /** Absent in the readonly reference mode — hides the "Request review" action. */
  onRequest?: () => void;
  onCollapse: () => void;
}) {
  const running = stream != null && stream.error == null;
  const latest = reviews?.[0] ?? null;
  const past = reviews != null ? reviews.slice(1) : [];
  const hasReviews = (reviews?.length ?? 0) > 0;
  // Mirrors NewQuestion's formDisabled: while settings haven't loaded yet,
  // treat the button the same as keyless (hidden) rather than briefly
  // showing an enabled button that guesses at a good outcome.
  const settingsLoaded = settings != null;
  const keyless = isKeyless(settings);
  const canRequest = settingsLoaded && !keyless;
  const reviewModel = resolvedModelFor(settings, 'review');

  // Debrief (interviewer packet + reference solution) — server-gated: the
  // endpoint 404s until the first review exists, and manual/pre-overhaul
  // questions return nulls. Hidden entirely in both cases.
  const [debrief, setDebrief] = useState<DebriefResponse | null>(null);
  useCancellableEffect(
    (cancelled) => {
      if (!hasReviews) {
        setDebrief(null);
        return;
      }
      getDebrief(question.category, question.slug)
        .then((d) => {
          if (!cancelled()) setDebrief(d);
        })
        .catch(() => {
          // 404 pre-review or fetch failure — stay hidden
        });
    },
    [hasReviews, question.category, question.slug],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // follow the stream unless the user scrolled up
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !running) return;
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [stream?.text, running]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <aside className="ai-panel">
      <div className="pane-header">
        <span className="pane-title">AI review</span>
        <div className="ai-header-actions">
          {onRequest && canRequest && (
            <button
              className="btn btn-small btn-accent"
              disabled={running}
              onClick={onRequest}
              title={
                reviewModel != null
                  ? `Costs one LLM call · ${modelLabel(reviewModel)}`
                  : 'runs an LLM review — needs an API key in Settings'
              }
            >
              {running && <span className="pulse-dot pulse-dot-on-accent" />}
              {running
                ? 'Reviewing…'
                : reviewModel != null
                  ? `Request review · ${modelLabel(reviewModel)}`
                  : 'Request review'}
            </button>
          )}
          <button className="icon-btn" onClick={onCollapse} title="Collapse AI panel">
            ▸
          </button>
        </div>
      </div>
      <div className="pane-scroll" ref={scrollRef} onScroll={onScroll}>
        {/* Proactive (settings-derived, before any click) or reactive (a 503
            slipped through, e.g. a key removed in another tab mid-session) —
            either way, the same notice instead of an enabled button. */}
        {((onRequest && keyless) || notice?.kind === 'no-key') && (
          <div className="ai-notice">
            No LLM API key configured —{' '}
            <Link className="ai-notice-link" to="/settings">
              add one in Settings
            </Link>{' '}
            to request reviews.
          </div>
        )}
        {notice?.kind === 'error' && <div className="error-note">{notice.message}</div>}
        {stream != null && (
          <div className="ai-stream">
            {stream.error == null ? (
              <div className="results-running">
                <span className="pulse-dot" /> reviewing your current code…
              </div>
            ) : (
              <div className="ai-error-banner">
                Review failed: {stream.error}
                {stream.text ? ' — partial output below (not saved).' : ''}
              </div>
            )}
            {stream.text && (
              <div className="markdown ai-stream-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{stream.text}</ReactMarkdown>
              </div>
            )}
          </div>
        )}
        {latest != null && (
          <ReviewCard
            review={latest}
            count={reviews?.length ?? 1}
            question={question}
            defaultOpen={latest.id === justDoneId}
          />
        )}
        {debrief != null && (debrief.interviewerPacket || debrief.referenceSolution) && (
          <div className="review-card" data-testid="debrief-panel">
            <h3 className="activity-heading">Debrief</h3>
            {debrief.interviewerPacket && (
              <details className="review-body">
                <summary>Interviewer packet</summary>
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {debrief.interviewerPacket}
                  </ReactMarkdown>
                </div>
              </details>
            )}
            {debrief.referenceSolution && (
              <details className="review-body">
                <summary>Reference solution</summary>
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {debrief.referenceSolution}
                  </ReactMarkdown>
                </div>
              </details>
            )}
          </div>
        )}
        {past.length > 0 && (
          <>
            <h3 className="activity-heading">Past reviews</h3>
            <ul className="activity-list">
              {past.map((r) => (
                <PastReviewRow key={r.id} review={r} />
              ))}
            </ul>
          </>
        )}
        {reviews != null && reviews.length === 0 && stream == null && (
          <div className="pane-empty">
            No reviews yet. Request one — it sends your current code to an LLM and the result is
            kept forever.
          </div>
        )}
        {reviews == null && stream == null && <div className="pane-empty">Loading reviews…</div>}
      </div>
    </aside>
  );
}

function ReviewCard({
  review,
  count,
  question,
  defaultOpen,
}: {
  review: ReviewRow;
  count: number;
  question: QuestionRow;
  defaultOpen: boolean;
}) {
  return (
    <div className="review-card">
      <div className="review-card-head">
        <ReviewBadge review={review} />
        <span className="review-meta">
          v{review.version} · {relTime(review.at)}
          {review.model != null && ` · ${review.model}`}
        </span>
      </div>
      {review.dimensions != null && <DimensionBars dimensions={review.dimensions} />}
      <details key={review.id} className="review-body" open={defaultOpen}>
        <summary>Full review</summary>
        <div className="markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{review.bodyMd}</ReactMarkdown>
        </div>
      </details>
      <div className="review-card-foot">
        <Link
          className="review-history-link"
          to={`/history?type=review&question=${encodeURIComponent(
            `${question.category}/${question.slug}`,
          )}`}
        >
          v{count} · view history →
        </Link>
      </div>
    </div>
  );
}

function PastReviewRow({ review }: { review: ReviewRow }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="past-review">
      <button className="past-review-row" onClick={() => setOpen((v) => !v)}>
        <span className="mono cell-dim">v{review.version}</span>
        <span className="past-review-date">{relTime(review.at)}</span>
        <ReviewBadge review={review} />
        <span className="past-review-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="markdown past-review-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{review.bodyMd}</ReactMarkdown>
        </div>
      )}
    </li>
  );
}
