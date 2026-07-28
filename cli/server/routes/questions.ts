import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { CATEGORIES, type CategoryConfig } from '../../lib/categories.js';
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

    const config = (CATEGORIES as Record<string, CategoryConfig | undefined>)[question.category];
    const files: QuestionFileInfo[] = [];
    if (config) {
      for (const name of config.solutionFiles) {
        files.push({
          name,
          relPath: toWorkspaceRelPath(workspaceRoot, path.join(question.dirPath, name)),
          kind: name === 'notes.md' ? 'notes' : 'solution',
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
}
