# Category Capsule: JS/TS Puzzles (`js-ts`)

## Identity

This category tests whether the candidate gets JavaScript/TypeScript
**semantics** right under product-shaped pressure: closures and reference
capture, async ordering and cancellation, event-loop timing, structural
typing and generics, and memory behavior (retention, cleanup, reentrancy).

A great `js-ts` question is a small utility that a real frontend platform
team would actually ship — a debounced persister, an async task queue with
cancellation, a subscription store with change batching, a retry wrapper
with backoff and abort, a memoizer with TTL and cache invalidation. It is
never a syntax puzzle or a trick about coercion trivia. The hard part is
always behavioral: ordering guarantees, reentrancy, error propagation,
cancellation windows, and API-contract edge cases the signature implies but
careless implementations break.

## Difficulty Calibration

Suggested times: easy 15 min, medium 30 min, hard 45 min.

- **easy (15 min)**: one core behavior plus 2–3 edge-case classes. A strong
  Senior finishes with minutes to spare; the signal is in clean semantics
  (no stale closures, correct `this`/reference handling). Example scope:
  `once(fn)` with error rethrow semantics.
- **medium (30 min)**: two interacting behaviors — e.g. debounce with both
  leading/trailing options and a `flush()`/`cancel()` API, or a keyed
  concurrency limiter. Correct ordering plus at least one lifecycle concern
  (cleanup, cancellation) must be handled. Staff signal: invariants named in
  code structure, not discovered by debugging.
- **hard (45 min)**: a small stateful engine with concurrency semantics —
  e.g. an async queue with priorities, cancellation, and partial-failure
  reporting; or an operation batcher with flush windows and error isolation.
  Multiple edge-case classes interact; a merely-working solution that
  ignores ordering/cancellation contracts should NOT pass all tests.

## Environment & Test Contract

- Solution file: `solution.ts`. Test file: `solution.test.ts`. The test file
  imports from `'./solution'`.
- `signature` must be the **bare declaration head only, no body, no
  braces** — the scaffold appends `{ // TODO: implement }` to it:
  - Function: `export function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T>`
  - Class: `export class TaskQueue<T>` — bare, with NO member list and NO
    braces; put constructor/method signatures in the description's
    `## Signature` section instead.
  - If the signature needs a named options/type parameter, define it inline
    in the description, not in the signature field.
- Allowed test imports: `vitest` ONLY (`describe`, `it`, `expect`, `vi`).
  Pure functions/classes — no DOM, no React, no testing-library.
  NEVER import `@testing-library/user-event`, `jsdom`, `node:timers`, or
  any package not listed here.
- Time-dependent behavior MUST use fake timers: `vi.useFakeTimers()` in
  `beforeEach`, `vi.useRealTimers()` in `afterEach`, advance with
  `await vi.advanceTimersByTimeAsync(ms)` (the async variant — plain
  `advanceTimersByTime` does not flush microtasks between timer callbacks).
- Async assertions: always `await` promises; use `await expect(p).rejects.toThrow(...)`
  for rejection paths. Never assert on a floating promise.
- Tests run under vitest with `globals: true` in a happy-dom environment,
  but must still import everything they use from `'vitest'` explicitly.

## Example Test File

This is the quality bar — note the derivation comments on every non-obvious
expected value, the fake-timer discipline, and that every test would fail
against an empty stub:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './solution';

