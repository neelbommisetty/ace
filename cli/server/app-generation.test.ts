// @vitest-environment node
//
// Route-level tests for the generation job endpoints (POST/GET
// /api/generation/jobs, GET /api/generation/jobs/:id, POST
// /api/generation/jobs/:id/retry). Mirrors app-session.test.ts's pattern: a
// real Hono app + real Request/Response over a real (temp-dir) db, with a
// FAKE generation engine injected via EngineFactories so no LLM call or real
// job pipeline ever runs — only the route's own validation/gating logic is
// under test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearConfigCache } from '../lib/llm.js';
import { createApp } from './app.js';
import { runImport, previewImport } from './importer.js';
import { createWorkspaceSession, type EngineFactories, type WorkspaceSession } from './session.js';
import { createBus } from './sse.js';
import type { BrainstormSessionRow, GenerationJobRow } from './types.js';

const TOKEN = 'test-token';

let tempRoot = '';
let tempHome = '';
let session: WorkspaceSession;
const originalEnv = { ...process.env };

/**
 * resolveProvider() (called directly by app.ts, not injectable) bottoms out
 * in lib/llm.js's getDefaultProvider(), which reads ~/.ace/config.json (via
 * getGlobalAceDir() -> process.env.HOME) and process.env.*_API_KEY, cached
 * at the module level until clearConfigCache() busts it. Pointing HOME at a
 * fresh, empty temp dir and clearing the two key env vars makes "no provider
 * configured" deterministic regardless of the real dev machine's ~/.ace —
 * same isolation technique as cli/lib/config.test.ts.
 */
function setKeyless(): void {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-generation-home-'));
  process.env.HOME = tempHome;
  delete process.env.USERPROFILE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ACE_E2E_MOCK_LLM;
  clearConfigCache();
}

/** Writes a fake (unvalidated — resolveProvider never validates) key so resolveProvider() is truthy. */
function setProviderConfigured(): void {
  const aceDir = path.join(tempHome, '.ace');
  fs.mkdirSync(aceDir, { recursive: true });
  fs.writeFileSync(
    path.join(aceDir, 'config.json'),
    JSON.stringify({ OPENAI_API_KEY: 'test-fake-key', default_provider: 'openai' }),
    'utf8',
  );
  clearConfigCache();
}

