# ACE next — M7 "Behavioral interviews" build spec

Behavioral rounds are half of every real loop and ace has no surface for them.
M7 adds `behavioral` as a third question type next to `coding` and `design`:
a prose answer with no test harness, STAR-aware generation and review, an
interviewer-style drill-down on what you wrote, and seed questions that work
with no API key.

Prereqs: M1–M3.6 conventions carry over — contracts land in
`shared/wire-types.ts` (re-exported by `cli/server/types.ts` and
`ui/src/types.ts`, never hand-copied), snake_case only inside `db.ts`, engines
never write to stdout and never call `requireProvider`, mock mode
(`ACE_E2E_MOCK_LLM`) must cover every new flow end to end, migrations are
append-only and versioned by array index.

## The one idea

The codebase branches on a **coding-vs-design binary** in exactly six places.
M7's whole risk is that widening a two-value union to three values produces
**zero TypeScript errors** — every existing branch is a boolean predicate or a
ternary, so a missed site silently takes the coding path.

So the foundation ticket does not "add a third case". It converts the binary
into a **discriminant with compile-time tripwires**:

- `QuestionType` widens to `'coding' | 'design' | 'behavioral'` and becomes THE
  discriminant.
- Every three-way *value* (a prompt section name, a step label, a skip reason,
  a review kind) becomes a `Record<QuestionType, X>` map — the only construct
  in this codebase that makes the compiler shout when the union widens. There
  are currently **zero** such maps, which is precisely why widening is silent
  today.
- Every three-way *behaviour* reads one of exactly two named capabilities off
  `CategoryConfig`, not the category slug.

### The capability predicates (and why only two)

```ts
export function hasTests(config: CategoryConfig): boolean {
  return config.testFiles.length > 0;
}

export function isProseAnswer(config: CategoryConfig): boolean {
  return config.solutionFiles.length > 0 && config.solutionFiles.every((f) => f.endsWith('.md'));
}
```

`hasTests` is not invented — `disputes.ts` already literally reads
`config.testFiles.length === 0`, and `gen-verify.ts` already fails closed on
it. Five tempting extra capabilities are deliberately **pruned** because they
collapse to `hasTests` with no divergent call site: `sandboxVerifiable`,
`supportsDispute`, `supportsAutoRun`, `hasReferenceSolution` (a hidden
reference solution exists precisely when there is a suite to verify it
against), and `reviewKind` (duplicates `type`). `supportsFormatOnSave` has no
category dimension at all — `useTestRuns.ts` decides it by file extension,
deliberately.

`isDesignCategory` was **removed** — the tripwire Records (`REVIEW_KIND`,
`EXAMPLE_SECTION`, `AUDIT_LABEL`, `VERIFY_SKIP_REASON`) subsumed its one
remaining use, and the `designSubType` chain in `reviews.ts` never called it.

The SPA needs none of this. It already derives `hasTests` from the wire file
list (`useFileBuffers.ts`: `editorFiles.some(f => f.kind === 'test')`) and
contains zero hardcoded category slugs in production code. **Do not add a
category check to any component.**

---

## Feature 1 — The `behavioral` question type (NEE-342)

The foundation. Owns every shared file; nothing else may run in parallel with
it.

### Category table (`shared/categories.ts`)

```ts
behavioral: {
  slug: 'behavioral',
  name: 'Behavioral',
  shortName: 'Behavioral',
  hint: 'Conflict, failure, influence, ownership — your real stories',
  type: 'behavioral',
  group: 'behavioral',
  suggestedTimes: { easy: 5, medium: 8, hard: 10 },  // all three required
  solutionFiles: ['story.md'],
  testFiles: [],
  templateDir: 'behavioral',
}
```

Suggested times are deliberately unlike design's 25–60: a behavioral answer is
a two-minute story, and the number is the discipline. All three difficulties
must be present or `NewQuestion.tsx` renders `easy — ~ min`.

