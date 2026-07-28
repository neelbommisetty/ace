import path from 'node:path';
import type { Hono } from 'hono';
import { getQuestionsDir } from '../../lib/paths.js';
import type { WorkspaceInfo } from '../types.js';
import { readRecentWorkspaces } from '../workspace-registry.js';
import type { RouteContext } from './context.js';

/** Shared by GET /api/workspace and the reset/switch routes' 200 responses. */
export function computeWorkspaceInfo(ctx: RouteContext): WorkspaceInfo {
  const workspaceRoot = ctx.requireWorkspaceRoot();
  const { db, skippedDirs } = ctx.requireSession();
  const questions = db.listQuestions();
  let attempts = 0;
  let testRuns = 0;
  for (const q of questions) {
    attempts += q.stats.attemptCount;
    testRuns += db.listTestRuns(q.id, 100000).length;
  }

  let legacyImport = { available: false, questionCount: 0 };
  try {
    const pending = ctx.importer
      .previewImport(db, workspaceRoot)
      .filter((item) => !item.alreadyImported);
    legacyImport = { available: pending.length > 0, questionCount: pending.length };
  } catch {
    // a broken legacy tree must not take down the workspace endpoint
  }

  return {
    root: workspaceRoot,
    questionsDir: getQuestionsDir(workspaceRoot),
    version: ctx.version,
    counts: { questions: questions.length, attempts, testRuns },
    skippedDirs,
    legacyImport,
    activeAttempt: db.getLatestActiveAttempt(),
    confirmName: path.basename(workspaceRoot),
  };
}

export function registerWorkspaceRoutes(app: Hono, ctx: RouteContext): void {
  app.get('/api/health', (c) => c.json({ ok: true, version: ctx.version }));

  app.get('/api/workspace', (c) => c.json(computeWorkspaceInfo(ctx)));

  app.get('/api/import/preview', (c) =>
    c.json({
      items: ctx.importer.previewImport(ctx.requireSession().db, ctx.requireWorkspaceRoot()),
    }),
  );

  app.post('/api/import/run', (c) =>
    c.json(ctx.importer.runImport(ctx.requireSession().db, ctx.requireWorkspaceRoot())),
  );

  // Exempt from the no-workspace gate: the picker needs it before anything
  // is mounted. Dead/uninitialized roots are filtered at read time.
  app.get('/api/workspace/recents', (c) => c.json({ recents: readRecentWorkspaces() }));
}
