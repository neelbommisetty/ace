import { describe, expect, it } from 'vitest';
import { isFullyPassing } from './run';

describe('isFullyPassing', () => {
  it('is true for a done run where every test passed', () => {
    expect(isFullyPassing({ status: 'done', summary: { total: 3, passed: 3 } })).toBe(true);
  });

  it('is false for a done run with some failures', () => {
    expect(isFullyPassing({ status: 'done', summary: { total: 3, passed: 2 } })).toBe(false);
  });

  it('is false when total is 0', () => {
    expect(isFullyPassing({ status: 'done', summary: { total: 0, passed: 0 } })).toBe(false);
  });

  it('is false for a non-done status', () => {
    expect(isFullyPassing({ status: 'error', summary: { total: 3, passed: 3 } })).toBe(false);
    expect(isFullyPassing({ status: 'running', summary: { total: 3, passed: 3 } })).toBe(false);
  });

  it('is false when the run or its summary is null', () => {
    expect(isFullyPassing(null)).toBe(false);
    expect(isFullyPassing({ status: 'done', summary: null })).toBe(false);
  });
});
