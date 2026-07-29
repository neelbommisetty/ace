// @vitest-environment node
//
// NEE-348: per-workspace Vite preview server. The lifecycle/security tests
// start a REAL Vite dev server against a temp workspace whose node_modules
// symlinks ace's own (which carries vite + @vitejs/plugin-react as
// devDependencies) — no npm install, no fake vite.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPreviewManager,
  resolvePreviewDependencies,
  type PreviewManager,
} from './preview.js';
import { closeWorkspaceSessionSafe, type WorkspaceSession } from './session.js';
import { createBus } from './sse.js';
import { performWorkspaceSwitch } from './switch-orchestrator.js';
import { fakeEngines, makeApp, makeWorkspace, setKeyless } from './test-support.js';
import type { PreviewStatus } from './types.js';

const ACE_NODE_MODULES = path.resolve(import.meta.dirname, '..', '..', 'node_modules');

interface PreviewWorkspace {
  root: string;
  cleanup(): void;
}

/**
 * Temp workspace with one react-apps question, the two secret locations the
 * fs guard must 403 (.env + .ace), and (by default) a node_modules symlink
 * to ace's own so vite/react resolve without an install.
 */
function makePreviewWorkspace(opts: { nodeModules?: boolean } = {}): PreviewWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-preview-'));
  const qdir = path.join(root, 'questions', 'react-apps', 'demo');
  fs.mkdirSync(qdir, { recursive: true });
  fs.writeFileSync(
    path.join(qdir, 'App.tsx'),
    "import React from 'react';\nexport default function App() {\n  return <h1>demo</h1>;\n}\n",
    'utf-8',
  );
  fs.writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=super-secret-value\n', 'utf-8');
  fs.mkdirSync(path.join(root, '.ace'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ace', 'ace.db'), 'not-actually-a-db\n', 'utf-8');
  if (opts.nodeModules !== false) {
    fs.symlinkSync(ACE_NODE_MODULES, path.join(root, 'node_modules'));
  }
  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(predicate()).toBe(true);
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function track<T extends { cleanup(): void }>(x: T): T {
  cleanups.push(() => x.cleanup());
  return x;
}

function trackManager(m: PreviewManager): PreviewManager {
  cleanups.push(() => m.dispose());
  return m;
}

describe('resolvePreviewDependencies', () => {
  it('names the missing package and the install command on a true miss', () => {
    const ws = track(makePreviewWorkspace({ nodeModules: false }));
    const result = resolvePreviewDependencies(ws.root, { fallbackDir: null });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toBe('vite');
    expect(result.message).toContain('"vite"');
    expect(result.message).toContain('npm install --save-dev vite @vitejs/plugin-react');
    expect(result.message).toContain('ace init');
  });

  it('falls back to ace for vite but NOT for react (browser-graph dep)', () => {
    // No workspace node_modules: vite resolves via the ace-side fallback,
    // but react cannot be served to the browser from there, so react is the
    // reported miss.
    const ws = track(makePreviewWorkspace({ nodeModules: false }));
    const result = resolvePreviewDependencies(ws.root);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toBe('react');
    expect(result.message).toContain('npm install --save-dev react react-dom');
  });

  // NEE-368: a fake vite (not a symlink to ace's — that would realpath back
  // into ace's tree and prove nothing) stands in for the transitive vite 7
  // that vitest hoists into old-template workspaces.
  function addFakeWorkspaceVite(root: string): string {
    const viteDir = path.join(root, 'node_modules', 'vite');
    fs.mkdirSync(viteDir, { recursive: true });
    fs.writeFileSync(
      path.join(viteDir, 'package.json'),
      JSON.stringify({ name: 'vite', version: '7.3.1', main: 'index.js' }),
      'utf-8',
    );
    fs.writeFileSync(path.join(viteDir, 'index.js'), 'module.exports = {};\n', 'utf-8');
    return path.join(viteDir, 'index.js');
  }

  it('NEE-368: never mixes trees — workspace vite without plugin-react falls back as a pair', () => {
    const ws = track(makePreviewWorkspace({ nodeModules: false }));
    const fakeViteEntry = addFakeWorkspaceVite(ws.root);
    // react/react-dom must resolve workspace-side (they get no ace fallback).
    for (const name of ['react', 'react-dom']) {
      fs.symlinkSync(path.join(ACE_NODE_MODULES, name), path.join(ws.root, 'node_modules', name));
    }
    const result = resolvePreviewDependencies(ws.root);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(fs.realpathSync(result.deps.viteEntry)).not.toBe(fs.realpathSync(fakeViteEntry));
    expect(fs.realpathSync(result.deps.viteEntry)).toContain(fs.realpathSync(ACE_NODE_MODULES));
    expect(fs.realpathSync(result.deps.pluginReactEntry)).toContain(
      fs.realpathSync(ACE_NODE_MODULES),
    );
  });

  it('NEE-368: partial workspace pair with no fallback reports plugin-react as the miss', () => {
    const ws = track(makePreviewWorkspace({ nodeModules: false }));
    addFakeWorkspaceVite(ws.root);
    const result = resolvePreviewDependencies(ws.root, { fallbackDir: null });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toBe('@vitejs/plugin-react');
    expect(result.message).toContain('npm install --save-dev vite @vitejs/plugin-react');
  });

  it('resolves everything through the workspace node_modules symlink', () => {
    const ws = track(makePreviewWorkspace());
    const result = resolvePreviewDependencies(ws.root, { fallbackDir: null });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.deps.viteEntry).toContain('vite');
    expect(result.deps.nodeModulesDirs.length).toBeGreaterThan(0);
    for (const dir of result.deps.nodeModulesDirs) {
      expect(path.basename(dir)).toBe('node_modules');
    }
  });
});

describe('preview manager lifecycle + fs guard (real vite)', () => {
  it('starts one guarded 127.0.0.1 dev server, reuses it, and stops cleanly', async () => {
    const ws = track(makePreviewWorkspace());
    const bus = createBus();
    const events: PreviewStatus[] = [];
    bus.subscribe((name, data) => {
      if (name === 'preview-status') events.push(data as PreviewStatus);
    });
    const manager = trackManager(createPreviewManager({ bus }));

    const status = await manager.open(ws.root);
    expect(status.state).toBe('ready');
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(events.map((e) => e.state)).toEqual(['starting', 'ready']);

    // Loopback-only binding — the vite port has no token auth, so 127.0.0.1
    // IS the trust boundary.
    const bound = manager.inspect();
    expect(bound?.boundAddress).toBe('127.0.0.1');

    const url = status.url as string;
    const realRoot = fs.realpathSync(ws.root);

    // SECURITY: the workspace .env (documented API-key fallback), the
    // workspace .ace state, and the user-home .ace must all be unreachable —
    // via the raw path AND the realpath vite normalises to.
    for (const forbidden of [
      `${url}/@fs${ws.root}/.env`,
      `${url}/@fs${realRoot}/.env`,
      `${url}/@fs${ws.root}/.ace/ace.db`,
      `${url}/@fs${realRoot}/.ace/ace.db`,
      `${url}/@fs${path.join(os.homedir(), '.ace', 'config.json')}`,
    ]) {
      const res = await fetch(forbidden);
      expect(res.status, `expected 403 for ${forbidden}`).toBe(403);
      const text = await res.text();
      expect(text).not.toContain('super-secret-value');
    }

    // The questions tree itself IS served (that's the point of the preview).
    const allowed = await fetch(`${url}/@fs${realRoot}/questions/react-apps/demo/App.tsx`);
    expect(allowed.status).toBe(200);

    // Reuse: a second open is the same server, same port.
    const again = await manager.open(ws.root);
    expect(again.state).toBe('ready');
    expect(again.url).toBe(status.url);
    expect(events.map((e) => e.state)).toEqual(['starting', 'ready']);

    // Stop: status flips, event fires, the port is actually released.
    const port = Number(new URL(url).port);
    await manager.stopForWorkspace(ws.root);
    expect(manager.status(ws.root).state).toBe('stopped');
    expect(events.map((e) => e.state)).toEqual(['starting', 'ready', 'stopped']);
    expect(await isPortFree(port)).toBe(true);
  }, 30_000);

  it('stops itself after the idle timeout', async () => {
    const ws = track(makePreviewWorkspace());
    const bus = createBus();
    const events: PreviewStatus[] = [];
    bus.subscribe((name, data) => {
      if (name === 'preview-status') events.push(data as PreviewStatus);
    });
    const manager = trackManager(createPreviewManager({ bus, idleTimeoutMs: 200 }));

    const status = await manager.open(ws.root);
    expect(status.state).toBe('ready');
    await waitFor(() => manager.status(ws.root).state === 'stopped');
    expect(events.map((e) => e.state)).toEqual(['starting', 'ready', 'stopped']);
  }, 30_000);

  it('reports the missing dependency instead of failing obscurely', async () => {
    const ws = track(makePreviewWorkspace({ nodeModules: false }));
    const bus = createBus();
    const events: PreviewStatus[] = [];
    bus.subscribe((name, data) => {
      if (name === 'preview-status') events.push(data as PreviewStatus);
    });
    const manager = trackManager(createPreviewManager({ bus, depFallbackDir: null }));

    const status = await manager.open(ws.root);
    expect(status.state).toBe('failed');
    expect(status.reason).toContain('"vite"');
    expect(status.reason).toContain('npm install --save-dev vite @vitejs/plugin-react');
    expect(events.map((e) => e.state)).toEqual(['starting', 'failed']);
    expect(manager.status(ws.root).state).toBe('failed');
  });
});

describe('preview routes', () => {
  it('GET /api/preview and POST /api/preview/open delegate to the manager', async () => {
    const ws = makeWorkspace('preview-routes');
    cleanups.push(() => ws.cleanup());
    const opened: string[] = [];
    const stub: PreviewManager = {
      open: async (root) => {
        opened.push(root);
        return { state: 'ready', url: 'http://127.0.0.1:1234', reason: null };
      },
      status: () => ({ state: 'stopped', url: null, reason: null }),
      stopForWorkspace: async () => {},
      dispose: async () => {},
      inspect: () => null,
    };
    const { fetch } = makeApp({
      getWorkspaceRoot: () => ws.root,
      getSession: () => ws.session,
      preview: stub,
    });

    const statusRes = await fetch('/api/preview');
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual({ state: 'stopped', url: null, reason: null });

    const openRes = await fetch('/api/preview/open', { method: 'POST' });
    expect(openRes.status).toBe(200);
    expect(await openRes.json()).toEqual({
      state: 'ready',
      url: 'http://127.0.0.1:1234',
      reason: null,
    });
    expect(opened).toEqual([ws.root]);
  });
});

describe('workspace switch stops the preview', () => {
  it('performWorkspaceSwitch calls stopPreview with the old root before the swap', async () => {
    setKeyless(); // isolate the recents registry writes under a temp HOME
    const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-preview-switch-'));
    fs.mkdirSync(path.join(newRoot, 'questions'), { recursive: true });
    cleanups.push(() => fs.rmSync(newRoot, { recursive: true, force: true }));

    let created: WorkspaceSession | null = null;
    cleanups.push(async () => {
      if (created) await closeWorkspaceSessionSafe(created);
    });
    const stopped: string[] = [];

    const result = await performWorkspaceSwitch({
      newRoot,
      bus: createBus(),
      getSession: () => null,
      getWorkspaceRoot: () => '/tmp/fake-old-root',
      swapWorkspace: (_root, session) => {
        created = session;
      },
      setSwapping: () => {},
      engines: fakeEngines(),
      stopPreview: async (oldRoot) => {
        stopped.push(oldRoot);
      },
    });

    expect(result.workspaceRoot).toBe(newRoot);
    expect(stopped).toEqual(['/tmp/fake-old-root']);
  });
});
