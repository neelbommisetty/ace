import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getQuestionsDir } from '../lib/paths.js';
import type { Bus } from './sse.js';
import type { PreviewStatus } from './types.js';

/**
 * Per-workspace Vite dev server for the live preview pane (NEE-348).
 *
 * TRUST POSTURE: the ace API sits behind the launch token; the Vite port does
 * NOT — it has no auth of its own. Binding to 127.0.0.1 is therefore the
 * security boundary (same-machine only), and there is deliberately no
 * `--host` escape hatch. On top of that, a Vite dev server will serve
 * anything its fs allow-list covers, and the workspace root can hold a `.env`
 * (documented API-key fallback) plus `.ace/` state — so the server's root is
 * the questions/ tree, `server.fs.allow` is pinned to that tree plus the
 * resolved dependency dirs and the dep-optimizer cache ONLY, and `.env*` /
 * `.ace` are denied besides. preview.test.ts asserts the 403s.
 */

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

export interface PreviewDeps {
  /** Absolute entry file of the workspace-resolved `vite` package. */
  viteEntry: string;
  /** Absolute entry file of the workspace-resolved `@vitejs/plugin-react`. */
  pluginReactEntry: string;
  /**
   * Realpath'd `node_modules` dirs containing every resolved dep — the
   * fs.allow contribution that lets Vite serve react/react-dom sources.
   */
  nodeModulesDirs: string[];
}

export type PreviewDepResolution =
  | { ok: true; deps: PreviewDeps }
  | { ok: false; missing: string; message: string };

function tryResolveFrom(fromDir: string, specifier: string): string | null {
  try {
    return createRequire(path.join(fromDir, 'package.json')).resolve(specifier);
  } catch {
    return null;
  }
}

/** `<...>/node_modules` dir containing a resolved entry file (realpath'd). */
function containingNodeModulesDir(entryFile: string): string {
  const real = fs.realpathSync(entryFile);
  const marker = `${path.sep}node_modules${path.sep}`;
  const idx = real.lastIndexOf(marker);
  if (idx === -1) return path.dirname(real);
  return real.slice(0, idx + marker.length - 1);
}

function missingDepMessage(name: string, workspaceRoot: string): string {
  const install =
    name === 'react' || name === 'react-dom'
      ? 'npm install --save-dev react react-dom'
      : 'npm install --save-dev vite @vitejs/plugin-react';
  return (
    `live preview needs the "${name}" package, which is not installed in this workspace — ` +
    `run \`${install}\` in ${workspaceRoot} (or re-run \`ace init\`, which adds it to package.json)`
  );
}

/**
 * Resolves the four packages the preview needs, workspace-first.
 *
 *  - `vite` / `@vitejs/plugin-react` are imported by the ACE PROCESS, so when
 *    the workspace doesn't have them they may fall back to ace's own
 *    node_modules (`fallbackDir`, default: this file's dir — a source/dev
 *    install of ace has both as devDependencies; a published install does
 *    not, which is a true miss and reports the install command).
 *  - `react` / `react-dom` are imported by the BROWSER module graph, which
 *    Vite resolves from the question file upward — an ace-side fallback could
 *    never serve them, so they get no fallback and a miss is reported as-is.
 */
