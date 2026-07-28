// @vitest-environment node
//
// Boots the REAL startAceServer with workspaceRoot: null (picker mode,
// NEE-164) and drives it over actual HTTP — pins the index.ts wiring the
// in-process switch-endpoint tests can't reach: null-session boot skips
// session/tmp-cleanup, a switch mounts real engines, and close() resolves
// with and without a mounted session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startAceServer, type AceServer } from './index.js';

let tempHome = '';
let workspace = '';
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function isAddrInUse(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
  );
}

async function bootPickerServer(): Promise<{ server: AceServer; token: string }> {
  const token = crypto.randomUUID();
  const basePort = 4300 + Math.floor(Math.random() * 5000);
  let lastErr: unknown;
  for (let port = basePort; port < basePort + 40; port++) {
    try {
      const server = await startAceServer({ workspaceRoot: null, port, token, uiDir: null });
      return { server, token };
    } catch (err) {
      if (isAddrInUse(err)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('failed to bind a free test port');
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-picker-home-'));
  process.env.HOME = tempHome;
  delete process.env.USERPROFILE;
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-picker-ws-'));
  const dir = path.join(workspace, 'questions', 'js-ts', 'two-sum');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# two-sum\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'solution.ts'), 'export const x = 1;\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'solution.test.ts'), "it('todo', () => {});\n", 'utf-8');
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tempHome, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('startAceServer picker-mode boot', () => {
  it('serves the picker surface unmounted, mounts a workspace via switch, and shuts down cleanly', async () => {
    const { server, token } = await bootPickerServer();
    try {
      const api = (p: string) => `${server.url}${p}${p.includes('?') ? '&' : '?'}t=${token}`;

      const health = await fetch(api('/api/health'));
      expect(health.status).toBe(200);

      const unmounted = await fetch(api('/api/questions'));
      expect(unmounted.status).toBe(409);
      expect((await unmounted.json()) as { error: string }).toEqual({
        error: 'no workspace mounted',
      });

      const recents = await fetch(api('/api/workspace/recents'));
      expect(recents.status).toBe(200);
      expect((await recents.json()) as { recents: unknown[] }).toEqual({ recents: [] });

      const switched = await fetch(api('/api/workspace/switch'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: workspace }),
      });
      expect(switched.status).toBe(200);
      const body = (await switched.json()) as { workspaceRoot: string; epoch: string };
      expect(body.workspaceRoot).toBe(workspace);
      expect(body.epoch).toBeTruthy();

      const mounted = await fetch(api('/api/questions'));
      expect(mounted.status).toBe(200);
      expect(((await mounted.json()) as Array<{ slug: string }>).map((q) => q.slug)).toEqual([
        'two-sum',
      ]);
    } finally {
      // close() must tear down the session the switch mounted mid-flight —
      // a leaked watcher/db handle would hang this past the race timeout.
      const raceResult = await Promise.race([
        server.close().then(() => 'closed' as const),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 8000)),
      ]);
      expect(raceResult).toBe('closed');
    }
    await expect(fetch(`${server.url}/api/health`)).rejects.toThrow();
  }, 15_000);

  it('close() resolves promptly when nothing was ever mounted', async () => {
    const { server } = await bootPickerServer();
    const raceResult = await Promise.race([
      server.close().then(() => 'closed' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 5000)),
    ]);
    expect(raceResult).toBe('closed');
    await expect(fetch(`${server.url}/api/health`)).rejects.toThrow();
  }, 10_000);
});
