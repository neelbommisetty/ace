import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisputeEngine } from './disputes.js';
import type { ReviewEngine } from './reviews.js';
import type { Runner } from './runner.js';
import {
  closeWorkspaceSession,
  createWorkspaceSession,
  startSessionWatcher,
  type EngineFactories,
} from './session.js';
import { createBus } from './sse.js';

let tempRoot = '';

function questionDir(category: string, slug: string): string {
  return path.join(tempRoot, 'questions', category, slug);
}

function writeQuestion(category: string, slug: string): void {
  const dir = questionDir(category, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${slug}\n`, 'utf-8');
}

/** Fake engine factories that never touch the LLM or spawn vitest. */
function fakeEngines(): EngineFactories & {
  disposals: { runner: number; reviews: number; disputes: number };
} {
  const disposals = { runner: 0, reviews: 0, disputes: 0 };
  return {
    disposals,
    createRunner: (() => ({
      start: vi.fn(),
      dispose: vi.fn(() => {
        disposals.runner += 1;
      }),
    })) as unknown as EngineFactories['createRunner'],
    createReviewEngine: (() => ({
      start: vi.fn(),
      isRunning: vi.fn(() => false),
      dispose: vi.fn(() => {
        disposals.reviews += 1;
      }),
    })) as unknown as EngineFactories['createReviewEngine'],
    createDisputeEngine: (() => ({
      start: vi.fn(),
      isRunning: vi.fn(() => false),
      dispose: vi.fn(() => {
        disposals.disputes += 1;
      }),
    })) as unknown as EngineFactories['createDisputeEngine'],
  };
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

  it('two sessions over the same workspace get different epoch values', () => {
    writeQuestion('js-ts', 'x');
    const bus = createBus();

    const s1 = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines: fakeEngines() });
    s1.db.close();
    const s2 = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines: fakeEngines() });

    expect(s1.epoch).not.toBe(s2.epoch);
    expect(s1.epoch).toMatch(/^[0-9a-f-]{36}$/);
    expect(s2.epoch).toMatch(/^[0-9a-f-]{36}$/);

    s2.db.close();
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

describe('closeWorkspaceSession', () => {
  it('calls each fake engine dispose() exactly once and closes the db', async () => {
    const bus = createBus();
    const engines = fakeEngines();
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });

    await closeWorkspaceSession(session);

    expect(engines.disposals.runner).toBe(1);
    expect(engines.disposals.reviews).toBe(1);
    expect(engines.disposals.disputes).toBe(1);
    expect(() => session.db.listQuestions()).toThrow();
  });

  it('is safe when watcher is null (no watch attached)', async () => {
    const bus = createBus();
    const engines = fakeEngines();
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });
    expect(session.watcher).toBeNull();

    await expect(closeWorkspaceSession(session)).resolves.toBeUndefined();
  });
});
