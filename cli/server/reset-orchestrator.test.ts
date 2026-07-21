import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStubContent } from '../lib/scaffold.js';
import { readBlob } from './blobs.js';
import { openDb } from './db.js';
import { toWorkspaceRelPath } from './files.js';
import { performWorkspaceReset } from './reset-orchestrator.js';
import { closeWorkspaceSession, createWorkspaceSession, type EngineFactories, type WorkspaceSession } from './session.js';
import { createBus } from './sse.js';
import type { AceDb } from './types.js';

let tempRoot = '';

function questionDir(category: string, slug: string): string {
  return path.join(tempRoot, 'questions', category, slug);
}

function writeCodingQuestion(
  category: string,
  slug: string,
  opts: { solution?: string; test?: string } = {},
): string {
  const dir = questionDir(category, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${slug}\n`, 'utf-8');
  fs.writeFileSync(path.join(dir, 'solution.ts'), opts.solution ?? 'export function solve() {}\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'solution.test.ts'), opts.test ?? "it('todo', () => {});\n", 'utf-8');
  return dir;
}

/** Fake engine factories that never touch the LLM or spawn vitest. */
function fakeEngines(): EngineFactories {
  return {
    createRunner: (() => ({ start: vi.fn(), isBusy: () => false, dispose: vi.fn() })) as unknown as EngineFactories['createRunner'],
    createReviewEngine: (() => ({
      start: vi.fn(),
      isRunning: () => false,
      isAnyRunning: () => false,
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createReviewEngine'],
    createDisputeEngine: (() => ({
      start: vi.fn(),
      isRunning: () => false,
      isAnyRunning: () => false,
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createDisputeEngine'],
    createGenerationEngine: (() => ({
      start: vi.fn(),
      retry: vi.fn(),
      runningCount: () => 0,
      isAnyRunning: () => false,
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createGenerationEngine'],
    createBrainstormEngine: (() => ({
      startTurn: vi.fn(),
      isThinking: () => false,
      isAnyRunning: () => false,
      dispose: vi.fn(),
    })) as unknown as EngineFactories['createBrainstormEngine'],
  };
}

/** Minimal in-test harness mimicking index.ts's getSession/swapSession/isResetting refs. */
function makeHarness(bus: ReturnType<typeof createBus>) {
  let session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines: fakeEngines() });
  let resetting = false;
  return {
    get session() {
      return session;
    },
    getSession: () => session,
    swapSession: (s: WorkspaceSession) => {
      session = s;
    },
    setResetting: (v: boolean) => {
      resetting = v;
    },
    isResetting: () => resetting,
    async cleanup() {
      await closeWorkspaceSession(session).catch(() => {});
    },
  };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-reset-orch-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('performWorkspaceReset — happy path (progress)', () => {
  it('archives the old db, reconciles a fresh one, leaves files untouched, and swaps to a new epoch', async () => {
    writeCodingQuestion('js-ts', 'debounce', { solution: 'export const x = 1;\n' });
    const bus = createBus();
    const harness = makeHarness(bus);
    const oldEpoch = harness.session.epoch;

    const events: Array<{ mode: string; archivedTo: string; requestId: string }> = [];
    bus.subscribe((name, data) => {
      if (name === 'workspace-reset') {
        events.push(data as { mode: string; archivedTo: string; requestId: string });
      }
    });

    const result = await performWorkspaceReset({
      workspaceRoot: tempRoot,
      bus,
      getSession: harness.getSession,
      swapSession: harness.swapSession,
      setResetting: harness.setResetting,
      mode: 'progress',
      confirm: path.basename(tempRoot),
      requestId: 'req-1',
      engines: fakeEngines(),
    });

    expect(fs.existsSync(path.join(result.archivedTo, 'ace.db'))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, '.ace', 'ace.db'))).toBe(true);

    const solutionAbs = path.join(questionDir('js-ts', 'debounce'), 'solution.ts');
    expect(fs.readFileSync(solutionAbs, 'utf-8')).toBe('export const x = 1;\n');

    const newSession = harness.getSession();
    expect(newSession.epoch).not.toBe(oldEpoch);
    expect(newSession.db.listQuestions()).toHaveLength(1);
    expect(newSession.db.listQuestions()[0]).toMatchObject({ category: 'js-ts', slug: 'debounce' });
    expect(newSession.watcher).not.toBeNull();

    // applyRestorePlan still seeds a 'scaffold' snapshot per question in
    // progress mode (see workspace-reset.test.ts), but that's internal
    // bookkeeping, not a restoration — the reported counts are zeros.
    expect(result.restored).toEqual({ questions: 0, files: 0 });
    expect(harness.isResetting()).toBe(false);
    expect(events).toEqual([
      { mode: 'progress', archivedTo: result.archivedTo, requestId: 'req-1' },
    ]);

    await harness.cleanup();
  });
});

describe('performWorkspaceReset — happy path (full)', () => {
  it('restores disk to the scaffold baseline, leaves test files untouched, and snapshots the old code into the archive', async () => {
    const dir = writeCodingQuestion('js-ts', 'restore-me', {
      solution: 'export const solved = true;\n',
      test: 'it("dispute-fixed", () => {});\n',
    });
    const bus = createBus();
    const harness = makeHarness(bus);

    // Seed a scaffold baseline that differs from the current on-disk code.
    const question = harness.session.db.getQuestion('js-ts', 'restore-me')!;
    const solutionRel = toWorkspaceRelPath(tempRoot, path.join(dir, 'solution.ts'));
    const { saveBlob } = await import('./blobs.js');
    const scaffoldHash = saveBlob(tempRoot, 'export const scaffold = true;\n');
    harness.session.db.addSnapshot({
      questionId: question.id,
      attemptId: null,
      relPath: solutionRel,
      hash: scaffoldHash,
      trigger: 'scaffold',
    });

    const testAbs = path.join(dir, 'solution.test.ts');
    const testContentBefore = fs.readFileSync(testAbs, 'utf-8');

    const result = await performWorkspaceReset({
      workspaceRoot: tempRoot,
      bus,
      getSession: harness.getSession,
      swapSession: harness.swapSession,
      setResetting: harness.setResetting,
      mode: 'full',
      confirm: path.basename(tempRoot),
      engines: fakeEngines(),
    });

    const solutionAbs = path.join(dir, 'solution.ts');
    expect(fs.readFileSync(solutionAbs, 'utf-8')).toBe('export const scaffold = true;\n');
    expect(fs.readFileSync(testAbs, 'utf-8')).toBe(testContentBefore);
    expect(result.restored).toEqual({ questions: 1, files: 1 });

    // The old db, now sealed inside the archive, holds a 'reset' snapshot of
    // the pre-reset (solved) code. openDb expects a workspace root whose
    // child is literally named '.ace', so copy the archive dir under a
    // throwaway root with that name to open it read-only for inspection.
    const archiveCheckRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-reset-archive-check-'));
    fs.cpSync(result.archivedTo, path.join(archiveCheckRoot, '.ace'), { recursive: true });
    const archivedDb: AceDb = openDb(archiveCheckRoot);
    const resetSnap = archivedDb.getLatestSnapshot(question.id, solutionRel, 'reset');
    expect(resetSnap).not.toBeNull();
    expect(readBlob(archiveCheckRoot, resetSnap!.hash)).toBe('export const solved = true;\n');
    archivedDb.close();
    fs.rmSync(archiveCheckRoot, { recursive: true, force: true });

    const newSession = harness.getSession();
    const newQuestion = newSession.db.getQuestion('js-ts', 'restore-me')!;
    const scaffoldSnap = newSession.db.getLatestSnapshot(newQuestion.id, solutionRel, 'scaffold');
    expect(scaffoldSnap).not.toBeNull();
    expect(readBlob(tempRoot, scaffoldSnap!.hash)).toBe('export const scaffold = true;\n');

    await harness.cleanup();
  });

  it('restores to the template stub when there is no scaffold snapshot', async () => {
    const dir = writeCodingQuestion('js-ts', 'no-scaffold', { solution: 'export const edited = 1;\n' });
    const bus = createBus();
    const harness = makeHarness(bus);

    const result = await performWorkspaceReset({
      workspaceRoot: tempRoot,
      bus,
      getSession: harness.getSession,
      swapSession: harness.swapSession,
      setResetting: harness.setResetting,
      mode: 'full',
      confirm: path.basename(tempRoot),
      engines: fakeEngines(),
    });

    expect(result.restored).toEqual({ questions: 1, files: 1 });
    const solutionAbs = path.join(dir, 'solution.ts');
    expect(fs.readFileSync(solutionAbs, 'utf-8')).toBe(getStubContent('js-ts', 'solution.ts'));

    await harness.cleanup();
  });
});

describe('performWorkspaceReset — archive failure recovery', () => {
  it('clears the resetting flag, leaves the old .ace intact, and rethrows when archiveAceDir fails', async () => {
    writeCodingQuestion('js-ts', 'safe', { solution: 'export const x = 1;\n' });
    const bus = createBus();
    const harness = makeHarness(bus);

    // A same-day filename collision is handled gracefully (it appends -2),
    // so to force archiveAceDir itself to throw, strip write permission on
    // the parent dir — fs.renameSync then fails with EACCES/EPERM.
    fs.chmodSync(tempRoot, 0o555);

    try {
      await expect(
        performWorkspaceReset({
          workspaceRoot: tempRoot,
          bus,
          getSession: harness.getSession,
          swapSession: harness.swapSession,
          setResetting: harness.setResetting,
          mode: 'progress',
          confirm: path.basename(tempRoot),
          engines: fakeEngines(),
        }),
      ).rejects.toThrow();
    } finally {
      fs.chmodSync(tempRoot, 0o755);
    }

    expect(harness.isResetting()).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, '.ace', 'ace.db'))).toBe(true);

    // The accessor still resolves to a live, usable session.
    const recovered = harness.getSession();
    expect(() => recovered.db.listQuestions()).not.toThrow();

    await harness.cleanup();
  });
});
