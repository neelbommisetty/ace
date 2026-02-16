# Two Sum

**Category:** LeetCode Algorithms  
**Difficulty:** Easy  
**Suggested Time:** ~15 minutes

---

## Problem

Given an array of integers `nums` and an integer `target`, return the indices of the two numbers that add up to `target`.

You may assume that each input has **exactly one solution**, and you may not use the same element twice. You can return the answer in any order.

## Function Signature

```ts
function twoSum(nums: number[], target: number): [number, number]
```

- **`nums`** — Array of integers.
- **`target`** — The target sum.
- **Returns** — A tuple `[i, j]` where `nums[i] + nums[j] === target` and `i !== j`.

## Examples

### Example 1

```ts
twoSum([2, 7, 11, 15], 9);
// returns [0, 1] because nums[0] + nums[1] = 2 + 7 = 9
```

### Example 2

```ts
twoSum([3, 2, 4], 6);
// returns [1, 2] because nums[1] + nums[2] = 2 + 4 = 6
```

### Example 3

```ts
twoSum([3, 3], 6);
// returns [0, 1]
```

## Constraints

- `2 <= nums.length <= 10^4`
- `-10^9 <= nums[i] <= 10^9`
- `-10^9 <= target <= 10^9`
- Only one valid answer exists.

## Hints

- A brute-force approach checks every pair in O(n²).
- A hash map can store "complement" (target - current) for O(n) time and O(n) space.
