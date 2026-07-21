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
import type { GenerationJobRow } from './types.js';

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
function fakeEngines(runningCount: () => number = () => 0): EngineFactories {
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
      startTurn: vi.fn(),
      isThinking: vi.fn(() => false),
      isAnyRunning: vi.fn(() => false),
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createBrainstormEngine'],
  };
}

function buildSession(runningCount: () => number = () => 0): WorkspaceSession {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-app-generation-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  const bus = createBus();
  return createWorkspaceSession({
    workspaceRoot: tempRoot,
    bus,
    watch: false,
    engines: fakeEngines(runningCount),
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
