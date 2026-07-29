import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getAttempt, getSnapshot, getSnapshots } from '../api';
import { useCancellableEffect } from '../hooks/useCancellableEffect';
import { formatDuration, relTime } from '../lib/format';
import { DISPUTE_VERDICT_LABELS } from '../lib/review';
import type {
  AttemptEventRow,
  AttemptEventType,
  DisputeRow,
  SnapshotRow,
  SnapshotTrigger,
  TestRunRow,
} from '../types';

const EVENT_LABELS: Record<AttemptEventType, string> = {
  reveal: 'question revealed',
  first_edit: 'first edit',
  test_run: 'test run',
  all_green: 'all green ✓',
  pause: 'paused',
  resume: 'resumed',
};

export function ProblemPane({
  readme,
  category,
  slug,
  attemptId,
  attemptNumber,
  history,
  disputes,
  onCollapse,
}: {
  readme: string;
  category: string;
  slug: string;
  attemptId: string;
  attemptNumber: number;
  history: TestRunRow[];
  disputes: DisputeRow[];
  onCollapse: () => void;
}) {
  const [tab, setTab] = useState<'problem' | 'activity'>('problem');

  return (
    <aside className="problem-pane">
      <div className="pane-header">
        <div className="pane-tabs">
          <button
            className={`pane-tab ${tab === 'problem' ? 'active' : ''}`}
            onClick={() => setTab('problem')}
          >
            Problem
          </button>
          <button
            className={`pane-tab ${tab === 'activity' ? 'active' : ''}`}
            onClick={() => setTab('activity')}
          >
            Activity
          </button>
        </div>
        <button className="icon-btn" onClick={onCollapse} title="Collapse problem pane">
          ◂
        </button>
      </div>
      <div className="pane-scroll">
        {tab === 'problem' ? (
          readme ? (
            <div className="markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{readme}</ReactMarkdown>
            </div>
          ) : (
            <div className="pane-empty">No README for this question.</div>
          )
        ) : (
          <ActivityTab
            category={category}
            slug={slug}
            attemptId={attemptId}
            attemptNumber={attemptNumber}
            history={history}
            disputes={disputes}
          />
        )}
      </div>
    </aside>
  );
}

