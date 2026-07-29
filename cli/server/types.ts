/**
 * Shared types for the ACE next server (M1 — The Room).
 *
 * Contract file: the db layer implements `AceDb`, routes consume it, and the
 * SPA consumes the same JSON wire shapes. The wire half lives in
 * shared/wire-types.ts (NEE-284) — compiled by both tsconfigs — and is
 * re-exported here so existing `./types.js` importers are untouched. This
 * file keeps only the server-only half: snapshot rows and the `AceDb`
 * interface. JSON over the wire is camelCase; SQLite columns are snake_case
 * (db.ts maps). All timestamps are ISO 8601 UTC strings.
 */

export * from '../../shared/wire-types.js';

import type {
  AttemptEndReason,
  AttemptEventRow,
  AttemptEventType,
  AttemptRow,
  AiRunKind,
  AiRunRow,
  AiStepKind,
  AiStepRow,
  AiStepSummary,
  BrainstormSessionRow,
  BrainstormSessionStatus,
  BrainstormTurn,
  Difficulty,
  DisputeRow,
  DisputeVerdict,
  GenerationJobRow,
  GenerationJobStatus,
  HistoryItem,
  Probe,
  ProbeSetRow,
  QuestionRow,
  QuestionSource,
  QuestionWithStats,
  ReviewRow,
  TestCaseResult,
  TestRunRow,
  TestRunStatus,
  TestRunSummary,
  TestRunTrigger,
} from '../../shared/wire-types.js';

export type SnapshotTrigger =
  | 'scaffold'
  | 'save'
  | 'review'
  | 'dispute-apply'
  | 'probe-append'
  | 'reset';

export interface SnapshotRow {
  id: string;
  questionId: string;
  attemptId: string | null;
  relPath: string;
  hash: string; // sha1, content stored at .ace/blobs/<hash>
  at: string;
  trigger: SnapshotTrigger;
}

// ---------------------------------------------------------------------------
// The db layer contract. Implemented in db.ts over node:sqlite; routes and
// the runner code against this interface only.
// ---------------------------------------------------------------------------

export interface AceDb {
  readonly workspaceRoot: string;

  listQuestions(): QuestionWithStats[];
  getQuestionById(id: string): QuestionRow | null;
  getQuestion(category: string, slug: string): QuestionRow | null;
  upsertQuestion(q: {
    category: string;
    slug: string;
    title: string;
    difficulty: Difficulty;
    suggestedMinutes: number;
    dirPath: string;
    source: QuestionSource;
  }): QuestionRow;
  /** Mark rows whose dir no longer exists; clears the flag for ids present again. */
  setMissing(presentIds: string[], missingIds: string[]): void;
  /** Sets `archivedAt`; null if `id` doesn't exist. */
  archiveQuestion(id: string): QuestionRow | null;
  /** Clears `archivedAt`; null if `id` doesn't exist. */
  unarchiveQuestion(id: string): QuestionRow | null;

  getActiveAttempt(questionId: string): AttemptRow | null;
  /** Most recently active attempt across all questions (for instant resume). */
  getLatestActiveAttempt(): { attempt: AttemptRow; question: QuestionRow } | null;
  /** Newest attempt for a question regardless of ended state, or null if none exist yet. */
  getLatestAttempt(questionId: string): AttemptRow | null;
  createAttempt(questionId: string, opts?: { imported?: boolean; startedAt?: string }): AttemptRow;
  getAttempt(id: string): AttemptRow | null;
  patchAttempt(
    id: string,
    patch: { activeSecondsDelta?: number; end?: { reason: AttemptEndReason } },
  ): AttemptRow;
  addAttemptEvent(
    attemptId: string,
    type: AttemptEventType,
    payload?: Record<string, unknown>,
  ): AttemptEventRow;
  hasAttemptEvent(attemptId: string, type: AttemptEventType): boolean;
  listAttemptEvents(attemptId: string): AttemptEventRow[];
  /** Workspace-wide attempt count in one query, e.g. for GET /api/workspace. */
  countAttempts(): number;

  createTestRun(r: {
    questionId: string;
    attemptId: string | null;
    trigger: TestRunTrigger;
  }): TestRunRow;
  finishTestRun(
    id: string,
    patch: {
      status: TestRunStatus;
      summary?: TestRunSummary;
      results?: TestCaseResult[];
      stdout?: string;
      stderr?: string;
      errorMessage?: string;
    },
  ): TestRunRow;
  getTestRun(id: string): TestRunRow | null;
  listTestRuns(questionId: string, limit?: number): TestRunRow[];
  /**
   * Workspace-wide test run count in one query — avoids materialising every
   * row (results_json, stdout_text, stderr_text) just to read `.length`.
   */
  countTestRuns(): number;
  getLatestTestRun(questionId: string): TestRunRow | null;
  /**
   * Newest completed ('done') run, or null if none — the same ORDER BY
   * (`at DESC, id DESC`) as `listQuestions`' latestDone subquery, so
   * solve-detection here and question-status derivation there never disagree.
   */
  getLatestCompletedTestRun(questionId: string): TestRunRow | null;

