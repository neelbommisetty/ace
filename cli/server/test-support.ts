// Shared unit/route-level test harness for cli/server/*.test.ts.
//
// This is the unit/route-level equivalent of cli/e2e/e2e-utils.ts — the two
// are deliberately not merged (e2e drives a real spawned CLI process; this
// drives createApp/createWorkspaceSession in-process against fake engines
// that never touch an LLM or spawn vitest).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, vi } from 'vitest';
import { clearConfigCache } from '../lib/llm.js';
import { createApp } from './app.js';
import type { BrainstormEngine } from './brainstorm.js';
import type { DisputeEngine } from './disputes.js';
import type { GenerationEngine } from './generation.js';
import { runImport, previewImport } from './importer.js';
import type { ProbeEngine } from './probes.js';
import type { ReviewEngine } from './reviews.js';
import type { Runner } from './runner.js';
import { createWorkspaceSession, type EngineFactories, type WorkspaceSession } from './session.js';
import { createBus, type Bus } from './sse.js';
import type { GenerationJobRow } from './types.js';

/** The token every fake app in this harness is built with. */
export const TOKEN = 'test-token';

// ---------------------------------------------------------------------------
// fakeEngines
// ---------------------------------------------------------------------------

type RunnerOpts = Parameters<EngineFactories['createRunner']>[0];
type ReviewOpts = Parameters<EngineFactories['createReviewEngine']>[0];
type DisputeOpts = Parameters<EngineFactories['createDisputeEngine']>[0];
type ProbeOpts = Parameters<EngineFactories['createProbeEngine']>[0];
type GenerationOpts = Parameters<EngineFactories['createGenerationEngine']>[0];
type BrainstormOpts = Parameters<EngineFactories['createBrainstormEngine']>[0];

/**
 * Per-engine override: either a plain partial (the common case — most tests
 * only care about a couple of methods' behavior) or a function of the real
 * factory's opts (for the rare test that needs the per-call `workspaceRoot`,
 * e.g. to tag which session's engine got disposed during a reset/switch).
 */
type EngineOverride<TEngine, TOpts> = Partial<TEngine> | ((opts: TOpts) => Partial<TEngine>);

function resolveOverride<TEngine, TOpts>(
  override: EngineOverride<TEngine, TOpts> | undefined,
  opts: TOpts,
): Partial<TEngine> {
  return typeof override === 'function' ? override(opts) : (override ?? {});
}

export interface FakeEngineOverrides {
  runner?: EngineOverride<Runner, RunnerOpts>;
  reviews?: EngineOverride<ReviewEngine, ReviewOpts>;
  disputes?: EngineOverride<DisputeEngine, DisputeOpts>;
  probes?: EngineOverride<ProbeEngine, ProbeOpts>;
  generation?: EngineOverride<GenerationEngine, GenerationOpts>;
  brainstorm?: EngineOverride<BrainstormEngine, BrainstormOpts>;
}

/**
 * Fully-stubbed engine factories — never touch the LLM or spawn vitest. Each
 * factory builds a complete, real object satisfying its engine interface (no
 * `as unknown as` escape hatch), so adding a method to e.g. `ReviewEngine`
 * becomes one compile error here instead of a silent gap in eight
 * copy-pasted stubs. `overrides` lets a test replace individual methods —
 * shallow, per engine — without losing type-checking on the rest.
 */
