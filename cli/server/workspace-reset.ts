import fs from 'node:fs';
import path from 'node:path';
import { isProseAnswer, lookupCategoryConfig } from '../lib/categories.js';
import { getStubContent } from '../lib/scaffold.js';
import { readBlob, saveBlob } from './blobs.js';
import { readWorkspaceFile, toWorkspaceRelPath, writeWorkspaceFile } from './files.js';
import type { AceDb, AtRiskProseFile } from './types.js';

/**
 * Pure fs+db helpers backing "clear workspace" (NEE-165). No HTTP, no
 * session/orchestration knowledge — those live in session.ts and the future
 * reset route. Every function here takes its db/root explicitly.
 */

/** Thrown by archiveAceDir when there is no `.ace` directory to archive. */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Renames `<root>/.ace` to `<root>/.ace-archive-<date>`, appending `-2`,
 * `-3`, … on collision (e.g. a second reset the same UTC day). `date`
 * defaults to today (UTC) and is injectable for tests. Returns the absolute
 * archive path. Throws ArchiveError if `.ace` does not exist.
 *
 * Same parent directory as `.ace`, so this is a same-filesystem rename (no
 * cross-device copy) and the dot-prefixed archive name is invisible to the
 * reconciler/importer/watcher, which only ever scan `questions/`.
 */
export function archiveAceDir(workspaceRoot: string, date?: string): string {
  const aceDir = path.join(workspaceRoot, '.ace');
  if (!fs.existsSync(aceDir)) {
    throw new ArchiveError(`no .ace directory to archive at ${aceDir}`);
  }
  const dateStr = date ?? utcDateString(new Date());

  let n = 1;
  for (;;) {
    const suffix = n === 1 ? '' : `-${n}`;
    const candidate = path.join(workspaceRoot, `.ace-archive-${dateStr}${suffix}`);
    if (!fs.existsSync(candidate)) {
      fs.renameSync(aceDir, candidate);
      return candidate;
    }
    n += 1;
  }
}

/** One solution file's restore instructions for one question. */
export interface RestorePlanEntry {
  category: string;
  slug: string;
  /** Workspace-relative POSIX path, e.g. "questions/js-ts/debounce/solution.ts". */
  relPath: string;
  /** Content the file should be restored to (scaffold snapshot, or template stub). */
  baselineContent: string;
  /** On-disk content right now, or null if the file is absent. */
  currentContent: string | null;
}

export type RestorePlan = RestorePlanEntry[];

/**
 * Builds a restore plan by reading the (about-to-be-archived) db and
 * workspace files — read-only, no mutation. Only questions with a known
 * CATEGORIES entry and `missingAt == null` are considered; for each, every
 * `config.solutionFiles` name gets one entry. All content is materialized
 * into memory here because the source db/blobs disappear once the `.ace`
 * dir is renamed.
 *
 * Test files are deliberately never included — see applyRestorePlan's
 * doc comment for why.
 */
export function collectRestorePlan(db: AceDb, workspaceRoot: string): RestorePlan {
  const plan: RestorePlan = [];

  for (const question of db.listQuestions()) {
    if (question.missingAt != null) continue;
    const config = lookupCategoryConfig(question.category);
    if (!config) continue;

    for (const name of config.solutionFiles) {
      const abs = path.join(question.dirPath, name);
      const relPath = toWorkspaceRelPath(workspaceRoot, abs);

      const scaffoldSnapshot = db.getFirstSnapshot(question.id, relPath, 'scaffold');
      const blobContent = scaffoldSnapshot ? readBlob(workspaceRoot, scaffoldSnapshot.hash) : null;
      const baselineContent = blobContent ?? getStubContent(config.slug, name);

      const onDisk = readWorkspaceFile(workspaceRoot, relPath);
      plan.push({
        category: question.category,
        slug: question.slug,
        relPath,
        baselineContent,
        currentContent: onDisk ? onDisk.content : null,
      });
    }
  }

  return plan;
}

