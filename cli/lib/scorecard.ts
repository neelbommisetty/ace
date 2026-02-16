import fs from 'node:fs';
import path from 'node:path';
import type { Scorecard, Attempt, CategorySlug, Difficulty, QuestionStatus } from './categories.js';
import { getSuggestedTime } from './categories.js';
import { resolveWorkspaceRoot, getQuestionsDir } from './paths.js';

export function getScorecardPath(category: CategorySlug, slug: string): string {
  const root = resolveWorkspaceRoot();
  const questionsDir = getQuestionsDir(root);
  return path.join(questionsDir, category, slug, 'scorecard.json');
}

export function readScorecard(category: CategorySlug, slug: string): Scorecard | null {
  const filepath = getScorecardPath(category, slug);
  if (!fs.existsSync(filepath)) return null;
  return JSON.parse(fs.readFileSync(filepath, 'utf-8')) as Scorecard;
}

export function writeScorecard(category: CategorySlug, slug: string, scorecard: Scorecard): void {
  const filepath = getScorecardPath(category, slug);
  fs.writeFileSync(filepath, JSON.stringify(scorecard, null, 2) + '\n', 'utf-8');
}

export function createScorecard(
  title: string,
  category: CategorySlug,
  difficulty: Difficulty,
): Scorecard {
  return {
    title,
    category,
    difficulty,
    suggestedTime: getSuggestedTime(category, difficulty),
    status: 'untouched',
    attempts: [],
    llmFeedback: null,
  };
}

export function getCurrentAttempt(scorecard: Scorecard): Attempt | null {
  if (scorecard.attempts.length === 0) return null;
  return scorecard.attempts[scorecard.attempts.length - 1];
}

export function startNewAttempt(scorecard: Scorecard): Scorecard {
  const attemptNum = scorecard.attempts.length + 1;
  scorecard.attempts.push({
    attempt: attemptNum,
    testsTotal: 0,
    testsPassed: 0,
    llmScore: null,
  });
  scorecard.status = 'in-progress';
  return scorecard;
}

export function updateTestResults(
  scorecard: Scorecard,
  testsTotal: number,
  testsPassed: number,
): Scorecard {
  if (scorecard.attempts.length === 0) {
    startNewAttempt(scorecard);
  }
  const current = scorecard.attempts[scorecard.attempts.length - 1];
  current.testsTotal = testsTotal;
  current.testsPassed = testsPassed;

  if (testsTotal > 0 && testsPassed === testsTotal) {
    scorecard.status = 'solved';
  } else if (testsTotal > 0) {
    scorecard.status = 'attempted';
  }

  return scorecard;
}

export function resetScorecard(scorecard: Scorecard): Scorecard {
  scorecard.status = 'untouched';
  scorecard.llmFeedback = null;
  return scorecard;
}

export function getAllQuestions(): Array<{ category: CategorySlug; slug: string; scorecard: Scorecard }> {
  const results: Array<{ category: CategorySlug; slug: string; scorecard: Scorecard }> = [];
  const root = resolveWorkspaceRoot();
  const questionsRoot = getQuestionsDir(root);

  if (!fs.existsSync(questionsRoot)) return results;

  for (const categoryDir of fs.readdirSync(questionsRoot)) {
    const categoryPath = path.join(questionsRoot, categoryDir);
    if (!fs.statSync(categoryPath).isDirectory()) continue;

    for (const questionDir of fs.readdirSync(categoryPath)) {
      const questionPath = path.join(categoryPath, questionDir);
      if (!fs.statSync(questionPath).isDirectory()) continue;

      const scorecardPath = path.join(questionPath, 'scorecard.json');
      if (!fs.existsSync(scorecardPath)) continue;

      const scorecard = JSON.parse(fs.readFileSync(scorecardPath, 'utf-8')) as Scorecard;
      results.push({
        category: categoryDir as CategorySlug,
        slug: questionDir,
        scorecard,
      });
    }
  }

  return results;
}

export function findQuestion(slug: string): { category: CategorySlug; slug: string; dir: string } | null {
  const root = resolveWorkspaceRoot();
  const questionsRoot = getQuestionsDir(root);
  if (!fs.existsSync(questionsRoot)) return null;

  for (const categoryDir of fs.readdirSync(questionsRoot)) {
    const categoryPath = path.join(questionsRoot, categoryDir);
    if (!fs.statSync(categoryPath).isDirectory()) continue;

    const questionPath = path.join(categoryPath, slug);
    if (fs.existsSync(questionPath) && fs.statSync(questionPath).isDirectory()) {
      return {
        category: categoryDir as CategorySlug,
        slug,
        dir: questionPath,
      };
    }
  }

  return null;
}
