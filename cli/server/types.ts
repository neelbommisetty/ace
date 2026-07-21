/**
 * Shared types for the ACE next server (M1 — The Room).
 *
 * Contract file: the db layer implements `AceDb`, routes consume it, and the
 * SPA mirrors the JSON shapes. JSON over the wire is camelCase; SQLite columns
 * are snake_case (db.ts maps). All timestamps are ISO 8601 UTC strings.
 */

export type Difficulty = 'easy' | 'medium' | 'hard';
export type QuestionSource = 'generated' | 'imported' | 'manual';
export type QuestionStatus = 'not-started' | 'in-progress' | 'green';
export type AttemptEndReason = 'green' | 'submitted' | 'abandoned' | 'superseded';
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

export interface ProviderSettings {
  configured: boolean;
  masked: string | null; // '...abcd'
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
