# LRU Cache with Peek and Eviction Order

**Category:** LeetCode Data Structures
**Difficulty:** hard
**Suggested Time:** ~45 minutes

---

## Problem Statement

The image service in front of your CDN keeps decoded thumbnails in memory. Once
the cache is full, the least recently *used* entry has to go — but "used" has a
precise meaning that the team keeps getting wrong: reading a value counts,
overwriting a value counts, and a mere existence check (`has`) does not.

Build that cache. Every operation must be O(1) amortised: the eviction path is
on the hot request path and cannot afford a scan.

Implement `LRUCache` in `solution.ts`.

## Signature

```ts
export class LRUCache<K, V> {
  /** Throws RangeError when capacity is not a positive integer. */
  constructor(capacity: number);

  /** Maximum number of entries the cache will hold. */
  readonly capacity: number;

  /** Current number of entries. */
  readonly size: number;

  /** Reads a value and marks the key as most recently used. */
  get(key: K): V | undefined;

  /** Inserts or overwrites, marking the key most recently used; evicts if over capacity. */
  put(key: K, value: V): void;

  /** Existence check that does NOT change recency. */
  has(key: K): boolean;

  /** Removes a key; returns whether it was present. */
  delete(key: K): boolean;

  /** Keys, most recently used FIRST. */
  keys(): K[];
}
```

## Examples

```ts
const cache = new LRUCache<string, number>(2);
cache.put('a', 1);
cache.put('b', 2);
cache.get('a');       // 1  -> 'a' is now the most recently used
cache.put('c', 3);    // over capacity -> evicts 'b', the least recently used
cache.has('b');       // false
cache.keys();         // ['c', 'a']
```

```ts
const cache = new LRUCache<string, number>(2);
cache.put('a', 1);
cache.put('b', 2);
cache.has('a');       // true — a peek, NOT a use
cache.put('c', 3);    // 'a' is still the least recently used -> evicted
cache.keys();         // ['c', 'b']
```

## Constraints

- `get`, `put`, `has` and `delete` must all be O(1) amortised. `keys()` may be
  O(n).
- `get` on a missing key returns `undefined` and must not create an entry or
  change any recency ordering.
- `put` on an existing key overwrites the value **and** promotes the key; it
  never grows `size`, so it can never trigger an eviction.
- Eviction happens only when an insert of a *new* key pushes `size` past
  `capacity`, and evicts exactly one entry: the least recently used.
- `has` and `keys()` are pure observers — neither may change recency.
- `capacity` must be a positive integer; anything else (`0`, `-1`, `2.5`,
  `NaN`, `Infinity`) throws `RangeError` from the constructor.
- `undefined` is never stored as a value in the tests, so `get` returning
  `undefined` unambiguously means "absent".

## Hints

1. JavaScript's `Map` already preserves insertion order and gives you O(1)
   `delete`. `delete` + `set` is therefore a legal O(1) "move to most recent".
2. With insertion order as your recency order, the least recently used entry is
   whatever `map.keys().next().value` yields.
3. Write `has` before you write `get`, and keep them structurally different —
   the moment `has` delegates to `get`, the peek requirement breaks.
