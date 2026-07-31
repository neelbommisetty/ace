import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { scaffoldQuestionAt } from '../../lib/scaffold.js';
import { getQuestionsDir } from '../../lib/paths.js';
import { readJsonBody } from '../route-helpers.js';
import type { PlaygroundCreateResult } from '../types.js';
import type { RouteContext } from './context.js';

const SCRATCH_DIR_RE = /^scratch-(\d+)$/;

/** Next `scratch-N` slug for `category` — one past the highest existing N (1 when none exist yet). */
function nextScratchSlug(questionsDir: string, category: string): string {
  const categoryDir = path.join(questionsDir, category);
  let highest = 0;
  if (fs.existsSync(categoryDir)) {
    for (const entry of fs.readdirSync(categoryDir)) {
      const m = SCRATCH_DIR_RE.exec(entry);
      if (m) highest = Math.max(highest, Number.parseInt(m[1], 10));
    }
  }
  return `scratch-${highest + 1}`;
}

/**
 * Playground route (NEE-387): materializes a blank "scratch pad" question
 * with zero LLM calls — the starter-pack.ts mold (scaffold, inline
 * session.reconcile(), broadcast 'questions-changed'), deliberately NOT
 * gated on a provider, since the whole point is that it costs nothing and
 * needs no API key.
 *
 * The scan-for-the-next-N + scaffold is fully synchronous inside this one
 * handler (no `await` in between), so a double-click can't race two requests
 * into the same `scratch-N` slug — scaffoldQuestionAt's "already exists"
 * throw is the only way that could show, and it can't happen here.
 */
export function registerPlaygroundRoutes(app: Hono, ctx: RouteContext): void {
  app.post('/api/playground', async (c) => {
    const workspaceRoot = ctx.requireWorkspaceRoot();
    const session = ctx.requireSession();

    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);

    const kind = body.kind;
    if (kind !== 'react' && kind !== 'ts') {
      return c.json({ error: 'kind must be "react" or "ts"' }, 400);
    }
    const category = kind === 'react' ? 'playground' : 'playground-ts';

    const questionsDir = getQuestionsDir(workspaceRoot);
    const slug = nextScratchSlug(questionsDir, category);
    const n = slug.slice('scratch-'.length);

    scaffoldQuestionAt(workspaceRoot, {
      title: `Scratch #${n}`,
      slug,
      category,
      difficulty: 'easy',
      description:
        'A scratch playground — nothing here is graded. Edit freely, experiment, throw it away.',
    });
    // No writeScorecard: the reconciler sees no scorecard.json and derives
    // source: 'manual' for this question (cli/server/reconciler.ts).

    session.reconcile();
    ctx.bus.emit('questions-changed', {});

    const result: PlaygroundCreateResult = { category, slug };
    return c.json(result);
  });
}
