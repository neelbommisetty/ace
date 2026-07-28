import { useEffect, useRef, useState } from 'react';
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
 * The one exception: a snapshot fetched mid-stream gets a single background
 * refresh once the step reaches a terminal status (see the effect below).
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
  // Guards the terminal refresh below to one settled attempt at a time, so a
  // snapshot that stays 'running' (finishAiStep is best-effort server-side)
  // can't loop the fetch.
  const refreshedRef = useRef(false);

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

  // A snapshot fetched mid-stream is frozen at 'running' and never catches up
  // on its own (the fetch-once guard above). Once SSE reports the step
  // terminal — via 'ai-step-done' or the hello reconcile — refresh in the
  // background: after a reconnect gap the live chunk buffer can be missing
  // text, and the persisted row (written before 'ai-step-done' is emitted) is
  // the only authoritative copy.
  useEffect(() => {
    if (!open || state !== 'loaded' || refreshedRef.current) return;
    if (full == null || full.status !== 'running' || step.status === 'running') return;
    refreshedRef.current = true;
    getAiStep(step.id)
      .then(({ step: s }) => setFull(s))
      .catch(() => {
        // Best-effort: the live text stays up; re-expanding retries.
        refreshedRef.current = false;
      });
  }, [open, state, full, step.status, step.id]);

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
