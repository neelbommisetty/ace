# ACE next — M3 "The Interviewer" build spec

M3 turns the two scariest CLI flows into the two best screens: a conversational
interviewer that reads what you write, a hint ladder that's honest about being
used, and a generate/brainstorm UI where paid output can never be lost.

Prereqs: M1 (`docs/m1-spec.md`) and M2 (`docs/m2-spec.md`) conventions carry
over — contracts land in `cli/server/types.ts` first, snake_case only inside
db.ts, engines never write to stdout and never call `requireProvider`, mock
mode (`ACE_E2E_MOCK_LLM`) must cover every new flow end to end.

## Data model (migration 3)

- `chat_threads`: id PK, question_id REF NULL (brainstorm threads have none),
  attempt_id NULL, mode (`interviewer` | `hints` | `brainstorm`), created_at,
  closed_at NULL. Index question_id.
- `chat_messages`: id PK, thread_id REF, at, role (`user` | `assistant`),
  content_md, truncated INT (partial from a crashed stream), flagged INT
  ("this gave the answer away"), meta_json (hint rung, notes hash, usage).
  Index (thread_id, at).
- `generation_jobs`: id PK, at, params_json (category/difficulty/topic/
  brainstorm thread id), state (`running` | `parse_failed` | `draft` |
  `accepted` | `discarded`), raw_response_text (ALWAYS saved before parsing),
  draft_json NULL, error NULL, question_id NULL (set on accept).
- `llm_usage`: id PK, at, purpose (`review` | `interviewer` | `hint` |
  `brainstorm` | `generate` | `dispute` | `extract`), question_id NULL, model,
  input_tokens, output_tokens, cost_usd (computed from a static per-model
  price table; approximate is fine, missing model → NULL).

Config additions (`~/.ace/config.json`, managed via Settings): `model_chat`
and `model_heavy` task overrides (default: chat tasks use the cheaper model
tier, generate/review use the default provider model). `cli/lib/llm.ts` gains
usage reporting: `chatStream`/`chatObject` return/expose the provider usage so
engines can record `llm_usage` (AI SDK exposes `usage` on results).

## Server

**chat engine (`cli/server/chat.ts`)** — generalizes the review engine's
streaming pattern:
- `startTurn({ thread, userText })`: persist the user message immediately, then
  stream the assistant reply (SSE `chat-started`/`chat-chunk`/`chat-done`
  keyed by threadId), committing the assistant message on completion; a
  crashed stream persists the partial with `truncated=1`. One in-flight turn
  per thread (409), 120s idle watchdog, salvage-free (messages are cheap;
  partials are persisted).