`CategoryGroup` gains `'behavioral'`. (Audit finding: `group` is currently read
by **nothing** outside the table — it is carried for future grouping only.)

### Tasks

1. **Pure refactor, no new category** — all existing tests stay green.
   - Add `hasTests` / `isProseAnswer` to `shared/categories.ts`.
   - Swap them in at `disputes.ts:46`, `gen-pipeline.ts` (verify skip),
     `scaffold.ts:132` (`.reference.md` guard), `routes/questions.ts:34`
     (`name === 'notes.md'` → `isProseAnswer(config)`), `reviews.ts:133`.
   - **Delete** the design arm of `scaffold.ts:87-92`. The generic
     solutionFiles/testFiles loop already produces byte-identical output:
     design declares `templateDir: 'design'` + `solutionFiles: ['notes.md']`
     and `cli/templates/design/notes.md.hbs` is the exact file the hardcoded
     path joins.
   - Unify `reviews.ts:134` and `:183` onto `config.solutionFiles[0]`, dropping
     both hardcoded `'notes.md'` literals.
2. **Widen the union without adding the entry.** Widen `QuestionType` and
   `CategoryGroup`, introduce the four `Record<QuestionType, X>` maps
   (`EXAMPLE_SECTION` in prompt-builder, `AUDIT_LABEL` + `VERIFY_SKIP_REASON`
   in gen-pipeline, `REVIEW_KIND` in reviews), convert `buildReviewMessages` to
   an exhaustive `switch` with a `never` default, widen
   `SseEventMap['review-started'].kind`. TypeScript now enumerates every
   unhandled behavioral case.
   - **Byte-for-byte constraint:** the `'coding'` and `'design'` entries must
     hold the existing strings verbatim. `'not applicable to design questions'`
     is asserted literally in `gen-pipeline.test.ts`; the design audit user
     message and the three `reviews.ts` guard messages are asserted too.
     Generic rewording is the likely accidental violation.
3. **Template** `cli/templates/behavioral/story.md.hbs` — STAR headings
   (Situation / Task / Action / Result / Reflection) plus a one-line
   restatement of the prompt at the top. No build change needed;
   `scripts/postbuild.js` copies `cli/templates` recursively.
4. **Capsule skeleton** `cli/prompts/categories/behavioral.md` with **all**
   required `## ` sections present (Identity, Difficulty Calibration,
   Environment & Test Contract, the EXAMPLE_SECTION heading, Edge-Case Classes,
   Review Dimensions, Signals, Example Directions) carrying honest placeholder
   prose. NEE-343 rewrites the generation sections, NEE-344 the review ones —
   this split is the seam that lets them run in parallel.
5. **Fix `starter-pack.test.ts`** to assert against `hasTests` rather than
   `isDesignCategory`. Must land here, not in NEE-347, or the behavioral seed
   trips two assertions it has nothing to do with.
6. **Last commit: add the CATEGORIES entry.** Everything CATEGORY_SLUGS-derived
   widens at this instant — the generation route allowlist, brainstorm's zod
   enum and its prose mirror, the three SPA pickers, the reconciler's
   known-category gate, and prompt-builder's test matrix (3×8 → 3×9).

### The single highest-risk ordering mistake

`buildBrainstormPrompt()` eagerly requires `Identity`, `Difficulty
Calibration` and `Example Directions` from **every** slug on **every** turn,
and rebuilds per turn. Landing the CATEGORIES entry before
`cli/prompts/categories/behavioral.md` exists takes brainstorm down completely,
at runtime, with a thrown error. Hence step 6 after step 4.

### Tests

- `scaffold.test.ts` — behavioral writes exactly `['README.md', 'story.md']`
  and never `.reference.md` even when `referenceSolutionMd` is supplied.
