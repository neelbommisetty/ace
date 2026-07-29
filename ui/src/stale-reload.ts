/**
 * Stale-deploy reload guard.
 *
 * `npm run build` rewrites dist/assets with new content hashes
 * (`emptyOutDir` is on). A tab left open across a rebuild still holds the
 * old in-memory bundle and requests lazy chunks — Monaco's monarch
 * tokenizers, the TS language-service worker, the editor worker — by their
 * old hashed filenames, which now 404. Vite fires `vite:preloadError` for
 * failed dynamic `import()`s; worker construction failures don't, so
 * callers that construct Web Workers must funnel `Worker#onerror` (or a
 * synchronous construction throw) through the same path by hand.
 *
 * The fix is a one-shot reload: reload once to pick up the new bundle, but
 * never loop if the chunk is genuinely gone (network down, asset deleted on
 * purpose) rather than just renamed by a rebuild. A sessionStorage flag is
 * the guard — it survives the reload (so we can tell "did we already try
 * this") but doesn't survive normal navigation/tab-close, and it is cleared
 * as soon as a page load completes successfully so a *later* rebuild can
 * trigger one more reload.
 */

const GUARD_KEY = 'ace:stale-reload-attempted';

/** Exposed for tests: swappable in place of `window.sessionStorage`. */
export interface ReloadGuardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Call when a stale-deploy symptom is observed (failed lazy chunk import,
 * failed worker construction/fetch). Reloads the page exactly once per
 * "generation" of stale assets: if a previous call already set the guard
 * and we haven't cleared it since (i.e. the reload itself is still failing
 * to fetch fresh chunks), this is a no-op instead of looping forever.
 *
 * Returns true if a reload was triggered, false if suppressed by the guard.
 */
export function triggerStaleReload(
  storage: ReloadGuardStorage,
  reload: () => void,
): boolean {
  if (storage.getItem(GUARD_KEY) === '1') return false;
  storage.setItem(GUARD_KEY, '1');
  reload();
  return true;
}

/**
 * Call once the app has rendered successfully. Clears the one-shot guard so
 * a later rebuild (a new "generation" of stale assets) can trigger its own
 * single reload rather than being permanently suppressed by a guard flag
 * left over from a previous stale-tab recovery.
 */
export function clearStaleReloadGuard(storage: ReloadGuardStorage): void {
  storage.removeItem(GUARD_KEY);
}
