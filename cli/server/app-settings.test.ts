// @vitest-environment node
//
// Route-level coverage for /api/settings — specifically the base-URL field
// validation the Settings UI depends on (bad type / empty / invalid URL → 400,
// null → clear). Provider validators are stubbed; no network is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { runImport, previewImport } from './importer.js';
import { createWorkspaceSession, type EngineFactories, type WorkspaceSession } from './session.js';
import { createBus } from './sse.js';
import type { SettingsInfo } from './types.js';

vi.mock('../lib/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/llm.js')>();
  return {
    ...actual,
    validateOpenAIKey: vi.fn(async () => ({ valid: true })),
    validateAnthropicKey: vi.fn(async () => ({ valid: true })),
  };
});

const TOKEN = 'test-token';

let tempRoot = '';
let tempHome = '';
let session: WorkspaceSession;
const originalEnv = { ...process.env };

function fakeEngines(): EngineFactories {
  return {
    createRunner: (() => ({ start: vi.fn(), dispose: vi.fn() })) as unknown as EngineFactories['createRunner'],
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
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-app-settings-'));
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-home-'));
  process.env.HOME = tempHome;
  delete process.env.USERPROFILE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  session = createWorkspaceSession({
    workspaceRoot: tempRoot,
    bus: createBus(),
    watch: false,
    engines: fakeEngines(),
  });
});

afterEach(() => {
  process.env = { ...originalEnv };
  session.db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function buildApp() {
  return createApp({
    bus: createBus(),
    workspaceRoot: tempRoot,
    token: TOKEN,
    uiDir: null,
    version: '0.0.0-test',
    importer: { previewImport, runImport },
    getSession: () => session,
    isResetting: () => false,
  });
}

function putSettings(app: ReturnType<typeof buildApp>, body: unknown) {
  return app.request(`http://localhost/api/settings?t=${TOKEN}`, {
    method: 'PUT',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/settings base-URL fields', () => {
  it('rejects a non-string value with 400', async () => {
    const res = await putSettings(buildApp(), { openaiBaseUrl: 123 });
    expect(res.status).toBe(400);
  });

  it('rejects an empty/whitespace string with 400', async () => {
    const res = await putSettings(buildApp(), { anthropicBaseUrl: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects a scheme-less URL with 400', async () => {
    const res = await putSettings(buildApp(), { openaiBaseUrl: 'localhost:4242/v1' });
    expect(res.status).toBe(400);
  });

  it('normalizes and saves a valid URL, returning it in the settings info', async () => {
    const res = await putSettings(buildApp(), { openaiBaseUrl: 'http://localhost:4242/v1/' });
    expect(res.status).toBe(200);
    const info = (await res.json()) as SettingsInfo;
    expect(info.openai.baseUrl).toBe('http://localhost:4242/v1');
  });

  it('accepts null and clears a previously saved base URL', async () => {
    const app = buildApp();
    await putSettings(app, { anthropicBaseUrl: 'http://localhost:4242/v1' });

    const res = await putSettings(app, { anthropicBaseUrl: null });

    expect(res.status).toBe(200);
    const info = (await res.json()) as SettingsInfo;
    expect(info.anthropic.baseUrl).toBeNull();
  });
});