/**
 * Which prose (behavioral story.md / design notes.md) solution files a
 * 'full' reset would actually overwrite with scaffold content right now
 * (NEE-363) — read-only, built on top of `collectRestorePlan`. A coding
 * question's solution.ts is deliberately excluded: it gets its own
 * 'reset'-trigger snapshot too, but naming *that* loss isn't this list's
 * job — it exists so the reset confirmation dialog can say "2 stories and 1
 * design answer will be reset" instead of the old, silent "solution files
 * are reset to scaffold" line. A file that was never touched (still equal
 * to its own baseline) isn't "at risk" — nothing would actually change.
 */
export function collectAtRiskProse(db: AceDb, workspaceRoot: string): AtRiskProseFile[] {
  const plan = collectRestorePlan(db, workspaceRoot);
  const atRisk: AtRiskProseFile[] = [];

  for (const entry of plan) {
    if (entry.currentContent == null) continue;
    if (entry.currentContent === entry.baselineContent) continue;

    const config = lookupCategoryConfig(entry.category);
    if (!config || !isProseAnswer(config)) continue;

    const question = db.getQuestion(entry.category, entry.slug);
    if (!question) continue;

    atRisk.push({
      category: entry.category,
      slug: entry.slug,
      title: question.title,
      relPath: entry.relPath,
    });
  }

  return atRisk;
}

/**
 * Snapshots every plan entry's current on-disk content into the OLD db
 * before it is archived, mirroring the guarantee POST /api/attempts/:id/fresh
 * makes: a reset can never lose code. Entries with `currentContent === null`
 * (file already absent) are skipped. Any throw (blob write failure, db
 * failure) propagates so the caller aborts the whole reset with the
 * workspace untouched.
 */
export function snapshotPreResetState(db: AceDb, workspaceRoot: string, plan: RestorePlan): void {
  for (const entry of plan) {
    if (entry.currentContent == null) continue;

    const question = db.getQuestion(entry.category, entry.slug);
    if (!question) {
      throw new Error(
        `snapshotPreResetState: question ${entry.category}/${entry.slug} vanished from the db mid-reset`,
      );
    }

    const hash = saveBlob(workspaceRoot, entry.currentContent);
    db.addSnapshot({
      questionId: question.id,
      attemptId: null,
      relPath: entry.relPath,
      hash,
      trigger: 'reset',
    });
  }
}

/**
 * Applies a restore plan against a freshly re-initialized db (post-archive,
 * post-reconcile). `full` mode writes each entry's `baselineContent` back to
 * disk and seeds a `'scaffold'` snapshot in the new db; `progress` mode only
 * seeds the snapshots, leaving disk untouched. Entries whose question no
 * longer resolves in the new db (dir vanished between collection and apply)
 * are skipped without throwing.
 *
 * Intentional asymmetry with captureScaffoldBaseline (app.ts): that path
 * baselines `config.testFiles` too, but this function restores and re-seeds
 * `solutionFiles` ONLY — test files are never restored and get no seeded
 * snapshot. On the first post-reset Room open, captureScaffoldBaseline
 * captures the *current* (dispute-fixed) test files as the new baseline.
 * That's deliberate: applied dispute fixes are corrections to the question,
 * not attempt progress, and must survive a reset.
 *
 * The returned counts describe what the caller should tell the user was
 * *restored* (per the `WorkspaceResetResult.restored` contract, which is
 * zeros across the board in `progress` mode) — not internal bookkeeping.
 * Scaffold snapshots are seeded in both modes (the review guard needs a
 * `'scaffold'` baseline to diff against regardless of mode), but that seeding
 * is not itself a restoration, so `questions` only counts entries in `full`
 * mode, same as `files`.
 */
export function applyRestorePlan(
  newDb: AceDb,
  workspaceRoot: string,
  plan: RestorePlan,
  mode: 'progress' | 'full',
): { questions: number; files: number } {
  let files = 0;
  const restoredQuestionIds = new Set<string>();

  for (const entry of plan) {
    const question = newDb.getQuestion(entry.category, entry.slug);
    if (!question) continue;

    if (mode === 'full') {
      writeWorkspaceFile(workspaceRoot, entry.relPath, entry.baselineContent);
      files += 1;
      restoredQuestionIds.add(question.id);
    }

    const hash = saveBlob(workspaceRoot, entry.baselineContent);
    newDb.addSnapshot({
      questionId: question.id,
      attemptId: null,
      relPath: entry.relPath,
      hash,
      trigger: 'scaffold',
    });
  }

  return { questions: restoredQuestionIds.size, files };
}
