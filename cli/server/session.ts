import crypto from 'node:crypto';
import { createAiLog } from './ai-log.js';
import { createBrainstormEngine, type BrainstormEngine } from './brainstorm.js';
import { openDb } from './db.js';
import { createDisputeEngine, type DisputeEngine } from './disputes.js';
import { createGenerationEngine, type GenerationEngine } from './generation.js';
import { createProbeEngine, type ProbeEngine } from './probes.js';
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
   * Id of the underlying `.ace/ace.db`, persisted in that db's own `meta`
   * table (see `resolveEpoch` below) rather than minted fresh on every
   * `createWorkspaceSession` call. Surfaced in the SSE `hello` payload so
   * reconnecting tabs can detect that a reset happened while they were
   * disconnected: a genuine reset (`workspace-reset`) always opens a brand
   * new db (the old one is archived away), so its epoch is guaranteed to
   * differ from the previous session's. A plain server restart, or the
   * failure-recovery paths in the reset orchestrator that rebuild a session
   * over the *same*, un-archived db, reopen that same db file and therefore
   * read back the same persisted epoch — so those cases must NOT be treated
   * as a reset by epoch-watching clients.
   */
  epoch: string;
  db: AceDb;
  runner: Runner;
  reviews: ReviewEngine;
  disputes: DisputeEngine;
  probes: ProbeEngine;
  generation: GenerationEngine;
  brainstorm: BrainstormEngine;
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
  createProbeEngine: typeof createProbeEngine;
  createGenerationEngine: typeof createGenerationEngine;
  createBrainstormEngine: typeof createBrainstormEngine;
}

const defaultEngines: EngineFactories = {
  createRunner,
  createReviewEngine,
  createDisputeEngine,
  createProbeEngine,
  createGenerationEngine,
  createBrainstormEngine,
};

export interface CreateWorkspaceSessionOptions {
  workspaceRoot: string;
  bus: Bus;
  /** Defaults to true (chokidar watcher attached inline). false returns watcher: null. */
  watch?: boolean;
  /** Defaults to the real createRunner/createReviewEngine/createDisputeEngine/createProbeEngine/createGenerationEngine/createBrainstormEngine. */
  engines?: EngineFactories;
}

// The Bus a session was created with, keyed by object identity — needed by
// startSessionWatcher (called later, e.g. by the reset orchestrator, with
// just the session). Not part of the public WorkspaceSession shape.
const sessionBus = new WeakMap<WorkspaceSession, Bus>();

const EPOCH_META_KEY = 'session_epoch';

/**
 * Reads the db-persisted epoch, minting and storing one on first open (a
 * brand new db — either the workspace's very first boot, or a fresh db
 * created right after a reset archived the old `.ace` away — has no
 * `session_epoch` row yet). Reopening the same db file on a later boot (a
 * plain restart, or session-rebuild-over-the-same-db failure-recovery path)
 * finds the row already there and returns it unchanged, so the epoch only
 * ever changes when a reset genuinely swaps in a new db.
 */
function resolveEpoch(db: AceDb): string {
  const existing = db.getMeta(EPOCH_META_KEY);
  if (existing != null) return existing;
  const fresh = crypto.randomUUID();
  db.setMeta(EPOCH_META_KEY, fresh);
  return fresh;
}

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
  // Runs at every session build — boot AND every post-reset rebuild — so a
  // job/session left non-terminal by a server crash (or a reset racing an
  // in-flight generation/brainstorm call) always surfaces as 'error' rather
  // than hanging forever as "in progress" with no engine left to resume it.
  db.sweepInterruptedGenerationState();

  // One AI-activity recorder shared by all four AI engines (NEE-268): every
  // run they log lands in the same ai_runs/ai_steps tables and streams over
  // the same bus. Engines default to NULL_AI_LOG when built without one, so
  // tests supplying fakes are untouched.
  const aiLog = createAiLog({ db, bus });

  const session: WorkspaceSession = {
    epoch: resolveEpoch(db),
    db,
    runner: engines.createRunner({ db, bus, workspaceRoot }),
    reviews: engines.createReviewEngine({ db, bus, workspaceRoot, aiLog }),
    disputes: engines.createDisputeEngine({ db, bus, workspaceRoot, aiLog }),
    probes: engines.createProbeEngine({ db, bus, workspaceRoot, aiLog }),
    generation: engines.createGenerationEngine({ db, bus, workspaceRoot, aiLog }),
    brainstorm: engines.createBrainstormEngine({ db, bus, workspaceRoot, aiLog }),
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
 * The one place the session's disposable engines are enumerated for
 * teardown. The array's order IS the documented teardown contract (asserted
 * by session.test.ts): watcher (skipped when null) → runner → reviews →
 * disputes → probes → generation → brainstorm → [beforeDbClose] → db.close —
 * the watcher/beforeDbClose/db.close steps stay explicit in the two close
 * functions below; every engine dispose between them runs in this order.
 * Adding a seventh engine means adding its key here, so both
 * closeWorkspaceSession and closeWorkspaceSessionSafe pick it up at once.
 */
const ENGINE_KEYS = ['runner', 'reviews', 'disputes', 'probes', 'generation', 'brainstorm'] as const;

/**
 * Tears down a session in the exact order the previous startAceServer's
 * close() used: watcher (skipped when null) → the ENGINE_KEYS dispose loop →
 * [beforeDbClose] → db.close.
 *
 * `beforeDbClose`, if given, runs after the engines are disposed and before
 * the db is closed — this is the seam the HTTP server's own close() must run
 * in, so an in-flight request handler that resumes mid-shutdown still finds
 * the db open (matches the pre-session.ts ordering: server.close() happened
 * before db.close(), not after). Like the rest of this function, a rejection
 * from `beforeDbClose` propagates and aborts the db.close() step — callers
 * that want best-effort cleanup on a failure path should use
 * closeWorkspaceSessionSafe instead.
 */
export async function closeWorkspaceSession(
  session: WorkspaceSession,
  opts?: { beforeDbClose?: () => Promise<void> },
): Promise<void> {
  if (session.watcher) await session.watcher.close();
  for (const key of ENGINE_KEYS) {
    session[key].dispose();
  }
  await opts?.beforeDbClose?.();
  session.db.close();
}

/**
 * Best-effort teardown for failure paths (e.g. boot failure during
 * startAceServer, so a caller retrying on the next port doesn't inherit a
 * leaked db handle or live engines). Unlike closeWorkspaceSession, each step
 * is guarded individually so a rejection from one (most commonly
 * watcher.close(), which does real chokidar teardown work) doesn't skip the
 * rest — mirrors the per-step try/catch the old inline boot-failure handler
 * in startAceServer used before this file existed.
 */
export async function closeWorkspaceSessionSafe(session: WorkspaceSession): Promise<void> {
  if (session.watcher) {
    await session.watcher.close().catch(() => {});
  }
  for (const key of ENGINE_KEYS) {
    try {
      session[key].dispose();
    } catch {
      // best effort
    }
  }
  try {
    session.db.close();
  } catch {
    // already closed, or never fully opened
  }
}