/** Fake engine factories — never touch the LLM or spawn vitest. */
function fakeEngines(
  runningCount: () => number = () => 0,
  /** sessionId considered "thinking" (isThinking(id) === true), or null for none. */
  thinkingSessionId: string | null = null,
): EngineFactories {
  return {
    createRunner: (() => ({
      start: vi.fn(),
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createRunner'],
    createReviewEngine: (() => ({
      start: vi.fn(),
      isRunning: vi.fn(() => false),
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createReviewEngine'],
    createDisputeEngine: (() => ({
      start: vi.fn(),
      isRunning: vi.fn(() => false),
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createDisputeEngine'],
    createGenerationEngine: (() => ({
      start: vi.fn(() => ({ jobId: 'fake-started-job-id' })),
      retry: vi.fn((job: GenerationJobRow) => ({ jobId: job.id })),
      runningCount: vi.fn(runningCount),
      isAnyRunning: vi.fn(() => runningCount() > 0),
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createGenerationEngine'],
    createBrainstormEngine: (() => ({
      startTurn: vi.fn((sessionId: string | null) => ({
        sessionId: sessionId ?? 'fake-started-session-id',
      })),
      isThinking: vi.fn((id: string) => id === thinkingSessionId),
      isAnyRunning: vi.fn(() => thinkingSessionId != null),
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createBrainstormEngine'],
  };
}

function buildSession(
  runningCount: () => number = () => 0,
  thinkingSessionId: string | null = null,
): WorkspaceSession {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-app-generation-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  const bus = createBus();
  return createWorkspaceSession({
    workspaceRoot: tempRoot,
    bus,
    watch: false,
    engines: fakeEngines(runningCount, thinkingSessionId),
  });
}

beforeEach(() => {
  setKeyless();
  session = buildSession();
});

afterEach(() => {
  session.db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  process.env = { ...originalEnv };
  clearConfigCache();
});

function buildApp() {
  const bus = createBus();
  return createApp({
    bus,
    workspaceRoot: tempRoot,
    token: TOKEN,
    uiDir: null,
    version: '0.0.0-test',
    importer: { previewImport, runImport },
    getSession: () => session,
  });
}

/** See app-session.test.ts's identical helper for why `Host` is set explicitly. */
function request(app: ReturnType<typeof buildApp>, url: string, init: RequestInit = {}) {
  return app.request(url, {
    ...init,
    headers: { host: 'localhost', ...(init.headers as Record<string, string> | undefined) },
  });
}

function postJson(app: ReturnType<typeof buildApp>, url: string, body: unknown) {
  return request(app, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/generation/jobs', () => {
  it('202s with a jobId on the happy path (provider configured, under the cap)', async () => {
    setProviderConfigured();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs?t=${TOKEN}`, {
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
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs?t=${TOKEN}`, {
      category: 'not-a-real-category',
      difficulty: 'medium',
      topic: 'anything',
    });
    expect(res.status).toBe(400);
  });

  it('400s on an invalid difficulty', async () => {
    setProviderConfigured();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs?t=${TOKEN}`, {
      category: 'js-ts',
      difficulty: 'impossible',
      topic: 'anything',
    });
    expect(res.status).toBe(400);
  });

  it('400s on an empty topic', async () => {
    setProviderConfigured();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs?t=${TOKEN}`, {
      category: 'js-ts',
      difficulty: 'medium',
      topic: '',
    });
    expect(res.status).toBe(400);
  });

  it('400s on a topic over 4000 characters', async () => {
    setProviderConfigured();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs?t=${TOKEN}`, {
      category: 'js-ts',
      difficulty: 'medium',
      topic: 'x'.repeat(4001),
    });
    expect(res.status).toBe(400);
  });

  it('400s when brainstormSessionId is not a string', async () => {
    setProviderConfigured();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs?t=${TOKEN}`, {
      category: 'js-ts',
      difficulty: 'medium',
      topic: 'anything',
      brainstormSessionId: 42,
    });
    expect(res.status).toBe(400);
  });

  it('404s on an unknown brainstormSessionId', async () => {
    setProviderConfigured();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs?t=${TOKEN}`, {
      category: 'js-ts',
      difficulty: 'medium',
      topic: 'anything',
      brainstormSessionId: 'does-not-exist',
    });
    expect(res.status).toBe(404);
  });

  it('accepts a real brainstormSessionId', async () => {
    setProviderConfigured();
    const bsession = session.db.createBrainstormSession('build me a hard react question');
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs?t=${TOKEN}`, {
      category: 'js-ts',
      difficulty: 'medium',
      topic: 'anything',
      brainstormSessionId: bsession.id,
    });
    expect(res.status).toBe(202);
  });

  it('409s when three generations are already running', async () => {
    setProviderConfigured();
    session.db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    session = buildSession(() => 3);
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs?t=${TOKEN}`, {
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
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs?t=${TOKEN}`, {
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
    session.db.createGenerationJob({ category: 'js-ts', difficulty: 'easy', topic: 'a' });
    session.db.createGenerationJob({ category: 'js-ts', difficulty: 'medium', topic: 'b' });
    const app = buildApp();
    const res = await request(app, `http://localhost/api/generation/jobs?t=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: GenerationJobRow[] };
    expect(body.jobs.length).toBe(2);
  });

  it('respects an explicit limit', async () => {
    session.db.createGenerationJob({ category: 'js-ts', difficulty: 'easy', topic: 'a' });
    session.db.createGenerationJob({ category: 'js-ts', difficulty: 'medium', topic: 'b' });
    session.db.createGenerationJob({ category: 'js-ts', difficulty: 'hard', topic: 'c' });
    const app = buildApp();
    const res = await request(app, `http://localhost/api/generation/jobs?t=${TOKEN}&limit=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: GenerationJobRow[] };
    expect(body.jobs.length).toBe(1);
  });

  it('caps an oversized limit at 100', async () => {
    const spy = vi.spyOn(session.db, 'listGenerationJobs');
    const app = buildApp();
    const res = await request(app, `http://localhost/api/generation/jobs?t=${TOKEN}&limit=9000`);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(100);
  });

  it('400s on a non-positive limit', async () => {
    const app = buildApp();
    const res = await request(app, `http://localhost/api/generation/jobs?t=${TOKEN}&limit=0`);
    expect(res.status).toBe(400);
  });
});

describe('generation-job result redaction', () => {
  it('strips referenceSolution/interviewerPacket/solutionCode from both job routes', async () => {
    const job = session.db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'secrets',
    });
    session.db.patchGenerationJob(job.id, {
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
    const app = buildApp();

    const listRes = await request(app, `http://localhost/api/generation/jobs?t=${TOKEN}`);
    const listBody = JSON.stringify(await listRes.json());
    expect(listBody).toContain('visible tests');
    expect(listBody).not.toContain('SECRET_REFERENCE');
    expect(listBody).not.toContain('SECRET_PACKET');
    expect(listBody).not.toContain('SECRET_SOLUTION');

    const oneRes = await request(app, `http://localhost/api/generation/jobs/${job.id}?t=${TOKEN}`);
    const oneBody = JSON.stringify(await oneRes.json());
    expect(oneBody).toContain('visible tests');
    expect(oneBody).not.toContain('SECRET_REFERENCE');
    expect(oneBody).not.toContain('SECRET_PACKET');
    expect(oneBody).not.toContain('SECRET_SOLUTION');

    // The db row itself keeps the full result — retry's scaffold-only
    // resume depends on it. Only the API boundary redacts.
    const stored = session.db.getGenerationJob(job.id)!;
    expect((stored.result as { referenceSolution?: string }).referenceSolution).toBe(
      'SECRET_REFERENCE',
    );
  });
});

describe('GET /api/generation/jobs/:id', () => {
  it('returns the job', async () => {
    const job = session.db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'a',
    });
    const app = buildApp();
    const res = await request(app, `http://localhost/api/generation/jobs/${job.id}?t=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: GenerationJobRow };
    expect(body.job.id).toBe(job.id);
  });

  it('404s on an unknown id', async () => {
    const app = buildApp();
    const res = await request(app, `http://localhost/api/generation/jobs/does-not-exist?t=${TOKEN}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/generation/jobs/:id/retry', () => {
  it('404s on an unknown id', async () => {
    setProviderConfigured();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs/does-not-exist/retry?t=${TOKEN}`, {});
    expect(res.status).toBe(404);
  });

  it("409s when the job isn't in an error state", async () => {
    setProviderConfigured();
    const job = session.db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'a',
    }); // status defaults to 'running'
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs/${job.id}/retry?t=${TOKEN}`, {});
    expect(res.status).toBe(409);
  });

  it('409s when three generations are already running (cap applies to retries too)', async () => {
    setProviderConfigured();
    session.db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    session = buildSession(() => 3);
    const job = session.db.createGenerationJob({ category: 'js-ts', difficulty: 'easy', topic: 'a' });
    const errored = session.db.patchGenerationJob(job.id, {
      status: 'error',
      errorMessage: 'boom',
    });
    const app = buildApp();
    const res = await postJson(
      app,
      `http://localhost/api/generation/jobs/${errored.id}/retry?t=${TOKEN}`,
      {},
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/three generations are already running/);
  });

  it('202s (full re-run branch) when a provider is configured', async () => {
    setProviderConfigured();
    const job = session.db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'a',
    });
    const errored = session.db.patchGenerationJob(job.id, {
      status: 'error',
      errorMessage: 'boom',
    });
    expect(errored.result).toBeNull();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs/${job.id}/retry?t=${TOKEN}`, {});
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe(job.id);
  });

  it('503s (full re-run branch) when no provider is configured', async () => {
    // keyless (setKeyless() ran in beforeEach; no setProviderConfigured())
    const job = session.db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'a',
    });
    const errored = session.db.patchGenerationJob(job.id, {
      status: 'error',
      errorMessage: 'boom',
    });
    expect(errored.result).toBeNull();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs/${job.id}/retry?t=${TOKEN}`, {});
    expect(res.status).toBe(503);
  });

  it('202s scaffold-only (result already present) even with no provider configured', async () => {
    // keyless — proves the 503 gate is skipped when job.result is already there.
    const job = session.db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'a',
    });
    session.db.patchGenerationJob(job.id, {
      status: 'llm_done',
      result: { title: 'Some Question' },
      title: 'Some Question',
    });
    const errored = session.db.patchGenerationJob(job.id, {
      status: 'error',
      errorMessage: 'scaffold write failed',
    });
    expect(errored.result).not.toBeNull();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/generation/jobs/${job.id}/retry?t=${TOKEN}`, {});
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe(job.id);
  });
});

describe('POST /api/brainstorm/turns', () => {
  it('202s with a sessionId on the happy path (new session, provider configured)', async () => {
    setProviderConfigured();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/brainstorm/turns?t=${TOKEN}`, {
      message: 'give me some react ideas',
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toBe('fake-started-session-id');
  });

  it('202s with the same sessionId on a follow-up turn to an existing session', async () => {
    setProviderConfigured();
    const bsession = session.db.createBrainstormSession('first message');
    session.db.setBrainstormStatus(bsession.id, 'idle');
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/brainstorm/turns?t=${TOKEN}`, {
      sessionId: bsession.id,
      message: 'make it harder',
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toBe(bsession.id);
  });

  it('400s on a missing/empty message', async () => {
    setProviderConfigured();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/brainstorm/turns?t=${TOKEN}`, {
      message: '',
    });
    expect(res.status).toBe(400);
  });

  it('400s on a message over 4000 characters', async () => {
    setProviderConfigured();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/brainstorm/turns?t=${TOKEN}`, {
      message: 'x'.repeat(4001),
    });
    expect(res.status).toBe(400);
  });

  it('400s when sessionId is not a string', async () => {
    setProviderConfigured();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/brainstorm/turns?t=${TOKEN}`, {
      sessionId: 42,
      message: 'anything',
    });
    expect(res.status).toBe(400);
  });

  it('404s on an unknown sessionId', async () => {
    setProviderConfigured();
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/brainstorm/turns?t=${TOKEN}`, {
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
    const seeded = session.db.createBrainstormSession('first message');
    session.db.close();
    session = createWorkspaceSession({
      workspaceRoot: tempRoot,
      bus: createBus(),
      watch: false,
      engines: fakeEngines(() => 0, seeded.id),
    });
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/brainstorm/turns?t=${TOKEN}`, {
      sessionId: seeded.id,
      message: 'anything',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already running for this session/);
  });

  it('503s when no LLM provider is configured', async () => {
    // setKeyless() already ran in beforeEach; no setProviderConfigured() here.
    const app = buildApp();
    const res = await postJson(app, `http://localhost/api/brainstorm/turns?t=${TOKEN}`, {
      message: 'anything',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no LLM API key configured/);
  });
});

describe('GET /api/brainstorm/sessions', () => {
  it('lists sessions as {id,title,status,updatedAt} summaries, default limit', async () => {
    session.db.createBrainstormSession('idea one');
    session.db.createBrainstormSession('idea two');
    const app = buildApp();
    const res = await request(app, `http://localhost/api/brainstorm/sessions?t=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ id: string; title: string; status: string; updatedAt: string }>;
    };
    expect(body.sessions.length).toBe(2);
    const summary = body.sessions[0];
    expect(Object.keys(summary).sort()).toEqual(['id', 'status', 'title', 'updatedAt'].sort());
  });

  it('respects an explicit limit', async () => {
    session.db.createBrainstormSession('a');
    session.db.createBrainstormSession('b');
    session.db.createBrainstormSession('c');
    const app = buildApp();
    const res = await request(app, `http://localhost/api/brainstorm/sessions?t=${TOKEN}&limit=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions.length).toBe(1);
  });

  it('caps an oversized limit at 100', async () => {
    const spy = vi.spyOn(session.db, 'listBrainstormSessions');
    const app = buildApp();
    const res = await request(app, `http://localhost/api/brainstorm/sessions?t=${TOKEN}&limit=9000`);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(100);
  });

  it('400s on a non-positive limit', async () => {
    const app = buildApp();
    const res = await request(app, `http://localhost/api/brainstorm/sessions?t=${TOKEN}&limit=0`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/brainstorm/sessions/:id', () => {
  it('returns the full session (messages included)', async () => {
    const bsession = session.db.createBrainstormSession('idea one');
    const app = buildApp();
    const res = await request(
      app,
      `http://localhost/api/brainstorm/sessions/${bsession.id}?t=${TOKEN}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: BrainstormSessionRow };
    expect(body.session.id).toBe(bsession.id);
    expect(body.session.messages.length).toBe(1);
  });

  it('404s on an unknown id', async () => {
    const app = buildApp();
    const res = await request(
      app,
      `http://localhost/api/brainstorm/sessions/does-not-exist?t=${TOKEN}`,
    );
    expect(res.status).toBe(404);
  });
});
