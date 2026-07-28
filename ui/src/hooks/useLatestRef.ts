import { useRef, type RefObject } from 'react';

/**
 * A ref that always holds the latest `value`, assigned during render (the
 * sse.ts idiom) rather than mirrored in an effect — so it is never a commit
 * stale and needs no useRef+useEffect pair.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
