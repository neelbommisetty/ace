import { AiRunCard } from '../components/AiRunCard';
import { useAiRunFeed } from '../hooks/useAiRunFeed';

export type { AiRunWithSteps } from '../hooks/useAiRunFeed';

/**
 * /activity — the live AI run feed. All feed state (seed fetch, SSE
 * handlers, hello reconcile, live chunk buffers, raced-event stashes) lives
 * in useAiRunFeed, shared with the per-job-card AiRunDrawer; this screen is
 * just the unfiltered rendering of it.
 */
export function Activity() {
  const { runs, loaded, liveText } = useAiRunFeed();

  return (
    <div className="activity-screen">
      <header className="topbar">
        <div className="topbar-left">
          <h1 className="topbar-title">Activity</h1>
          {loaded && (
            <span className="topbar-count">
              {runs.length} {runs.length === 1 ? 'run' : 'runs'}
            </span>
          )}
        </div>
      </header>
      <div className="library-scroll">
        {!loaded && <div className="pane-empty">Loading AI activity…</div>}
        {loaded && runs.length === 0 && (
          <div className="empty-state">
            <p className="empty-title">No AI activity yet</p>
            <p className="empty-hint">
              Every LLM call — generation, review, dispute, brainstorm — shows up here as it runs.
            </p>
          </div>
        )}
        {runs.map((run) => (
          <AiRunCard key={run.id} run={run} liveText={liveText} />
        ))}
      </div>
    </div>
  );
}
