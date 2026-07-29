# Sprint Task Board

**Category:** React Web Apps
**Difficulty:** medium
**Suggested Time:** ~45 minutes

---

## Problem Statement

The internal tooling team wants the smallest useful sprint board: add a task,
tick it off, filter the list, and sweep the finished ones away. It has to hold
together under the boring-but-real cases the last version got wrong — blank
submissions, duplicate titles, an empty filtered view, and a progress counter
that has to stay honest.

Build the whole screen as the default export of `App.tsx`.

## Signature

```tsx
export default function App(): ReactElement;
```

The component owns all of its state; it takes no props and performs no I/O.

## Examples

```
[ New task: "Ship the migration" ]  [ Add task ]

All | Active | Done                       1 of 3 done

☑ Write the RFC
☐ Ship the migration
☐ Backfill the index

[ Clear done ]
```

```tsx
// typing "  Write the RFC  " and pressing Add
// -> one task titled "Write the RFC" (trimmed), and the input is cleared

// pressing Add with an empty or whitespace-only input
// -> nothing is added, and the list is unchanged
```

```tsx
// filter = Active with every task done
// -> the list is replaced by the message "Nothing here yet."
```

## Constraints

- The text field's accessible name is `New task`; the submit control's is
  `Add task`. Submitting via the form (Enter in the field) and clicking the
  button must behave identically.
- Titles are trimmed before being stored. A title that trims to empty is
  rejected: no task, no error thrown, and the input keeps whatever the user
  typed.
- Adding a task clears the input. New tasks append to the bottom of the list.
- Duplicate titles are allowed — two tasks with the same title are two
  independent tasks and toggling one must not toggle the other.
- Tasks render as `<li>` items, each containing a checkbox whose accessible
  name is the task title. Checking it marks the task done; unchecking undoes
  it.
- Exactly one of the three filters (`All`, `Active`, `Done`) is active at a
  time, marked with `aria-pressed="true"`. `All` is the initial filter.
  Filtering changes what is listed, never what is stored.
- The counter reads `"<done> of <total> done"` and always counts **all** tasks,
  never just the visible ones.
- `Clear done` removes every completed task. It is disabled when no task is
  done.
- When the current filter yields no tasks, render the exact text
  `Nothing here yet.` instead of an empty list.

## Hints

1. One `Task = { id, title, done }` array is all the state you need, plus the
   input string and the current filter. Everything else is derived at render
   time.
2. Derive the visible list with a `filter` at render time rather than storing a
   second array — that is what keeps the counter honest when the filter changes.
3. Duplicate titles are why tasks need an id: key and toggle by id, never by
   title or by index.
