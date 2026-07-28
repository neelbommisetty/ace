// @vitest-environment node
//
// Drives POST /api/workspace/reset through createApp's Hono instance with
// real Request/Response objects (app.request()), matching app-session.test.ts's
// harness. happy-dom's fetch/Headers polyfill drops the `Host` header the
// DNS-rebinding guard requires, so this file opts into Node's real fetch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getStubContent } from '../lib/scaffold.js';
import { createApp } from './app.js';
import { readBlob } from './blobs.js';
import { openDb } from './db.js';
import { toWorkspaceRelPath } from './files.js';
import { runImport, previewImport } from './importer.js';
import {
  closeWorkspaceSession,
  createWorkspaceSession,
  type EngineFactories,
  type WorkspaceSession,
} from './session.js';
import { createBus, type Bus } from './sse.js';
import { fakeEngines, TOKEN } from './test-support.js';
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
  return dir;
}

interface BusyFlags {
  runner: boolean;
  reviews: boolean;
  disputes: boolean;
  generation: boolean;
  brainstorm: boolean;
}

/** Fake engine factories, never touching the LLM or spawning vitest. Busy
 * state is read from a shared, mutable `flags` object so a test can flip a
 * flag after the session/app are already built. */
function busyEngines(flags: BusyFlags): EngineFactories {
  return fakeEngines({
    runner: { isBusy: () => flags.runner },
    reviews: { isAnyRunning: () => flags.reviews },
    disputes: { isAnyRunning: () => flags.disputes },
    generation: { isAnyRunning: () => flags.generation },
    brainstorm: { isAnyRunning: () => flags.brainstorm },
  });
}

/** Mimics the mutable getWorkspaceRoot/getSession/swapWorkspace/isSwapping
 * refs index.ts wires into createApp — the route reads/writes these across
 * the reset. */
function makeHarness(initialSession: WorkspaceSession) {
  let activeRoot: string | null = tempRoot;
  let activeSession: WorkspaceSession | null = initialSession;
  let swapping = false;
  return {
    getWorkspaceRoot: () => activeRoot,
    getSession: () => activeSession,
    swapWorkspace: (root: string | null, s: WorkspaceSession | null) => {
      activeRoot = root;
      activeSession = s;
    },
    isSwapping: () => swapping,
    setSwapping: (v: boolean) => {
      swapping = v;
    },
  };
}

function buildApp(
  bus: Bus,
  harness: ReturnType<typeof makeHarness>,
  engines: EngineFactories,
) {
  return createApp({
    bus,
    token: TOKEN,
    uiDir: null,
    version: '0.0.0-test',
    importer: { previewImport, runImport },
    getWorkspaceRoot: harness.getWorkspaceRoot,
    getSession: harness.getSession,
    isSwapping: harness.isSwapping,
    swapWorkspace: harness.swapWorkspace,
    setSwapping: harness.setSwapping,
    engines,
  });
}

/**
 * app.request() builds a Request in-process (no real network transport), so
 * — unlike a real HTTP client — nothing populates the `Host` header from the
 * URL automatically. The app's DNS-rebinding guard requires it, so every
 * request here sets it explicitly.
 */
function request(app: ReturnType<typeof buildApp>, url: string, init: RequestInit = {}) {
  return app.request(url, {
    ...init,
    headers: { host: 'localhost', ...(init.headers as Record<string, string> | undefined) },
  });
}

