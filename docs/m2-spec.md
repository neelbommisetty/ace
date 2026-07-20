# ACE next — M2 "The Corpus" build spec

M2 makes every dollar spent on LLM review a permanent, searchable asset: versioned
reviews streamed into the Room, a History browser, dispute-as-diff, fresh-attempt
instead of destructive reset, Settings, and content-addressed snapshots.

Read `docs/m1-spec.md` first for conventions (auth, SSE, file scope, style). The
M2 contracts (rows, SSE events, AceDb methods) are already in `cli/server/types.ts`
— implement against them exactly. M1 code is committed and working; extend, don't
rewrite.

## File ownership (parallel build — stay inside your area)

- **data-layer**: `cli/server/migrations.ts` (append migration 2), `cli/server/db.ts`
  (new methods + FTS), new `cli/server/blobs.ts`, plus `cli/server/db.test.ts`
  (append) and new `cli/server/history-search.test.ts`, `cli/server/blobs.test.ts`.
- **features**: new `cli/server/reviews.ts`, `cli/server/disputes.ts`,
  `cli/server/settings.ts`; edit `cli/server/app.ts` (new routes + snapshot-on-write)
  and `cli/server/index.ts` (wire new deps); new `cli/server/review-parse.test.ts`.
- **spa**: `ui/src/**` only.

Shared pre-existing code you may READ for patterns but not modify:
`cli/commands/feedback.ts` + `cli/commands/dispute.ts` (how prompts are assembled),
`cli/lib/llm.ts` (already has `chatStream`, `chatObject(zod)`, `getDefaultProvider`,
`validateOpenAIKey/validateAnthropicKey`, `clearConfigCache`, `isMockLlm` — NEVER
call `requireProvider` from server code: it process.exit()s),
`cli/lib/config.ts` (`loadAceConfig`, `saveGlobalAceConfig`, `maskApiKey`),
`cli/lib/scaffold.ts` (`getStubContent`), `cli/lib/import-meta.ts` (asset dir
resolution used to find `cli/prompts/**` in dev and `dist/prompts/**` when built).

## Data layer

**Migration 2** (append to MIGRATIONS; runner already applies pending ones):
- `ALTER TABLE reviews ADD COLUMN score REAL;`
- `ALTER TABLE reviews ADD COLUMN snapshot_hash TEXT;`
- `disputes` table: id PK, question_id REF, attempt_id, test_run_id, at, argument,
  verdict, summary, details_md, fixed_test_code, test_rel_path, hint, applied_at
  (+ index question_id).
- `snapshots` table: id PK, question_id REF, attempt_id, rel_path, hash, at,
  trigger (+ index (question_id, rel_path, at)).

**FTS** is NOT a numbered migration (node:sqlite builds without FTS5 must not
brick the db): at openDb, try `CREATE VIRTUAL TABLE IF NOT EXISTS reviews_fts
USING fts5(review_id UNINDEXED, body_md)`; on throw set `ftsAvailable=false`.
Sync: insert into reviews_fts inside createReview when available; at boot, if
`count(reviews) != count(reviews_fts)` rebuild the FTS table from reviews.
`searchHistory`: with q + FTS → `SELECT review_id FROM reviews_fts WHERE
reviews_fts MATCH ?` (escape the user string: wrap each term in double quotes);
fallback → `body_md LIKE '%q%' COLLATE NOCASE`. Disputes match on
summary/details_md via LIKE in both modes. Merge reviews + disputes newest-first,
join their questions, apply category/type filters, default limit 100.

**blobs.ts**: `saveBlob(root, content): string` writes `.ace/blobs/<sha1>` (skip
if exists; mkdir -p; write tmp + rename for atomicity), returns hash;
`readBlob(root, hash): string | null` (validate hash is /^[0-9a-f]{40}$/ before
path use). Reuse `sha1` from files.ts.

## Server features

**reviews.ts** — `createReviewEngine({ db, bus, workspaceRoot })` returning
`{ start(question, attemptId): { jobId }, dispose() }`:
- One in-flight review per question; starting another while one runs → 409 at the
  route (do NOT supersede — reviews cost money).
