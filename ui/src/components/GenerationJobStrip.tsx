import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, getGenerationJobs, retryGenerationJob } from '../api';
import { useCancellableEffect } from '../hooks/useCancellableEffect';
import { AiRunDrawer } from './AiRunDrawer';
import { categoryShortName } from '../lib/categories';
import { formatClock } from '../lib/format';
import { useSseEvent } from '../sse';
import type { GenerationJobRow } from '../types';

function isActive(job: GenerationJobRow): boolean {
  return job.status === 'running' || job.status === 'llm_done';
}

interface JobPhase {
  phase: 'generating' | 'auditing' | 'verifying' | 'repairing';
  attempt: number;
}

function phaseLabel(p: JobPhase | undefined): string {
  if (!p) return 'generating…';
  switch (p.phase) {
    case 'generating':
      return 'writing question…';
    case 'auditing':
      return 'auditing edge cases…';
    case 'verifying':
      return 'running tests…';
    case 'repairing':
      return `fixing tests (attempt ${p.attempt}/3)…`;
  }
}

function isTerminal(job: GenerationJobRow): boolean {
  return job.status === 'done' || job.status === 'error';
}

// Dismissed-card ids (NEE-309): the server keeps returning terminal jobs up
// to its GET limit (20), so the strip filters them out on the client instead.
// Persisted in localStorage — a dismissed card stays dismissed across a
// reload — and keyed by job id so re-running/retrying the same job (a fresh
// id) isn't affected by a prior dismissal.
const DISMISSED_KEY = 'ace-dismissed-generation-jobs';

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (raw == null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v) => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // best-effort persistence only
  }
}

// Anchored to the current run (runStartedAt) rather than job creation, so a
// retried job's clock restarts at 0:00 instead of counting from the original
// attempt (NEE-277); the caller falls back to createdAt when the server
// predates the field.
function elapsedLabel(startedAt: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  return formatClock(secs);
}

/**
 * Persistent strip of generation-job cards. Seeded from the server on mount
 * so a page reload mid-job still shows progress, then kept live over SSE.
 * `generation-started` carries the full row so a job kicked off in another
 * tab renders a complete card here with no follow-up fetch.
 */
