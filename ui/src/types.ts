/**
 * Wire shapes mirrored from cli/server/types.ts (the ui tsconfig cannot reach
 * into cli/). Keep in sync with that file — JSON over the wire is camelCase.
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

export interface ProviderSettings {
  configured: boolean;
  masked: string | null;
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
}

export type SseEventName = keyof SseEventMap;
