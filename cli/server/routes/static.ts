import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import type { RouteContext } from './context.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/**
 * Registered LAST: the API 404 fallback must come after every /api route,
 * and the SPA handler catches everything else. (No token required for the
 * static UI; GET only, SPA fallback to index.html.)
 */
export function registerStaticRoutes(app: Hono, ctx: RouteContext): void {
  // Unknown API routes are JSON 404s, never the SPA fallback.
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  app.get('*', (c) => {
    const { uiDir } = ctx;
    if (!uiDir) return c.text('ACE UI not built. Run: npm run build');

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.json({ error: 'bad request' }, 400);
    }
    if (pathname.includes('..') || pathname.includes('\\') || pathname.includes('\0')) {
      return c.json({ error: 'not found' }, 404);
    }

    const ext = path.extname(pathname);
    if (ext) {
      const contentType = CONTENT_TYPES[ext];
      const filePath = path.join(uiDir, pathname);
      if (!contentType || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return c.json({ error: 'not found' }, 404);
      }
      const cacheControl =
        pathname === '/index.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
      return c.body(new Uint8Array(fs.readFileSync(filePath)), 200, {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
      });
    }

    const indexPath = path.join(uiDir, 'index.html');
    if (!fs.existsSync(indexPath)) return c.text('ACE UI not built. Run: npm run build');
    return c.body(fs.readFileSync(indexPath, 'utf8'), 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
  });
}
