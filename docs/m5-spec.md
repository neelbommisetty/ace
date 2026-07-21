# ACE next — M5 "The Gauntlet" build spec

M5 ships the full mock-interview capability: timed sessions with real-round
structure, auto-graded debriefs whose every criticism links to the exact
moment it happened, the Tape scrubber over the snapshots M2 has been quietly
recording, and the dashboard — landing exactly when there's finally enough
data to chart.

Prereqs: M1–M4. The Tape builds on `snapshots` + `attempt_events` + blobs;
debrief citations build on M3's chat + M2's reviews.

## Data model (migration 5)

- `sessions`: id PK, template_name, config_json (rounds, dials), state,
  created_at, started_at NULL, ended_at NULL, overall_summary_md NULL.
- `session_rounds`: id PK, session_id REF, ordinal, question_id NULL (filled
  when the round's question is picked/generated), attempt_id NULL, config_json
  (category pool, difficulty, minutes, timer `soft`|`hard`, interviewer on/off,
  delivery `readme`|`verbal-first`, hints `free`|`counted`|`off`), state,
  started_at, submitted_at, planned_seconds, overtime_seconds INT DEFAULT 0,
  paused_seconds INT DEFAULT 0, review_id NULL.
- `attempt_events` gains types (types.ts union extension, no schema change):
  `round_start`, `time_warning`, `hard_stop`, `overtime_start`, `submit`.
- Session templates as data, not code: `cli/server/session-templates.ts`
  (Frontend Loop, Algo Screen, Design Deep-Dive) + custom configs persisted in
  config_json; a "save as template" writes to `<workspace>/.ace/templates.json`.

## Server

**session engine (`cli/server/sessions.ts`)** — a persisted state machine;
every transition writes the row + an event, so refresh/crash resumes exactly:

```
draft → briefing(n) → round_active(n) ⇄ round_paused(n) → round_submitted(n)
      → (briefing n+1 | wrapup) → debrief_pending → debrief_ready → archived
abandoned reachable from any live state (kept, visible — abandonment is signal)
```

- **Clock semantics (the sleep problem, solved explicitly):** the round clock
  is driven by the client's active-time heartbeats (same mechanism as the M1
  timer) reconciled server-side against a monotonic baseline. A wall-clock gap
  > 30s with no heartbeats is recorded as an implicit pause (`paused_seconds`),
  never as elapsed round time — a closed lid can't produce a "9-hour round" or
  silently eat the countdown. Explicit pause is allowed but visibly counted in
  the debrief ("interviews don't have pause").
- Transitions: START reveals the question (logs `reveal` — reading time is
  measured from here); T-15/T-10/T-5 emit `time_warning` events AND interviewer
  chat messages when the round has the interviewer on; at 0:00 `hard` locks
  writes for the round's files (server rejects PUT /api/file for them with 423
  until submitted; Monaco flips readOnly via SSE) and auto-submits with
  buffers flushed; `soft` starts the overtime counter. SUBMIT ends the round's
  attempt (`submitted`), snapshots every file (`round_end` trigger — add to
  SnapshotTrigger), and starts background grading.
- **Question sourcing per round:** `library-unattempted` (server picks,
  title hidden until reveal) or `generate-fresh` — the generation job runs
  during the briefing screen so the paid 30–60s call never eats the clock;
  briefing waits with visible progress only if not ready.
- **Verbal-first delivery** (realism dial): the interviewer states the problem
  in chat; `GET /api/questions/:c/:s` withholds `readme` for that attempt
  until the candidate has sent ≥1 clarifying message or 3 minutes pass
  (server-enforced, event-logged either way).
