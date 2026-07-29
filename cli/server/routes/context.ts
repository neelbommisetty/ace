import type { CreateAppOptions, ImporterApi } from '../app.js';
import { createPreviewManager, type PreviewManager } from '../preview.js';
import type { EngineFactories, WorkspaceSession } from '../session.js';
import type { Bus } from '../sse.js';

/** Shared dependencies handed to every routes/ module's register function. */
export interface RouteContext {
  bus: Bus;
  version: string;
  importer: ImporterApi;
  uiDir: string | null;
  /** Live preview dev-server lifecycle (NEE-348). */
  preview: PreviewManager;
  getWorkspaceRoot: () => string | null;
  getSession: () => WorkspaceSession | null;
  requireSession: () => WorkspaceSession;
  requireWorkspaceRoot: () => string;
  isSwapping: () => boolean;
  swapWorkspace: (root: string | null, session: WorkspaceSession | null) => void;
  setSwapping: (swapping: boolean) => void;
  engines: EngineFactories | undefined;
  waitForRequestDrain: (timeoutMs?: number) => Promise<void>;
}

export function createRouteContext(
  opts: CreateAppOptions,
  waitForRequestDrain: (timeoutMs?: number) => Promise<void>,
): RouteContext {
  const { getSession, getWorkspaceRoot } = opts;

  /**
   * For routes behind the no-workspace 409 gate (app.ts), which guarantees a
   * mounted session — they assert the mount here instead of null-checking at
   * every call site. Throwing (→ onError 500) is correct for the impossible
   * case: it means a route was added without thinking about picker mode.
   */
  function requireSession(): WorkspaceSession {
    const session = getSession();
    if (!session) throw new Error('no workspace mounted');
    return session;
  }

  /** Same contract as requireSession, for the root. */
  function requireWorkspaceRoot(): string {
    const root = getWorkspaceRoot();
    if (root == null) throw new Error('no workspace mounted');
    return root;
  }

  return {
    bus: opts.bus,
    version: opts.version,
    importer: opts.importer,
    uiDir: opts.uiDir,
    // startAceServer passes its own so close() can dispose it; tests that
    // never open a preview are fine with the default (it holds no resources
    // until the first open()).
    preview: opts.preview ?? createPreviewManager({ bus: opts.bus }),
    getWorkspaceRoot,
    getSession,
    requireSession,
    requireWorkspaceRoot,
    isSwapping: opts.isSwapping ?? (() => false),
    swapWorkspace: opts.swapWorkspace ?? (() => {}),
    setSwapping: opts.setSwapping ?? (() => {}),
    engines: opts.engines,
    waitForRequestDrain,
  };
}
