# Build a Star Rating Web Component

**Category:** Web Components  
**Difficulty:** Medium  
**Suggested Time:** ~35 minutes

---

## Problem

Build a `<star-rating>` custom element that displays 5 stars, allows users to click to rate, has a `value` attribute/property, and dispatches a `change` event when the rating changes.

## Requirements

- **Display** — Render 5 star elements (you may use Unicode stars ★/☆, SVG, or styled spans).
- **Click to rate** — Clicking a star sets the rating to that star's index (1–5).
- **`value` attribute** — The component accepts a `value` attribute (e.g. `<star-rating value="3">`) to show the initial or current rating.
- **`value` property** — The component exposes a `value` getter/setter that reflects and updates the rating.
- **`change` event** — When the user clicks a star, dispatch a `change` event with the new value (e.g. `detail: { value: 3 }`).

## Example Usage

```html
<star-rating value="3"></star-rating>
```

```js
const el = document.querySelector('star-rating');
el.value = 4;
el.addEventListener('change', (e) => console.log('New rating:', e.detail.value));
```

## Constraints

- Use the Custom Elements API (extend `HTMLElement`).
- Use Shadow DOM for encapsulation.
- Observe the `value` attribute and sync it with the internal state.
- Clamp `value` to 0–5 (0 = no stars selected).

## Hints

- Use `attachShadow({ mode: 'open' })` in the constructor.
- Use `static get observedAttributes()` to return `['value']`.
- In `attributeChangedCallback`, parse the attribute and update the display.
- Use `CustomEvent` with `detail: { value }` for the change event.
