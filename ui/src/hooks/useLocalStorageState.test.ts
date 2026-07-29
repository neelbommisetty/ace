import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useLocalStorageNumber } from './useLocalStorageState';

describe('useLocalStorageNumber', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('resolves to null when the key was never set', () => {
    const hook = renderHook(() => useLocalStorageNumber('ace-problem-width'));
    expect(hook.result.current[0]).toBeNull();
  });

  it('round-trips a written value through localStorage', () => {
    const hook = renderHook(() => useLocalStorageNumber('ace-problem-width'));
    act(() => hook.result.current[1](340));
    expect(hook.result.current[0]).toBe(340);
    expect(localStorage.getItem('ace-problem-width')).toBe('340');

    // a fresh mount reads the same persisted value back
    const hook2 = renderHook(() => useLocalStorageNumber('ace-problem-width'));
    expect(hook2.result.current[0]).toBe(340);
  });

  it('supports the functional updater form used for re-clamping', () => {
    const hook = renderHook(() => useLocalStorageNumber('ace-ai-width'));
    act(() => hook.result.current[1](300));
    act(() => hook.result.current[1]((w) => (w ?? 0) + 20));
    expect(hook.result.current[0]).toBe(320);
    expect(localStorage.getItem('ace-ai-width')).toBe('320');
  });

  it('resetting to null removes the key rather than writing back a default', () => {
    const hook = renderHook(() => useLocalStorageNumber('ace-console-height'));
    act(() => hook.result.current[1](250));
    expect(localStorage.getItem('ace-console-height')).toBe('250');

    act(() => hook.result.current[1](null));
    expect(hook.result.current[0]).toBeNull();
    expect(localStorage.getItem('ace-console-height')).toBeNull();
  });

  it('treats a corrupted stored value as unset instead of throwing', () => {
    localStorage.setItem('ace-problem-width', 'not-a-number');
    const hook = renderHook(() => useLocalStorageNumber('ace-problem-width'));
    expect(hook.result.current[0]).toBeNull();
  });
});
