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
optimistic checkout step that must never double-submit. The network is
always mocked in tests (`vi.fn` / fetch stubs), so the hard part is never
plumbing — it is what the UI shows in every state under interleaving.

This category is NOT: a single presentational component demo, CSS or pixel
craft, routing- or state-library API trivia, or a todo-app rehash. If a
question needs no async-race or lifecycle reasoning, it does not belong here.

## Difficulty Calibration

Suggested times: easy 25 min, medium 45 min, hard 60 min.

- **easy (25 min)**: one async data flow with a complete state surface —
  loading, empty, error, success — plus one interaction that mutates it
  (e.g. a notification list with mark-as-read). A strong Senior finishes
  with time to spare; the Staff signal is state modeled as a discriminated
  status (not boolean soup) and effect cleanup handled without being told.
- **medium (45 min)**: two interacting async concerns — e.g. debounced
  search with stale-response guarding, or an optimistic mutation with
  rollback while a refresh is in flight. At least one concurrency reality
  (ordering, cancellation, dedup) must be handled to pass. Staff signal:
  the staleness/cancellation guard is designed in from the start (request
  token, ignore flag, AbortController), not patched in after a failing test.
- **hard (60 min)**: a slice where three or more edge-case classes
  interact — e.g. a streaming reply pane with stop/regenerate, queued
  sends, and error recovery, where tests enforce ordering, cleanup, and
  read-state consistency so a happy-path solution cannot pass. Hard forces
  prioritizing which guarantees to encode and defending the trade-offs
  (cancel vs. ignore-stale, optimistic vs. confirmed) — never obscure APIs.

## Environment & Test Contract

- Solution file: `App.tsx`. Test file: `App.test.tsx`. Tests import the
  component via `import App from './App'` — the component is ALWAYS the
  default export and ALWAYS named `App`.
- **`signature` is used VERBATIM as the entire starter file** — it is NOT a
  bare declaration head. It must be a complete, compilable multi-line file:
  the `import React from 'react';` line, any domain types or props
  interface the problem names, and `export default function App(...)` with
  a minimal `// TODO: implement` body returning placeholder JSX:

  ```tsx
  import React from 'react';

  export interface Notification {
    id: string;
    readAt: string | null;
  }

  export default function App() {
    // TODO: implement
    return <div>TODO</div>;
  }
  ```

  Prefer a props-free `App` fed by the mocked network; if props are truly
  needed, define the interface here and pass them in every test.
- Tests run under vitest (`globals: true`) in a `happy-dom` environment;
  jest-dom matchers are preloaded via `vitest.setup.ts`. Tests must still
  import everything they use from `'vitest'` and `'@testing-library/react'`.
- Allowed test imports — this exact whitelist: `'vitest'`, `'react'`,
  `'react-dom'`, `'@testing-library/react'`, `'@testing-library/jest-dom'`.
  NEVER `'@testing-library/user-event'`, `'jsdom'`, `'msw'`, or any other
  package. All interactions use `fireEvent` (never `userEvent`).
- No real network: stub with `vi.stubGlobal('fetch', vi.fn(...))`, restore
  via `vi.unstubAllGlobals()` in `afterEach`; deferred promises make races deterministic.
- Time-dependent behavior MUST use fake timers: `vi.useFakeTimers()` in
  `beforeEach`, `vi.useRealTimers()` in `afterEach`, advance with
  `await vi.advanceTimersByTimeAsync(ms)` (the async variant flushes
  microtasks). With fake timers, avoid `waitFor`/`findBy*` (they can hang);
  wrap timer advances and promise resolutions in `await act(async () => ...)`.
- Prefer accessible queries (`getByRole`, `getByLabelText`, `getByText`).
- Every expected value carries a derivation comment; every test must fail
  against the starter stub — a test that passes on placeholder JSX (e.g.
  "renders without crashing") is vacuous; never write one.

## Example Test File

This excerpt is the quality bar (a full file has 6–12 tests) — note the
deferred-promise control of response order, the act/fake-timer discipline,
and the derivation comments. Every test fails against the stub:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import App from './App';

// Contract under test: App is a developer-portal user search. Typing into
// the input (placeholder "Search users") debounces 300ms, then calls
// fetch(`/api/users?q=${query}`). In flight: "Loading..."; success: one
// item per user name; failure: "Something went wrong" + a "Retry" button
// that refetches the same query. Stale responses must never win.

function deferred() {
  let resolve!: (names: string[]) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = (names) => res({ ok: true, json: async () => names } as Response);
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function advance(ms: number) {
  // act-wrapped: timer callbacks trigger React state updates
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

describe('App — portal user search', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('debounces, shows loading, and ignores a stale response', async () => {
    const first = deferred(); // response for "al" — arrives LAST (stale)
    const second = deferred(); // response for "ali" — arrives first
    const fetchMock = vi.fn();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    const input = screen.getByPlaceholderText('Search users');
    fireEvent.change(input, { target: { value: 'al' } });
    await advance(299); // 1ms short of the 300ms debounce — must not fire
    expect(fetchMock).not.toHaveBeenCalled();
    await advance(1); // t=300ms: debounce fires exactly once, for "al"
    // Assert the URL only — a solution may legitimately pass { signal } too
    expect(fetchMock.mock.calls[0][0]).toBe('/api/users?q=al');
    expect(screen.getByText('Loading...')).toBeInTheDocument(); // in flight
    fireEvent.change(input, { target: { value: 'ali' } });
    await advance(300); // request 2 ("ali") in flight; request 1 unresolved
    await act(async () => second.resolve(['Alice'])); // newer query wins
    expect(screen.getByText('Alice')).toBeInTheDocument();
    await act(async () => first.resolve(['Al', 'Alan'])); // stale lands late
    // Staleness guard: "Alice" must survive; stale names must never appear
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Alan')).not.toBeInTheDocument();
  });

  it('shows the error state and recovers via Retry', async () => {
    const failed = deferred();
    const retried = deferred();
    const fetchMock = vi.fn();
    fetchMock.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retried.promise);
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    const input = screen.getByPlaceholderText('Search users');
    fireEvent.change(input, { target: { value: 'bo' } });
    await advance(300); // debounce elapsed — request for "bo" in flight
    await act(async () => failed.reject(new Error('network down')));
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // Retry refetches the SAME query immediately (no debounce on retry):
    // 2 calls total, both for q=bo
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // URL-only assertion — stays correct if the solution passes { signal }
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/users?q=bo');
    await act(async () => retried.resolve(['Bo']));
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
- **Optimistic updates and reconciliation**: UI updates before the server
  confirms; rollback restores truth even if other state changed meanwhile.

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
- **Notification center with read-state**: fetch a
  list, show an unread badge derived from data, mark-one and mark-all-read
  as optimistic mutations with rollback on failure — hard because
  optimistic reconciliation, error+retry, list identity under new arrivals,
  and state-surface completeness all bear on one counter that must not lie.
- **Checkout step with expiring quote**: fetch a quote
  that expires on a countdown, disable Pay while submitting, guarantee
  exactly-one submission under rapid clicks, re-quote on expiry without
  losing form input — hard because double-submit prevention, stale-quote
  guarding, timer cleanup, and error recovery hold while money is on screen.
