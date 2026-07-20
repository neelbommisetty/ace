import fs from 'node:fs';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { previewImport, runImport } from './importer.js';
import { reconcile } from './reconciler.js';
import { createRunner } from './runner.js';
import { createBus } from './sse.js';
import { startWatcher } from './watcher.js';

export interface StartAceServerOptions {
  workspaceRoot: string;
  port: number;
  token: string;
  uiDir: string | null;
}

export interface AceServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function readPackageVersion(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
      if (typeof pkg.version === 'string') return pkg.version;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

export async function startAceServer(opts: StartAceServerOptions): Promise<AceServer> {
  const { workspaceRoot, port, token, uiDir } = opts;

  const db = openDb(workspaceRoot);

  // Clear stranded runner output files from previous (crashed) sessions.
  const tmpDir = path.join(workspaceRoot, '.ace', 'tmp');
  try {
    for (const name of fs.readdirSync(tmpDir)) {
      fs.rmSync(path.join(tmpDir, name), { force: true });
    }
  } catch {
    // tmp dir may not exist yet
  }

  let skippedDirs: string[] = [];
  const doReconcile = () => {
    const result = reconcile(db, workspaceRoot);
    skippedDirs = result.skippedDirs;
  };

  let watcher: { close(): Promise<void> } | null = null;
  let runner: ReturnType<typeof createRunner> | null = null;
  try {
    doReconcile();

    const bus = createBus();
    runner = createRunner({ db, bus, workspaceRoot });
    watcher = startWatcher({ workspaceRoot, bus, onQuestionsChanged: doReconcile });

    const app = createApp({
      db,
      bus,
      workspaceRoot,
      token,
      uiDir,
      version: readPackageVersion(),
      runner,
      importer: { previewImport, runImport },
      getSkippedDirs: () => skippedDirs,
    });

    const server = await new Promise<ServerType>((resolve, reject) => {
      const srv = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
        srv.removeListener('error', reject);
        resolve(srv);
      });
      srv.once('error', reject);
    });

    const activeRunner = runner;
    const activeWatcher = watcher;
    return {
      url: `http://127.0.0.1:${port}`,
      port,
      async close() {
        await activeWatcher.close();
        activeRunner.dispose();
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          // Open SSE connections would keep close() waiting forever.
          const s = server as { closeAllConnections?: () => void };
          s.closeAllConnections?.();
        });
        db.close();
      },
    };
  } catch (err) {
    // Listen (or boot) failed — release everything so the caller can retry.
    if (watcher) await watcher.close().catch(() => {});
    if (runner) runner.dispose();
    try {
      db.close();
    } catch {
      // already closed
    }
    throw err;
  }
}
