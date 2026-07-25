/**
 * Shared types for the ACE next server (M1 — The Room).
 *
 * Contract file: the db layer implements `AceDb`, routes consume it, and the
 * SPA mirrors the JSON shapes. JSON over the wire is camelCase; SQLite columns
 * are snake_case (db.ts maps). All timestamps are ISO 8601 UTC strings.
 */

export type Difficulty = 'easy' | 'medium' | 'hard';
export type QuestionSource = 'generated' | 'imported' | 'manual';
export type QuestionStatus = 'not-attempted' | 'in-progress' | 'solved';
export type AttemptEndReason = 'solved' | 'submitted' | 'abandoned' | 'superseded';
export type AttemptEventType =
  | 'reveal'
  | 'first_edit'
  | 'test_run'
  | 'all_green'
  | 'pause'
  | 'resume';
export type TestRunTrigger = 'manual' | 'save';
export type TestRunStatus = 'running' | 'done' | 'error' | 'cancelled';
export type FileKind = 'readme' | 'solution' | 'test' | 'notes';

export interface QuestionRow {
  id: string;
  category: string;
  slug: string;
  title: string;
  difficulty: Difficulty;
  suggestedMinutes: number;
  dirPath: string; // absolute path of the question directory
  source: QuestionSource;
  createdAt: string;
  archivedAt: string | null;
  missingAt: string | null; // set by the reconciler when the dir vanished
}

export interface AttemptRow {
  id: string;
  questionId: string;
  number: number;
  startedAt: string;
  endedAt: string | null;
  endReason: AttemptEndReason | null;
  activeSeconds: number;
  hintsUsed: number;
  imported: boolean;
}

export interface AttemptEventRow {
  id: string;
  attemptId: string;
  at: string;
  type: AttemptEventType;
  payload: Record<string, unknown> | null;
}

export interface TestCaseResult {
  name: string;
  suite: string; // ancestor titles joined with ' › ', '' when top-level
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number | null;
  error: string | null; // first failure message, ANSI stripped
}

export interface TestRunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export interface TestRunRow {
  id: string;
  attemptId: string | null;
  questionId: string;
  at: string;
  trigger: TestRunTrigger;
  status: TestRunStatus;
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  durationMs: number | null;
  results: TestCaseResult[] | null;
  stdout: string | null;
  stderr: string | null;
  errorMessage: string | null; // for status 'error': why the run failed to execute
}

export interface ReviewRow {
  id: string;
  questionId: string;
  attemptId: string | null;
  version: number;
  at: string;
  model: string | null;
  verdict: string | null; // design rubric: 'Strong Hire' | 'Hire' | 'Lean Hire' | 'No Hire'
  score: number | null; // code reviews: parsed "Overall N/5"
  dimensions: Record<string, number> | null; // design rubric dimension → 1..5
  bodyMd: string;
  snapshotHash: string | null; // blob hash of the primary solution file at request time
  source: 'user' | 'import';
}

export type DisputeVerdict = 'test_incorrect' | 'solution_incorrect' | 'ambiguous';

export interface DisputeRow {
  id: string;
  questionId: string;
  attemptId: string | null;
  testRunId: string;
  at: string;
  argument: string | null; // the user's case, optional
  verdict: DisputeVerdict;
  summary: string;
  detailsMd: string;
  fixedTestCode: string | null; // full corrected test file when verdict allows applying
  testRelPath: string; // workspace-relative path of the disputed test file
  hint: string | null; // spoiler-free hint when solution_incorrect
  appliedAt: string | null;
}

export type SnapshotTrigger = 'scaffold' | 'save' | 'review' | 'dispute-apply' | 'reset';

export interface SnapshotRow {
  id: string;
  questionId: string;
  attemptId: string | null;
  relPath: string;
  hash: string; // sha1, content stored at .ace/blobs/<hash>
  at: string;
  trigger: SnapshotTrigger;
}

export type GenerationJobStatus = 'running' | 'llm_done' | 'done' | 'error';

