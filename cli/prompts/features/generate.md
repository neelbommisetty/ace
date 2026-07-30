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
  Environment & Test Contract above prescribes. Omit (return `null`) for
  design and behavioral categories.
- `testCode` — ONLY for coding categories: the complete Vitest test file,
  obeying the Environment & Test Contract. Omit (return `null`) for design
  and behavioral categories.
- `referenceSolution` — ONLY for coding categories: a complete, correct,
  production-quality solution file that satisfies every test you wrote. This
  is never shown to the candidate before review; it exists so the tests can
  be executed and verified. It must compile and pass your own tests. Omit
  (return `null`) for design and behavioral categories.
- `supportCode` — ONLY for categories whose Environment & Test Contract
  defines a support module (e.g. `api.ts`): the complete contents of that
  module. It is scaffolded as a read-only file and imported by BOTH the
  reference solution and the tests — and it is what the live preview
  serves, so it must be a real deterministic fake backend, never a
  test-only stub. Omit (return `null`) for every other category.
- `estimatedMinutes` — ONLY for coding categories: the whole number of
  minutes a strong candidate at the target level needs to read the
  problem, implement a solution, and pass the tests. Any honest value from
  10 to 60 is valid — a 10- or 25-minute question is fine when that is
  what the scope actually takes. A full-size question is expected to land
  around 45; 60 is a hard cap — if your honest estimate exceeds 60, SHRINK
  the question and re-estimate rather than reporting a number over the
  cap. Omit (return `null`) for design and behavioral categories.
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
  Required for every category, including behavioral.
- `competency` — ONLY for behavioral categories: exactly one value from the
  closed competency vocabulary in the Category Identity above (e.g.
  `conflict`, `ambiguity`, `failure`, `influence-without-authority`,
  `prioritisation`, `mentorship`, `receiving-feedback`, `ownership`) —
  lowercase, hyphenated, verbatim from that list, never invented. Omit
  (return `null`) for coding and design categories.
- `followUps` — ONLY for behavioral categories: an array of 2–4 candidate
  follow-up probe questions an interviewer could ask once the candidate has
  answered, each drawn from a DIFFERENT angle on the same story (dig into a
  vague claim, ask what the other side would say, ask what they'd do
  differently at scale). These are never shown to the candidate up front —
  they exist for a later drill-down. Omit (return `null`) for coding and
  design categories.

Never include a `solutionCode` field. The candidate's starter file is built
from `signature` alone.

### Description Sections

For **coding** categories, `description` must contain, in order:
`## Problem Statement` (the product scenario and the ask), `## Signature`
(the signature in a code block), `## Examples` (at least 3 worked
input/output cases), `## Constraints` (explicit rules, limits, and required
edge-case behavior), `## Hints` (2–3 nudges, gentle → nearly prescriptive).
Component categories (`react-apps`, `web-components`) insert one more
section after `## Constraints` and before `## Hints`: `## UI Contract` —
every role+accessible-name, label, placeholder, and exact visible string
(loading/error/empty states included) that the tests are allowed to query;
see that category's Environment & Test Contract for the full rule.

For **design** categories, `description` must contain, in order:
`## Problem Statement` (realistic product context with concrete numbers),
`## Requirements` (functional and non-functional, with real targets),
`## Scope` (Focus On / Out of Scope), `## Evaluation Criteria` (what a
strong answer covers).

For **behavioral** categories, `description` IS the interview prompt
itself: a single realistic question in the interviewer's own words,
optionally followed by one or two sentences of framing for what kind of
story is wanted. No section headings, no multi-part scenario — a long
`description` here is itself a quality defect. See the Environment & Test
Contract above for the full contract.

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
2. Would a strong Senior finish in the intended time — for coding
   categories, the `estimatedMinutes` you reported (~45 for a full-size
   question, 60 absolute max); for design and behavioral, the difficulty
   calibration above — and would only a credible Staff engineer nail the
   constraints, edge cases, and trade-offs? If it is comfortably solvable
   without surfacing Staff-level signal, raise the bar before answering.
3. (Coding categories) Does every expected test value have a derivation you
   actually traced?
4. (Coding categories) Does the signature match the Environment & Test
   Contract shape exactly?
5. (Coding categories) Does the reference solution satisfy every single test
   you wrote?
6. (Coding categories) Is `estimatedMinutes` an honest whole-number
   estimate you actually derived — 10 to 60, never padded to hit 45, never
   left above the 60 cap — and `null` only for design/behavioral?
7. (`react-apps`, `web-components`) Does every string/role/label the tests
   query appear verbatim in the description's `## UI Contract`?
8. Does the interviewer packet contain all five required sections?
9. (Behavioral categories) Is `description` a single interviewer-voiced
   prompt with no section headings — never a multi-part scenario? Does
   `competency` match exactly one value from the closed vocabulary, and does
   the difficulty reflect discomfort (a success story vs an owned failure),
   not scope? Does each of `followUps` probe a genuinely different angle,
   not a rewording of the same question?
