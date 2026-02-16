# Implement Debounce

**Category:** JS/TS Puzzles  
**Difficulty:** Medium  
**Suggested Time:** ~30 minutes

---

## Problem

Implement a `debounce` function that delays invoking a function until after a specified `delay` (in milliseconds) has elapsed since the last time it was invoked. If the debounced function is called again before the delay expires, the timer resets.

Debouncing is commonly used for search inputs, resize handlers, scroll handlers, and other events that fire rapidly—ensuring the wrapped function only runs once after the user stops triggering it.

## Function Signature

```ts
function debounce(fn: (...args: any[]) => void, delay: number): (...args: any[]) => void
```

- **`fn`** — The function to debounce. It may accept any arguments and returns `void`.
- **`delay`** — The debounce delay in milliseconds.
- **Returns** — A new debounced function with the same signature.

## Examples

### Example 1: Basic delay

```ts
const log = (msg: string) => console.log(msg);
const debouncedLog = debounce(log, 100);

debouncedLog('hello');  // nothing logged yet
// ... 100ms passes ...
// logs: "hello"
```

### Example 2: Multiple rapid calls trigger only once

```ts
const save = (data: string) => console.log('Saving:', data);
const debouncedSave = debounce(save, 200);

debouncedSave('a');
debouncedSave('b');
debouncedSave('c');
// ... 200ms passes ...
// logs: "Saving: c"  (only the last call runs)
```

### Example 3: Timer resets on new calls

```ts
const fn = vi.fn();
const debounced = debounce(fn, 100);

debounced();
// advance 50ms
debounced();
// advance 50ms (total 100ms since first call, but only 50ms since last)
// fn not called yet
// advance 50ms more (100ms since last call)
// fn called once
```

## Constraints

- The debounced function should pass through all arguments to the original function.
- The debounced function should preserve the `this` context when the original function is invoked.
- With `delay === 0`, the function should still debounce (i.e., schedule for the next tick / microtask boundary, or run immediately on the next call—implementation-dependent but should not fire synchronously on every call).
- The debounced function returns `void`; you do not need to return the original function's return value.

## Expected Behavior

1. **Basic delay** — The wrapped function is invoked only after `delay` ms of no further calls.
2. **Rapid calls** — Multiple calls in quick succession result in a single invocation with the arguments from the last call.
3. **Timer reset** — Each new call resets the timer; the function runs only after `delay` ms of inactivity.
4. **Arguments** — All arguments passed to the debounced function are forwarded to the original function.
5. **`this` context** — When the debounced function is called as a method, the original function receives the correct `this`.
6. **Zero delay** — Behavior with `delay === 0` should still debounce (no synchronous double-invocation on rapid calls).

## Hints

- Use `setTimeout` to schedule the invocation.
- Store the timeout ID so you can clear it when a new call comes in.
- Use `apply` or spread to pass arguments and preserve `this`.
