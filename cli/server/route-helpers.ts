import type { Context, MiddlewareHandler } from 'hono';
import type { RouteContext } from './routes/context.js';
import { resolveProvider } from './settings.js';
import type { QuestionRow } from './types.js';

declare module 'hono' {
  interface ContextVariableMap {
    /** Stashed by the question-lookup middleware below; handlers read it via c.get('question'). */
    question: QuestionRow;
  }
}

/** Reads a JSON body; null for invalid JSON or a non-object root. */
export async function readJsonBody(c: {
  req: { json(): Promise<unknown> };
}): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The one shared `?limit=` parser. A missing or EMPTY `limit` falls back to
 * `opts.default` (possibly undefined, meaning the db layer's own default —
 * historically `/api/test-runs` 400'd on `?limit=` while every other route
 * fell back; all routes now agree on the fall-back behaviour). Anything else
 * must parse as a positive integer and is capped at `opts.max`.
 */
export function parseLimit(
  c: Context,
  opts: { default: number; max: number },
): { ok: true; limit: number } | { ok: false; response: Response };
export function parseLimit(
  c: Context,
  opts: { max: number },
): { ok: true; limit: number | undefined } | { ok: false; response: Response };
export function parseLimit(
  c: Context,
  opts: { default?: number; max: number },
): { ok: true; limit: number | undefined } | { ok: false; response: Response } {
  const rawLimit = c.req.query('limit');
  if (rawLimit === undefined || rawLimit === '') return { ok: true, limit: opts.default };
  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return { ok: false, response: c.json({ error: 'limit must be a positive integer' }, 400) };
  }
  return { ok: true, limit: Math.min(parsed, opts.max) };
}

/** Returns the 503 refusal when no LLM provider is configured, or null to proceed. */
export function requireProvider(c: Context): Response | null {
  if (resolveProvider()) return null;
  return c.json({ error: 'no LLM API key configured — add one in Settings' }, 503);
}

/**
 * Middleware for `/api/questions/:category/:slug/*` routes: resolves the
 * question once, 404s when it does not exist, and stashes the row on the
 * context for handlers to read via `c.get('question')`.
 */
export function questionLookup(ctx: RouteContext): MiddlewareHandler {
  return async (c, next) => {
    const category = c.req.param('category') ?? '';
    const slug = c.req.param('slug') ?? '';
    const question = ctx.requireSession().db.getQuestion(category, slug);
    if (!question) return c.json({ error: 'question not found' }, 404);
    c.set('question', question);
    await next();
  };
}