export function fakeEngines(overrides: FakeEngineOverrides = {}): EngineFactories {
  return {
    createRunner: (opts) => {
      const o = resolveOverride(overrides.runner, opts);
      return {
        start: o.start ?? vi.fn(),
        cancel: o.cancel ?? vi.fn(() => false),
        isBusy: o.isBusy ?? vi.fn(() => false),
        dispose: o.dispose ?? vi.fn(),
      };
    },
    createReviewEngine: (opts) => {
      const o = resolveOverride(overrides.reviews, opts);
      return {
        start: o.start ?? vi.fn(() => ({ jobId: 'fake-review-job-id' })),
        isRunning: o.isRunning ?? vi.fn(() => false),
        isAnyRunning: o.isAnyRunning ?? vi.fn(() => false),
        dispose: o.dispose ?? vi.fn(),
      };
    },
    createDisputeEngine: (opts) => {
      const o = resolveOverride(overrides.disputes, opts);
      return {
        start: o.start ?? vi.fn(() => ({ disputeJobId: 'fake-dispute-job-id' })),
        isRunning: o.isRunning ?? vi.fn(() => false),
        isAnyRunning: o.isAnyRunning ?? vi.fn(() => false),
        dispose: o.dispose ?? vi.fn(),
      };
    },
    createProbeEngine: (opts) => {
      const o = resolveOverride(overrides.probes, opts);
      return {
        start: o.start ?? vi.fn(() => ({ probeJobId: 'fake-probe-job-id' })),
        isRunning: o.isRunning ?? vi.fn(() => false),
        isAnyRunning: o.isAnyRunning ?? vi.fn(() => false),
        dispose: o.dispose ?? vi.fn(),
      };
    },
    createGenerationEngine: (opts) => {
      const o = resolveOverride(overrides.generation, opts);
      return {
        start: o.start ?? vi.fn(() => ({ jobId: 'fake-started-job-id' })),
        retry: o.retry ?? vi.fn((job: GenerationJobRow) => ({ jobId: job.id })),
        runningCount: o.runningCount ?? vi.fn(() => 0),
        isAnyRunning: o.isAnyRunning ?? vi.fn(() => false),
        dispose: o.dispose ?? vi.fn(),
      };
    },
    createBrainstormEngine: (opts) => {
      const o = resolveOverride(overrides.brainstorm, opts);
      return {
        startTurn:
          o.startTurn ??
          vi.fn((sessionId: string | null) => ({
            sessionId: sessionId ?? 'fake-started-session-id',
          })),
        isThinking: o.isThinking ?? vi.fn(() => false),
        isAnyRunning: o.isAnyRunning ?? vi.fn(() => false),
        dispose: o.dispose ?? vi.fn(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// makeWorkspace
// ---------------------------------------------------------------------------

export interface MakeWorkspaceOptions {
  /** Defaults to fakeEngines(). */
  engines?: EngineFactories;
  /** Defaults to false (no real chokidar watcher). */
  watch?: boolean;
}

export interface WorkspaceHandle {
  root: string;
  bus: Bus;
  /** Mutable — a test may rebuild/reassign this over the same root (see e.g.
   * app-generation.test.ts's "already thinking" case). `cleanup()` always
   * closes whatever this currently points to. */
  session: WorkspaceSession;
  /** session.db.close() + rm -rf root. */
  cleanup(): void;
}

/** mkdtemp + questions/ + a WorkspaceSession over it, with matching teardown. */
export function makeWorkspace(name: string, opts: MakeWorkspaceOptions = {}): WorkspaceHandle {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ace-${name}-`));
  fs.mkdirSync(path.join(root, 'questions'), { recursive: true });
  const bus = createBus();
  const session = createWorkspaceSession({
    workspaceRoot: root,
    bus,
    watch: opts.watch ?? false,
    engines: opts.engines ?? fakeEngines(),
  });
  const handle: WorkspaceHandle = {
    root,
    bus,
    session,
    cleanup() {
      // Read through `handle` rather than closing over `session`/`root`
      // directly — a caller may have reassigned `handle.session` since.
      handle.session.db.close();
      fs.rmSync(handle.root, { recursive: true, force: true });
    },
  };
  return handle;
}

// ---------------------------------------------------------------------------
// makeApp
// ---------------------------------------------------------------------------

type App = ReturnType<typeof createApp>;
type CreateAppOptions = Parameters<typeof createApp>[0];

export interface MakeAppOptions {
  getWorkspaceRoot: CreateAppOptions['getWorkspaceRoot'];
  getSession: CreateAppOptions['getSession'];
  isSwapping?: CreateAppOptions['isSwapping'];
  engines?: CreateAppOptions['engines'];
  bus?: CreateAppOptions['bus'];
  token?: CreateAppOptions['token'];
  uiDir?: CreateAppOptions['uiDir'];
  version?: CreateAppOptions['version'];
  importer?: CreateAppOptions['importer'];
  swapWorkspace?: CreateAppOptions['swapWorkspace'];
  setSwapping?: CreateAppOptions['setSwapping'];
  preview?: CreateAppOptions['preview'];
}

/**
 * createApp with the standard test token + importer wired in, plus an authed
 * fetch helper: pass just a path (e.g. `/api/workspace`) and it fills in the
 * `http://localhost` origin, the `?t=` token (unless the path already has
 * one), and the `Host` header the DNS-rebinding guard requires — app.request()
 * builds a Request in-process, so nothing populates `Host` from the URL the
 * way a real HTTP client would.
 */
export function makeApp(opts: MakeAppOptions): {
  app: App;
  fetch(path: string, init?: RequestInit): Promise<Response>;
} {
  const bus = opts.bus ?? createBus();
  const app = createApp({
    getWorkspaceRoot: opts.getWorkspaceRoot,
    getSession: opts.getSession,
    token: opts.token ?? TOKEN,
    uiDir: opts.uiDir ?? null,
    version: opts.version ?? '0.0.0-test',
    importer: opts.importer ?? { previewImport, runImport },
    isSwapping: opts.isSwapping ?? (() => false),
    bus,
    ...(opts.engines ? { engines: opts.engines } : {}),
    ...(opts.preview ? { preview: opts.preview } : {}),
    ...(opts.swapWorkspace ? { swapWorkspace: opts.swapWorkspace } : {}),
    ...(opts.setSwapping ? { setSwapping: opts.setSwapping } : {}),
  });

  function appFetch(pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(pathAndQuery, 'http://localhost');
    if (!url.searchParams.has('t')) url.searchParams.set('t', TOKEN);
    return Promise.resolve(
      app.request(url.toString(), {
        ...init,
        headers: { host: 'localhost', ...(init.headers as Record<string, string> | undefined) },
      }),
    );
  }

  return { app, fetch: appFetch };
}

// ---------------------------------------------------------------------------
// setKeyless / setProviderConfigured
// ---------------------------------------------------------------------------

let keylessHome: string | null = null;
let savedEnv: NodeJS.ProcessEnv | null = null;

/**
 * HOME-isolation for provider gating. hasProvider() (called directly by
 * app.ts, not injectable) bottoms out in lib/llm.js's hasAnyProvider(),
 * which reads ~/.ace/config.json (via getGlobalAceDir() -> process.env.HOME)
 * and process.env.*_API_KEY, cached at the module level until
 * clearConfigCache() busts it. Pointing HOME at a fresh, empty temp dir and
 * clearing the two key env vars makes "no provider configured" deterministic
 * regardless of the real dev machine's ~/.ace — same isolation technique as
 * cli/lib/config.test.ts.
 *
 * Self-registers its own afterEach teardown (restores process.env, removes
 * the temp HOME) — callers don't need a matching cleanup call.
 */
export function setKeyless(): void {
  if (savedEnv === null) savedEnv = { ...process.env };
  keylessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-test-home-'));
  process.env.HOME = keylessHome;
  delete process.env.USERPROFILE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ACE_E2E_MOCK_LLM;
  clearConfigCache();
}

/** Writes a fake (unvalidated — the gate never validates) key under the setKeyless() HOME so hasProvider() is true. */
export function setProviderConfigured(): void {
  if (keylessHome === null) {
    throw new Error('setProviderConfigured() requires setKeyless() to run first');
  }
  const aceDir = path.join(keylessHome, '.ace');
  fs.mkdirSync(aceDir, { recursive: true });
  fs.writeFileSync(
    path.join(aceDir, 'config.json'),
    JSON.stringify({ OPENAI_API_KEY: 'test-fake-key', default_provider: 'openai' }),
    'utf8',
  );
  clearConfigCache();
}

afterEach(() => {
  if (keylessHome !== null) {
    fs.rmSync(keylessHome, { recursive: true, force: true });
    keylessHome = null;
  }
  if (savedEnv !== null) {
    process.env = { ...savedEnv };
    savedEnv = null;
    clearConfigCache();
  }
});
