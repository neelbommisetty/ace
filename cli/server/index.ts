import fs from 'node:fs';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { createApp } from './app.js';
import { previewImport, runImport } from './importer.js';
import { createPreviewManager } from './preview.js';
import {
  closeWorkspaceSession,
  closeWorkspaceSessionSafe,
  createWorkspaceSession,
  type WorkspaceSession,
} from './session.js';
import { createBus } from './sse.js';

export interface StartAceServerOptions {
  /** Null boots in picker mode (NEE-164): no session until a switch mounts one. */
  workspaceRoot: string | null;
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
  const { port, token, uiDir } = opts;

  // The bus lives OUTSIDE the session for the process lifetime — a future
  // reset/switch rebuilds the session but connected EventSource clients
  // (subscribed to this same bus) survive it and receive the completion event.
  const bus = createBus();

  // Mutable across the process lifetime: POST /api/workspace/reset and
  // POST /api/workspace/switch tear down and rebuild the session (the switch
  // also repoints the root) without restarting the HTTP listener; `swapping`
  // gates the mid-swap 503 middleware and both routes' own "already in
  // progress" 409s. Both start null in picker mode.
  let activeRoot: string | null = opts.workspaceRoot;
  let activeSession: WorkspaceSession | null = null;
  try {
    if (activeRoot != null) {
      activeSession = createWorkspaceSession({ workspaceRoot: activeRoot, bus });

      // Clear stranded runner output files from previous (crashed) sessions.
      const tmpDir = path.join(activeRoot, '.ace', 'tmp');
      try {
        for (const name of fs.readdirSync(tmpDir)) {
          fs.rmSync(path.join(tmpDir, name), { force: true });
        }
      } catch {
        // tmp dir may not exist yet
      }
    }

    // Owned here (not inside createApp) so close() below can dispose it —
    // stopping ace must never leave a Vite dev server holding a port.
    const preview = createPreviewManager({ bus });

    let swapping = false;
    const app = createApp({
      bus,
      token,
      uiDir,
      preview,
      version: readPackageVersion(),
      importer: { previewImport, runImport },
      getWorkspaceRoot: () => activeRoot,
      getSession: () => activeSession,
      isSwapping: () => swapping,
      swapWorkspace: (root, session) => {
        activeRoot = root;
        activeSession = session;
      },
      setSwapping: (value) => {
        swapping = value;
      },
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
        // First: the preview dev server has its own port and its own file
        // watcher — release both before tearing the session down.
        await preview.dispose();
        const closeHttp = () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
            // Open SSE connections would keep close() waiting forever.
            const s = server as { closeAllConnections?: () => void };
            s.closeAllConnections?.();
          });
        // db.close() must run after the HTTP server has fully closed, not
        // before — an in-flight request handler (e.g. a PUT /api/file
        // autosave) can resume mid-shutdown and needs the db still open.
        if (activeSession) {
          await closeWorkspaceSession(activeSession, { beforeDbClose: closeHttp });
        } else {
          await closeHttp();
        }
      },
    };
  } catch (err) {
    // Listen (or boot) failed — release everything so the caller can retry.
    if (activeSession) await closeWorkspaceSessionSafe(activeSession);
    throw err;
  }
}
