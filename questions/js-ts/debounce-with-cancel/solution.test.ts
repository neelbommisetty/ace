import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce, type Debounced } from './solution';

// Contract under test: debounce(fn, waitMs) returns a callable that runs `fn`
// once, on the trailing edge of a burst, with the LAST call's arguments —
// plus cancel(), flush() and pending().

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never runs the wrapped function synchronously', () => {
    const save = vi.fn();
    const debounced = debounce(save, 100);

    debounced('a');

    // Trailing edge only: nothing has run yet at t=0.
    expect(save).not.toHaveBeenCalled();
    expect(debounced.pending()).toBe(true);
  });

  it('runs once after the quiet window with the last arguments', async () => {
    const save = vi.fn();
    const debounced = debounce(save, 100);

    debounced('a');
    debounced('b');

    // Window restarted by the 'b' call, so at t=99 it has still not fired.
    await vi.advanceTimersByTimeAsync(99);
    expect(save).not.toHaveBeenCalled();

    // t=100 relative to the 'b' call -> exactly one invocation, args ['b'].
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('b');
  });

  it('restarts the window on every call rather than firing on a fixed schedule', async () => {
    const save = vi.fn();
    const debounced = debounce(save, 100);

    // Five calls 60ms apart: total elapsed 240ms, but each call resets the
    // window, so nothing may have fired yet.
    for (let i = 0; i < 5; i++) {
      debounced(i);
      await vi.advanceTimersByTimeAsync(60);
    }
    expect(save).not.toHaveBeenCalled();

    // 60ms already elapsed since the last call (i=4); 40 more completes it.
    await vi.advanceTimersByTimeAsync(40);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(4);
  });

  it('reports pending() as false from inside the wrapped function', async () => {
    const seen: boolean[] = [];
    // Annotated because the callback reads `debounced` from inside its own
    // initializer, which TypeScript cannot infer through.
    const debounced: Debounced<[]> = debounce(() => {
      seen.push(debounced.pending());
    }, 50);

    debounced();
    await vi.advanceTimersByTimeAsync(50);

    // The schedule must be cleared BEFORE fn runs, so fn observes false.
    expect(seen).toEqual([false]);
    expect(debounced.pending()).toBe(false);
  });

  it('cancel() drops the scheduled call and clears the queued arguments', async () => {
    const save = vi.fn();
    const debounced = debounce(save, 100);

    debounced('a');
    debounced.cancel();
    expect(debounced.pending()).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();

    // A later call starts a fresh window and is unaffected by the cancel.
    debounced('b');
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('b');
  });

  it('cancel() with nothing scheduled is a no-op', async () => {
    const save = vi.fn();
    const debounced = debounce(save, 100);

    debounced.cancel();
    await vi.advanceTimersByTimeAsync(1000);

    expect(save).not.toHaveBeenCalled();
  });

  it('flush() runs the queued call synchronously and clears the schedule', async () => {
    const save = vi.fn();
    const debounced = debounce(save, 100);

    debounced('a');
    debounced.flush();

    // Synchronous: no timer advance happened between the call and this line.
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('a');
    expect(debounced.pending()).toBe(false);

    // The timer must have been cleared — no second, delayed invocation.
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flush() with nothing scheduled does not call the wrapped function', async () => {
    const save = vi.fn();
    const debounced = debounce(save, 100);

    debounced('a');
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(1);

    // Nothing queued any more: flushing must not replay the stale args.
    debounced.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('treats waitMs of 0 as "next tick", not "synchronous"', async () => {
    const save = vi.fn();
    const debounced = debounce(save, 0);

    debounced('a');
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('keeps separate instances independent', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = debounce(first, 100);
    const b = debounce(second, 100);

    a('x');
    b('y');
    a.cancel();

    await vi.advanceTimersByTimeAsync(100);

    // Cancelling `a` must not touch `b`'s pending call.
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith('y');
  });
});