// Contract under test: createRateLimiter(maxCalls, windowMs) returns
// (fn) => wrapped; wrapped calls beyond maxCalls within a sliding window
// reject with RateLimitError carrying retryAfterMs.

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to maxCalls within the window and preserves results', async () => {
    const limiter = createRateLimiter(2, 1000);
    const wrapped = limiter(async (x: number) => x * 10);
    // 2 calls allowed: 3*10=30, 4*10=40
    await expect(wrapped(3)).resolves.toBe(30);
    await expect(wrapped(4)).resolves.toBe(40);
  });

  it('rejects the call that exceeds the window with retryAfterMs', async () => {
    const limiter = createRateLimiter(2, 1000);
    const wrapped = limiter(async () => 'ok');
    await wrapped(); //  t=0ms  — slot 1
    await vi.advanceTimersByTimeAsync(300);
    await wrapped(); //  t=300ms — slot 2 (window full until t=1000)
    await vi.advanceTimersByTimeAsync(100);
    // t=400ms: oldest call (t=0) leaves the window at t=1000,
    // so retryAfterMs = 1000 - 400 = 600
    await expect(wrapped()).rejects.toMatchObject({
      name: 'RateLimitError',
      retryAfterMs: 600,
    });
  });

  it('frees a slot once the oldest call leaves the sliding window', async () => {
    const limiter = createRateLimiter(1, 1000);
    const wrapped = limiter(async () => 'ok');
    await wrapped(); // t=0ms — window occupied until t=1000
    await vi.advanceTimersByTimeAsync(1000);
    // t=1000ms: the t=0 call has aged out — a call leaves the window once
    // its age >= 1000ms (window is (t-1000, t]), matching retryAfterMs
    // above — so this call occupies the freed slot rather than rejecting
    await expect(wrapped()).resolves.toBe('ok');
  });

  it('does not consume a slot when the wrapped fn itself rejects', async () => {
    const limiter = createRateLimiter(1, 1000);
    const wrapped = limiter(async () => {
      throw new Error('boom');
    });
    await expect(wrapped()).rejects.toThrow('boom');
    // The failed call must not count against the limit: a second call
    // inside the same window still runs (and rejects with 'boom' again,
    // NOT with RateLimitError)
    await expect(wrapped()).rejects.toThrow('boom');
  });
});
```

## Edge-Case Classes

- **Timing boundaries**: behavior exactly AT a window/delay boundary
  (inclusive vs exclusive), zero-delay/zero-size configurations, multiple
  timers firing in the same tick.
- **Ordering & reentrancy**: calls issued while a previous async call is
  still in flight; callbacks that synchronously re-invoke the API;
  preservation (or documented non-preservation) of completion order.
- **Cancellation & cleanup**: cancel/flush/dispose called before first use,
  during flight, and after completion; no timers or listeners left behind;
  idempotent disposal.
- **Error propagation**: rejections must not break subsequent calls; error
  isolation per item in batch APIs; rethrow vs swallow contracts.
- **Reference & mutation semantics**: shared references vs copies in
  caches/results; mutation of arguments; identity vs structural equality in
  dedup/memo keys (`NaN`, `-0`, object keys).
- **Empty/degenerate inputs**: empty arrays, `undefined` optionals,
  single-element inputs, limit-of-zero configurations — each with a defined,
  tested behavior.

## Review Dimensions

Keep these exact names (they key historical score comparisons):

- **Correctness**: 5 = every contract honored including ordering/timing
  edges; 3 = happy path plus most edges right, one behavioral slip;
  1 = core behavior wrong or promise contract broken.
- **Edge Case Handling**: 5 = all promised classes handled by design;
  3 = common edges handled, subtle ones (reentrancy, boundary timing)
  missed; 1 = happy path only.
- **Time/Space Complexity**: 5 = optimal structures chosen and retention
  bounded (no unbounded growth); 3 = acceptable but with avoidable
  linear scans or retained references; 1 = quadratic where linear is
  natural, or leaks.
- **TypeScript Usage**: 5 = precise generics and narrowing carry the
  contract, zero `any`; 3 = types compile honestly but loose (`any` at
  edges, missing generic constraints); 1 = types fought or bypassed.
- **Code Quality**: 5 = invariants visible in structure, small focused
  functions, no dead code; 3 = readable but with incidental complexity;
  1 = tangled state, copy-paste blocks.
- **Readability**: 5 = a reviewer follows it cold in one pass; 3 = needs
  re-reads at the tricky parts; 1 = obscure naming and control flow.

## Signals

Positive (Staff-level):
- Invariants stated and enforced structurally (e.g. a single queue drain
  loop rather than scattered flag checks).
- Cancellation and error paths designed first-class, not bolted on.
- Data-structure choice justified by the contract (Map vs object, ring
  buffer vs array shift) rather than habit.
- Types that make illegal states unrepresentable.

Red flags:
- `any` or unchecked casts to silence the compiler at the contract surface.
- Fire-and-forget promises; missing `await` on paths the contract requires
  ordered.
- Timer/listener leaks; cleanup only on the happy path.
- Mutation of caller-owned arguments; cache keys that collide on edge
  values.
- Complexity theater: clever one-liners where a plain loop is clearer.

## Example Directions

- A `createFormAutosaver` for a config-driven workflow editor: debounced
  persistence with in-flight dedup, retry-with-backoff on failure, a
  `flush()` for navigation, and last-write-wins conflict tagging — tests
  probe boundary timing and failure isolation.
- A keyed concurrency limiter for an agent-interface tool runner: at most N
  in flight per key, FIFO within a key, global cancellation via
  AbortSignal — tests probe ordering, cancellation windows, and rejection
  isolation.
- An event-log compactor for a collaborative editor's local buffer: merge
  consecutive compatible ops, cap memory with a size budget, preserve
  causality — tests probe merge rules, budget-boundary eviction, and
  idempotent replay.
