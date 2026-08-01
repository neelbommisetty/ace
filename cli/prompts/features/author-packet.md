{{charter}}

---

# Task: Author the Interviewer Packet — {{category-name}} (`{{category-slug}}`)

The user message carries a finished `{{question-type}}` question — its
problem statement and, for coding categories, the reference solution and the
test file. Your job is the hidden interviewer packet: the document the
interviewer reads to run and grade this question. It is never shown to the
candidate before their work is reviewed, so it may name the answer freely.

## Category Identity

{{identity}}

## Signals to Grade Against

{{signals}}

## Output Contract

Respond with a single JSON object — no code fences around it, no surrounding
prose. Fields:

- `interviewerPacket` — a Markdown document with exactly these sections, in
  order:
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
- `followUps` — ONLY for behavioral categories: an array of 2–4 candidate
  follow-up probe questions an interviewer could ask once the candidate has
  answered, each drawn from a DIFFERENT angle on the same story (dig into a
  vague claim, ask what the other side would say, ask what they'd do
  differently at scale). These are never shown to the candidate up front —
  they exist for a later drill-down. Omit (return `null`) for coding and
  design categories.

**Never state a time estimate anywhere in the packet.** No "should take ~20
minutes", no "budget 10 minutes for the edge cases", no per-section minute
splits. An independent stage sizes this question from the problem and the
code alone, and it reads the packet: a number here contaminates that
judgment. Describe scope in work, not in minutes.

## Self-Check Before You Answer

1. Are all five packet sections present, in order, and specific to THIS
   question rather than generic interviewing advice?
2. Does `## Staff-Level Answer` name the actual invariants and trade-offs
   this problem forces, at the depth the charter's bar demands?
3. Do the rubric's five lines describe genuinely different answers, so two
   adjacent scores are distinguishable?
4. Does the packet contain NO time or duration estimate of any kind?
5. (Behavioral categories) Does each `followUps` entry probe a genuinely
   different angle, not a rewording of the same question?
