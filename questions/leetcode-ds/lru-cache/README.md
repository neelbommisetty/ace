# Implement an LRU Cache

**Category:** LeetCode Data Structures  
**Difficulty:** Hard  
**Suggested Time:** ~45 minutes

---

## Problem

Implement an LRU (Least Recently Used) Cache class with `get(key)` and `put(key, value)` methods. Both operations must run in **O(1)** time complexity.

The constructor takes a `capacity` parameter that determines the maximum number of key-value pairs the cache can hold. When the cache reaches capacity and a new item is inserted, the least recently used item must be evicted.

## Class Signature

```ts
class LRUCache {
  constructor(capacity: number)
  get(key: number): number
  put(key: number, value: number): void
}
```

- **`constructor(capacity)`** — Initialize the cache with a maximum capacity.
- **`get(key)`** — Return the value for the key if it exists, otherwise return `-1`. Accessing a key updates its recency (makes it "most recently used").
- **`put(key, value)`** — Insert or update the value. If the key already exists, update its value and recency. If the cache is at capacity, evict the least recently used item before inserting.

## Examples

### Example 1

```ts
const cache = new LRUCache(2);

cache.put(1, 1);
cache.put(2, 2);
cache.get(1);    // returns 1
cache.put(3, 3); // evicts key 2
cache.get(2);    // returns -1 (not found)
cache.put(4, 4); // evicts key 1
cache.get(1);    // returns -1 (not found)
cache.get(3);    // returns 3
cache.get(4);    // returns 4
```

### Example 2

```ts
const cache = new LRUCache(1);

cache.put(1, 1);
cache.get(1);    // returns 1
cache.put(2, 2); // evicts key 1
cache.get(1);    // returns -1
cache.get(2);    // returns 2
```

## Constraints

- `1 <= capacity <= 3000`
- `0 <= key <= 10^4`
- `0 <= value <= 10^5`
- At most `2 * 10^5` calls will be made to `get` and `put`.

## Hints

- A hash map gives O(1) lookup, but doesn't track order.
- A doubly linked list gives O(1) add/remove at head or tail.
- Combine both: map for O(1) lookup, doubly linked list for O(1) recency updates.
