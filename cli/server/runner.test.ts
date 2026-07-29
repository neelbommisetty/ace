// @vitest-environment node
//
// Integration coverage for createRunner() against real spawned child
// processes — NOT mocked child_process — in the style of the "engine busy
// flags" describe block in workspace-reset.test.ts:
//   * NEE-295 — Runner.cancel(runId) kills the in-flight process tree, marks
//     the run 'cancelled', broadcasts run-done, and leaves no orphaned
//     worker running.
//   * NEE-333 — the vitest spawn args now request both the json and default
//     reporters, with `--outputFile.json=` (not the old bare `--outputFile=`,
//     which with two reporters would apply to both). parseVitestJson's
//     unchanged parsing of the json-reporter file is covered separately in
//     runner-parse.test.ts; a full real-vitest console.log-surfacing check
//     lives at the UI/manual level (the TestConsole "Output" tab already
//     streams run-output verbatim).
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

/** A fake `vitest` binary that records the argv it was invoked with, then
 * exits immediately with a minimal-but-valid JSON report at whatever
 * `--outputFile.json=`/`--outputFile=` path it finds in argv. */
function writeArgvRecordingVitestBin(argvFile: string): void {
  const binDir = path.join(tempRoot, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'vitest'),
    [
      '#!/usr/bin/env node',
      `const fs = require('fs');`,
      `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
      'const path = require("path");',
      'const argv = process.argv.slice(2);',
      'const outArg = argv.find((a) => a.startsWith("--outputFile"));',
      'const outPath = outArg.split("=")[1];',
      'fs.writeFileSync(outPath, JSON.stringify({',
      '  numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,',
      '  testResults: [],',
      '}));',
      'process.exit(0);',
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

describe('vitest spawn args (NEE-333)', () => {
  it('requests both the json and default reporters, scoping the output file to json via --outputFile.json=', async () => {
    const question = writeCodingQuestion('js-ts', 'argv-check');
    const argvFile = path.join(tempRoot, 'argv.json');
    writeArgvRecordingVitestBin(argvFile);

    const bus = createBus();
    const runner = createRunner({ db, bus, workspaceRoot: tempRoot });
    const done = waitForBusEvent<{ status: string }>(bus, 'run-done');
    runner.start(question, null, 'manual');
    const result = await done;
    expect(result.status).toBe('done');

    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf-8')) as string[];
    expect(argv).toContain('--reporter=json');
    expect(argv).toContain('--reporter=default');
    expect(argv.some((a) => a.startsWith('--outputFile.json='))).toBe(true);
    // The old bare flag — which with two reporters would apply to both,
    // rather than scoping to json — must be gone.
    expect(argv.some((a) => a.startsWith('--outputFile=') && !a.startsWith('--outputFile.json='))).toBe(
      false,
    );
  });
});
