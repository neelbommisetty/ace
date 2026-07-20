import fs from 'node:fs';
import path from 'node:path';
import { CATEGORIES } from '../lib/categories.js';
import { getQuestionsDir } from '../lib/paths.js';
import type { AceDb, ImportPreviewItem, ImportResult } from './types.js';
import { nowIso } from './ids.js';
import { reconcile } from './reconciler.js';

interface LegacyEntry {
  category: string;
  slug: string;
  scorecardPath: string;
  title: string;
  attemptCount: number;
  feedback: string | null;
}

const VERDICT_RE = /(Strong Hire|Lean Hire|No Hire|Hire)/;

function parseVerdict(body: string): string | null {
  for (const line of body.split('\n')) {
    const match = line.match(VERDICT_RE);
    if (match) return match[1];
  }
  return null;
}

function metaKey(category: string, slug: string): string {
  return `imported:${category}/${slug}`;
}

function listSubdirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/** Question dirs (under known categories) bearing a parseable legacy scorecard.json. */
function scanLegacy(workspaceRoot: string): LegacyEntry[] {
  const questionsDir = getQuestionsDir(workspaceRoot);
  const entries: LegacyEntry[] = [];
  for (const category of listSubdirs(questionsDir)) {
    if (!Object.prototype.hasOwnProperty.call(CATEGORIES, category)) continue;
    for (const slug of listSubdirs(path.join(questionsDir, category))) {
      const scorecardPath = path.join(questionsDir, category, slug, 'scorecard.json');
      if (!fs.existsSync(scorecardPath)) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(fs.readFileSync(scorecardPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        continue;
      }
      const feedback =
        typeof raw.llmFeedback === 'string' && raw.llmFeedback.trim() !== ''
          ? raw.llmFeedback
          : null;
      entries.push({
        category,
        slug,
        scorecardPath,
        title: typeof raw.title === 'string' && raw.title !== '' ? raw.title : slug,
        attemptCount: Array.isArray(raw.attempts) ? raw.attempts.length : 0,
        feedback,
      });
    }
  }
  return entries;
}

export function previewImport(db: AceDb, workspaceRoot: string): ImportPreviewItem[] {
  return scanLegacy(workspaceRoot).map((e) => ({
    category: e.category,
    slug: e.slug,
    title: e.title,
    legacyAttempts: e.attemptCount,
    hasFeedback: e.feedback != null,
    alreadyImported: db.getMeta(metaKey(e.category, e.slug)) != null,
  }));
}

/**
 * Imports legacy scorecard.json history: one ended attempts row per legacy
 * attempt entry and at most one review from llmFeedback. Idempotent via the
 * 'imported:<category>/<slug>' meta key; scorecard.json is never modified.
 */
export function runImport(db: AceDb, workspaceRoot: string): ImportResult {
  reconcile(db, workspaceRoot);

  const result: ImportResult = {
    questionsImported: 0,
    attemptsCreated: 0,
    reviewsCreated: 0,
    skipped: 0,
  };

  for (const entry of scanLegacy(workspaceRoot)) {
    if (db.getMeta(metaKey(entry.category, entry.slug)) != null) {
      result.skipped += 1;
      continue;
    }
    const question = db.getQuestion(entry.category, entry.slug);
    if (!question) {
      result.skipped += 1;
      continue;
    }

    const startedAt = fs.statSync(entry.scorecardPath).mtime.toISOString();
    // One transaction per question: the meta key (the idempotency guard) must
    // commit atomically with the rows it guards, or a crash mid-import would
    // duplicate history on the next run.
    db.transaction(() => {
      let lastAttemptId: string | null = null;
      for (let i = 0; i < entry.attemptCount; i++) {
        const attempt = db.createAttempt(question.id, { imported: true, startedAt });
        db.patchAttempt(attempt.id, { end: { reason: 'submitted' } });
        lastAttemptId = attempt.id;
        result.attemptsCreated += 1;
      }

      if (entry.feedback != null) {
        db.createReview({
          questionId: question.id,
          attemptId: lastAttemptId,
          bodyMd: entry.feedback,
          verdict: parseVerdict(entry.feedback),
          source: 'import',
        });
        result.reviewsCreated += 1;
      }

      db.setMeta(metaKey(entry.category, entry.slug), nowIso());
      result.questionsImported += 1;
    });
  }

  return result;
}
