# Category Capsule: React Web Apps (`react-apps`)

## Identity

This category tests whether the candidate can build a **feature-sized
product slice** in React — hooks, state modeling, effects, data flow —
under production concurrency realities. The core skill under test is
**async data meeting concurrent UI state**: in-flight tracking, retry,
cancellation, stale-response guarding, and optimistic updates that
reconcile or roll back.

A great question is a slice a product team would actually ship:
a streaming agent chat pane with interruption, a notification center with
read-state, a config-driven form step validating against a server, an
optimistic checkout step that must never double-submit. The backend is
always a provided deterministic fake module (`api.ts`) — the same
fixtures and fake async functions shared by the app, the tests, and the
live preview — so the hard part is never plumbing; it is what the UI
shows in every state under interleaving.

This category is NOT: a single presentational component demo, CSS or pixel
craft, routing- or state-library API trivia, or a todo-app rehash. If a
question needs no async-race or lifecycle reasoning, it does not belong here.

## Difficulty Calibration

- **easy**: one async data flow with a complete state surface —
  loading, empty, error, success — plus one interaction that mutates it
  (e.g. a notification list with mark-as-read). A strong Senior finishes
  with time to spare; the Staff signal is state modeled as a discriminated
  status (not boolean soup) and effect cleanup handled without being told.
- **medium**: two interacting async concerns — e.g. debounced
  search with stale-response guarding, or an optimistic mutation with
  rollback while a refresh is in flight. At least one concurrency reality
  (ordering, cancellation, dedup) must be handled to pass. Staff signal:
  the staleness/cancellation guard is designed in from the start (request
  token, ignore flag, AbortController), not patched in after a failing test.
- **hard**: a slice where three or more edge-case classes
  interact — e.g. a streaming reply pane with stop/regenerate, queued
  sends, and error recovery, where tests enforce ordering, cleanup, and
  read-state consistency so a happy-path solution cannot pass. Hard forces
  prioritizing which guarantees to encode and defending the trade-offs
  (cancel vs. ignore-stale, optimistic vs. confirmed) — never obscure APIs.

Size the question honestly for its difficulty. Short questions (10, 25
minutes) are valid — not every easy needs padding to fill a slot. A
full-size question is expected to take a strong Senior about 45 minutes;
up to 60 is allowed when the material genuinely warrants it. 60 minutes is
a hard cap — if the design needs more, shrink scope rather than exceed it.
Never pad a naturally short question to look bigger than it is.

## Environment & Test Contract