export interface GenerationJobRow {
  id: string;
  status: GenerationJobStatus;
  category: string;
  difficulty: Difficulty;
  topic: string;
  brainstormSessionId: string | null;
  title: string | null;
  slug: string | null;
  result: Record<string, unknown> | null; // parsed LLM object, persisted BEFORE any scaffolding
  rawText: string | null; // salvage when parsing failed
  errorMessage: string | null;
  questionId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export type BrainstormSessionStatus = 'idle' | 'thinking' | 'error';

export interface BrainstormTurn {
  role: 'user' | 'assistant';
  content: string;
  ideas?: Array<{
    title: string;
    category: string;
    difficulty: Difficulty;
    pitch: string;
    topic: string; // ready-to-feed generation description
  }>;
}

export interface BrainstormSessionRow {
  id: string;
  status: BrainstormSessionStatus;
  title: string; // first user message, truncated
  messages: BrainstormTurn[]; // parsed from messages_json
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderSettings {
  configured: boolean;
  masked: string | null; // '...abcd'
  baseUrl: string | null; // vendor default when null; not masked
}

export interface SettingsInfo {
  openai: ProviderSettings;
  anthropic: ProviderSettings;
  defaultProvider: 'openai' | 'anthropic' | null;
  mockMode: boolean;
}

export type HistoryItem =
  | { type: 'review'; at: string; question: QuestionRow; review: ReviewRow }
  | { type: 'dispute'; at: string; question: QuestionRow; dispute: DisputeRow };

export interface QuestionFileInfo {
  name: string;
  relPath: string; // relative to the workspace root, POSIX separators
  kind: FileKind;
  readonly: boolean; // test files are readonly in M1
}

export interface QuestionStats {
  attemptCount: number;
  lastRun: { passed: number; total: number; at: string } | null;
  lastActivityAt: string | null;
  status: QuestionStatus;
  imported: boolean;
}

export interface QuestionWithStats extends QuestionRow {
  stats: QuestionStats;
}

export interface QuestionDetail {
  question: QuestionRow;
  readme: string; // raw markdown, '' if missing
  files: QuestionFileInfo[];
  activeAttempt: AttemptRow | null;
  lastRun: TestRunRow | null;
}

export interface WorkspaceInfo {
  root: string;
  questionsDir: string;
  version: string;
  counts: { questions: number; attempts: number; testRuns: number };
  skippedDirs: string[]; // question dirs under unknown categories
  legacyImport: { available: boolean; questionCount: number };
  activeAttempt: { attempt: AttemptRow; question: QuestionRow } | null;
  /**
   * `path.basename(root)` as computed by the server — the exact string
   * `POST /api/workspace/reset` requires in `confirm`. Clients must use this
   * verbatim instead of re-deriving a basename themselves: `path.basename`'s
   * separator handling is platform-dependent (POSIX treats `\` as an
   * ordinary filename character; Windows treats it as a separator), so a
   * browser-side re-derivation can disagree with the server for roots
   * containing the "wrong" platform's separator character.
   */
  confirmName: string;
}

export interface ImportPreviewItem {
  category: string;
  slug: string;
  title: string;
  legacyAttempts: number;
  hasFeedback: boolean;
  alreadyImported: boolean;
}

export interface ImportResult {
  questionsImported: number;
  attemptsCreated: number;
  reviewsCreated: number;
  skipped: number;
}

export type WorkspaceResetMode = 'progress' | 'full';

export interface WorkspaceResetResult {
  mode: WorkspaceResetMode;
  archivedTo: string; // absolute path of the renamed .ace-archive-* dir
  restored: { questions: number; files: number }; // zeros in 'progress' mode
  workspace: WorkspaceInfo; // freshly computed post-reset, for the initiating tab
}

// ---------------------------------------------------------------------------
// SSE events — sent on GET /api/events. `event:` field is the name below,
// `data:` is the JSON payload.
// ---------------------------------------------------------------------------

export interface SseEventMap {
  hello: { version: string; workspaceRoot: string; epoch: string };
  /** A file changed on disk from OUTSIDE the server (VS Code etc.). */
  'file-changed': { relPath: string; hash: string };
  /** Question dirs were added/removed; clients should refetch the library. */
  'questions-changed': Record<string, never>;
  'run-started': {
    runId: string;
    questionId: string;
    attemptId: string | null;
    trigger: TestRunTrigger;
  };
  'run-output': { runId: string; stream: 'stdout' | 'stderr'; chunk: string };
  'run-done': {
    runId: string;
    questionId: string;
    status: TestRunStatus;
    summary: TestRunSummary | null;
    results: TestCaseResult[] | null;
    errorMessage: string | null;
  };
  'review-started': { jobId: string; questionId: string; kind: 'code' | 'design' };
  'review-chunk': { jobId: string; chunk: string };
  'review-done': { jobId: string; questionId: string; review: ReviewRow };
  'review-error': { jobId: string; questionId: string; message: string };
  'dispute-started': { disputeJobId: string; questionId: string; testRunId: string };
  'dispute-done': { disputeJobId: string; questionId: string; dispute: DisputeRow };
  'dispute-error': { disputeJobId: string; questionId: string; message: string };
  'brainstorm-started': { sessionId: string };
  'brainstorm-done': { sessionId: string; turn: BrainstormTurn };
  'brainstorm-error': { sessionId: string; message: string };
  /**
   * The FULL row (not just the id) — the job strip and Library pill must
   * render a card for a job started from another tab (category, topic,
   * createdAt) without a follow-up fetch.
   */
  'generation-started': { job: GenerationJobRow };
  /**
   * Ephemeral pipeline-phase progress for active generation cards. Not
   * persisted anywhere — a reload falls back to the generic running label.
   */
  'generation-progress': {
    jobId: string;
    phase: 'generating' | 'auditing' | 'verifying' | 'repairing';
    attempt: number;
  };
  'generation-done': { jobId: string; question: QuestionRow };
  'generation-error': { jobId: string; message: string };
  /**
   * Emitted once, after the new session is live, at the end of a workspace
   * reset. `requestId` echoes back whatever the initiating
   * `POST /api/workspace/reset` request sent (or a server-minted fallback if
   * it sent none) — clients use it to recognize "this is the broadcast for
   * MY request" and distinguish it from a reset some other tab triggered,
   * which matters because the SSE broadcast and the POST's own HTTP response
   * race independently and can arrive in either order.
   */
  'workspace-reset': { mode: WorkspaceResetMode; archivedTo: string; requestId: string };
}

export type SseEventName = keyof SseEventMap;

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
   * 'done' or 'error'; leaves it null for any other status.
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
   * Run once at session build, before anything else touches these tables.
   * Flips every non-terminal in-flight row left behind by an unclean
   * shutdown: 'running' generation jobs -> 'error' ("interrupted by a server
   * restart — retry"); 'llm_done' generation jobs -> 'error' ("interrupted by
   * a server restart — retry (no new LLM call)"), preserving `result`/`title`/
   * `slug`/`rawText` so retry is scaffold-only with no re-spend; 'thinking'
   * brainstorm sessions -> 'error' ("interrupted by a server restart").
   * Terminal job rows ('done', 'error') and 'idle' sessions are untouched.
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
