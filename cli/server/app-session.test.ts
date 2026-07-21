// @vitest-environment node
//
// This suite drives createApp's Hono instance with real Request/Response
// objects (SSE streaming, the `host` header the DNS-rebinding guard needs).
// happy-dom's fetch/Headers polyfill enforces the browser fetch spec's
// forbidden-header list — which silently drops `Host` — so this file opts
// into Node's real fetch implementation instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { runImport, previewImport } from './importer.js';
import { createWorkspaceSession, type EngineFactories, type WorkspaceSession } from './session.js';
import { createBus } from './sse.js';

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
  };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-app-session-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  const bus = createBus();
  session = createWorkspaceSession({
    workspaceRoot: tempRoot,
    bus,
    watch: false,
    engines: fakeEngines(),
  });
});

afterEach(async () => {
  session.db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function buildApp(isResetting: () => boolean = () => false) {
  const bus = createBus();
  return createApp({
    bus,
    workspaceRoot: tempRoot,
    token: TOKEN,
    uiDir: null,
    version: '0.0.0-test',
    importer: { previewImport, runImport },
    getSession: () => session,
    isResetting,
  });
}

/**
 * app.request() builds a Request in-process (no real network transport), so
 * — unlike a real HTTP client — nothing populates the `Host` header from the
 * URL automatically. The app's DNS-rebinding guard requires it, so every
 * request here sets it explicitly.
 */
function request(app: ReturnType<typeof buildApp>, url: string, init: RequestInit = {}) {
  return app.request(url, {
    ...init,
    headers: { host: 'localhost', ...(init.headers as Record<string, string> | undefined) },
  });
}

describe('createApp with a session accessor', () => {
  it('GET /api/workspace 200s with the right token', async () => {
    const app = buildApp();
    const res = await request(app, `http://localhost/api/workspace?t=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { root: string };
    expect(body.root).toBe(tempRoot);
  });

  it('gates /api/* at 503 while resetting, except /api/health and POST /api/workspace/reset', async () => {
    const app = buildApp(() => true);

    const questions = await request(app, `http://localhost/api/questions?t=${TOKEN}`);
    expect(questions.status).toBe(503);

    const health = await request(app, `http://localhost/api/health?t=${TOKEN}`);
    expect(health.status).toBe(200);

    // The reset route itself must run its own guard logic rather than being
    // swallowed by the 503 gate — an empty body fails mode validation (400),
    // proving the route was reached at all (not gated to 503 or falling
    // through to the JSON 404 handler).
    const reset = await request(app, `http://localhost/api/workspace/reset?t=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(reset.status).toBe(400);
  });

  it('the SSE hello event carries the session epoch', async () => {
    const app = buildApp();
    const res = await request(app, `http://localhost/api/events?t=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    // The hello event is written synchronously before anything else — one
    // read is enough to capture it.
    while (!text.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    expect(text).toContain('event: hello');
    const dataLine = text
      .split('\n')
      .find((line) => line.startsWith('data:'));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine!.slice('data:'.length).trim()) as {
      epoch: string;
      workspaceRoot: string;
    };
    expect(payload.epoch).toBe(session.epoch);
    expect(payload.workspaceRoot).toBe(tempRoot);
  });
});
