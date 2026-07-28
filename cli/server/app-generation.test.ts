// @vitest-environment node
//
// Route-level tests for the generation job endpoints (POST/GET
// /api/generation/jobs, GET /api/generation/jobs/:id, POST
// /api/generation/jobs/:id/retry). Mirrors app-session.test.ts's pattern: a
// real Hono app + real Request/Response over a real (temp-dir) db, with a
// FAKE generation engine injected via EngineFactories so no LLM call or real
// job pipeline ever runs — only the route's own validation/gating logic is
// under test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from './sse.js';
import { createWorkspaceSession, type WorkspaceSession } from './session.js';
import {
  fakeEngines,
  makeApp,
  makeWorkspace,
  setKeyless,
  setProviderConfigured,
  type WorkspaceHandle,
} from './test-support.js';
import type { BrainstormSessionRow, GenerationJobRow } from './types.js';

let ws: WorkspaceHandle;

function buildSession(
  runningCount: () => number = () => 0,
  /** sessionId considered "thinking" (isThinking(id) === true), or null for none. */
  thinkingSessionId: string | null = null,
): WorkspaceSession {
  ws = makeWorkspace('app-generation', {
    engines: fakeEngines({
      generation: {
        runningCount: vi.fn(runningCount),
        isAnyRunning: vi.fn(() => runningCount() > 0),
      },
      brainstorm: {
        isThinking: vi.fn((id: string) => id === thinkingSessionId),
        isAnyRunning: vi.fn(() => thinkingSessionId != null),
      },
    }),
  });
  return ws.session;
}

beforeEach(() => {
  setKeyless();
  buildSession();
});

afterEach(() => {
  ws.cleanup();
});

function buildApp() {
  return makeApp({ getWorkspaceRoot: () => ws.root, getSession: () => ws.session }).fetch;
}

function postJson(fetch: ReturnType<typeof buildApp>, url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/generation/jobs', () => {
  it('202s with a jobId on the happy path (provider configured, under the cap)', async () => {
    setProviderConfigured();
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/generation/jobs', {
      category: 'js-ts',
      difficulty: 'medium',
      topic: 'closures and debouncing',
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe('fake-started-job-id');
  });

  it('400s on an invalid category', async () => {
    setProviderConfigured();
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/generation/jobs', {
      category: 'not-a-real-category',
      difficulty: 'medium',
      topic: 'anything',
    });
    expect(res.status).toBe(400);
  });

  it('400s on an invalid difficulty', async () => {
    setProviderConfigured();
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/generation/jobs', {
      category: 'js-ts',
      difficulty: 'impossible',
      topic: 'anything',
    });
    expect(res.status).toBe(400);
  });

  it('400s on an empty topic', async () => {
    setProviderConfigured();
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/generation/jobs', {
      category: 'js-ts',
      difficulty: 'medium',
      topic: '',
    });
    expect(res.status).toBe(400);
  });

  it('400s on a topic over 4000 characters', async () => {
    setProviderConfigured();
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/generation/jobs', {
      category: 'js-ts',
      difficulty: 'medium',
      topic: 'x'.repeat(4001),
    });
    expect(res.status).toBe(400);
  });

  it('400s when brainstormSessionId is not a string', async () => {
    setProviderConfigured();
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/generation/jobs', {
      category: 'js-ts',
      difficulty: 'medium',
      topic: 'anything',
      brainstormSessionId: 42,
    });
    expect(res.status).toBe(400);
  });

  it('404s on an unknown brainstormSessionId', async () => {
    setProviderConfigured();
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/generation/jobs', {
      category: 'js-ts',
      difficulty: 'medium',
      topic: 'anything',
      brainstormSessionId: 'does-not-exist',
    });
    expect(res.status).toBe(404);
  });

  it('accepts a real brainstormSessionId', async () => {
    setProviderConfigured();
    const bsession = ws.session.db.createBrainstormSession('build me a hard react question');
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/generation/jobs', {
      category: 'js-ts',
      difficulty: 'medium',
      topic: 'anything',
      brainstormSessionId: bsession.id,
    });
    expect(res.status).toBe(202);
  });

  it('409s when three generations are already running', async () => {
    setProviderConfigured();
    ws.cleanup();
    buildSession(() => 3);
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/generation/jobs', {
      category: 'js-ts',
      difficulty: 'medium',
      topic: 'anything',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/three generations are already running/);
  });

  it('503s when no LLM provider is configured', async () => {
    // setKeyless() already ran in beforeEach; no setProviderConfigured() here.
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/generation/jobs', {
      category: 'js-ts',
      difficulty: 'medium',
      topic: 'anything',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no LLM API key configured/);
  });
});

