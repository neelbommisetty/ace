# Best Revenue Window

**Category:** LeetCode Algorithms
**Difficulty:** easy
**Suggested Time:** ~15 minutes

---

## Problem Statement

A subscription business logs one net-revenue delta per hour: positive when new
signups outweigh churn, negative when they don't. Finance wants the single best
contiguous stretch of hours — the window whose deltas sum to the largest total
— to headline the quarterly deck.

Given the hourly deltas, return that largest contiguous sum.

Implement `bestRevenueWindow` in `solution.ts`.

## Signature

```ts
export function bestRevenueWindow(deltas: number[]): number;
```

## Examples

```ts
bestRevenueWindow([1, -2, 3, 4, -1, 2]); // 8   -> the window [3, 4, -1, 2]
bestRevenueWindow([-5, -2, -9]);         // -2  -> every window is negative; the least bad is [-2]
bestRevenueWindow([]);                   // 0   -> no hours logged at all
```

## Constraints

- The window must be **contiguous** and **non-empty** — you may not skip hours,
  and you may not answer with "take nothing".
- Because the window must be non-empty, an all-negative input returns its
  largest (least negative) element, not `0`.
- The empty input is the one exception: `bestRevenueWindow([])` returns `0`.
- Deltas may be any finite number, including `0` and non-integers.
- Must run in O(n) time and O(1) extra space — inputs reach 200,000 hours, so a
  nested-loop scan will time out.
- Do not mutate the input array.

## Hints

1. Walk the array once, carrying "the best sum of a window that ends exactly
   here". That value is a one-line recurrence from the previous one.
2. At each hour you only ever choose between extending the previous window and
   starting a new window at the current hour.
3. Seed your running best with the first element rather than `0` — that is
   precisely what makes the all-negative case come out right.
