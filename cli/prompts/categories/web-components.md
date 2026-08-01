# Category Capsule: React Components (`web-components`)

## Identity

This category tests whether the candidate can design and build a **single
reusable React component with a real API**: controlled/uncontrolled prop
contracts, keyboard interaction, correct ARIA roles and states, composition
(children, render slots), and imperative handles only where justified. The
Staff bar is **API-contract thinking** — what the consumer owns versus what
the component owns, and what happens when the consumer misbehaves (unstable
callbacks, mid-flight prop switches) — never pixel styling.

A great `web-components` question is a component a design-systems or product
platform team would actually ship: a mention autocomplete for a comment box,
a tag input for an editorial pipeline, a quantity stepper for checkout, a
streaming-message disclosure for an agent chat. The hard part is always
behavioral: who holds the state, how keyboard and pointer interactions
interleave, what is announced to assistive tech, and what gets cleaned up
when unmounted mid-interaction.

This category is NOT: full apps with routing/data-fetching/multi-screen
flows (that is `react-apps`), CSS or visual-design craft, or textbook
counters/todo lists with no interaction contract.

## Difficulty Calibration

- **easy**: one interaction surface plus 2–3 edge-case classes —
  e.g. a controlled `TagInput` with Enter-to-add, dedupe, and
  Backspace-to-remove. A strong Senior finishes comfortably; Staff signal
  is a clean controlled contract (no shadow state duplicating the `value`
  prop) and correct roles without prompting.
- **medium**: two interacting concerns — e.g. a combobox with
  keyboard navigation PLUS debounced filtering, or both controlled and
  uncontrolled modes with a defined transition policy. At least one
  lifecycle concern (cleanup, focus restoration) must be handled. Staff
  signal: the state-ownership split is decided up front and visible in the
  prop types, not discovered by debugging re-renders.
- **hard**: edge-case classes interact and force prioritization —
  e.g. an async mention autocomplete where rapid typing, debounce windows,
  out-of-order responses, keyboard selection, and unmount mid-request all
  collide. A merely-working solution that ignores race ordering, focus
  management, or cleanup should NOT pass all tests. Hard means interacting
  contracts under time pressure, never obscure React trivia.

Size the question honestly for its difficulty. Short questions are valid —
not every easy needs padding to fill a slot. For this category:
easy targets about 20 minutes, medium about 35, hard about 50.
60 minutes is a hard cap — if the design needs more, shrink scope rather
than exceed it. Never pad a naturally short question to look bigger than
it is.

## Environment & Test Contract

- Solution file: `Component.tsx`. Test file: `Component.test.tsx`. The file
  is ALWAYS named `Component.tsx`, but the component is a **named export
  with a descriptive name** — tests import it by that name:
  `import { TagInput } from './Component'`. Never a default export, never
  `export function Component`.
- **Signature contract (critical)**: the scaffold PREPENDS
  `import React from 'react';` and APPENDS ` {` plus a placeholder JSX body
  plus `}` to the signature. Therefore `signature` must be: optional
  `interface`/`type` declaration(s), then the **bare component declaration
  head with NO body, NO braces, and NO import line**. Correct:

  ```tsx
  interface TagInputProps {
    value: string[];
    onChange: (next: string[]) => void;
    maxTags?: number;
  }

  export function TagInput({ value, onChange, maxTags }: TagInputProps)
  ```

  Incorrect (each produces a broken scaffold): including
  `import React from 'react';`, ending the last line with `{` or `=> {`,
  any function body or trailing `}`, or a default export.
- Allowed test imports — this exact whitelist and nothing else: `'vitest'`,
  `'react'`, `'react-dom'`, `'@testing-library/react'`,
  `'@testing-library/jest-dom'`. NEVER `'@testing-library/user-event'`,
  `'jsdom'`, or any other package. All interactions use `fireEvent` from
  `@testing-library/react` — never `userEvent`.
- Tests run under vitest with `globals: true` in a **happy-dom**
  environment; jest-dom matchers (`toBeInTheDocument`, `toHaveAttribute`,
  ...) are preloaded via `vitest.setup.ts`, so no jest-dom import is
  needed in the test file — but tests must still explicitly import
  everything they use from `'vitest'` (`describe`, `it`, `expect`, `vi`).
- Time-dependent behavior (debounce, auto-repeat, auto-dismiss) MUST use
  fake timers: `vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()`
  in `afterEach`, advance with `await vi.advanceTimersByTimeAsync(ms)`
  (the async variant — it flushes microtasks between timer callbacks).
