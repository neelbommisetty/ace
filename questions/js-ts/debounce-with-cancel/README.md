# Debounce with Cancel and Flush

**Category:** JS/TS Puzzles
**Difficulty:** easy
**Suggested Time:** ~15 minutes

---

## Problem Statement

The autosave layer of a document editor calls `saveDraft(docId, body)` on every
keystroke. That is far too chatty for the API, so the platform team wants a
`debounce` helper that collapses a burst of calls into a single trailing call —
plus the two escape hatches every real autosave needs: `cancel()` when the user
discards the draft, and `flush()` when the tab is about to close and the
pending write must land immediately.

Implement `debounce` in `solution.ts`.

## Signature

```ts
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
): Debounced<TArgs>;
```

## Examples

```ts
const save = vi.fn();
const debounced = debounce(save, 100);

debounced('a');
debounced('b');
// 99ms later: save has not been called at all
// 100ms after the LAST call: save('b') — only the latest args survive
```

```ts
const debounced = debounce(save, 100);
debounced('a');
debounced.cancel();
// 1000ms later: save was never called, debounced.pending() === false
```

```ts
const debounced = debounce(save, 100);
debounced('a');
debounced.flush(); // save('a') runs synchronously, right now
debounced.flush(); // nothing scheduled — no second call
```

## Constraints

- The wrapped function never runs synchronously from a call — trailing edge
  only. There is no leading-edge mode.
- Every call restarts the quiet window and replaces the queued arguments. Only
  the most recent call's arguments are ever passed to `fn`.
- `cancel()` clears both the timer and the queued arguments; a later call
  starts a fresh window.
- `flush()` invokes `fn` synchronously with the queued arguments and clears the
  schedule. With nothing scheduled it must do nothing (not call `fn` with stale
  arguments, not throw).
- `pending()` is `true` from the moment a call is scheduled until it runs, is
  cancelled, or is flushed — and `false` at every other moment, including
  inside `fn` itself.
- Two `debounce(...)` results are fully independent: cancelling one must never
  affect the other.
- `waitMs` of `0` still defers to a timer tick; treat a negative `waitMs` as
  `0`.
- Use `setTimeout`/`clearTimeout` only. No `Date.now()` polling, no
  `node:timers`.

## Hints

1. You need exactly two pieces of mutable state: the live timer handle and the
   queued arguments. Every method is a small edit to that pair.
2. `flush()` and the timer callback do the same thing — extract one `invoke()`
   that clears the state *before* calling `fn`, so `pending()` reads `false`
   from inside `fn`.
3. `Object.assign(theFunction, { cancel, flush, pending })` is the cleanest way
   to hang methods off a closure without losing the call signature's types.