- `scaffold.test.ts` — `getStubContent('behavioral', 'story.md')` is
  **non-empty**. Not optional: a missing template returns `''` silently, which
  becomes the workspace-reset baseline and the reset-to-stub content, i.e. a
  user's story gets blanked on reset with no error anywhere.
- `app-questions.test.ts` — `story.md` arrives as kind `'notes'`, zero test
  files.
- `reconciler.test.ts` — `questions/behavioral/<slug>` upserts rather than
  landing in `skippedDirs`.
- `gen-verify.test.ts` — pin the "no solution/test files to verify" throw for a
  `testFiles: []` category (the fail-loud backstop).
- `useFileBuffers.test.ts` — a no-test file set yields `hasTests === false`.
  Currently covered by nothing.

---

## Feature 2 — Behavioral generation (NEE-343)

### Where the probes live — a deliberate deviation

The ticket's acceptance reads "a README.md with the prompt, the competency, and
stored follow-up probes". We store the **competency in the README** (visible —
it is useful framing, not a spoiler) and the **probes in a hidden
`.probes.md`** dotfile beside `.interviewer.md`.

Reason: NEE-345's entire premise is that the drill-down is a drill-down. Probes
printed in the README are read before the answer is written, which is the one
thing that makes them worthless. Dotfiles are invisible to the watcher,
reconciler, UI file list and vitest by construction — the same trick
`.interviewer.md` already uses. Probes are **not** sourced from
`.interviewer.md`: that file is in `SPOILER_KEYS` and debrief-gated, and
splitting it would punch a hole in the masking chokepoint.

### Tasks

1. **`shared/competencies.ts`** — the closed vocabulary
   (`conflict`, `ambiguity`, `failure`, `influence-without-authority`,
   `prioritisation`, `mentorship`, …) plus `normalizeCompetency(raw)`.
   Lands here because generation needs it regardless, and it is what makes a
   later coverage view a pure addition rather than a rework. `shared/` must not
   import `cli/` or `ui/`.
2. **Capsule** `cli/prompts/categories/behavioral.md` sections 1–6: a question
   in the interviewer's own words, the competency it probes, what a strong vs
   weak answer sounds like. **Difficulty means discomfort here** — a success
   story vs a failure you owned — not technical depth. Say it in the prompt.
3. **Pipeline branch generalised**: `if (design)` becomes `if (!hasTests(config))`.
   Edge-audit still runs (it is a critique of a text artifact — it should catch
   prompts that are leading, unanswerable, or a thinly-veiled duplicate).
   Sandbox verify/repair is skipped via `VERIFY_SKIP_REASON`.
4. **Schema**: `competency` and `followUps` on `GeneratedQuestionSchema`. Both
   `.nullable()`, never `.nullish()` (NEE-263: OpenAI strict structured output
   requires `required` to list every property). This is a four-file change that
   fails in three different places if incomplete:
   - classify each new key into `WIRE_SAFE_KEYS.generate` or `SPOILER_KEYS` in
     `spoilers.ts` — `spoilers.test.ts` asserts an exact partition;
   - it flows automatically into ai-log's `STEP_SCHEMA_KEYS` via
     `Object.keys(shape)`;
   - `getGenerateMockPayload` must be updated **in the same commit** or mock
     mode silently falls through to a different candidate payload (the mock
     dispatcher picks by which payload `safeParse`s).
5. **Scaffold**: thread `followUps` through `ScaffoldOptions`, write
   `.probes.md` next to `.interviewer.md`.
6. **Corpus dedupe**: feed existing behavioral titles **and competencies** from
   `db.listQuestions()` into the generate user message and require a distinct
   competency. Note: no dedupe exists anywhere today — slug suffixing silently
   accepts duplicates. Behavioral prompts collapse into each other far faster
   than coding ones.
7. **Activity Log**: no phantom verify stage for a no-test category.

### Acceptance check that needs a real run

