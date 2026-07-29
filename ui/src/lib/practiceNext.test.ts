import { describe, expect, it } from 'vitest';
import type { QuestionWithStats } from '../types';
import { pickPracticeNext } from './practiceNext';

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

describe('pickPracticeNext', () => {
  it('returns null when there is nothing to suggest', () => {
    expect(pickPracticeNext([])).toBeNull();
  });

  it('returns null when every question is solved, archived, or missing', () => {
    const questions = [
      q({ id: 'solved', stats: { attemptCount: 1, lastRun: null, lastActivityAt: null, status: 'solved', imported: false } }),
      q({ id: 'archived', archivedAt: '2026-02-01T00:00:00.000Z' }),
      q({ id: 'missing', missingAt: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(pickPracticeNext(questions)).toBeNull();
  });

  it('picks the oldest unattempted question first, with a "not attempted" reason', () => {
    const questions = [
      q({
        id: 'newer',
        title: 'Newer Question',
        createdAt: '2026-01-05T00:00:00.000Z',
        category: 'js-ts',
        suggestedMinutes: 20,
      }),
      q({
        id: 'older',
        title: 'Older Question',
        createdAt: '2026-01-01T00:00:00.000Z',
        category: 'algorithms',
        suggestedMinutes: 30,
      }),
      // solved — never picked even though it would otherwise be the oldest
      q({
        id: 'solved-oldest',
        createdAt: '2025-12-01T00:00:00.000Z',
        stats: { attemptCount: 1, lastRun: null, lastActivityAt: null, status: 'solved', imported: false },
      }),
    ];

    const result = pickPracticeNext(questions);
    expect(result?.question.id).toBe('older');
    expect(result?.reason).toContain('not attempted');
    expect(result?.reason).toContain('~30m');
  });

  it('falls back to the oldest failed attempt when nothing is unattempted', () => {
    const questions = [
      q({
        id: 'recent-fail',
        stats: {
          attemptCount: 2,
          lastRun: { passed: 1, total: 2, at: '2026-01-10T00:00:00.000Z', status: 'done' },
          lastActivityAt: '2026-01-10T00:00:00.000Z',
          status: 'in-progress',
          imported: false,
        },
      }),
      q({
        id: 'older-fail',
        stats: {
          attemptCount: 3,
          lastRun: { passed: 0, total: 3, at: '2026-01-02T00:00:00.000Z', status: 'done' },
          lastActivityAt: '2026-01-02T00:00:00.000Z',
          status: 'in-progress',
          imported: false,
        },
      }),
    ];

    const result = pickPracticeNext(questions);
    expect(result?.question.id).toBe('older-fail');
    expect(result?.reason).toContain('failed last attempt');
  });

  it('treats a compile-error last run as a failure candidate', () => {
    const questions = [
      q({
        id: 'compile-error',
        stats: {
          attemptCount: 1,
          lastRun: { passed: 0, total: 0, at: '2026-01-02T00:00:00.000Z', status: 'compile-error' },
          lastActivityAt: '2026-01-02T00:00:00.000Z',
          status: 'in-progress',
          imported: false,
        },
      }),
    ];

    const result = pickPracticeNext(questions);
    expect(result?.question.id).toBe('compile-error');
    expect(result?.reason).toContain('failed last attempt');
  });

  it('does not treat a fully-passing, zero-test run as a failure', () => {
    const questions = [
      q({
        id: 'no-tests',
        stats: {
          attemptCount: 1,
          lastRun: { passed: 0, total: 0, at: '2026-01-02T00:00:00.000Z', status: 'done' },
          lastActivityAt: '2026-01-02T00:00:00.000Z',
          status: 'in-progress',
          imported: false,
        },
      }),
    ];

    // not unattempted, not failed — falls through to the last-resort branch,
    // but still returns *something* rather than nothing.
    const result = pickPracticeNext(questions);
    expect(result?.question.id).toBe('no-tests');
  });

  // NEE-353: a prose (design/behavioral) question can never have a lastRun,
  // so it can never satisfy the "failed last attempt" tier's `lastRun != null`
  // check — that tier is inherently test-run-shaped and has no meaningful
  // prose analog (a completed review always reads as 'solved' regardless of
  // verdict, so there is no "reviewed but needs another pass" state to
  // detect). An attempted-but-unreviewed prose question therefore correctly
  // falls through to the generic in-progress/last-touched tier, same as a
  // coding question with an inconclusive (zero-test) run above — this is
  // intentional, not a gap: there is no failure signal for prose without an
  // actual review verdict-based re-open, which NEE-353 explicitly does not
  // introduce ("solved" is purely "has a completed review").
  describe('prose (design/behavioral) tiering', () => {
    it('an unattempted prose question is picked with a "not attempted" reason, same as coding', () => {
      const questions = [
        q({
          id: 'story',
          category: 'behavioral',
          suggestedMinutes: 8,
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      ];
      const result = pickPracticeNext(questions);
      expect(result?.question.id).toBe('story');
      expect(result?.reason).toContain('not attempted');
    });

    it('an attempted-but-unreviewed prose question (lastRun null, status in-progress) never lands in the "failed" tier and falls to the in-progress fallback', () => {
      const questions = [
        q({
          id: 'story-in-progress',
          category: 'behavioral',
          stats: {
            attemptCount: 1,
            lastRun: null,
            lastActivityAt: '2026-01-02T00:00:00.000Z',
            status: 'in-progress',
            imported: false,
          },
        }),
      ];
      const result = pickPracticeNext(questions);
      expect(result?.question.id).toBe('story-in-progress');
      expect(result?.reason).not.toContain('failed last attempt');
      expect(result?.reason).toContain('in progress');
    });

    it('a reviewed (solved) prose question is never suggested', () => {
      const questions = [
        q({
          id: 'story-solved',
          category: 'behavioral',
          stats: { attemptCount: 1, lastRun: null, lastActivityAt: null, status: 'solved', imported: false },
        }),
      ];
      expect(pickPracticeNext(questions)).toBeNull();
    });

    it('an in-progress coding failure still outranks an in-progress unreviewed prose question', () => {
      const questions = [
        q({
          id: 'story-in-progress',
          category: 'behavioral',
          stats: {
            attemptCount: 1,
            lastRun: null,
            lastActivityAt: '2026-01-05T00:00:00.000Z',
            status: 'in-progress',
            imported: false,
          },
        }),
        q({
          id: 'coding-failed',
          category: 'js-ts',
          stats: {
            attemptCount: 1,
            lastRun: { passed: 1, total: 2, at: '2026-01-03T00:00:00.000Z', status: 'done' },
            lastActivityAt: '2026-01-03T00:00:00.000Z',
            status: 'in-progress',
            imported: false,
          },
        }),
      ];
      const result = pickPracticeNext(questions);
      expect(result?.question.id).toBe('coding-failed');
      expect(result?.reason).toContain('failed last attempt');
    });
  });
});
