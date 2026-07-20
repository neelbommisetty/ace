import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AceDb, DisputeRow, QuestionRow, ReviewRow } from './types.js';
import { openDb } from './db.js';

let tempRoot = '';
let db: AceDb;

function makeQuestion(category = 'js-ts', slug = 'debounce'): QuestionRow {
  return db.upsertQuestion({
    category,
    slug,
    title: slug,
    difficulty: 'medium',
    suggestedMinutes: 30,
    dirPath: path.join(tempRoot, 'questions', category, slug),
    source: 'manual',
  });
}

function addReview(questionId: string, bodyMd: string, at?: string): ReviewRow {
  return db.createReview({ questionId, attemptId: null, bodyMd, source: 'user', at });
}

function addDispute(questionId: string, summary: string, detailsMd: string): DisputeRow {
  const run = db.createTestRun({ questionId, attemptId: null, trigger: 'manual' });
  return db.createDispute({
    questionId,
    attemptId: null,
    testRunId: run.id,
    argument: null,
    verdict: 'test_incorrect',
    summary,
    detailsMd,
    fixedTestCode: null,
    testRelPath: `questions/x/y/solution.test.ts`,
    hint: null,
  });
}

function historyIds(items: ReturnType<AceDb['searchHistory']>): string[] {
  return items.map((i) => (i.type === 'review' ? i.review.id : i.dispute.id));
}

const HOSTILE_QUERIES = [
  '"',
  '""',
  '"""',
  '" OR "',
  'a"b',
  'AND',
  'OR',
  'NOT',
  'NEAR',
  'NEAR(a, b)',
  'foo AND bar',
  'foo OR bar',
  'foo*',
  '-foo',
  '(',
  ')',
  '*',
  '^start',
  'col : term',
  '%_',
  "'; DROP TABLE reviews; --",
];

afterEach(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe.each([
  { mode: 'fts', disableFts: false },
  { mode: 'like fallback', disableFts: true },
])('searchHistory ($mode)', ({ disableFts }) => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hist-'));
    db = openDb(tempRoot, { disableFts });
  });

  it('empty q merges reviews and disputes newest first', () => {
    const q = makeQuestion();
    const oldReview = addReview(q.id, 'old body', '2026-01-01T00:00:00.000Z');
    const dispute = addDispute(q.id, 'summary here', 'details here'); // at = now
    const futureReview = addReview(q.id, 'future body', '2036-01-01T00:00:00.000Z');

    const items = db.searchHistory({});
    expect(historyIds(items)).toEqual([futureReview.id, dispute.id, oldReview.id]);
    expect(items.map((i) => i.type)).toEqual(['review', 'dispute', 'review']);
    expect(items[0].question.id).toBe(q.id);
    expect(items[0].at).toBe(futureReview.at);
  });

  it('matches review bodies by term, case-insensitively', () => {
    const q = makeQuestion();
    const hit = addReview(q.id, 'The debounce timer logic is sound');
    addReview(q.id, 'Nothing relevant in here');

    expect(historyIds(db.searchHistory({ q: 'timer' }))).toEqual([hit.id]);
    expect(historyIds(db.searchHistory({ q: 'TIMER' }))).toEqual([hit.id]);
    expect(db.searchHistory({ q: 'zzznope' })).toEqual([]);
  });

  it('matches disputes on summary and on details', () => {
    const q = makeQuestion();
    const bySummary = addDispute(q.id, 'Wrong rounding expectation', 'plain details');
    const byDetails = addDispute(q.id, 'plain summary', 'The assertion uses floor semantics');

    expect(historyIds(db.searchHistory({ q: 'rounding' }))).toEqual([bySummary.id]);
    expect(historyIds(db.searchHistory({ q: 'FLOOR' }))).toEqual([byDetails.id]);
  });

  it('applies the category filter after joining questions', () => {
    const js = makeQuestion('js-ts', 'debounce');
    const react = makeQuestion('react', 'use-fetch');
    addReview(js.id, 'shared term alpha');
    const reactReview = addReview(react.id, 'shared term alpha');
    const reactDispute = addDispute(react.id, 'alpha in summary', 'details');

    const items = db.searchHistory({ q: 'alpha', category: 'react' });
    expect(historyIds(items).sort()).toEqual([reactDispute.id, reactReview.id].sort());
    expect(items.every((i) => i.question.category === 'react')).toBe(true);
    expect(db.searchHistory({ category: 'nope' })).toEqual([]);
  });

  it('applies the type filter', () => {
    const q = makeQuestion();
    const review = addReview(q.id, 'body');
    const dispute = addDispute(q.id, 'summary', 'details');

    expect(historyIds(db.searchHistory({ type: 'review' }))).toEqual([review.id]);
    expect(historyIds(db.searchHistory({ type: 'dispute' }))).toEqual([dispute.id]);
  });

  it('respects limit and defaults to 100', () => {
    const q = makeQuestion();
    for (let i = 0; i < 105; i++) {
      const at = `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`;
      addReview(q.id, `review number ${i}`, at);
    }
    expect(db.searchHistory({})).toHaveLength(100);
    const limited = db.searchHistory({ limit: 3 });
    expect(limited).toHaveLength(3);
    expect(limited.map((i) => i.at)).toEqual([...limited.map((i) => i.at)].sort().reverse());
  });

  it('hostile input never throws', () => {
    const q = makeQuestion();
    addReview(q.id, 'plain review body with "quotes" and (parens)');
    addDispute(q.id, 'summary', 'details');

    for (const hostile of HOSTILE_QUERIES) {
      expect(() => db.searchHistory({ q: hostile }), `q=${JSON.stringify(hostile)}`).not.toThrow();
      expect(Array.isArray(db.searchHistory({ q: hostile }))).toBe(true);
    }
  });

  it('whitespace-only q behaves like empty q', () => {
    const q = makeQuestion();
    const review = addReview(q.id, 'body');
    expect(historyIds(db.searchHistory({ q: '   ' }))).toEqual([review.id]);
  });
});