- File layout: `App.tsx` (editable — the candidate's solution), `api.ts`
  (read-only — the fake backend, authored as `supportCode`), `App.test.tsx`
  (read-only). Tests import the component via `import App from './App'` —
  the component is ALWAYS the default export and ALWAYS named `App`.
- **`supportCode` is the complete contents of `api.ts`.** It exports typed
  fixtures (the data the scenario needs) and fake async functions that
  stand in for the backend — e.g. `fetchNotifications(): Promise<Notification[]>`,
  `markRead(id: string): Promise<void>`. Requirements:
  - Latency via `setTimeout` inside the returned promise, never an
    already-resolved/rejected promise — so `vi.advanceTimersByTimeAsync`
    controls when each call settles.
  - Error paths trigger on a designated input or fixture state (a specific
    id, a flag flipped by a prior call) — NEVER on randomness
    (`Math.random`). A test must be able to force the error deterministically.
  - The module is stateless, or exposes a `reset()` export that tests call
    in `beforeEach` — never let mutation from one test bleed into the next.
- **`signature` is used VERBATIM as the entire starter file** — it is NOT a
  bare declaration head. It must be a complete, compilable multi-line file:
  the `import React from 'react';` line, an import from `'./api'` for
  whatever the component calls, any domain types or props interface the
  problem names, and `export default function App(...)` with a minimal
  `// TODO: implement` body returning placeholder JSX:

  ```tsx
  import React from 'react';
  import { fetchNotifications, type Notification } from './api';

  export default function App() {
    // TODO: implement
    return <div>TODO</div>;
  }
  ```

  Prefer a props-free `App` fed by `./api`; if props are truly needed,
  define the interface here and pass them in every test.
- `App.tsx` imports data ONLY from `./api` — never `fetch`, never
  `vi.stubGlobal('fetch', ...)`. There is no network seam in this category
  anymore: the fake module in `./api` IS the backend, for the app, the
  tests, and the live preview alike.
- Tests import the same `./api` module the app imports — the identical
  fixtures and fake functions, never a separately re-mocked version.
- Tests run under vitest (`globals: true`) in a `happy-dom` environment;
  jest-dom matchers are preloaded via `vitest.setup.ts`. Tests must still
  import everything they use from `'vitest'` and `'@testing-library/react'`.
- Allowed test imports — this exact whitelist: `'vitest'`, `'react'`,
  `'react-dom'`, `'@testing-library/react'`, `'@testing-library/jest-dom'`.
  NEVER `'@testing-library/user-event'`, `'jsdom'`, `'msw'`, or any other
  package. All interactions use `fireEvent` (never `userEvent`).
- Time-dependent behavior MUST use fake timers: `vi.useFakeTimers()` in
  `beforeEach`, `vi.useRealTimers()` in `afterEach`, advance with
  `await vi.advanceTimersByTimeAsync(ms)` (the async variant flushes
  microtasks). With fake timers, avoid `waitFor`/`findBy*` (they can hang);
  wrap timer advances and promise resolutions in `await act(async () => ...)`.
- Prefer accessible queries (`getByRole`, `getByLabelText`, `getByText`).
- Every expected value carries a derivation comment; every test must fail
  against the starter stub — a test that passes on placeholder JSX (e.g.
  "renders without crashing") is vacuous; never write one.
- **UI contract**: `description` MUST contain a `## UI Contract` section
  enumerating every role+accessible-name, label, placeholder, and exact
  visible string — loading, error, and empty states included — that the
  tests query. Tests may assert only strings/roles/labels listed there; a
  test that needs an unlisted one means the description is incomplete, not
  that the test may reach for something untracked.

## Example Test File

This excerpt is the quality bar (a full file has 6–12 tests) — note the
per-call latency in `api.ts` controlling response order, the act/fake-timer
discipline, and the derivation comments. Every test fails against the stub.

`api.ts` sketch (`supportCode` is the complete file — this is the shape,
not the whole thing):

```ts
export type User = { id: string; name: string };

const RESULTS: Record<string, User[]> = {
  al: [{ id: '1', name: 'Al' }, { id: '2', name: 'Alan' }],
  ali: [{ id: '3', name: 'Alice' }],
  bo: [{ id: '4', name: 'Bo' }],
};

// Per-query latency is what makes race ordering deterministic: "al" is
// requested first but resolves after "ali", producing a stale response.
const LATENCY: Record<string, number> = { al: 500, ali: 100, bo: 200 };

let boFailedOnce = false; // fixture state, not randomness — cleared by reset()
export function reset() {
  boFailedOnce = false;
}

export function searchUsers(query: string): Promise<User[]> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (query === 'bo' && !boFailedOnce) {
        boFailedOnce = true;
        reject(new Error('network down')); // designated failing input: 'bo' fails once
        return;
      }
      resolve(RESULTS[query] ?? []);
    }, LATENCY[query] ?? 100);
  });
}
```

Test file — see the description's `## UI Contract` for every role/label/
string these tests are allowed to assert; that section is the single
source of truth, so this comment does not restate it:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { reset } from './api';

async function advance(ms: number) {
  // act-wrapped: timer callbacks trigger React state updates
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

describe('App — portal user search', () => {
  beforeEach(() => { vi.useFakeTimers(); reset(); });
  afterEach(() => vi.useRealTimers());

  it('debounces, shows loading, and ignores a stale response', async () => {
    render(<App />);
    const input = screen.getByPlaceholderText('Search users');
    fireEvent.change(input, { target: { value: 'al' } }); // latency 500ms — arrives LAST
    await advance(299); // 1ms short of the 300ms debounce — must not fire
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    await advance(1); // t=300ms: debounce fires exactly once, calling searchUsers('al')
    expect(screen.getByText('Loading...')).toBeInTheDocument(); // in flight
    fireEvent.change(input, { target: { value: 'ali' } }); // latency 100ms — arrives first
    await advance(300); // t=600ms: debounce for "ali" fires, calling searchUsers('ali')
    await advance(100); // t=700ms: "ali" (called at 600, +100 latency) resolves — newer query wins
    expect(screen.getByText('Alice')).toBeInTheDocument();
    await advance(100); // t=800ms: "al" (called at 300, +500 latency) resolves late — must be ignored
    // Staleness guard: "Alice" must survive; stale names must never appear
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Alan')).not.toBeInTheDocument();
  });

  it('shows the error state and recovers via Retry', async () => {
    render(<App />);
    const input = screen.getByPlaceholderText('Search users');
    fireEvent.change(input, { target: { value: 'bo' } });
    await advance(300); // debounce elapsed — searchUsers('bo') in flight
    await advance(200); // 'bo' latency — first call is the designated failing one
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // Retry refetches immediately (no debounce on retry); boFailedOnce is
    // now true, so this second call resolves instead of rejecting
    await advance(200);
    expect(screen.getByText('Bo')).toBeInTheDocument(); // error state cleared
  });
});
```

## Edge-Case Classes

- **Out-of-order async responses**: an older request resolving after a newer
  one must never overwrite current results (token, ignore flag, or abort).
- **Rapid input during in-flight requests**: keystrokes/clicks/submits while
  pending — debounce/dedup, double-submit prevention, superseded-request fate.
- **Error and retry paths**: failure surfaces a real error state; retry
  refetches correctly, clears the error, duplicates no side effects.
- **State-surface completeness**: loading, empty, error, success all
  distinct, reachable, mutually exclusive — no "empty" flash, no error+data together.
- **Effect cleanup on unmount**: no setState after unmount; timers and
  subscriptions cleared; in-flight work cancelled or ignored.
- **List identity under reorder**: keys stable across reorder/insert/remove
  so row-local state sticks to the right item — index keys break this.
- **Optimistic updates and reconciliation**: UI updates before the api
  module confirms; rollback restores truth even if other state changed meanwhile.

## Review Dimensions

Keep these exact names (they key historical score comparisons):

- **Correctness**: 5 = every promised state and transition right, including
  concurrent interleavings (stale guard, retry, cleanup); 3 = most states
  right, one behavioral slip under interleaving; 1 = core flow wrong or states missing.
- **Component Design**: 5 = boundaries fall where responsibilities change,
  narrow typed props, presentation split from orchestration where it pays;
  3 = one oversized component, mixed concerns but followable; 1 = a single
  tangle where every concern touches every other.
- **Hook Usage**: 5 = effects only for genuine external synchronization,
  honest dependency arrays, cleanup wherever needed; 3 = works but with an
  unnecessary effect or redundant memoization; 1 = suppressed deps causing
  stale closures, effects computing derived state, conditional hooks.
- **State Management**: 5 = illegal states unrepresentable (discriminated
  status union), single source of truth, derived data computed at render;
  3 = boolean flags permit an impossible state but code avoids it; 1 =
  duplicated or contradictory state, server data copied into drifting slots.
- **Accessibility**: 5 = roles and names from semantic elements (button,
  list, labeled input), status changes surfaced (role="status"/aria-live),
  honest disabled/busy semantics; 3 = mostly semantic markup, a few missing
  labels; 1 = div-with-onClick, unlabeled inputs, silent state changes.
- **Performance**: 5 = no wasted network (debounce/dedup/cancel), stable
  list identity, memoization only where render cost demands it; 3 = correct
  but refetches or re-renders more than needed; 1 = a fetch per keystroke,
  unstable keys forcing remounts, effects re-running every render.
- **Code Quality**: 5 = invariants visible in structure, typed handlers and
  API payloads, no dead code; 3 = readable with incidental complexity;
  1 = copy-paste branches, `any`-typed events, tangled control flow.

## Signals

Positive (Staff-level):
- Request lifecycle designed up front: a staleness guard (token/ignore
  flag/AbortController) in the first version of the effect.
- Status modeled as one discriminated union (`idle|loading|error|success`)
  rather than independent booleans that can contradict.
- Derived values (unread counts, filtered lists, canSubmit) computed at
  render, never mirrored into state via effects.
- Optimistic paths that keep enough information to roll back correctly.
- Accessibility arrives free via semantic elements and real labels.

Red flags:
- `eslint-disable-next-line react-hooks/exhaustive-deps`, or dependency
  arrays edited until the loop stops, instead of restructuring the effect.
- setState after unmount; timers or subscriptions with no cleanup path.
- `isLoading`/`isError`/`data` boolean soup where impossible combinations
  are only avoided by luck.
- Index keys on a list the problem explicitly reorders or edits.
- Effects that exist to copy props or server data into local state.

## Example Directions

- **Streaming agent reply pane**: send a prompt,
  render the reply as timer-driven streamed chunks, support Stop (keep
  partial text, mark interrupted) and Regenerate (discard the old stream) —
  hard because out-of-order chunk delivery, rapid stop/regenerate during
  flight, and cleanup on unmount all interact with one growing transcript.
- **Notification center with read-state**: load a
  list from the api module, show an unread badge derived from data,
  mark-one and mark-all-read as optimistic mutations with rollback on
  failure — hard because optimistic reconciliation, error+retry, list
  identity under new arrivals, and state-surface completeness all bear on
  one counter that must not lie.
- **Checkout step with expiring quote**: load a quote
  from the api module that expires on a countdown, disable Pay while
  submitting, guarantee exactly-one submission under rapid clicks, re-quote
  on expiry without losing form input — hard because double-submit
  prevention, stale-quote guarding, timer cleanup, and error recovery hold
  while money is on screen.
