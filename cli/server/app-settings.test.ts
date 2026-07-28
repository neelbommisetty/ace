// @vitest-environment node
//
// Route-level coverage for /api/settings — specifically the base-URL field
// validation the Settings UI depends on (bad type / empty / invalid URL → 400,
// null → clear). Provider validators are stubbed; no network is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp, makeWorkspace, type WorkspaceHandle } from './test-support.js';
import type { SettingsInfo } from './types.js';

vi.mock('../lib/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/llm.js')>();
  return {
    ...actual,
    validateOpenAIKey: vi.fn(async () => ({ valid: true })),
    validateAnthropicKey: vi.fn(async () => ({ valid: true })),
  };
});

let ws: WorkspaceHandle;
let tempHome = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-home-'));
  process.env.HOME = tempHome;
  delete process.env.USERPROFILE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;
  ws = makeWorkspace('app-settings');
});

afterEach(() => {
  process.env = { ...originalEnv };
  ws.cleanup();
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function buildApp() {
  return makeApp({ getWorkspaceRoot: () => ws.root, getSession: () => ws.session }).fetch;
}

function putSettings(fetch: ReturnType<typeof buildApp>, body: unknown) {
  return fetch('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
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
    const fetch = buildApp();
    await putSettings(fetch, { anthropicBaseUrl: 'http://localhost:4242/v1' });

    const res = await putSettings(fetch, { anthropicBaseUrl: null });

    expect(res.status).toBe(200);
    const info = (await res.json()) as SettingsInfo;
    expect(info.anthropic.baseUrl).toBeNull();
  });
});
