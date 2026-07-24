# Category Capsule: LeetCode Data Structures (`leetcode-ds`)

## Identity

This category tests whether the candidate can design and implement the
data structure a real product feature needs: choosing the structure from
the **operation mix**, honoring complexity guarantees as if they were API
SLAs, and keeping internal state coherent under interleaved operations.

A great `leetcode-ds` question is an API contract for a believable product
need in a charter domain — an LRU/TTL cache in front of an API client, an
interval index for a calendar's overlap engine, a trie for a
mention-autocomplete index, a priority queue for a notification scheduler.
Operations carry promised complexity as SLAs ("`get`/`set` in O(1)",
"`cancel(id)` in O(log n)"), and the hard part is always **state
coherence**: eviction order under ties, duplicate-key semantics, capacity
boundaries, and operation sequences that corrupt naive bookkeeping.

This category is NOT: contest-style abstract puzzles ("given an array A,
find..."), obscure structure trivia (hand-rolling red-black rotations),
algorithm-technique drills (DP, greedy, two pointers — that is
`leetcode-algo`), or UI code — solutions are pure TypeScript, no DOM.

## Difficulty Calibration

Suggested times: easy 15 min, medium 30 min, hard 45 min.

- **easy (15 min)**: one structure, one primary guarantee, 2–3 edge-case
  classes. Example scope: a bounded dedupe ring for notification IDs with
  O(1) `has`/`add` and FIFO overflow. A strong Senior finishes early; the
  Staff signal is deriving the structure from the operation mix and
  defining capacity-0/1 behavior unprompted.
- **medium (30 min)**: two interacting guarantees — recency + expiry,
  ordering + keyed lookup. Example scope: an LRU cache with per-entry TTL,
  or a booking-overlap checker with explicit boundary-touch semantics.
  Staff signal: a single mutation path per invariant (one eviction
  routine, not scattered deletes) and tie/boundary behavior defined in the
  contract before coding, not discovered by failing tests.
- **hard (45 min)**: three or more interacting operations where edge-case
  classes collide and force prioritization and trade-offs — e.g. a
  priority scheduler with collapse-key dedupe, cancellation, and stable
  tie order. The trade-off must be real (lazy vs eager expiry: memory vs
  hot-path latency) and the tests must include interleaved sequences so a
  solution handling each feature only in isolation does NOT pass. "Hard"
  means interacting constraints under time pressure, never obscurity.

## Environment & Test Contract

- Solution file: `solution.ts`. Test file: `solution.test.ts`. The test
  file imports from `'./solution'`.
- `signature` must be the **bare declaration head only, no body, no
  braces** — the scaffold appends `{ // TODO: implement }` to it:
  - Correct (function): `export function mergeBookings(bookings: Booking[]): Booking[]`
  - Correct (class): `export class BoundedCache<K, V>` — bare head with NO
    member list and NO braces; put the constructor and method contracts in
    the description's `## Signature` section instead.
  - INCORRECT (breaks the scaffold): `export class BoundedCache<K, V> { get(key: K): V | undefined; }`
    — any member list or brace renders as `...} { // TODO: implement }`.
  - Named types the signature references are defined in the description,
    never in the signature field.
- Allowed test imports (whitelist): `'vitest'`, `'react'`, `'react-dom'`,
  `'@testing-library/react'`, `'@testing-library/jest-dom'`. In practice a
  data-structure test imports ONLY from `'vitest'` — this category has no
  DOM. NEVER import `@testing-library/user-event`, `jsdom`, `node:timers`,
  or any package not on the whitelist. If DOM interaction ever appears,
  use `fireEvent` (never `userEvent`).
- Tests run under vitest, `globals: true`, happy-dom environment, jest-dom
  matchers preloaded via `vitest.setup.ts` — but tests must still import
  everything they use (`describe`, `it`, `expect`, `vi`) from `'vitest'`.
- Time-dependent behavior (TTL, expiry) MUST use fake timers:
  `vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()` in
  `afterEach`, advance with `await vi.advanceTimersByTimeAsync(ms)`. Fake
  timers also fake `Date`, so `Date.now()`-based ages advance with the
  timer clock. Never use real waits.
- Every non-obvious expected value carries a derivation comment (which
  entries are live, what the recency order is, which tie rule applied).
  Every test must fail against the unimplemented stub: the scaffold class
  has no members, so any method call throws — a test that merely
  constructs the class or checks `typeof` is vacuous.

## Example Test File

This is the quality bar — note the recency-order derivation comments, the
fake-timer discipline for TTL, and that every test fails against the stub:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoundedCache } from './solution';

