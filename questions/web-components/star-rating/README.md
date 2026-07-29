# Accessible Star Rating

**Category:** React Components
**Difficulty:** medium
**Suggested Time:** ~35 minutes

---

## Problem Statement

The reviews team needs a star-rating control for the "rate your order" step of
checkout. It ships in three places with three different owners of the value, so
it must be **fully controlled** — no internal shadow state — and it must be
operable entirely from the keyboard, because rating is inside the accessible
checkout flow that is audited every quarter.

Build `StarRating` in `Component.tsx` (the file is always `Component.tsx`; the
export is named `StarRating`).

## Signature

```tsx
export interface StarRatingProps {
  /** Current rating, 0 = unrated. */
  value: number;
  /** Called with the next rating. Never called in readOnly mode. */
  onChange: (next: number) => void;
  /** Number of stars. Defaults to 5. */
  max?: number;
  /** Accessible name for the group. */
  label: string;
  /** Renders the current value but refuses all input. Defaults to false. */
  readOnly?: boolean;
}

export function StarRating(props: StarRatingProps): ReactElement;
```

## Examples

```tsx
<StarRating value={3} label="Order rating" onChange={setRating} />
// renders a radiogroup named "Order rating" with 5 radios;
// the 3rd radio has aria-checked="true", the rest "false"
```

```tsx
// clicking the 4th star
onChange // called with 4

// clicking the star that is already selected
onChange // called with 0 — clicking your own rating clears it
```

```tsx
// value={3}, ArrowRight on the group -> onChange(4)
// value={5}, max={5}, ArrowRight       -> onChange(5)   (clamped, still emitted)
// value={0}, ArrowLeft                 -> onChange(0)   (clamped, still emitted)
```

## Constraints

- The container is `role="radiogroup"` with `aria-label={label}`. Each star is
  a `<button type="button">` with `role="radio"` and an `aria-checked` of
  `"true"`/`"false"` — exactly one star is checked, and none are when
  `value === 0`.
- Each star's accessible name is `"1 star"`, `"2 stars"`, `"3 stars"`, … —
  singular only for the first.
- Fully controlled: the rendered state is always derived from `value`. If the
  parent ignores `onChange`, nothing on screen may change.
- Clicking star *n* emits `n`, except when `value === n`, which emits `0`.
- Keyboard, handled on the group: `ArrowRight`/`ArrowUp` emit `value + 1`,
  `ArrowLeft`/`ArrowDown` emit `value - 1`, `Home` emits `1`, `End` emits
  `max`. All results are clamped to `0..max`, and a clamped value is still
  emitted. The group is focusable (`tabIndex={0}`).
- `readOnly` renders the value, sets `aria-readonly="true"` on the group,
  disables every star button, and suppresses every `onChange` — including the
  keyboard ones.
- `max` defaults to 5 and may be any positive integer.
- No `useEffect`, no timers, no state. This component has none to own.

## Hints

1. `Array.from({ length: max }, (_, i) => i + 1)` gives you the 1-based star
   numbers to map over — indices are the classic off-by-one here.
2. Funnel every input path — click and key — through one `emit(next)` helper
   that clamps and short-circuits on `readOnly`. That is what keeps the
   readOnly rule from being re-implemented five times.
3. `aria-checked={star === value}` is enough: React renders booleans on `aria-*`
   attributes as the strings `"true"` / `"false"`.
