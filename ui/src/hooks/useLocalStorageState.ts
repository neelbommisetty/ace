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
