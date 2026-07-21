import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, getGenerationJobs, retryGenerationJob } from '../api';
import { categoryShortName } from '../lib/categories';
import { formatClock } from '../lib/format';
import { useSseEvent } from '../sse';
import type { GenerationJobRow } from '../types';

function isActive(job: GenerationJobRow): boolean {
  return job.status === 'running' || job.status === 'llm_done';
}

function elapsedLabel(createdAt: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 1000));
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

  useEffect(() => {
    let cancelled = false;
    getGenerationJobs()
      .then((res) => {
        if (!cancelled) setJobs(res.jobs);
      })
      .catch(() => {
        // best-effort seed; SSE still keeps the strip live if this fails
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function upsert(job: GenerationJobRow) {
    setJobs((prev) => {
      const idx = prev.findIndex((j) => j.id === job.id);
      if (idx === -1) return [job, ...prev];
      const next = [...prev];
      next[idx] = job;
      return next;
    });
  }

  function patch(jobId: string, patchFields: Partial<GenerationJobRow>) {
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...patchFields } : j)));
  }

  useSseEvent('generation-started', ({ job }) => {
    upsert(job);
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

  return (
    <div className="job-strip">
      {jobs.map((job) => (
        <GenerationJobCard key={job.id} job={job} onUpdate={(fields) => patch(job.id, fields)} />
      ))}
    </div>
  );
}

function GenerationJobCard({
  job,
  onUpdate,
}: {
  job: GenerationJobRow;
  onUpdate: (fields: Partial<GenerationJobRow>) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  async function onRetry() {
    setRetrying(true);
    setRetryError(null);
    try {
      await retryGenerationJob(job.id);
      // The engine re-emits 'generation-started' right away; this optimistic
      // flip just avoids a stale error card in the gap before that arrives.
      onUpdate({ status: 'running', errorMessage: null });
    } catch (err) {
      setRetryError(err instanceof ApiError ? err.message : 'retry failed');
    } finally {
      setRetrying(false);
    }
  }

  const label = job.title ?? job.topic;

  if (isActive(job)) {
    return (
      <div className="job-card job-card-running" data-testid={`job-card-${job.id}`}>
        <span className="pulse-dot" aria-hidden="true" />
        <div className="job-card-info">
          <div className="job-card-title">{label}</div>
          <div className="job-card-meta">
            {categoryShortName(job.category)} · generating… {elapsedLabel(job.createdAt)}
          </div>
        </div>
      </div>
    );
  }

  if (job.status === 'done') {
    return (
      <div className="job-card job-card-done" data-testid={`job-card-${job.id}`}>
        <div className="job-card-info">
          <div className="job-card-title">{label}</div>
          <div className="job-card-meta">{categoryShortName(job.category)} · ready</div>
        </div>
        <Link className="btn btn-small" to={`/q/${job.category}/${job.slug}`}>
          Open room →
        </Link>
      </div>
    );
  }

  // status === 'error' — a job that got a title has a persisted LLM result,
  // so retrying it is scaffold-only (no re-spend); one that never got that
  // far needs a full re-run.
  const resumable = job.title != null;
  return (
    <div className="job-card job-card-error" data-testid={`job-card-${job.id}`}>
      <div className="job-card-info">
        <div className="job-card-title">{label}</div>
        <div className="job-card-meta error-note">{job.errorMessage ?? 'generation failed'}</div>
        {retryError && <div className="job-card-meta error-note">{retryError}</div>}
      </div>
      <button className="btn btn-small" onClick={onRetry} disabled={retrying}>
        {resumable ? 'Retry (no new LLM call)' : 'Retry'}
      </button>
    </div>
  );
}
