import crypto from 'node:crypto';
import path from 'node:path';
import type { Hono } from 'hono';
import { isWorkspaceInitialized } from '../../lib/paths.js';
import { performWorkspaceReset } from '../reset-orchestrator.js';
import { readJsonBody } from '../route-helpers.js';
import type { WorkspaceSession } from '../session.js';
import { performWorkspaceSwitch } from '../switch-orchestrator.js';
import type { WorkspaceResetMode } from '../types.js';
import type { RouteContext } from './context.js';
import { computeWorkspaceInfo } from './workspace.js';

const VALID_RESET_MODES: ReadonlySet<string> = new Set<WorkspaceResetMode>(['progress', 'full']);

const SWAP_IN_PROGRESS_ERROR = 'a workspace reset or switch is already in progress';

/**
 * The six idle-engine preconditions shared by POST /api/workspace/reset
 * and POST /api/workspace/switch (NEE-164): both tear the session down,
 * which must never happen under a live test run or a paid LLM stream.
 * Returns the user-facing refusal, or null when every engine is idle.
 */
function getBusyEngineError(session: WorkspaceSession): string | null {
  if (session.runner.isBusy()) {
    return 'a test run is in progress — wait for it to finish and try again';
  }
  if (session.reviews.isAnyRunning()) {
    return 'a review is streaming — wait for it to finish and try again';
  }
  if (session.disputes.isAnyRunning()) {
    return 'a dispute analysis is in progress — wait for it to finish and try again';
  }
  // NEE-345: a live paid probe call must not have its db closed out from
  // under it any more than review/dispute/generation/brainstorm can.
  if (session.probes.isAnyRunning()) {
    return 'a follow-up probe run is in progress — wait for it to finish and try again';
  }
  if (session.generation.isAnyRunning()) {
    return 'a generation is in progress — wait for it to finish and try again';
  }
  if (session.brainstorm.isAnyRunning()) {
    return 'a brainstorm turn is in progress — wait for it to finish and try again';
  }
  return null;
}

export function registerResetRoutes(app: Hono, ctx: RouteContext): void {
  app.post('/api/workspace/reset', async (c) => {
    const workspaceRoot = ctx.requireWorkspaceRoot();
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);

    const rawMode = body.mode;
    if (typeof rawMode !== 'string' || !VALID_RESET_MODES.has(rawMode)) {
      return c.json({ error: 'mode must be "progress" or "full"' }, 400);
    }
    const mode = rawMode as WorkspaceResetMode;

    const expectedConfirm = path.basename(workspaceRoot);
    const confirm = body.confirm;
    if (typeof confirm !== 'string' || confirm !== expectedConfirm) {
      return c.json(
        { error: `type the workspace folder name "${expectedConfirm}" to confirm` },
        400,
      );
    }

    // Echoed back in the `workspace-reset` broadcast so the initiating tab
    // can tell its own reset's broadcast apart from one a different tab
    // triggered (the HTTP response and the SSE broadcast race independently
    // and can arrive in either order). A caller that omits it still gets a
    // working reset — it just gets a server-minted id back with no client
    // to match it against.
    const requestId =
      typeof body.requestId === 'string' && body.requestId.length > 0
        ? body.requestId
        : crypto.randomUUID();

    // Checked at route entry — reachable only because this route is exempt
    // from the mid-swap 503 gate in app.ts (a concurrent reset POST answers
    // from here, not the gate).
    if (ctx.isSwapping()) {
      return c.json({ error: SWAP_IN_PROGRESS_ERROR }, 409);
    }

    const busyError = getBusyEngineError(ctx.requireSession());
    if (busyError) return c.json({ error: busyError }, 409);

    try {
      const result = await performWorkspaceReset({
        workspaceRoot,
        bus: ctx.bus,
        getSession: ctx.requireSession,
        // A reset rebuilds the session over the SAME root — only the session
        // half of the pair swaps.
        swapSession: (session) => ctx.swapWorkspace(workspaceRoot, session),
        setSwapping: ctx.setSwapping,
        mode,
        confirm,
        requestId,
        engines: ctx.engines,
        drainRequests: ctx.waitForRequestDrain,
      });
      return c.json({
        mode,
        archivedTo: result.archivedTo,
        restored: result.restored,
        workspace: computeWorkspaceInfo(ctx),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'workspace reset failed' }, 500);
    }
  });

  app.post('/api/workspace/switch', async (c) => {
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);

    const rawRoot = body.root;
    if (typeof rawRoot !== 'string' || rawRoot.trim().length === 0) {
      return c.json({ error: 'root must be a non-empty string' }, 400);
    }
    const newRoot = path.resolve(rawRoot.trim());
    if (!isWorkspaceInitialized(newRoot)) {
      return c.json(
        { error: `no questions/ directory found at ${newRoot} — run \`ace init\` there first` },
        400,
      );
    }

    // Same echo contract as the reset route's requestId (see the comment
    // there): lets the initiating tab match the `workspace-switched`
    // broadcast to its own request.
    const requestId =
      typeof body.requestId === 'string' && body.requestId.length > 0
        ? body.requestId
        : crypto.randomUUID();

    if (newRoot === ctx.getWorkspaceRoot()) {
      // Already mounted — echo the current info instead of a pointless
      // teardown/re-mount cycle (which would look like a reset to clients).
      return c.json({
        workspaceRoot: newRoot,
        epoch: ctx.requireSession().epoch,
        workspace: computeWorkspaceInfo(ctx),
      });
    }

    // Checked at route entry — reachable only because this route is exempt
    // from the mid-swap 503 gate in app.ts.
    if (ctx.isSwapping()) {
      return c.json({ error: SWAP_IN_PROGRESS_ERROR }, 409);
    }

    // Booted unmounted (picker mode) → nothing to guard; otherwise the same
    // teardown preconditions as reset — never yank a live run or LLM stream.
    const current = ctx.getSession();
    if (current) {
      const busyError = getBusyEngineError(current);
      if (busyError) return c.json({ error: busyError }, 409);
    }

    try {
      const result = await performWorkspaceSwitch({
        newRoot,
        bus: ctx.bus,
        getSession: ctx.getSession,
        getWorkspaceRoot: ctx.getWorkspaceRoot,
        swapWorkspace: ctx.swapWorkspace,
        setSwapping: ctx.setSwapping,
        requestId,
        engines: ctx.engines,
        drainRequests: ctx.waitForRequestDrain,
      });
      return c.json({
        workspaceRoot: result.workspaceRoot,
        epoch: result.epoch,
        workspace: computeWorkspaceInfo(ctx),
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'workspace switch failed' },
        500,
      );
    }
  });
}
