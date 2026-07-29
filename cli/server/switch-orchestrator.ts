import crypto from 'node:crypto';
import {
  closeWorkspaceSession,
  closeWorkspaceSessionSafe,
  createWorkspaceSession,
  type EngineFactories,
  type WorkspaceSession,
} from './session.js';
import type { Bus } from './sse.js';
import { recordRecentWorkspace } from './workspace-registry.js';

/**
 * Orchestrates switching the mounted workspace (NEE-164): tear down the
 * current session (when one is mounted at all), build a fresh one against
 * `newRoot`, and swap root+session atomically — without restarting the HTTP
 * listener. Pure orchestration: no HTTP, no root validation, and no
 * busy-engine guards — the `POST /api/workspace/switch` route has already
 * resolved+validated the root and checked the engines are idle by the time
 * this runs (same division of labor as performWorkspaceReset).
 */
export interface PerformWorkspaceSwitchOptions {
  /** Absolute, already validated by the route via isWorkspaceInitialized. */
  newRoot: string;
  bus: Bus;
  getSession: () => WorkspaceSession | null;
  getWorkspaceRoot: () => string | null;
  swapWorkspace: (root: string | null, session: WorkspaceSession | null) => void;
  setSwapping: (swapping: boolean) => void;
  /**
   * Echoed back verbatim in the `workspace-switched` broadcast — same
   * contract as the reset route's requestId. Defaults to a freshly minted id.
   */
  requestId?: string;
  /** Defaults to the real engine factories; tests inject fakes here. */
  engines?: EngineFactories;
  /** Awaited before the old session's db closes — the same request-drain seam as performWorkspaceReset. */
  drainRequests?: () => Promise<void>;
  /**
   * Stops the old workspace's live-preview dev server (NEE-348) before the
   * teardown, so a switched-away workspace never leaves a Vite server
   * holding a port. Best-effort: a failure here never aborts the switch (the
   * preview manager's idle timeout is the backstop).
   */
  stopPreview?: (oldRoot: string) => Promise<void>;
}

export interface PerformWorkspaceSwitchResult {
  workspaceRoot: string;
  epoch: string;
}

/**
 * Runs the switch in the load-bearing order:
 *
 *   set swapping flag -> closeWorkspaceSession(old, { beforeDbClose:
 *   drainRequests }) (skipped when booted unmounted) ->
 *   createWorkspaceSession(newRoot) (watcher attaches inline — unlike reset
 *   there is no restore-writes phase to order it after) ->
 *   swapWorkspace(newRoot, newSession) + recordRecentWorkspace(newRoot) ->
 *   clear flag -> bus.emit('workspace-switched', ...).
 *
 * Failure recovery: nothing here renames `.ace` (unlike reset), so every
 * failure lands in one regime — remount. If mounting `newRoot` fails (or the
 * old teardown does), the old root is remounted and swapped back; reopening
 * the same db yields the same persisted epoch, so epoch-watching clients
 * correctly see no reset. If the remount also fails (or there was no old
 * root), the server swaps to unmounted (null) and keeps serving the picker.
 * The flag is always cleared, and the thrown error names which of those
 * outcomes happened.
 */
export async function performWorkspaceSwitch(
  opts: PerformWorkspaceSwitchOptions,
): Promise<PerformWorkspaceSwitchResult> {
  const { newRoot, bus, getSession, getWorkspaceRoot, swapWorkspace, setSwapping, engines } = opts;
  const requestId = opts.requestId ?? crypto.randomUUID();
  const drainRequests = opts.drainRequests ?? (async () => {});

  setSwapping(true);
  const oldRoot = getWorkspaceRoot();
  const oldSession = getSession();
  let oldClosed = oldSession == null;

  try {
    if (oldRoot != null && opts.stopPreview) {
      try {
        await opts.stopPreview(oldRoot);
      } catch {
        // best-effort — see the option's doc comment
      }
    }
    if (oldSession) {
      // beforeDbClose runs after the watcher/engines are torn down but
      // before db.close() — wait out any request that got past the 503 gate
      // before `swapping` flipped, so it resumes against a still-open db.
      await closeWorkspaceSession(oldSession, { beforeDbClose: drainRequests });
      oldClosed = true;
    }

    const newSession = createWorkspaceSession({ workspaceRoot: newRoot, bus, engines });
    swapWorkspace(newRoot, newSession);
    recordRecentWorkspace(newRoot);
    setSwapping(false);
    bus.emit('workspace-switched', {
      workspaceRoot: newRoot,
      epoch: newSession.epoch,
      requestId,
    });
    return { workspaceRoot: newRoot, epoch: newSession.epoch };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // closeWorkspaceSession stops at its failing step — finish the teardown
    // best-effort so the remount below never opens a second live handle on a
    // db that the half-closed session still holds.
    if (oldSession && !oldClosed) {
      await closeWorkspaceSessionSafe(oldSession);
    }

    let recovered: WorkspaceSession | null = null;
    if (oldRoot != null) {
      try {
        recovered = createWorkspaceSession({ workspaceRoot: oldRoot, bus, engines });
      } catch {
        recovered = null;
      }
    }
    swapWorkspace(recovered ? oldRoot : null, recovered);
    setSwapping(false);

    if (oldRoot == null) {
      throw new Error(`workspace switch to ${newRoot} failed: ${message}`);
    }
    if (recovered) {
      throw new Error(
        `workspace switch to ${newRoot} failed (${message}) — the previous workspace at ${oldRoot} is still mounted`,
      );
    }
    throw new Error(
      `workspace switch to ${newRoot} failed (${message}), and remounting ${oldRoot} also failed — no workspace is mounted`,
    );
  }
}
