import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { getGenerationJobs, getQuestions, getSettings, getWorkspace, installStarterPack } from '../api';
import { ImportBanner } from '../components/ImportBanner';
import { QuestionTable } from '../components/QuestionTable';
import { ResumeCard } from '../components/ResumeCard';
import { CATEGORY_SLUGS, categoryShortName } from '../lib/categories';
import { openWorkspaceSwitchDialog } from '../lib/switchSignal';
import { useSseEvent } from '../sse';
import type { QuestionStatus, QuestionWithStats, SettingsInfo, WorkspaceInfo } from '../types';

type StatusFilter = 'all' | QuestionStatus;

export function Library() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [questions, setQuestions] = useState<QuestionWithStats[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // Null until the settings fetch lands (or if it fails). Only a CONFIRMED
  // keyless workspace repoints the empty-state CTA at Settings — while the
  // answer is unknown, /new stays the primary action and NewQuestion's own
  // keyless notice remains the backstop.
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [addingSamples, setAddingSamples] = useState(false);
  const [samplesNote, setSamplesNote] = useState<string | null>(null);
  // Tracked by job id (not a running +/-1 counter) so a missed/reordered SSE
  // event can't permanently skew the count, and so the seed fetch below can
  // merge with — rather than clobber — whatever the live SSE handlers have
  // already applied.
  const [activeJobIds, setActiveJobIds] = useState<Set<string>>(new Set());
  // Ids whose 'generation-done'/'generation-error' arrived before the seed
  // fetch resolved (mock mode can finish a job in a microtask, well inside
  // the seed GET's round-trip) — consulted so the seed doesn't resurrect a
  // job that has already finished.
  const settledWhileSeedingRef = useRef<Set<string>>(new Set());

  const refetch = useCallback(() => {
    Promise.all([getWorkspace(), getQuestions()])
      .then(([ws, qs]) => {
        setWorkspace(ws);
        setQuestions(qs);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load workspace');
      });
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((info) => {
        if (!cancelled) setSettings(info);
      })
      .catch(() => {
        // Best effort: an unknown provider state keeps the default CTA.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const keyless =
    settings != null &&
    !settings.mockMode &&
    !settings.openai.configured &&
    !settings.anthropic.configured;

  const addStarterQuestions = useCallback(() => {
    setAddingSamples(true);
    setSamplesNote(null);
    installStarterPack()
      .then((result) => {
        if (result.installed.length === 0) {
          setSamplesNote(
            result.unavailable.length > 0
              ? 'The starter questions are missing from this ACE install.'
              : 'The starter questions are already in this workspace.',
          );
        }
        refetch();
      })
      .catch((e: unknown) => {
        setSamplesNote(e instanceof Error ? e.message : 'Could not add the starter questions');
      })
      .finally(() => {
        setAddingSamples(false);
      });
  }, [refetch]);

  useEffect(() => {
    getGenerationJobs()
      .then((res) => {
        setActiveJobIds((prev) => {
          const next = new Set(prev); // keep ids added via SSE mid-fetch
          for (const j of res.jobs) {
            const active = j.status === 'running' || j.status === 'llm_done';
            if (active && !settledWhileSeedingRef.current.has(j.id)) next.add(j.id);
          }
          settledWhileSeedingRef.current.clear();
          return next;
        });
      })
      .catch(() => {
        // best-effort seed; SSE keeps the pill live even if this fails
      });
  }, []);

  useSseEvent('questions-changed', refetch);

  // No per-event fetch: the pill is driven purely by the start/finish SSE
  // events, seeded once above from the server, and tracked by job id so a
  // stray/duplicate event can't skew the count.
  useSseEvent('generation-started', ({ job }) => {
    setActiveJobIds((prev) => (prev.has(job.id) ? prev : new Set(prev).add(job.id)));
  });
  const settle = useCallback((jobId: string) => {
    setActiveJobIds((prev) => {
      if (!prev.has(jobId)) {
        // Not seeded yet — this finished before the mount-time GET resolved;
        // remember it so that GET doesn't re-add it once it lands.
        settledWhileSeedingRef.current.add(jobId);
        return prev;
      }
      const next = new Set(prev);
      next.delete(jobId);
      return next;
    });
  }, []);
  useSseEvent('generation-done', ({ jobId }) => settle(jobId));
  useSseEvent('generation-error', ({ jobId }) => settle(jobId));

  const generatingCount = activeJobIds.size;

  const visible = useMemo(() => {
    if (questions == null) return [];
    return questions
      .filter((q) => q.archivedAt == null)
      .filter((q) => categoryFilter == null || q.category === categoryFilter)
      .filter((q) => statusFilter === 'all' || q.stats.status === statusFilter)
      .sort((a, b) => {
        const at = a.stats.lastActivityAt ?? a.createdAt;
        const bt = b.stats.lastActivityAt ?? b.createdAt;
        return bt.localeCompare(at);
      });
  }, [questions, categoryFilter, statusFilter]);

  const loading = workspace == null && questions == null && error == null;

  return (
    <div className="library">
      <header className="topbar">
        <div className="topbar-left">
          <h1 className="topbar-title">Library</h1>
          {questions != null && (
            <span className="topbar-count">
              {questions.length} {questions.length === 1 ? 'question' : 'questions'}
            </span>
          )}
        </div>
        <div className="topbar-right">
          {generatingCount > 0 && (
            <span className="chip generating-pill">
              <span className="pulse-dot" aria-hidden="true" />
              {generatingCount} generating…
            </span>
          )}
          {workspace != null && (
            <button
              className="workspace-switch-btn mono"
              title={`${workspace.root} — switch workspace (⌘K)`}
              onClick={openWorkspaceSwitchDialog}
            >
              {workspace.confirmName}
            </button>
          )}
        </div>
      </header>
      <div className="library-scroll">
        {error != null && (
          <div className="error-note">
            {error}{' '}
            <button className="btn btn-small" onClick={refetch}>
              Retry
            </button>
          </div>
        )}
        {loading && <div className="pane-empty">Loading library…</div>}
        {workspace?.legacyImport.available && (
          <ImportBanner
            questionCount={workspace.legacyImport.questionCount}
            onImported={refetch}
          />
        )}
        {workspace?.activeAttempt != null && (
          <ResumeCard
            attempt={workspace.activeAttempt.attempt}
            question={workspace.activeAttempt.question}
          />
        )}
        {questions != null && (
          <>
            <div className="filter-row">
              <div className="filter-pills">
                <button
                  className={`pill ${categoryFilter == null ? 'active' : ''}`}
                  onClick={() => setCategoryFilter(null)}
                >
                  All
                </button>
                {CATEGORY_SLUGS.map((slug) => (
                  <button
                    key={slug}
                    className={`pill ${categoryFilter === slug ? 'active' : ''}`}
                    onClick={() => setCategoryFilter(categoryFilter === slug ? null : slug)}
                  >
                    {categoryShortName(slug)}
                  </button>
                ))}
              </div>
              <select
                className="status-select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                title="Filter by status"
              >
                <option value="all">All statuses</option>
                <option value="not-attempted">Not attempted</option>
                <option value="in-progress">In progress</option>
                <option value="solved">Solved</option>
              </select>
            </div>
            {questions.length === 0 ? (
              <div className="empty-state">
                <p className="empty-title">No questions yet</p>
                <p className="empty-hint">
                  {keyless
                    ? 'Generating questions needs a provider API key. The bundled starter questions need nothing at all.'
                    : 'Describe what you want to practice and ACE will generate it for you.'}
                </p>
                <div className="empty-actions">
                  {keyless ? (
                    <Link className="btn btn-accent" to="/settings">
                      Add an API key
                    </Link>
                  ) : (
                    <Link className="btn btn-accent" to="/new">
                      Create your first question
                    </Link>
                  )}
                  {/* Always available — no key, no network, no cost. */}
                  <button className="btn" onClick={addStarterQuestions} disabled={addingSamples}>
                    {addingSamples ? 'Adding…' : 'Add starter questions'}
                  </button>
                </div>
                {samplesNote != null && <p className="empty-note">{samplesNote}</p>}
              </div>
            ) : visible.length === 0 ? (
              <div className="empty-state">
                <p className="empty-title">Nothing matches these filters</p>
                <p className="empty-hint">Try clearing the category or status filter.</p>
              </div>
            ) : (
              <QuestionTable questions={visible} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