- Context assembly per mode:
  - `interviewer` (design rooms first-class, coding rooms in sessions later):
    system prompt from `cli/prompts/interviewer/<group>.md` (new assets: the
    question, the review rubric, persona guidance: Socratic, gives constraints
    never solutions, probes thin sections). Between turns the server diffs
    notes.md (store the last-sent content hash in meta_json; send only changed
    sections) so writing *is* talking to the interviewer.
  - `hints`: not free text — POST a rung (`nudge` | `approach` |
    `walkthrough`); prompt enforces the ceiling (nudge: one sentence, no code;
    approach: pattern only; walkthrough: pseudocode). Records `hint` attempt
    event + increments attempts.hints_used. Context: README + current buffer +
    last run results.
  - `brainstorm`: system prompt `cli/prompts/question-brainstorm.md` (existing
    asset). The reply may contain fenced ```candidate blocks (JSON: title,
    pitch, category, difficulty, topic) — parsed server-side on message commit
    into meta_json.candidates so the SPA renders cards without re-parsing.
- Turn guardrails: DELETE last assistant message + regenerate
  (`POST /api/chat/threads/:id/regenerate` — replaces the message row, old row
  kept with flagged=1 semantics), and `POST .../messages/:id/flag` for "gave
  it away" (stored; used to tune prompts later).

**generation engine (`cli/server/generate.ts`)** — port of the CLI generate
with the M2 safety patterns:
- `startJob(params)`: create `generation_jobs` row (running), 202 `{ jobId }`,
  stream progress over SSE (`gen-started`/`gen-chunk`/`gen-done`/`gen-failed`).
  Raw text saved to the row BEFORE parsing; parse failure → state
  `parse_failed` (never loses the paid call).
- `repairJob(id)`: cheap-model reformat pass over the saved raw text →
  re-parse → `draft` or stays `parse_failed`.
- `acceptJob(id, { slug })`: live slug-collision check (400 with suggestion),
  scaffold via `cli/lib/scaffold.ts`, upsert question row, capture 'scaffold'
  snapshots for every written file (reuse M2's baseline capture), state
  `accepted`. `discardJob(id)`.
- Similar-questions endpoint: `GET /api/questions/similar?topic=` — fuzzy
  title/slug match over the library (simple trigram/substring scoring, no LLM).

**Routes** (all token-authed, JSON):
`POST/GET /api/chat/threads` (create with mode+questionId / list, filterable),
`GET /api/chat/threads/:id` (messages), `POST .../messages` (user turn),
`POST .../hint` `{ rung }`, `POST .../regenerate`, `POST .../messages/:id/flag`,
`POST /api/generate` → job, `GET /api/generate/jobs?limit=`,
`POST /api/generate/jobs/:id/(repair|accept|discard)`,
`GET /api/usage/summary?month=` → `{ totalUsd, byPurpose }`.

## SPA

- **Design room** completes the approved mockup: left outline rail — the 7
  skeleton sections parsed from notes.md headings, fill state (○/◐/●) by
  per-section word count, click scrolls the editor; center notes.md Monaco
  with a ⌘P toggleable preview that renders markdown **including mermaid
  fences** (`mermaid` npm package, bundled like monaco — no CDN); right pane
  is the interviewer thread (open by default in design rooms), with a
  focus selector (Balanced / Scaling / API design / Trade-offs) that maps to a
  system-prompt suffix. "Request formal review" stays in the panel; the review
  prompt now appends the interviewer transcript so the rubric can score
  communication under questioning.
- **Coding room**: AI panel gains a Hints tab — three rung buttons with the
  ceiling explained, responses render inline, used rungs show as spent (and in
  the debrief later). Interviewer tab hidden outside sessions (M5).
- **Chat UX**: message stream renders live; regenerate + "flag: gave it away"
  actions on assistant messages; threads survive refresh and resume from the
  Activity tab.
- **/generate**: two tabs. *Direct*: category cards, difficulty, topic; a live
  "similar existing questions" strip under the topic field (each match links
  to its room); submit → job screen with streamed progress; parse failure →
  Repair screen (raw text left, extracted-so-far right; Retry parse / Ask
  model to reformat / Discard). Draft screen: rendered README + read-only
  Monaco of tests + editable slug with live collision check → Accept scaffolds
  and deep-links to the room. *Brainstorm*: persistent thread; candidate cards
  render from meta_json.candidates with pre-filled category/difficulty chips
  (click-to-edit) and one "Generate this" button each — no magic words, and
  quitting loses nothing. Jobs rail on the right lists recent jobs/drafts;
  a topbar chip shows running jobs app-wide.
- **Settings**: per-task model pickers (chat vs heavy) + a monthly spend line
  (from `/api/usage/summary`).

## Prompts (new assets under `cli/prompts/interviewer/`)

`design.md`, `coding.md`, plus `_persona.md` shared preamble. Contract in the
prompt: never produce full solutions; answer clarifications with constraints;
one probing question at a time; when the candidate's notes changed, react to
the diff, not the whole document. Add 3–5 golden transcript fixtures under
`cli/prompts/interviewer/golden/` and a unit test that asserts the prompt
assembly includes rubric + notes-diff correctly (no LLM calls in tests).

## Verification

Mock mode: extend `getMockResponse()` with `interviewer`, `hint`, `brainstorm`
(brainstorm mock includes one ```candidate block) and `generate` already
exists. Unit-test: candidate-block parser, notes-diff computation, hint-rung
prompt selection, generation state machine transitions (running→parse_failed→
draft→accepted), similar-questions scoring. Integration smoke (tsx + temp
workspace + mock): full brainstorm→candidate→job→draft→accept→room chain;
interviewer turn with notes diff; hint rung recorded on attempt; usage rows
written. SPA: tsc + build clean.

## Out of scope for M3

Session-mode interviewer behavior (persona strictness, time warnings,
verbal-first delivery) — M5. Insight extraction from chats — M4. Voice, and
any interviewer-initiated curveballs — later.

## Risks to respect

- Interviewer quality is the product: ship regenerate/flag from day one, keep
  personas in versioned prompt files, default chat turns to the cheap model.
- The notes-diff loop must never echo-loop: interviewer turns read notes.md
  but never write workspace files.
- mermaid bundling adds weight to an already monaco-heavy bundle — lazy-load
  the mermaid chunk on first preview toggle.
