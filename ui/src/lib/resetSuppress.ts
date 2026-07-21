/**
 * One-shot cross-component signal so the tab that just POSTed a workspace
 * reset can show its `WorkspaceResetDialog`'s "done" state instead of being
 * yanked to the Library by its own SSE `workspace-reset` broadcast — see
 * App.tsx's SSE handler.
 *
 * Keyed by request id (not a plain boolean): the SSE broadcast and the
 * POST's own HTTP response race independently over separate connections, so
 * a *different* tab's reset can finish and broadcast in the small window
 * between this tab arming its suppression and its own response arriving
 * (most commonly a 409 "already in progress"). Comparing the broadcast's
 * `requestId` against the id armed for THIS tab's own in-flight request
 * means an unrelated tab's broadcast is never mistaken for ours — it falls
 * through to App's normal reload instead of being incorrectly swallowed.
 *
 * Module-singleton. `armSuppressNextReset(id)` is called immediately before
 * the reset request goes out, with an id generated for that request;
 * `consumeSuppressForReset(id)` is called by App's `workspace-reset` handler
 * with the id from the incoming broadcast, and only reports a match (and
 * clears the armed id) when it equals what was armed.
 */
let armedRequestId: string | null = null;

export function armSuppressNextReset(requestId: string): void {
  armedRequestId = requestId;
}

/** Disarms only if `requestId` is still the one currently armed (no-op otherwise). */
export function disarmSuppressNextReset(requestId: string): void {
  if (armedRequestId === requestId) armedRequestId = null;
}

export function consumeSuppressForReset(requestId: string): boolean {
  if (armedRequestId === requestId) {
    armedRequestId = null;
    return true;
  }
  return false;
}

/**
 * Non-consuming check for the `hello` epoch-mismatch fallback (App.tsx),
 * which has no per-request id to match against (a `hello` payload only ever
 * carries `{ version, workspaceRoot, epoch }`). That fallback only fires on
 * THIS tab's own SSE reconnect, so "something is currently armed" is a
 * reasonable proxy for "this tab itself has a reset in flight" without
 * needing exact id correlation the way the `workspace-reset` broadcast
 * handler does.
 */
export function isSuppressArmed(): boolean {
  return armedRequestId != null;
}
