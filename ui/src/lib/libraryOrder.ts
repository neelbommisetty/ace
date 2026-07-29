/**
 * The Library's filter predicate + sort comparator (NEE-298), extracted so
 * the room can recompute the *exact same* ordered list Library was showing
 * without duplicating the logic (NEE-310) — both screens parse the same URL
 * search params into a `LibraryOrderParams` and feed the full questions list
 * through `orderedQuestions`.
 */

import type { Difficulty, QuestionStatus, QuestionWithStats } from '../types';

export type StatusFilter = 'all' | QuestionStatus | 'archived';
export type DifficultyFilter = 'all' | Difficulty;

/** The four click-to-sort columns (NEE-298) — Category/Difficulty/Status stay display-only. */
export type SortKey = 'title' | 'attempts' | 'lastRun' | 'lastActivity';
export type SortDir = 'asc' | 'desc';

// Each sort key's direction the *first* time it's clicked — text sorts
// start A→Z, everything else (counts, timestamps) starts biggest/newest
// first, matching the table's prior hardcoded newest-activity-first order.
export const DEFAULT_SORT_DIR: Record<SortKey, SortDir> = {
  title: 'asc',
  attempts: 'desc',
  lastRun: 'desc',
  lastActivity: 'desc',
};

export function parseStatusFilter(raw: string | null): StatusFilter {
  return raw === 'not-attempted' || raw === 'in-progress' || raw === 'solved' || raw === 'archived'
    ? raw
    : 'all';
}

export function parseDifficultyFilter(raw: string | null): DifficultyFilter {
  return raw === 'easy' || raw === 'medium' || raw === 'hard' ? raw : 'all';
}

export function parseSortKey(raw: string | null): SortKey {
  return raw === 'title' || raw === 'attempts' || raw === 'lastRun' || raw === 'lastActivity'
    ? raw
    : 'lastActivity';
}

export function sortDirMultiplier(dir: SortDir): number {
  return dir === 'asc' ? 1 : -1;
}

// Generalizes the previously-hardcoded newest-activity-first order
// across all four sortable columns; ascending, the caller negates for
// descending.
export function compareBySortKey(a: QuestionWithStats, b: QuestionWithStats, key: SortKey): number {
  switch (key) {
    case 'title':
      return a.title.localeCompare(b.title);
    case 'attempts':
      return a.stats.attemptCount - b.stats.attemptCount;
    case 'lastRun': {
      const at = a.stats.lastRun?.at ?? '';
      const bt = b.stats.lastRun?.at ?? '';
      return at.localeCompare(bt);
    }
    case 'lastActivity':
    default: {
      const at = a.stats.lastActivityAt ?? a.createdAt;
      const bt = b.stats.lastActivityAt ?? b.createdAt;
      return at.localeCompare(bt);
    }
  }
}

export interface LibraryOrderParams {
  category: string; // '' = all
  status: StatusFilter;
  difficulty: DifficultyFilter;
  search: string;
  sortKey: SortKey;
  sortDir: SortDir;
}

export const DEFAULT_LIBRARY_ORDER_PARAMS: LibraryOrderParams = {
  category: '',
  status: 'all',
  difficulty: 'all',
  search: '',
  sortKey: 'lastActivity',
  sortDir: 'desc',
};

/** The URL keys Library persists (NEE-298) and that the room carries onward (NEE-310). */
const PARAM_KEYS = ['category', 'status', 'difficulty', 'q', 'sort', 'dir'] as const;

/** Parses a Library-shaped `URLSearchParams` into the params `orderedQuestions` needs. */
export function parseLibraryOrderParams(searchParams: URLSearchParams): LibraryOrderParams {
  const sortKey = parseSortKey(searchParams.get('sort'));
  const rawDir = searchParams.get('dir');
  return {
    category: searchParams.get('category') ?? '',
    status: parseStatusFilter(searchParams.get('status')),
    difficulty: parseDifficultyFilter(searchParams.get('difficulty')),
    search: searchParams.get('q') ?? '',
    sortKey,
    sortDir: rawDir === 'asc' || rawDir === 'desc' ? rawDir : DEFAULT_SORT_DIR[sortKey],
  };
}

/**
 * True when the URL carries at least one of the Library's ordering params —
 * false for a bare deep link into the room (e.g. a bookmark, or a link from
 * outside the Library) with no filter/sort context to recompute.
 */
export function hasLibraryOrderContext(searchParams: URLSearchParams): boolean {
  return PARAM_KEYS.some((k) => {
    const v = searchParams.get(k);
    return v != null && v !== '';
  });
}

/** Extracts just the Library ordering params from a location's search string, for carrying onward across room navigations (NEE-310). */
export function libraryOrderQueryString(searchParams: URLSearchParams): string {
  const next = new URLSearchParams();
  for (const k of PARAM_KEYS) {
    const v = searchParams.get(k);
    if (v) next.set(k, v);
  }
  return next.toString();
}

/**
 * Same-category, default-sorted order — used when a room is opened with no
 * Library context to recompute from (deep link, NEE-310). Restricting to the
 * question's own category keeps "next unsolved" and prev/next meaningful
 * instead of walking the entire, unrelated library.
 */
export function fallbackOrderParams(category: string): LibraryOrderParams {
  return { ...DEFAULT_LIBRARY_ORDER_PARAMS, category };
}

/** The 'Archived' filter is the only view where archivedAt != null rows show up at all (NEE-296). */
export function orderedQuestions(
  questions: QuestionWithStats[],
  params: LibraryOrderParams,
): QuestionWithStats[] {
  const needle = params.search.trim().toLowerCase();
  return questions
    .filter((q) => (params.status === 'archived' ? q.archivedAt != null : q.archivedAt == null))
    .filter((q) => params.category === '' || q.category === params.category)
    .filter(
      (q) => params.status === 'all' || params.status === 'archived' || q.stats.status === params.status,
    )
    .filter((q) => params.difficulty === 'all' || q.difficulty === params.difficulty)
    .filter((q) => needle === '' || q.title.toLowerCase().includes(needle))
    .sort((a, b) => sortDirMultiplier(params.sortDir) * compareBySortKey(a, b, params.sortKey));
}

/** The question immediately after `currentId` in `ordered`, or null past the end / if not found. */
export function nextInOrder(ordered: QuestionWithStats[], currentId: string): QuestionWithStats | null {
  const idx = ordered.findIndex((q) => q.id === currentId);
  if (idx === -1 || idx === ordered.length - 1) return null;
  return ordered[idx + 1];
}

/** The question immediately before `currentId` in `ordered`, or null before the start / if not found. */
export function prevInOrder(ordered: QuestionWithStats[], currentId: string): QuestionWithStats | null {
  const idx = ordered.findIndex((q) => q.id === currentId);
  if (idx <= 0) return null;
  return ordered[idx - 1];
}

/**
 * The next question after `currentId` in `ordered` whose status isn't
 * 'solved', wrapping around the list — so the solved banner's "Next
 * question" finds something as long as ANY unsolved question exists
 * anywhere in the ordered (filtered) list, not only after the current
 * position. Always skips `currentId` itself.
 */
export function nextUnsolvedInOrder(
  ordered: QuestionWithStats[],
  currentId: string,
): QuestionWithStats | null {
  const n = ordered.length;
  if (n === 0) return null;
  const idx = ordered.findIndex((q) => q.id === currentId);
  const start = idx === -1 ? 0 : idx;
  for (let step = 1; step <= n; step++) {
    const candidate = ordered[(start + step) % n];
    if (candidate.id !== currentId && candidate.stats.status !== 'solved') return candidate;
  }
  return null;
}
