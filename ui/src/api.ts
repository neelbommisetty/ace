import type {
  AiRunKind,
  AiRunRow,
  AiStepRow,
  AiStepSummary,
  AttemptEventRow,
  AttemptEventType,
  AttemptRow,
  BrainstormSessionRow,
  BrainstormSessionStatus,
  DisputeRow,
  GenerationJobRow,
  HistoryItem,
  ImportPreviewItem,
  ImportResult,
  LLMSlot,
  PlaygroundCreateResult,
  PreviewStatus,
  ProbeSetRow,
  QuestionDetail,
  QuestionRow,
  QuestionWithStats,
  RecentWorkspace,
  ReviewRow,
  SettingsInfo,
  SnapshotRow,
  StarterPackInstallResult,
  TestRunRow,
  TestRunTrigger,
  WorkspaceInfo,
  WorkspaceResetMode,
  WorkspaceResetPreview,
  WorkspaceResetResult,
  WorkspaceSwitchResult,
} from './types';

// Token bootstrap (module init): ?t= → localStorage → strip from the URL.
// localStorage (not sessionStorage, NEE-308) so a second tab and a
// bookmarked bare URL both reuse the last-seen token instead of 401ing.
const TOKEN_KEY = 'ace-token';

const bootParams = new URLSearchParams(window.location.search);
const urlToken = bootParams.get('t');
if (urlToken) {
  localStorage.setItem(TOKEN_KEY, urlToken);
  bootParams.delete('t');
  const qs = bootParams.toString();
  history.replaceState(
    null,
    '',
    window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
  );
}

let token: string | null = localStorage.getItem(TOKEN_KEY);

export function getToken(): string | null {
  return token;
}

/**
 * The exact URL that will re-authenticate this tab, built from whatever
 * token is currently known (even one that just 401'd) — since the CLI now
 * persists its token across plain restarts (NEE-308), this is the correct
 * relaunch URL for the common case, and gives the "Token expired" screen
 * something more actionable than "go find the URL in the terminal".
 */
export function getRelaunchUrl(): string | null {
  if (!token) return null;
  return `${window.location.origin}${window.location.pathname}?t=${encodeURIComponent(token)}`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * Machine-readable discriminator from the error body, when the route
     * sends one. Two different 409s reach the file-save path — a stale
     * `savedHash` precondition ('stale-write', NEE-359) and a save aimed at a
     * workspace that has since been switched away ('workspace-changed',
     * NEE-164) — and they want different handling, so callers branch on this
     * rather than on the prose message.
     */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let unauthorizedHandler: (() => void) | null = null;

/** App registers this to swap in the "token expired" screen instead of crashing. */
export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn;
}

// Workspace root this tab is anchored to — App records the first SSE hello's
// root here (NEE-164). File writes carry it as `expectedRoot` so a save
// queued before/during a workspace switch (debounce timer, pagehide keepalive
// flush fired by the switch's own reload) is rejected by the server instead
// of silently landing in the newly mounted, unrelated workspace.
let workspaceAnchor: string | null = null;

export function setWorkspaceAnchor(root: string | null): void {
  workspaceAnchor = root;
}

/**
 * `savedHash` (NEE-359) is the disk hash this tab last saw for the file; the
 * server rejects the write with 409 `stale-write` when disk has moved on
 * since. Omit it to force the write (conflict resolution's "Keep mine").
 */
function fileWriteBody(
  relPath: string,
  content: string,
  savedHash?: string,
): Record<string, unknown> {
  return {
    path: relPath,
    content,
    ...(workspaceAnchor == null ? {} : { expectedRoot: workspaceAnchor }),
    ...(savedHash == null ? {} : { savedHash }),
  };
}

function doFetch(path: string, init: RequestInit | undefined, bearer: string | null): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${bearer ?? ''}`,
    },
  });
}

async function toApiError(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`;
  let code: string | null = null;
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    if (body && typeof body.error === 'string') message = body.error;
    if (body && typeof body.code === 'string') code = body.code;
  } catch {
    // non-JSON error body; keep the status text
  }
  return new ApiError(res.status, message, code);
}

