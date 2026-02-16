import { describe, it, expect } from 'vitest';
import { twoSum } from './solution';

describe('twoSum', () => {
  it('basic case: [2,7,11,15] target 9 returns [0,1]', () => {
    const nums = [2, 7, 11, 15];
    const result = twoSum(nums, 9);
    expect(result).toHaveLength(2);
    expect(result.sort()).toEqual([0, 1]);
    expect(nums[result[0]] + nums[result[1]]).toBe(9);
  });

  it('handles negative numbers', () => {
    const result = twoSum([-1, -2, -3, -4, -5], -8);
    expect(result).toHaveLength(2);
    const [i, j] = result;
    expect([-1, -2, -3, -4, -5][i] + [-1, -2, -3, -4, -5][j]).toBe(-8);
  });

  it('handles zero in array', () => {
    const result = twoSum([0, 4, 3, 0], 0);
    expect(result).toHaveLength(2);
    const [i, j] = result;
    expect(i).not.toBe(j);
    expect([0, 4, 3, 0][i] + [0, 4, 3, 0][j]).toBe(0);
  });

  it('handles large array', () => {
    const nums = Array.from({ length: 10000 }, (_, i) => i);
    const target = 9998;
    const result = twoSum(nums, target);
    expect(result).toHaveLength(2);
    expect(nums[result[0]] + nums[result[1]]).toBe(target);
  });

  it('handles duplicate values', () => {
    const result = twoSum([3, 3], 6);
    expect(result).toHaveLength(2);
    expect(result).toContain(0);
    expect(result).toContain(1);
    expect(result[0]).not.toBe(result[1]);
  });

  it('adjacent elements sum to target', () => {
    const result = twoSum([1, 2, 3, 4], 7);
    expect(result).toHaveLength(2);
    expect([1, 2, 3, 4][result[0]] + [1, 2, 3, 4][result[1]]).toBe(7);
  });

  it('single pair in longer array', () => {
    const result = twoSum([1, 2, 3, 4, 5, 6, 7, 8, 9], 17);
    expect(result).toHaveLength(2);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9][result[0]] + [1, 2, 3, 4, 5, 6, 7, 8, 9][result[1]]).toBe(17);
  });
});
