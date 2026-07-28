// @vitest-environment node
//
// Route-level tests for the AI activity read API (GET /api/ai/runs, GET
// /api/ai/runs/:id, GET /api/ai/steps/:id). Mirrors app-session.test.ts's
// pattern: a real Hono app + real Request/Response over a real (temp-dir) db
// with fake engines — the routes are read-only, so rows are seeded straight
// through the db.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { runImport, previewImport } from './importer.js';
import { createWorkspaceSession, type EngineFactories, type WorkspaceSession } from './session.js';
import { createBus } from './sse.js';
import type { AiRunRow, AiStepRow, AiStepSummary } from './types.js';

const TOKEN = 'test-token';

let tempRoot = '';
let session: WorkspaceSession;

/** Fake engine factories — never touch the LLM or spawn vitest. */
function fakeEngines(): EngineFactories {
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
      start: vi.fn(),
      retry: vi.fn(),
      runningCount: vi.fn(() => 0),
      isAnyRunning: vi.fn(() => false),
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

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-app-ai-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  const bus = createBus();
  session = createWorkspaceSession({
    workspaceRoot: tempRoot,
    bus,
    watch: false,
    engines: fakeEngines(),
  });
});

afterEach(() => {
  session.db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
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

/** Seeds one run with one step carrying the multi-KB text fields. */
function seedRunWithStep(opts: { refId?: string | null } = {}) {
  const run = session.db.createAiRun({
    kind: 'generation',
    refId: opts.refId ?? 'job-1',
    label: 'Generate: closures',
  });
  const step = session.db.createAiStep({
    runId: run.id,
    kind: 'llm',
    slug: 'generate',
    label: 'Generate question',
    promptText: 'SECRET_PROMPT_TEXT',
  });
  session.db.appendAiStepResponse(step.id, 'SECRET_RESPONSE_TEXT');
  return { run, step };
}

type RunWithSteps = AiRunRow & { steps: AiStepSummary[] };

describe('GET /api/ai/runs', () => {
  it('lists runs newest-first with their steps riding along', async () => {
    const { run, step } = seedRunWithStep();
    const app = buildApp();
    const res = await request(app, `http://localhost/api/ai/runs?t=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: RunWithSteps[] };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].id).toBe(run.id);
    expect(body.runs[0].steps.length).toBe(1);
    expect(body.runs[0].steps[0].id).toBe(step.id);
    expect(body.runs[0].steps[0].seq).toBe(1);
  });

  it('never returns promptText/responseText (summary shape)', async () => {
    seedRunWithStep();
    const app = buildApp();
    const res = await request(app, `http://localhost/api/ai/runs?t=${TOKEN}`);
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('SECRET_PROMPT_TEXT');
    expect(raw).not.toContain('SECRET_RESPONSE_TEXT');
    expect(raw).not.toContain('promptText');
    expect(raw).not.toContain('responseText');
  });

  it('respects an explicit limit', async () => {
    seedRunWithStep();
    seedRunWithStep();
    seedRunWithStep();
    const app = buildApp();
    const res = await request(app, `http://localhost/api/ai/runs?t=${TOKEN}&limit=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: RunWithSteps[] };
    expect(body.runs.length).toBe(1);
  });

  it('caps an oversized limit at 100', async () => {
    const spy = vi.spyOn(session.db, 'listAiRuns');
    const app = buildApp();
    const res = await request(app, `http://localhost/api/ai/runs?t=${TOKEN}&limit=9000`);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
  });

  it('defaults the limit to 30', async () => {
    const spy = vi.spyOn(session.db, 'listAiRuns');
    const app = buildApp();
    const res = await request(app, `http://localhost/api/ai/runs?t=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ limit: 30 }));
  });

  it('400s on a non-positive limit', async () => {
    const app = buildApp();
    const res = await request(app, `http://localhost/api/ai/runs?t=${TOKEN}&limit=0`);
    expect(res.status).toBe(400);
  });

  it('400s on a non-numeric limit', async () => {
    const app = buildApp();
    const res = await request(app, `http://localhost/api/ai/runs?t=${TOKEN}&limit=abc`);
    expect(res.status).toBe(400);
  });

  it('filters by refId (the job-card drawer query)', async () => {
    seedRunWithStep({ refId: 'job-a' });
    const { run } = seedRunWithStep({ refId: 'job-b' });
    const app = buildApp();
    const res = await request(app, `http://localhost/api/ai/runs?t=${TOKEN}&refId=job-b`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: RunWithSteps[] };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].id).toBe(run.id);
  });

  it('filters by kind', async () => {
    seedRunWithStep(); // kind: 'generation'
    const review = session.db.createAiRun({ kind: 'review', label: 'Review: debounce' });
    const app = buildApp();
    const res = await request(app, `http://localhost/api/ai/runs?t=${TOKEN}&kind=review`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: RunWithSteps[] };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].id).toBe(review.id);
  });

  it('400s on an unknown kind', async () => {
    const app = buildApp();
    const res = await request(app, `http://localhost/api/ai/runs?t=${TOKEN}&kind=nonsense`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/ai/runs/:id', () => {
  it('returns the run and its steps (summary shape)', async () => {
    const { run, step } = seedRunWithStep();
    const app = buildApp();
    const res = await request(app, `http://localhost/api/ai/runs/${run.id}?t=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: AiRunRow; steps: AiStepSummary[] };
    expect(body.run.id).toBe(run.id);
    expect(body.steps.length).toBe(1);
    expect(body.steps[0].id).toBe(step.id);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('SECRET_PROMPT_TEXT');
    expect(raw).not.toContain('SECRET_RESPONSE_TEXT');
  });

  it('404s on an unknown id', async () => {
    const app = buildApp();
    const res = await request(app, `http://localhost/api/ai/runs/does-not-exist?t=${TOKEN}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('ai run not found');
  });
});

describe('GET /api/ai/steps/:id', () => {
  it('returns the full step including promptText/responseText', async () => {
    const { step } = seedRunWithStep();
    const app = buildApp();
    const res = await request(app, `http://localhost/api/ai/steps/${step.id}?t=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { step: AiStepRow };
    expect(body.step.id).toBe(step.id);
    expect(body.step.promptText).toBe('SECRET_PROMPT_TEXT');
    expect(body.step.responseText).toBe('SECRET_RESPONSE_TEXT');
  });

  it('404s on an unknown id', async () => {
    const app = buildApp();
    const res = await request(app, `http://localhost/api/ai/steps/does-not-exist?t=${TOKEN}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('ai step not found');
  });
});
