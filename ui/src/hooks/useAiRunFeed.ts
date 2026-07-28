import { useEffect, useRef, useState } from 'react';
import { getAiRuns } from '../api';
import { useSseEvent } from '../sse';
import type { AiRunRow, AiStepSummary } from '../types';

export type AiRunWithSteps = AiRunRow & { steps: AiStepSummary[] };

/** Per-(step, key) cap on live chunk text held in memory. */
const STEP_TEXT_MAX_LINES = 2000;

// Line-based front-drop cap — the appendCapped idiom from Room.tsx, applied
// per (step, key) so a chatty step can't grow the tab's memory without bound.
// The full text still persists server-side (GET /api/ai/steps/:id).
function appendCapped(prev: string, chunk: string): string {
  const next = prev + chunk;
  const lines = next.split('\n');
  if (lines.length <= STEP_TEXT_MAX_LINES) return next;
  return lines.slice(lines.length - STEP_TEXT_MAX_LINES).join('\n');
}

function isTerminalRun(run: AiRunRow): boolean {
  return run.status === 'done' || run.status === 'error';
}

function isTerminalStep(step: AiStepSummary): boolean {
  return step.status !== 'running';
}

/**
 * Union of two step lists by id, seq-ordered. When both sides carry a step,
 * the terminal copy wins — a snapshot and the SSE events that arrived while
 * it was in flight can resolve in either order.
 */
function mergeSteps(a: AiStepSummary[], b: AiStepSummary[]): AiStepSummary[] {
  const byId = new Map(a.map((s) => [s.id, s]));
  for (const s of b) {
    const cur = byId.get(s.id);
    if (cur == null || (!isTerminalStep(cur) && isTerminalStep(s))) byId.set(s.id, s);
  }
  return [...byId.values()].sort((x, y) => x.seq - y.seq);
}

export interface AiRunFeed {
  runs: AiRunWithSteps[];
  /** true once the seed fetch settled (success or failure) */
  loaded: boolean;
  /** Live streamed response text: stepId → key → accumulated (capped) text. */
  liveText: Map<string, Map<string, string>>;
}

/**
 * Live AI-run feed state, shared by the Activity screen (unfiltered) and the
 * per-job-card AiRunDrawer (refId-filtered). Seeded from the server on
 * mount, then kept live over SSE; re-seeded on every SSE `hello` because the
 * stream has no replay — chunks missed in a reconnect gap are unrecoverable
 * here, but the ≤1s-stale persisted text always is (expanded steps
 * lazy-fetch it). Also ticks a re-render once a second while any run is
 * still running, so elapsed labels advance.
 *
 * `filter` must be stable for the life of the caller: `refId` scopes the
 * seed/reseed GETs server-side and drops 'ai-run-started' events for other
 * refIds. Step-level events carry only runId, so foreign ones land in the
 * raced stashes below and simply never get applied.
 */