/**
 * How long a file read/write may hang before it is treated as a failure
 * (NEE-358). Without this, a server that accepted the connection and then
 * stopped answering (suspended laptop, a wedged `ace ui`) left the editor
 * showing "saving…" forever — no error, no retry, and every keystroke since
 * living only in the browser buffer. Deliberately NOT applied to SSE or any
 * long-lived stream, which are supposed to stay open.
 */
const FILE_REQUEST_TIMEOUT_MS = 15_000;

async function requestOnce<T>(path: string, init?: RequestInit): Promise<T> {
  let res = await doFetch(path, init, token);
  if (res.status === 401) {
    // localStorage is shared across tabs of this origin: another tab may
    // have just completed a fresh `?t=` handshake (e.g. after the user
    // relaunched `ace ui` and opened the new URL there) and written a
    // different token in the time since this tab last read it. Retry once
    // against whatever is there NOW before giving up — this is what lets a
    // background tab recover without the user ever seeing "Token expired".
    const latest = localStorage.getItem(TOKEN_KEY);
    if (latest && latest !== token) {
      token = latest;
      res = await doFetch(path, init, token);
    }
  }
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) {
    throw await toApiError(res);
  }
  return (await res.json()) as T;
}

function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestOnce<T>(path, init);
}

/**
 * `request` with a deadline. A timeout surfaces as `ApiError(0, …, 'timeout')`
 * — status 0 because nothing was ever answered — which the caller can treat
 * as transient and retry, unlike a 4xx.
 */