function postReset(
  app: ReturnType<typeof buildApp>,
  body: unknown,
): ReturnType<typeof request> {
  return request(app, `http://localhost/api/workspace/reset?t=${TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-reset-endpoint-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('POST /api/workspace/reset — happy path', () => {
  it('progress mode: archives the old db, reconciles fresh, keeps files, emits SSE once, new epoch', async () => {
    writeCodingQuestion('js-ts', 'debounce', { solution: 'export const x = 1;\n' });
    const bus = createBus();
    const flags: BusyFlags = { runner: false, reviews: false, disputes: false, generation: false, brainstorm: false };
    const engines = busyEngines(flags);
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });
    const oldEpoch = session.epoch;

    // Seed some state a fresh cycle should wipe: an attempt, a review, an
    // extra save snapshot.
    const question = session.db.getQuestion('js-ts', 'debounce')!;
    const attempt = session.db.createAttempt(question.id);
    session.db.addAttemptEvent(attempt.id, 'reveal');
    session.db.createReview({
      questionId: question.id,
      attemptId: attempt.id,
      bodyMd: 'looks fine',
      source: 'user',
    });

    const harness = makeHarness(session);
    const app = buildApp(bus, harness, engines);

    const events: Array<{ mode: string; archivedTo: string; requestId: string }> = [];
    bus.subscribe((name, data) => {
      if (name === 'workspace-reset') {
        events.push(data as { mode: string; archivedTo: string; requestId: string });
      }
    });

    const res = await postReset(app, { mode: 'progress', confirm: path.basename(tempRoot) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      archivedTo: string;
      restored: { questions: number; files: number };
      workspace: { counts: { questions: number; attempts: number; testRuns: number } };
    };

    expect(body.mode).toBe('progress');
    expect(fs.existsSync(path.join(body.archivedTo, 'ace.db'))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, '.ace', 'ace.db'))).toBe(true);

    // File content untouched byte-for-byte.
    const solutionAbs = path.join(questionDir('js-ts', 'debounce'), 'solution.ts');
    expect(fs.readFileSync(solutionAbs, 'utf-8')).toBe('export const x = 1;\n');

    // Fresh db: reconciled question, zeroed attempt/review history.
    expect(body.workspace.counts.questions).toBe(1);
    expect(body.workspace.counts.attempts).toBe(0);
    expect(body.restored).toEqual({ questions: 0, files: 0 });

    // Exactly one workspace-reset SSE event, emitted after the swap. No
    // `requestId` was sent in the request body, so the server minted a
    // fallback one itself.
    expect(events).toEqual([
      { mode: 'progress', archivedTo: body.archivedTo, requestId: expect.any(String) },
    ]);

    // New session is live with a fresh epoch and an attached watcher.
    const newSession = harness.getSession()!;
    expect(newSession.epoch).not.toBe(oldEpoch);
    expect(newSession.watcher).not.toBeNull();
    expect(harness.isSwapping()).toBe(false);

    await closeWorkspaceSession(newSession);
  });

  it('echoes a client-supplied requestId back verbatim in the workspace-reset broadcast', async () => {
    const bus = createBus();
    const flags: BusyFlags = { runner: false, reviews: false, disputes: false, generation: false, brainstorm: false };
    const engines = busyEngines(flags);
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });
    const harness = makeHarness(session);
    const app = buildApp(bus, harness, engines);

    const events: Array<{ mode: string; archivedTo: string; requestId: string }> = [];
    bus.subscribe((name, data) => {
      if (name === 'workspace-reset') {
        events.push(data as { mode: string; archivedTo: string; requestId: string });
      }
    });

    const res = await postReset(app, {
      mode: 'progress',
      confirm: path.basename(tempRoot),
      requestId: 'client-generated-id-123',
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0].requestId).toBe('client-generated-id-123');

    await closeWorkspaceSession(harness.getSession()!);
  });

  it('full mode: restores solution files to the scaffold baseline, leaves test files untouched, snapshots old code into the archive', async () => {
    const dir = writeCodingQuestion('js-ts', 'restore-me', {
      solution: 'export const solved = true;\n',
      test: 'it("dispute-fixed", () => {});\n',
    });
    const bus = createBus();
    const flags: BusyFlags = { runner: false, reviews: false, disputes: false, generation: false, brainstorm: false };
    const engines = busyEngines(flags);
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });

    const question = session.db.getQuestion('js-ts', 'restore-me')!;
    const solutionRel = toWorkspaceRelPath(tempRoot, path.join(dir, 'solution.ts'));
    const { saveBlob } = await import('./blobs.js');
    const scaffoldHash = saveBlob(tempRoot, 'export const scaffold = true;\n');
    session.db.addSnapshot({
      questionId: question.id,
      attemptId: null,
      relPath: solutionRel,
      hash: scaffoldHash,
      trigger: 'scaffold',
    });

    const testAbs = path.join(dir, 'solution.test.ts');
    const testContentBefore = fs.readFileSync(testAbs, 'utf-8');

    const harness = makeHarness(session);
    const app = buildApp(bus, harness, engines);

    const res = await postReset(app, { mode: 'full', confirm: path.basename(tempRoot) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      archivedTo: string;
      restored: { questions: number; files: number };
    };
    expect(body.mode).toBe('full');
    expect(body.restored).toEqual({ questions: 1, files: 1 });

    const solutionAbs = path.join(dir, 'solution.ts');
    expect(fs.readFileSync(solutionAbs, 'utf-8')).toBe('export const scaffold = true;\n');
    expect(fs.readFileSync(testAbs, 'utf-8')).toBe(testContentBefore);

    // The archived db (now sealed) holds a 'reset' snapshot of the pre-reset
    // (solved) code. openDb needs a workspace root whose child is literally
    // named '.ace', so copy the archive under a throwaway root to inspect it.
    const archiveCheckRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-reset-archive-check-'));
    fs.cpSync(body.archivedTo, path.join(archiveCheckRoot, '.ace'), { recursive: true });
    const archivedDb: AceDb = openDb(archiveCheckRoot);
    const resetSnap = archivedDb.getLatestSnapshot(question.id, solutionRel, 'reset');
    expect(resetSnap).not.toBeNull();
    expect(readBlob(archiveCheckRoot, resetSnap!.hash)).toBe('export const solved = true;\n');
    archivedDb.close();
    fs.rmSync(archiveCheckRoot, { recursive: true, force: true });

    await closeWorkspaceSession(harness.getSession()!);
  });

  it('full mode with no prior scaffold snapshot: restores to the template stub', async () => {
    const dir = writeCodingQuestion('js-ts', 'no-scaffold', { solution: 'export const edited = 1;\n' });
    const bus = createBus();
    const flags: BusyFlags = { runner: false, reviews: false, disputes: false, generation: false, brainstorm: false };
    const engines = busyEngines(flags);
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });
    const harness = makeHarness(session);
    const app = buildApp(bus, harness, engines);

    const res = await postReset(app, { mode: 'full', confirm: path.basename(tempRoot) });
    expect(res.status).toBe(200);

    const solutionAbs = path.join(dir, 'solution.ts');
    expect(fs.readFileSync(solutionAbs, 'utf-8')).toBe(getStubContent('js-ts', 'solution.ts'));

    await closeWorkspaceSession(harness.getSession()!);
  });
});

describe('POST /api/workspace/reset — guard matrix', () => {
  async function buildIdleApp() {
    writeCodingQuestion('js-ts', 'guarded');
    const bus = createBus();
    const flags: BusyFlags = { runner: false, reviews: false, disputes: false, generation: false, brainstorm: false };
    const engines = busyEngines(flags);
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });
    const harness = makeHarness(session);
    const app = buildApp(bus, harness, engines);
    return { app, harness, flags, session };
  }

  it('409s with "a test run is in progress" when the runner is busy, .ace untouched', async () => {
    const { app, flags } = await buildIdleApp();
    flags.runner = true;
    const res = await postReset(app, { mode: 'progress', confirm: path.basename(tempRoot) });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'a test run is in progress — wait for it to finish and try again',
    });
    expect(fs.existsSync(path.join(tempRoot, '.ace', 'ace.db'))).toBe(true);
  });

  it('409s with "a review is streaming" when a review is running, .ace untouched', async () => {
    const { app, flags } = await buildIdleApp();
    flags.reviews = true;
    const res = await postReset(app, { mode: 'progress', confirm: path.basename(tempRoot) });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'a review is streaming — wait for it to finish and try again',
    });
    expect(fs.existsSync(path.join(tempRoot, '.ace', 'ace.db'))).toBe(true);
  });

  it('409s with a dispute-in-progress message when a dispute analysis is running, .ace untouched', async () => {
    const { app, flags } = await buildIdleApp();
    flags.disputes = true;
    const res = await postReset(app, { mode: 'progress', confirm: path.basename(tempRoot) });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'a dispute analysis is in progress — wait for it to finish and try again',
    });
    expect(fs.existsSync(path.join(tempRoot, '.ace', 'ace.db'))).toBe(true);
  });

  it('409s with a generation-in-progress message when a generation job is running, .ace untouched', async () => {
    const { app, flags } = await buildIdleApp();
    flags.generation = true;
    const res = await postReset(app, { mode: 'progress', confirm: path.basename(tempRoot) });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'a generation is in progress — wait for it to finish and try again',
    });
    expect(fs.existsSync(path.join(tempRoot, '.ace', 'ace.db'))).toBe(true);
  });

  it('409s with a brainstorm-in-progress message when a brainstorm turn is thinking, .ace untouched', async () => {
    const { app, flags } = await buildIdleApp();
    flags.brainstorm = true;
    const res = await postReset(app, { mode: 'progress', confirm: path.basename(tempRoot) });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'a brainstorm turn is in progress — wait for it to finish and try again',
    });
    expect(fs.existsSync(path.join(tempRoot, '.ace', 'ace.db'))).toBe(true);
  });

  it('400s on an invalid mode', async () => {
    const { app } = await buildIdleApp();
    const res = await postReset(app, { mode: 'nope', confirm: path.basename(tempRoot) });
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(tempRoot, '.ace', 'ace.db'))).toBe(true);
  });

  it('400s with the exact confirm-phrase message on a wrong confirm string, .ace untouched', async () => {
    const { app } = await buildIdleApp();
    const res = await postReset(app, { mode: 'progress', confirm: 'not-the-folder-name' });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: `type the workspace folder name "${path.basename(tempRoot)}" to confirm`,
    });
    expect(fs.existsSync(path.join(tempRoot, '.ace', 'ace.db'))).toBe(true);
  });

  it('400s when confirm is missing entirely', async () => {
    const { app } = await buildIdleApp();
    const res = await postReset(app, { mode: 'progress' });
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(tempRoot, '.ace', 'ace.db'))).toBe(true);
  });

  it('400s on invalid JSON body', async () => {
    const { app } = await buildIdleApp();
    const res = await request(app, `http://localhost/api/workspace/reset?t=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/workspace/reset — concurrency', () => {
  it('a concurrent second POST gets 409 "already in progress" (bypassing the 503 gate), not a busy-engine 409', async () => {
    writeCodingQuestion('js-ts', 'slow-close');
    const bus = createBus();
    const flags: BusyFlags = { runner: false, reviews: false, disputes: false, generation: false, brainstorm: false };
    const engines = busyEngines(flags);
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });

    // Give the OLD session a fake watcher whose close() blocks on a promise
    // we control — closeWorkspaceSession awaits watcher.close() first, so
    // this deterministically pauses the reset mid-flight (right after the
    // resetting flag is set) without a real chokidar instance.
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    session.watcher = { close: () => closeGate };

    const harness = makeHarness(session);
    const app = buildApp(bus, harness, engines);

    const firstReq = postReset(app, { mode: 'progress', confirm: path.basename(tempRoot) });
    // Poll (rather than guessing a fixed microtask-tick count) until the
    // first request's continuation has run far enough to set the resetting
    // flag and block on the awaited watcher.close() call.
    for (let i = 0; i < 200 && !harness.isSwapping(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(harness.isSwapping()).toBe(true);

    const secondRes = await postReset(app, { mode: 'progress', confirm: path.basename(tempRoot) });
    expect(secondRes.status).toBe(409);
    expect((await secondRes.json()) as { error: string }).toEqual({
      error: 'a workspace reset or switch is already in progress',
    });

    releaseClose();
    const firstRes = await firstReq;
    expect(firstRes.status).toBe(200);

    await closeWorkspaceSession(harness.getSession()!);
  });

  it('a PUT /api/file already past the gate when a reset begins finishes against the old db (no 500) and the reset waits for it before closing that db', async () => {
    const dir = writeCodingQuestion('js-ts', 'straddle', { solution: 'export const before = 1;\n' });
    const bus = createBus();
    const flags: BusyFlags = { runner: false, reviews: false, disputes: false, generation: false, brainstorm: false };
    const engines = busyEngines(flags);
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });
    const harness = makeHarness(session);
    const app = buildApp(bus, harness, engines);

    // A save request that passed the 503 gate (resetting is still false)
    // but is suspended reading its body — mimics a client whose PUT body is
    // still streaming in when POST /api/workspace/reset begins.
    let releaseBody!: (chunk: Uint8Array) => void;
    let closeBody!: () => void;
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        releaseBody = (chunk) => controller.enqueue(chunk);
        closeBody = () => controller.close();
      },
    });
    const solutionRel = toWorkspaceRelPath(tempRoot, path.join(dir, 'solution.ts'));
    const putPromise = request(app, `http://localhost/api/file?t=${TOKEN}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: bodyStream,
      duplex: 'half',
    } as RequestInit);

    // Let the PUT's middleware chain run far enough to register as in-flight
    // (it suspends inside `await c.req.json()`, past the counter middleware)
    // before the reset starts.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const resetPromise = postReset(app, { mode: 'progress', confirm: path.basename(tempRoot) });
    for (let i = 0; i < 200 && !harness.isSwapping(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(harness.isSwapping()).toBe(true);

    // The reset must not sail through independently of the still-open PUT —
    // race it against a short timer to prove it's genuinely blocked (in
    // beforeDbClose's drain), not just naturally slow.
    const raceResult = await Promise.race([
      Promise.resolve(resetPromise).then(() => 'reset-resolved' as const),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 100)),
    ]);
    expect(raceResult).toBe('still-pending');

    // Now let the PUT's body arrive. Its handler (write + snapshot) must run
    // to completion against the still-open old db before the reset is
    // allowed to close it.
    releaseBody(
      new TextEncoder().encode(JSON.stringify({ path: solutionRel, content: 'export const after = 2;\n' })),
    );
    closeBody();

    const [putRes, resetRes] = await Promise.all([putPromise, resetPromise]);
    expect(putRes.status).toBe(200);
    expect(resetRes.status).toBe(200);

    await closeWorkspaceSession(harness.getSession()!);
  });

  it('while the resetting flag is set: GET /api/questions -> 503, POST /api/workspace/reset -> 409', async () => {
    writeCodingQuestion('js-ts', 'gate-check');
    const bus = createBus();
    const flags: BusyFlags = { runner: false, reviews: false, disputes: false, generation: false, brainstorm: false };
    const engines = busyEngines(flags);
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });
    const harness = makeHarness(session);
    const app = buildApp(bus, harness, engines);

    harness.setSwapping(true);
    try {
      const questions = await request(app, `http://localhost/api/questions?t=${TOKEN}`);
      expect(questions.status).toBe(503);

      const reset = await postReset(app, { mode: 'progress', confirm: path.basename(tempRoot) });
      expect(reset.status).toBe(409);
      expect((await reset.json()) as { error: string }).toEqual({
        error: 'a workspace reset or switch is already in progress',
      });
    } finally {
      harness.setSwapping(false);
    }

    await closeWorkspaceSession(harness.getSession()!);
  });
});

