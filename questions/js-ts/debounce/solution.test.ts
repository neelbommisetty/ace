import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce } from './solution';

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delays invocation by the specified delay', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('invokes only once when called multiple times rapidly', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    debounced();
    debounced();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes through all arguments to the original function', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced('a', 1, { key: 'value' });
    vi.advanceTimersByTime(50);

    expect(fn).toHaveBeenCalledWith('a', 1, { key: 'value' });
  });

  it('preserves this context when called as a method', () => {
    const methodFn = vi.fn(function (this: { value: number }) {
      return this.value;
    });
    const obj = {
      value: 42,
      method: methodFn,
    };
    obj.method = debounce(obj.method, 50);

    obj.method();
    vi.advanceTimersByTime(50);

    expect(methodFn).toHaveBeenCalled();
    expect(methodFn.mock.results[0]?.value).toBe(42);
  });

  it('resets timer when called again before delay expires', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(50);
    debounced();
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses arguments from the last call when multiple rapid calls occur', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('first');
    debounced('second');
    debounced('third');

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('third');
  });

  it('works with 0 delay (debounces to next tick)', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 0);

    debounced();
    debounced();
    debounced();

    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns void (does not return the original function result)', () => {
    const fn = vi.fn(() => 'result');
    const debounced = debounce(fn, 50);

    const result = debounced();
    expect(result).toBeUndefined();

    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalled();
  });

  it('can be called again after the delay has fired', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);

    debounced();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
