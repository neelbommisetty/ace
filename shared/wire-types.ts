/**
 * The JSON-over-the-wire contract shared by cli/ and ui/ (NEE-284).
 *
 * Single source of truth for every shape the server sends the SPA: row
 * shapes, route payloads, and the SSE event map. `cli/server/types.ts`
 * re-exports this module (plus the server-only half — `AceDb` etc.), and
 * `ui/src/types.ts` re-exports it via the `@shared` alias, so a route
 * response shape change is a compile error on both sides instead of a
 * runtime `undefined`. JSON over the wire is camelCase; SQLite columns are
 * snake_case (db.ts maps). All timestamps are ISO 8601 UTC strings.
 */

import type { Difficulty } from './categories.js';

export type { Difficulty };

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
/**
 * 'compile-error' (NEE-332): vitest ran but the suite never collected —
 * a syntax error or broken import in the solution/test file. Distinct from
 * 'error' (the run itself couldn't be executed/produced no parseable
 * report) and from a 'done' run with total:0 (a suite that collected fine
 * but genuinely defines zero tests — neutral, not an error). errorMessage
 * carries the ANSI-stripped transform/import failure for both 'error' and
 * 'compile-error'.
 */
export type TestRunStatus = 'running' | 'done' | 'error' | 'cancelled' | 'compile-error';
export type FileKind = 'readme' | 'solution' | 'test' | 'notes' | 'support';

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

export type SnapshotTrigger =
  | 'scaffold'
  | 'save'
  | 'review'
  | 'dispute-apply'
  | 'probe-append'
  | 'reset';

/**
 * One point-in-time capture of a solution/story/notes file's content, keyed
 * by content-addressed blob hash (NEE-363's snapshot-viewing surface reuses
 * the same rows `applyRestorePlan`/`snapshotPreResetState` already write —
 * nothing new is captured, this just makes them reachable from the SPA).
 */