- **Query discipline — every query is the LOOSEST query that still
  verifies the behavior**, one a candidate who read only the description
  could satisfy:
  - Prefer role-based queries (`getByRole('textbox')`,
    `getAllByRole('option')`) — they double as accessibility assertions —
    and query screen-level by default.
  - AUTHOR strings to be globally unique. Error/status copy names its
    subject, so no scoping is ever needed. GOOD: the copy is
    `Could not remove tag "beta".` and one `screen.getByRole('alert')`
    finds it. BAD: generic `Removal failed.` copy that forces the test to
    assert inside one chip's container.
  - Repeated controls get unique accessible names instead of scoped
    queries. GOOD: a per-chip `Remove beta` button queried by name. BAD:
    `within(chip).getByRole('button', { name: 'Remove' })` when naming
    would do.
  - `within()` (or indexing `getAllByRole(...)`) only when repetition is
    inherent (e.g. per-option selected state in a listbox, chip order) AND
    the scope is a role the `## UI Contract` declares, found via a role
    query — never by walking tags.
  - BANNED in tests: `closest()`, `querySelector`/CSS/tag selectors, and
    container-level `toHaveTextContent` for a string that is globally
    unique when a screen-level query would already verify the behavior
    (order checks via `getAllByRole(...)[i]` are role-scoped and fine).
    Each of these asserts DOM shape the contract never promised.
- The unimplemented stub renders a `<div>` with an `<h1>` of the question
  title. Every test must fail against that stub: never assert merely that
  something rendered, never query the placeholder heading.
- Every non-obvious expected value carries a derivation comment showing
  how it was computed from the inputs.
- **UI Contract rule**: the description MUST contain a `## UI Contract`
  section enumerating every role+accessible-name, label, placeholder, and
  exact visible string (loading/empty/error states included) that any test
  queries. Tests may only assert roles, labels, placeholders, and strings
  listed there — nothing invented ad hoc in the test file. The section
  stays a FLAT vocabulary — roles, names, and exact strings, plus purely
  behavioral structure ("one listitem per tag") — and must never grow a
  containment matrix or prescribe which element wraps which: the DOM shape
  is the candidate's to choose.
- **Description self-sufficiency**: every state-machine transition the
  tests assert — pending → settled, dismissal → empty render,
  disabled-during-flight — must be stated BEHAVIORALLY in the problem
  statement or `## Constraints`, including what stays on screen and what
  leaves at each step. Behavior-level always, DOM-level never: the
  description says WHAT the user observes; tests may only check that
  WHAT. Constraints must never point AWAY from tested behavior. Canonical
  trap: tests expect an action visible-but-disabled while its async work
  is in flight and removed only after settlement, but a constraint says
  the settled state "must not offer the action" — a candidate who hides
  it the moment it is triggered has obeyed the text and fails. State the
  pending shape explicitly.
- **Lifecycle narration**: the `## Problem Statement` must narrate the
  component's observable lifecycle end-to-end — initial render → each
  transition → terminal render — with concrete behavior at every step,
  including terminal states that render nothing (e.g. "after Dismiss the
  component renders nothing at all"). A terminal or intermediate state
  the candidate must reverse-engineer from Constraints and Hints is a
  description defect, not a difficulty device.

## Example Test File

This is the quality bar — note the derivation comments, the role-based
queries, the controlled-contract test using `rerender`, and that every test
fails against the placeholder stub:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TagInput } from './Component';

// Contract under test: every role, label, and string queried below is
// enumerated in the description's ## UI Contract section. Behavior:
// <TagInput value={string[]} onChange={fn}> renders one chip (listitem)
// per tag, appends a trimmed tag on Enter, rejects case-insensitive
// duplicates, and removes the last tag on Backspace when the text input is
// empty. Fully controlled: the chip list follows `value`.

