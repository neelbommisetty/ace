{{charter}}

---

# Task: Author the Test File — {{category-name}} (`{{category-slug}}`)

The user message carries a drafted problem statement and the reference
solution written against it. Your job is the complete test file that
verifies a candidate's work. It is executed twice before this question ships:
it MUST pass against the reference solution, and it MUST fail against the
unimplemented starter stub. Both runs are automated — a suite that fails
either one sends the whole question back for repair.

## Category Identity

{{identity}}

## Environment & Test Contract

Your test file must obey this contract exactly — runner, imports, file name,
and query rules included:

{{environment}}

## Edge-Case Classes for This Category

Cover the classes below that the description actually promises. A class the
description says nothing about is NOT yours to test — the statement is the
contract with the candidate:

{{edge-case-classes}}

## Test Authoring Core

- Write 6–12 tests: happy path, each promised edge-case class, error
  handling, and lifecycle/cleanup where the category demands it.
- **Hand-trace every expected value.** Execute the reference solution
  line-by-line against each test input before writing the expectation, and
  add a short derivation comment to every non-obvious expected value showing
  how it was computed. Never guess an expected value.
- Every test must fail against the unimplemented starter stub. A test that
  passes with no implementation (e.g. asserting on an empty render, or only
  that a function exists) is vacuous — do not write it.
- **Test only what the description promises.** For each assertion, name to
  yourself where the description states the behavior it checks. If nowhere,
  drop or loosen the assertion — never assert behavior a candidate could only
  learn by reading the reference solution.
- Respect the import allowlist in the Environment & Test Contract exactly.
- Tests must be deterministic: no real network, no real timers where fake
  timers are prescribed, no order dependence between tests.
- (`react-apps`, `web-components`) Query ONLY strings, roles, and labels the
  description's `## UI Contract` declares, with the loosest screen-level
  query that still verifies the behavior. `closest()`, CSS/tag selectors, and
  container-level text assertions are defects. Use role-scoped `within()`
  only where the contract declares the repetition. If the behavior you want
  to verify needs a string the contract does not declare, verify a different
  promised behavior instead.

## Example of the Expected Quality

Match the rigor of this model test file:

{{example}}

## Output Contract

Respond with a single JSON object — no code fences around it, no surrounding
prose. Fields:

- `testCode` — the complete test file contents. `null` only for categories
  with no test suite.

Return the whole file, never a fragment or a diff: the file you return is
written to disk verbatim.

## Self-Check Before You Answer

1. Does every expected value have a derivation you actually traced against
   the reference solution?
2. Would each test genuinely FAIL against an unimplemented stub?
3. Does every assertion check behavior the description states — nothing
   learned only from the reference solution's internals?
4. Does the file obey the import allowlist and the file/runner shape in the
   Environment & Test Contract?
5. (`react-apps`, `web-components`) Is every queried string, role, and label
   declared in the description's `## UI Contract`?