"Generating five in a row produces five distinct competencies" is only provable
against a live provider. Verify with the closed vocabulary + corpus feed in the
prompt, and pin the mechanism (existing competencies reach the user message)
with a unit test.

---

## Feature 3 — STAR review rubric (NEE-344)

The prompt system is already fully category-capsule-driven: `review.md` pulls
`{{review-dimensions}}` and `{{signals}}` straight out of
`cli/prompts/categories/<slug>.md`. **The rubric is therefore authored, not
branched** — `review.md` needs no behavioral arm.

### Tasks

1. **`reviews.ts` behavioral arm** in `buildReviewMessages` (now an exhaustive
   switch): `buildQuestionSection(readme)` + `## Candidate's Story` from
   `config.solutionFiles[0]`. The competency rides along inside the README, so
   no extra plumbing.
2. **Guard**: the `isProseAnswer` branch reuses `hasMeaningfulNotes`, which
   already does exactly what the ticket asks — it discounts any line that is a
   `#` heading or an `<!--` comment, so a `story.md` holding only the STAR
   headings is rejected with "write your story before requesting a review".
3. **Capsule `## Review Dimensions`**: structure (a real S/T/A/R, not three
   minutes of context and no result), specificity (named systems, numbers,
   dates), ownership (what *you* did vs what the team did), impact (a measured
   outcome, not "it went well"), reflection (what you'd do differently, without
   self-flagellation).
4. **Capsule `## Signals`**: quote the candidate's own sentences when marking
   something vague — cheap, because the answer is short, and it is what makes
   the feedback actionable. Length discipline is a finding: an answer that
   would take eight minutes to say out loud costs a band.

### Do not touch

`ReviewExtractionSchema`'s verdict `z.enum` and `VERDICT_RE`. A behavioral
rubric emitting a different verdict vocabulary yields `verdict = null` and a
neutral badge. Keep the hire-scale verdicts and 1–5 dimensions; `ReviewBadge`
and the dimension bars then need zero changes, and historical score comparison
keys stay stable.

### Proving "byte-for-byte unaffected"

Snapshot assertions on the `code` and `design` arms of `buildReviewMessages`,
plus a behavioral fixture in `review-parse.test.ts`.

---

## Feature 4 — Follow-up probes (NEE-345)

### Mechanism decision

**A bounded probe engine that is a structural clone of the dispute engine — not
of the brainstorm chat engine.**

The repo already contains the right precedent, and it is not brainstorm.
`disputes.ts` is a bounded, non-conversational, question-scoped engine: one
paid structured call → a persisted row → an apply step that snapshots the
target file and writes it through `writeWorkspaceFile`. NEE-345 is that shape
with a different payload.

Brainstorm is the wrong precedent on three independent axes: its sessions are
workspace-global with no question FK, its schema and prompt are
idea-generation-specific, and its only UI is the app's one chat composer — the
exact artifact the acceptance criterion forbids duplicating. A "mode" flag
inside the brainstorm engine *is* the divergent second implementation; it just
hides the fork inside one file.

The decisive detail is **where the exchange lives**. Because
`buildReviewMessages`' behavioral arm reads `config.solutionFiles[0]` in full,
putting probe questions and answers into `story.md` means "the final review
scores the full exchange" requires **no** review-engine change, no new prompt
branch, no new wire shape — and the review snapshot captures the exchange too,
so History's as-reviewed view works unchanged.

That same choice is what stops this becoming a chat: answers are typed in the
existing Monaco editor, inheriting autosave, conflict detection and save
snapshots. No composer, no turn list, no message history, no chunk SSE event.
There is nothing to converge with NEE-155/156 later — only a prompt and a row.
When the M4 interviewer chat lands, the probe prompt becomes its behavioral
persona seed.

Bounding is structural, not disciplinary: `.min(2).max(4)` in the zod schema,
one probe set per attempt (409 otherwise), a single `mid`-tier call, a 120 s
abort, and deliberately no streaming surface to grow into.

