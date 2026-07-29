import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { isProseAnswer, lookupCategoryConfig } from '../../lib/categories.js';
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
}
