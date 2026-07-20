import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AceDb } from './types.js';
import { openDb } from './db.js';
import { previewImport, runImport } from './importer.js';

let tempRoot = '';
let db: AceDb;

const FEEDBACK = '## Review\n\nGood decomposition.\n\nVerdict: Lean Hire\n';

function writeScorecard(category: string, slug: string, scorecard: Record<string, unknown>): string {
  const dir = path.join(tempRoot, 'questions', category, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${slug}\n`, 'utf-8');
  const filePath = path.join(dir, 'scorecard.json');
  fs.writeFileSync(filePath, JSON.stringify(scorecard, null, 2) + '\n', 'utf-8');
  return filePath;
}

function legacyScorecard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Two Sum',
    category: 'js-ts',
    difficulty: 'medium',
    suggestedTime: 30,
    status: 'solved',
    attempts: [
      { attempt: 1, testsTotal: 5, testsPassed: 3, llmScore: null },
      { attempt: 2, testsTotal: 5, testsPassed: 5, llmScore: 8 },
    ],
    llmFeedback: FEEDBACK,
    ...overrides,
  };
}

// AceDb has no list methods for attempts/reviews — inspect rows directly.
function rawRows(sql: string, ...params: string[]): Array<Record<string, unknown>> {
  const raw = new DatabaseSync(path.join(tempRoot, '.ace', 'ace.db'));
  try {
    return raw.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  } finally {
    raw.close();
  }
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-test-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  db = openDb(tempRoot);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('previewImport', () => {
  it('lists question dirs bearing a scorecard.json', () => {
    writeScorecard('js-ts', 'two-sum', legacyScorecard());
    writeScorecard('design-fe', 'news-feed', legacyScorecard({
      title: 'News Feed',
      category: 'design-fe',
      attempts: [{ attempt: 1, testsTotal: 0, testsPassed: 0, llmScore: 7 }],
      llmFeedback: null,
    }));
    // no scorecard → not a legacy question
    fs.mkdirSync(path.join(tempRoot, 'questions', 'js-ts', 'fresh'), { recursive: true });

    const items = previewImport(db, tempRoot);
    expect(items).toEqual([
      {
        category: 'design-fe',
        slug: 'news-feed',
        title: 'News Feed',
        legacyAttempts: 1,
        hasFeedback: false,
        alreadyImported: false,
      },
      {
        category: 'js-ts',
        slug: 'two-sum',
        title: 'Two Sum',
        legacyAttempts: 2,
        hasFeedback: true,
        alreadyImported: false,
      },
    ]);
  });

  it('ignores unknown categories and unparseable scorecards', () => {
    writeScorecard('mystery-cat', 'x', legacyScorecard());
    const dir = path.join(tempRoot, 'questions', 'js-ts', 'corrupt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'scorecard.json'), '{oops', 'utf-8');

    expect(previewImport(db, tempRoot)).toEqual([]);
  });
});

describe('runImport', () => {
  it('creates ended imported attempts and one review per feedback', () => {
    const scorecardPath = writeScorecard('js-ts', 'two-sum', legacyScorecard());
    writeScorecard('leetcode-ds', 'lru-cache', legacyScorecard({
      title: 'LRU Cache',
      category: 'leetcode-ds',
      attempts: [{ attempt: 1, testsTotal: 4, testsPassed: 4, llmScore: 9 }],
      llmFeedback: null,
    }));
    const before = fs.readFileSync(scorecardPath, 'utf-8');

    const result = runImport(db, tempRoot);
    expect(result).toEqual({
      questionsImported: 2,
      attemptsCreated: 3,
      reviewsCreated: 1,
      skipped: 0,
    });

    // reconcile ran first: question rows exist
    const question = db.getQuestion('js-ts', 'two-sum');
    expect(question).not.toBeNull();
    const twoSum = db.listQuestions().find((q) => q.slug === 'two-sum');
    expect(twoSum?.stats.attemptCount).toBe(2);
    expect(twoSum?.stats.imported).toBe(true);

    // every imported attempt is ended (never active), stamped with the scorecard mtime
    expect(db.getActiveAttempt(question!.id)).toBeNull();
    expect(db.getLatestActiveAttempt()).toBeNull();
    const mtimeIso = fs.statSync(scorecardPath).mtime.toISOString();
    const attempts = rawRows(
      'SELECT * FROM attempts WHERE question_id = ? ORDER BY number',
      question!.id,
    );
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.number)).toEqual([1, 2]);
    for (const a of attempts) {
      expect(a.imported).toBe(1);
      expect(a.started_at).toBe(mtimeIso);
      expect(a.ended_at).not.toBeNull();
      expect(a.end_reason).toBe('submitted');
    }

    // one review, version 1, verdict parsed from the feedback body
    const reviews = rawRows('SELECT * FROM reviews WHERE question_id = ?', question!.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].version).toBe(1);
    expect(reviews[0].body_md).toBe(FEEDBACK);
    expect(reviews[0].verdict).toBe('Lean Hire');
    expect(reviews[0].source).toBe('import');
    expect(reviews[0].attempt_id).toBe(attempts[1].id);
    expect(rawRows('SELECT * FROM reviews')).toHaveLength(1);

    // scorecard.json untouched on disk; meta keys set
    expect(fs.readFileSync(scorecardPath, 'utf-8')).toBe(before);
    expect(db.getMeta('imported:js-ts/two-sum')).not.toBeNull();
    expect(db.getMeta('imported:leetcode-ds/lru-cache')).not.toBeNull();
  });

  it('parses verdicts longest-phrase-first, null when absent', () => {
    writeScorecard('js-ts', 'a', legacyScorecard({ llmFeedback: 'Overall: Strong Hire\n' }));
    writeScorecard('js-ts', 'b', legacyScorecard({ llmFeedback: 'Overall: No Hire today\n' }));
    writeScorecard('js-ts', 'c', legacyScorecard({ llmFeedback: 'No verdict in here\n' }));
    const result = runImport(db, tempRoot);
    expect(result.reviewsCreated).toBe(3);

    const verdictBySlug = new Map(
      rawRows(
        `SELECT q.slug AS slug, r.verdict AS verdict
         FROM reviews r JOIN questions q ON q.id = r.question_id`,
      ).map((r) => [r.slug, r.verdict]),
    );
    expect(verdictBySlug.get('a')).toBe('Strong Hire');
    expect(verdictBySlug.get('b')).toBe('No Hire');
    expect(verdictBySlug.get('c')).toBeNull();
  });

  it('is idempotent: a second run skips everything', () => {
    writeScorecard('js-ts', 'two-sum', legacyScorecard());
    writeScorecard('leetcode-ds', 'lru-cache', legacyScorecard({
      title: 'LRU Cache',
      category: 'leetcode-ds',
      llmFeedback: null,
    }));
    runImport(db, tempRoot);

    const second = runImport(db, tempRoot);
    expect(second).toEqual({
      questionsImported: 0,
      attemptsCreated: 0,
      reviewsCreated: 0,
      skipped: 2,
    });

    expect(previewImport(db, tempRoot).every((i) => i.alreadyImported)).toBe(true);
    expect(rawRows('SELECT * FROM attempts')).toHaveLength(4);
    expect(rawRows('SELECT * FROM reviews')).toHaveLength(1);
  });

  it('imports a question with zero attempts and blank feedback as a no-op record', () => {
    writeScorecard('js-ts', 'empty', legacyScorecard({ attempts: [], llmFeedback: '   ' }));
    const result = runImport(db, tempRoot);
    expect(result).toEqual({
      questionsImported: 1,
      attemptsCreated: 0,
      reviewsCreated: 0,
      skipped: 0,
    });
    expect(db.getMeta('imported:js-ts/empty')).not.toBeNull();
  });
});
