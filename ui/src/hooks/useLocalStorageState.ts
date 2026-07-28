import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Boolean state persisted to localStorage under `key`, with one encoding for
 * every caller: the literal strings 'true' / 'false'. A missing key resolves
 * to `initial`, and the resolved value is written back on mount so the key
 * always settles to an explicit 'true'/'false'.
 *
 * Key registry (defaults are load-bearing — users have these keys stored):
 * - 'ace-autorun'  auto-run tests on save; default false
 * - 'ace-ai-open'  AI review panel visible; default true
 */
export function useLocalStorageState(
  key: string,
  initial: boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key);
    return stored == null ? initial : stored === 'true';
  });

  useEffect(() => {
    localStorage.setItem(key, value ? 'true' : 'false');
  }, [key, value]);

  return [value, setValue];
}