- kind = `isDesignCategory(category) ? 'design' : 'code'`.
- Guards (400 at route with clear message): design → notes.md must have meaningful
  content (a non-blank line that isn't a heading or HTML comment); code → primary
  solution file must exist and differ from `getStubContent(...)` (compare
  trimmed) — do NOT reject on a '// TODO' substring anywhere (that legacy gate
  rejected real solutions).
- Provider: `getDefaultProvider()`; null → 503 `{ error: 'no LLM API key
  configured — add one in Settings' }`.
- Prompt: system = `cli/prompts/review/<group>.md` (group via `getPromptGroup`),
  user message = README + all solution files (+ test files for code), mirroring
  cli/commands/feedback.ts's assembly. Before calling: snapshot the primary
  solution file (saveBlob + db.addSnapshot trigger 'review') and keep the hash.
- Stream via `chatStream`; emit `review-started`, then `review-chunk` per token
  batch (coalesce with ~50ms flushes so SSE isn't per-token), accumulate full
  text. On completion parse and persist (exported pure fns, unit-tested in
  review-parse.test.ts):
  - `parseReviewScore(body)`: /overall[^0-9]{0,20}(\d(?:\.\d)?)\s*\/\s*5/i → number|null.
  - `parseReviewVerdict(body)`: first match of Strong Hire|Lean Hire|No Hire|Hire
    (longest-first) → string|null.
  - `parseReviewDimensions(body)`: lines matching /(Requirements|Architecture|API|
    Data Model|Deep Dive|Trade-offs|Communication)[^0-9]{0,30}([1-5])\s*\/\s*5/i →
    record (design only), null when none.
  Then `db.createReview({... model: provider's model string, snapshotHash})`, emit
  `review-done`. On stream error: persist NOTHING, emit `review-error` (the partial
  text travels via chunks; the client shows it with the error banner). Log nothing
  to stdout.
- Mock mode (`ACE_E2E_MOCK_LLM=1`): works end to end via llm.ts's built-in mocks
  (`ACE_MOCK_LLM_MODE=feedback` yields 'Overall 4/5 …').

**disputes.ts** — `startDispute({ db, bus, workspaceRoot, question, run, argument })`:
- Preconditions at route: run belongs to question, status 'done', failed > 0,
  category has test files. One in-flight per question → 409.
- zod schema mirroring cli/prompts/test-dispute.md's contract: verdict enum,
  summary, details, failingTests[] (testName, verdict, explanation,
  fixedAssertion?), fixedTestCode?, hint? — call `chatObject`, prompt assembled
  like cli/commands/dispute.ts (README + solution + test file + failing output
  from run.results/stderr + the user's argument appended as an extra user
  message when present).
- Persist via db.createDispute (details_md = details + a '### Per-test' section
  rendered from failingTests). Emit dispute-started/done/error. Mock mode:
  `ACE_MOCK_LLM_MODE=dispute` returns a valid payload.
- Apply route: verdict must be test_incorrect|ambiguous and fixedTestCode
  non-null and applied_at null → snapshot current test file (trigger
  'dispute-apply'), `writeWorkspaceFile` the fixed code (echo suppression
  included), `db.markDisputeApplied`, return the dispute. The client then
  triggers a normal test run.

**settings.ts** — pure helpers over cli/lib/config.ts + llm.ts:
- `getSettingsInfo(): SettingsInfo` (maskApiKey for masked values; mockMode via isMockLlm()).
- `updateSettings({ openaiKey?, anthropicKey?, defaultProvider? })`: validate any
  NEW key first (validateOpenAIKey/validateAnthropicKey) — invalid → throw with
  the validation error, save NOTHING; then saveGlobalAceConfig + clearConfigCache.
  Keys are write-only: never return a full key to the client.

**app.ts additions** (features agent):
| Method & path | Behavior |
|---|---|
| POST `/api/questions/:c/:s/reviews` | body `{}`; guards above; → `{ jobId }` (202) |
| GET `/api/questions/:c/:s/reviews` | `ReviewRow[]` newest first |
| GET `/api/reviews/:id` | `ReviewRow` + `{ snapshotContent }` when blob exists |
| POST `/api/test-runs/:runId/disputes` | `{ argument? }` → `{ disputeJobId }` (202) |
| GET `/api/questions/:c/:s/disputes` | `DisputeRow[]` |
| POST `/api/disputes/:id/apply` | apply flow above → `{ dispute }` |
| POST `/api/attempts/:id/fresh` | `{ resetToStub: boolean }` → end attempt ('abandoned'), snapshot each solution file (trigger 'reset'), optionally write stubs via getStubContent, create + return new attempt (with `reveal` event) |
| GET `/api/history?q=&category=&type=&limit=` | `{ items: HistoryItem[] }` |
| GET `/api/settings` | `SettingsInfo` |
| PUT `/api/settings` | body above → updated `SettingsInfo`; validation failure → 400 `{ error }` |
| PUT `/api/file` | ADD: after write, if hash differs from latest snapshot for that relPath, saveBlob + addSnapshot (trigger 'save', attemptId = active attempt if any) |

index.ts: construct engines, pass to createApp, dispose on close.

## SPA

- **Room — AI panel** (right side, collapsible, replaces the M1 placeholder):
  "Request review" button (disabled while running, with cost-honest tooltip
  'runs an LLM review — needs an API key in Settings'). Streamed markdown renders
  live (react-markdown; auto-scroll). On review-done: pinned **review card** at
  panel top — verdict badge (colored: Strong Hire/Hire green tones, Lean Hire
  amber, No Hire red) or score badge 'N/5', dimension mini-bars when present,
  expandable full body, version count ('v3 · view history →' links to History
  filtered to this question). Past reviews listed below (version, date, badge).
  503/no-key → inline notice linking to Settings. review-error → amber banner,
  partial text preserved.
- **Dispute**: kebab on a failing test row → modal: optional argument textarea →
  'Analyze' → progress → verdict banner + summary + details; when fixedTestCode
  present: Monaco **DiffEditor** (original readOnly left, fixed right) + Apply /
  Reject. Apply → POST apply → close modal → trigger manual test run. All
  disputes for the question appear in the Activity tab.
- **/history**: rail icon activates. Screen: search input (debounced), category
  select, type filter pills (All / Reviews / Disputes); reverse-chron cards —
  review cards show question title, version, badge, first improvement lines;
  dispute cards show verdict + summary + applied state. Card click → detail:
  reviews get a **version picker** (two dropdowns, side-by-side markdown
  render + collapsible 'code as reviewed' from snapshotContent); disputes get
  details + diff (read-only). URL params for filters (?q=&category=&type=&question=).
- **/settings**: rail icon activates. Provider cards (OpenAI / Anthropic): masked
  current key ('...abcd'), password input to replace, Save validates server-side
  (show per-provider spinner + green check / inline error), default-provider
  select, mock-mode banner when SettingsInfo.mockMode. Never render full keys.
- **Fresh attempt**: Room topbar '↺ New attempt' → dialog: 'Start attempt #N?'
  radio: keep current code / reset files to stub; body notes 'Your current code
  is snapshotted; previous attempts and reviews are kept.' → POST fresh →
  reload room state (new attempt, refreshed files).
- Library rows: add a reviews count + latest badge column (data available from
  /api/questions? — it is NOT; fetch lazily per row is wasteful: SKIP unless the
  data-layer agent's listQuestions already returns it — do not change server
  contracts from the SPA side).

## Verification

- Unit: `npx vitest run cli/server/...` for your new tests; whole suite must stay green.
- features agent: integration-smoke your routes with tsx + a temp workspace and
  `ACE_E2E_MOCK_LLM=1 ACE_MOCK_LLM_MODE=feedback|dispute` (mock mode makes review
  and dispute flows fully offline). Never call real providers in tests.
- spa agent: `npx tsc --noEmit -p ui/tsconfig.json` + `npm run build:ui` clean.
