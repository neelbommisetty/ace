import { describe, it, expect } from 'vitest';
import { LRUCache } from './solution';

describe('LRUCache', () => {
  it('basic get and put', () => {
    const cache = new LRUCache(2);
    cache.put(1, 1);
    cache.put(2, 2);
    expect(cache.get(1)).toBe(1);
    expect(cache.get(2)).toBe(2);
  });

  it('evicts least recently used when full', () => {
    const cache = new LRUCache(2);
    cache.put(1, 1);
    cache.put(2, 2);
    cache.put(3, 3); // evicts key 1
    expect(cache.get(1)).toBe(-1);
    expect(cache.get(2)).toBe(2);
    expect(cache.get(3)).toBe(3);
  });

  it('get updates recency (accessed key is not evicted next)', () => {
    const cache = new LRUCache(2);
    cache.put(1, 1);
    cache.put(2, 2);
    cache.get(1); // makes 1 most recently used
    cache.put(3, 3); // evicts key 2, not 1
    expect(cache.get(1)).toBe(1);
    expect(cache.get(2)).toBe(-1);
    expect(cache.get(3)).toBe(3);
  });

  it('put existing key updates value and recency', () => {
    const cache = new LRUCache(2);
    cache.put(1, 1);
    cache.put(2, 2);
    cache.put(1, 10); // update value, 1 becomes most recently used
    expect(cache.get(1)).toBe(10);
    cache.put(3, 3); // evicts key 2
    expect(cache.get(1)).toBe(10);
    expect(cache.get(2)).toBe(-1);
  });

  it('capacity of 1', () => {
    const cache = new LRUCache(1);
    cache.put(1, 1);
    expect(cache.get(1)).toBe(1);
    cache.put(2, 2);
    expect(cache.get(1)).toBe(-1);
    expect(cache.get(2)).toBe(2);
  });

  it('accessing a key prevents its eviction', () => {
    const cache = new LRUCache(2);
    cache.put(1, 1);
    cache.put(2, 2);
    cache.get(2); // 2 is now most recently used
    cache.put(3, 3); // evicts 1
    expect(cache.get(1)).toBe(-1);
    expect(cache.get(2)).toBe(2);
    expect(cache.get(3)).toBe(3);
  });

  it('multiple evictions in sequence', () => {
    const cache = new LRUCache(2);
    cache.put(1, 1);
    cache.put(2, 2);
    cache.put(3, 3); // evicts 1
    cache.put(4, 4); // evicts 2
    expect(cache.get(1)).toBe(-1);
    expect(cache.get(2)).toBe(-1);
    expect(cache.get(3)).toBe(3);
    expect(cache.get(4)).toBe(4);
  });

  it('empty cache returns -1 for get', () => {
    const cache = new LRUCache(2);
    expect(cache.get(1)).toBe(-1);
    expect(cache.get(99)).toBe(-1);
  });
});
