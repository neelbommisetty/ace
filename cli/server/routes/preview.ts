import type { Hono } from 'hono';
import type { RouteContext } from './context.js';

/**
 * Live preview (NEE-348). The dev server itself listens on its own
 * 127.0.0.1 port (see cli/server/preview.ts for the trust posture) — these
 * routes only control/observe its lifecycle from behind the token-guarded
 * ace API.
 */
export function registerPreviewRoutes(app: Hono, ctx: RouteContext): void {
  app.get('/api/preview', (c) => c.json(ctx.preview.status(ctx.requireWorkspaceRoot())));

  // Lazy start: resolves once the server is 'ready' (with its URL) or
  // 'failed' (with the reason — e.g. exactly which dependency is missing).
  // Idempotent while running; a stopped/failed preview starts fresh.
  app.post('/api/preview/open', async (c) =>
    c.json(await ctx.preview.open(ctx.requireWorkspaceRoot())),
  );
}