export function resolvePreviewDependencies(
  workspaceRoot: string,
  opts: { fallbackDir?: string | null } = {},
): PreviewDepResolution {
  const fallbackDir = opts.fallbackDir === undefined ? import.meta.dirname : opts.fallbackDir;
  const questionsDir = getQuestionsDir(workspaceRoot);

  const resolved: Record<string, string> = {};
  for (const name of ['vite', '@vitejs/plugin-react'] as const) {
    const entry =
      tryResolveFrom(workspaceRoot, name) ??
      (fallbackDir != null ? tryResolveFrom(fallbackDir, name) : null);
    if (entry == null) {
      return { ok: false, missing: name, message: missingDepMessage(name, workspaceRoot) };
    }
    resolved[name] = entry;
  }
  for (const name of ['react', 'react-dom'] as const) {
    const entry = tryResolveFrom(questionsDir, name) ?? tryResolveFrom(workspaceRoot, name);
    if (entry == null) {
      return { ok: false, missing: name, message: missingDepMessage(name, workspaceRoot) };
    }
    resolved[name] = entry;
  }

  const nodeModulesDirs = [...new Set(Object.values(resolved).map(containingNodeModulesDir))];
  return {
    ok: true,
    deps: {
      viteEntry: resolved['vite'],
      pluginReactEntry: resolved['@vitejs/plugin-react'],
      nodeModulesDirs,
    },
  };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** The slice of a Vite dev server the manager depends on (keeps `vite` types out of the compile). */
interface ViteDevServerLike {
  listen(port?: number): Promise<unknown>;
  close(): Promise<void>;
  waitForRequestsIdle?: (ignoredId?: string) => Promise<void>;
  watcher?: { close(): Promise<void> };
  httpServer: {
    address(): { address: string; port: number } | string | null;
    close(cb?: (err?: Error) => void): unknown;
    closeAllConnections?: () => void;
  } | null;
  middlewares: { use(fn: (req: unknown, res: unknown, next: () => void) => void): void };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

export interface PreviewManager {
  /**
   * Lazily starts (or reuses) the ONE dev server for this workspace and
   * resolves with the terminal status: 'ready' (with URL) or 'failed' (with
   * reason). Never rejects — every failure lands in the status.
   */
  open(workspaceRoot: string): Promise<PreviewStatus>;
  /** Current status for a workspace root; 'stopped' when nothing is tracked. */
  status(workspaceRoot: string): PreviewStatus;
  /** Stops the dev server if it belongs to `workspaceRoot`. Never throws. */
  stopForWorkspace(workspaceRoot: string): Promise<void>;
  /** Stops whatever is running. Called on ace server shutdown. */
  dispose(): Promise<void>;
  /** Test-only introspection: the bound address of the live dev server. */
  inspect(): { boundAddress: string; boundPort: number } | null;
}

export interface CreatePreviewManagerOptions {
  bus: Bus;
  /** Stop the dev server after this long with no HTTP traffic. Default 5 min. */
  idleTimeoutMs?: number;
  /** Test seam for resolvePreviewDependencies' ace-side fallback. */
  depFallbackDir?: string | null;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

const STOPPED: PreviewStatus = { state: 'stopped', url: null, reason: null };

/** OS-assigned free port. Vite treats `port: 0` as "use the default 5173", so the pick happens here. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr == null || typeof addr === 'string') {
        srv.close(() => reject(new Error('could not allocate a preview port')));
        return;
      }
      srv.close(() => resolve(addr.port));
    });
  });
}

interface PreviewEntry {
  root: string;
  status: PreviewStatus;
  server: ViteDevServerLike | null;
  startPromise: Promise<PreviewStatus> | null;
  lastActivityAt: number;
  idleTimer: NodeJS.Timeout | null;
}

export function createPreviewManager(opts: CreatePreviewManagerOptions): PreviewManager {
  const { bus } = opts;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  // ONE dev server at a time: only one workspace is ever mounted, and the
  // switch orchestrator stops the old workspace's server before the swap.
  let current: PreviewEntry | null = null;

  function setStatus(entry: PreviewEntry, status: PreviewStatus): void {
    entry.status = status;
    bus.emit('preview-status', status);
  }

  async function stopEntry(entry: PreviewEntry): Promise<void> {
    if (entry.idleTimer != null) {
      clearInterval(entry.idleTimer);
      entry.idleTimer = null;
    }
    const server = entry.server;
    entry.server = null;
    if (server != null) {
      try {
        // Closing while the dep optimizer is still mid-crawl parks
        // server.close() forever (verified against vite 8.1) — wait for the
        // request crawl to go idle first, with a cap so a wedged crawl can't
        // park US forever either.
        if (server.waitForRequestsIdle) {
          await Promise.race([server.waitForRequestsIdle(), sleep(3000)]);
        }
        const closing = server.close().then(() => true as const);
        // A browser (or test fetch agent) holding a keep-alive socket would
        // also park close() — sever the connections alongside it.
        server.httpServer?.closeAllConnections?.();
        const closed = await Promise.race([closing, sleep(5000)]);
        if (closed !== true) throw new Error('vite close timed out');
      } catch {
        // Last resort: free the port and the file watcher directly. The
        // never-settling vite close promise leaks, but the observable
        // resources (socket, watcher) are released.
        await new Promise<void>((resolve) => {
          const hs = server.httpServer;
          if (hs == null) return resolve();
          hs.closeAllConnections?.();
          hs.close(() => resolve());
        });
        await server.watcher?.close().catch(() => {});
      }
    }
    if (entry.status.state !== 'stopped') setStatus(entry, STOPPED);
  }

  async function doStart(entry: PreviewEntry): Promise<PreviewStatus> {
    try {
      const resolution = resolvePreviewDependencies(entry.root, {
        fallbackDir: opts.depFallbackDir,
      });
      if (!resolution.ok) {
        setStatus(entry, { state: 'failed', url: null, reason: resolution.message });
        return entry.status;
      }
      const { deps } = resolution;

      const viteMod = (await import(pathToFileURL(deps.viteEntry).href)) as {
        createServer(config: unknown): Promise<ViteDevServerLike>;
      };
      const pluginReactMod = (await import(pathToFileURL(deps.pluginReactEntry).href)) as {
        default: (o?: unknown) => unknown;
      };

      // realpath so fs.allow entries match what Vite serves — it resolves
      // symlinks (macOS /var -> /private/var, workspace node_modules links)
      // before checking the allow list.
      const realRoot = fs.realpathSync(entry.root);
      const questionsDir = getQuestionsDir(realRoot);
      // Outside the workspace: the default (`<root>/node_modules/.vite`)
      // would materialise a node_modules dir inside questions/, which is the
      // user's artifact tree.
      const cacheDir = path.join(
        os.tmpdir(),
        'ace-preview-cache',
        crypto.createHash('sha256').update(realRoot).digest('hex').slice(0, 12),
      );

      const server = await viteMod.createServer({
        root: questionsDir,
        configFile: false,
        envDir: false,
        clearScreen: false,
        logLevel: 'warn',
        cacheDir,
        appType: 'custom',
        server: {
          // 127.0.0.1 IS the trust boundary — see the module doc comment.
          host: '127.0.0.1',
          strictPort: true,
          fs: {
            strict: true,
            allow: [...new Set([questionsDir, cacheDir, ...deps.nodeModulesDirs])],
            // Redundant with the allow list (neither .env nor .ace is under
            // it), kept as defense in depth for the documented secrets.
            deny: ['.env', '.env.*', '**/.env*', '**/.ace/**'],
          },
        },
        plugins: [
          pluginReactMod.default(),
          {
            name: 'ace-preview-activity',
            configureServer(s: ViteDevServerLike) {
              // Registered pre-internal so every request (HTML, /@fs module
              // fetches, HMR re-imports) counts as activity for idle-stop.
              s.middlewares.use((_req, _res, next) => {
                entry.lastActivityAt = Date.now();
                next();
              });
            },
          },
        ],
      });

      // OS-assigned port with a small retry: findFreePort closes its probe
      // socket before Vite rebinds, so another process can steal the port in
      // between.
      let lastListenError: unknown = null;
      let listening = false;
      for (let attempt = 0; attempt < 3 && !listening; attempt++) {
        try {
          await server.listen(await findFreePort());
          listening = true;
        } catch (err) {
          lastListenError = err;
        }
      }
      if (!listening) {
        await server.close().catch(() => {});
        throw lastListenError instanceof Error
          ? lastListenError
          : new Error(String(lastListenError));
      }

      const addr = server.httpServer?.address();
      if (addr == null || typeof addr === 'string') {
        await server.close().catch(() => {});
        throw new Error('preview server failed to report its bound port');
      }

      entry.server = server;
      entry.lastActivityAt = Date.now();
      const checkEveryMs = Math.max(50, Math.min(idleTimeoutMs / 4, 30_000));
      entry.idleTimer = setInterval(() => {
        if (Date.now() - entry.lastActivityAt >= idleTimeoutMs) {
          void stopEntry(entry);
        }
      }, checkEveryMs);
      entry.idleTimer.unref();

      setStatus(entry, {
        state: 'ready',
        url: `http://127.0.0.1:${addr.port}`,
        reason: null,
      });
      return entry.status;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(entry, {
        state: 'failed',
        url: null,
        reason: `preview server failed to start: ${message}`,
      });
      return entry.status;
    }
  }

  async function stopForRoot(workspaceRoot: string): Promise<void> {
    const entry = current;
    if (entry == null || entry.root !== workspaceRoot) return;
    // Never close a server mid-listen — wait for the start to settle first.
    if (entry.startPromise != null) await entry.startPromise.catch(() => {});
    await stopEntry(entry);
  }

  return {
    async open(workspaceRoot: string): Promise<PreviewStatus> {
      if (current != null && current.root === workspaceRoot) {
        if (current.startPromise != null) return current.startPromise;
        if (current.status.state === 'ready') {
          current.lastActivityAt = Date.now();
          return current.status;
        }
        // 'failed' or 'stopped' — fall through and start fresh.
      }
      if (current != null && current.root !== workspaceRoot) {
        // Shouldn't happen (the switch orchestrator stops the old server),
        // but never leave two dev servers holding ports.
        await stopForRoot(current.root);
      }
      const entry: PreviewEntry = {
        root: workspaceRoot,
        status: { state: 'starting', url: null, reason: null },
        server: null,
        startPromise: null,
        lastActivityAt: Date.now(),
        idleTimer: null,
      };
      current = entry;
      bus.emit('preview-status', entry.status);
      entry.startPromise = doStart(entry).finally(() => {
        entry.startPromise = null;
      });
      return entry.startPromise;
    },

    status(workspaceRoot: string): PreviewStatus {
      return current != null && current.root === workspaceRoot ? current.status : STOPPED;
    },

    stopForWorkspace: stopForRoot,

    async dispose(): Promise<void> {
      const entry = current;
      if (entry == null) return;
      if (entry.startPromise != null) await entry.startPromise.catch(() => {});
      await stopEntry(entry);
      current = null;
    },

    inspect(): { boundAddress: string; boundPort: number } | null {
      const addr = current?.server?.httpServer?.address();
      if (addr == null || typeof addr === 'string') return null;
      return { boundAddress: addr.address, boundPort: addr.port };
    },
  };
}
