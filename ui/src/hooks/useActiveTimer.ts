import { useEffect, useRef, useState } from 'react';
import { flushActiveSeconds, patchAttempt } from '../api';

const IDLE_MS = 90_000;
const FLUSH_INTERVAL_MS = 15_000;

/**
 * Counts active seconds for an attempt: ticks only while the tab is visible
 * and there was input (keydown/mousedown/scroll) within the last 90s.
 * Flushes the accumulated delta via PATCH every 15s, and on pagehide/unmount
 * with a keepalive fetch (sendBeacon can't carry the auth header).
 *
 * `attemptId` is null for the readonly reference mode (solved question, no
 * active attempt) — no listeners/intervals/flushes are registered and the
 * timer reports a stopped 0, but the hook itself stays unconditional so
 * callers can keep it at the top of the component regardless of mode.
 */
export function useActiveTimer(
  attemptId: string | null,
  baseSeconds: number,
): { seconds: number; active: boolean } {
  const [seconds, setSeconds] = useState(baseSeconds);
  const [active, setActive] = useState(true);
  const pendingRef = useRef(0);
  const lastInputRef = useRef(Date.now());

  useEffect(() => {
    if (attemptId == null) {
      setSeconds(0);
      setActive(false);
      return;
    }

    setSeconds(baseSeconds);
    pendingRef.current = 0;
    lastInputRef.current = Date.now();

    const onInput = () => {
      lastInputRef.current = Date.now();
    };
    window.addEventListener('keydown', onInput);
    window.addEventListener('mousedown', onInput);
    // capture: window 'scroll' doesn't bubble from inner scroll containers
    window.addEventListener('scroll', onInput, true);

    const tick = window.setInterval(() => {
      const isActive =
        document.visibilityState === 'visible' &&
        Date.now() - lastInputRef.current < IDLE_MS;
      setActive(isActive);
      if (isActive) {
        pendingRef.current += 1;
        setSeconds((s) => s + 1);
      }
    }, 1000);

    const flush = window.setInterval(() => {
      const delta = pendingRef.current;
      if (delta <= 0) return;
      pendingRef.current = 0;
      patchAttempt(attemptId, { activeSecondsDelta: delta }).catch(() => {
        // keep the delta; retry on the next flush
        pendingRef.current += delta;
      });
    }, FLUSH_INTERVAL_MS);

    const flushFinal = () => {
      const delta = pendingRef.current;
      if (delta <= 0) return;
      pendingRef.current = 0;
      flushActiveSeconds(attemptId, delta);
    };
    window.addEventListener('pagehide', flushFinal);

    return () => {
      window.clearInterval(tick);
      window.clearInterval(flush);
      window.removeEventListener('keydown', onInput);
      window.removeEventListener('mousedown', onInput);
      window.removeEventListener('scroll', onInput, true);
      window.removeEventListener('pagehide', flushFinal);
      flushFinal();
    };
    // baseSeconds is the starting point for this attempt; only reset per attempt
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId]);

  return { seconds, active };
}
