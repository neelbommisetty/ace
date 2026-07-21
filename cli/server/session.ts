import crypto from 'node:crypto';
import { openDb } from './db.js';
import { createDisputeEngine, type DisputeEngine } from './disputes.js';
import { reconcile } from './reconciler.js';
import { createReviewEngine, type ReviewEngine } from './reviews.js';
import { createRunner, type Runner } from './runner.js';
import type { Bus } from './sse.js';
import type { AceDb } from './types.js';
import { startWatcher } from './watcher.js';

/**
 * The set of stateful resources bound to one open workspace. A fresh session
 * is built whenever a workspace is (re)opened — a future reset tears one
 * down and builds another without restarting the HTTP listener, so
 * `getSession()` accessors (see app.ts) are the seam that makes that
 * possible.
 */
export interface WorkspaceSession {
  /**
   * Unique per-session id, minted fresh on every createWorkspaceSession call.
   * Surfaced in the SSE `hello` payload so reconnecting tabs can detect that
   * a reset happened while they were disconnected.
   */
  epoch: string;
  db: AceDb;
  runner: Runner;
  reviews: ReviewEngine;
  disputes: DisputeEngine;
  watcher: { close(): Promise<void> } | null;
  /** Latest reconcile's skipped dirs (dirs under unknown categories). */
  skippedDirs: string[];
  /** Re-syncs questions/ into the db and refreshes skippedDirs. */
  reconcile(): void;
}

/** Injectable engine factories — tests supply fakes so no LLM keys/vitest are touched. */
export interface EngineFactories {
  createRunner: typeof createRunner;
  createReviewEngine: typeof createReviewEngine;
  createDisputeEngine: typeof createDisputeEngine;
}

const defaultEngines: EngineFactories = {
  createRunner,
  createReviewEngine,
  createDisputeEngine,
};

export interface CreateWorkspaceSessionOptions {
  workspaceRoot: string;
  bus: Bus;
  /** Defaults to true (chokidar watcher attached inline). false returns watcher: null. */
  watch?: boolean;
  /** Defaults to the real createRunner/createReviewEngine/createDisputeEngine. */
  engines?: EngineFactories;
}

// The Bus a session was created with, keyed by object identity — needed by
// startSessionWatcher (called later, e.g. by the reset orchestrator, with
// just the session). Not part of the public WorkspaceSession shape.
const sessionBus = new WeakMap<WorkspaceSession, Bus>();

/**
 * Builds a fresh WorkspaceSession: opens the db, reconciles questions/ into
 * it, creates the engines, and (unless `watch: false`) attaches the chokidar
 * watcher. `watch: false` returns the session with `watcher: null` — used by
 * tests and by the reset orchestrator, which attaches the watcher explicitly
 * only after restore writes have landed.
 */
export function createWorkspaceSession(opts: CreateWorkspaceSessionOptions): WorkspaceSession {
  const { workspaceRoot, bus } = opts;
  const engines = opts.engines ?? defaultEngines;

  const db = openDb(workspaceRoot);

  const session: WorkspaceSession = {
    epoch: crypto.randomUUID(),
    db,
    runner: engines.createRunner({ db, bus, workspaceRoot }),
    reviews: engines.createReviewEngine({ db, bus, workspaceRoot }),
    disputes: engines.createDisputeEngine({ db, bus, workspaceRoot }),
    watcher: null,
    skippedDirs: [],
    reconcile(): void {
      const result = reconcile(db, workspaceRoot);
      session.skippedDirs = result.skippedDirs;
    },
  };
  session.reconcile();

  sessionBus.set(session, bus);
  if (opts.watch !== false) {
    startSessionWatcher(session);
  }

  return session;
}

/**
 * Creates and attaches the chokidar watcher to an existing session. Called
 * internally by createWorkspaceSession unless `watch: false`, and by the
 * reset orchestrator explicitly, after restore writes are on disk.
 */
export function startSessionWatcher(session: WorkspaceSession): void {
  const bus = sessionBus.get(session);
  if (!bus) throw new Error('startSessionWatcher: session has no associated bus');
  session.watcher = startWatcher({
    workspaceRoot: session.db.workspaceRoot,
    bus,
    onQuestionsChanged: () => session.reconcile(),
  });
}

/**
 * Tears down a session in the exact order the previous startAceServer's
 * close() used: watcher (skipped when null) → runner.dispose → reviews.dispose
 * → disputes.dispose → db.close.
 */
export async function closeWorkspaceSession(session: WorkspaceSession): Promise<void> {
  if (session.watcher) await session.watcher.close();
  session.runner.dispose();
  session.reviews.dispose();
  session.disputes.dispose();
  session.db.close();
}
