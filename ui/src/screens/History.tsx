import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link, useParams, useSearchParams } from 'react-router';
import { getDispute, getFile, getHistory, getReview, getReviews } from '../api';
import { useCancellableEffect } from '../hooks/useCancellableEffect';
import { DisputeResult } from '../components/DisputeModal';
import { CategoryChip } from '../components/Chip';
import { DimensionBars, ReviewBadge } from '../components/ReviewBadge';
import { CATEGORY_SLUGS, categoryShortName } from '../lib/categories';
import { relTime } from '../lib/format';
import { DISPUTE_VERDICT_LABELS, firstImprovementLines } from '../lib/review';
import type { DisputeRow, HistoryItem, QuestionRow, ReviewRow } from '../types';

const SEARCH_DEBOUNCE_MS = 300;
const FETCH_LIMIT = 200;

type TypeFilter = '' | 'review' | 'dispute';

/** /history — the searchable corpus of reviews + disputes. Filters live in URL params. */
export function History() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const category = searchParams.get('category') ?? '';
  const rawType = searchParams.get('type') ?? '';
  const type: TypeFilter = rawType === 'review' || rawType === 'dispute' ? rawType : '';
  const questionKey = searchParams.get('question') ?? '';

  const updateParams = (patch: Record<string, string>) => {
    // Functional update: the debounced ?q= commit must not resurrect the
    // params of the render it was scheduled in (e.g. undoing a filter the
    // user clicked during the debounce window).
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
  };

  // debounced search input → ?q=
  const [input, setInput] = useState(q);
  useEffect(() => {
    setInput(q);
    // resync only when the param changes from outside (back/forward, links)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  useEffect(() => {
    if (input === q) return;
    const t = window.setTimeout(() => updateParams({ q: input }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useCancellableEffect(
    (cancelled) => {
      getHistory({
        q: q || undefined,
        category: category || undefined,
        type: type || undefined,
        question: questionKey || undefined,
        limit: FETCH_LIMIT,
      })
        .then(({ items: got }) => {
          if (cancelled()) return;
          setItems(got);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!cancelled()) setError(e instanceof Error ? e.message : 'Failed to load history');
        });
    },
    [q, category, type, questionKey],
  );

  // ?question= is filtered server-side; a question's full history is never a
  // client-side slice of the newest page.
  const visible = items;

  return (
    <div className="history">
      <header className="topbar">
        <div className="topbar-left">
          <h1 className="topbar-title">History</h1>
          {visible != null && (
            <span className="topbar-count">
              {visible.length} {visible.length === 1 ? 'item' : 'items'}
            </span>
          )}
        </div>
      </header>
      <div className="library-scroll">
        <div className="history-toolbar">
          <input
            className="history-search"
            type="search"
            placeholder="Search reviews and disputes…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <select
            className="status-select"
            value={category}
            onChange={(e) => updateParams({ category: e.target.value })}
            title="Filter by category"
          >
            <option value="">All categories</option>
            {CATEGORY_SLUGS.map((slug) => (
              <option key={slug} value={slug}>
                {categoryShortName(slug)}
              </option>
            ))}
          </select>
          <div className="filter-pills">
            {(
              [
                ['', 'All'],
                ['review', 'Reviews'],
                ['dispute', 'Disputes'],
              ] as Array<[TypeFilter, string]>
            ).map(([value, label]) => (
              <button
                key={label}
                className={`pill ${type === value ? 'active' : ''}`}
                onClick={() => updateParams({ type: value })}
              >
                {label}
              </button>
            ))}
          </div>
          {questionKey && (
            <button
              className="pill active"
              onClick={() => updateParams({ question: '' })}
              title="Clear the question filter"
            >
              {questionKey} ✕
            </button>
          )}
        </div>
        {error != null && <div className="error-note">{error}</div>}
        {visible == null && error == null && <div className="pane-empty">Loading history…</div>}
        {visible != null && visible.length === 0 && (
          <div className="empty-state">
            <p className="empty-title">Nothing here yet</p>
            <p className="empty-hint">
              Reviews and disputes land here the moment they finish — every LLM call becomes a
              searchable record.
            </p>
          </div>
        )}
        {visible != null && visible.length > 0 && (
          <ul className="history-list">
            {visible.map((item) => (
              <HistoryCard
                key={item.type === 'review' ? `r-${item.review.id}` : `d-${item.dispute.id}`}
                item={item}
                search={searchParams.toString()}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** `search` is the parent list's current `?q=&category=…` — carried onto the
 * detail link so '← History' and browser Back land back on this same
 * filtered list (NEE-306). */
function HistoryCard({ item, search }: { item: HistoryItem; search: string }) {
  if (item.type === 'review') {
    const { review, question } = item;
    const lines = firstImprovementLines(review.bodyMd);
    const to = `/history/review/${review.id}${search ? `?${search}` : ''}`;
    return (
      <li>
        <Link className="history-card" to={to}>
          <div className="history-card-main">
            <div className="history-card-head">
              <span className="history-card-title">{question.title}</span>
              <span className="mono cell-dim">v{review.version}</span>
              <ReviewBadge review={review} />
            </div>
            {lines.length > 0 && (
              <div className="improve-lines">
                {lines.map((line, i) => (
                  <div key={i} className="improve-line">
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="history-card-side">
            <CategoryChip category={question.category} />
            <span className="activity-when">{relTime(item.at)}</span>
          </div>
        </Link>
      </li>
    );
  }
  const { dispute, question } = item;
  const to = `/history/dispute/${dispute.id}${search ? `?${search}` : ''}`;
  return (
    <li>
      <Link className="history-card" to={to}>
        <div className="history-card-main">
          <div className="history-card-head">
            <span className="history-card-title">{question.title}</span>
            <span className={`dispute-tag dv-${dispute.verdict}`}>
              {DISPUTE_VERDICT_LABELS[dispute.verdict]}
            </span>
            {dispute.appliedAt != null && <span className="chip chip-applied">applied</span>}
          </div>
          <div className="improve-lines">
            <div className="improve-line">{dispute.summary}</div>
          </div>
        </div>
        <div className="history-card-side">
          <CategoryChip category={question.category} />
          <span className="activity-when">{relTime(item.at)}</span>
        </div>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Routed detail (NEE-306): /history/review/:id and /history/dispute/:id.
// Fetches the review/dispute (+ its owning question) by id directly — the
// same code path whether reached by clicking a card or landing here on a
// fresh reload/shared link.
// ---------------------------------------------------------------------------

type DetailData =
  | { type: 'review'; question: QuestionRow; review: ReviewRow }
  | { type: 'dispute'; question: QuestionRow; dispute: DisputeRow };

/** Rendered at /history/review/:id or /history/dispute/:id — `type` comes from which route matched (see App.tsx), not parsed out of the URL. */
export function HistoryDetail({ type }: { type: 'review' | 'dispute' }) {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const [data, setData] = useState<DetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useCancellableEffect(
    (cancelled) => {
      setData(null);
      setError(null);
      if (!id) return;
      const onError = (e: unknown) => {
        if (!cancelled()) setError(e instanceof Error ? e.message : `Failed to load ${type}`);
      };
      if (type === 'review') {
        getReview(id)
          .then((row) => {
            if (!cancelled()) setData({ type: 'review', question: row.question, review: row });
          })
          .catch(onError);
      } else {
        getDispute(id)
          .then((row) => {
            if (!cancelled()) setData({ type: 'dispute', question: row.question, dispute: row });
          })
          .catch(onError);
      }
    },
    [type, id],
  );

  const search = searchParams.toString();
  const backTo = `/history${search ? `?${search}` : ''}`;

  if (error != null) {
    return (
      <div className="history">
        <header className="topbar">
          <div className="topbar-left">
            <Link className="btn btn-small" to={backTo}>
              ← History
            </Link>
          </div>
        </header>
        <div className="library-scroll">
          <div className="error-note">{error}</div>
        </div>
      </div>
    );
  }

  if (data == null) {
    return (
      <div className="history">
        <header className="topbar">
          <div className="topbar-left">
            <Link className="btn btn-small" to={backTo}>
              ← History
            </Link>
          </div>
        </header>
        <div className="library-scroll">
          <div className="pane-empty">Loading…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="history">
      <header className="topbar">
        <div className="topbar-left">
          <Link className="btn btn-small" to={backTo}>
            ← History
          </Link>
          <h1 className="topbar-title">{data.question.title}</h1>
          <CategoryChip category={data.question.category} />
        </div>
      </header>
      <div className="library-scroll">
        {data.type === 'review' ? (
          <ReviewDetail question={data.question} review={data.review} />
        ) : (
          <DisputeDetail dispute={data.dispute} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review detail: two-version side-by-side compare + snapshot code.
// ---------------------------------------------------------------------------

function ReviewDetail({ question, review }: { question: QuestionRow; review: ReviewRow }) {
  const [versions, setVersions] = useState<ReviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string>(review.id);

  useCancellableEffect(
    (cancelled) => {
      getReviews(question.category, question.slug)
        .then((rows) => {
          if (cancelled()) return;
          setVersions(rows);
          // default compare: the clicked version right, its predecessor (or any
          // other version) left — rows are newest-first
          const idx = rows.findIndex((r) => r.id === review.id);
          const other =
            (idx >= 0 ? rows[idx + 1] : undefined) ?? rows.find((r) => r.id !== review.id) ?? null;
          setLeftId(other != null ? other.id : null);
        })
        .catch((e: unknown) => {
          if (!cancelled()) setError(e instanceof Error ? e.message : 'Failed to load versions');
        });
    },
    [question.category, question.slug, review.id],
  );

  if (error != null) return <div className="error-note">{error}</div>;
  if (versions == null || versions.length === 0) {
    return <div className="pane-empty">Loading versions…</div>;
  }

  const left = leftId != null ? (versions.find((r) => r.id === leftId) ?? null) : null;

  return (
    <div className={`versions-split ${left == null ? 'versions-single' : ''}`}>
      {left != null && (
        <VersionColumn versions={versions} selectedId={left.id} onSelect={setLeftId} />
      )}
      <VersionColumn versions={versions} selectedId={rightId} onSelect={setRightId} />
    </div>
  );
}

function VersionColumn({
  versions,
  selectedId,
  onSelect,
}: {
  versions: ReviewRow[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const current = versions.find((r) => r.id === selectedId) ?? versions[0];

  return (
    <div className="version-col">
      <select
        className="status-select version-select"
        value={current.id}
        onChange={(e) => onSelect(e.target.value)}
      >
        {versions.map((r) => (
          <option key={r.id} value={r.id}>
            v{r.version} · {new Date(r.at).toLocaleDateString()}
            {r.verdict != null ? ` · ${r.verdict}` : r.score != null ? ` · ${r.score}/5` : ''}
          </option>
        ))}
      </select>
      <div className="version-meta">
        <ReviewBadge review={current} />
        <span className="review-meta">
          {relTime(current.at)}
          {current.model != null && ` · ${current.model}`}
          {current.source === 'import' && ' · imported'}
        </span>
      </div>
      {current.dimensions != null && <DimensionBars dimensions={current.dimensions} />}
      <SnapshotCode
        key={current.id}
        reviewId={current.id}
        hasSnapshot={current.snapshotHash != null}
      />
      <div className="markdown version-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{current.bodyMd}</ReactMarkdown>
      </div>
    </div>
  );
}

/** Collapsible 'code as reviewed' — fetched lazily on first expand. */
function SnapshotCode({ reviewId, hasSnapshot }: { reviewId: string; hasSnapshot: boolean }) {
  const [content, setContent] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'loaded' | 'missing' | 'error'>('idle');

  if (!hasSnapshot) return null;

  const load = () => {
    if (state !== 'idle') return;
    setState('loading');
    getReview(reviewId)
      .then((r) => {
        if (r.snapshotContent != null) {
          setContent(r.snapshotContent);
          setState('loaded');
        } else {
          setState('missing');
        }
      })
      .catch(() => setState('error'));
  };

  return (
    <details className="snapshot-details" onToggle={(e) => e.currentTarget.open && load()}>
      <summary>code as reviewed</summary>
      {state === 'loading' && <div className="pane-empty">Loading snapshot…</div>}
      {state === 'missing' && <div className="pane-empty">Snapshot blob is gone from disk.</div>}
      {state === 'error' && <div className="pane-empty">Failed to load the snapshot.</div>}
      {state === 'loaded' && content != null && <pre className="snapshot-pre">{content}</pre>}
    </details>
  );
}

// ---------------------------------------------------------------------------
// Dispute detail: verdict + details + read-only diff against the current file.
// ---------------------------------------------------------------------------

function DisputeDetail({ dispute }: { dispute: DisputeRow }) {
  const [originalCode, setOriginalCode] = useState<string | null>(null);

  useCancellableEffect(
    (cancelled) => {
      if (dispute.fixedTestCode == null) return;
      getFile(dispute.testRelPath)
        .then(({ content }) => {
          if (!cancelled()) setOriginalCode(content);
        })
        .catch(() => {
          if (!cancelled()) setOriginalCode('');
        });
    },
    [dispute.fixedTestCode, dispute.testRelPath],
  );

  return (
    <div className="dispute-detail">
      {dispute.argument != null && dispute.argument !== '' && (
        <p className="dialog-note">
          <strong>Your case:</strong> {dispute.argument}
        </p>
      )}
      <DisputeResult dispute={dispute} originalCode={originalCode} />
      {dispute.fixedTestCode != null && dispute.appliedAt != null && (
        <p className="dialog-note">
          Applied {relTime(dispute.appliedAt)} — the diff compares against the file as it is now.
        </p>
      )}
    </div>
  );
}
