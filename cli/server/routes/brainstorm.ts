import type { Hono } from 'hono';
import { parseLimit, readJsonBody, requireProvider } from '../route-helpers.js';
import type { RouteContext } from './context.js';

export function registerBrainstormRoutes(app: Hono, ctx: RouteContext): void {
  app.post('/api/brainstorm/turns', async (c) => {
    const { db, brainstorm } = ctx.requireSession();
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);

    const message = body.message;
    if (typeof message !== 'string' || message.length < 1 || message.length > 4000) {
      return c.json({ error: 'message must be a string between 1 and 4000 characters' }, 400);
    }

    let sessionId: string | null = null;
    if (body.sessionId !== undefined && body.sessionId !== null) {
      if (typeof body.sessionId !== 'string') {
        return c.json({ error: 'sessionId must be a string' }, 400);
      }
      if (!db.getBrainstormSession(body.sessionId)) {
        return c.json({ error: 'brainstorm session not found' }, 404);
      }
      if (brainstorm.isThinking(body.sessionId)) {
        return c.json(
          { error: 'a brainstorm turn is already running for this session' },
          409,
        );
      }
      sessionId = body.sessionId;
    }

    const noProvider = requireProvider(c);
    if (noProvider) return noProvider;

    const { sessionId: id } = brainstorm.startTurn(sessionId, message);
    return c.json({ sessionId: id }, 202);
  });

  app.get('/api/brainstorm/sessions', (c) => {
    const { db } = ctx.requireSession();
    const limit = parseLimit(c, { default: 20, max: 100 });
    if (!limit.ok) return limit.response;
    const sessions = db.listBrainstormSessions(limit.limit).map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      updatedAt: s.updatedAt,
    }));
    return c.json({ sessions });
  });

  app.get('/api/brainstorm/sessions/:id', (c) => {
    const { db } = ctx.requireSession();
    const session = db.getBrainstormSession(c.req.param('id'));
    if (!session) return c.json({ error: 'brainstorm session not found' }, 404);
    return c.json({ session });
  });
}
