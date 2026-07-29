// @vitest-environment node
//
// Integration coverage for createRunner() against a real spawned child
// process — NOT mocked child_process — in the style of the "engine busy
// flags" describe block in workspace-reset.test.ts: Runner.cancel(runId)
// kills the in-flight process tree, marks the run 'cancelled', broadcasts
// run-done, and leaves no orphaned worker running (NEE-295).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from './db.js';
import { createRunner } from './runner.js';
import { createBus, type Bus } from './sse.js';
import type { AceDb, QuestionRow, TestRunRow } from './types.js';

let tempRoot = '';
let db: AceDb;

function questionDir(category: string, slug: string): string {
  return path.join(tempRoot, 'questions', category, slug);
}

function writeCodingQuestion(
  category: string,
  slug: string,
  opts: { solution?: string; test?: string } = {},
): QuestionRow {
  const dir = questionDir(category, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${slug}\n`, 'utf-8');
  fs.writeFileSync(
    path.join(dir, 'solution.ts'),
    opts.solution ?? 'export function solve() {}\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'solution.test.ts'),
    opts.test ?? "it('todo', () => {});\n",
    'utf-8',
  );
  return db.upsertQuestion({
    category,
    slug,
    title: slug,
    difficulty: 'easy',
    suggestedMinutes: 15,
    dirPath: dir,
    source: 'manual',
  });
}

/** A fake `vitest` binary that never exits on its own and heartbeats a file
 * (so a test can prove the process is still alive, and later prove it isn't
 * — the "no orphaned worker" assertion — without needing the runner to
 * expose a pid). Args are ignored, matching the existing fake-bin pattern in
 * workspace-reset.test.ts's "engine busy flags" tests. */
function writeHangingVitestBin(heartbeatFile: string): void {
  const binDir = path.join(tempRoot, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'vitest'),
    [
      '#!/usr/bin/env node',
      `const fs = require('fs');`,
      `const heartbeat = ${JSON.stringify(heartbeatFile)};`,
      'let i = 0;',
      "setInterval(() => { fs.writeFileSync(heartbeat, String(i++)); }, 20);",
      // Long enough that it would never exit on its own within the test.
      'setTimeout(() => process.exit(0), 60000);',
    ].join('\n'),
    { mode: 0o755 },
  );
}

function waitForBusEvent<T = unknown>(bus: Bus, name: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${name}"`)), timeoutMs);
    bus.subscribe((evName, data) => {
      if (evName !== name) return;
      clearTimeout(timer);
      resolve(data as T);
    });
  });
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-runner-test-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  db = openDb(tempRoot);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('Runner.cancel() (NEE-295)', () => {
  it('kills the in-flight process, marks the run cancelled, and broadcasts run-done — without starting a replacement', async () => {
    const question = writeCodingQuestion('js-ts', 'runaway');
    const heartbeatFile = path.join(tempRoot, 'heartbeat.txt');
    writeHangingVitestBin(heartbeatFile);

    const bus = createBus();
    const runner = createRunner({ db, bus, workspaceRoot: tempRoot });

    const run = runner.start(question, null, 'manual');
    expect(runner.isBusy()).toBe(true);

    // Wait for the fake process to actually be alive and heartbeating before
    // cancelling — otherwise a false pass could slip through if cancel()
    // raced ahead of the spawn.
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (fs.existsSync(heartbeatFile)) return resolve();
        if (Date.now() - start > 5000) return reject(new Error('fake vitest never heartbeated'));
        setTimeout(poll, 20);
      };
      poll();
    });
    const heartbeatBeforeCancel = fs.readFileSync(heartbeatFile, 'utf-8');

    const runDonePromise = waitForBusEvent<{ runId: string; status: string }>(bus, 'run-done');

    const cancelStart = Date.now();
    const cancelled = runner.cancel(run.id);
    expect(cancelled).toBe(true);

    const runDone = await runDonePromise;
    const elapsedMs = Date.now() - cancelStart;
    // "well under a second" per the ticket's acceptance criteria.
    expect(elapsedMs).toBeLessThan(1000);
    expect(runDone.runId).toBe(run.id);
    expect(runDone.status).toBe('cancelled');

    expect(runner.isBusy()).toBe(false);

    const row = db.getTestRun(run.id) as TestRunRow;
    expect(row.status).toBe('cancelled');

    // No orphaned worker: give the killed process a moment to have written
    // one more heartbeat tick IF it were somehow still alive, then confirm
    // it hasn't advanced.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const heartbeatAfterWait = fs.readFileSync(heartbeatFile, 'utf-8');
    expect(heartbeatAfterWait).toBe(heartbeatBeforeCancel);
  });

  it('returns false for a runId that is not currently in flight (unknown or already finished)', async () => {
    const bus = createBus();
    const runner = createRunner({ db, bus, workspaceRoot: tempRoot });
    expect(runner.cancel('not-a-real-run-id')).toBe(false);

    // A run that already finished (fast fake bin) is also no longer in flight.
    const question = writeCodingQuestion('js-ts', 'quick');
    const binDir = path.join(tempRoot, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'vitest'), '#!/usr/bin/env node\nprocess.exit(0);\n', {
      mode: 0o755,
    });
    const done = waitForBusEvent(bus, 'run-done');
    const run = runner.start(question, null, 'manual');
    await done;
    expect(runner.cancel(run.id)).toBe(false);
  });
});
