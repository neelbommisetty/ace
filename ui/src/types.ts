/**
 * Wire shapes mirrored from cli/server/types.ts (the ui tsconfig cannot reach
 * into cli/). Keep in sync with that file — JSON over the wire is camelCase.
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
  dirPath: string;
  source: QuestionSource;
  createdAt: string;
  archivedAt: string | null;
  missingAt: string | null;
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
  suite: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number | null;
  error: string | null;
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
  errorMessage: string | null;
}

export interface QuestionFileInfo {
  name: string;
  relPath: string;
  kind: FileKind;
  readonly: boolean;
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
  readme: string;
  files: QuestionFileInfo[];
  activeAttempt: AttemptRow | null;
  lastRun: TestRunRow | null;
}

export interface WorkspaceInfo {
  root: string;
  questionsDir: string;
  version: string;
  counts: { questions: number; attempts: number; testRuns: number };
  skippedDirs: string[];
  legacyImport: { available: boolean; questionCount: number };
  activeAttempt: { attempt: AttemptRow; question: QuestionRow } | null;
  /**
   * `path.basename(root)` as computed by the server — the exact string
   * `POST /api/workspace/reset` requires in `confirm`. Use this verbatim
   * instead of re-deriving a basename client-side (see server `types.ts`).
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
  archivedTo: string;
  restored: { questions: number; files: number };
  workspace: WorkspaceInfo;
}

export interface ReviewRow {
  id: string;
  questionId: string;
  attemptId: string | null;
  version: number;
  at: string;
  model: string | null;
  verdict: string | null;
  score: number | null;
  dimensions: Record<string, number> | null;
  bodyMd: string;
  snapshotHash: string | null;
  source: 'user' | 'import';
}

export type DisputeVerdict = 'test_incorrect' | 'solution_incorrect' | 'ambiguous';

export interface DisputeRow {
  id: string;
  questionId: string;
  attemptId: string | null;
  testRunId: string;
  at: string;
  argument: string | null;
  verdict: DisputeVerdict;
  summary: string;
  detailsMd: string;
  fixedTestCode: string | null;
  testRelPath: string;
  hint: string | null;
  appliedAt: string | null;
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
  // Anchor for the elapsed clock: stamped at creation, re-stamped by the
  // server on every retry (NEE-277). Optional so a server that predates the
  // field degrades to the createdAt fallback instead of a NaN clock.
  runStartedAt?: string | null;
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

export type AiRunKind = 'generation' | 'review' | 'dispute' | 'brainstorm';
export type AiRunStatus = 'running' | 'done' | 'error';
export type AiStepKind = 'llm' | 'sandbox' | 'static-check' | 'scaffold';
export type AiStepStatus = 'running' | 'done' | 'error' | 'skipped';

export interface AiRunRow {
  id: string; // minted per run — NOT the engine's jobId (retry re-uses that)
  kind: AiRunKind;
  refId: string | null;
  questionId: string | null;
  label: string;
  status: AiRunStatus;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface AiStepRow {
  id: string;
  runId: string;
  seq: number; // 1-based, per run
  kind: AiStepKind;
  slug: string; // 'generate' | 'edge-audit' | 'verify' | 'repair' | 'scaffold' | …
  label: string;
  status: AiStepStatus;
  attempt: number;
  promptText: string | null; // already masked server-side; null when withheld
  promptWithheld: boolean;
  responseText: string | null; // already masked server-side
  withheldKeys: string[] | null; // e.g. ['referenceSolution', 'interviewerPacket']
  detail: string | null; // one-line collapsed outcome, e.g. '12/12 passed'
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** `AiStepRow` minus the multi-KB prompt/response bodies — the list/SSE shape. */
export type AiStepSummary = Omit<AiStepRow, 'promptText' | 'responseText'>;

export interface ProviderSettings {
  configured: boolean;
  masked: string | null;
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

export interface SseEventMap {
  hello: { version: string; workspaceRoot: string; epoch: string };
  'file-changed': { relPath: string; hash: string };
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
   * persisted — a reload falls back to the generic running label.
   */
  'generation-progress': {
    jobId: string;
    phase: 'generating' | 'auditing' | 'verifying' | 'repairing';
    attempt: number;
  };
  'generation-done': { jobId: string; question: QuestionRow };
  'generation-error': { jobId: string; message: string };
  /**
   * AI activity log (NEE-268). Step responses stream as coalesced per-key
   * text ops; prompts never ride SSE — clients fetch the full step on demand.
   * `withheldKeys` arrives on ai-step-started so the `█ withheld █` lines can
   * render while the stream is still filling. Every step- and run-level
   * event repeats the owning run's `refId` so refId-filtered feeds (the
   * per-job drawer, NEE-272) can drop foreign events statelessly instead of
   * accumulating them.
   */
  'ai-run-started': { run: AiRunRow };
  'ai-step-started': { runId: string; refId: string | null; step: AiStepSummary };
  'ai-step-chunk': {
    runId: string;
    refId: string | null;
    stepId: string;
    ops: Array<{ key: string; op: 'append' | 'set'; text: string }>;
  };
  'ai-step-done': {
    runId: string;
    refId: string | null;
    stepId: string;
    status: 'done' | 'error' | 'skipped';
    detail: string | null;
    errorMessage: string | null;
    finishedAt: string;
  };
  'ai-run-done': {
    runId: string;
    refId: string | null;
    status: 'done' | 'error';
    errorMessage: string | null;
    finishedAt: string;
  };
  /**
   * `requestId` echoes back the initiating POST's own id (see
   * `resetWorkspace` in `api.ts`) so the initiating tab can recognize its
   * own broadcast and distinguish it from a reset some other tab triggered.
   */
  'workspace-reset': { mode: WorkspaceResetMode; archivedTo: string; requestId: string };
}

export type SseEventName = keyof SseEventMap;
