import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AceDb } from './types.js';
import { openDb } from './db.js';
import { readBlob, saveBlob } from './blobs.js';
import { toWorkspaceRelPath } from './files.js';
import { createBus } from './sse.js';
import {
  ArchiveError,
  applyRestorePlan,
  archiveAceDir,
  collectRestorePlan,
  snapshotPreResetState,
  type RestorePlan,
} from './workspace-reset.js';

let tempRoot = '';
let db: AceDb;

function questionDir(category: string, slug: string): string {
  return path.join(tempRoot, 'questions', category, slug);
}

function writeCodingQuestion(
  category: string,
  slug: string,
  opts: { solution?: string; test?: string } = {},
): string {
  const dir = questionDir(category, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${slug}\n`, 'utf-8');
  fs.writeFileSync(
    path.join(dir, 'solution.ts'),
    opts.solution ?? 'export function solve() {}\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'solution.test.ts'),
    opts.test ?? "it('todo', () => {});\n",
    'utf-8',
  );
  return dir;
}

function writeDesignQuestion(category: string, slug: string, notes = '# Notes\n'): string {
  const dir = questionDir(category, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${slug}\n`, 'utf-8');
  fs.writeFileSync(path.join(dir, 'notes.md'), notes, 'utf-8');
  return dir;
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-reset-test-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  db = openDb(tempRoot);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('archiveAceDir', () => {
  it('renames .ace to .ace-archive-<date> and returns the absolute path', () => {
    const archived = archiveAceDir(tempRoot, '2026-07-20');
    expect(archived).toBe(path.join(tempRoot, '.ace-archive-2026-07-20'));
    expect(fs.existsSync(path.join(tempRoot, '.ace'))).toBe(false);
    expect(fs.existsSync(path.join(archived, 'ace.db'))).toBe(true);
  });

  it('appends -2, -3, ... on collision for the same date', () => {
    db.close();
    fs.mkdirSync(path.join(tempRoot, '.ace-archive-2026-07-20'));
    db = openDb(tempRoot);
    const first = archiveAceDir(tempRoot, '2026-07-20');
    expect(first).toBe(path.join(tempRoot, '.ace-archive-2026-07-20-2'));

    db = openDb(tempRoot);
    const second = archiveAceDir(tempRoot, '2026-07-20');
    expect(second).toBe(path.join(tempRoot, '.ace-archive-2026-07-20-3'));
  });

  it('throws ArchiveError when there is no .ace directory', () => {
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-reset-bare-'));
    try {
      expect(() => archiveAceDir(bareRoot)).toThrow(ArchiveError);
    } finally {
      fs.rmSync(bareRoot, { recursive: true, force: true });
    }
  });

  it('defaults to today (UTC) when no date is given', () => {
    const today = new Date().toISOString().slice(0, 10);
    const archived = archiveAceDir(tempRoot);
    expect(archived).toBe(path.join(tempRoot, `.ace-archive-${today}`));
  });
});

describe('collectRestorePlan', () => {
  it('uses the scaffold snapshot blob as baseline when one exists', () => {
    const dir = writeCodingQuestion('js-ts', 'debounce', { solution: 'export const x = 1;\n' });
    const question = db.upsertQuestion({
      category: 'js-ts',
      slug: 'debounce',
      title: 'Debounce',
      difficulty: 'medium',
      suggestedMinutes: 30,
      dirPath: dir,
      source: 'manual',
    });
    const rel = toWorkspaceRelPath(tempRoot, path.join(dir, 'solution.ts'));
    const hash = saveBlob(tempRoot, 'export const scaffold = true;\n');
    db.addSnapshot({ questionId: question.id, attemptId: null, relPath: rel, hash, trigger: 'scaffold' });

    const plan = collectRestorePlan(db, tempRoot);
    const entry = plan.find((e) => e.relPath === rel);
    expect(entry?.baselineContent).toBe('export const scaffold = true;\n');
    expect(entry?.currentContent).toBe('export const x = 1;\n');
  });

  it('falls back to the template stub when there is no scaffold snapshot', () => {
    const dir = writeCodingQuestion('js-ts', 'no-scaffold');
    db.upsertQuestion({
      category: 'js-ts',
      slug: 'no-scaffold',
      title: 'No scaffold',
      difficulty: 'easy',
      suggestedMinutes: 15,
      dirPath: dir,
      source: 'manual',
    });

    const plan = collectRestorePlan(db, tempRoot);
    const rel = toWorkspaceRelPath(tempRoot, path.join(dir, 'solution.ts'));
    const entry = plan.find((e) => e.relPath === rel);
    expect(entry).toBeDefined();
    // No .hbs template ships for a bare solution.ts stub in this repo layout,
    // so the stub is the empty-placeholder render (possibly '').
    expect(typeof entry?.baselineContent).toBe('string');
  });

  it('includes design-category notes.md as a solution file', () => {
    const dir = writeDesignQuestion('design-fe', 'infinite-scroll', '# my notes\n');
    db.upsertQuestion({
      category: 'design-fe',
      slug: 'infinite-scroll',
      title: 'Infinite scroll',
      difficulty: 'medium',
      suggestedMinutes: 40,
      dirPath: dir,
      source: 'manual',
    });

    const plan = collectRestorePlan(db, tempRoot);
    const rel = toWorkspaceRelPath(tempRoot, path.join(dir, 'notes.md'));
    const entry = plan.find((e) => e.relPath === rel);
    expect(entry?.currentContent).toBe('# my notes\n');
  });

  it('excludes questions with missingAt set', () => {
    const dir = writeCodingQuestion('js-ts', 'gone');
    db.upsertQuestion({
      category: 'js-ts',
      slug: 'gone',
      title: 'Gone',
      difficulty: 'easy',
      suggestedMinutes: 15,
      dirPath: dir,
      source: 'manual',
    });
    const present = db.listQuestions().filter((q) => q.slug !== 'gone').map((q) => q.id);
    const goneId = db.getQuestion('js-ts', 'gone')!.id;
    db.setMissing(present, [goneId]);

    const plan = collectRestorePlan(db, tempRoot);
    expect(plan.some((e) => e.slug === 'gone')).toBe(false);
  });

  it('excludes rows under unknown categories', () => {
    const dir = questionDir('not-a-category', 'orphan');
    fs.mkdirSync(dir, { recursive: true });
    db.upsertQuestion({
      category: 'not-a-category',
      slug: 'orphan',
      title: 'Orphan',
      difficulty: 'easy',
      suggestedMinutes: 15,
      dirPath: dir,
      source: 'manual',
    });

    const plan = collectRestorePlan(db, tempRoot);
    expect(plan.some((e) => e.slug === 'orphan')).toBe(false);
  });

  it('sets currentContent to null when the file is absent on disk', () => {
    const dir = writeCodingQuestion('js-ts', 'partial');
    db.upsertQuestion({
      category: 'js-ts',
      slug: 'partial',
      title: 'Partial',
      difficulty: 'easy',
      suggestedMinutes: 15,
      dirPath: dir,
      source: 'manual',
    });
    fs.rmSync(path.join(dir, 'solution.ts'));

    const plan = collectRestorePlan(db, tempRoot);
    const rel = toWorkspaceRelPath(tempRoot, path.join(dir, 'solution.ts'));
    const entry = plan.find((e) => e.relPath === rel);
    expect(entry?.currentContent).toBeNull();
  });

  it('never includes test files, even when they have their own scaffold snapshots', () => {
    const dir = writeCodingQuestion('js-ts', 'has-test-scaffold');
    const question = db.upsertQuestion({
      category: 'js-ts',
      slug: 'has-test-scaffold',
      title: 'Has test scaffold',
      difficulty: 'easy',
      suggestedMinutes: 15,
      dirPath: dir,
      source: 'manual',
    });
    const testRel = toWorkspaceRelPath(tempRoot, path.join(dir, 'solution.test.ts'));
    const hash = saveBlob(tempRoot, 'it("scaffold test", () => {});\n');
    db.addSnapshot({
      questionId: question.id,
      attemptId: null,
      relPath: testRel,
      hash,
      trigger: 'scaffold',
    });

    const plan = collectRestorePlan(db, tempRoot);
    expect(plan.some((e) => e.relPath === testRel)).toBe(false);
    // Only the solution file made it into the plan for this question.
    expect(plan.filter((e) => e.slug === 'has-test-scaffold')).toHaveLength(1);
  });
});

describe('snapshotPreResetState', () => {
  it('writes a reset snapshot + blob for every entry with non-null currentContent', () => {
    const dir = writeCodingQuestion('js-ts', 'save-me', { solution: 'export const y = 2;\n' });
    const question = db.upsertQuestion({
      category: 'js-ts',
      slug: 'save-me',
      title: 'Save me',
      difficulty: 'easy',
      suggestedMinutes: 15,
      dirPath: dir,
      source: 'manual',
    });
    const plan = collectRestorePlan(db, tempRoot);

    snapshotPreResetState(db, tempRoot, plan);

    const rel = toWorkspaceRelPath(tempRoot, path.join(dir, 'solution.ts'));
    const snap = db.getLatestSnapshot(question.id, rel, 'reset');
    expect(snap).not.toBeNull();
    expect(readBlob(tempRoot, snap!.hash)).toBe('export const y = 2;\n');
  });

  it('skips entries with null currentContent', () => {
    const dir = writeCodingQuestion('js-ts', 'missing-file');
    const question = db.upsertQuestion({
      category: 'js-ts',
      slug: 'missing-file',
      title: 'Missing file',
      difficulty: 'easy',
      suggestedMinutes: 15,
      dirPath: dir,
      source: 'manual',
    });
    fs.rmSync(path.join(dir, 'solution.ts'));
    const plan = collectRestorePlan(db, tempRoot);

    snapshotPreResetState(db, tempRoot, plan);

    const rel = toWorkspaceRelPath(tempRoot, path.join(dir, 'solution.ts'));
    expect(db.getLatestSnapshot(question.id, rel, 'reset')).toBeNull();
  });

  it('propagates a blob write failure so callers abort the reset', () => {
    const dir = writeCodingQuestion('js-ts', 'blob-fail', { solution: 'x\n' });
    db.upsertQuestion({
      category: 'js-ts',
      slug: 'blob-fail',
      title: 'Blob fail',
      difficulty: 'easy',
      suggestedMinutes: 15,
      dirPath: dir,
      source: 'manual',
    });
    const plan = collectRestorePlan(db, tempRoot);

    // Make the blobs dir unwritable by replacing it with a file.
    const blobsDir = path.join(tempRoot, '.ace', 'blobs');
    fs.rmSync(blobsDir, { recursive: true, force: true });
    fs.writeFileSync(blobsDir, 'not a directory', 'utf-8');

    expect(() => snapshotPreResetState(db, tempRoot, plan)).toThrow();

    fs.rmSync(blobsDir, { force: true });
  });
});

describe('applyRestorePlan', () => {
  function buildOldAndNewDbs(): {
    oldDir: string;
    plan: RestorePlan;
    testScaffoldHash: string;
  } {
    const dir = writeCodingQuestion('js-ts', 'restore-me', {
      solution: 'export const solved = true;\n',
      test: 'it("edited by dispute", () => {});\n',
    });
    const question = db.upsertQuestion({
      category: 'js-ts',
      slug: 'restore-me',
      title: 'Restore me',
      difficulty: 'medium',
      suggestedMinutes: 30,
      dirPath: dir,
      source: 'manual',
    });
    const solutionRel = toWorkspaceRelPath(tempRoot, path.join(dir, 'solution.ts'));
    const testRel = toWorkspaceRelPath(tempRoot, path.join(dir, 'solution.test.ts'));
    const scaffoldHash = saveBlob(tempRoot, 'export const scaffold = true;\n');
    db.addSnapshot({
      questionId: question.id,
      attemptId: null,
      relPath: solutionRel,
      hash: scaffoldHash,
      trigger: 'scaffold',
    });
    // A test-file scaffold snapshot exists too, but must never be restored.
    const testScaffoldHash = saveBlob(tempRoot, 'it("original", () => {});\n');
    db.addSnapshot({
      questionId: question.id,
      attemptId: null,
      relPath: testRel,
      hash: testScaffoldHash,
      trigger: 'scaffold',
    });

    const plan = collectRestorePlan(db, tempRoot);
    return { oldDir: dir, plan, testScaffoldHash };
  }

  it('full mode: writes baseline content to disk and seeds one scaffold snapshot per file', () => {
    const { oldDir, plan, testScaffoldHash } = buildOldAndNewDbs();
    const testAbs = path.join(oldDir, 'solution.test.ts');
    const testContentBefore = fs.readFileSync(testAbs, 'utf-8');
    const testMtimeBefore = fs.statSync(testAbs).mtimeMs;

    const result = applyRestorePlan(db, tempRoot, plan, 'full');

    const solutionAbs = path.join(oldDir, 'solution.ts');
    expect(fs.readFileSync(solutionAbs, 'utf-8')).toBe('export const scaffold = true;\n');
    // The edited test file is untouched — content and mtime unchanged.
    expect(fs.readFileSync(testAbs, 'utf-8')).toBe(testContentBefore);
    expect(fs.statSync(testAbs).mtimeMs).toBe(testMtimeBefore);

    expect(result).toEqual({ questions: 1, files: 1 });

    const question = db.getQuestion('js-ts', 'restore-me')!;
    const solutionRel = toWorkspaceRelPath(tempRoot, solutionAbs);
    const testRel = toWorkspaceRelPath(tempRoot, testAbs);
    const solutionSnap = db.getLatestSnapshot(question.id, solutionRel, 'scaffold');
    expect(solutionSnap).not.toBeNull();
    expect(readBlob(tempRoot, solutionSnap!.hash)).toBe('export const scaffold = true;\n');

    // The test file's scaffold snapshot is still exactly the one seeded
    // manually in buildOldAndNewDbs — applyRestorePlan never touched it.
    const testSnap = db.getLatestSnapshot(question.id, testRel, 'scaffold');
    expect(testSnap?.hash).toBe(testScaffoldHash);
  });

  it('skips entries whose question no longer resolves in the new db, without throwing', () => {
    const dir = writeCodingQuestion('js-ts', 'vanished', { solution: 'x\n' });
    db.upsertQuestion({
      category: 'js-ts',
      slug: 'vanished',
      title: 'Vanished',
      difficulty: 'easy',
      suggestedMinutes: 15,
      dirPath: dir,
      source: 'manual',
    });
    const plan = collectRestorePlan(db, tempRoot);

    // Simulate a second, unrelated db (as if opened fresh post-reset) that
    // never saw this question.
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-reset-other-'));
    fs.mkdirSync(path.join(otherRoot, 'questions'), { recursive: true });
    const otherDb = openDb(otherRoot);
    try {
      expect(() => applyRestorePlan(otherDb, otherRoot, plan, 'full')).not.toThrow();
      expect(applyRestorePlan(otherDb, otherRoot, plan, 'full')).toEqual({ questions: 0, files: 0 });
    } finally {
      otherDb.close();
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('progress mode: leaves disk untouched but still seeds scaffold snapshots', () => {
    const { oldDir, plan } = buildOldAndNewDbs();
    const solutionAbs = path.join(oldDir, 'solution.ts');
    const contentBefore = fs.readFileSync(solutionAbs, 'utf-8');
    const mtimeBefore = fs.statSync(solutionAbs).mtimeMs;

    const result = applyRestorePlan(db, tempRoot, plan, 'progress');

    expect(fs.readFileSync(solutionAbs, 'utf-8')).toBe(contentBefore);
    expect(fs.statSync(solutionAbs).mtimeMs).toBe(mtimeBefore);
    expect(result).toEqual({ questions: 0, files: 0 });

    const question = db.getQuestion('js-ts', 'restore-me')!;
    const solutionRel = toWorkspaceRelPath(tempRoot, solutionAbs);
    const snap = db.getLatestSnapshot(question.id, solutionRel, 'scaffold');
    expect(snap).not.toBeNull();
    expect(readBlob(tempRoot, snap!.hash)).toBe('export const scaffold = true;\n');
  });
});

describe('engine busy flags', () => {
  it('Runner.isBusy() is false at rest, true while a run is in flight, false again after it finishes', async () => {
    const { createRunner } = await import('./runner.js');
    const dir = writeCodingQuestion('js-ts', 'slow-run');
    const question = db.upsertQuestion({
      category: 'js-ts',
      slug: 'slow-run',
      title: 'Slow run',
      difficulty: 'easy',
      suggestedMinutes: 15,
      dirPath: dir,
      source: 'manual',
    });

    // A trivially slow fake "vitest" binary so the run stays in flight long
    // enough to observe isBusy() === true before it exits.
    const binDir = path.join(tempRoot, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const vitestBin = path.join(binDir, 'vitest');
    fs.writeFileSync(
      vitestBin,
      '#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 150);\n',
      { mode: 0o755 },
    );

    const bus = createBus();
    const runner = createRunner({ db, bus, workspaceRoot: tempRoot });
    expect(runner.isBusy()).toBe(false);

    const done = new Promise<void>((resolve) => {
      bus.subscribe((name) => {
        if (name === 'run-done') resolve();
      });
    });

    runner.start(question, null, 'manual');
    expect(runner.isBusy()).toBe(true);

    await done;
    expect(runner.isBusy()).toBe(false);
  }, 15000);

  describe('LLM-backed engines (mock provider)', () => {
    beforeAll(() => {
      process.env.ACE_E2E_MOCK_LLM = '1';
    });

    it('ReviewEngine.isAnyRunning() is false at rest and true then false around a mock-LLM run', async () => {
      const { createReviewEngine } = await import('./reviews.js');
      const dir = writeCodingQuestion('js-ts', 'reviewed', { solution: 'export const x = 1;\n' });
      const question = db.upsertQuestion({
        category: 'js-ts',
        slug: 'reviewed',
        title: 'Reviewed',
        difficulty: 'easy',
        suggestedMinutes: 15,
        dirPath: dir,
        source: 'manual',
      });

      const bus = createBus();
      const reviews = createReviewEngine({ db, bus, workspaceRoot: tempRoot });
      expect(reviews.isAnyRunning()).toBe(false);

      const settled = new Promise<void>((resolve) => {
        bus.subscribe((name) => {
          if (name === 'review-done' || name === 'review-error') resolve();
        });
      });

      reviews.start(question, null);
      expect(reviews.isAnyRunning()).toBe(true);

      await settled;
      expect(reviews.isAnyRunning()).toBe(false);
    });

    it('DisputeEngine.isAnyRunning() is false at rest and true then false around a mock-LLM run', async () => {
      const { createDisputeEngine } = await import('./disputes.js');
      const dir = writeCodingQuestion('js-ts', 'disputed', {
        solution: 'export const x = 1;\n',
        test: 'it("fails", () => { expect(true).toBe(false); });\n',
      });
      const question = db.upsertQuestion({
        category: 'js-ts',
        slug: 'disputed',
        title: 'Disputed',
        difficulty: 'easy',
        suggestedMinutes: 15,
        dirPath: dir,
        source: 'manual',
      });
      const run = db.createTestRun({ questionId: question.id, attemptId: null, trigger: 'manual' });

      const bus = createBus();
      const disputes = createDisputeEngine({ db, bus, workspaceRoot: tempRoot });
      expect(disputes.isAnyRunning()).toBe(false);

      const settled = new Promise<void>((resolve) => {
        bus.subscribe((name) => {
          if (name === 'dispute-done' || name === 'dispute-error') resolve();
        });
      });

      disputes.start(question, run, null);
      expect(disputes.isAnyRunning()).toBe(true);

      await settled;
      expect(disputes.isAnyRunning()).toBe(false);
    });
  });
});
