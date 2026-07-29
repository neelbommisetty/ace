import { describe, expect, it } from 'vitest';
import { bestRevenueWindow } from './solution';

// Contract under test: bestRevenueWindow(deltas) returns the largest sum of a
// NON-EMPTY contiguous window, in O(n) time, without mutating the input.
// The empty array is the single exception and returns 0.

describe('bestRevenueWindow', () => {
  it('finds the best window in a mixed sequence', () => {
    // [3, 4, -1, 2] = 3 + 4 - 1 + 2 = 8; every other window is smaller
    // (e.g. [3, 4] = 7, the whole array = 1 - 2 + 3 + 4 - 1 + 2 = 7).
    expect(bestRevenueWindow([1, -2, 3, 4, -1, 2])).toBe(8);
  });

  it('handles the classic interior window', () => {
    // [4, -1, 2, 1] = 4 - 1 + 2 + 1 = 6, beating [4] = 4 and
    // [4, -1, 2, 1, -5, 4] = 5.
    expect(bestRevenueWindow([-2, 1, -3, 4, -1, 2, 1, -5, 4])).toBe(6);
  });

  it('returns the least-negative element when every hour lost money', () => {
    // Windows must be non-empty, so the answer is max(-5, -2, -9) = -2.
    expect(bestRevenueWindow([-5, -2, -9])).toBe(-2);
  });

  it('returns 0 only for the empty input', () => {
    expect(bestRevenueWindow([])).toBe(0);
  });

  it('handles a single hour of either sign', () => {
    expect(bestRevenueWindow([7])).toBe(7);
    expect(bestRevenueWindow([-7])).toBe(-7);
  });

  it('sums the whole array when every delta is positive', () => {
    // 2 + 3 + 1 + 4 = 10.
    expect(bestRevenueWindow([2, 3, 1, 4])).toBe(10);
  });

  it('spans a dip when spanning it still pays', () => {
    // [2, -1, 2, -1, 2] = 2 - 1 + 2 - 1 + 2 = 4, better than any single 2.
    expect(bestRevenueWindow([2, -1, 2, -1, 2])).toBe(4);
  });

  it('does not span a dip that costs more than it earns', () => {
    // Crossing the -10 gives 5 - 10 + 5 = 0, so the best is a lone 5.
    expect(bestRevenueWindow([5, -10, 5])).toBe(5);
  });

  it('handles zeros and fractional deltas', () => {
    // [0, -3, 0]: best non-empty window is a lone 0.
    expect(bestRevenueWindow([0, -3, 0])).toBe(0);
    // 1.5 - 0.5 + 2.25 = 3.25.
    expect(bestRevenueWindow([1.5, -0.5, 2.25])).toBeCloseTo(3.25, 10);
  });

  it('does not mutate the caller\'s array', () => {
    const deltas = [1, -2, 3];
    bestRevenueWindow(deltas);
    expect(deltas).toEqual([1, -2, 3]);
  });

  it('stays linear on a 200,000-hour input', () => {
    // 200k ones: the best window is the entire array -> 200000. A quadratic
    // scan would be ~2e10 operations and blow the test timeout.
    const deltas = new Array<number>(200_000).fill(1);
    expect(bestRevenueWindow(deltas)).toBe(200_000);
  });
});