### Tasks

1. **Migration 8** — `probe_sets(id PK, question_id NOT NULL REFERENCES
   questions(id), attempt_id, at, probes_json, model, applied_at)` **plus an
   explicit index on `question_id`**. (Migration 7 exists only because that
   index was forgotten on `reviews`. Do not repeat it.) Never edit an existing
   migration entry — the version is the array index.
2. **DB + types** — `rowToProbeSet`, `createProbeSet`, `getProbeSet`,
   `listProbeSets(questionId)`, `markProbeSetApplied`, each memoized in
   `stmtCache`; mirrored into the `AceDb` interface. Add `'probe-append'` to
   `SnapshotTrigger`.
3. **Wire** — `Probe { question, source: 'bank' | 'derived' }`, `ProbeSetRow`;
   `'probe'` added to `AiRunKind` and `LLMPurpose`; the SSE triple
   `probes-started` / `probes-done` / `probes-error`. Deliberately **no**
   `probes-chunk`.
4. **The split-brain trap** — `routes/ai.ts` keeps a hand-maintained
   `AI_RUN_KINDS` Set typed `Set<AiRunKind>`, which catches a *bad* member but
   never a *missing* one. Forgetting `'probe'` there 400s
   `GET /api/ai/runs?kind=probe` while rows keep writing.
5. **Model map** — `probe: 'mid'` in `PURPOSE_TIERS` (selection and derivation,
   not grading), and `'probe'` in the SPA's `PURPOSE_LABELS` / `PURPOSE_ORDER`
   or Settings type-errors.
6. **Spoilers** — `probe: new Set(['probes'])` in `WIRE_SAFE_KEYS` plus the
   matching `STEP_SCHEMA_KEYS` entry. An unknown step slug fails closed and
   silently drops every streamed partial. Do **not** ask the model for a
   per-probe `rationale` — that is pre-review grading and forces a new spoiler
   decision.
7. **Engine** `cli/server/probes.ts` on `createJobRegistry`, keyed by
   questionId, structurally copied from `disputes.ts`. User message:
   `buildQuestionSection(README)` + `## Candidate's Story` + `## Probe Bank`
   (from `.probes.md`; absent ⇒ every probe derived). The prompt requires ≥1
   probe with `source: 'derived'` drawn from the weakest point of the story.
   Check `inFlight.isDisposed()` after the awaited call before any db write or
   bus emit.
8. **Append** — purely additive, idempotent: snapshot the current `story.md`
   (`saveBlob` + `addSnapshot` trigger `'probe-append'`), then write
   `current + '\n\n## Follow-ups\n\n### Probe 1 — …'`. A later round adds
   `### Probe N` under the **same** `## Follow-ups` H2, never rewrites.
   Nothing ever parses this section back out — the review reads the whole file.
9. **Routes** `POST/GET /api/questions/:category/:slug/probes` — 202 with
   `{ probeJobId }`; 400 when there is no story yet (reuse the prose
   emptiness heuristic); 409 when a probe run is live **or** a probe set
   already exists for the active attempt (this is the bound); 503 keyless.
   Registered before the static routes, which own the `/api/*` 404 fallback.
10. **Session wiring** — `probes` into `WorkspaceSession`, `EngineFactories`,
    `defaultEngines`, the construction block, and `ENGINE_KEYS` (whose order
    `session.test.ts` asserts). Add `probes.isAnyRunning()` to
    `getBusyEngineError` or a workspace reset can close the db under a live
    paid call.
