import { useAiRunFeed } from '../hooks/useAiRunFeed';
import { AiRunCard } from './AiRunCard';

/**
 * Inline step log for one generation job (NEE-272), embedded under its card
 * in GenerationJobStrip. The parent mounts it on FIRST expand and keeps it
 * mounted (hidden) across collapses, so the refId-filtered seed fetch runs
 * exactly once; from then on it lives on the same SSE events as the Activity
 * screen. retry() mints a NEW ai_runs row with the same refId, so after a
 * retry both attempts list here, newest first.
 */
export function AiRunDrawer({ refId }: { refId: string }) {
  const { runs, loaded, liveText } = useAiRunFeed({ refId, limit: 5 });

  return (
    <div className="ai-run-drawer" data-testid={`ai-run-drawer-${refId}`}>
      {!loaded && <div className="pane-empty">Loading step log…</div>}
      {loaded && runs.length === 0 && (
        // Jobs that predate the activity log (NEE-268) have no runs at all.
        <div className="pane-empty">
          No step log for this job (it ran before activity logging).
        </div>
      )}
      {runs.map((run) => (
        <AiRunCard key={run.id} run={run} liveText={liveText} />
      ))}
    </div>
  );
}