export function GenerationJobStrip() {
  const [jobs, setJobs] = useState<GenerationJobRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [, setTick] = useState(0);
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());

  const dismiss = (jobId: string) => {
    setDismissed((prev) => {
      const next = new Set(prev).add(jobId);
      saveDismissed(next);
      return next;
    });
  };
  // Ephemeral pipeline phase per jobId — SSE-only local state (not on the job
  // row): after a reload active cards just show the generic label again.
  const [phases, setPhases] = useState<Map<string, JobPhase>>(new Map());

  // 'generation-done'/'generation-error' patches that arrived for a jobId
  // not yet in `jobs` — e.g. the mount-time GET below is still in flight, or
  // (for retry) the POST hasn't resolved yet — get stashed here instead of
  // silently dropped, and applied on top of the next snapshot/upsert for
  // that id. Mock mode routinely resolves the LLM call in a microtask, so
  // 'generation-done' can beat both the seed fetch and a retry POST's own
  // response.
  const racedPatchesRef = useRef<Map<string, Partial<GenerationJobRow>>>(new Map());

  useCancellableEffect((cancelled) => {
    getGenerationJobs()
      .then((res) => {
        if (cancelled()) return;
        setJobs((prev) => {
          const prevById = new Map(prev.map((j) => [j.id, j]));
          const merged = res.jobs.map((j) => {
            const existing = prevById.get(j.id);
            prevById.delete(j.id);
            const withRaced = applyRaced(j.id, j);
            if (existing == null) return withRaced;
            // Prefer whichever side already reached a terminal state — the
            // GET and any SSE events that arrived while it was in flight can
            // resolve in either order.
            return isTerminal(existing) || !isTerminal(withRaced) ? existing : withRaced;
          });
          // Jobs added via 'generation-started' (e.g. from another tab)
          // while this fetch was in flight aren't in the snapshot yet.
          return [...prevById.values(), ...merged];
        });
      })
      .catch(() => {
        // best-effort seed; SSE still keeps the strip live if this fails
      })
      .finally(() => {
        if (!cancelled()) setLoaded(true);
      });
  }, []);

  /** Applies (and consumes) any patch stashed for `jobId` by `patch()` below. */
  function applyRaced(jobId: string, job: GenerationJobRow): GenerationJobRow {
    const raced = racedPatchesRef.current.get(jobId);
    if (raced == null) return job;
    racedPatchesRef.current.delete(jobId);
    return { ...job, ...raced };
  }

  function upsert(job: GenerationJobRow) {
    setJobs((prev) => {
      const withRaced = applyRaced(job.id, job);
      const idx = prev.findIndex((j) => j.id === job.id);
      if (idx === -1) return [withRaced, ...prev];
      const next = [...prev];
      next[idx] = withRaced;
      return next;
    });
  }

  function patch(jobId: string, patchFields: Partial<GenerationJobRow>) {
    setJobs((prev) => {
      const idx = prev.findIndex((j) => j.id === jobId);
      if (idx === -1) {
        // Base row not seeded yet — stash so the seed fetch or a later
        // upsert() can apply it instead of dropping a terminal update.
        racedPatchesRef.current.set(jobId, {
          ...racedPatchesRef.current.get(jobId),
          ...patchFields,
        });
        return prev;
      }
      const next = [...prev];
      next[idx] = { ...next[idx], ...patchFields };
      return next;
    });
  }

  useSseEvent('generation-started', ({ job }) => {
    upsert(job);
    // A (re)started run owes its own progress events — drop any stale phase
    // from a previous failed run (a scaffold-only resume emits none at all).
    setPhases((prev) => {
      if (!prev.has(job.id)) return prev;
      const next = new Map(prev);
      next.delete(job.id);
      return next;
    });
  });

  useSseEvent('generation-progress', ({ jobId, phase, attempt }) => {
    setPhases((prev) => new Map(prev).set(jobId, { phase, attempt }));
  });

  useSseEvent('generation-done', ({ jobId, question }) => {
    patch(jobId, {
      status: 'done',
      questionId: question.id,
      slug: question.slug,
      category: question.category,
      title: question.title,
    });
  });

  useSseEvent('generation-error', ({ jobId, message }) => {
    patch(jobId, { status: 'error', errorMessage: message });
  });

  // Re-render once a second while anything is actively generating, so the
  // elapsed-time label on running cards advances.
  useEffect(() => {
    if (!jobs.some(isActive)) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [jobs]);

  if (!loaded || jobs.length === 0) return null;

  const visibleJobs = jobs.filter((job) => !dismissed.has(job.id));
  if (visibleJobs.length === 0) return null;

  const anyFinished = visibleJobs.some(isTerminal);

  return (
    <div className="job-strip">
      {anyFinished && (
        <div className="job-strip-actions">
          <button
            className="btn btn-small"
            onClick={() => {
              setDismissed((prev) => {
                const next = new Set(prev);
                for (const job of visibleJobs) if (isTerminal(job)) next.add(job.id);
                saveDismissed(next);
                return next;
              });
            }}
          >
            Clear finished
          </button>
        </div>
      )}
      {visibleJobs.map((job) => (
        <GenerationJobCard
          key={job.id}
          job={job}
          jobPhase={phases.get(job.id)}
          onDismiss={isTerminal(job) ? () => dismiss(job.id) : undefined}
        />
      ))}
    </div>
  );
}

