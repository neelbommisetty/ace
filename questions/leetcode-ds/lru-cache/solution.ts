export class LRUCache<K, V> {
  readonly capacity: number;

  constructor(capacity: number) {
    // TODO: validate `capacity` and set up your internal storage.
    this.capacity = capacity;
  }

  /** Current number of entries. */
  get size(): number {
    throw new Error('LRUCache#size is not implemented yet');
  }

  /** Reads a value and marks the key as most recently used. */
  get(key: K): V | undefined {
    void key;
    throw new Error('LRUCache#get is not implemented yet');
  }

  /** Inserts or overwrites, marking the key most recently used; evicts if over capacity. */
  put(key: K, value: V): void {
    void key;
    void value;
    throw new Error('LRUCache#put is not implemented yet');
  }

  /** Existence check that does NOT change recency. */
  has(key: K): boolean {
    void key;
    throw new Error('LRUCache#has is not implemented yet');
  }

  /** Removes a key; returns whether it was present. */
  delete(key: K): boolean {
    void key;
    throw new Error('LRUCache#delete is not implemented yet');
  }

  /** Keys, most recently used FIRST. */
  keys(): K[] {
    throw new Error('LRUCache#keys is not implemented yet');
  }
}
