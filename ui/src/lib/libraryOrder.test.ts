import { describe, expect, it } from 'vitest';
import type { QuestionWithStats } from '../types';
import {
  DEFAULT_LIBRARY_ORDER_PARAMS,
  fallbackOrderParams,
  hasLibraryOrderContext,
  libraryOrderQueryString,
  nextInOrder,
  nextUnsolvedInOrder,
  orderedQuestions,
  parseLibraryOrderParams,
  prevInOrder,
} from './libraryOrder';

function q(overrides: Partial<QuestionWithStats> = {}): QuestionWithStats {
  return {
    id: 'q-1',
    category: 'js-ts',
    slug: 'question-1',
    title: 'Question 1',
    difficulty: 'medium',
    suggestedMinutes: 30,
    dirPath: 'questions/js-ts/question-1',
    source: 'generated',
    createdAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    missingAt: null,
    stats: {
      attemptCount: 0,
      lastRun: null,
      lastActivityAt: null,
      status: 'not-attempted',
      imported: false,
    },
    ...overrides,
  };
}

describe('libraryOrder', () => {
  describe('parseLibraryOrderParams / hasLibraryOrderContext', () => {
    it('parses every known key out of the URL', () => {
      const params = parseLibraryOrderParams(
        new URLSearchParams('category=js-ts&status=solved&difficulty=hard&q=two&sort=title&dir=asc'),
      );
      expect(params).toEqual({
        category: 'js-ts',
        status: 'solved',
        difficulty: 'hard',
        search: 'two',
        sortKey: 'title',
        sortDir: 'asc',
      });
    });

    it('falls back to defaults for missing/garbage values, deriving sortDir from the sort key default', () => {
      const params = parseLibraryOrderParams(new URLSearchParams('sort=attempts'));
      expect(params.category).toBe('');
      expect(params.status).toBe('all');
      expect(params.difficulty).toBe('all');
      expect(params.search).toBe('');
      expect(params.sortKey).toBe('attempts');
      expect(params.sortDir).toBe('desc'); // DEFAULT_SORT_DIR.attempts
    });

    it('reports no context for a bare/empty URL', () => {
      expect(hasLibraryOrderContext(new URLSearchParams(''))).toBe(false);
      expect(hasLibraryOrderContext(new URLSearchParams('foo=bar'))).toBe(false);
    });

    it('reports context when any recognized key is present and non-empty', () => {
      expect(hasLibraryOrderContext(new URLSearchParams('category=js-ts'))).toBe(true);
      expect(hasLibraryOrderContext(new URLSearchParams('q=two'))).toBe(true);
      // an explicitly-empty value doesn't count as context
      expect(hasLibraryOrderContext(new URLSearchParams('category='))).toBe(false);
    });
  });

  describe('libraryOrderQueryString', () => {
    it('carries only the recognized keys onward, dropping anything else', () => {
      const qs = libraryOrderQueryString(
        new URLSearchParams('category=js-ts&sort=title&dir=asc&unrelated=1'),
      );
      expect(qs).toBe('category=js-ts&sort=title&dir=asc');
    });

    it('is empty for a bare URL', () => {
      expect(libraryOrderQueryString(new URLSearchParams(''))).toBe('');
    });
  });

  describe('fallbackOrderParams', () => {
    it('restricts to the given category with every other default', () => {
      expect(fallbackOrderParams('algorithms')).toEqual({
        ...DEFAULT_LIBRARY_ORDER_PARAMS,
        category: 'algorithms',
      });
    });
  });

  describe('orderedQuestions', () => {
    const questions = [
      q({ id: 'a', title: 'Alpha', category: 'js-ts', difficulty: 'easy', createdAt: '2026-01-01T00:00:00.000Z' }),
      q({ id: 'b', title: 'Bravo', category: 'algorithms', difficulty: 'hard', createdAt: '2026-01-02T00:00:00.000Z' }),
      q({
        id: 'c',
        title: 'Charlie',
        category: 'js-ts',
        difficulty: 'medium',
        createdAt: '2026-01-03T00:00:00.000Z',
        archivedAt: '2026-01-04T00:00:00.000Z',
      }),
    ];

    it('hides archived rows outside the archived filter, and shows only them inside it', () => {
      const visible = orderedQuestions(questions, DEFAULT_LIBRARY_ORDER_PARAMS);
      expect(visible.map((r) => r.id)).toEqual(['b', 'a']); // no default sortKey override -> lastActivity desc by createdAt fallback

      const archivedOnly = orderedQuestions(questions, { ...DEFAULT_LIBRARY_ORDER_PARAMS, status: 'archived' });
      expect(archivedOnly.map((r) => r.id)).toEqual(['c']);
    });

    it('filters by category, difficulty, and title search', () => {
      const byCategory = orderedQuestions(questions, { ...DEFAULT_LIBRARY_ORDER_PARAMS, category: 'js-ts' });
      expect(byCategory.map((r) => r.id)).toEqual(['a']);

      const byDifficulty = orderedQuestions(questions, { ...DEFAULT_LIBRARY_ORDER_PARAMS, difficulty: 'hard' });
      expect(byDifficulty.map((r) => r.id)).toEqual(['b']);

      const bySearch = orderedQuestions(questions, { ...DEFAULT_LIBRARY_ORDER_PARAMS, search: 'alph' });
      expect(bySearch.map((r) => r.id)).toEqual(['a']);
    });

    it('sorts by title ascending', () => {
      const sorted = orderedQuestions(questions, {
        ...DEFAULT_LIBRARY_ORDER_PARAMS,
        sortKey: 'title',
        sortDir: 'asc',
      });
      expect(sorted.map((r) => r.id)).toEqual(['a', 'b']); // c is archived, hidden by default
    });

    // NEE-353: a reviewed prose question (design/behavioral) now derives
    // status 'solved' from db.ts even though it never has a lastRun — the
    // status filter here is category-agnostic, so it should behave exactly
    // like a solved coding question.
    it('the Solved filter includes a reviewed prose question (lastRun stays null)', () => {
      const prose = [
        q({
          id: 'story',
          title: 'Greatest Failure',
          category: 'behavioral',
          stats: { attemptCount: 1, lastRun: null, lastActivityAt: '2026-01-05T00:00:00.000Z', status: 'solved', imported: false },
        }),
        q({
          id: 'unreviewed',
          title: 'Conflict Story',
          category: 'behavioral',
          stats: { attemptCount: 1, lastRun: null, lastActivityAt: '2026-01-05T00:00:00.000Z', status: 'in-progress', imported: false },
        }),
      ];
      const solvedOnly = orderedQuestions(prose, { ...DEFAULT_LIBRARY_ORDER_PARAMS, status: 'solved' });
      expect(solvedOnly.map((r) => r.id)).toEqual(['story']);
    });
  });

  describe('prevInOrder / nextInOrder', () => {
    const ordered = [q({ id: 'a' }), q({ id: 'b' }), q({ id: 'c' })];

    it('walks to the immediate neighbor without wrapping', () => {
      expect(prevInOrder(ordered, 'b')?.id).toBe('a');
      expect(nextInOrder(ordered, 'b')?.id).toBe('c');
    });

    it('returns null at either boundary', () => {
      expect(prevInOrder(ordered, 'a')).toBeNull();
      expect(nextInOrder(ordered, 'c')).toBeNull();
    });

    it('returns null when the current id is not in the list', () => {
      expect(prevInOrder(ordered, 'missing')).toBeNull();
      expect(nextInOrder(ordered, 'missing')).toBeNull();
    });
  });

  describe('nextUnsolvedInOrder', () => {
    it('finds the next unsolved question after the current position', () => {
      const ordered = [
        q({ id: 'a', stats: { attemptCount: 1, lastRun: null, lastActivityAt: null, status: 'solved', imported: false } }),
        q({ id: 'b', stats: { attemptCount: 0, lastRun: null, lastActivityAt: null, status: 'not-attempted', imported: false } }),
      ];
      expect(nextUnsolvedInOrder(ordered, 'a')?.id).toBe('b');
    });

    it('wraps around to find an unsolved question earlier in the list', () => {
      const ordered = [
        q({ id: 'a', stats: { attemptCount: 0, lastRun: null, lastActivityAt: null, status: 'not-attempted', imported: false } }),
        q({ id: 'b', stats: { attemptCount: 1, lastRun: null, lastActivityAt: null, status: 'solved', imported: false } }),
      ];
      // current is 'b' (just solved) — the only unsolved one, 'a', is *before* it in the list.
      expect(nextUnsolvedInOrder(ordered, 'b')?.id).toBe('a');
    });

    it('never returns the current question itself', () => {
      const ordered = [
        q({ id: 'a', stats: { attemptCount: 0, lastRun: null, lastActivityAt: null, status: 'not-attempted', imported: false } }),
      ];
      expect(nextUnsolvedInOrder(ordered, 'a')).toBeNull();
    });

    it('returns null when every question is solved', () => {
      const ordered = [
        q({ id: 'a', stats: { attemptCount: 1, lastRun: null, lastActivityAt: null, status: 'solved', imported: false } }),
        q({ id: 'b', stats: { attemptCount: 1, lastRun: null, lastActivityAt: null, status: 'solved', imported: false } }),
      ];
      expect(nextUnsolvedInOrder(ordered, 'a')).toBeNull();
    });

    it('returns null for an empty list', () => {
      expect(nextUnsolvedInOrder([], 'a')).toBeNull();
    });

    // NEE-353: a reviewed prose question is 'solved' with lastRun still
    // null — the solved-banner's Next must skip it exactly like a solved
    // coding question, not treat the missing lastRun as "still open".
    it('skips a reviewed prose question (lastRun null, status solved) just like a solved coding question', () => {
      const ordered = [
        q({
          id: 'coding-solved',
          category: 'js-ts',
          stats: { attemptCount: 1, lastRun: { passed: 2, total: 2, at: '2026-01-01T00:00:00.000Z', status: 'done' }, lastActivityAt: null, status: 'solved', imported: false },
        }),
        q({
          id: 'story-solved',
          category: 'behavioral',
          stats: { attemptCount: 1, lastRun: null, lastActivityAt: null, status: 'solved', imported: false },
        }),
        q({
          id: 'story-unreviewed',
          category: 'behavioral',
          stats: { attemptCount: 1, lastRun: null, lastActivityAt: null, status: 'in-progress', imported: false },
        }),
      ];
      expect(nextUnsolvedInOrder(ordered, 'coding-solved')?.id).toBe('story-unreviewed');
    });
  });
});
