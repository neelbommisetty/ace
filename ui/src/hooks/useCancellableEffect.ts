import { useEffect, type DependencyList } from 'react';

/**
 * The cancelled-flag effect, written once. `run` receives a `cancelled()`
 * probe that flips true when `deps` change or the component unmounts — check
 * it before applying async results to state:
 *
 *   useCancellableEffect((cancelled) => {
 *     fetchThing().then((r) => { if (!cancelled()) setThing(r); }).catch(() => {});
 *   }, [deps]);
 *
 * `run` may still return a cleanup function; it is called right after the
 * flag flips.
 */
export function useCancellableEffect(
  run: (cancelled: () => boolean) => void | (() => void),
  deps: DependencyList,
): void {
  useEffect(() => {
    let cancelled = false;
    const cleanup = run(() => cancelled);
    return () => {
      cancelled = true;
      cleanup?.();
    };
    // the caller's deps drive the effect; `run` is deliberately fresh each render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
