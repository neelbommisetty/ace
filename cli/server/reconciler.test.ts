import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AceDb } from './types.js';
import { openDb } from './db.js';
import { reconcile } from './reconciler.js';
import { scaffoldQuestionAt } from '../lib/scaffold.js';
import { getSuggestedTime } from '../lib/categories.js';

let tempRoot = '';
let db: AceDb;

function questionDir(category: string, slug: string): string {
  return path.join(tempRoot, 'questions', category, slug);
}

function writeQuestion(
  category: string,
  slug: string,
  opts: { readme?: string; scorecard?: Record<string, unknown> } = {},
): string {
  const dir = questionDir(category, slug);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.readme !== undefined) {
    fs.writeFileSync(path.join(dir, 'README.md'), opts.readme, 'utf-8');
  }
  if (opts.scorecard !== undefined) {
    fs.writeFileSync(
      path.join(dir, 'scorecard.json'),
      JSON.stringify(opts.scorecard, null, 2) + '\n',
      'utf-8',
    );
  }
  return dir;
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

describe('reconcile', () => {
  it('adds question dirs with README titles and legacy scorecard metadata', () => {
    writeQuestion('js-ts', 'two-sum', {
      readme: '# Two Sum\n\nFind indices adding to target.\n',
      scorecard: {
        title: 'Two Sum',
        category: 'js-ts',
        difficulty: 'hard',
        suggestedTime: 45,
        status: 'solved',
        attempts: [],
        llmFeedback: null,
      },
    });
    writeQuestion('design-fe', 'infinite-scroll', {});

    const result = reconcile(db, tempRoot);
    expect(result).toEqual({ added: 2, updated: 0, missing: 0, skippedDirs: [] });

    const twoSum = db.getQuestion('js-ts', 'two-sum');
    expect(twoSum?.title).toBe('Two Sum');
    expect(twoSum?.difficulty).toBe('hard');
    expect(twoSum?.suggestedMinutes).toBe(45);
    expect(twoSum?.dirPath).toBe(questionDir('js-ts', 'two-sum'));
    expect(twoSum?.source).toBe('generated');
    expect(twoSum?.missingAt).toBeNull();

    // no README, no scorecard → slug title, defaults, manual source
    const scroll = db.getQuestion('design-fe', 'infinite-scroll');
    expect(scroll?.title).toBe('infinite-scroll');
    expect(scroll?.difficulty).toBe('medium');
    expect(scroll?.suggestedMinutes).toBe(30);
    expect(scroll?.source).toBe('manual');
  });

  it('upserts a behavioral question dir instead of landing in skippedDirs', () => {
    writeQuestion('behavioral', 'a-time-you-disagreed', {
      readme: '# A Time You Disagreed\n',
    });

    const result = reconcile(db, tempRoot);
    expect(result.added).toBe(1);
    expect(result.skippedDirs).toEqual([]);
    expect(db.getQuestion('behavioral', 'a-time-you-disagreed')).not.toBeNull();
  });

  it('skips dirs under unknown categories, reporting repo-relative paths', () => {
    writeQuestion('js-ts', 'ok', { readme: '# Ok\n' });
    writeQuestion('not-a-category', 'orphan', { readme: '# Orphan\n' });

    const result = reconcile(db, tempRoot);
    expect(result.added).toBe(1);
    expect(result.skippedDirs).toEqual(['questions/not-a-category/orphan']);
    expect(db.getQuestion('not-a-category', 'orphan')).toBeNull();
  });

  it('is idempotent and counts title/difficulty changes as updates', () => {
    writeQuestion('js-ts', 'debounce', { readme: '# Debounce\n' });
    reconcile(db, tempRoot);

    expect(reconcile(db, tempRoot)).toEqual({
      added: 0,
      updated: 0,
      missing: 0,
      skippedDirs: [],
    });

    writeQuestion('js-ts', 'debounce', { readme: '# Debounce Deluxe\n' });
    const result = reconcile(db, tempRoot);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(db.getQuestion('js-ts', 'debounce')?.title).toBe('Debounce Deluxe');
  });

  it('falls back to defaults when scorecard.json is invalid', () => {
    const dir = writeQuestion('js-ts', 'broken', { readme: '# Broken\n' });
    fs.writeFileSync(path.join(dir, 'scorecard.json'), 'not json{', 'utf-8');
    writeQuestion('js-ts', 'partial', {
      readme: '# Partial\n',
      scorecard: { difficulty: 'impossible', suggestedTime: -5 },
    });

    reconcile(db, tempRoot);
    const broken = db.getQuestion('js-ts', 'broken');
    expect(broken?.difficulty).toBe('medium');
    expect(broken?.suggestedMinutes).toBe(30);
    const partial = db.getQuestion('js-ts', 'partial');
    expect(partial?.difficulty).toBe('medium');
    expect(partial?.suggestedMinutes).toBe(30);
  });

  it('uses the slug when README has no h1', () => {
    writeQuestion('js-ts', 'no-heading', { readme: 'Just prose.\n\n## Notes\n' });
    reconcile(db, tempRoot);
    expect(db.getQuestion('js-ts', 'no-heading')?.title).toBe('no-heading');
  });

  it('marks vanished dirs missing and clears them when they return', () => {
    writeQuestion('js-ts', 'keeper', { readme: '# Keeper\n' });
    writeQuestion('js-ts', 'goner', { readme: '# Goner\n' });
    reconcile(db, tempRoot);

    fs.rmSync(questionDir('js-ts', 'goner'), { recursive: true, force: true });
    let result = reconcile(db, tempRoot);
    expect(result.missing).toBe(1);
    expect(db.getQuestion('js-ts', 'goner')?.missingAt).not.toBeNull();
    expect(db.getQuestion('js-ts', 'keeper')?.missingAt).toBeNull();

    writeQuestion('js-ts', 'goner', { readme: '# Goner\n' });
    result = reconcile(db, tempRoot);
    expect(result.missing).toBe(0);
    expect(result.added).toBe(0);
    expect(db.getQuestion('js-ts', 'goner')?.missingAt).toBeNull();
  });

  it('handles a workspace without a questions dir', () => {
    fs.rmSync(path.join(tempRoot, 'questions'), { recursive: true, force: true });
    expect(reconcile(db, tempRoot)).toEqual({
      added: 0,
      updated: 0,
      missing: 0,
      skippedDirs: [],
    });
  });

  it('parses difficulty and suggested time from README.md when there is no scorecard', () => {
    writeQuestion('js-ts', 'no-scorecard', {
      readme: '# No Scorecard\n\n**Category:** JS/TS Puzzles\n**Difficulty:** hard\n**Suggested Time:** ~45 minutes\n\n---\n\nBody.\n',
    });

    reconcile(db, tempRoot);
    const row = db.getQuestion('js-ts', 'no-scorecard');
    expect(row?.difficulty).toBe('hard');
    expect(row?.suggestedMinutes).toBe(45);
    // Scorecard-less, so still classified as manually authored provenance.
    expect(row?.source).toBe('manual');
  });

  it('prefers README metadata over a stale scorecard.json', () => {
    writeQuestion('js-ts', 'readme-wins', {
      readme: '# Readme Wins\n\n**Difficulty:** easy\n**Suggested Time:** ~10 minutes\n\n---\n',
      scorecard: {
        title: 'Readme Wins',
        category: 'js-ts',
        difficulty: 'hard',
        suggestedTime: 45,
        status: 'untouched',
        attempts: [],
        llmFeedback: null,
      },
    });

    reconcile(db, tempRoot);
    const row = db.getQuestion('js-ts', 'readme-wins');
    expect(row?.difficulty).toBe('easy');
    expect(row?.suggestedMinutes).toBe(10);
  });

  it('falls back to scorecard.json when README has no matching meta lines', () => {
    writeQuestion('js-ts', 'scorecard-fallback', {
      readme: '# Scorecard Fallback\n\nJust prose, no metadata lines.\n',
      scorecard: {
        title: 'Scorecard Fallback',
        category: 'js-ts',
        difficulty: 'hard',
        suggestedTime: 45,
        status: 'untouched',
        attempts: [],
        llmFeedback: null,
      },
    });

    reconcile(db, tempRoot);
    const row = db.getQuestion('js-ts', 'scorecard-fallback');
    expect(row?.difficulty).toBe('hard');
    expect(row?.suggestedMinutes).toBe(45);
  });

  it('falls back to defaults when README metadata lines are malformed', () => {
    writeQuestion('js-ts', 'malformed-readme', {
      readme: '# Malformed\n\n**Difficulty:** impossible\n**Suggested Time:** forever\n\n---\n',
    });

    reconcile(db, tempRoot);
    const row = db.getQuestion('js-ts', 'malformed-readme');
    expect(row?.difficulty).toBe('medium');
    expect(row?.suggestedMinutes).toBe(30);
  });

  it('is difficulty-stable across repeated reconciles for a scaffoldQuestionAt-created question', () => {
    scaffoldQuestionAt(
      tempRoot,
      {
        title: 'Generated Hard One',
        slug: 'generated-hard-one',
        category: 'js-ts',
        difficulty: 'hard',
        description: 'A generated question with no scorecard.json.',
      },
      { writeScorecard: false },
    );

    reconcile(db, tempRoot);
    let row = db.getQuestion('js-ts', 'generated-hard-one');
    expect(row?.difficulty).toBe('hard');
    expect(row?.source).toBe('manual'); // no scorecard.json -> provenance is a separate concern

    // A second (watcher-triggered) rescan must not clobber difficulty back to medium.
    reconcile(db, tempRoot);
    row = db.getQuestion('js-ts', 'generated-hard-one');
    expect(row?.difficulty).toBe('hard');
    expect(row?.suggestedMinutes).toBe(getSuggestedTime('js-ts', 'hard'));
  });
});
