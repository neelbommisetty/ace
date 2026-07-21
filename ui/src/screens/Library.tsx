import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getGenerationJobs, getQuestions, getWorkspace } from '../api';
import { ImportBanner } from '../components/ImportBanner';
import { QuestionTable } from '../components/QuestionTable';
import { ResumeCard } from '../components/ResumeCard';
import { CATEGORY_SLUGS, categoryShortName } from '../lib/categories';
import { useSseEvent } from '../sse';
import type { QuestionStatus, QuestionWithStats, WorkspaceInfo } from '../types';

type StatusFilter = 'all' | QuestionStatus;

export function Library() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [questions, setQuestions] = useState<QuestionWithStats[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [generatingCount, setGeneratingCount] = useState(0);

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
    getGenerationJobs()
      .then((res) => {
        const active = res.jobs.filter(
          (j) => j.status === 'running' || j.status === 'llm_done',
        ).length;
        setGeneratingCount(active);
      })
      .catch(() => {
        // best-effort seed; SSE keeps the pill live even if this fails
      });
  }, []);

  useSseEvent('questions-changed', refetch);

  // No per-event fetch: the pill is a running count driven purely by the
  // start/finish SSE events, seeded once above from the server.
  useSseEvent('generation-started', () => setGeneratingCount((c) => c + 1));
  useSseEvent('generation-done', () => setGeneratingCount((c) => Math.max(0, c - 1)));
  useSseEvent('generation-error', () => setGeneratingCount((c) => Math.max(0, c - 1)));

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
          <Link className="btn btn-accent btn-small" to="/new">
            New question
          </Link>
          {workspace != null && (
            <span className="workspace-root mono" title="Workspace root">
              {workspace.root}
            </span>
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
                <option value="not-started">Not started</option>
                <option value="in-progress">In progress</option>
                <option value="green">Green</option>
              </select>
            </div>
            {questions.length === 0 ? (
              <div className="empty-state">
                <p className="empty-title">No questions yet</p>
                <p className="empty-hint">
                  Describe what you want to practice and ACE will generate it for you.
                </p>
                <Link className="btn btn-accent" to="/new">
                  Create your first question
                </Link>
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
