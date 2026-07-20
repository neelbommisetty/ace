import type {
  AttemptEventRow,
  AttemptEventType,
  AttemptRow,
  ImportPreviewItem,
  ImportResult,
  QuestionDetail,
  QuestionRow,
  QuestionWithStats,
  TestRunRow,
  TestRunTrigger,
  WorkspaceInfo,
} from './types';

// Token bootstrap (module init): ?t= → sessionStorage → strip from the URL.
const bootParams = new URLSearchParams(window.location.search);
const urlToken = bootParams.get('t');
if (urlToken) {
  sessionStorage.setItem('ace-token', urlToken);
  bootParams.delete('t');
  const qs = bootParams.toString();
  history.replaceState(
    null,
    '',
    window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
  );
}

const token: string | null = sessionStorage.getItem('ace-token');

export function getToken(): string | null {
  return token;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token ?? ''}`,
    },
  });
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export function getWorkspace(): Promise<WorkspaceInfo> {
  return request('/api/workspace');
}

export function getQuestions(): Promise<QuestionWithStats[]> {
  return request('/api/questions');
}

export function getQuestionDetail(category: string, slug: string): Promise<QuestionDetail> {
  return request(`/api/questions/${encodeURIComponent(category)}/${encodeURIComponent(slug)}`);
}

export function createOrResumeAttempt(
  category: string,
  slug: string,
): Promise<{ attempt: AttemptRow }> {
  return request(
    `/api/questions/${encodeURIComponent(category)}/${encodeURIComponent(slug)}/attempts`,
    { method: 'POST' },
  );
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

/**
 * Fire-and-forget active-seconds flush for pagehide/unmount. sendBeacon cannot
 * set the Authorization header, so use keepalive fetch with the query token.
 */
export function flushActiveSeconds(attemptId: string, delta: number): void {
  void fetch(
    `/api/attempts/${encodeURIComponent(attemptId)}?t=${encodeURIComponent(token ?? '')}`,
    {
      method: 'PATCH',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activeSecondsDelta: delta }),
    },
  ).catch(() => {});
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
  return request(`/api/file?path=${encodeURIComponent(relPath)}`);
}

/** Fire-and-forget file save for pagehide — same keepalive rationale as flushActiveSeconds. */
export function flushFileSave(relPath: string, content: string): void {
  void fetch(`/api/file?t=${encodeURIComponent(token ?? '')}`, {
    method: 'PUT',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: relPath, content }),
  }).catch(() => {});
}

export function putFile(relPath: string, content: string): Promise<{ hash: string }> {
  return request('/api/file', {
    method: 'PUT',
    body: JSON.stringify({ path: relPath, content }),
  });
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
  const qs = new URLSearchParams({ questionId });
  if (limit != null) qs.set('limit', String(limit));
  return request(`/api/test-runs?${qs.toString()}`);
}

export function getImportPreview(): Promise<{ items: ImportPreviewItem[] }> {
  return request('/api/import/preview');
}

export function runImport(): Promise<ImportResult> {
  return request('/api/import/run', { method: 'POST' });
}
