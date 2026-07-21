# ACE next — M4 "The Loop Closes" build spec

M4 is the killer feature from the approved design: the Mistake Ledger. Every
paid review is mined into atomic, tagged insights that surface at the three
moments that change behavior — before you code (pre-flight), after you improve
(retirement), and when you ask "what should I practice?" (guidance). The app
starts telling you things about yourself.

Prereqs: M1–M3 shipped. Conventions carry over; contracts land in
`cli/server/types.ts` first.

## Data model (migration 4)

- `insights`: id PK, review_id REF, question_id REF, category, tag (canonical
  slug, e.g. `missing-effect-cleanup`), excerpt (the sentence from the review
  that earned it), at, status (`open` | `retired`), retired_at NULL,
  occurrence_count INT DEFAULT 1 (bumped when a later review re-confirms the
  same tag+category instead of inserting a duplicate row), last_seen_at.
  Indexes: (category, status), review_id.
- Tag taxonomy as versioned assets: `cli/prompts/insights/taxonomy-<family>.md`
  (families: js-ts, react, leetcode, design) — ~30–40 curated tags each with a
  one-line definition, plus a `freeform:` escape hatch the extractor may use
  when nothing fits (freeform tags are slugified and marked `curated=0`).

## Server

**extraction engine (`cli/server/insights.ts`)**
- Triggered after every `review-done` (user reviews only, not imports): one
  cheap-model `chatObject` call — input: review body + the category's
  taxonomy; output (zod): `Array<{ tag, curated, excerpt, confidence }>`,
  capped at 5 per review. Recorded in `llm_usage` with purpose `extract`.
- Merge semantics: same tag + category with an `open` insight → bump
  occurrence_count + last_seen_at + append the new excerpt (keep the latest 3
  excerpts in a JSON column or child rows — pick one, document it); otherwise
  insert. Extraction failure is logged and silently skipped — never blocks the
  review flow, retriable via `POST /api/reviews/:id/extract`.
- **Retirement:** after extraction, for each open insight in the review's
  category NOT re-confirmed by this review, bump a `clean_streak` counter;
  at 2 consecutive clean reviews → status `retired`, retired_at set. A
  recurrence resets the streak and re-opens a retired insight (status back to
  `open`, occurrence_count bumped) — regressions are visible, not silent.
- SSE: `insights-changed { questionId, category }` after any mutation.

**guidance (`cli/server/coach.ts`)**
- `getPracticeNext(db): PracticeNextItem[]` — up to 3 recommendations, each
  with a machine-readable reason:
  `{ question | generateSeed, reason: { kind: 'open-insight' | 'stale-category' | 'never-attempted', detail } }`.
  Ranking: open-insight density per category (weighted by occurrence_count and
  recency), then category staleness (days since last attempt), then untouched
  library questions. Deterministic, no LLM call.
- Routes: `GET /api/coach` → `{ resume, practiceNext, activity: { weeks:
  perDay attempt counts for 12 weeks }, weekStats, monthSpendUsd }`;
  `GET /api/insights?category=&status=` ; `POST /api/insights/:id/acknowledge`
  (dismiss from pre-flight without retiring); `GET /api/questions/:c/:s/insights`
  → the pre-flight set (top 3 open, ranked, for that category).

## SPA

- **Coach home (`/`)** replaces the bare Library as the landing screen (the
  Library moves to `/library`; the rail gains its icon). Layout per the
  approved mockup: Resume card ("3/7 passing · 22m active · resume →"),
  three Practice Next cards each stating its reason ("2 of your last 3 reviews
  flagged listeners without cleanup"), 12-week activity heatmap strip, week
  stats line (attempts / green / reviews / streak) + month spend. Empty state:
  "Generate your first question" + import offer.
- **Coach's Notes** tab in every room (the badge from the mockups): the top 3
  open insights for the category with their excerpts, each linking to the
  source review in History; an acknowledge (✕) per card. Shown BEFORE code is
  written — the pre-flight briefing. In session briefings later (M5) the same
  component renders on the briefing screen.
- **Weakness heatmap** on `/history` (a "Weaknesses" tab): category × tag
  matrix, cell intensity = occurrence_count over the last 20 reviews; retired
  tags render as faded green "fixed ✓" cells; every cell clicks through to the
  filtered excerpts. Review cards in History wear a "Fixed: <tag> ✓" ribbon
  when they completed a retirement streak.
- **Brainstorm seed**: the "Something I'm weak at" starter (from M3's
  brainstorm empty state) now pre-seeds the chat with the user's top open
  tags — the loop closes even in generation.

## Verification

Unit: merge/retire/reopen state machine (including streak reset on
recurrence), ranking determinism for getPracticeNext (fixture db), taxonomy
parsing, extractor zod schema against mock output (`ACE_MOCK_LLM_MODE=extract`
added to llm.ts mocks). Integration smoke: review → extraction → insight →
appears in `GET .../insights` → second clean review → third clean review →
retired → heatmap reflects it. SPA: tsc + build; Coach empty states with a
fresh workspace.

## Out of scope

Insight extraction from interviewer chats (only formal reviews mine insights
in M4); spaced-repetition scheduling (explicitly deprioritized by Neel);
cross-workspace aggregation.

## Risks to respect

- Tag sprawl makes the heatmap useless: cap freeform tags per review (1),
  slugify aggressively, and surface curated ones first.
- Retirement must never feel like data loss — retired insights stay queryable
  and re-openable; the UI celebrates ("Fixed ✓"), never deletes.
- Extraction is a paid call per review: cheap model, capped output, and the
  monthly spend tile keeps it honest.
