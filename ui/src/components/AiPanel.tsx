import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router';
import { isProseAnswer, lookupCategoryConfig } from '@shared/categories';
import { isEscalatedReview } from '@shared/escalation';
import { getDebrief, type DebriefResponse } from '../api';
import { useCancellableEffect } from '../hooks/useCancellableEffect';
import { relTime } from '../lib/format';
import { isKeyless, modelLabel, resolvedModelFor } from '../lib/models';
import type { ProbeSetRow, QuestionRow, ReviewRow, SettingsInfo } from '../types';
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
  attemptId = null,
  stream,
  notice,
  justDoneId,
  settings,
  onRequest,
  probeSets,
  probesRunning,
  probeNotice,
  onRequestProbes,
  onCollapse,
}: {
  question: QuestionRow;
  reviews: ReviewRow[] | null;
  /**
   * The attempt a "Request review" click would target — the room's active
   * (or readonly reference) attempt. Mirrors reviews.ts's escalation rule
   * client-side (NEE-303) so the pre-invocation label already names the
   * model that will actually run, not always the routine one. Optional/null
   * for call sites (and existing tests) that predate the escalation tier —
   * never escalates, same as the server rule's own null-attemptId case.
   */
  attemptId?: string | null;
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
  /** Follow-up probes (NEE-345) — defaults keep every existing call site (and test) unaffected. */
  probeSets?: ProbeSetRow[];
  probesRunning?: boolean;
  probeNotice?: ReviewNotice | null;
  /** Absent in the readonly reference mode, exactly like onRequest — hides the probes button. */
  onRequestProbes?: () => void;
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

  // Follow-up probes (NEE-345): gated identically to Review, PLUS a
  // category-capability check — the feature only makes sense for prose
  // answers (story.md/notes.md), never a coding question's solution file.
  const config = lookupCategoryConfig(question.category);

  // The SAME rule reviews.ts routes on (shared/escalation.ts), collapsing back
  // to 'review' when the escalated slot has no route (openai-only install).
  // Category-aware for the same reason the server is: a prose attempt ends the
  // instant its review lands, so an attempt-scoped test could never fire there.
  const willEscalate =
    config != null && isEscalatedReview({ config, reviews: reviews ?? [], attemptId });
  const reviewModel = willEscalate
    ? (resolvedModelFor(settings, 'review-escalated') ?? resolvedModelFor(settings, 'review'))
    : resolvedModelFor(settings, 'review');
  const proseCategory = config != null && isProseAnswer(config);
  const probeModel = resolvedModelFor(settings, 'probe');
  const canRequestProbes = proseCategory && settingsLoaded && !keyless;
  const primaryFile = config?.solutionFiles[0] ?? 'the story file';

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

  // Both actions carry a `· provider/model` suffix (NEE-303), and neither the
  // 38px `.pane-header` nor the panel itself is ever wide enough for two of
  // them: even at the 520px maximum the header runs ~170px over, and at the
  // 220px minimum a single full label already overflows on its own. So the
  // buttons live in their own wrapping row below the header, stacking the
  // model onto a second line — see `.pane-actions` in styles.css. The
  // accessible name still spells out the full one-line label the header used
  // to show, which is what NEE-303 actually promised: name the model that will
  // run BEFORE the paid click.
  const showReview = onRequest != null && canRequest;
  const showProbes = onRequestProbes != null && canRequestProbes;
  const reviewLabel = running
    ? 'Reviewing…'
    : reviewModel != null
      ? `Request review · ${modelLabel(reviewModel)}`
      : 'Request review';
  const probeLabel = probesRunning
    ? 'Drafting probes…'
    : probeModel != null
      ? `Follow-up probes · ${modelLabel(probeModel)}`
      : 'Follow-up probes';

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
          <button className="icon-btn" onClick={onCollapse} title="Collapse AI panel">
            ▸
          </button>
        </div>
      </div>
      {(showReview || showProbes) && (
        <div className="pane-actions">
          {onRequest && canRequest && (
            <button
              className="btn btn-small btn-accent btn-stack"
              disabled={running}
              onClick={onRequest}
              aria-label={reviewLabel}
              title={
                reviewModel != null
                  ? `Costs one LLM call · ${modelLabel(reviewModel)}`
                  : 'runs an LLM review — needs an API key in Settings'
              }
            >
              <span className="btn-stack-main">
                {running && <span className="pulse-dot pulse-dot-on-accent" />}
                {running ? 'Reviewing…' : 'Request review'}
              </span>
              {!running && reviewModel != null && (
                <span className="btn-stack-sub">{modelLabel(reviewModel)}</span>
              )}
            </button>
          )}
          {onRequestProbes && canRequestProbes && (
            <button
              className="btn btn-small btn-stack"
              disabled={probesRunning || (probeSets != null && probeSets.length > 0)}
              onClick={onRequestProbes}
              aria-label={probeLabel}
              title={
                probeSets != null && probeSets.length > 0
                  ? 'Follow-up probes already generated for this attempt'
                  : probeModel != null
                    ? `Costs one LLM call · ${modelLabel(probeModel)}`
                    : 'runs an LLM to draft follow-up questions — needs an API key in Settings'
              }
            >
              <span className="btn-stack-main">
                {probesRunning && <span className="pulse-dot" />}
                {probesRunning ? 'Drafting probes…' : 'Follow-up probes'}
              </span>
              {!probesRunning && probeModel != null && (
                <span className="btn-stack-sub">{modelLabel(probeModel)}</span>
              )}
            </button>
          )}
        </div>
      )}
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
        {proseCategory && ((onRequestProbes && keyless) || probeNotice?.kind === 'no-key') && (
          <div className="ai-notice">
            No LLM API key configured —{' '}
            <Link className="ai-notice-link" to="/settings">
              add one in Settings
            </Link>{' '}
            to request follow-up probes.
          </div>
        )}
        {probeNotice?.kind === 'error' && <div className="error-note">{probeNotice.message}</div>}
        {probeSets != null && probeSets.length > 0 && (
          <div className="review-card" data-testid="probe-panel">
            <h3 className="activity-heading">Follow-up probes</h3>
            <p className="pane-hint">
              answer these in <code>{primaryFile}</code> ↓
            </p>
            <ul className="activity-list">
              {probeSets[0].probes.map((probe, i) => (
                <li key={i} className="probe-item">
                  {probe.question}
                </li>
              ))}
            </ul>
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
