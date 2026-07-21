import {
  closeWorkspaceSession,
  createWorkspaceSession,
  startSessionWatcher,
  type EngineFactories,
  type WorkspaceSession,
} from './session.js';
import type { Bus } from './sse.js';
import type { WorkspaceResetMode } from './types.js';
import {
  applyRestorePlan,
  archiveAceDir,
  collectRestorePlan,
  snapshotPreResetState,
  type RestorePlan,
} from './workspace-reset.js';

/**
 * Orchestrates "clear workspace" (NEE-165): teardown the current session,
 * archive `.ace`, and bring up a fresh one — without restarting the HTTP
 * listener. Pure orchestration + fs/db composition: no HTTP, no
 * confirm-string/mode validation, and no busy-engine guards. Those are the
 * `POST /api/workspace/reset` route's job — by the time this runs, the
 * route has already validated `mode`/`confirm` and checked the engines are
 * idle. `confirm` is accepted here purely to keep the orchestrator's
 * parameter shape stable for the route to call straight through; it is not
 * inspected.
 */
export interface PerformWorkspaceResetOptions {
  workspaceRoot: string;
  bus: Bus;
  getSession: () => WorkspaceSession;
  swapSession: (session: WorkspaceSession) => void;
  setResetting: (resetting: boolean) => void;
  mode: WorkspaceResetMode;
  confirm: string;
  /** Defaults to the real engine factories; tests inject fakes here. */
  engines?: EngineFactories;
  /**
   * Awaited right before the old session's db is closed (wired through as
   * closeWorkspaceSession's `beforeDbClose`) — lets the HTTP layer drain any
   * request that was already past the resetting-gate and mid-flight against
   * the old session when the reset began, so it can't resume against a
   * closed db. Defaults to a no-op; tests generally omit it.
   */
  drainRequests?: () => Promise<void>;
}

export interface PerformWorkspaceResetResult {
  archivedTo: string;
  restored: { questions: number; files: number };
}

/**
 * Runs the reset in the exact load-bearing order:
 *
 *   set resetting flag -> collectRestorePlan (old db) -> (full only)
 *   snapshotPreResetState (old db) -> closeWorkspaceSession -> archiveAceDir
 *   -> createWorkspaceSession({ watch: false }) (fresh db + reconcile) ->
 *   applyRestorePlan -> setMeta('reset_archived_from', archivedTo) ->
 *   startSessionWatcher(newSession) -> swapSession(newSession) -> clear flag
 *   -> bus.emit('workspace-reset', { mode, archivedTo }).
 *
 * Failure recovery has two regimes, split by whether `.ace` has been
 * renamed yet:
 *
 * - Pre-rename (collectRestorePlan, snapshotPreResetState,
 *   closeWorkspaceSession, archiveAceDir itself): the flag is cleared and
 *   the original `.ace` is left fully intact. If the old session was
 *   already closed by the time the failure happened, a fresh session is
 *   rebuilt over the untouched `.ace` and swapped in so the server keeps
 *   serving; the original error is rethrown unmodified.
 * - Post-rename (createWorkspaceSession, applyRestorePlan, setMeta,
 *   startSessionWatcher): the archive already exists and cannot be undone.
 *   A best-effort session is brought up (reusing whatever was already
 *   created, attaching a watcher if one is still missing) and swapped in,
 *   the flag is cleared, and a new error is thrown whose message names
 *   `archivedTo` so the caller can point the user at their archived data.
 */
export async function performWorkspaceReset(
  opts: PerformWorkspaceResetOptions,
): Promise<PerformWorkspaceResetResult> {
  const { workspaceRoot, bus, getSession, swapSession, setResetting, mode, engines } = opts;
  const drainRequests = opts.drainRequests ?? (async () => {});

  setResetting(true);

  const oldSession = getSession();
  let closed = false;

  // --- Pre-rename phase: plan capture + snapshot + teardown --------------
  try {
    const plan = collectRestorePlan(oldSession.db, workspaceRoot);
    if (mode === 'full') {
      snapshotPreResetState(oldSession.db, workspaceRoot, plan);
    }

    // beforeDbClose runs after the watcher/engines are torn down but before
    // db.close() — wait out any request that got past the 503 gate before
    // `setResetting(true)` took effect (e.g. suspended in `await
    // c.req.json()`) so it resumes against a still-open db instead of a
    // closed one. See closeWorkspaceSession's doc comment for this seam.
    await closeWorkspaceSession(oldSession, { beforeDbClose: drainRequests });
    closed = true;

    const archivedTo = archiveAceDir(workspaceRoot);

    // --- Post-rename phase: re-init + restore + watcher + swap ---------
    return await bringUpAfterArchive({
      workspaceRoot,
      bus,
      swapSession,
      setResetting,
      mode,
      plan,
      archivedTo,
      engines,
    });
  } catch (err) {
    // Any failure that reaches here happened before (or during) the
    // archive rename — recover in place and leave `.ace` untouched.
    if (closed) {
      try {
        swapSession(createWorkspaceSession({ workspaceRoot, bus, engines }));
      } catch {
        // Best effort — if this also fails there is nothing more we can do;
        // the accessor keeps pointing at the now-closed old session.
      }
    }
    setResetting(false);
    throw err;
  }
}

async function bringUpAfterArchive(opts: {
  workspaceRoot: string;
  bus: Bus;
  swapSession: (session: WorkspaceSession) => void;
  setResetting: (resetting: boolean) => void;
  mode: WorkspaceResetMode;
  plan: RestorePlan;
  archivedTo: string;
  engines?: EngineFactories;
}): Promise<PerformWorkspaceResetResult> {
  const { workspaceRoot, bus, swapSession, setResetting, mode, plan, archivedTo, engines } = opts;

  let newSession: WorkspaceSession | undefined;
  try {
    newSession = createWorkspaceSession({ workspaceRoot, bus, watch: false, engines });
    const restored = applyRestorePlan(newSession.db, workspaceRoot, plan, mode);
    newSession.db.setMeta('reset_archived_from', archivedTo);
    startSessionWatcher(newSession);

    swapSession(newSession);
    setResetting(false);
    bus.emit('workspace-reset', { mode, archivedTo });

    return { archivedTo, restored };
  } catch (err) {
    // The archive already happened and cannot be undone — bring up
    // whatever we can, reusing the session we already built if possible,
    // so the server keeps serving instead of being stuck.
    let recovered = newSession;
    if (!recovered) {
      try {
        recovered = createWorkspaceSession({ workspaceRoot, bus, engines });
      } catch {
        recovered = undefined;
      }
    } else if (!recovered.watcher) {
      try {
        startSessionWatcher(recovered);
      } catch {
        // best effort — session still usable without a live watcher
      }
    }
    if (recovered) swapSession(recovered);
    setResetting(false);

    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`workspace reset failed after archiving to ${archivedTo}: ${message}`);
  }
}
