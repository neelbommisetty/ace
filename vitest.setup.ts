import '@testing-library/jest-dom/vitest';

// Node 22+ defines a global `localStorage` accessor that reads as
// `undefined` unless the process is started with --localstorage-file, and
// it shadows happy-dom's own window.localStorage in this test environment
// (globalThis.localStorage is already a non-writable-looking getter by the
// time happy-dom tries to install its own, so happy-dom's assignment is a
// silent no-op). ui/src/api.ts reads/writes the ace-ui auth token via
// localStorage (NEE-308), and several other modules use it too — give every
// test a real in-memory stand-in instead of patching each file individually
// (this used to be done ad hoc per test file; centralized here so nothing
// new has to remember it).
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number) {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}
Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
  writable: true,
});