export interface SnapshotRow {
  id: string;
  questionId: string;
  attemptId: string | null;
  relPath: string;
  hash: string; // sha1, content stored at .ace/blobs/<hash>
  at: string;
  trigger: SnapshotTrigger;
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

/** One follow-up question offered by the probe engine (NEE-345). */
export interface Probe {
  question: string;
  /** 'bank' — pulled from the question's hidden `.probes.md` generation-time
   *  bank; 'derived' — written fresh from the candidate's own story text. */
  source: 'bank' | 'derived';
}

/** One probe generation round for a question (NEE-345) — bounded to one per attempt. */
export interface ProbeSetRow {
  id: string;
  questionId: string;
  attemptId: string | null;
  at: string;
  probes: Probe[];
  model: string | null;
  /** Stamped once the probes have been appended to the story file on disk. */
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
  // NEE-386: set together (or neither) when this job regenerates a prior
  // question with feedback. Write-once — patchGenerationJob never touches
  // them, so every existing patch preserves them untouched.
  feedback: string | null;
  sourceQuestionId: string | null;
  title: string | null;
  slug: string | null;
  result: Record<string, unknown> | null; // parsed LLM object, persisted BEFORE any scaffolding
  rawText: string | null; // salvage when parsing failed
  errorMessage: string | null;
  questionId: string | null;
  createdAt: string;
  // Anchor for the UI's elapsed clock: stamped at creation, re-stamped on
  // every retry (NEE-277) — created_at stays fixed so strip ordering never
  // changes. Backfilled to created_at by migration 6, so never null.
  runStartedAt: string;
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

export type AiRunKind = 'generation' | 'review' | 'dispute' | 'brainstorm' | 'probe';
export type AiRunStatus = 'running' | 'done' | 'error';
export type AiStepKind = 'llm' | 'sandbox' | 'static-check' | 'scaffold';
export type AiStepStatus = 'running' | 'done' | 'error' | 'skipped';

export interface AiRunRow {
  id: string; // minted per run — NOT the engine's jobId (retry re-uses that)
  kind: AiRunKind;
  refId: string | null; // generation_jobs.id | review jobId | disputeJobId | brainstorm session id
  questionId: string | null; // no FK: a generation run precedes its question row
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
  promptText: string | null; // ALREADY MASKED at write time; null when withheld
  promptWithheld: boolean;
  responseText: string | null; // ALREADY MASKED at write time
  withheldKeys: string[] | null; // e.g. ['referenceSolution', 'interviewerPacket']
  detail: string | null; // one-line collapsed outcome, e.g. '12/12 passed'
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * `AiStepRow` minus the multi-KB prompt/response bodies — the list-response
 * shape. Keeping that text out of the feed is what makes a 30-run listing
 * cheap; clients fetch the full step on demand.
 */
export type AiStepSummary = Omit<AiStepRow, 'promptText' | 'responseText'>;

export interface ProviderSettings {
  configured: boolean;
  masked: string | null; // '...abcd'
  baseUrl: string | null; // vendor default when null; not masked
}

/**
 * What a given LLM call is for — mirrors cli/lib/llm.ts's `PURPOSE_TIERS`
 * keys one-for-one; that file imports this type rather than redeclaring it,
 * so the wire shape and the resolution policy can never drift apart.
 */
export type LLMPurpose =
  | 'generate'
  | 'edge-audit'
  | 'review'
  | 'review-extract'
  | 'brainstorm'
  | 'dispute'
  | 'probe'
  | 'calibrate';

/** The exact provider + model id a purpose resolves to right now (NEE-303). */
export interface ResolvedModel {
  provider: 'openai' | 'anthropic';
  model: string;
}

export interface SettingsInfo {
  openai: ProviderSettings;
  anthropic: ProviderSettings;
  defaultProvider: 'openai' | 'anthropic' | null;
  mockMode: boolean;
  /**
   * Per-purpose resolved provider/model (NEE-303), using the same resolution
   * a real call would (mock mode always resolves to 'openai', matching
   * `resolveProvider()` in cli/server/settings.ts) — what the UI shows
   * *before* invoking a paid action. Null when no provider can be resolved
   * (keyless, non-mock): no model would actually run.
   */
  models: Record<LLMPurpose, ResolvedModel> | null;
}

/**
 * POST /api/starter-pack — per-question outcome of copying the bundled
 * starter pack into the active workspace (NEE-301). Ids are "<category>/<slug>".
 */
export interface StarterPackInstallResult {
  /** Copied by this call. */
  installed: string[];
  /** Already present on disk; left exactly as they were. */
  skipped: string[];
  /** Missing from the packaged tree — a broken install, not a user error. */
  unavailable: string[];
}

/** POST /api/playground — the freshly-scaffolded scratch question (NEE-387). */
export interface PlaygroundCreateResult {
  category: string;
  slug: string;
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
  /**
   * The latest run whose outcome is knowable — status 'done' or
   * 'compile-error' (a still-running/errored/cancelled run never shadows
   * whatever finished before it). `status` lets table/list chips render a
   * compile failure distinctly instead of folding it into total/passed
   * (which would read as a vacuous, green "0/0 passed").
   */
  lastRun: { passed: number; total: number; at: string; status: 'done' | 'compile-error' } | null;
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

/**
 * One prose (behavioral story.md / design notes.md) solution file that
 * currently differs from its scaffold baseline — a 'full' reset would
 * overwrite it with scaffold content, destroying whatever was hand-written
 * (NEE-363). Coding solution files are deliberately excluded here: they get
 * a pre-reset 'reset'-trigger snapshot too, but this list exists to name the
 * hand-written prose at risk in words the confirmation dialog can show.
 */
export interface AtRiskProseFile {
  category: string;
  slug: string;
  title: string;
  relPath: string;
}

/** 200 response of `GET /api/workspace/reset-preview` (NEE-363) — read-only;
 * `progress` mode never touches solution files on disk, so this list only
 * matters ahead of a 'full' reset. */
export interface WorkspaceResetPreview {
  atRiskProse: AtRiskProseFile[];
}

/**
 * One remembered workspace mount (NEE-164) — an entry of
 * `GET /api/workspace/recents`, newest-first.
 */
export interface RecentWorkspace {
  root: string;
  lastOpenedAt: string;
}

/** 200 response of `POST /api/workspace/switch` (NEE-164). */
export interface WorkspaceSwitchResult {
  workspaceRoot: string;
  epoch: string;
  workspace: WorkspaceInfo;
}

// ---------------------------------------------------------------------------
// Live preview (NEE-348) — the per-workspace Vite dev server behind the ace
// server. `GET /api/preview` returns the current PreviewStatus; `POST
// /api/preview/open` lazily starts the server and resolves with the terminal
// status ('ready' or 'failed').
// ---------------------------------------------------------------------------

export type PreviewState = 'stopped' | 'starting' | 'ready' | 'failed';

export interface PreviewStatus {
  state: PreviewState;
  /**
   * Base origin of the dev server (`http://127.0.0.1:<port>`) when state is
   * 'ready', null otherwise. The preview pane loads
   * `${url}/preview/<category>/<slug>/` in its iframe.
   */
  url: string | null;
  /** Human-readable failure reason when state is 'failed', null otherwise. */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Live preview console forwarding (NEE-351) — the postMessage payload the
// preview iframe harness (cli/server/preview-harness.ts's error-forwarding
// section) sends to the parent window, and ui/src/hooks/usePreviewConsole.ts
// receives. UNTRUSTED: the iframe runs LLM-generated + user-written code, so
// the receiving hook re-validates every field's shape at runtime (this type
// only documents the contract both sides aim for) before anything here is
// rendered — as plain text, never markup.
// ---------------------------------------------------------------------------

/** The closed set of preview console kinds. Exported as a runtime value so the
 * postMessage receiver can drop any kind outside it (NEE-351: the iframe is
 * untrusted, so an unrecognised message is discarded, not rendered). Keep in
 * lockstep with the union below. */
export const PREVIEW_CONSOLE_KINDS = [
  'console-log',
  'console-warn',
  'console-error',
  'window-error',
  'unhandled-rejection',
  'vite-error',
  'rate-limited',
] as const;

export type PreviewConsoleKind = (typeof PREVIEW_CONSOLE_KINDS)[number];

export interface PreviewConsoleMessage {
  source: 'ace-preview';
  kind: PreviewConsoleKind;
  text: string;
  /** Set only for 'vite-error' (a transform/syntax failure) — mirrors the
   * file/line a vitest compile-error already carries baked into its own
   * `errorMessage` prose, so both presentations line up. */
  file: string | null;
  line: number | null;
}

// ---------------------------------------------------------------------------
// SSE events — sent on GET /api/events. `event:` field is the name below,
// `data:` is the JSON payload.
// ---------------------------------------------------------------------------

export interface SseEventMap {
  /**
   * Sent once per SSE connection. `workspaceRoot`/`epoch` are null while the
   * server is unmounted (picker mode, NEE-164). A reconnecting tab compares
   * both against what it first saw: a different epoch means a workspace
   * reset happened while it was disconnected; a different root means a
   * workspace switch did.
   */
  hello: { version: string; workspaceRoot: string | null; epoch: string | null };
  /** A file on disk changed. Since NEE-359 the watcher broadcasts this
   * unconditionally — an external editor (VS Code etc.), a server-side append
   * (probes/dispute), and a tab's own PUT all emit it. Each client suppresses
   * its own echo locally via `hash === savedHash`, which is per-tab correct. */
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
  /**
   * The SERVER closed an attempt on its own (NEE-356). Only prose
   * categories (design/behavioral, `testFiles: []`) produce this: they have
   * no test run for the client to watch, so the review completing IS the
   * end of the attempt — no client-side signal exists for that moment. The
   * Room reloads on it and lets the server re-derive the room's mode
   * (readonly reference vs. a fresh attempt), rather than keeping a second
   * copy of the solved rule in the SPA.
   */
  'attempt-ended': { attemptId: string; questionId: string; attempt: AttemptRow };
  'review-started': { jobId: string; questionId: string; kind: 'code' | 'design' | 'behavioral' };
  'review-chunk': { jobId: string; chunk: string };
  'review-done': { jobId: string; questionId: string; review: ReviewRow };
  'review-error': { jobId: string; questionId: string; message: string };
  'dispute-started': { disputeJobId: string; questionId: string; testRunId: string };
  'dispute-done': { disputeJobId: string; questionId: string; dispute: DisputeRow };
  'dispute-error': { disputeJobId: string; questionId: string; message: string };
  /**
   * Follow-up probes (NEE-345). Deliberately no `probes-chunk` — one paid
   * structured call, no streaming surface: see cli/server/probes.ts.
   */
  'probes-started': { probeJobId: string; questionId: string };
  'probes-done': { probeJobId: string; questionId: string; probeSet: ProbeSetRow };
  'probes-error': { probeJobId: string; questionId: string; message: string };
  /**
   * Live preview lifecycle (NEE-348). The full status object every time —
   * the pane renders whatever arrives (starting spinner, ready iframe,
   * failure reason, stopped placeholder) without needing a follow-up fetch.
   */
  'preview-status': PreviewStatus;
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
    phase: 'generating' | 'auditing' | 'calibrating' | 'verifying' | 'repairing';
    attempt: number;
  };
  'generation-done': { jobId: string; question: QuestionRow };
  'generation-error': { jobId: string; message: string };
  /**
   * AI activity log (NEE-268). Step responses stream as coalesced per-key
   * text ops; prompts NEVER ride SSE (multi-KB × every connected tab) —
   * clients fetch the full step on demand. `withheldKeys` arrives on
   * ai-step-started so the `█ withheld █` lines can render while the stream
   * is still filling. Every step- and run-level event repeats the owning
   * run's `refId` so refId-filtered feeds (the per-job drawer, NEE-272) can
   * drop foreign events statelessly instead of accumulating them.
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
   * Emitted once, after the new session is live, at the end of a workspace
   * reset. `requestId` echoes back whatever the initiating
   * `POST /api/workspace/reset` request sent (or a server-minted fallback if
   * it sent none) — clients use it to recognize "this is the broadcast for
   * MY request" and distinguish it from a reset some other tab triggered,
   * which matters because the SSE broadcast and the POST's own HTTP response
   * race independently and can arrive in either order.
   */
  'workspace-reset': { mode: WorkspaceResetMode; archivedTo: string; requestId: string };
  /**
   * Emitted once after a workspace switch swaps the new session live
   * (NEE-164), with the same `requestId` echo contract as `workspace-reset`.
   * Every tab whose first-seen root differs — the initiator included —
   * responds with a full page reload: the hard reset is what guarantees no
   * per-workspace cache (or Monaco model) survives into the new workspace.
   */
  'workspace-switched': { workspaceRoot: string; epoch: string; requestId: string };
}

export type SseEventName = keyof SseEventMap;
