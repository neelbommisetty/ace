import type { Hono } from 'hono';
import { parseLimit } from '../route-helpers.js';
import type { RouteContext } from './context.js';

export function registerHistoryRoutes(app: Hono, ctx: RouteContext): void {
  app.get('/api/history', (c) => {
    const { db } = ctx.requireSession();
    const q = c.req.query('q');
    const category = c.req.query('category');

    // Optional "<category>/<slug>" filter so a question's full history is
    // server-side, not a client-side slice of the newest page.
    const rawQuestion = c.req.query('question');
    let questionId: string | undefined;
    if (rawQuestion !== undefined && rawQuestion !== '') {
      const slash = rawQuestion.indexOf('/');
      const qrow =
        slash > 0
          ? db.getQuestion(rawQuestion.slice(0, slash), rawQuestion.slice(slash + 1))
          : null;
      if (!qrow) return c.json({ items: [] });
      questionId = qrow.id;
    }

    const rawType = c.req.query('type');
    let type: 'review' | 'dispute' | undefined;
    if (rawType !== undefined && rawType !== '') {
      if (rawType !== 'review' && rawType !== 'dispute') {
        return c.json({ error: 'type must be "review" or "dispute"' }, 400);
      }
      type = rawType;
    }

    const limit = parseLimit(c, { max: 500 });
    if (!limit.ok) return limit.response;

    return c.json({
      items: db.searchHistory({
        q: q || undefined,
        category: category || undefined,
        type,
        questionId,
        limit: limit.limit,
      }),
    });
  });
}
