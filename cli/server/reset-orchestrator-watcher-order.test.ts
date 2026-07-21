import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from './sse.js';
import type { EngineFactories, WorkspaceSession } from './session.js';

/**
 * Isolated from reset-orchestrator.test.ts because it mocks './session.js'
 * and './workspace-reset.js' for the whole file to observe call order —
 * both mocks delegate to the real implementation, so behavior is unchanged,
 * but keeping this in its own file avoids any risk of the instrumentation
 * leaking into unrelated tests.
 */

const callOrder: string[] = [];

vi.mock('./session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session.js')>();
  return {
    ...actual,
    startSessionWatcher: (session: WorkspaceSession) => {
      callOrder.push('startSessionWatcher');
      return actual.startSessionWatcher(session);
    },
  };
});

vi.mock('./workspace-reset.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace-reset.js')>();
  return {
    ...actual,
    applyRestorePlan: (...args: Parameters<typeof actual.applyRestorePlan>) => {
      callOrder.push('applyRestorePlan');
      return actual.applyRestorePlan(...args);
    },
  };
});

let tempRoot = '';

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
  };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-reset-order-'));
  fs.mkdirSync(path.join(tempRoot, 'questions', 'js-ts', 'ordered'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'questions', 'js-ts', 'ordered', 'README.md'), '# ordered\n', 'utf-8');
  fs.writeFileSync(
    path.join(tempRoot, 'questions', 'js-ts', 'ordered', 'solution.ts'),
    'export const x = 1;\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(tempRoot, 'questions', 'js-ts', 'ordered', 'solution.test.ts'),
    "it('todo', () => {});\n",
    'utf-8',
  );
  callOrder.length = 0;
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('performWorkspaceReset — watcher ordering', () => {
  it('attaches the watcher only after applyRestorePlan has completed', async () => {
    const { createWorkspaceSession, closeWorkspaceSession } = await import('./session.js');
    const { performWorkspaceReset } = await import('./reset-orchestrator.js');

    const bus = createBus();
    let session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines: fakeEngines() });
    const getSession = () => session;
    const swapSession = (s: WorkspaceSession) => {
      session = s;
    };
    let resetting = false;
    const setResetting = (v: boolean) => {
      resetting = v;
    };

    const result = await performWorkspaceReset({
      workspaceRoot: tempRoot,
      bus,
      getSession,
      swapSession,
      setResetting,
      mode: 'progress',
      confirm: path.basename(tempRoot),
      engines: fakeEngines(),
    });

    expect(result.archivedTo).toBeTruthy();
    expect(resetting).toBe(false);
    // Both instrumented calls actually fired — otherwise the ordering
    // assertion below would pass vacuously.
    expect(callOrder).toContain('applyRestorePlan');
    expect(callOrder).toContain('startSessionWatcher');
    expect(callOrder.indexOf('applyRestorePlan')).toBeLessThan(callOrder.indexOf('startSessionWatcher'));
    expect(session.watcher).not.toBeNull();

    await closeWorkspaceSession(session);
  });
});
