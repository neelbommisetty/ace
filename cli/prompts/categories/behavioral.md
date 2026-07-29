# Category Capsule: Behavioral (`behavioral`)

<!-- NEE-342 skeleton: every section below carries honest first-draft prose,
     not a placeholder. NEE-343 (generation) owns sections 1-6 (Identity
     through Example Directions); NEE-344 (review) owns Review Dimensions
     and Signals. Both may rewrite their sections independently — the
     headings themselves are the seam and must not move. -->

## Identity

This category probes leadership and collaboration signals that code and
system-design questions cannot reach: how a candidate handles conflict,
ambiguity, failure, and influence without formal authority. It draws on the
charter's "Influence without authority" and "Direction changes on evidence"
capabilities, but the evidence is a real story from the candidate's own work,
not a hypothetical or a general philosophy.

A great behavioral question asks for exactly ONE concrete story that surfaces
a specific competency — a disagreement with a peer that had to be resolved
without escalating, a project that failed where the candidate owned real
responsibility, a decision the candidate reversed once new evidence arrived.
The question itself is short: literally the sentence an interviewer would say
out loud. The interviewer's job here is to ask, listen, and press with
follow-ups — not to construct an elaborate scenario the way a coding or
design prompt does.

Every question targets exactly one competency from this closed vocabulary
(`shared/competencies.ts` — the `competency` output field must be one of
these values, verbatim, lowercase, hyphenated):

- `conflict` — disagreement with a peer, manager, or another team, resolved
  without escalating past the candidate's own authority.
- `ambiguity` — a call made with incomplete requirements or information, and
  how the candidate resolved (not avoided) the uncertainty.
- `failure` — a project, decision, or delivery the candidate owned that went
  wrong, and what they did about it.
- `influence-without-authority` — getting another person or team to change
  course without having formal authority over them.
- `prioritisation` — a real trade-off under a deadline or resource
  constraint, and what got cut and why.
- `mentorship` — developing another engineer's skill or judgment, including
  when it didn't go smoothly.
- `receiving-feedback` — critical feedback the candidate received and what
  they did with it afterward, not feedback they gave.
- `ownership` — going beyond the letter of the candidate's role to see a
  problem through, distinct from `failure` (no bad outcome required here).

## Difficulty Calibration

Suggested times: easy 5 min, medium 8 min, hard 10 min.

Difficulty here does not mean bigger scope — it means **discomfort**: how
exposing the story is to tell honestly.

- **easy (5 min)**: a story with a clean, largely positive outcome (a
  disagreement resolved through data, a deadline hit through good
  prioritization). The discomfort is low; the candidate mainly needs to
  structure the story well and be specific.
- **medium (8 min)**: a story with a messier or partial outcome (a
  compromise that satisfied nobody fully, a mentee who improved more slowly
  than hoped). The candidate has to be honest about a mixed result and their
  own contribution to it, not just narrate a win.
- **hard (10 min)**: a story of genuine failure or fault the candidate owns
  (a call that hurt the team, a conflict mishandled the first time around).
  The discomfort is highest because it demands unflattering honesty instead
  of a rehearsed win — a success story dressed up as a failure story fails
  this bar immediately.

## Environment & Test Contract

This is a prose exercise, not a coding exercise:

- The candidate writes their story as prose in a single `story.md` file,
  under STAR headings (Situation / Task / Action / Result / Reflection).
  There is NO solution file beyond it and NO test file.
- Generation must NOT emit `signature`, `testCode`, or `referenceSolution`
  fields — omit them entirely from the output JSON, exactly as design
  categories do.
- The `description` (the README body) IS the interview prompt itself: a
  single realistic behavioral question in the interviewer's own words (e.g.
  "Tell me about a time you disagreed with a technical decision and had to
  push back on it"), optionally followed by one or two sentences of framing
  for what kind of story the interviewer wants — never a multi-section spec.
  Behavioral prompts are short by nature; a long `description` is itself a
  quality defect.
- The edge-audit feature runs as a critique of the PROMPT, not a test audit:
  it checks that the question is answerable from real work experience (not a
  trick question, not double-barreled), that it targets one clear
  competency, and that it isn't a thinly-veiled duplicate of a stock
  "tell me about a time" prompt.
- Generation MUST emit `competency`: exactly one value from the closed
  vocabulary above, chosen to match the prompt. If the user message lists
  existing behavioral questions already in the workspace, `competency` must
  be distinct from every one listed — do not repeat a competency that's
  already covered.
- Generation MUST emit `followUps`: an array of 2–4 candidate drill-down
  probes an interviewer could ask once the candidate has answered, each from
  a genuinely different angle (e.g. push on a vague claim, ask what the
  other party would say, ask how the approach would change at 10x scale).
  These are never shown to the candidate before they write their story —
  they are stored in a hidden probe bank for a later follow-up round, so
  write them as real, specific questions, not generic prompts like "tell me
  more."

## Example Strong vs Weak Answer

This is the quality bar for judging a candidate's story — shown here against
the prompt "Tell me about a time you had to influence a decision without
formal authority over the people involved." Note what separates the two,
section by section:

