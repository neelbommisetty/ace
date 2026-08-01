{{charter}}

---

# Task: Draft the Problem — {{category-name}} (`{{category-slug}}`)

You are drafting the problem statement for ONE interview question in the
category described below, at the difficulty and topic given in the user
message. You are the FIRST author in a chain: separate stages then write the
reference solution, the test file, and the interviewer packet from nothing but
what you return here. Anything you leave implicit is lost. Everything you
produce must serve the charter above: realistic production-flavored scenarios
framed in believable product contexts, hard enough to separate a strong
Senior from a credible Staff engineer.

## Category Identity

{{identity}}

## Difficulty Calibration

{{difficulty-calibration}}

## Environment & Test Contract

The later stages must obey this contract exactly — your `signature` and the
behavior your description promises have to be expressible inside it:

{{environment}}

## Edge-Case Classes to Draw From

Use these canonical edge-case families for this category when designing the
problem's constraints. The test author will hold your description to them, so
state in `## Constraints` every behavior you want covered:

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
- `estimatedMinutes` — ONLY for coding categories: the whole number of
  minutes a strong candidate at the target level needs to read the
  problem, implement a solution, and pass the tests. Any honest value from
  10 to 60 is valid — a 10- or 25-minute question is fine when that is
  what the scope actually takes. Target the per-difficulty minutes given in
  the Difficulty Calibration section above, not a fixed number; 60 is a hard
  cap regardless of that target — if your honest estimate exceeds 60,
  SHRINK the question and re-estimate rather than reporting a number over
  the cap. Omit (return `null`) for design and behavioral categories.
- `competency` — ONLY for behavioral categories: exactly one value from the
  closed competency vocabulary in the Category Identity above (e.g.
  `conflict`, `ambiguity`, `failure`, `influence-without-authority`,
  `prioritisation`, `mentorship`, `receiving-feedback`, `ownership`) —
  lowercase, hyphenated, verbatim from that list, never invented. Omit
  (return `null`) for coding and design categories.

Do not write the reference solution, the test file, or the interviewer packet
here — those are later stages, and this response has no field for them.

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
see that category's Environment & Test Contract for the full rule. The test
author may query NOTHING that is not declared there, so the contract must be
exhaustive for the behavior you promise.

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

## Self-Check Before You Answer

1. Is the scenario production-flavored and framed in a believable product
   context, rather than a textbook rehash or trivia outside the target role?
2. Would a strong Senior finish in the intended time — for coding
   categories, the `estimatedMinutes` you reported, against the
   per-difficulty target in the Difficulty Calibration section above (60
   absolute max); for design and behavioral, the difficulty calibration
   above — and would only a credible Staff engineer nail the constraints,
   edge cases, and trade-offs? If it is comfortably solvable without
   surfacing Staff-level signal, raise the bar before answering.
3. (Coding categories) Does the signature match the Environment & Test
   Contract shape exactly, and does the description's `## Signature` section
   carry the same text?
4. (Coding categories) Is every behavior you want tested actually STATED in
   `## Constraints` or `## Examples`? A candidate who never opens the test
   file must be able to satisfy the suite from this description alone — the
   test author writes only what you promised here.
5. (Coding categories) Is `estimatedMinutes` an honest whole-number
   estimate you actually derived — 10 to 60, never padded to hit the top of
   its band, never left above the 60 cap — and `null` only for
   design/behavioral?
6. (`react-apps`, `web-components`) Does `## UI Contract` list every
   string, role, and label the promised behavior needs — including
   loading, error, and empty states?
7. (Behavioral categories) Is `description` a single interviewer-voiced
   prompt with no section headings, never a multi-part scenario? Does
   `competency` match exactly one value from the closed vocabulary, and does
   the difficulty reflect discomfort (a success story vs an owned failure),
   not scope?