async function requestWithTimeout<T>(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await requestOnce<T>(path, { ...init, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new ApiError(0, `the server did not respond within ${timeoutMs / 1000}s`, 'timeout');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const q = (s: string) => encodeURIComponent(s);

/** `/api/questions/<category>/<slug>` + optional suffix. */
function questionPath(category: string, slug: string, suffix = ''): string {
  return `/api/questions/${q(category)}/${q(slug)}${suffix}`;
}

/**
 * Fire-and-forget request for pagehide/unmount. sendBeacon cannot set the
 * Authorization header, so these use keepalive fetch with the query token.
 */
function keepalive(path: string, method: 'PATCH' | 'PUT', body: unknown): void {
  const sep = path.includes('?') ? '&' : '?';
  void fetch(`${path}${sep}t=${q(token ?? '')}`, {
    method,
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

/** Appends the defined params (insertion order) as a query string; `?` only when non-empty. */
function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export function getWorkspace(): Promise<WorkspaceInfo> {
  return request('/api/workspace');
}

export function getQuestions(): Promise<QuestionWithStats[]> {
  return request('/api/questions');
}

export function getQuestionDetail(category: string, slug: string): Promise<QuestionDetail> {
  return request(questionPath(category, slug));
}

/** Newest first, solution files only (never test files) — the Room Activity
 * tab's read-only "Past attempt code" list (NEE-363). */
export function getSnapshots(category: string, slug: string): Promise<SnapshotRow[]> {
  return request(questionPath(category, slug, '/snapshots'));
}

/** `content` is null when the blob is gone from disk — mirrors getReview's
 * snapshotContent nullability. */
export function getSnapshot(id: string): Promise<SnapshotRow & { content: string | null }> {
  return request(`/api/snapshots/${encodeURIComponent(id)}`);
}

/**
 * `attempt` is null when the question is solved and there's no active
 * attempt to resume — the server returns a readonly-mode response instead of
 * auto-creating a fresh attempt. `latestAttempt` (the ended attempt to base a
 * "Start new attempt" off of) is only present in that case.
 */
export function createOrResumeAttempt(
  category: string,
  slug: string,
): Promise<{ attempt: AttemptRow | null; readonly?: boolean; latestAttempt?: AttemptRow | null }> {
  return request(questionPath(category, slug, '/attempts'), { method: 'POST' });
}

export function getAttempt(
  id: string,
): Promise<{ attempt: AttemptRow; events: AttemptEventRow[] }> {
  return request(`/api/attempts/${encodeURIComponent(id)}`);
}

export function patchAttempt(
  id: string,
  patch: { activeSecondsDelta?: number; end?: { reason: string } },
): Promise<{ attempt: AttemptRow }> {
  return request(`/api/attempts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** Fire-and-forget active-seconds flush for pagehide/unmount. */
export function flushActiveSeconds(attemptId: string, delta: number): void {
  keepalive(`/api/attempts/${q(attemptId)}`, 'PATCH', { activeSecondsDelta: delta });
}

/**
 * Fire-and-forget attempt-end flush for pagehide. `reason` stays narrowed to
 * 'solved' — the only end reason the client may claim — and the server
 * re-verifies it from `test_runs`, so a stale or forged claim is harmless.
 */
export function flushAttemptEnd(attemptId: string, reason: 'solved'): void {
  keepalive(`/api/attempts/${q(attemptId)}`, 'PATCH', { end: { reason } });
}

export function postAttemptEvent(
  attemptId: string,
  type: AttemptEventType,
  payload?: Record<string, unknown>,
): Promise<{ event: AttemptEventRow }> {
  return request(`/api/attempts/${encodeURIComponent(attemptId)}/events`, {
    method: 'POST',
    body: JSON.stringify(payload ? { type, payload } : { type }),
  });
}

export function getResume(): Promise<
  { attempt: AttemptRow; question: QuestionRow } | { attempt: null }
> {
  return request('/api/resume');
}

export function getFile(relPath: string): Promise<{ path: string; content: string; hash: string }> {
  return requestWithTimeout(
    `/api/file?path=${encodeURIComponent(relPath)}`,
    undefined,
    FILE_REQUEST_TIMEOUT_MS,
  );
}

/**
 * Fire-and-forget file save for pagehide. Carries `savedHash` when the caller
 * knows it: an unload flush is exactly the case with no client left to see a
 * conflict banner, so it must not be the one write that silently clobbers
 * another tab's newer content.
 */
export function flushFileSave(relPath: string, content: string, savedHash?: string): void {
  keepalive('/api/file', 'PUT', fileWriteBody(relPath, content, savedHash));
}

export function putFile(
  relPath: string,
  content: string,
  opts?: { savedHash?: string },
): Promise<{ hash: string }> {
  return requestWithTimeout(
    '/api/file',
    {
      method: 'PUT',
      body: JSON.stringify(fileWriteBody(relPath, content, opts?.savedHash)),
    },
    FILE_REQUEST_TIMEOUT_MS,
  );
}

export function startTestRun(
  attemptId: string,
  trigger: TestRunTrigger,
): Promise<{ runId: string }> {
  return request(`/api/attempts/${encodeURIComponent(attemptId)}/test-runs`, {
    method: 'POST',
    body: JSON.stringify({ trigger }),
  });
}

export function getTestRuns(questionId: string, limit?: number): Promise<TestRunRow[]> {
  return request(withQuery('/api/test-runs', { questionId, limit }));
}

/** Stops an in-flight run (killTree + status 'cancelled') without starting a replacement. */
export function cancelTestRun(runId: string): Promise<{ ok: true }> {
  return request(`/api/test-runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
}

export function getImportPreview(): Promise<{ items: ImportPreviewItem[] }> {
  return request('/api/import/preview');
}

export function runImport(): Promise<ImportResult> {
  return request('/api/import/run', { method: 'POST' });
}

// ---- M2: reviews / disputes / history / settings ---------------------------

export function startReview(category: string, slug: string): Promise<{ jobId: string }> {
  return request(questionPath(category, slug, '/reviews'), {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function getReviews(category: string, slug: string): Promise<ReviewRow[]> {
  return request(questionPath(category, slug, '/reviews'));
}

/**
 * snapshotContent is present when the reviewed-code blob still exists on
 * disk. `question` is embedded (NEE-306) so a direct load of
 * /history/review/:id (including a reload) has everything the detail view
 * needs in one round trip.
 */
export function getReview(
  id: string,
): Promise<ReviewRow & { snapshotContent?: string | null; question: QuestionRow }> {
  return request(`/api/reviews/${encodeURIComponent(id)}`);
}

export function startDispute(
  runId: string,
  argument?: string,
): Promise<{ disputeJobId: string }> {
  return request(`/api/test-runs/${encodeURIComponent(runId)}/disputes`, {
    method: 'POST',
    body: JSON.stringify(argument ? { argument } : {}),
  });
}

export function getDisputes(category: string, slug: string): Promise<DisputeRow[]> {
  return request(questionPath(category, slug, '/disputes'));
}

export function applyDispute(id: string): Promise<{ dispute: DisputeRow }> {
  return request(`/api/disputes/${encodeURIComponent(id)}/apply`, { method: 'POST' });
}

/** `question` is embedded (NEE-306) — mirrors getReview's direct-load shape. */
export function getDispute(id: string): Promise<DisputeRow & { question: QuestionRow }> {
  return request(`/api/disputes/${encodeURIComponent(id)}`);
}

// ---- follow-up probes (NEE-345) ---------------------------------------------

export function startProbes(category: string, slug: string): Promise<{ probeJobId: string }> {
  return request(questionPath(category, slug, '/probes'), { method: 'POST' });
}

/**
 * Scoped to a single attempt (NEE-345 follow-up) — the server buckets by
 * exact `attemptId` equality (see hasProbeSetForAttempt), null included, so
 * `attemptId: null` here must omit the query param, not send the string
 * "null".
 */
export function getProbeSets(
  category: string,
  slug: string,
  attemptId: string | null,
): Promise<ProbeSetRow[]> {
  return request(withQuery(questionPath(category, slug, '/probes'), { attemptId: attemptId ?? undefined }));
}

export function startFreshAttempt(
  attemptId: string,
  resetToStub: boolean,
): Promise<{ attempt: AttemptRow }> {
  return request(`/api/attempts/${encodeURIComponent(attemptId)}/fresh`, {
    method: 'POST',
    body: JSON.stringify({ resetToStub }),
  });
}

export function getHistory(opts: {
  q?: string;
  category?: string;
  type?: 'review' | 'dispute';
  /** "<category>/<slug>" — server-side single-question filter */
  question?: string;
  limit?: number;
}): Promise<{ items: HistoryItem[] }> {
  return request(
    withQuery('/api/history', {
      q: opts.q || undefined,
      category: opts.category || undefined,
      type: opts.type,
      question: opts.question || undefined,
      limit: opts.limit,
    }),
  );
}

export function getSettings(): Promise<SettingsInfo> {
  return request('/api/settings');
}

export function putSettings(body: {
  openaiKey?: string;
  anthropicKey?: string;
  openaiBaseUrl?: string | null;
  anthropicBaseUrl?: string | null;
  defaultProvider?: 'openai' | 'anthropic';
  /** A model id sets an override for that slot, null clears it back to default. */
  models?: Partial<Record<LLMSlot, string | null>>;
}): Promise<SettingsInfo> {
  return request('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
}

// ---- starter pack (NEE-301) -------------------------------------------------

/**
 * Copies the bundled starter questions into the active workspace. Safe to
 * call twice — the server skips questions that already exist on disk.
 */
export function installStarterPack(): Promise<StarterPackInstallResult> {
  return request('/api/starter-pack', { method: 'POST' });
}

/** Which hand-written prose files a 'full' reset would overwrite right now
 * (NEE-363) — fetched before the confirmation dialog opens so it can name
 * what's actually at risk instead of a generic "solution files are reset"
 * line. */
export function getResetPreview(): Promise<WorkspaceResetPreview> {
  return request('/api/workspace/reset-preview');
}

export function resetWorkspace(
  mode: WorkspaceResetMode,
  confirm: string,
  requestId: string,
): Promise<WorkspaceResetResult> {
  return request('/api/workspace/reset', {
    method: 'POST',
    body: JSON.stringify({ mode, confirm, requestId }),
  });
}

// ---- workspace switching (NEE-164) ------------------------------------------

/** Reachable in picker mode too (exempt from the no-workspace 409 gate). */
export function getWorkspaceRecents(): Promise<{ recents: RecentWorkspace[] }> {
  return request('/api/workspace/recents');
}

export function switchWorkspace(root: string, requestId: string): Promise<WorkspaceSwitchResult> {
  return request('/api/workspace/switch', {
    method: 'POST',
    body: JSON.stringify({ root, requestId }),
  });
}

// ---- generation / brainstorm ------------------------------------------------

export function startGenerationJob(body: {
  category: string;
  difficulty: string;
  topic: string;
  brainstormSessionId?: string | null;
}): Promise<{ jobId: string }> {
  return request('/api/generation/jobs', { method: 'POST', body: JSON.stringify(body) });
}

export interface DebriefResponse {
  interviewerPacket: string | null;
  referenceSolution: string | null;
}

/** 404s (ApiError) until the question has at least one review. */
export function getDebrief(category: string, slug: string): Promise<DebriefResponse> {
  return request(questionPath(category, slug, '/debrief'));
}

export function getGenerationJobs(limit?: number): Promise<{ jobs: GenerationJobRow[] }> {
  return request(withQuery('/api/generation/jobs', { limit }));
}

export function getGenerationJob(id: string): Promise<{ job: GenerationJobRow }> {
  return request(`/api/generation/jobs/${encodeURIComponent(id)}`);
}

export function retryGenerationJob(id: string): Promise<{ jobId: string }> {
  return request(`/api/generation/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
}

export function sendBrainstormTurn(
  sessionId: string | null,
  message: string,
): Promise<{ sessionId: string }> {
  return request('/api/brainstorm/turns', {
    method: 'POST',
    body: JSON.stringify(sessionId != null ? { sessionId, message } : { message }),
  });
}

export function getBrainstormSession(id: string): Promise<{ session: BrainstormSessionRow }> {
  return request(`/api/brainstorm/sessions/${encodeURIComponent(id)}`);
}

export interface BrainstormSessionSummary {
  id: string;
  title: string;
  status: BrainstormSessionStatus;
  updatedAt: string;
}

export function getBrainstormSessions(
  limit?: number,
): Promise<{ sessions: BrainstormSessionSummary[] }> {
  return request(withQuery('/api/brainstorm/sessions', { limit }));
}

// ---- AI activity ------------------------------------------------------------

export function getAiRuns(
  opts: { limit?: number; kind?: AiRunKind; refId?: string } = {},
): Promise<{ runs: Array<AiRunRow & { steps: AiStepSummary[] }> }> {
  return request(
    withQuery('/api/ai/runs', {
      limit: opts.limit,
      kind: opts.kind,
      refId: opts.refId || undefined,
    }),
  );
}

export function getAiRun(id: string): Promise<{ run: AiRunRow; steps: AiStepSummary[] }> {
  return request(`/api/ai/runs/${encodeURIComponent(id)}`);
}

/** The ONLY route that returns promptText/responseText — fetched lazily on expand. */
export function getAiStep(id: string): Promise<{ step: AiStepRow }> {
  return request(`/api/ai/steps/${encodeURIComponent(id)}`);
}

// ---- question archive (NEE-296) --------------------------------------------

export function archiveQuestion(category: string, slug: string): Promise<{ question: QuestionRow }> {
  return request(questionPath(category, slug, '/archive'), { method: 'POST' });
}

export function unarchiveQuestion(
  category: string,
  slug: string,
): Promise<{ question: QuestionRow }> {
  return request(questionPath(category, slug, '/unarchive'), { method: 'POST' });
}

/** Starts a new generation job that revises `category`/`slug` with `feedback`
 * (NEE-386) — the source question is archived server-side once the
 * replacement is done. Returns the new job's id, same shape as a fresh /new
 * generation job. */
export function regenerateQuestion(
  category: string,
  slug: string,
  feedback: string,
): Promise<{ jobId: string }> {
  return request(questionPath(category, slug, '/regenerate'), {
    method: 'POST',
    body: JSON.stringify({ feedback }),
  });
}

// ---- live preview (NEE-348/NEE-349) ----------------------------------------

export function getPreviewStatus(): Promise<PreviewStatus> {
  return request('/api/preview');
}

/** Lazily starts the per-workspace preview dev server; idempotent while it's
 * already running. Resolves with the terminal status ('ready' or 'failed'). */
export function openPreview(): Promise<PreviewStatus> {
  return request('/api/preview/open', { method: 'POST' });
}

// ---- playground (NEE-387) --------------------------------------------------

/** Scaffolds a zero-LLM scratch question ('playground' or 'playground-ts') and returns where it landed. */
export function createPlayground(kind: 'react' | 'ts'): Promise<PlaygroundCreateResult> {
  return request('/api/playground', { method: 'POST', body: JSON.stringify({ kind }) });
}