describe('TagInput', () => {
  it('renders one chip per tag, in prop order', () => {
    render(<TagInput value={['alpha', 'beta']} onChange={() => {}} />);
    const chips = screen.getAllByRole('listitem');
    // value has 2 entries -> exactly 2 chips, order preserved
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent('alpha');
    expect(chips[1]).toHaveTextContent('beta');
  });

  it('emits the appended tag on Enter without mutating the value prop', () => {
    const value = ['alpha'];
    const onChange = vi.fn();
    render(<TagInput value={value} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '  beta ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // '  beta ' trims to 'beta'; appended to ['alpha'] -> ['alpha', 'beta']
    expect(onChange).toHaveBeenCalledWith(['alpha', 'beta']);
    // the caller's array must not be mutated: still exactly ['alpha']
    expect(value).toEqual(['alpha']);
  });

  it('is controlled: chips follow the value prop, not internal state', () => {
    const { rerender } = render(<TagInput value={['alpha']} onChange={() => {}} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'beta' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Parent ignored the onChange: chip list must still reflect
    // value=['alpha'], i.e. exactly 1 chip (no shadow state)
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    rerender(<TagInput value={['alpha', 'gamma']} onChange={() => {}} />);
    // Parent committed a different tag -> 2 chips now
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('rejects a case-insensitive duplicate and flags the input invalid', () => {
    const onChange = vi.fn();
    render(<TagInput value={['Alpha']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'alpha' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // 'alpha' duplicates existing 'Alpha' case-insensitively -> no emit
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('removes the last tag on Backspace when the text input is empty', () => {
    const onChange = vi.fn();
    render(<TagInput value={['alpha', 'beta']} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Backspace' });
    // empty input + Backspace drops the trailing 'beta' -> ['alpha']
    expect(onChange).toHaveBeenCalledWith(['alpha']);
  });
});
```

## Edge-Case Classes

- **Controlled/uncontrolled contract**: value-prop changes always win over
  internal state; uncontrolled mode (when offered) has a defined
  transition policy; caller-owned props are never mutated or shadowed.
- **Rapid interaction sequences**: double-fired clicks, Enter followed
  immediately by blur, focus/blur races with open popups, typing during a
  pending debounce — each with one defined outcome (no double-submit).
- **Empty and overflow content**: zero items, one item, hundreds of items;
  labels exceeding the container; a defined empty state, never a blank.
- **Keyboard-only operation**: every pointer path has a keyboard
  equivalent (Arrows, Home/End, Enter, Escape), focus is restored after
  dismissal, roving focus/`aria-activedescendant` matches announced roles.
- **Cleanup on unmount mid-interaction**: unmount while a debounce timer,
  pending async lookup, or held auto-repeat is live — no state update
  after unmount, no leaked timers or listeners.
- **Prop identity churn**: unstable callback props (new identity every
  render) must not reset state, re-fire effects, or break memoization;
  the latest callback is always the one invoked.

## Review Dimensions

Keep these exact names (they key historical score comparisons):

- **Correctness**: 5 = every promised behavior including interaction edges
  (races, duplicates, boundary keys) holds; 3 = happy path and most edges
  right, one behavioral slip; 1 = core interaction broken or the
  controlled contract violated.
- **Component Design**: 5 = prop API is minimal, composable, ownership
  split explicit (consumer owns data, component owns interaction);
  3 = workable API with some redundancy or leaked internals; 1 = prop
  soup, boolean explosions, or internals the consumer must poke.
- **Hook Usage**: 5 = correct dependencies everywhere, effects only for
  real external synchronization, refs for latest-callback where needed;
  3 = works but with a redundant effect or over-broad deps; 1 = state
  derived in effects, missing deps papered over, or conditional hooks.
- **State Management**: 5 = single source of truth, derived data computed
  not stored, controlled/uncontrolled split enforced by construction;
  3 = correct but with duplicated or over-lifted state; 1 = shadow copies
  of props that drift.
- **Accessibility**: 5 = correct roles/states (`aria-expanded`,
  `aria-invalid`), full keyboard operation, focus managed through
  open/dismiss; 3 = roles present but a keyboard path or state attribute
  missing; 1 = div-with-onClick, keyboard users locked out.
- **Performance**: 5 = stable identities where they matter, no
  re-render-the-world on keystroke, memoization justified not ritual;
  3 = acceptable with avoidable re-renders or unstable handlers passed
  deep; 1 = whole-tree work per keystroke or layout thrash in effects.
- **Code Quality**: 5 = invariants visible in structure, precise prop
  types, no dead code; 3 = readable with incidental complexity;
  1 = tangled handlers, `any`-typed props, copy-paste branches.

## Signals

Positive (Staff-level):
- States the controlled/uncontrolled contract up front and enforces it by
  construction (e.g. deriving rendering solely from `value`).
- Keyboard and ARIA behavior designed with the API, not retrofitted —
  roles chosen first, DOM follows.
- Latest-callback handling (ref pattern) so consumer identity churn cannot
  cause stale closures; every timer/listener has one owner, one teardown.
- Names the composition-vs-configuration trade-off (children and slots vs
  more props) and defends the choice.

Red flags:
- Copying props into state "to be safe" — the classic drifting shadow state.
- `useEffect` to synchronize state the component itself owns; effects with
  disabled or hand-wavy dependency arrays.
- Pointer-only interaction; focus lost into `document.body` on dismissal.
- Imperative DOM reads/writes where declarative rendering suffices; an
  imperative handle without a justifying consumer need.
- Memoization theater (`useMemo`/`useCallback` everywhere) while passing a
  fresh object literal to the hot child.

## Example Directions

- A **mention autocomplete** for a collaborative editor's comment box:
  typing `@` opens a keyboard-navigable listbox filtered via an async
  `search(query)` prop with debouncing — hard because rapid typing,
  out-of-order responses, Escape/blur dismissal, and unmount mid-request
  interact; tests probe debounce windows with fake timers, stale-response
  discarding, and `aria-activedescendant` correctness.
- A **quantity stepper** for a checkout line item: controlled `value` with
  min/max clamping, text entry validated on blur, press-and-hold
  auto-repeat — hard because auto-repeat (fake timers), clamp boundaries,
  and invalid-entry recovery interact with the controlled contract; tests
  probe repeat cadence, clamping, and no-emit on out-of-range input.
- A **streaming message disclosure** for an agent chat interface: renders
  progressively appended chunks, auto-collapses beyond N lines with an
  expand control, exposes a copy action — hard because chunk arrival
  during collapse toggling, overflow content, and unmount mid-stream
  interact; tests probe append-while-collapsed, keyboard toggling, and
  cleanup on unmount.
