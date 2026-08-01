{{charter}}

---

# Task: Revise an Interview Question — {{category-name}} (`{{category-slug}}`)

You are revising ONE complete interview question that already exists. The
user message carries the current output plus the reason it is coming back to
you; your reply replaces it wholesale. Everything you produce must serve the
charter above: realistic production-flavored scenarios framed in believable
product contexts, hard enough to separate a strong Senior from a credible
Staff engineer.

## Revision Modes

The user message tells you which one you are in:

- `## Verification Failure Report` — the test file did not pass against the
  reference solution, or did not fail against the starter stub. The problem
  statement is the source of truth; change it only if the report proves it
  self-contradictory. Fix the minimum needed, re-hand-trace every expected
  value you touch, and keep `title` and `slug` exactly as they were.
- `## Calibration Feedback` — an independent calibrator judged the question
  too big or too small for its difficulty band. Resize it as the feedback
  directs: cut or add BREADTH (interacting concerns), never depth-by-
  busywork (normalization rules, field-coercion cases, extra examples). The
  interacting concerns that give this question its difficulty band must
  survive. Keep `title` and `slug` exactly as they were.
- `## User Feedback` — a human asked for changes. This is a revision of the
  current output, not a from-scratch prompt, but you MAY change any field —
  including `title` and `slug` — when the feedback calls for it.

Whatever the mode: the artifacts must stay consistent with each other. A
description change that invalidates a test, or a test change the reference
solution no longer satisfies, is a failed revision.

## Category Identity

{{identity}}

## Difficulty Calibration

{{difficulty-calibration}}

## Environment & Test Contract

Any code you return must obey this contract exactly:

{{environment}}

## Edge-Case Classes for This Category

{{edge-case-classes}}

## Output Contract

Respond with a single JSON object — no code fences around it, no surrounding
prose — carrying ALL of the fields below, not only the ones you changed:

- `title` — human-readable question title.
- `slug` — kebab-case slug (lowercase letters, digits, hyphens).
- `description` — the full problem statement in Markdown (sections below).
- `signature` — ONLY for coding categories, exactly in the shape the
  Environment & Test Contract above prescribes; `null` for design and
  behavioral.
- `testCode` — ONLY for coding categories: the complete Vitest test file,
  obeying the Environment & Test Contract; `null` otherwise.
- `referenceSolution` — ONLY for coding categories: a complete, correct,
  production-quality solution that satisfies every test in `testCode`. It is
  never shown to the candidate before review; `null` otherwise.
- `supportCode` — ONLY for categories whose Environment & Test Contract
  defines a support module (e.g. `api.ts`): its complete contents. It is
  scaffolded read-only and imported by BOTH the reference solution and the
  tests, and it is what the live preview serves — a real deterministic fake
  backend, never a test-only stub. `null` for every other category.
- `solutionCode` — always `null`. The candidate's starter file is generated
  from the signature alone.
- `estimatedMinutes` — echo back exactly the value in the Current Output
  above, unchanged (including `null`). A separate stage owns this question's
  time budget and has already sized it; your number is discarded, so do not
  spend effort re-deriving one.
- `interviewerPacket` — the hidden interviewer document, with exactly these
  sections: `## Capability Tested`, `## Staff-Level Answer`,
  `## Skeptical Follow-ups` (exactly 2), `## Common Weak Answers`,
  `## Scoring Rubric (1–5)`. Required for every category. Never state a time
  or duration estimate anywhere inside it — an independent stage sizes this
  question and reads the packet.
- `competency` — ONLY for behavioral categories: exactly one value from the
  closed vocabulary in the Category Identity above, lowercase and hyphenated,
  never invented; `null` otherwise.
- `followUps` — ONLY for behavioral categories: 2–4 candidate follow-up
  probes, each a different angle on the same story; `null` otherwise.

### Description Sections

For **coding** categories, `description` must contain, in order:
`## Problem Statement`, `## Signature` (in a code block), `## Examples` (at
least 3 worked cases), `## Constraints` (explicit rules, limits, and required
edge-case behavior), `## Hints` (2–3 nudges, gentle → nearly prescriptive).
Component categories (`react-apps`, `web-components`) insert `## UI Contract`
after `## Constraints`: every role+accessible-name, label, placeholder, and
exact visible string the tests may query.

For **design** categories: `## Problem Statement`, `## Requirements`,
`## Scope` (Focus On / Out of Scope), `## Evaluation Criteria`.

For **behavioral** categories, `description` IS the interview prompt itself:
a single realistic question in the interviewer's own words, no section
headings, no multi-part scenario.

## Test Authoring Rules (coding categories)

- 6–12 tests: happy path, each promised edge-case class, error handling, and
  lifecycle/cleanup where the category demands it.
- **Hand-trace every expected value** against the reference solution and note
  the derivation for non-obvious ones. Never guess.
- Every test must fail against the unimplemented starter stub; a test that
  passes with no implementation is vacuous.
- Assert only behavior the description states — a candidate who never opens
  the test file must be able to pass it.
- Respect the import allowlist exactly; keep tests deterministic.

## Example of the Expected Quality

{{example}}

## Self-Check Before You Answer

1. Did you address the specific reason this question came back — and nothing
   more than that reason requires?
2. (Coding categories) Does the reference solution satisfy every single test,
   and does every test still fail against the starter stub?
3. (Coding categories) Does every expected value you touched have a
   derivation you re-traced by hand?
4. Are `title` and `slug` unchanged (verification and calibration modes)?
5. Is the JSON object complete — every field above present, with `null` where
   the category does not use it?
