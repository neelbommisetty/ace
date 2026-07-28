// @vitest-environment node
//
// This suite drives createApp's Hono instance with real Request/Response
// objects (SSE streaming, the `host` header the DNS-rebinding guard needs).
// happy-dom's fetch/Headers polyfill enforces the browser fetch spec's
// forbidden-header list — which silently drops `Host` — so this file opts
// into Node's real fetch implementation instead.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, makeWorkspace, type WorkspaceHandle } from './test-support.js';

let ws: WorkspaceHandle;

beforeEach(() => {
  ws = makeWorkspace('app-session');
});

afterEach(() => {
  ws.cleanup();
});

function buildApp(isSwapping?: () => boolean) {
  return makeApp({
    getWorkspaceRoot: () => ws.root,
    getSession: () => ws.session,
    ...(isSwapping ? { isSwapping } : {}),
  }).fetch;
}

describe('createApp with a session accessor', () => {
  it('GET /api/workspace 200s with the right token', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/workspace');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { root: string };
    expect(body.root).toBe(ws.root);
  });

  it('gates /api/* at 503 while resetting, except /api/health and POST /api/workspace/reset', async () => {
    const fetch = buildApp(() => true);

    const questions = await fetch('/api/questions');
    expect(questions.status).toBe(503);

    const health = await fetch('/api/health');
    expect(health.status).toBe(200);

    // The reset route itself must run its own guard logic rather than being
    // swallowed by the 503 gate — an empty body fails mode validation (400),
    // proving the route was reached at all (not gated to 503 or falling
    // through to the JSON 404 handler).
    const reset = await fetch('/api/workspace/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(reset.status).toBe(400);
  });

  it('the SSE hello event carries the session epoch', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/events');
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
    expect(payload.epoch).toBe(ws.session.epoch);
    expect(payload.workspaceRoot).toBe(ws.root);
  });
});
