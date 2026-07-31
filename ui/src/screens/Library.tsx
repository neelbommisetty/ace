import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  archiveQuestion,
  createPlayground,
  getGenerationJobs,
  getQuestions,
  getSettings,
  getWorkspace,
  installStarterPack,
  unarchiveQuestion,
} from '../api';
import { ImportBanner } from '../components/ImportBanner';
import { PracticeNextCard } from '../components/PracticeNextCard';
import { QuestionTable } from '../components/QuestionTable';
import { ResumeCard } from '../components/ResumeCard';
import { showActionToast } from '../components/Toast';
import { CATEGORY_SLUGS, categoryShortName } from '../lib/categories';
import {
  DEFAULT_SORT_DIR,
  libraryOrderQueryString,
  orderedQuestions,
  parseDifficultyFilter,
  parseSortKey,
  parseStatusFilter,
  type SortDir,
  type SortKey,
} from '../lib/libraryOrder';
import { pickPracticeNext } from '../lib/practiceNext';
import { openWorkspaceSwitchDialog } from '../lib/switchSignal';
import { useSseEvent } from '../sse';
import type { QuestionWithStats, SettingsInfo, WorkspaceInfo } from '../types';

const SEARCH_DEBOUNCE_MS = 300;

export function Library() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [questions, setQuestions] = useState<QuestionWithStats[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filters/search/sort live in the URL (NEE-298), matching History
  // (History.tsx:21-43) so Back/forward and bookmarking work for free and
  // survive navigating into a room and back.
  const categoryFilter = searchParams.get('category') ?? '';
  const statusFilter = parseStatusFilter(searchParams.get('status'));
  const difficultyFilter = parseDifficultyFilter(searchParams.get('difficulty'));
  const searchQuery = searchParams.get('q') ?? '';
  const sortKey = parseSortKey(searchParams.get('sort'));
  const rawDir = searchParams.get('dir');
  const sortDir: SortDir = rawDir === 'asc' || rawDir === 'desc' ? rawDir : DEFAULT_SORT_DIR[sortKey];

  const updateParams = useCallback(
    (patch: Record<string, string>) => {
      // Functional update: a debounced ?q= commit (below) must not resurrect
      // the params of the render it was scheduled in.
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v) next.set(k, v);
            else next.delete(k);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Debounced search input → ?q=, mirroring History.tsx.
  const [searchInput, setSearchInput] = useState(searchQuery);
  useEffect(() => {
    setSearchInput(searchQuery);
    // resync only when the param changes from outside (back/forward, Clear filters)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);
  useEffect(() => {
    if (searchInput === searchQuery) return;
    const t = window.setTimeout(() => updateParams({ q: searchInput }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const handleSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) {
        updateParams({ sort: key, dir: sortDir === 'asc' ? 'desc' : 'asc' });
      } else {
        updateParams({ sort: key, dir: DEFAULT_SORT_DIR[key] });
      }
    },
    [sortKey, sortDir, updateParams],
  );

  const activeFilterCount = [
    categoryFilter !== '',
    statusFilter !== 'all',
    difficultyFilter !== 'all',
    searchQuery !== '',
  ].filter(Boolean).length;

  const clearFilters = useCallback(() => {
    setSearchInput(''); // avoid the debounce effect re-committing stale text over the clear
    updateParams({ category: '', status: '', difficulty: '', q: '' });
  }, [updateParams]);

  // Null until the settings fetch lands (or if it fails). Only a CONFIRMED
  // keyless workspace repoints the empty-state CTA at Settings — while the
  // answer is unknown, /new stays the primary action and NewQuestion's own
  // keyless notice remains the backstop.
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [addingSamples, setAddingSamples] = useState(false);
  const [samplesNote, setSamplesNote] = useState<string | null>(null);
  // 'Playground ▾' topbar dropdown (NEE-387): a zero-LLM scratch pad, so the
  // only async state is the scaffold POST itself — no refetch needed since a
  // successful create navigates straight into the new room.
  const [playgroundMenuOpen, setPlaygroundMenuOpen] = useState(false);
  const [creatingPlayground, setCreatingPlayground] = useState(false);
  const playgroundMenuRef = useRef<HTMLDivElement>(null);
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

  // Close on outside click — mirrors TestConsole's CaseKebab pattern.
  useEffect(() => {
    if (!playgroundMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (playgroundMenuRef.current != null && !playgroundMenuRef.current.contains(e.target as Node)) {
        setPlaygroundMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [playgroundMenuOpen]);

  const handleCreatePlayground = useCallback(
    (kind: 'react' | 'ts') => {
      setCreatingPlayground(true);
      createPlayground(kind)
        .then(({ category, slug }) => {
          setPlaygroundMenuOpen(false);
          navigate(`/q/${category}/${slug}`);
        })
        .catch((e: unknown) => {
          setPlaygroundMenuOpen(false);
          setError(e instanceof Error ? e.message : 'Failed to create the playground');
        })
        .finally(() => {
          setCreatingPlayground(false);
        });
    },
    [navigate],
  );

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

  // The 'Archived' filter is the only view where archivedAt != null rows
  // show up at all — everywhere else they're hidden by default (NEE-296).
  const visible = useMemo(() => {
    if (questions == null) return [];
    return orderedQuestions(questions, {
      category: categoryFilter,
      status: statusFilter,
      difficulty: difficultyFilter,
      search: searchQuery,
      sortKey,
      sortDir,
    });
  }, [questions, categoryFilter, statusFilter, difficultyFilter, searchQuery, sortKey, sortDir]);

  // Carried onward into the room (NEE-310) so prev/next and "Next question"
  // can recompute this exact ordering without a Library round trip.
  const linkQuery = useMemo(() => libraryOrderQueryString(searchParams), [searchParams]);

  // Pure heuristic over the already-fetched stats (NEE-310) — null hides the
  // card entirely (nothing left unsolved to suggest).
  const practiceNext = useMemo(
    () => (questions == null ? null : pickPracticeNext(questions)),
    [questions],
  );

  // Archive is reversible (Toast undo, or the Archived filter's Restore row
  // action) so it fires immediately with no confirmation — the Library
  // refetches on the 'questions-changed' broadcast either action emits, so
  // no local optimistic-update bookkeeping is needed here.
  const handleArchive = useCallback((q: QuestionWithStats) => {
    archiveQuestion(q.category, q.slug)
      .then(() => {
        showActionToast(`"${q.title}" archived`, 'Undo', () => {
          unarchiveQuestion(q.category, q.slug).catch(() => {
            setError('Failed to restore the question');
          });
        });
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to archive the question');
      });
  }, []);

  const handleUnarchive = useCallback((q: QuestionWithStats) => {
    unarchiveQuestion(q.category, q.slug).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Failed to restore the question');
    });
  }, []);

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
          {activeFilterCount > 0 && (
            <>
              <span className="topbar-count">
                {activeFilterCount} {activeFilterCount === 1 ? 'filter' : 'filters'}
              </span>
              <button className="btn btn-small" onClick={clearFilters}>
                Clear filters
              </button>
            </>
          )}
        </div>
        <div className="topbar-right">
          {generatingCount > 0 && (
            <span className="chip generating-pill">
              <span className="pulse-dot" aria-hidden="true" />
              {generatingCount} generating…
            </span>
          )}
          <div className="playground-menu-wrap" ref={playgroundMenuRef}>
            <button
              className="btn btn-small"
              onClick={() => setPlaygroundMenuOpen((v) => !v)}
              title="Scaffold a zero-LLM scratch pad — nothing here is graded"
            >
              Playground ▾
            </button>
            {playgroundMenuOpen && (
              <div className="playground-menu">
                <button
                  className="playground-menu-item"
                  disabled={creatingPlayground}
                  onClick={() => handleCreatePlayground('react')}
                >
                  React playground
                </button>
                <button
                  className="playground-menu-item"
                  disabled={creatingPlayground}
                  onClick={() => handleCreatePlayground('ts')}
                >
                  TS playground
                </button>
              </div>
            )}
          </div>
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
        {(workspace?.activeAttempt != null || practiceNext != null) && (
          <div className="suggestion-row">
            {workspace?.activeAttempt != null && (
              <ResumeCard
                attempt={workspace.activeAttempt.attempt}
                question={workspace.activeAttempt.question}
                linkQuery={linkQuery}
              />
            )}
            {practiceNext != null && (
              <PracticeNextCard suggestion={practiceNext} linkQuery={linkQuery} />
            )}
          </div>
        )}
        {questions != null && (
          <>
            <div className="filter-row">
              <div className="filter-pills">
                <button
                  className={`pill ${categoryFilter === '' ? 'active' : ''}`}
                  onClick={() => updateParams({ category: '' })}
                >
                  All
                </button>
                {CATEGORY_SLUGS.map((slug) => (
                  <button
                    key={slug}
                    className={`pill ${categoryFilter === slug ? 'active' : ''}`}
                    onClick={() => updateParams({ category: categoryFilter === slug ? '' : slug })}
                  >
                    {categoryShortName(slug)}
                  </button>
                ))}
              </div>
              <input
                className="search-input"
                type="search"
                placeholder="Search titles…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
              <select
                className="status-select"
                value={statusFilter}
                onChange={(e) => updateParams({ status: e.target.value === 'all' ? '' : e.target.value })}
                title="Filter by status"
              >
                <option value="all">All statuses</option>
                <option value="not-attempted">Not attempted</option>
                <option value="in-progress">In progress</option>
                <option value="solved">Solved</option>
                <option value="archived">Archived</option>
              </select>
              <select
                className="status-select"
                value={difficultyFilter}
                onChange={(e) =>
                  updateParams({ difficulty: e.target.value === 'all' ? '' : e.target.value })
                }
                title="Filter by difficulty"
              >
                <option value="all">All difficulties</option>
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
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
                <p className="empty-hint">Try clearing the category, status, difficulty, or search filter.</p>
                {activeFilterCount > 0 && (
                  <div className="empty-actions">
                    <button className="btn btn-small" onClick={clearFilters}>
                      Clear filters
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <QuestionTable
                questions={visible}
                sort={{ key: sortKey, dir: sortDir }}
                onSortChange={handleSort}
                onArchive={handleArchive}
                onUnarchive={handleUnarchive}
                linkQuery={linkQuery}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