  createReview(r: {
    questionId: string;
    attemptId: string | null;
    bodyMd: string;
    verdict?: string | null;
    score?: number | null;
    dimensions?: Record<string, number> | null;
    snapshotHash?: string | null;
    model?: string | null;
    source: 'user' | 'import';
    at?: string;
  }): ReviewRow;
  getReview(id: string): ReviewRow | null;
  /** All versions for a question, newest first. */
  listReviews(questionId: string): ReviewRow[];
  /**
   * Newest review for a question (by `version`), or null if none — the same
   * row `listQuestions`' `last_review_verdict` subquery resolves, so the
   * verdict-aware `solved` rule for no-test categories (NEE-353, NEE-356)
   * reads identically from `isQuestionSolved` (app.ts) and from
   * question-status derivation.
   */
  getLatestReview(questionId: string): ReviewRow | null;

  createDispute(d: {
    questionId: string;
    attemptId: string | null;
    testRunId: string;
    argument: string | null;
    verdict: DisputeVerdict;
    summary: string;
    detailsMd: string;
    fixedTestCode: string | null;
    testRelPath: string;
    hint: string | null;
  }): DisputeRow;
  getDispute(id: string): DisputeRow | null;
  listDisputes(questionId: string): DisputeRow[];
  markDisputeApplied(id: string): DisputeRow;

  /** One probe generation round (NEE-345) — bounded to one per attempt (enforced by the route, not here). */
  createProbeSet(p: {
    questionId: string;
    attemptId: string | null;
    probes: Probe[];
    model: string | null;
  }): ProbeSetRow;
  getProbeSet(id: string): ProbeSetRow | null;
  /** Newest first. */
  listProbeSets(questionId: string): ProbeSetRow[];
  /** Stamps `appliedAt`; a no-op (returns the existing row) once already applied — mirrors markDisputeApplied. */
  markProbeSetApplied(id: string): ProbeSetRow;

  addSnapshot(s: {
    questionId: string;
    attemptId: string | null;
    relPath: string;
    hash: string;
    trigger: SnapshotTrigger;
  }): SnapshotRow;
  getLatestSnapshot(questionId: string, relPath: string, trigger?: SnapshotTrigger): SnapshotRow | null;
  /** Oldest snapshot for a path (optionally by trigger) — the pristine scaffold baseline. */
  getFirstSnapshot(questionId: string, relPath: string, trigger?: SnapshotTrigger): SnapshotRow | null;

  createGenerationJob(j: {
    category: string;
    difficulty: Difficulty;
    topic: string;
    brainstormSessionId?: string | null;
  }): GenerationJobRow;
  /**
   * Throws when the existing row's status is already 'done' (terminal rows
   * are immutable). Stamps `finishedAt` when the patch's resulting status is
   * 'done' or 'error'; leaves it null for any other status. `runStartedAt`
   * is only ever re-stamped when the patch supplies it (retry does; nothing
   * else should).
   */
  patchGenerationJob(
    id: string,
    patch: {
      status?: GenerationJobStatus;
      title?: string | null;
      slug?: string | null;
      result?: Record<string, unknown> | null;
      rawText?: string | null;
      errorMessage?: string | null;
      questionId?: string | null;
      runStartedAt?: string;
    },
  ): GenerationJobRow;
  getGenerationJob(id: string): GenerationJobRow | null;
  /** Newest first. */
  listGenerationJobs(limit?: number): GenerationJobRow[];
  /**
   * Narrow provenance-correction escape hatch: a plain `UPDATE questions SET
   * source = ?`, used only by the generation engine to re-assert 'generated'
   * over a 'manual' row the reconciler may have inserted first during a crash
   * window. Does not touch `upsertQuestion`'s insert-only source semantics.
   */
  setQuestionSource(id: string, source: QuestionSource): void;

  /**
   * Creates a brainstorm session seeded with the first user message: status
   * starts 'thinking' (a reply is about to be generated for it), `title` is
   * `firstMessage` truncated, and `messages` is a single user turn.
   */
  createBrainstormSession(firstMessage: string): BrainstormSessionRow;
  getBrainstormSession(id: string): BrainstormSessionRow | null;
  /** Newest first (by `updatedAt`). */
  listBrainstormSessions(limit?: number): BrainstormSessionRow[];
  /**
   * Transactional read-modify-write: appends `turn` to `messages` and sets
   * `status` + bumps `updatedAt`, all inside one transaction, so a mid-write
   * failure (e.g. a constraint violation) leaves `messages` byte-for-byte
   * unchanged rather than partially applied. Throws on an unknown id.
   */
  appendBrainstormTurn(
    id: string,
    turn: BrainstormTurn,
    status: BrainstormSessionStatus,
  ): BrainstormSessionRow;
  /**
   * Sets `status` (and `errorMessage`, cleared to null when omitted) without
   * touching `messages` — for transitions that have no turn to persist (e.g.
   * a hard LLM failure with nothing salvageable). Throws on an unknown id.
   */
  setBrainstormStatus(
    id: string,
    status: BrainstormSessionStatus,
    errorMessage?: string | null,
  ): BrainstormSessionRow;