describe('GET /api/generation/jobs', () => {
  it('lists jobs, default limit', async () => {
    ws.session.db.createGenerationJob({ category: 'js-ts', difficulty: 'easy', topic: 'a' });
    ws.session.db.createGenerationJob({ category: 'js-ts', difficulty: 'medium', topic: 'b' });
    const fetch = buildApp();
    const res = await fetch('/api/generation/jobs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: GenerationJobRow[] };
    expect(body.jobs.length).toBe(2);
  });

  it('respects an explicit limit', async () => {
    ws.session.db.createGenerationJob({ category: 'js-ts', difficulty: 'easy', topic: 'a' });
    ws.session.db.createGenerationJob({ category: 'js-ts', difficulty: 'medium', topic: 'b' });
    ws.session.db.createGenerationJob({ category: 'js-ts', difficulty: 'hard', topic: 'c' });
    const fetch = buildApp();
    const res = await fetch('/api/generation/jobs?limit=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: GenerationJobRow[] };
    expect(body.jobs.length).toBe(1);
  });

  it('caps an oversized limit at 100', async () => {
    const spy = vi.spyOn(ws.session.db, 'listGenerationJobs');
    const fetch = buildApp();
    const res = await fetch('/api/generation/jobs?limit=9000');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(100);
  });

  it('400s on a non-positive limit', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/generation/jobs?limit=0');
    expect(res.status).toBe(400);
  });
});

describe('generation-job result redaction', () => {
  it('strips referenceSolution/interviewerPacket/solutionCode from both job routes', async () => {
    const job = ws.session.db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'secrets',
    });
    ws.session.db.patchGenerationJob(job.id, {
      status: 'llm_done',
      result: {
        title: 'T',
        description: 'visible',
        testCode: 'visible tests',
        referenceSolution: 'SECRET_REFERENCE',
        interviewerPacket: 'SECRET_PACKET',
        solutionCode: 'SECRET_SOLUTION',
      },
    });
    const fetch = buildApp();

    const listRes = await fetch('/api/generation/jobs');
    const listBody = JSON.stringify(await listRes.json());
    expect(listBody).toContain('visible tests');
    expect(listBody).not.toContain('SECRET_REFERENCE');
    expect(listBody).not.toContain('SECRET_PACKET');
    expect(listBody).not.toContain('SECRET_SOLUTION');

    const oneRes = await fetch(`/api/generation/jobs/${job.id}`);
    const oneBody = JSON.stringify(await oneRes.json());
    expect(oneBody).toContain('visible tests');
    expect(oneBody).not.toContain('SECRET_REFERENCE');
    expect(oneBody).not.toContain('SECRET_PACKET');
    expect(oneBody).not.toContain('SECRET_SOLUTION');

    // The db row itself keeps the full result — retry's scaffold-only
    // resume depends on it. Only the API boundary redacts.
    const stored = ws.session.db.getGenerationJob(job.id)!;
    expect((stored.result as { referenceSolution?: string }).referenceSolution).toBe(
      'SECRET_REFERENCE',
    );
  });

  it('nulls rawText on both job routes — failure reports and raw model output are answer key (NEE-265)', async () => {
    const job = ws.session.db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'raw leak',
    });
    ws.session.db.patchGenerationJob(job.id, {
      status: 'error',
      errorMessage: 'generated tests could not be verified after 3 attempts — ✕ suite › test',
      rawText: '✕ suite › test\nSECRET_FAILURE_DETAIL: expected the reference output',
    });
    const fetch = buildApp();

    const listRes = await fetch('/api/generation/jobs');
    const listBody = (await listRes.json()) as { jobs: GenerationJobRow[] };
    expect(listBody.jobs[0].rawText).toBeNull();
    expect(JSON.stringify(listBody)).not.toContain('SECRET_FAILURE_DETAIL');

    const oneRes = await fetch(`/api/generation/jobs/${job.id}`);
    const oneBody = (await oneRes.json()) as { job: GenerationJobRow };
    expect(oneBody.job.rawText).toBeNull();
    expect(JSON.stringify(oneBody)).not.toContain('SECRET_FAILURE_DETAIL');

    // The db row keeps it — retry's scaffold-only resume and salvage
    // debugging depend on the un-redacted row.
    expect(ws.session.db.getGenerationJob(job.id)!.rawText).toContain('SECRET_FAILURE_DETAIL');
  });
});