function ActivityTab({
  category,
  slug,
  attemptId,
  attemptNumber,
  history,
  disputes,
}: {
  category: string;
  slug: string;
  attemptId: string;
  attemptNumber: number;
  history: TestRunRow[];
  disputes: DisputeRow[];
}) {
  const [events, setEvents] = useState<AttemptEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useCancellableEffect(
    (cancelled) => {
      getAttempt(attemptId)
        .then(({ events: got }) => {
          if (!cancelled()) setEvents(got);
        })
        .catch(() => {
          if (!cancelled()) setError('Failed to load attempt events');
        });
    },
    [attemptId, history.length],
  );

  return (
    <div className="activity">
      <h3 className="activity-heading">Attempt #{attemptNumber}</h3>
      {error && <div className="error-note">{error}</div>}
      {events == null && !error ? (
        <div className="pane-empty">Loading…</div>
      ) : events != null && events.length === 0 ? (
        <div className="pane-empty">No events yet.</div>
      ) : (
        <ul className="activity-list">
          {events?.map((ev) => (
            <li key={ev.id} className="activity-item">
              <span className={`activity-type activity-type-${ev.type}`}>
                {EVENT_LABELS[ev.type] ?? ev.type}
              </span>
              <span className="activity-when">{relTime(ev.at)}</span>
            </li>
          ))}
        </ul>
      )}
      {disputes.length > 0 && (
        <>
          <h3 className="activity-heading">Disputes</h3>
          <ul className="activity-list">
            {disputes.map((d) => (
              <li key={d.id} className="activity-item activity-dispute">
                <span className="activity-dispute-main">
                  <span className={`dispute-tag dv-${d.verdict}`}>
                    {DISPUTE_VERDICT_LABELS[d.verdict]}
                  </span>
                  {d.appliedAt != null && <span className="chip chip-applied">applied</span>}
                  <span className="activity-dispute-summary" title={d.summary}>
                    {d.summary}
                  </span>
                </span>
                <span className="activity-when">{relTime(d.at)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="activity-heading">Past runs</h3>
      {history.length === 0 ? (
        <div className="pane-empty">No runs yet.</div>
      ) : (
        <ul className="activity-list">
          {history.map((run) => (
            <li key={run.id} className="activity-item">
              <span className="mono">
                {run.status === 'done' && run.total != null ? (
                  run.total === 0 ? (
                    <span className="cell-dim">no tests found</span>
                  ) : (
                    <span className={run.failed === 0 ? 'run-pass' : 'run-fail'}>
                      {run.passed}/{run.total}
                    </span>
                  )
                ) : (
                  <span
                    className={
                      run.status === 'error' || run.status === 'compile-error'
                        ? 'run-fail'
                        : 'cell-dim'
                    }
                  >
                    {run.status === 'compile-error' ? 'compile error' : run.status}
                  </span>
                )}
                {run.durationMs != null && (
                  <span className="cell-dim"> · {formatDuration(run.durationMs)}</span>
                )}
              </span>
              <span className="activity-when">
                {run.trigger === 'save' ? 'auto · ' : ''}
                {relTime(run.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <PastAttemptCode category={category} slug={slug} />
    </div>
  );
}

const SNAPSHOT_TRIGGER_LABELS: Record<SnapshotTrigger, string> = {
  scaffold: 'scaffold baseline',
  save: 'autosave',
  review: 'reviewed',
  'dispute-apply': 'dispute fix applied',
  'probe-append': 'follow-up added',
  reset: 'saved before reset',
};

/**
 * Read-only "past attempt code" list (NEE-363): a question solved by tests
 * (or by review-free prose) and then reset-to-stub previously had no
 * in-app way to recover the pre-reset content — the only viewable blob was
 * a review's snapshotHash. This surfaces every snapshot ever taken for the
 * question's solution files, newest first. No restore action — visible
 * recovery is enough; copy/paste covers the rest.
 */
function PastAttemptCode({ category, slug }: { category: string; slug: string }) {
  const [snapshots, setSnapshots] = useState<SnapshotRow[] | null>(null);

  useCancellableEffect(
    (cancelled) => {
      setSnapshots(null);
      getSnapshots(category, slug)
        .then((got) => {
          if (!cancelled()) setSnapshots(got);
        })
        .catch(() => {
          if (!cancelled()) setSnapshots([]);
        });
    },
    [category, slug],
  );

  if (snapshots == null || snapshots.length === 0) return null;

  return (
    <>
      <h3 className="activity-heading">Past attempt code</h3>
      <ul className="activity-list">
        {snapshots.map((s) => (
          <li key={s.id} className="activity-item activity-snapshot">
            <SnapshotEntry snapshot={s} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** Collapsible past-attempt blob, fetched lazily on first expand — same
 * details/summary lazy-load pattern as History.tsx's SnapshotCode. */
function SnapshotEntry({ snapshot }: { snapshot: SnapshotRow }) {
  const [content, setContent] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'loaded' | 'missing' | 'error'>('idle');

  const load = () => {
    if (state !== 'idle') return;
    setState('loading');
    getSnapshot(snapshot.id)
      .then((s) => {
        if (s.content != null) {
          setContent(s.content);
          setState('loaded');
        } else {
          setState('missing');
        }
      })
      .catch(() => setState('error'));
  };

  return (
    <details className="snapshot-details" onToggle={(e) => e.currentTarget.open && load()}>
      <summary>
        <span className="mono">{snapshot.relPath}</span>
        <span className="cell-dim"> · {SNAPSHOT_TRIGGER_LABELS[snapshot.trigger]}</span>
        <span className="activity-when"> · {relTime(snapshot.at)}</span>
      </summary>
      {state === 'loading' && <div className="pane-empty">Loading snapshot…</div>}
      {state === 'missing' && <div className="pane-empty">Snapshot blob is gone from disk.</div>}
      {state === 'error' && <div className="pane-empty">Failed to load the snapshot.</div>}
      {state === 'loaded' && content != null && <pre className="snapshot-pre">{content}</pre>}
    </details>
  );
}