**Strong**: Situation names a real system and a real stalemate ("our
platform team wanted to standardize on GraphQL; my team's two most senior
engineers were quietly building around it with REST"). Task is explicit
ownership ("I didn't own the platform decision, but I owned my team's
migration cost if it went the wrong way"). Action is concrete and
first-person ("I set up a working session with the two engineers and the
platform lead, brought a one-page comparison against our actual query
patterns, and proposed a two-week spike instead of arguing in the
abstract"). Result carries a number or a decision ("the spike surfaced a
real N+1 problem in the GraphQL resolver; the platform team adjusted the
schema before rollout, and we adopted it two sprints later with no
rework"). Reflection is specific ("I'd run the spike before the meeting
next time — it would have saved a week of debate").

**Weak**: Situation is vague ("there was a disagreement about architecture
on my team"). Task and Action conflate "I" with "we" throughout. Action is
generic ("I talked to people and we came to an agreement"). Result is
unmeasured ("it worked out well"). Reflection is absent or generic
self-praise ("I'm good at bringing people together"). The interviewer
cannot verify anything or picture the actual sequence of events.

## Edge-Case Classes

The failure modes edge-audit should catch in a freshly generated prompt:

- **Double-barreled prompts**: asking about two competencies at once ("tell
  me about a conflict AND a time you failed") — split into one prompt per
  competency.
- **Leading prompts**: phrasing that hints at the "right" answer or a
  specific outcome, coaching the candidate toward what to say.
- **Unanswerable from typical experience**: a prompt that assumes a scale or
  authority level (e.g. "a company-wide reorg you led") the target candidate
  profile is unlikely to have actually held.
- **Stock-prompt duplication**: a bare synonym of a well-known interview
  cliché ("tell me about your greatest weakness") with no framing to make it
  concrete or distinct.
- **Competency mismatch**: a prompt whose surface wording (e.g. "a time you
  led a project") doesn't actually probe the competency it's filed under.

## Review Dimensions

Keep these exact names (they key historical score comparisons):

- **Structure**: 5 = a real Situation/Task/Action/Result arc with each part
  proportionate (Situation brief, Action detailed) and nothing skipped;
  3 = the shape is there but one section is thin or the sections blur
  together; 1 = a rambling narrative with no discernible structure.
- **Specificity**: 5 = named systems, real numbers, and concrete
  dates/timeframes throughout; 3 = mostly concrete with a few vague
  stretches; 1 = generic enough to have happened to anyone, anywhere.
- **Ownership**: 5 = crisp "I" statements that distinguish the candidate's
  individual contribution from the team's; 3 = mostly "I" but slips into
  "we" at the load-bearing moments; 1 = the candidate's individual role in
  the outcome is never clear.
- **Impact**: 5 = a measured outcome (a number, a shipped decision, a
  stated consequence); 3 = a real but unquantified outcome ("the team
  adopted the new process"); 1 = "it went well" with nothing to verify.
- **Reflection**: 5 = a specific, credible "what I'd do differently" that
  shows real judgment, without over-apologizing; 3 = a generic lesson
  ("communication is important"); 1 = no reflection, or reflection that
  re-praises the same action instead of examining it.

## Signals

**Quote, don't summarize, when marking something vague.** When a claim is
generic ("it went well", "we worked together to fix it"), pull the
candidate's own sentence into your feedback rather than describing the
vagueness in the abstract — the story is short, so this is cheap, and a
quoted line is what turns "be more specific" into something the candidate
can actually see and fix, instead of generic advice they've heard before.

**Length discipline is part of the score, not a bonus for thoroughness.** A
real answer to a behavioral question runs two to four minutes spoken aloud.
If the written story would take eight minutes or more to say out loud, that
is a Structure finding on its own — padding through repeated context,
hedging, or re-explaining the same point does not earn extra credit, and a
long answer that never gets to a Result is worse than a short one that does.

**If a `## Follow-ups` section is present**, the candidate answered probe
questions after the initial write-up — weigh whether those answers added
real substance (a name, a number, an admission, a detail that changes the
picture) or simply restated the original story in different words; a
candidate who dodges a direct follow-up with more generalities should score
lower on Specificity and Ownership than the initial story alone suggested. A
`## Follow-ups` section is absent on most stories — say nothing about it
when it isn't there.

Positive (Staff-level):

- Answers a question the interviewer didn't fully ask because the candidate
  anticipated the natural follow-up.
- Names the counterargument or the other side's reasonable position before
  explaining why their own path won out.
- Owns a real mistake or a real cost, without spiraling into excessive
  self-criticism or deflecting blame onto others.
- Ties the story back to a broader principle now applied elsewhere, rather
  than treating it as a one-off anecdote.

Red flags:

- Every pronoun is "we" — the candidate's own decisions and actions are
  never isolated from the team's.
- The story resolves too cleanly for its stated difficulty — a "failure"
  story with no real cost, or a "conflict" story where the other side simply
  agreed once shown the data.
- Vague temporal markers ("around that time", "eventually") standing in for
  a real sequence of events.
- A rehearsed, over-polished cadence that reads as memorized rather than
  recalled — worth probing with a specific follow-up.

## Example Directions

- **A disagreement with a peer engineer over a technical approach** that had
  to be resolved without escalating to a manager — `conflict`, with a side
  of `influence-without-authority` if the resolution required winning the
  peer over rather than a manager's ruling.
- **A project or feature that shipped late or was scrapped**, where the
  candidate had real responsibility for the outcome — `failure`.
- **Requirements that changed or were ambiguous mid-project**, forcing a
  call without complete information — `ambiguity`.
- **Receiving critical feedback that stung**, and what the candidate did
  with it afterward — `receiving-feedback`.
- **Prioritizing under a hard deadline** when not everything could get
  done — `prioritisation`.
- **Helping a struggling teammate or junior engineer improve**, including a
  case where the first attempt at mentoring didn't land — `mentorship`.
