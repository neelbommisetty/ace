import type { AiStepSummary } from '../types';
import { AiStepRow } from './AiStepRow';

/**
 * Ordered step log plus the progress indicator. Deliberately NOT a
 * percentage bar: the total step count is unknowable up front (the
 * verify/repair loop is 1–5 steps), so a stepper renders one segment per
 * known-so-far step instead — the active one carries the pulse dot.
 * DimensionBars (ReviewBadge.tsx) is the styling reference only.
 */
export function AiStepList({
  steps,
  liveText,
}: {
  steps: AiStepSummary[];
  liveText: Map<string, Map<string, string>>;
}) {
  if (steps.length === 0) return null;
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  return (
    <div className="ai-step-log">
      <div className="ai-stepper" aria-hidden="true">
        {ordered.map((s) => (
          <span key={s.id} className={`ai-stepper-seg ai-stepper-${s.status}`} title={s.label}>
            {s.status === 'running' && <span className="pulse-dot" />}
          </span>
        ))}
      </div>
      <ul className="ai-step-rows">
        {ordered.map((s) => (
          <AiStepRow key={s.id} step={s} live={liveText.get(s.id) ?? null} />
        ))}
      </ul>
    </div>
  );
}
