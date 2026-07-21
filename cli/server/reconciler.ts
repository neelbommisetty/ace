import fs from 'node:fs';
import path from 'node:path';
import { CATEGORIES } from '../lib/categories.js';
import { getQuestionsDir } from '../lib/paths.js';
import type { AceDb, Difficulty } from './types.js';

export interface ReconcileResult {
  added: number;
  updated: number;
  missing: number;
  skippedDirs: string[];
}

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

function listSubdirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

function readTitle(questionDir: string, slug: string): string {
  const readmePath = path.join(questionDir, 'README.md');
  if (fs.existsSync(readmePath)) {
    const match = fs.readFileSync(readmePath, 'utf-8').match(/^#\s+(.+)$/m);
    if (match) return match[1].trim();
  }
  return slug;
}

function readReadmeMeta(questionDir: string): { difficulty: Difficulty | null; suggestedMinutes: number | null } {
  const readmePath = path.join(questionDir, 'README.md');
  const meta: { difficulty: Difficulty | null; suggestedMinutes: number | null } = {
    difficulty: null,
    suggestedMinutes: null,
  };
  if (!fs.existsSync(readmePath)) return meta;
  const raw = fs.readFileSync(readmePath, 'utf-8');

  const difficultyMatch = raw.match(/^\*\*Difficulty:\*\*\s*(easy|medium|hard)\s*$/im);
  if (difficultyMatch) {
    meta.difficulty = difficultyMatch[1].toLowerCase() as Difficulty;
  }

  const timeMatch = raw.match(/^\*\*Suggested Time:\*\*\s*~?(\d+)\s*minutes?\s*$/im);
  if (timeMatch) {
    const minutes = Number(timeMatch[1]);
    if (Number.isFinite(minutes) && minutes > 0) {
      meta.suggestedMinutes = minutes;
    }
  }

  return meta;
}

/**
 * Resolves title/difficulty/time metadata for a question dir. README.md
 * (written by scaffoldQuestionAt for every question, generated or not)
 * takes precedence over scorecard.json (legacy, only present for CLI-scaffolded
 * questions with writeScorecard: true), which takes precedence over hardcoded
 * defaults. Without this, a scorecard-less generated question's difficulty
 * would get clobbered back to 'medium' on the first watcher-triggered rescan,
 * since upsertQuestion DOES update difficulty on conflict.
 */
function readQuestionMeta(questionDir: string): {
  hasScorecard: boolean;
  difficulty: Difficulty;
  suggestedMinutes: number;
} {
  const meta = { hasScorecard: false, difficulty: 'medium' as Difficulty, suggestedMinutes: 30 };

  const scorecardPath = path.join(questionDir, 'scorecard.json');
  if (fs.existsSync(scorecardPath)) {
    meta.hasScorecard = true;
    try {
      const raw = JSON.parse(fs.readFileSync(scorecardPath, 'utf-8')) as Record<string, unknown>;
      if (DIFFICULTIES.includes(raw.difficulty as Difficulty)) {
        meta.difficulty = raw.difficulty as Difficulty;
      }
      if (typeof raw.suggestedTime === 'number' && Number.isFinite(raw.suggestedTime) && raw.suggestedTime > 0) {
        meta.suggestedMinutes = raw.suggestedTime;
      }
    } catch {
      // unparseable scorecard — keep defaults
    }
  }

  const readme = readReadmeMeta(questionDir);
  if (readme.difficulty !== null) meta.difficulty = readme.difficulty;
  if (readme.suggestedMinutes !== null) meta.suggestedMinutes = readme.suggestedMinutes;

  return meta;
}

/**
 * Syncs the questions/ tree into the db: upserts every
 * questions/<category>/<slug>/ dir, flags rows whose dir vanished, and
 * reports dirs under categories unknown to CATEGORIES.
 */
export function reconcile(db: AceDb, workspaceRoot: string): ReconcileResult {
  const questionsDir = getQuestionsDir(workspaceRoot);
  const skippedDirs: string[] = [];
  const presentIds: string[] = [];
  let added = 0;
  let updated = 0;

  for (const category of listSubdirs(questionsDir)) {
    const categoryDir = path.join(questionsDir, category);
    const known = Object.prototype.hasOwnProperty.call(CATEGORIES, category);
    for (const slug of listSubdirs(categoryDir)) {
      if (!known) {
        skippedDirs.push(`questions/${category}/${slug}`);
        continue;
      }
      const questionDir = path.join(categoryDir, slug);
      const title = readTitle(questionDir, slug);
      const legacy = readQuestionMeta(questionDir);
      const existing = db.getQuestion(category, slug);
      const row = db.upsertQuestion({
        category,
        slug,
        title,
        difficulty: legacy.difficulty,
        suggestedMinutes: legacy.suggestedMinutes,
        dirPath: questionDir,
        source: legacy.hasScorecard ? 'generated' : 'manual',
      });
      presentIds.push(row.id);
      if (!existing) {
        added += 1;
      } else if (
        existing.title !== title ||
        existing.dirPath !== questionDir ||
        existing.difficulty !== legacy.difficulty
      ) {
        updated += 1;
      }
    }
  }

  const present = new Set(presentIds);
  const missingIds = db
    .listQuestions()
    .filter((q) => !present.has(q.id))
    .map((q) => q.id);
  db.setMissing(presentIds, missingIds);

  return { added, updated, missing: missingIds.length, skippedDirs };
}
