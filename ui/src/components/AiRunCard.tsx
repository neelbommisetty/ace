import { formatClock } from '../lib/format';
import type { AiRunWithSteps } from '../hooks/useAiRunFeed';
import { AiStepList } from './AiStepList';

function elapsedLabel(startedAt: string, finishedAt: string | null): string {
  const end = finishedAt != null ? Date.parse(finishedAt) : Date.now();
  return formatClock(Math.max(0, Math.floor((end - Date.parse(startedAt)) / 1000)));
}

/** One AI run: kind chip, label, status + elapsed, then its step log. */
export function AiRunCard({
  run,
  liveText,
}: {
  run: AiRunWithSteps;
  liveText: Map<string, Map<string, string>>;
}) {
  const running = run.status === 'running';
  return (
    <div className={`ai-run-card ai-run-card-${run.status}`} data-testid={`ai-run-card-${run.id}`}>
      <div className="ai-run-head">
        {running && <span className="pulse-dot" aria-hidden="true" />}
        <span className="chip ai-kind-chip">{run.kind}</span>
        <span className="ai-run-label">{run.label}</span>
        <span className="ai-run-meta">
          {run.status} · <span className="mono">{elapsedLabel(run.startedAt, run.finishedAt)}</span>
        </span>
      </div>
      {run.status === 'error' && run.errorMessage != null && (
        <div className="error-note">{run.errorMessage}</div>
      )}
      {/* A zero-step errored run (e.g. no API key) renders as just the error note above. */}
      <AiStepList steps={run.steps} liveText={liveText} />
    </div>
  );
}