  /**
   * Creates an AI activity log run: status starts 'running', `startedAt` is
   * stamped now. `refId`/`questionId` default to null when omitted.
   */
  createAiRun(r: {
    kind: AiRunKind;
    refId?: string | null;
    questionId?: string | null;
    label: string;
  }): AiRunRow;
  /** Marks a run terminal, stamping `finishedAt`. Throws on an unknown id. */
  finishAiRun(
    id: string,
    patch: { status: 'done' | 'error'; errorMessage?: string | null },
  ): AiRunRow;
  /**
   * Creates a step under a run: status starts 'running', `seq` is assigned
   * per-run (max + 1), `attempt` defaults to 1. `promptText` must already be
   * masked by the caller and is capped head-and-tail at `AI_LOG_TEXT_CAP`;
   * pass `promptWithheld` with a null `promptText` when the whole prompt is
   * withheld. Throws on an unknown run id.
   */
  createAiStep(s: {
    runId: string;
    kind: AiStepKind;
    slug: string;
    label: string;
    attempt?: number;
    promptText?: string | null;
    promptWithheld?: boolean;
    withheldKeys?: string[] | null;
  }): AiStepRow;
  /**
   * Replaces `responseText` with the full accumulated (already-masked) text —
   * snapshot semantics, not concatenation, so the recorder's throttled
   * re-flushes are idempotent and each flush is one cheap UPDATE. Capped
   * head-and-tail at `AI_LOG_TEXT_CAP`. Throws on an unknown id.
   */
  appendAiStepResponse(id: string, responseText: string): AiStepRow;
  /**
   * Marks a step terminal, stamping `finishedAt`. Omitted fields are
   * preserved (notably `responseText` streamed via `appendAiStepResponse`);
   * a provided `responseText` replaces it (capped). Throws on an unknown id.
   */
  finishAiStep(
    id: string,
    patch: {
      status: 'done' | 'error' | 'skipped';
      detail?: string | null;
      errorMessage?: string | null;
      responseText?: string | null;
    },
  ): AiStepRow;
  /** Newest first (by `startedAt`), optionally filtered by kind and/or refId. */
  listAiRuns(opts?: { limit?: number; kind?: AiRunKind; refId?: string }): AiRunRow[];
  getAiRun(id: string): AiRunRow | null;
  getAiStep(id: string): AiStepRow | null;
  /** A run's steps in `seq` order — summary shape (the text columns are never selected). */
  listAiSteps(runId: string): AiStepSummary[];
  /**
   * Deletes runs outside the newest `keep` (default 200); ON DELETE CASCADE
   * drops their steps. Called after each run terminates — no timers. Returns
   * the number of runs deleted.
   */
  pruneAiRuns(keep?: number): number;

  /**
   * Run once at session build, before anything else touches these tables.
   * Flips every non-terminal in-flight row left behind by an unclean
   * shutdown: 'running' generation jobs -> 'error' ("interrupted by a server
   * restart — retry"); 'llm_done' generation jobs -> 'error' ("interrupted by
   * a server restart — retry (no new LLM call)"), preserving `result`/`title`/
   * `slug`/`rawText` so retry is scaffold-only with no re-spend; 'thinking'
   * brainstorm sessions -> 'error' ("interrupted by a server restart");
   * 'running' ai_runs and ai_steps -> 'error' ("interrupted by a server
   * restart"), stamping `finishedAt` — otherwise Activity would show a run
   * pulsing forever with no engine behind it. Terminal job rows ('done',
   * 'error'), 'idle' sessions, and terminal runs/steps are untouched.
   */
  sweepInterruptedGenerationState(): void;

  /**
   * Search reviews + disputes, newest first. `q` uses FTS5 over review bodies
   * when available (LIKE fallback otherwise); empty q returns everything.
   */
  searchHistory(opts: {
    q?: string;
    category?: string;
    type?: 'review' | 'dispute';
    questionId?: string;
    limit?: number;
  }): HistoryItem[];

  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  /** Runs fn inside a single SQLite transaction (BEGIN/COMMIT, ROLLBACK on throw). Not nestable. */
  transaction<T>(fn: () => T): T;

  close(): void;
}