11. **Room UI — no new pane, no composer.** Extend `useReviewPanel` (it already
    owns the panel's settings fetch and the dispute slice; a separate hook
    would duplicate both): probe-set state, a `requestProbes` that awaits
    `flushSaves()` first exactly as `requestReview` does, the three SSE
    handlers filtered on questionId, and on `probes-done` a
    `loadFileInto(storyRelPath, { onlyIfClean: true })` — the server's own
    write is echo-suppressed so no `file-changed` arrives, and `onlyIfClean`
    routes a raced dirty buffer into the existing conflict banner instead of
    clobbering it. `AiPanel` gets a second button gated identically to Review
    (`settingsLoaded && !isKeyless && resolvedModelFor(settings,'probe')`) and
    renders the probe set as a read-only list with an "answer these in
    story.md ↓" hint. **No textareas.**
12. **Review input** — zero code changes. Only add a line to the capsule's
    `## Review Dimensions` telling the reviewer to score whether the probe
    answers added substance or restated the story.

### Degradation

`.probes.md` is absent on every manual and pre-M7 question. The engine must
derive all probes from the story in that case, or the feature is dead on every
hand-authored question — including the entire starter pack if NEE-347's seeds
ship without banks.

---

## Feature 5 — Seed behavioral questions (NEE-347)