// Contract under test: BoundedCache<K, V>(capacity, ttlMs?) — LRU eviction
// on insert past capacity; get() refreshes recency; an entry expires once
// ttlMs has elapsed since the set() that wrote it (age >= ttlMs is a miss);
// `size` reports the count of entries currently stored.

describe('BoundedCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('evicts the least recently used entry when inserting past capacity', () => {
    const cache = new BoundedCache<string, string>(2);
    cache.set('a', 'A'); // recency (old -> new): a
    cache.set('b', 'B'); // recency: a, b
    cache.set('c', 'C'); // over capacity -> evict 'a' (least recent)
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBe('C');
    // 3 inserts, 1 eviction -> size pinned at capacity = 2
    expect(cache.size).toBe(2);
  });

  it('treats get() as a use: a read rescues an entry from eviction', () => {
    const cache = new BoundedCache<string, string>(2);
    cache.set('a', 'A'); // recency: a
    cache.set('b', 'B'); // recency: a, b
    cache.get('a'); //      recency: b, a — 'b' is now least recent
    cache.set('c', 'C'); // evicts 'b', NOT 'a'
    expect(cache.get('a')).toBe('A');
    expect(cache.get('b')).toBeUndefined();
  });

  it('overwriting a key updates value and recency without growing size', () => {
    const cache = new BoundedCache<string, string>(2);
    cache.set('a', 'A1'); // recency: a
    cache.set('b', 'B'); //  recency: a, b
    cache.set('a', 'A2'); // duplicate key: overwrite -> recency: b, a
    expect(cache.size).toBe(2); // overwrite must not grow size
    cache.set('c', 'C'); // evicts 'b' (least recent after the overwrite)
    expect(cache.get('a')).toBe('A2'); // latest write wins
    expect(cache.get('b')).toBeUndefined();
  });

  it('capacity 0 stores nothing and never throws', () => {
    const cache = new BoundedCache<string, number>(0);
    cache.set('x', 1); // capacity 0 -> dropped immediately
    expect(cache.get('x')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('expires an entry once ttlMs has elapsed since its write', async () => {
    const cache = new BoundedCache<string, string>(5, 1000);
    cache.set('token', 'abc'); // written at t=0, valid while age < 1000
    await vi.advanceTimersByTimeAsync(999);
    // t=999: age 999 < 1000 -> still a hit
    expect(cache.get('token')).toBe('abc');
    await vi.advanceTimersByTimeAsync(1);
    // t=1000: age 1000 >= ttl -> expired, miss
    expect(cache.get('token')).toBeUndefined();
  });

  it('reclaims an expired slot instead of evicting a live entry', async () => {
    const cache = new BoundedCache<string, string>(2, 1000);
    cache.set('stale', 'S'); // t=0, expires at t=1000
    await vi.advanceTimersByTimeAsync(600);
    cache.set('live', 'L'); //  t=600, expires at t=1600
    await vi.advanceTimersByTimeAsync(300);
    cache.get('stale'); // t=900: age 900 < 1000, a hit — recency now: live, stale
    await vi.advanceTimersByTimeAsync(200);
    // t=1100: 'stale' age 1100 >= 1000 (expired); 'live' age 500 (valid).
    // Recency alone would evict 'live' (least recent) — expiry-aware
    // eviction must reclaim the expired 'stale' slot instead.
    cache.set('next', 'N');
    expect(cache.get('live')).toBe('L');
    expect(cache.get('next')).toBe('N');
    expect(cache.get('stale')).toBeUndefined(); // expired either way
  });
});
```

## Edge-Case Classes

- **Capacity boundaries**: capacity 0 (store nothing, never throw),
  capacity 1 (every insert evicts the sole occupant), inserting exactly at
  full versus one past full — each with defined, tested behavior.
- **Eviction-order ties**: equal priority, equal timestamp, or equal
  recency — the tie rule (e.g. FIFO among equals) must be part of the
  contract and pinned by a test, never left to incidental iteration order.
- **Duplicate keys and values**: overwrite semantics (latest wins, recency
  refreshed, size unchanged); distinct keys holding equal values must not
  alias or co-evict.
- **Operations on empty structures**: get/peek/pop/delete/drain on a fresh
  or fully-drained structure — defined results (`undefined`, `[]`), no
  throw, size stays 0.
- **Interleaved operation sequences**: orderings that expose state
  corruption — a read between writes changing the eviction victim, cancel
  landing between schedule and drain, delete-then-reinsert of the same
  key. Every question tests at least one nontrivial interleaving.
- **Key edge values**: `NaN` and `-0` under Map/Set SameValueZero
  semantics, numeric vs string keys (`1` vs `'1'`), object keys compared
  by identity, and keys that collide when coerced (`'__proto__'`,
  `'[object Object]'`).

## Review Dimensions

Keep these exact names (they key historical score comparisons):

- **Correctness**: 5 = every operation honors its contract across all
  promised edge classes, including interleaved sequences; 3 = core ops
  right with one behavioral slip (a mis-ordered tie, a throwing empty-op);
  1 = a core operation wrong or state corrupts under interleaving.
- **Algorithm Choice**: 5 = structure derived from the operation mix and
  justified (Map + doubly-linked list for O(1) LRU, heap + id index for
  O(log n) cancel); 3 = workable but mismatched somewhere (array scan
  where a keyed index fits); 1 = structure fights the problem (linear
  search inside every hot-path operation).
- **Time Complexity**: 5 = meets the stated per-operation guarantees,
  including amortized claims the candidate can defend; 3 = meets them on
  most operations with one accidental O(n) (e.g. re-sorting on insert);
  1 = misses the promised bounds where the contract demands them.
- **Space Complexity**: 5 = retention bounded by design and evicted or
  deleted entries fully released (no ghost references in a side index);
  3 = correct bound with avoidable duplication or deferred cleanup left
  unjustified; 1 = unbounded growth or evicted entries still reachable.
- **Edge Cases**: 5 = capacity 0/1, empty-structure ops, ties, duplicates,
  and key edge values handled by design; 3 = common edges handled but tie
  order or an interleaving missed; 1 = happy path only.
- **Code Clarity**: 5 = invariants visible in structure — one eviction
  path, named helpers, state transitions in one place; 3 = readable but
  bookkeeping is smeared across methods; 1 = scattered mutations a
  reviewer cannot follow cold.

## Signals

Positive (Staff-level):
- Names the operation mix first and derives the structure from it, with
  the complexity target stated per operation before any code exists.
- Funnels each invariant through a single mutation path (one `evict()`,
  one expiry check) instead of repeating bookkeeping per method.
- Defines tie and boundary behavior in the contract up front — stable
  order among equal priorities, inclusive/exclusive expiry boundary.
- Uses `Map`/`Set` deliberately: SameValueZero key semantics (`NaN`,
  `-0`) and identity comparison for object keys.
- Reasons about interleavings unprompted ("what if `cancel` lands between
  `schedule` and `drain`?") and encodes the answer as an invariant.

Red flags:
- Re-sorting or rebuilding the whole structure inside a hot-path operation
  while still claiming the promised complexity.
- A plain object as a keyed store, keys silently coerced to strings
  (`1` vs `'1'`, `'__proto__'`) — `Map` was the job.
- Parallel bookkeeping that drifts: a hand-maintained size counter or a
  shadow keys array that disagrees with the source of truth.
- Eviction or delete that leaves ghost references — removed from the list
  but still in the map, or vice versa.
- Patching each failing edge case with a special-case branch instead of
  fixing the invariant that makes the whole class of cases correct.

## Example Directions

- A delivery queue for a notification scheduler: `schedule(id, priority,
  deliverAt)` with collapse-key dedupe (latest wins), `cancel(id)` in
  O(log n), `drainDue(now)` returning due items in priority-then-FIFO
  order — hard via ties (equal priority AND equal `deliverAt`), duplicate
  collapse keys, cancel interleaved with drain, and empty drains.
- A mention-autocomplete index for a collaborative editor: case-folded
  prefix index over display names with `add`, `remove`, `query(prefix, k)`
  returning top-k by most-recent mention — hard via collisions after case
  folding, duplicate names across distinct member ids, remove-then-re-add
  interleavings, and the empty-prefix contract.
- An exposure counter for an experimentation platform: `record(flagKey,
  ts)` and `topK(k, windowMs)` over a sliding window with bounded memory —
  hard via window-boundary inclusivity (an event exactly `windowMs` old),
  count ties needing a stable order, interleaved record/query sequences,
  and `k` larger than the number of live flags.