function GenerationJobCard({
  job,
  jobPhase,
  onDismiss,
}: {
  job: GenerationJobRow;
  jobPhase?: JobPhase;
  onDismiss?: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // Step-log drawer (NEE-272). `everOpened` keeps the drawer MOUNTED (just
  // hidden) across collapses, so its one-time seed fetch isn't repeated and
  // SSE keeps it current while collapsed.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);

  async function onRetry() {
    setRetrying(true);
    setRetryError(null);
    try {
      await retryGenerationJob(job.id);
      // No optimistic status flip here: the engine emits 'generation-started'
      // synchronously before this POST even responds, and — for a
      // scaffold-only resume — 'generation-done' can follow within the same
      // tick (mock LLM resolves in a microtask). Both events reach this strip
      // over the same ordered SSE stream ahead of or shortly after this
      // await resolves; flipping status here too could overwrite a
      // 'generation-done' that already landed, sticking the card on
      // "running" forever.
    } catch (err) {
      setRetryError(err instanceof ApiError ? err.message : 'retry failed');
    } finally {
      setRetrying(false);
    }
  }

  const label = job.title ?? job.topic;

  // Caret toggling the inline step log — the same log /activity shows,
  // brought to where the user already is when a generation starts.
  const caret = (
    <button
      className="icon-btn job-card-caret"
      aria-label={drawerOpen ? 'Hide step log' : 'Show step log'}
      aria-expanded={drawerOpen}
      title={drawerOpen ? 'Hide step log' : 'Show step log'}
      onClick={() => {
        setEverOpened(true);
        setDrawerOpen((v) => !v);
      }}
    >
      {drawerOpen ? '▾' : '▸'}
    </button>
  );
  const dismissBtn = onDismiss ? (
    <button
      className="icon-btn job-card-dismiss"
      aria-label="Dismiss card"
      title="Dismiss"
      onClick={onDismiss}
    >
      ×
    </button>
  ) : null;
  const drawer = everOpened ? (
    <div className="job-card-drawer" hidden={!drawerOpen} data-testid={`job-drawer-${job.id}`}>
      <AiRunDrawer refId={job.id} />
    </div>
  ) : null;

  if (isActive(job)) {
    return (
      <div className="job-card-block">
        <div className="job-card job-card-running" data-testid={`job-card-${job.id}`}>
          <span className="pulse-dot" aria-hidden="true" />
          <div className="job-card-info">
            <div className="job-card-title">{label}</div>
            <div className="job-card-meta">
              {categoryShortName(job.category)} · {phaseLabel(jobPhase)}{' '}
              {elapsedLabel(job.runStartedAt ?? job.createdAt)}
            </div>
          </div>
          {caret}
        </div>
        {drawer}
      </div>
    );
  }

  if (job.status === 'done') {
    return (
      <div className="job-card-block">
        <div className="job-card job-card-done" data-testid={`job-card-${job.id}`}>
          <div className="job-card-info">
            <div className="job-card-title">{label}</div>
            <div className="job-card-meta">{categoryShortName(job.category)} · ready</div>
          </div>
          <Link className="btn btn-small" to={`/q/${job.category}/${job.slug}`}>
            Open room →
          </Link>
          {caret}
          {dismissBtn}
        </div>
        {drawer}
      </div>
    );
  }

  // status === 'error' — a job that got a title has a persisted LLM result,
  // so retrying it is scaffold-only (no re-spend); one that never got that
  // far needs a full re-run.
  const resumable = job.title != null;
  return (
    <div className="job-card-block">
      <div className="job-card job-card-error" data-testid={`job-card-${job.id}`}>
        <div className="job-card-info">
          <div className="job-card-title">{label}</div>
          <div className="job-card-meta error-note">{job.errorMessage ?? 'generation failed'}</div>
          {retryError && <div className="job-card-meta error-note">{retryError}</div>}
        </div>
        <button className="btn btn-small" onClick={onRetry} disabled={retrying}>
          {resumable ? 'Retry (no new LLM call)' : 'Retry'}
        </button>
        {caret}
        {dismissBtn}
      </div>
      {drawer}
    </div>
  );
}