export function useAiRunFeed(filter: { refId?: string; limit?: number } = {}): AiRunFeed {
  const { refId, limit } = filter;
  const [runs, setRuns] = useState<AiRunWithSteps[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [, setTick] = useState(0);
  // Live streamed response text: stepId → key → accumulated (capped) text.
  // Deliberately never pruned on run end — the expanded body keeps showing
  // the freshest streamed text until a lazy fetch supersedes it.
  const [liveText, setLiveText] = useState<Map<string, Map<string, string>>>(new Map());

  // Two-level analogue of GenerationJobStrip.tsx's racedPatchesRef (the ref,
  // applyRaced's read-and-consume, patch's stash-on-miss) — see that file for
  // the full rationale. Mock mode resolves LLM calls in a microtask, so an
  // entire run (run-started … run-done) can complete before the seed GET
  // below resolves. Here the raced state is two-level: run patches, full
  // steps whose run row isn't seeded yet, and step patches — duplicated
  // rather than extracted because the read-and-consume ordering is exactly
  // what makes it correct.
  const racedRunPatchesRef = useRef<Map<string, Partial<AiRunRow>>>(new Map());
  const racedStepsRef = useRef<Map<string, AiStepSummary[]>>(new Map());
  const racedStepPatchesRef = useRef<Map<string, Partial<AiStepSummary>>>(new Map());

  /** Applies (and consumes) everything stashed for this run and its steps. */
  function applyRaced(run: AiRunWithSteps): AiRunWithSteps {
    const runPatch = racedRunPatchesRef.current.get(run.id);
    racedRunPatchesRef.current.delete(run.id);
    const racedSteps = racedStepsRef.current.get(run.id) ?? [];
    racedStepsRef.current.delete(run.id);
    const steps = mergeSteps(run.steps, racedSteps).map((s) => {
      const stepPatch = racedStepPatchesRef.current.get(s.id);
      if (stepPatch == null) return s;
      racedStepPatchesRef.current.delete(s.id);
      return { ...s, ...stepPatch };
    });
    return { ...run, ...runPatch, steps };
  }

  function mergeSnapshot(snapshot: AiRunWithSteps[]): void {
    setRuns((prev) => {
      const prevById = new Map(prev.map((r) => [r.id, r]));
      const merged = snapshot.map((r) => {
        const existing = prevById.get(r.id);
        prevById.delete(r.id);
        const withRaced = applyRaced(r);
        if (existing == null) return withRaced;
        // Prefer whichever side already reached a terminal state; steps are
        // unioned either way so a step missed in a reconnect gap still lands.
        const base =
          isTerminalRun(existing) || !isTerminalRun(withRaced) ? existing : withRaced;
        return { ...base, steps: mergeSteps(existing.steps, withRaced.steps) };
      });
      // Runs added via 'ai-run-started' while the fetch was in flight aren't
      // in the snapshot yet — they're newer, so they stay in front.
      return [...prevById.values(), ...merged];
    });
  }

  useEffect(() => {
    let cancelled = false;
    getAiRuns({ refId, limit })
      .then((res) => {
        if (!cancelled) mergeSnapshot(res.runs);
      })
      .catch(() => {
        // best-effort seed; SSE still keeps the feed live if this fails
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refId, limit]);

  // SSE reconnected (each connect sends hello): SseClient has no replay, so
  // run/step events in the gap are simply gone — reconcile from the server
  // (the Room.tsx hello idiom) so nothing can be stuck "running" forever.
  useSseEvent('hello', () => {
    getAiRuns({ refId, limit })
      .then((res) => mergeSnapshot(res.runs))
      .catch(() => {});
  });

  function upsertRun(run: AiRunWithSteps) {
    setRuns((prev) => {
      const withRaced = applyRaced(run);
      const idx = prev.findIndex((r) => r.id === run.id);
      if (idx === -1) return [withRaced, ...prev];
      const next = [...prev];
      next[idx] = { ...withRaced, steps: mergeSteps(prev[idx].steps, withRaced.steps) };
      return next;
    });
  }

  function patchRun(runId: string, patchFields: Partial<AiRunRow>) {
    setRuns((prev) => {
      const idx = prev.findIndex((r) => r.id === runId);
      if (idx === -1) {
        // Run row not seeded yet — stash so the seed fetch or a later
        // upsertRun() can apply it instead of dropping a terminal update.
        racedRunPatchesRef.current.set(runId, {
          ...racedRunPatchesRef.current.get(runId),
          ...patchFields,
        });
        return prev;
      }
      const next = [...prev];
      next[idx] = { ...next[idx], ...patchFields };
      return next;
    });
  }

  function patchStep(runId: string, stepId: string, patchFields: Partial<AiStepSummary>) {
    setRuns((prev) => {
      const runIdx = prev.findIndex((r) => r.id === runId);
      const stepIdx =
        runIdx === -1 ? -1 : prev[runIdx].steps.findIndex((s) => s.id === stepId);
      if (runIdx === -1 || stepIdx === -1) {
        // Step row not present anywhere yet (run unseeded, or the step's own
        // 'ai-step-started' was missed) — stash by stepId; applyRaced applies
        // it on top of whichever copy of the step lands first.
        racedStepPatchesRef.current.set(stepId, {
          ...racedStepPatchesRef.current.get(stepId),
          ...patchFields,
        });
        return prev;
      }
      const next = [...prev];
      const steps = [...next[runIdx].steps];
      steps[stepIdx] = { ...steps[stepIdx], ...patchFields };
      next[runIdx] = { ...next[runIdx], steps };
      return next;
    });
  }

  useSseEvent('ai-run-started', ({ run }) => {
    if (refId != null && run.refId !== refId) return;
    upsertRun({ ...run, steps: [] });
  });

  useSseEvent('ai-step-started', ({ runId, step }) => {
    setRuns((prev) => {
      const idx = prev.findIndex((r) => r.id === runId);
      if (idx === -1) {
        // Run row not seeded yet — stash the whole step (the two-level twist
        // on stash-on-miss: this one is a full row, not a patch).
        const list = racedStepsRef.current.get(runId) ?? [];
        racedStepsRef.current.set(runId, [...list, step]);
        return prev;
      }
      const next = [...prev];
      const stepPatch = racedStepPatchesRef.current.get(step.id);
      racedStepPatchesRef.current.delete(step.id);
      next[idx] = {
        ...next[idx],
        steps: mergeSteps(next[idx].steps, [{ ...step, ...stepPatch }]),
      };
      return next;
    });
  });

  useSseEvent('ai-step-chunk', ({ stepId, ops }) => {
    setLiveText((prev) => {
      const next = new Map(prev);
      const perKey = new Map(next.get(stepId));
      for (const op of ops) {
        if (op.op === 'set') perKey.set(op.key, appendCapped('', op.text));
        else perKey.set(op.key, appendCapped(perKey.get(op.key) ?? '', op.text));
      }
      next.set(stepId, perKey);
      return next;
    });
  });

  useSseEvent('ai-step-done', ({ runId, stepId, status, detail, errorMessage, finishedAt }) => {
    patchStep(runId, stepId, { status, detail, errorMessage, finishedAt });
  });

  useSseEvent('ai-run-done', ({ runId, status, errorMessage, finishedAt }) => {
    patchRun(runId, { status, errorMessage, finishedAt });
  });

  // Re-render once a second while anything is running, so elapsed labels advance.
  useEffect(() => {
    if (!runs.some((r) => r.status === 'running')) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [runs]);

  return { runs, loaded, liveText };
}
