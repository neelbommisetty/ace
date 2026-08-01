{{charter}}

---

# Task: Author the Reference Solution — {{category-name}} (`{{category-slug}}`)

A problem statement for this category has already been drafted; it is in the
user message. Your job is the answer key: a complete, correct,
production-quality solution that satisfies every promise the statement makes.
A separate stage then writes the test file against YOUR solution, so anything
the description requires and your solution does not implement becomes a failed
verification run, not a smaller test suite.

This solution is never shown to the candidate before review.

## Category Identity

{{identity}}

## Environment & Test Contract

Your solution must obey this contract exactly — file shape, imports, and
module boundaries included:

{{environment}}

## Your Job

1. **Implement everything the description promises.** Work through
   `## Constraints` and `## Examples` line by line; every stated rule, limit,
   and edge-case behavior must be handled explicitly, not incidentally.
2. **Write it the way a credible Staff engineer would**: the simplest
   structure that meets the requirements, correct semantics before
   abstraction, no dead generality, no commentary about the interview.
3. **Support module** — if this category's Environment & Test Contract
   defines a shared read-only module (e.g. `api.ts`), author it too: a real
   deterministic fake backend that the solution, the tests, AND the live
   preview all import. It must expose every input, latency, and error path the
   description's promised behavior needs; a test-only stub is a defect.
4. **Stay inside the description.** If the statement is ambiguous, pick the
   reading a careful candidate would and implement THAT — never invent a new
   requirement the candidate could not have known about.

## Output Contract

Respond with a single JSON object — no code fences around it, no surrounding
prose. Fields:

- `referenceSolution` — the complete solution file contents. It must compile
  and satisfy every behavior the description promises. `null` only for
  categories with no solution file.
- `supportCode` — the complete contents of the category's support module
  when its Environment & Test Contract defines one; `null` for every other
  category.
- `solutionCode` — always `null`. The candidate's starter file is generated
  from the signature alone; a candidate-facing solution must never be
  written.

## Self-Check Before You Answer

1. Does the solution satisfy every `## Constraints` rule and reproduce every
   `## Examples` case exactly, traced by hand rather than assumed?
2. Does it handle the edge cases the description promises — empty, boundary,
   error, and concurrency paths — explicitly?
3. Does it match the declared signature and the Environment & Test Contract's
   file/import shape exactly?
4. (Support module) Is it deterministic, importable by both the solution and
   the tests, and rich enough to drive every promised state — loading, error,
   and empty included?
