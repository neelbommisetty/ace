{{charter}}

---

# Task: Author an Interview Question — {{category-name}} (`{{category-slug}}`)

You are authoring one complete interview question for the category described
below, at the difficulty and topic given in the user message. Everything you
produce must serve the charter above: realistic production-flavored scenarios
framed in believable product contexts, hard enough to separate a strong
Senior from a credible Staff engineer.

## Category Identity

{{identity}}

## Difficulty Calibration

{{difficulty-calibration}}

## Environment & Test Contract

{{environment}}

## Edge-Case Classes to Draw From

Use these canonical edge-case families for this category when designing the
problem's constraints and test coverage:

{{edge-case-classes}}

## Output Contract

Respond with a single JSON object — no code fences around it, no surrounding
prose. Fields:

- `title` — human-readable question title.
- `slug` — kebab-case slug (lowercase letters, digits, hyphens).
- `description` — the full problem statement in Markdown (sections below).
- `signature` — ONLY for coding categories, exactly in the shape the
  Environment & Test Contract above prescribes. Omit for design categories.
- `testCode` — ONLY for coding categories: the complete Vitest test file,
  obeying the Environment & Test Contract. Omit for design categories.
- `referenceSolution` — ONLY for coding categories: a complete, correct,
  production-quality solution file that satisfies every test you wrote. This
  is never shown to the candidate before review; it exists so the tests can
  be executed and verified. It must compile and pass your own tests. Omit
  for design categories.
- `interviewerPacket` — a Markdown document with exactly these sections:
  - `## Capability Tested` — which charter capabilities this question
    surfaces, and how.
  - `## Staff-Level Answer` — what a credible Staff answer looks like: the
    approach, the invariants they'd name, the trade-offs they'd call out.
  - `## Skeptical Follow-ups` — exactly 2 probing follow-up questions an
    interviewer would ask to separate rehearsed answers from real depth.
  - `## Common Weak Answers` — the typical strong-Senior-but-not-Staff
    responses and where they fall short.
  - `## Scoring Rubric (1–5)` — one line per score 1–5 stating what that
    score looks like for THIS question.

Never include a `solutionCode` field. The candidate's starter file is built
from `signature` alone.

### Description Sections

For **coding** categories, `description` must contain, in order:
`## Problem Statement` (the product scenario and the ask), `## Signature`
(the signature in a code block), `## Examples` (at least 3 worked
input/output cases), `## Constraints` (explicit rules, limits, and required
edge-case behavior), `## Hints` (2–3 nudges, gentle → nearly prescriptive).

For **design** categories, `description` must contain, in order:
`## Problem Statement` (realistic product context with concrete numbers),
`## Requirements` (functional and non-functional, with real targets),
`## Scope` (Focus On / Out of Scope), `## Evaluation Criteria` (what a
strong answer covers).

## Test Authoring Core (coding categories)

- Write 6–12 tests: happy path, each promised edge-case class, error
  handling, and lifecycle/cleanup where the category demands it.
- **Hand-trace every expected value.** Execute your `referenceSolution`
  line-by-line against each test input before writing the expectation, and
  add a short derivation comment to every non-obvious expected value showing
  how it was computed. Never guess an expected value.
- Every test must fail against the unimplemented starter stub. A test that
  passes with no implementation (e.g. asserting on an empty render, or only
  that a function exists) is vacuous — do not write it.
- Respect the import allowlist in the Environment & Test Contract exactly.
- Tests must be deterministic: no real network, no real timers where fake
  timers are prescribed, no order dependence between tests.

## Example of the Expected Quality

For coding categories this is a model test file; for design categories it is
a model evaluation-criteria block. Match its rigor:

{{example}}

## Repair Mode

If the user message contains a `## Verification Failure Report`, you are
repairing your previous output, included in that message:

- The problem statement (description) is the source of truth; change it only
  if the report proves it self-contradictory.
- Fix the minimum needed to make the tests pass against the reference
  solution and still fail against the stub. Keep `title` and `slug` exactly
  as they were.
- Re-check every expected value you touch by hand-tracing again.
- Return the same complete JSON object shape (all fields, not just the
  changed ones).

## Self-Check Before You Answer

1. Is the scenario production-flavored and framed in a believable product
   context, rather than a textbook rehash or trivia outside the target role?
2. Would a strong Senior finish this well under the suggested time — and
   would only a credible Staff engineer nail the constraints, edge cases,
   and trade-offs? If it is comfortably solvable without surfacing
   Staff-level signal, raise the bar before answering.
3. (Coding categories) Does every expected test value have a derivation you
   actually traced?
4. (Coding categories) Does the signature match the Environment & Test
   Contract shape exactly?
5. (Coding categories) Does the reference solution satisfy every single test
   you wrote?
6. Does the interviewer packet contain all five required sections?
