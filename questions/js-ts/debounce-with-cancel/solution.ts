export interface Debounced<TArgs extends unknown[]> {
  /** Schedules the wrapped function; restarts the quiet window. */
  (...args: TArgs): void;
  /** Drops a scheduled call. Safe to call when nothing is scheduled. */
  cancel(): void;
  /** Runs a scheduled call right now. No-op when nothing is scheduled. */
  flush(): void;
  /** True while a call is scheduled and has not run, been cancelled, or been flushed. */
  pending(): boolean;
}

export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  waitMs: number,
): Debounced<TArgs> {
  // TODO: implement — delete the throw below and build the real thing.
  void fn;
  void waitMs;
  throw new Error('debounce() is not implemented yet');
}
