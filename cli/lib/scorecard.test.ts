import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scorecard } from './categories.js';
import { getSuggestedTime } from './categories.js';
import { createScorecard, writeScorecardAt } from './scorecard.js';

let tempRoot = '';

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-workspace-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
});

afterEach(() => {
  if (tempRoot && fs.existsSync(tempRoot)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('createScorecard', () => {
  it('creates scorecards with suggested time and untouched status', () => {
    const scorecard = createScorecard('Two Sum', 'js-ts', 'easy');

    expect(scorecard.title).toBe('Two Sum');
    expect(scorecard.suggestedTime).toBe(getSuggestedTime('js-ts', 'easy'));
    expect(scorecard.status).toBe('untouched');
    expect(scorecard.attempts).toEqual([]);
    expect(scorecard.llmFeedback).toBeNull();
  });
});

describe('writeScorecardAt', () => {
  it('writes scorecard.json under the PASSED root, not process.cwd()', () => {
    const questionDir = path.join(tempRoot, 'questions', 'js-ts', 'two-sum');
    fs.mkdirSync(questionDir, { recursive: true });

    writeScorecardAt(tempRoot, 'js-ts', 'two-sum', createScorecard('Two Sum', 'js-ts', 'easy'));

    const written = JSON.parse(
      fs.readFileSync(path.join(questionDir, 'scorecard.json'), 'utf-8'),
    ) as Scorecard;
    expect(written.title).toBe('Two Sum');
    expect(written.status).toBe('untouched');
  });
});
