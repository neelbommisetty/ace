import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scorecard } from './categories.js';
import { getSuggestedTime } from './categories.js';
import {
  createScorecard,
  findQuestion,
  getAllQuestions,
  getCurrentAttempt,
  readScorecard,
  resetScorecard,
  startNewAttempt,
  updateTestResults,
  writeScorecard,
} from './scorecard.js';

let tempRoot = '';
let originalCwd = '';

function createWorkspace(): { root: string; questionsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-workspace-'));
  const questionsDir = path.join(root, 'questions');
  fs.mkdirSync(questionsDir, { recursive: true });
  return { root, questionsDir };
}

beforeEach(() => {
  originalCwd = process.cwd();
  const workspace = createWorkspace();
  tempRoot = workspace.root;
  process.chdir(tempRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (tempRoot && fs.existsSync(tempRoot)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('scorecard lifecycle', () => {
  it('creates scorecards with suggested time and untouched status', () => {
    const scorecard = createScorecard('Two Sum', 'js-ts', 'easy');

    expect(scorecard.suggestedTime).toBe(getSuggestedTime('js-ts', 'easy'));
    expect(scorecard.status).toBe('untouched');
    expect(scorecard.attempts).toEqual([]);
  });

  it('starts and updates attempts based on test results', () => {
    const scorecard = createScorecard('Two Sum', 'js-ts', 'easy');

    const started = startNewAttempt(scorecard);
    expect(started.status).toBe('in-progress');
    expect(getCurrentAttempt(started)).toEqual({
      attempt: 1,
      testsTotal: 0,
      testsPassed: 0,
      llmScore: null,
    });

    updateTestResults(started, 5, 3);
    expect(started.status).toBe('attempted');
    expect(getCurrentAttempt(started)?.testsPassed).toBe(3);

    updateTestResults(started, 5, 5);
    expect(started.status).toBe('solved');
  });

  it('resets status and feedback', () => {
    const scorecard = createScorecard('Two Sum', 'js-ts', 'easy');
    scorecard.status = 'solved';
    scorecard.llmFeedback = 'Great job';

    const reset = resetScorecard(scorecard);
    expect(reset.status).toBe('untouched');
    expect(reset.llmFeedback).toBeNull();
  });
});

describe('scorecard persistence', () => {
  it('writes and reads scorecards from the questions directory', () => {
    const baseDir = path.join(tempRoot, 'questions', 'js-ts', 'two-sum');
    fs.mkdirSync(baseDir, { recursive: true });
    const scorecard = createScorecard('Two Sum', 'js-ts', 'easy');

    writeScorecard('js-ts', 'two-sum', scorecard);

    const loaded = readScorecard('js-ts', 'two-sum') as Scorecard;
    expect(loaded.title).toBe('Two Sum');
    expect(loaded.status).toBe('untouched');
  });

  it('finds questions and lists scorecards across categories', () => {
    const questionA = path.join(tempRoot, 'questions', 'js-ts', 'two-sum');
    const questionB = path.join(tempRoot, 'questions', 'leetcode-algo', 'max-subarray');
    fs.mkdirSync(questionA, { recursive: true });
    fs.mkdirSync(questionB, { recursive: true });

    writeScorecard('js-ts', 'two-sum', createScorecard('Two Sum', 'js-ts', 'easy'));
    writeScorecard('leetcode-algo', 'max-subarray', createScorecard('Max Subarray', 'leetcode-algo', 'medium'));

    const all = getAllQuestions();
    expect(all).toHaveLength(2);
    expect(all.map((q) => q.slug).sort()).toEqual(['max-subarray', 'two-sum']);

    const found = findQuestion('two-sum');
    expect(found?.category).toBe('js-ts');
    expect(found?.dir).toBe(questionA);
  });
});