5–6 hand-authored questions covering distinct competencies: conflict with a
peer, a project that failed, influencing without authority, ambiguous
requirements, receiving hard feedback, prioritising under a deadline. Added to
`questions/behavioral/` and to the `STARTER_PACK` manifest (an explicit
manifest, **not** a directory scan — a stray scratch question must never reach
someone else's workspace).

- Company-neutral: no Amazon-LP phrasing, no role assumptions beyond "software
  engineer".
- Each README's `**Suggested Time:** ~N minutes` line must **equal**
  `getSuggestedTime(category, difficulty)` exactly — `starter-pack.test.ts`
  asserts it.
- Ship a `.probes.md` with each seed so the probe feature works keyless on a
  fresh install.
- `package.json` "files" already publishes `questions/` raw — no packaging
  change.

**AGENTS.md is stale here.** It says to scaffold seed questions with
`npm run ace generate`, but the CLI retired at the M2 cut line and only
`init` / `setup` / `ui` remain. Scaffold via `scaffoldQuestionAt` (a one-off
script), never `mkdir` — that honours the rule's intent. Fix the AGENTS.md line
while you are there.

---

## Feature 6 — Prose questions can be solved (NEE-353)

Filed during this design pass. Status derives purely from test runs, so a
category with `testFiles: []` can **never** reach `solved` — Library's Solved
filter, the solved-banner's Next, practice-next tiering and the Last-run column
are all wrong for prose questions. Design has had this since M1; M7 multiplies
the row count.

Fix: when `hasTests(config)` is false, derive `solved` from a completed review,
in the `listQuestions` SQL (no N+1, no second JS pass). This deliberately
changes design semantics too — that is the intended fix. Coding status must be
provably unchanged.

---

## Deferred: the story bank (NEE-346)

**Decision recorded, implementation deferred out of M7.**

Own store, files-on-disk as the source of truth, SQLite as a derived index —
**not** a second entity in M4's Mistake Ledger.

The scope check resolves on **lifecycle, not subject matter**. The ledger is
system-authored, LLM-extracted, append-only and evidence-linked; every input
lives in `.ace/ace.db`, so it is correct for it to be archived and rebuilt when
the user clears the workspace. A story bank is the inverse: hand-written,
freely edited, derived from nothing in the app, irreplaceable. `performWorkspaceReset`
renames `<root>/.ace` wholesale and the restore plan only walks known-category
questions' solution files — so anything living only in SQLite is destroyed by
"clear workspace" while anything on disk is untouched. One table with two reset
behaviours is the reliable tell that it is two tables. They meet at a future
ledger evidence row carrying `story_id`/`slug`, never in a shared table.

Deferred because NEE-342→345+347 deliver a complete behavioral loop with zero
story dependency, the bank's value scales with a corpus that does not exist
yet, and it is the only M7 ticket touching the path-traversal guard
(`resolveWorkspacePath` is hard-scoped to `questions/`), the watcher root, and
the schema — the highest blast radius at the lowest priority.

What must **not** be deferred: the competency vocabulary. It ships in NEE-343,
which needs it anyway, so the coverage view is later a pure addition rather
than an unjoinable string-matching problem.

---

## Sequencing

Forcing files: `shared/categories.ts` (owned wholly by NEE-342),
`cli/lib/scaffold.ts` + `cli/lib/prompt-builder.ts` (342 refactors, 343
extends), `cli/server/reviews.ts` (344 and 345 both),
`cli/prompts/categories/behavioral.md` (342 creates the skeleton, 343 and 344
fill different sections).

| Wave | Tickets | Why |
| --- | --- | --- |
| 0 | **NEE-342** alone | Owns every shared file; nothing can run beside it |
| 1 | **NEE-343**, **NEE-344**, **NEE-353** | Disjoint code files; 343/344 share only the capsule, in disjoint sections |
| 2 | **NEE-345**, **NEE-347** | 345 needs 343's probe bank + 344's reviews.ts; 347 needs 343's README shape |

Merge serially through a queue in wave order. Whoever merges second into the
capsule must re-run the full suite rather than trust the auto-merge —
`prompt-builder` validates sections at **runtime on every call**, not at
compile time, so a clean auto-merge can still be broken.

## Where TypeScript will not save you

Runtime tests are required for all of these — the compiler stays silent:

1. ~~`isDesignCategory(...)` returns a boolean; a missed site compiles and
   takes the coding arm.~~ Moot: the function was removed and every site that
   would have called it is now a `Record<QuestionType, X>`, so a missed case
   is a compile error, not a silent fallthrough.
2. `config.type` interpolated as a string (`generation.ts`'s
   `Question type: ${config.type}` — the only place the type reaches an LLM).
3. `CATEGORY_SLUGS.includes(...)` in the generation route allowlist.
4. `z.enum(CATEGORY_SLUGS)` in brainstorm, plus the prose mirror that inlines
   `CATEGORY_SLUGS.join(' | ')`.
5. `hasOwnProperty(CATEGORIES, category)` in the reconciler and the importer —
   an unknown category dir is silently skipped, never upserted. This is why
   `questions/behavioral/*` on disk is invisible until the table entry ships.
6. `lookupCategoryConfig(category: string)` returns `null`; every
   `if (!config) return 400` is a normal path, never a type error.
7. String-literal comparisons: `name === 'notes.md'`, the `designSubType`
   chain's `'full-stack'` else-fallback, the hardcoded `'notes.md'` reads, the
   `path.join(TEMPLATES_DIR, 'design', 'notes.md.hbs')`.
8. `config.solutionFiles[0]` / `config.testFiles[0]` — `noUncheckedIndexedAccess`
   is **off**, so these are typed `string` while being `undefined` at runtime
   for a `testFiles: []` category.
9. `fs.existsSync(templatePath)` in scaffold — a missing `story.md.hbs` writes
   nothing and returns `''`, silently.
10. Capsule section presence — `requireSection` throws at **runtime**, on every
    call, reading from disk with no caching.
11. `suggestedTimes[difficulty]` — the SPA renders the raw value, so a missing
    difficulty produces `easy — ~ min`.
12. `QuestionRow.category` is `string`, not `CategorySlug`, everywhere on the
    wire.
13. Handlebars templates and markdown seed content get no type checking at all.
    `starter-pack.test.ts` is the only automated check that will ever look at a
    behavioral seed question.

## Verification

No CI, by standing decision — local verification only. Every wave ends with
`npm test` (both projects), both typechecks, `npm run build`, and a built-CLI
smoke test. Known noise: `ECONNREFUSED :3000` and happy-dom AbortError traces
are negative-path output, not failures. Two known rare flakes on the watchlist:
`cli/e2e/workspace-reset.test.ts` ECONNRESET and `cli/server/runner.test.ts`
heartbeat timing — re-run once before investigating.
