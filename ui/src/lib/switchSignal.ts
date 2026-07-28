/**
 * Module-singleton opener for the workspace switch dialog (NEE-164). The
 * dialog itself (and its Cmd/Ctrl+K shortcut) lives at App level so it works
 * on every screen, but the trigger rendered in a screen's topbar (Library's
 * workspace button) can't reach App's state directly — same cross-component
 * pattern as lib/resetSuppress.ts.
 */
let opener: (() => void) | null = null;

/** App registers exactly one opener; returns the unregister cleanup. */
export function registerWorkspaceSwitchOpener(fn: () => void): () => void {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

export function openWorkspaceSwitchDialog(): void {
  opener?.();
}
