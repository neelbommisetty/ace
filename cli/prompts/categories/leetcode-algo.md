# Category Capsule: LeetCode Algorithms (`leetcode-algo`)

## Identity

This category tests **algorithmic reasoning in product contexts**: choosing
the right strategy (greedy, DP, two pointers, sorting + scan, binary search,
graph ordering), proving to yourself it is correct, and meeting a stated
complexity budget — all inside a believable frontend-adjacent product
scenario.

A great `leetcode-algo` question is an algorithm that **earns its place in a
product**: sliding-window math for a notification rate limiter, k-way merge
for pre-ranked feed sources, a diff/reconciliation pass over two versions of
a document, dependency-ordered rollout waves (topological sort) for a config
platform, text chunking for a streaming agent interface, quota allocation
across experiments (greedy/DP). The problem statement always names a concrete
complexity budget ("must handle 50k events within a frame budget", "feeds of
100k items, merge must be O(n log k)") so brute force is a *decision to
reject*, not an option nobody mentioned.

This category is NOT competitive programming: no contest framing ("given an
array A of N integers..."), no number-theory tricks, no obscure
data-structure trivia, no adversarial-judge gotchas. It is also not
`leetcode-ds` — structure-centric questions (build a trie, implement a heap)
belong there; here the signal is strategy choice and complexity analysis.
A question a strong Senior could solve by pattern-matching a memorized
LeetCode solution, without reasoning about ties, boundaries, or the budget,
is a failed question.

## Difficulty Calibration

- **easy**: one algorithmic idea, one pass or one sort + scan, 2–3
  edge-case classes (empty input, a tie, one boundary value). A strong
  Senior finishes with time to spare; the Staff signal is stating the
  complexity unprompted and getting window/boundary inclusivity right on the
  first pass, not by debugging. Example scope: compute retry-after values
  from a sliding window of event timestamps.
- **medium**: two interacting concerns — e.g. a greedy choice PLUS
  a stability/tie rule, or window math PLUS budget-boundary behavior — where
  the natural first structure (sort inside a loop, repeated scans) blows the
  stated budget. Staff signal: derives the structure from the budget (heap
  vs sort, one pass vs re-scan) and says *why* the greedy choice is safe.
- **hard**: interacting constraints that force prioritization and
  trade-offs — e.g. DP with a budget dimension plus a tie-normalization rule
  plus adversarial input orderings, or a merge with dedup, stability, and a
  per-source fairness cap. Multiple edge-case classes interact; a
  brute-force or tie-ignoring solution must fail tests, not merely be slow.
  "Hard" is never an obscure trick — it is edge-case interaction plus an
  explicit performance budget under time pressure.

Size the question honestly for its difficulty. Short questions are valid —
not every easy needs padding to fill a slot. For this category:
easy targets about 15 minutes, medium about 30, hard about 45.
60 minutes is a hard cap — if the design needs more, shrink scope rather
than exceed it. Never pad a naturally short question to look bigger than
it is.

## Environment & Test Contract

- Solution file: `solution.ts`. Test file: `solution.test.ts`. The test file
  imports from `'./solution'`.
- `signature` must be the **bare single-line function declaration head only,
  no body, no braces** — the scaffold appends `{ // TODO: implement }`:
  - `export function planDeployWaves(services: Service[], maxParallel: number): string[][]`
  - Supporting types (`Service`, options objects) are defined in the
    description's `## Signature` section, never in the signature field.
- Allowed test imports: `'vitest'`, `'react'`, `'react-dom'`,
  `'@testing-library/react'`, `'@testing-library/jest-dom'`. Problems in
  this category are pure functions, so in practice import from `'vitest'`
  only (`describe`, `it`, `expect`, `vi`). NEVER import
  `@testing-library/user-event`, `jsdom`, or any package not listed here.
  In the rare test that touches the DOM, interactions use `fireEvent` —
  never `userEvent`.
- Tests run under vitest with `globals: true` in a happy-dom environment,
  with jest-dom matchers preloaded via `vitest.setup.ts` — but tests must
  still explicitly import everything they use from `'vitest'`.
- Time-dependent behavior (timestamp windows, scheduling) MUST use fake
  timers: `vi.useFakeTimers()` / `vi.useRealTimers()`, advancing with
  `await vi.advanceTimersByTimeAsync(ms)`. Prefer passing timestamps as
  plain data so most tests need no timers at all.
- When multiple outputs are valid (equal-priority orderings, equivalent
  groupings), the problem statement must define a normalization rule (e.g.
  "sort each wave lexicographically") and tests must assert the normalized
  form — never assert one arbitrary valid answer.
- Every expected value carries a derivation comment; every test must fail
  against the unimplemented stub. Deterministic only: no real time, no
  randomness without a seeded contract.

## Example Test File

This is the quality bar — note the derivation comments tracing every
expected value, the normalization rule that makes answers unique, and that
every test fails against the empty stub:

```typescript
import { describe, expect, it } from 'vitest';
import { planDeployWaves } from './solution';

// Contract under test: planDeployWaves(services, maxParallel) groups
// services into sequential deploy waves. A service may only appear after
// ALL of its dependsOn entries appeared in earlier waves. Each wave holds
// at most maxParallel services; when more are eligible, the
// lexicographically smallest names deploy first. Each returned wave is
// sorted lexicographically (the normalization that makes one unique
// correct answer). Throws an Error mentioning 'cycle' on cyclic graphs.

type S = { name: string; dependsOn: string[] };
const svc = (name: string, dependsOn: string[] = []): S => ({ name, dependsOn });

describe('planDeployWaves', () => {
  it('orders a linear chain across waves regardless of input order', () => {
    // Input deliberately reverse of deploy order (adversarial ordering).
    const waves = planDeployWaves(
      [svc('web', ['api']), svc('api', ['db']), svc('db')],
      4,
    );
    // db has no deps -> wave 0; api needs db -> wave 1; web needs api ->
    // wave 2. maxParallel=4 never binds (one eligible service per wave).
    expect(waves).toEqual([['db'], ['api'], ['web']]);
  });

  it('caps a wave at maxParallel, taking lexicographically smallest first', () => {
    const waves = planDeployWaves(
      [svc('db'), svc('cache'), svc('auth'), svc('api')],
      2,
    );
    // All 4 eligible at once; sorted eligible = api, auth, cache, db.
    // Cap 2 -> wave 0 takes api+auth, wave 1 takes cache+db.
    expect(waves).toEqual([
      ['api', 'auth'],
      ['cache', 'db'],
    ]);
  });

  it('releases a service only when ALL of its dependencies are deployed', () => {
    const waves = planDeployWaves(
      [svc('gateway', ['api', 'worker']), svc('api', ['db']), svc('worker', ['db']), svc('db')],
      3,
    );
    // Wave 0: db. Wave 1: api and worker both unlock (cap 3 not binding),
    // sorted api < worker. gateway waits for BOTH deps -> wave 2, not 1.
    expect(waves).toEqual([['db'], ['api', 'worker'], ['gateway']]);
  });

  it('fits exactly maxParallel eligible services into a single wave', () => {
    // Boundary: eligible count (3) equals the cap (3) — exactly one wave,
    // not two; wave sorted lexicographically.
    expect(planDeployWaves([svc('c'), svc('a'), svc('b')], 3)).toEqual([
      ['a', 'b', 'c'],
    ]);
  });

  it('returns no waves for an empty service list', () => {
    // Degenerate input: nothing to deploy -> []. Fails against the stub,
    // which returns undefined rather than an empty array.
    expect(planDeployWaves([], 2)).toEqual([]);
  });

  it('throws a cycle diagnostic instead of looping or returning partial waves', () => {
    // a -> b -> a can never schedule; the contract requires a diagnostic.
    expect(() => planDeployWaves([svc('a', ['b']), svc('b', ['a'])], 2)).toThrow(
      /cycle/i,
    );
  });
});
```

## Edge-Case Classes

- **Empty & single-element inputs**: empty arrays, one item, one group —
  each with a defined result (`[]`, identity, or a documented error), never
  an implicit crash.
- **Ties & stability**: equal scores/timestamps/priorities must have a
  stated resolution rule (stable by input order, or explicit tie-break key)
  and tests that fail if it is violated.
- **Boundary-of-window/budget values**: an event exactly AT the window edge
  (inclusive vs exclusive), a quota exactly reached, a capacity exactly
  filled — the off-by-one class that separates reasoned solutions from
  debugged ones.
- **Adversarial orderings**: already-sorted, reverse-sorted, and all-equal
  inputs — the orderings that expose wrong greedy choices and quadratic
  degenerations.
- **Multiple-valid-answers normalization**: when several outputs satisfy the
  contract, the statement defines a canonical form (sort, stable order) and
  tests assert it — or the tests verify properties rather than one answer.
- **Magnitude within JS number safety**: counts/timestamps large enough to
  break naive `n*m` intermediate products or float accumulation, while
  staying inside `Number.MAX_SAFE_INTEGER`; money in integer cents, never
  floats.

## Review Dimensions

Keep these exact names (they key historical score comparisons):

- **Correctness**: 5 = every contract clause honored, including ties,
  boundaries, and error diagnostics; 3 = happy path and most edges right,
  one boundary or tie slip; 1 = wrong results on core cases or a hang/crash
  on a promised input class.
- **Algorithm Choice**: 5 = strategy named and justified against
  alternatives (why greedy is safe here, what the DP state means, why a
  heap beats re-sorting); 3 = workable approach reached ad hoc, no
  articulated reason it is correct; 1 = brute force where the stated budget
  forbids it, or a memorized pattern misapplied to the actual contract.
- **Time Complexity**: 5 = meets the stated budget with a correct analysis
  the candidate states themselves; 3 = acceptable bound but unanalyzed, or
  an avoidable extra factor (sort inside a loop that a single pre-sort
  removes); 1 = violates the stated budget (quadratic over 50k items).
- **Space Complexity**: 5 = auxiliary space deliberate and minimal (in-place
  where safe, O(k) buffers justified); 3 = works but copies or retains data
  without noticing; 1 = unbounded or accidentally quadratic memory
  (materializing all pairs/prefixes).
- **Edge Cases**: 5 = every promised class handled by design and visible in
  the code's structure; 3 = common classes handled, subtle ones (exact
  boundary, all-equal ordering) missed; 1 = happy path only.
- **Code Clarity**: 5 = invariants and loop bounds readable at a glance,
  names carry meaning (`windowStart`, not `i2`), a reviewer follows it cold;
  3 = correct but needs re-reads at the tricky parts; 1 = index soup,
  magic numbers, control flow that must be simulated to understand.

## Signals

Positive (Staff-level):
- States the loop/window invariant and the tie-break rule BEFORE coding,
  then the code visibly maintains them.
- Derives the algorithm from the stated budget ("50k per frame rules out
  O(n²), so one sort then a linear scan") rather than from pattern recall.
- Names why the greedy choice is safe — or switches to DP when it is not —
  and can say where the approach breaks.
- Hand-checks boundary values (exact window edge, quota exactly reached)
  against their own code before running tests.
- Normalizes output deliberately when multiple answers are valid, citing
  the contract.

Red flags:
- Off-by-one at window/budget boundaries found by debugging instead of
  reasoning; inclusivity never stated.
- Sorting or scanning inside a loop, turning a stated O(n log n) budget
  into O(n² log n) without noticing.
- Tie-handling left to accident (relying on engine sort stability without
  stating it, or nondeterministic ordering).
- Contest reflexes: variable names like `dp`, `arr`, `res` with no product
  meaning; solving a memorized neighbor-problem instead of the stated one.
- Float arithmetic on money or quotas; ignoring magnitude limits the
  constraints call out.

## Example Directions

- A notification digest scheduler for a fan-out system: given per-user event
  timestamps and a "max N pushes per rolling window" policy, compute when
  each digest fires and what it contains — hard because of exact
  window-boundary inclusivity, ties on equal timestamps, and a budget of
  50k events per user processed in one pass (sliding window, not re-scan).
- A k-way feed merger for a high-scale consumer app: merge pre-ranked source
  feeds into one ranked page with dedup by canonical id and stable
  tie-breaking by source priority, in O(total log k) via a heap — hard
  because of all-equal-score runs, duplicates straddling sources, and a
  multiple-valid-answers contract that must be pinned by normalization.
- A rollout-wave planner for a config-driven workflow platform: order config
  changes into deploy waves under dependency edges and a max-parallelism
  cap, with cycle diagnostics naming the offending chain — hard because of
  diamond dependencies, cap-exactly-reached boundaries, adversarial input
  orderings, and tie-normalization inside waves.
