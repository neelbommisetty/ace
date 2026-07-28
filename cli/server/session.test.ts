import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from './db.js';
import {
  closeWorkspaceSession,
  closeWorkspaceSessionSafe,
  createWorkspaceSession,
  startSessionWatcher,
  type EngineFactories,
} from './session.js';
import { createBus } from './sse.js';
import { fakeEngines } from './test-support.js';

let tempRoot = '';

function questionDir(category: string, slug: string): string {
  return path.join(tempRoot, 'questions', category, slug);
}

function writeQuestion(category: string, slug: string): void {
  const dir = questionDir(category, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${slug}\n`, 'utf-8');
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-session-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('createWorkspaceSession', () => {
  it('opens a db and reconciles questions/ on a temp workspace (watch: false)', () => {
    writeQuestion('js-ts', 'x');
    const bus = createBus();
    const engines = fakeEngines();

    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });

    const questions = session.db.listQuestions();
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ category: 'js-ts', slug: 'x' });

    session.db.close();
  });

  it('two sessions reopening the same underlying db get the SAME epoch (plain restart is not a reset)', () => {
    // The epoch is persisted in the db's own meta table (not minted fresh in
    // memory per session), specifically so that reopening the same db file —
    // a plain server restart, or the reset orchestrator's pre-rename
    // failure-recovery path, both of which rebuild a session over the same,
    // un-archived db — reads back the same epoch instead of manufacturing a
    // spurious "reset" signal for SSE clients watching for epoch changes.
    writeQuestion('js-ts', 'x');
    const bus = createBus();

    const s1 = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines: fakeEngines() });
    s1.db.close();
    const s2 = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines: fakeEngines() });

    expect(s2.epoch).toBe(s1.epoch);
    expect(s1.epoch).toMatch(/^[0-9a-f-]{36}$/);

    s2.db.close();
  });

  it('a fresh db (no prior session_epoch row) gets a newly minted epoch', () => {
    writeQuestion('js-ts', 'x');
    const bus = createBus();

    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines: fakeEngines() });

    expect(session.epoch).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.db.getMeta('session_epoch')).toBe(session.epoch);

    session.db.close();
  });

  it('watch: false leaves watcher null; startSessionWatcher attaches a real one', async () => {
    const bus = createBus();
    const session = createWorkspaceSession({
      workspaceRoot: tempRoot,
      bus,
      watch: false,
      engines: fakeEngines(),
    });

    expect(session.watcher).toBeNull();

    startSessionWatcher(session);
    expect(session.watcher).not.toBeNull();

    await closeWorkspaceSession(session);
  });
});

describe('createWorkspaceSession — generation/brainstorm engines', () => {
  it('exposes generation and brainstorm engines with their expected shapes', () => {
    const bus = createBus();
    const session = createWorkspaceSession({
      workspaceRoot: tempRoot,
      bus,
      watch: false,
      engines: fakeEngines(),
    });

    expect(typeof session.generation.start).toBe('function');
    expect(typeof session.generation.retry).toBe('function');
    expect(typeof session.generation.runningCount).toBe('function');
    expect(typeof session.generation.isAnyRunning).toBe('function');
    expect(typeof session.generation.dispose).toBe('function');

    expect(typeof session.brainstorm.startTurn).toBe('function');
    expect(typeof session.brainstorm.isThinking).toBe('function');
    expect(typeof session.brainstorm.isAnyRunning).toBe('function');
    expect(typeof session.brainstorm.dispose).toBe('function');

    session.db.close();
  });

  it('sweeps interrupted generation/brainstorm state at session build time (boot AND every rebuild)', () => {
    // Seed non-terminal rows directly against the db, as if a prior process
    // crashed mid-job/mid-turn, then close that raw handle — session build
    // reopens the same db file and must run the sweep before anything reads
    // from it.
    const seedDb = openDb(tempRoot);
    const runningJob = seedDb.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'debounce',
    });
    const llmDoneJobSeed = seedDb.createGenerationJob({
      category: 'js-ts',
      difficulty: 'hard',
      topic: 'throttle',
    });
    const resultPayload = { title: 'Throttle a function', description: 'implement throttle' };
    seedDb.patchGenerationJob(llmDoneJobSeed.id, {
      status: 'llm_done',
      result: resultPayload,
      title: 'Throttle a function',
    });
    const brainstormSession = seedDb.createBrainstormSession('give me some ideas');
    expect(brainstormSession.status).toBe('thinking');
    seedDb.close();

    const bus = createBus();
    const session = createWorkspaceSession({
      workspaceRoot: tempRoot,
      bus,
      watch: false,
      engines: fakeEngines(),
    });

    const sweptRunning = session.db.getGenerationJob(runningJob.id);
    expect(sweptRunning?.status).toBe('error');
    expect(sweptRunning?.errorMessage).toMatch(/interrupted by a server restart/);

    const sweptLlmDone = session.db.getGenerationJob(llmDoneJobSeed.id);
    expect(sweptLlmDone?.status).toBe('error');
    expect(sweptLlmDone?.errorMessage).toMatch(/no new LLM call/);
    // The whole point of the llm_done sweep: the paid result must survive so
    // a retry can be scaffold-only.
    expect(sweptLlmDone?.result).toEqual(resultPayload);
    expect(sweptLlmDone?.title).toBe('Throttle a function');

    const sweptBrainstorm = session.db.getBrainstormSession(brainstormSession.id);
    expect(sweptBrainstorm?.status).toBe('error');
    expect(sweptBrainstorm?.errorMessage).toMatch(/interrupted by a server restart/);

    session.db.close();
  });
});

describe('closeWorkspaceSession', () => {
  it('calls each fake engine dispose() exactly once and closes the db', async () => {
    const bus = createBus();
    const disposals = { runner: 0, reviews: 0, disputes: 0, generation: 0, brainstorm: 0 };
    const engines = fakeEngines({
      runner: { dispose: vi.fn(() => void disposals.runner++) },
      reviews: { dispose: vi.fn(() => void disposals.reviews++) },
      disputes: { dispose: vi.fn(() => void disposals.disputes++) },
      generation: { dispose: vi.fn(() => void disposals.generation++) },
      brainstorm: { dispose: vi.fn(() => void disposals.brainstorm++) },
    });
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });

    await closeWorkspaceSession(session);

    expect(disposals.runner).toBe(1);
    expect(disposals.reviews).toBe(1);
    expect(disposals.disputes).toBe(1);
    expect(disposals.generation).toBe(1);
    expect(disposals.brainstorm).toBe(1);
    expect(() => session.db.listQuestions()).toThrow();
  });

  it('is safe when watcher is null (no watch attached)', async () => {
    const bus = createBus();
    const engines = fakeEngines();
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });
    expect(session.watcher).toBeNull();

    await expect(closeWorkspaceSession(session)).resolves.toBeUndefined();
  });

  it('disposes generation and brainstorm AFTER disputes.dispose() and BEFORE db.close()', async () => {
    const bus = createBus();
    const callOrder: string[] = [];
    const engines: EngineFactories = fakeEngines({
      runner: { dispose: vi.fn(() => callOrder.push('runner')) },
      reviews: { dispose: vi.fn(() => callOrder.push('reviews')) },
      disputes: { dispose: vi.fn(() => callOrder.push('disputes')) },
      generation: { dispose: vi.fn(() => callOrder.push('generation')) },
      brainstorm: { dispose: vi.fn(() => callOrder.push('brainstorm')) },
    });
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });
    const closeSpy = vi.spyOn(session.db, 'close').mockImplementation(() => {
      callOrder.push('db.close');
    });

    await closeWorkspaceSession(session);

    const disputesIdx = callOrder.indexOf('disputes');
    const generationIdx = callOrder.indexOf('generation');
    const brainstormIdx = callOrder.indexOf('brainstorm');
    const dbCloseIdx = callOrder.indexOf('db.close');
    expect(disputesIdx).toBeGreaterThanOrEqual(0);
    expect(generationIdx).toBeGreaterThan(disputesIdx);
    expect(brainstormIdx).toBeGreaterThan(disputesIdx);
    expect(dbCloseIdx).toBeGreaterThan(generationIdx);
    expect(dbCloseIdx).toBeGreaterThan(brainstormIdx);

    closeSpy.mockRestore();
    session.db.close();
  });
});

describe('closeWorkspaceSessionSafe', () => {
  it('a throwing engine.dispose() does not prevent the rest of teardown (including db.close()) from completing', async () => {
    const bus = createBus();
    const disposals = { runner: 0, reviews: 0, disputes: 0, brainstorm: 0 };
    const engines: EngineFactories = fakeEngines({
      runner: { dispose: vi.fn(() => void disposals.runner++) },
      reviews: { dispose: vi.fn(() => void disposals.reviews++) },
      disputes: { dispose: vi.fn(() => void disposals.disputes++) },
      generation: {
        // Simulates a broken generation engine's teardown.
        dispose: vi.fn(() => {
          throw new Error('generation dispose blew up');
        }),
      },
      brainstorm: { dispose: vi.fn(() => void disposals.brainstorm++) },
    });
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });

    await expect(closeWorkspaceSessionSafe(session)).resolves.toBeUndefined();

    // Every other step still ran despite generation.dispose() throwing.
    expect(disposals.runner).toBe(1);
    expect(disposals.reviews).toBe(1);
    expect(disposals.disputes).toBe(1);
    expect(disposals.brainstorm).toBe(1);
    expect(() => session.db.listQuestions()).toThrow();
  });
});