- **Grading:** on wrapup, request a formal review per round (M2 engine, one at
  a time to respect per-question locks), including the interviewer transcript;
  failures retryable per round without losing others. Between rounds the break
  screen shows what's next but **withholds all scores** until the final
  debrief. Debrief assembly: per round — tests-at-bell (last run ≤ submitted_at)
  vs final, time-split bars (reading = reveal→first_edit, coding, debugging =
  time after first failing run, from events), rubric card, hints used,
  overtime/paused, and **citations**: strengths/improvements parsed from the
  review each carry the nearest supporting event/moment id when the reviewer
  names one (prompt addition: "when citing a moment, reference the provided
  event timeline by index") — every citation deep-links into the Tape.
  Footer: overall roll-up + deltas vs the last session of the same template.

**tape (`cli/server/tape.ts`)**
- `GET /api/tape/:attemptId` → the timeline: merged, time-ordered events
  (attempt_events + test_runs + snapshots + chat messages), plus
  **stuck intervals** computed server-side: gaps > 8 minutes with a failing
  latest run and no snapshots. `GET /api/tape/:attemptId/at?ts=` → the
  reconstructed file contents at that moment (latest snapshot ≤ ts per file,
  from blobs) + the run/chat state then. Restore endpoint:
  `POST /api/tape/restore { attemptId, relPath, hash }` → writes that blob
  content to the file (normal write path: snapshot + echo suppression).

**dashboard (`cli/server/stats.ts`)**
- `GET /api/stats` → tiles (attempts/wk with delta, green rate, median
  time-to-green, hints per solve) + series: time-to-green rolling median per
  category, weekly verdict distribution, dimension averages (current 5 vs
  previous 5), hint economy. All SQL over existing tables; `imported=1`
  attempts and `source='import'` reviews are **excluded from every trend**
  (they carry approximate timestamps) and only counted in lifetime totals.

## SPA

- **/sessions**: list + `New session` builder (template cards, per-round
  config, realism dials, estimated LLM cost for grading shown before start).
  Live session shell: briefing interstitial (Coach's Notes card from M4,
  "press Enter to reveal — the clock starts then"), full-screen room with the
  rail hidden, countdown top-center (white → amber at 20% → red at 5%),
  pause blurs problem + code (pausing to think off-clock is pointless), break
  screens with no scores, wrap-up progress ("grading round 2…" streaming).
- **Debrief (`/sessions/:id/debrief`)**: permanent URL, per the approved
  mockup — verdict chips per round, rubric bars with ghost markers vs your
  previous attempt at the same question/template, time-allocation bar,
  improvements with `→ 18:40` citation links into the Tape, session footer
  comparison + one "next session suggestion" (from M4 guidance).
- **The Tape (`/tape/:attemptId`)**: horizontal timeline — phase bands, save
  ticks, red/green run dots, chat/hint flags, stuck-interval brackets with the
  callout ("14 min on the off-by-one — the moment it clicked →"); drag the
  scrubber → Monaco ghost view (read-only, Esc back to live) + that moment's
  test results; per-file "Restore this version" / copy. Every debrief citation
  and History review card links here.
- **/dashboard**: rail icon activates. Stat tiles + the four charts from the
  approved design (time-to-green lines, verdict stacked bars, dimension
  trend, hint economy), gated: < 5 completed attempts renders "collecting
  signal" instead of fake trends. Chart palette per the design system
  (validated categorical slots; direct labels + legend).

## Verification

Unit: state-machine transition table (every legal/illegal transition),
clock reconciliation (heartbeat gaps → paused_seconds, never elapsed),
stuck-interval detection, tests-at-bell selection, stats SQL against a fixture
db (imported rows excluded), citation-index parser. Integration smoke (mock
LLM): full 2-round session — briefing → hard-stop auto-submit → break (no
scores leaked in payloads) → debrief with per-round reviews + citations;
tape reconstruction returns the exact blob content for three scrub points;
423 on writes after hard stop. Timer chaos test: replay a heartbeat gap and
assert the round clock excluded it. SPA: tsc + build.

## Out of scope

Curveball injection mid-round (post-M5 polish), audio/voice, multi-user
anything, session sharing/export (a debrief-to-markdown export is a nice
post-M5 follow-up), component live-preview pane (tracked separately as the
v1.1 candidate from the design's risk register).

## Risks to respect

- The state machine is the product here: no transition may bypass persistence,
  and the client NEVER computes authoritative time — it renders what the
  server says and contributes heartbeats.
- Hard-stop file locking must fail safe: on server crash mid-round, boot
  reconciliation releases all locks (locks live in memory keyed by round
  state, never on disk).
- Grading a whole loop is the most expensive single click in the app — the
  builder shows the estimate up front, and per-round retry never re-bills
  completed rounds.
- The Tape must degrade gracefully for pre-M2 attempts (no snapshots): show
  events-only timelines rather than an empty screen.