describe('searchHistory (FTS specifics)', () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hist-fts-'));
    db = openDb(tempRoot);
  });

  it('multi-term queries AND across the whole body, any order', () => {
    const q = makeQuestion();
    const hit = addReview(q.id, 'debounce delays calls using a timer under the hood');
    addReview(q.id, 'throttle limits calls');
    addReview(q.id, 'a timer without the other word');

    expect(historyIds(db.searchHistory({ q: 'debounce timer' }))).toEqual([hit.id]);
    expect(historyIds(db.searchHistory({ q: 'timer debounce' }))).toEqual([hit.id]);
  });

  it('treats MATCH operators as literal terms', () => {
    const q = makeQuestion();
    const withAnd = addReview(q.id, 'foo and bar live here');
    addReview(q.id, 'foo bar without the connective');
    const withNear = addReview(q.id, 'that was a near miss');

    // 'AND' must be a required literal token, not the boolean operator
    expect(historyIds(db.searchHistory({ q: 'foo AND bar' }))).toEqual([withAnd.id]);
    expect(historyIds(db.searchHistory({ q: 'NEAR' }))).toEqual([withNear.id]);
  });

  it('escapes double quotes inside terms', () => {
    const q = makeQuestion();
    const hit = addReview(q.id, 'call the "flush" method now');
    addReview(q.id, 'unrelated');

    expect(historyIds(db.searchHistory({ q: '"flush"' }))).toEqual([hit.id]);
    expect(() => db.searchHistory({ q: 'flu"sh' })).not.toThrow();
  });

  it('rebuilds the FTS index at boot when it drifts from reviews', () => {
    const q = makeQuestion();
    const review = addReview(q.id, 'the searchable canary phrase');
    db.close();

    const raw = new DatabaseSync(path.join(tempRoot, '.ace', 'ace.db'));
    raw.exec('DELETE FROM reviews_fts');
    raw.close();

    db = openDb(tempRoot);
    expect(historyIds(db.searchHistory({ q: 'canary' }))).toEqual([review.id]);
  });

  it('indexes reviews written while FTS was unavailable on next boot', () => {
    const q = makeQuestion();
    db.close();

    db = openDb(tempRoot, { disableFts: true });
    const review = addReview(q.id, 'debounce logic reviewed with a timer somewhere');
    db.close();

    db = openDb(tempRoot);
    // non-adjacent multi-term match only works via FTS → proves the rebuild ran
    expect(historyIds(db.searchHistory({ q: 'debounce timer' }))).toEqual([review.id]);
  });
});
