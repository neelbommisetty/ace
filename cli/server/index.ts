import fs from 'node:fs';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { createApp } from './app.js';
import { previewImport, runImport } from './importer.js';
import {
  closeWorkspaceSession,
  closeWorkspaceSessionSafe,
  createWorkspaceSession,
  type WorkspaceSession,
} from './session.js';
import { createBus } from './sse.js';

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

  // The bus lives OUTSIDE the session for the process lifetime — a future
  // reset rebuilds the session but connected EventSource clients (subscribed
  // to this same bus) survive it and receive the completion event.
  const bus = createBus();

  let session: WorkspaceSession | null = null;
  try {
    session = createWorkspaceSession({ workspaceRoot, bus });

    // Clear stranded runner output files from previous (crashed) sessions.
    const tmpDir = path.join(workspaceRoot, '.ace', 'tmp');
    try {
      for (const name of fs.readdirSync(tmpDir)) {
        fs.rmSync(path.join(tmpDir, name), { force: true });
      }
    } catch {
      // tmp dir may not exist yet
    }

    const activeSession = session;
    const app = createApp({
      bus,
      workspaceRoot,
      token,
      uiDir,
      version: readPackageVersion(),
      importer: { previewImport, runImport },
      getSession: () => activeSession,
      // No reset endpoint yet — always false until that subtask lands.
      isResetting: () => false,
    });

    const server = await new Promise<ServerType>((resolve, reject) => {
      const srv = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
        srv.removeListener('error', reject);
        resolve(srv);
      });
      srv.once('error', reject);
    });

    return {
      url: `http://127.0.0.1:${port}`,
      port,
      async close() {
        // db.close() must run after the HTTP server has fully closed, not
        // before — an in-flight request handler (e.g. a PUT /api/file
        // autosave) can resume mid-shutdown and needs the db still open.
        await closeWorkspaceSession(activeSession, {
          beforeDbClose: () =>
            new Promise<void>((resolve, reject) => {
              server.close((err) => (err ? reject(err) : resolve()));
              // Open SSE connections would keep close() waiting forever.
              const s = server as { closeAllConnections?: () => void };
              s.closeAllConnections?.();
            }),
        });
      },
    };
  } catch (err) {
    // Listen (or boot) failed — release everything so the caller can retry.
    if (session) await closeWorkspaceSessionSafe(session);
    throw err;
  }
}