describe('GET /api/generation/jobs/:id', () => {
  it('returns the job', async () => {
    const job = ws.session.db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'a',
    });
    const fetch = buildApp();
    const res = await fetch(`/api/generation/jobs/${job.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: GenerationJobRow };
    expect(body.job.id).toBe(job.id);
  });

  it('404s on an unknown id', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/generation/jobs/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/generation/jobs/:id/retry', () => {
  it('404s on an unknown id', async () => {
    setProviderConfigured();
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/generation/jobs/does-not-exist/retry', {});
    expect(res.status).toBe(404);
  });

  it("409s when the job isn't in an error state", async () => {
    setProviderConfigured();
    const job = ws.session.db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'a',
    }); // status defaults to 'running'
    const fetch = buildApp();
    const res = await postJson(fetch, `/api/generation/jobs/${job.id}/retry`, {});
    expect(res.status).toBe(409);
  });

  it('409s when three generations are already running (cap applies to retries too)', async () => {
    setProviderConfigured();
    ws.cleanup();
    buildSession(() => 3);
    const job = ws.session.db.createGenerationJob({ category: 'js-ts', difficulty: 'easy', topic: 'a' });
    const errored = ws.session.db.patchGenerationJob(job.id, {
      status: 'error',
      errorMessage: 'boom',
    });
    const fetch = buildApp();
    const res = await postJson(fetch, `/api/generation/jobs/${errored.id}/retry`, {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/three generations are already running/);
  });

  it('202s (full re-run branch) when a provider is configured', async () => {
    setProviderConfigured();
    const job = ws.session.db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'a',
    });
    const errored = ws.session.db.patchGenerationJob(job.id, {
      status: 'error',
      errorMessage: 'boom',
    });
    expect(errored.result).toBeNull();
    const fetch = buildApp();
    const res = await postJson(fetch, `/api/generation/jobs/${job.id}/retry`, {});
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe(job.id);
  });

  it('503s (full re-run branch) when no provider is configured', async () => {
    // keyless (setKeyless() ran in beforeEach; no setProviderConfigured())
    const job = ws.session.db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'a',
    });
    const errored = ws.session.db.patchGenerationJob(job.id, {
      status: 'error',
      errorMessage: 'boom',
    });
    expect(errored.result).toBeNull();
    const fetch = buildApp();
    const res = await postJson(fetch, `/api/generation/jobs/${job.id}/retry`, {});
    expect(res.status).toBe(503);
  });

  it('202s scaffold-only (result already present) even with no provider configured', async () => {
    // keyless — proves the 503 gate is skipped when job.result is already there.
    const job = ws.session.db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'a',
    });
    ws.session.db.patchGenerationJob(job.id, {
      status: 'llm_done',
      result: { title: 'Some Question' },
      title: 'Some Question',
    });
    const errored = ws.session.db.patchGenerationJob(job.id, {
      status: 'error',
      errorMessage: 'scaffold write failed',
    });
    expect(errored.result).not.toBeNull();
    const fetch = buildApp();
    const res = await postJson(fetch, `/api/generation/jobs/${job.id}/retry`, {});
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe(job.id);
  });
});

describe('POST /api/brainstorm/turns', () => {
  it('202s with a sessionId on the happy path (new session, provider configured)', async () => {
    setProviderConfigured();
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/brainstorm/turns', {
      message: 'give me some react ideas',
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toBe('fake-started-session-id');
  });

  it('202s with the same sessionId on a follow-up turn to an existing session', async () => {
    setProviderConfigured();
    const bsession = ws.session.db.createBrainstormSession('first message');
    ws.session.db.setBrainstormStatus(bsession.id, 'idle');
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/brainstorm/turns', {
      sessionId: bsession.id,
      message: 'make it harder',
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toBe(bsession.id);
  });

  it('400s on a missing/empty message', async () => {
    setProviderConfigured();
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/brainstorm/turns', { message: '' });
    expect(res.status).toBe(400);
  });

  it('400s on a message over 4000 characters', async () => {
    setProviderConfigured();
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/brainstorm/turns', { message: 'x'.repeat(4001) });
    expect(res.status).toBe(400);
  });

  it('400s when sessionId is not a string', async () => {
    setProviderConfigured();
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/brainstorm/turns', {
      sessionId: 42,
      message: 'anything',
    });
    expect(res.status).toBe(400);
  });

  it('404s on an unknown sessionId', async () => {
    setProviderConfigured();
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/brainstorm/turns', {
      sessionId: 'does-not-exist',
      message: 'anything',
    });
    expect(res.status).toBe(404);
  });

  it('409s when the target session is already thinking', async () => {
    setProviderConfigured();
    // A session's id is only known once created, but the fake brainstorm
    // engine's thinkingSessionId is baked in at session-construction time —
    // so seed the row against the existing (real) db first, then rebuild
    // the WorkspaceSession over the SAME db file with a fake engine that
    // treats exactly that id as "thinking" (isThinking is engine state, not
    // read from the db's own status column).
    const seeded = ws.session.db.createBrainstormSession('first message');
    ws.session.db.close();
    ws.session = createWorkspaceSession({
      workspaceRoot: ws.root,
      bus: createBus(),
      watch: false,
      engines: fakeEngines({
        brainstorm: {
          isThinking: vi.fn((id: string) => id === seeded.id),
          isAnyRunning: vi.fn(() => true),
        },
      }),
    });
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/brainstorm/turns', {
      sessionId: seeded.id,
      message: 'anything',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already running for this session/);
  });

  it('503s when no LLM provider is configured', async () => {
    // setKeyless() already ran in beforeEach; no setProviderConfigured() here.
    const fetch = buildApp();
    const res = await postJson(fetch, '/api/brainstorm/turns', { message: 'anything' });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no LLM API key configured/);
  });
});

describe('GET /api/brainstorm/sessions', () => {
  it('lists sessions as {id,title,status,updatedAt} summaries, default limit', async () => {
    ws.session.db.createBrainstormSession('idea one');
    ws.session.db.createBrainstormSession('idea two');
    const fetch = buildApp();
    const res = await fetch('/api/brainstorm/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ id: string; title: string; status: string; updatedAt: string }>;
    };
    expect(body.sessions.length).toBe(2);
    const summary = body.sessions[0];
    expect(Object.keys(summary).sort()).toEqual(['id', 'status', 'title', 'updatedAt'].sort());
  });

  it('respects an explicit limit', async () => {
    ws.session.db.createBrainstormSession('a');
    ws.session.db.createBrainstormSession('b');
    ws.session.db.createBrainstormSession('c');
    const fetch = buildApp();
    const res = await fetch('/api/brainstorm/sessions?limit=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions.length).toBe(1);
  });

  it('caps an oversized limit at 100', async () => {
    const spy = vi.spyOn(ws.session.db, 'listBrainstormSessions');
    const fetch = buildApp();
    const res = await fetch('/api/brainstorm/sessions?limit=9000');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(100);
  });

  it('400s on a non-positive limit', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/brainstorm/sessions?limit=0');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/brainstorm/sessions/:id', () => {
  it('returns the full session (messages included)', async () => {
    const bsession = ws.session.db.createBrainstormSession('idea one');
    const fetch = buildApp();
    const res = await fetch(`/api/brainstorm/sessions/${bsession.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: BrainstormSessionRow };
    expect(body.session.id).toBe(bsession.id);
    expect(body.session.messages.length).toBe(1);
  });

  it('404s on an unknown id', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/brainstorm/sessions/does-not-exist');
    expect(res.status).toBe(404);
  });
});
