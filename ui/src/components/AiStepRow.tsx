import { useState } from 'react';
import { ApiError, getAiStep } from '../api';
import { formatDuration } from '../lib/format';
import type { AiStepRow as AiStepRowFull, AiStepStatus, AiStepSummary } from '../types';
import { AiStepBody } from './AiStepBody';

const STEP_GLYPHS: Record<AiStepStatus, string> = {
  done: '✓',
  error: '✕',
  skipped: '○',
  running: '●',
};

export type StepFetchState = 'idle' | 'loading' | 'loaded' | 'missing' | 'error';

/**
 * Controlled caret row (the PastReviewRow pattern from AiPanel.tsx).
 * Expanding lazily fetches the full step — prompt/response text never rides
 * the list or SSE — exactly once, mirroring SnapshotCode in History.tsx.
 */
export function AiStepRow({
  step,
  live,
}: {
  step: AiStepSummary;
  live: Map<string, string> | null;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<AiStepRowFull | null>(null);
  const [state, setState] = useState<StepFetchState>('idle');

  const load = () => {
    if (state !== 'idle') return;
    setState('loading');
    getAiStep(step.id)
      .then(({ step: s }) => {
        setFull(s);
        setState('loaded');
      })
      .catch((e: unknown) =>
        setState(e instanceof ApiError && e.status === 404 ? 'missing' : 'error'),
      );
  };

  // A skipped step's reason (and any step's outcome) travels in `detail`;
  // an errored step's message is the more useful line.
  const detail = (step.status === 'error' ? step.errorMessage : null) ?? step.detail;
  const duration =
    step.finishedAt != null
      ? formatDuration(Date.parse(step.finishedAt) - Date.parse(step.startedAt))
      : null;

  return (
    <li className={`ai-step ai-step-${step.status}`}>
      <button
        className="ai-step-row"
        onClick={() => {
          if (!open) load();
          setOpen((v) => !v);
        }}
      >
        <span className="ai-step-glyph">{STEP_GLYPHS[step.status]}</span>
        <span className="ai-step-label">{step.label}</span>
        <span className="ai-step-meta">
          {[detail, duration].filter((part) => part != null && part !== '').join(' · ')}
        </span>
        <span className="ai-step-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && <AiStepBody step={step} full={full} state={state} live={live} />}
    </li>
  );
}
