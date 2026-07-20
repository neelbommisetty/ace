import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getAttempt } from '../api';
import { formatDuration, relTime } from '../lib/format';
import { DISPUTE_VERDICT_LABELS } from '../lib/review';
import type { AttemptEventRow, AttemptEventType, DisputeRow, TestRunRow } from '../types';

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
  attemptId,
  attemptNumber,
  history,
  disputes,
  onCollapse,
}: {
  readme: string;
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
  attemptId,
  attemptNumber,
  history,
  disputes,
}: {
  attemptId: string;
  attemptNumber: number;
  history: TestRunRow[];
  disputes: DisputeRow[];
}) {
  const [events, setEvents] = useState<AttemptEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAttempt(attemptId)
      .then(({ events: got }) => {
        if (!cancelled) setEvents(got);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load attempt events');
      });
    return () => {
      cancelled = true;
    };
  }, [attemptId, history.length]);

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
                  <span className={run.failed === 0 ? 'run-pass' : 'run-fail'}>
                    {run.passed}/{run.total}
                  </span>
                ) : (
                  <span className={run.status === 'error' ? 'run-fail' : 'cell-dim'}>
                    {run.status}
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
    </div>
  );
}
