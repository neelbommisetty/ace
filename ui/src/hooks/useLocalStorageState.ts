import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Boolean state persisted to localStorage under `key`, with one encoding for
 * every caller: the literal strings 'true' / 'false'. A missing key resolves
 * to `initial` (evaluated lazily, so a window-width check only ever runs
 * once, on mount — never re-evaluated behind an explicit user choice), and
 * the resolved value is written back on mount so the key always settles to
 * an explicit 'true'/'false'.
 *
 * Key registry (defaults are load-bearing — users have these keys stored):
 * - 'ace-autorun'  auto-run tests on save; default false
 * - 'ace-ai-open'  AI review panel visible; default true when the window is
 *   wide enough to fit it (NEE-290), collapsed by default below that
 *
 * See `useLocalStorageNumber` below for the room's pane-splitter width/height
 * keys (NEE-305) — a boolean encoding doesn't fit those.
 */
export function useLocalStorageState(
  key: string,
  initial: boolean | (() => boolean),
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key);
    if (stored != null) return stored === 'true';
    return typeof initial === 'function' ? initial() : initial;
  });

  useEffect(() => {
    localStorage.setItem(key, value ? 'true' : 'false');
  }, [key, value]);

  return [value, setValue];
}

/**
 * Numeric-or-unset state persisted to localStorage under `key`. Unlike
 * `useLocalStorageState` there is no `initial` — a missing (or unparseable)
 * key resolves to `null`, meaning "no user override yet". Callers treat null
 * as "fall back to the CSS default" rather than inventing a fallback number,
 * so resetting is just `setValue(null)`, which also removes the key entirely
 * rather than writing back a value (an unset pane width should stay unset
 * across reloads, not calcify into whatever the default happened to be).
 *
 * Key registry addition (NEE-305 — room pane splitters):
 * - 'ace-problem-width'   problem pane width in px; null = CSS ~30% default
 * - 'ace-ai-width'        AI panel width in px; null = CSS ~27% default
 * - 'ace-console-height'  console height in px; null = CSS ~30% default
 */
export function useLocalStorageNumber(key: string): [number | null, Dispatch<SetStateAction<number | null>>] {
  const [value, setValue] = useState<number | null>(() => {
    const stored = localStorage.getItem(key);
    if (stored == null) return null;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? parsed : null;
  });

  useEffect(() => {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  }, [key, value]);

  return [value, setValue];
}
