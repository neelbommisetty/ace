/**
 * One-shot cross-component signal so the tab that just POSTed a workspace
 * reset can show its `WorkspaceResetDialog`'s "done" state instead of being
 * yanked to the Library by its own SSE `workspace-reset` broadcast (or the
 * epoch-mismatch fallback on `hello`) — see App.tsx's SSE handlers.
 *
 * Module-singleton. `setSuppressNextReset(true)` is called immediately
 * before the reset request goes out; `consumeSuppressNextReset()` is called
 * by App's reset-signal handler and both reads and clears the flag so it
 * only ever suppresses a single reload.
 */
let suppressed = false;

export function setSuppressNextReset(value: boolean): void {
  suppressed = value;
}

export function consumeSuppressNextReset(): boolean {
  const was = suppressed;
  suppressed = false;
  return was;
}
