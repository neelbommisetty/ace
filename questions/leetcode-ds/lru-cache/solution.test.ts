import { describe, expect, it } from 'vitest';
import { LRUCache } from './solution';

// Contract under test: a capacity-bounded cache where get() and put() promote
// a key to most-recently-used, has() and keys() are pure observers, and an
// over-capacity insert evicts exactly the least recently used entry.

describe('LRUCache', () => {
  it('stores and reads back values', () => {
    const cache = new LRUCache<string, number>(2);
    cache.put('a', 1);
    cache.put('b', 2);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('returns undefined for a missing key without creating an entry', () => {
    const cache = new LRUCache<string, number>(2);
    cache.put('a', 1);

    expect(cache.get('nope')).toBeUndefined();
    // A missed read must not grow the cache or reorder anything.
    expect(cache.size).toBe(1);
    expect(cache.keys()).toEqual(['a']);
  });

  it('evicts the least recently used key when a new key overflows capacity', () => {
    const cache = new LRUCache<string, number>(2);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('c', 3); // 'a' is the LRU -> evicted

    expect(cache.has('a')).toBe(false);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('counts get() as a use, changing which key is evicted', () => {
    const cache = new LRUCache<string, number>(2);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.get('a'); // recency order is now ['a', 'b'] (MRU first)
    cache.put('c', 3); // 'b' is the LRU -> evicted

    expect(cache.has('b')).toBe(false);
    expect(cache.get('a')).toBe(1);
    expect(cache.keys()).toEqual(['a', 'c']);
  });

  it('does NOT count has() as a use', () => {
    const cache = new LRUCache<string, number>(2);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.has('a'); // a peek: 'a' stays the least recently used
    cache.put('c', 3);

    expect(cache.has('a')).toBe(false);
    expect(cache.keys()).toEqual(['c', 'b']);
  });

  it('overwrites in place and promotes, never evicting on an existing key', () => {
    const cache = new LRUCache<string, number>(2);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('a', 10); // overwrite: size stays 2, 'a' becomes MRU

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(10);
    expect(cache.has('b')).toBe(true);

    cache.put('c', 3); // now 'b' is the LRU -> evicted
    expect(cache.has('b')).toBe(false);
  });

  it('lists keys most recently used first, without changing recency', () => {
    const cache = new LRUCache<string, number>(3);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('c', 3);
    cache.get('a'); // uses: a(3rd), c(2nd), b(1st) -> MRU-first is a, c, b

    expect(cache.keys()).toEqual(['a', 'c', 'b']);
    // keys() is an observer: calling it twice yields the same order.
    expect(cache.keys()).toEqual(['a', 'c', 'b']);
  });

  it('deletes keys and reports whether they were present', () => {
    const cache = new LRUCache<string, number>(2);
    cache.put('a', 1);

    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('frees room for a new key after a delete', () => {
    const cache = new LRUCache<string, number>(2);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.delete('a');
    cache.put('c', 3); // size was 1, so nothing is evicted

    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('works at capacity 1, where every new key evicts the previous one', () => {
    const cache = new LRUCache<string, number>(1);
    cache.put('a', 1);
    cache.put('b', 2);

    expect(cache.has('a')).toBe(false);
    expect(cache.get('b')).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.keys()).toEqual(['b']);
  });

  it('rejects a capacity that is not a positive integer', () => {
    expect(() => new LRUCache<string, number>(0)).toThrow(RangeError);
    expect(() => new LRUCache<string, number>(-1)).toThrow(RangeError);
    expect(() => new LRUCache<string, number>(2.5)).toThrow(RangeError);
    expect(() => new LRUCache<string, number>(Number.NaN)).toThrow(RangeError);
    expect(() => new LRUCache<string, number>(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('stays O(1) per operation under 100,000 inserts', () => {
    const cache = new LRUCache<number, number>(1000);
    for (let i = 0; i < 100_000; i++) cache.put(i, i * 2);

    // Only the last 1000 keys survive: 99000..99999.
    expect(cache.size).toBe(1000);
    expect(cache.get(99_999)).toBe(199_998);
    expect(cache.has(98_999)).toBe(false);
    expect(cache.has(99_000)).toBe(true);
  });
});
