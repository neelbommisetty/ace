import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { isProseAnswer, lookupCategoryConfig } from '../../lib/categories.js';
import { readBlob } from '../blobs.js';
import { toWorkspaceRelPath } from '../files.js';
import { questionLookup } from '../route-helpers.js';
import type { QuestionDetail, QuestionFileInfo } from '../types.js';
import type { RouteContext } from './context.js';

export function registerQuestionRoutes(app: Hono, ctx: RouteContext): void {
  const lookupQuestion = questionLookup(ctx);

  app.get('/api/questions', (c) => c.json(ctx.requireSession().db.listQuestions()));

  app.get('/api/questions/:category/:slug', lookupQuestion, (c) => {
    const workspaceRoot = ctx.requireWorkspaceRoot();
    const { db } = ctx.requireSession();
    const question = c.get('question');

    let readme = '';
    try {
      readme = fs.readFileSync(path.join(question.dirPath, 'README.md'), 'utf8');
    } catch {
      // missing README → ''
    }

    const config = lookupCategoryConfig(question.category);
    const files: QuestionFileInfo[] = [];
    if (config) {
      const solutionKind = isProseAnswer(config) ? 'notes' : 'solution';
      for (const name of config.solutionFiles) {
        files.push({
          name,
          relPath: toWorkspaceRelPath(workspaceRoot, path.join(question.dirPath, name)),
          kind: solutionKind,
          readonly: false,
        });
      }
      for (const name of config.testFiles) {
        files.push({
          name,
          relPath: toWorkspaceRelPath(workspaceRoot, path.join(question.dirPath, name)),
          kind: 'test',
          readonly: true,
        });
      }
      // Gated on existence (unlike solutionFiles/testFiles above, which the
      // scaffold guarantees): pre-existing react-apps questions generated
      // before the support-module feature landed have no api.ts on disk, and
      // listing it anyway would show a phantom, permanently-404ing tab.
      for (const name of config.supportFiles) {
        if (!fs.existsSync(path.join(question.dirPath, name))) continue;
        files.push({
          name,
          relPath: toWorkspaceRelPath(workspaceRoot, path.join(question.dirPath, name)),
          kind: 'support',
          readonly: true,
        });
      }
    }

    const detail: QuestionDetail = {
      question,
      readme,
      files,
      activeAttempt: db.getActiveAttempt(question.id),
      lastRun: db.getLatestTestRun(question.id),
    };
    return c.json(detail);
  });

  // Archive/unarchive (NEE-296): flips `archivedAt` only — files on disk,
  // attempts, reviews, and disputes are all left untouched. Offered on
  // 'missing' rows too, so a directory deleted on disk can finally be
  // cleared out of the Library.
  app.post('/api/questions/:category/:slug/archive', lookupQuestion, (c) => {
    const { db } = ctx.requireSession();
    const question = c.get('question');
    const updated = db.archiveQuestion(question.id);
    if (!updated) return c.json({ error: 'question not found' }, 404);
    ctx.bus.emit('questions-changed', {});
    return c.json({ question: updated });
  });

  app.post('/api/questions/:category/:slug/unarchive', lookupQuestion, (c) => {
    const { db } = ctx.requireSession();
    const question = c.get('question');
    const updated = db.unarchiveQuestion(question.id);
    if (!updated) return c.json({ error: 'question not found' }, 404);
    ctx.bus.emit('questions-changed', {});
    return c.json({ question: updated });
  });

  // Minimal snapshot surfacing (NEE-363): a question solved by tests (or by
  // review-free prose) then reset-to-stub previously had no in-app way to
  // recover the pre-reset code — the only viewable blob was a review's
  // snapshotHash. Restricted to `config.solutionFiles` (never test files):
  // this is "past attempt code", not a test-file archaeology tool. Newest
  // first, straight off `listSnapshotsForQuestion` — no restore action, just
  // visibility.
  app.get('/api/questions/:category/:slug/snapshots', lookupQuestion, (c) => {
    const workspaceRoot = ctx.requireWorkspaceRoot();
    const { db } = ctx.requireSession();
    const question = c.get('question');
    const config = lookupCategoryConfig(question.category);
    const solutionRelPaths = new Set(
      (config?.solutionFiles ?? []).map((name) =>
        toWorkspaceRelPath(workspaceRoot, path.join(question.dirPath, name)),
      ),
    );
    const snapshots = db
      .listSnapshotsForQuestion(question.id)
      .filter((s) => solutionRelPaths.has(s.relPath));
    return c.json(snapshots);
  });

  // Blob-view for a single snapshot — same shape/pattern as GET
  // /api/reviews/:id's snapshotContent (reviews.ts): null content when the
  // blob is gone from disk rather than a 404, so the UI can say so instead
  // of erroring.
  app.get('/api/snapshots/:id', (c) => {
    const { db } = ctx.requireSession();
    const snapshot = db.getSnapshot(c.req.param('id'));
    if (!snapshot) return c.json({ error: 'snapshot not found' }, 404);
    const content = readBlob(ctx.requireWorkspaceRoot(), snapshot.hash);
    return c.json({ ...snapshot, content });
  });
}