describe('POST /api/workspace/reset — archive-failure recovery', () => {
  it('500s, clears the resetting flag, leaves .ace intact, and the workspace stays usable', async () => {
    writeCodingQuestion('js-ts', 'archive-fail');
    const bus = createBus();
    const flags: BusyFlags = { runner: false, reviews: false, disputes: false, generation: false, brainstorm: false };
    const engines = busyEngines(flags);
    const session = createWorkspaceSession({ workspaceRoot: tempRoot, bus, watch: false, engines });
    const harness = makeHarness(session);
    const app = buildApp(bus, harness, engines);

    // Strip write permission on the workspace root so archiveAceDir's rename
    // throws EACCES/EPERM before .ace is touched.
    fs.chmodSync(tempRoot, 0o555);
    try {
      const res = await postReset(app, { mode: 'progress', confirm: path.basename(tempRoot) });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBeTruthy();
    } finally {
      fs.chmodSync(tempRoot, 0o755);
    }

    expect(harness.isSwapping()).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, '.ace', 'ace.db'))).toBe(true);

    // The workspace is still usable via the (recovered) live session.
    const workspaceRes = await request(app, `http://localhost/api/workspace?t=${TOKEN}`);
    expect(workspaceRes.status).toBe(200);

    await closeWorkspaceSession(harness.getSession()!);
  });
});
