import type { Hono } from 'hono';
import { copyStarterPack } from '../../lib/starter-pack.js';
import type { StarterPackInstallResult } from '../types.js';
import type { RouteContext } from './context.js';

/**
 * Starter pack route (NEE-301) — the "an existing workspace can adopt the
 * bundled questions too" half of the first-run fix. `ace init` copies the same
 * pack onto disk for brand new workspaces; this is what the Library's
 * "Add starter questions" action calls.
 *
 * Deliberately NOT gated on a provider: the whole point of the pack is that it
 * works with no API key and costs nothing.
 */
export function registerStarterPackRoutes(app: Hono, ctx: RouteContext): void {
  app.post('/api/starter-pack', (c) => {
    const workspaceRoot = ctx.requireWorkspaceRoot();
    const session = ctx.requireSession();

    // copyStarterPack skips any question whose directory already exists, so a
    // double-click (or a second tab) adds nothing and overwrites nothing.
    const copied = copyStarterPack(workspaceRoot);

    // Reconcile inline rather than waiting for the watcher's 500ms debounce —
    // the caller refetches the library the moment this response lands, and a
    // workspace mounted with `watch: false` has no watcher at all.
    session.reconcile();

    if (copied.installed.length > 0) {
      ctx.bus.emit('questions-changed', {});
    }

    const result: StarterPackInstallResult = {
      installed: copied.installed,
      skipped: copied.skipped,
      unavailable: copied.unavailable,
    };
    return c.json(result);
  });
}
