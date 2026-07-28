// @vitest-environment node
//
// Drives POST /api/workspace/switch (NEE-164) through createApp's Hono
// instance with real Request/Response objects, matching
// reset-endpoint.test.ts's harness — same Node-fetch opt-in rationale (the
// happy-dom polyfill drops the `Host` header the DNS-rebinding guard needs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { runImport, previewImport } from './importer.js';
import {
  closeWorkspaceSession,
  createWorkspaceSession,
  type EngineFactories,
  type WorkspaceSession,
} from './session.js';
import { createBus, type Bus } from './sse.js';
import { fakeEngines, TOKEN } from './test-support.js';
import type { RecentWorkspace } from './workspace-registry.js';

let tempHome = '';
let rootA = '';
let rootB = '';
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function writeCodingQuestion(root: string, slug: string, solution: string): void {
  const dir = path.join(root, 'questions', 'js-ts', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${slug}\n`, 'utf-8');
  fs.writeFileSync(path.join(dir, 'solution.ts'), solution, 'utf-8');
  fs.writeFileSync(path.join(dir, 'solution.test.ts'), "it('todo', () => {});\n", 'utf-8');
}

interface BusyFlags {
  runner: boolean;
  reviews: boolean;
  disputes: boolean;
  generation: boolean;
  brainstorm: boolean;
}

function idleFlags(): BusyFlags {
  return { runner: false, reviews: false, disputes: false, generation: false, brainstorm: false };
}

/**
 * Fake engine factories that record every dispose() as `"<kind>:<root>"`
 * into `disposed` — the leak check asserts the OLD session's five engines
 * were all torn down (and the new session's were not). Each override is a
 * function of the real factory's opts so it can tag the disposal with the
 * `workspaceRoot` that particular engine instance was built for (the SAME
 * EngineFactories object is reused across the old and new sessions around a
 * switch, so a plain per-engine singleton couldn't tell them apart).
 */
function busyEngines(flags: BusyFlags, disposed: string[] = []): EngineFactories {
  return fakeEngines({
    runner: (opts) => ({
      isBusy: () => flags.runner,
      dispose: () => disposed.push(`runner:${opts.workspaceRoot}`),
    }),
    reviews: (opts) => ({
      isAnyRunning: () => flags.reviews,
      dispose: () => disposed.push(`reviews:${opts.workspaceRoot}`),
    }),
    disputes: (opts) => ({
      isAnyRunning: () => flags.disputes,
      dispose: () => disposed.push(`disputes:${opts.workspaceRoot}`),
    }),
    generation: (opts) => ({
      isAnyRunning: () => flags.generation,
      dispose: () => disposed.push(`generation:${opts.workspaceRoot}`),
    }),
    brainstorm: (opts) => ({
      isAnyRunning: () => flags.brainstorm,
      dispose: () => disposed.push(`brainstorm:${opts.workspaceRoot}`),
    }),
  });
}

/** Same mutable-refs harness as reset-endpoint.test.ts, but the root swaps too. */
function makeHarness(initialRoot: string | null, initialSession: WorkspaceSession | null) {
  let activeRoot = initialRoot;
  let activeSession = initialSession;
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

function request(app: ReturnType<typeof buildApp>, url: string, init: RequestInit = {}) {
  return app.request(url, {
    ...init,
    headers: { host: 'localhost', ...(init.headers as Record<string, string> | undefined) },
  });
}

function postSwitch(app: ReturnType<typeof buildApp>, body: unknown) {
  return request(app, `http://localhost/api/workspace/switch?t=${TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Reads the SSE hello frame off /api/events (same pattern as app-session.test.ts). */
async function readHello(
  app: ReturnType<typeof buildApp>,
): Promise<{ version: string; workspaceRoot: string | null; epoch: string | null }> {
  const res = await request(app, `http://localhost/api/events?t=${TOKEN}`);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
  expect(dataLine).toBeDefined();
  return JSON.parse(dataLine!.slice('data:'.length).trim()) as {
    version: string;
    workspaceRoot: string | null;
    epoch: string | null;
  };
}

function readRegistryRoots(): string[] {
  const file = path.join(tempHome, '.ace', 'workspaces.json');
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as RecentWorkspace[]).map((r) => r.root);
}

type SwitchedEvent = { workspaceRoot: string; epoch: string; requestId: string };

function collectSwitched(bus: Bus): SwitchedEvent[] {
  const events: SwitchedEvent[] = [];
  bus.subscribe((name, data) => {
    if (name === 'workspace-switched') events.push(data as SwitchedEvent);
  });
  return events;
}

beforeEach(() => {
  // The recents registry writes to ~/.ace via process.env.HOME — isolate it.
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-switch-home-'));
  process.env.HOME = tempHome;
  delete process.env.USERPROFILE;
  rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-switch-a-'));
  rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-switch-b-'));
  writeCodingQuestion(rootA, 'alpha-q', 'export const alpha = 1;\n');
  writeCodingQuestion(rootB, 'beta-q', 'export const beta = 1;\n');
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
  for (const dir of [tempHome, rootA, rootB]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('POST /api/workspace/switch — happy path', () => {
  it('swaps root+session, serves files/questions from the new root, reports a new epoch over SSE, tears the old session down, records recents, and broadcasts with the requestId echoed', async () => {
    const bus = createBus();
    const flags = idleFlags();
    const disposed: string[] = [];
    const engines = busyEngines(flags, disposed);
    const oldSession = createWorkspaceSession({ workspaceRoot: rootA, bus, watch: false, engines });
    const oldEpoch = oldSession.epoch;
    const watcherClose = vi.fn(async () => {});
    oldSession.watcher = { close: watcherClose };

    const harness = makeHarness(rootA, oldSession);
    const app = buildApp(bus, harness, engines);
    const events = collectSwitched(bus);

    const helloBefore = await readHello(app);
    expect(helloBefore).toMatchObject({ workspaceRoot: rootA, epoch: oldEpoch });

    const res = await postSwitch(app, { root: rootB, requestId: 'switch-req-1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaceRoot: string;
      epoch: string;
      workspace: { root: string; counts: { questions: number } };
    };
    expect(body.workspaceRoot).toBe(rootB);
    expect(body.epoch).not.toBe(oldEpoch);
    expect(body.workspace.root).toBe(rootB);
    expect(body.workspace.counts.questions).toBe(1);

    // The accessors now resolve to the new root/session.
    expect(harness.getWorkspaceRoot()).toBe(rootB);
    const newSession = harness.getSession()!;
    expect(newSession).not.toBe(oldSession);
    expect(newSession.epoch).toBe(body.epoch);
    expect(harness.isSwapping()).toBe(false);

    // A file route resolves against the NEW root.
    const fileRes = await request(
      app,
      `http://localhost/api/file?path=questions/js-ts/beta-q/solution.ts&t=${TOKEN}`,
    );
    expect(fileRes.status).toBe(200);
    expect(((await fileRes.json()) as { content: string }).content).toBe('export const beta = 1;\n');

    // Question listing comes from the new db.
    const questionsRes = await request(app, `http://localhost/api/questions?t=${TOKEN}`);
    const questions = (await questionsRes.json()) as Array<{ slug: string }>;
    expect(questions.map((q) => q.slug)).toEqual(['beta-q']);

    // A later SSE connection's hello reports the new root and a different epoch.
    const helloAfter = await readHello(app);
    expect(helloAfter.workspaceRoot).toBe(rootB);
    expect(helloAfter.epoch).toBe(body.epoch);

    // Leak check: the old watcher closed and every old engine was disposed;
    // the new session's engines were not.
    expect(watcherClose).toHaveBeenCalledTimes(1);
    expect(disposed.sort()).toEqual(
      ['brainstorm', 'disputes', 'generation', 'reviews', 'runner'].map((k) => `${k}:${rootA}`),
    );

    // Broadcast fired once, after the swap, echoing the client requestId.
    expect(events).toEqual([
      { workspaceRoot: rootB, epoch: body.epoch, requestId: 'switch-req-1' },
    ]);

    // The mount was recorded to the recents registry.
    expect(readRegistryRoots()).toEqual([rootB]);

    await closeWorkspaceSession(newSession);
  });

  it('post-switch writes land under the NEW root: PUT /api/file writes the file, blob, and snapshot there', async () => {
    const bus = createBus();
    const engines = busyEngines(idleFlags());
    const oldSession = createWorkspaceSession({ workspaceRoot: rootA, bus, watch: false, engines });
    const harness = makeHarness(rootA, oldSession);
    const app = buildApp(bus, harness, engines);

    expect((await postSwitch(app, { root: rootB })).status).toBe(200);

    const rel = 'questions/js-ts/beta-q/solution.ts';
    const putRes = await request(app, `http://localhost/api/file?t=${TOKEN}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: rel, content: 'export const beta = 2;\n' }),
    });
    expect(putRes.status).toBe(200);

    expect(fs.readFileSync(path.join(rootB, rel), 'utf-8')).toBe('export const beta = 2;\n');
    // Snapshot bookkeeping went into the NEW session's db and blob store.
    const newSession = harness.getSession()!;
    const question = newSession.db.getQuestion('js-ts', 'beta-q')!;
    const snap = newSession.db.getLatestSnapshot(question.id, rel, 'save');
    expect(snap).not.toBeNull();
    expect(fs.existsSync(path.join(rootB, '.ace', 'blobs'))).toBe(true);
    // Nothing leaked into the old root.
    expect(fs.existsSync(path.join(rootA, 'questions', 'js-ts', 'beta-q'))).toBe(false);

    await closeWorkspaceSession(newSession);
  });

  it('rejects a post-switch save still anchored to the OLD root (the pagehide-flush race) and accepts current-root/unanchored ones', async () => {
    const bus = createBus();
    const engines = busyEngines(idleFlags());
    const oldSession = createWorkspaceSession({ workspaceRoot: rootA, bus, watch: false, engines });
    const harness = makeHarness(rootA, oldSession);
    const app = buildApp(bus, harness, engines);

    expect((await postSwitch(app, { root: rootB })).status).toBe(200);

    // The switch-triggered reload fires pagehide, whose keepalive flush
    // arrives only after the swap; its old-root anchor must reject it — here
    // aimed at a relPath that ALSO exists in the new workspace, the silent
    // cross-workspace overwrite case.
    const rel = 'questions/js-ts/beta-q/solution.ts';
    const putFile = (body: Record<string, unknown>) =>
      request(app, `http://localhost/api/file?t=${TOKEN}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const staleRes = await putFile({
      path: rel,
      content: 'export const alpha = 1; // stale, from rootA\n',
      expectedRoot: rootA,
    });
    expect(staleRes.status).toBe(409);
    expect(((await staleRes.json()) as { error: string }).error).toBe(
      `workspace changed: this save targeted ${rootA}`,
    );
    expect(fs.readFileSync(path.join(rootB, rel), 'utf-8')).toBe('export const beta = 1;\n');
    expect(fs.existsSync(path.join(rootA, rel))).toBe(false);

    // A save anchored to the CURRENT root applies, as does an unanchored one
    // (callers that predate the anchor, or a tab that never saw a hello).
    expect(
      (await putFile({ path: rel, content: 'export const beta = 2;\n', expectedRoot: rootB }))
        .status,
    ).toBe(200);
    expect(
      (await putFile({ path: rel, content: 'export const beta = 3;\n' })).status,
    ).toBe(200);
    expect(fs.readFileSync(path.join(rootB, rel), 'utf-8')).toBe('export const beta = 3;\n');

    await closeWorkspaceSession(harness.getSession()!);
  });

  it('mints a server requestId for the broadcast when the client sends none', async () => {
    const bus = createBus();
    const engines = busyEngines(idleFlags());
    const oldSession = createWorkspaceSession({ workspaceRoot: rootA, bus, watch: false, engines });
    const harness = makeHarness(rootA, oldSession);
    const app = buildApp(bus, harness, engines);
    const events = collectSwitched(bus);

    expect((await postSwitch(app, { root: rootB })).status).toBe(200);
    expect(events).toEqual([
      { workspaceRoot: rootB, epoch: expect.any(String), requestId: expect.any(String) },
    ]);

    await closeWorkspaceSession(harness.getSession()!);
  });

  it('same-root switch is a 200 no-op: same session object, same epoch, no teardown, no broadcast', async () => {
    const bus = createBus();
    const disposed: string[] = [];
    const engines = busyEngines(idleFlags(), disposed);
    const session = createWorkspaceSession({ workspaceRoot: rootA, bus, watch: false, engines });
    const harness = makeHarness(rootA, session);
    const app = buildApp(bus, harness, engines);
    const events = collectSwitched(bus);

    const res = await postSwitch(app, { root: rootA });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceRoot: string; epoch: string };
    expect(body.workspaceRoot).toBe(rootA);
    expect(body.epoch).toBe(session.epoch);
    expect(harness.getSession()).toBe(session);
    expect(disposed).toEqual([]);
    expect(events).toEqual([]);

    await closeWorkspaceSession(session);
  });
});

describe('POST /api/workspace/switch — guards', () => {
  async function buildMounted(flags: BusyFlags, disposed: string[] = []) {
    const bus = createBus();
    const engines = busyEngines(flags, disposed);
    const session = createWorkspaceSession({ workspaceRoot: rootA, bus, watch: false, engines });
    const harness = makeHarness(rootA, session);
    const app = buildApp(bus, harness, engines);
    return { app, harness, session, bus };
  }

  it('409s while the runner is busy — extracted guard, no teardown happened', async () => {
    const flags = idleFlags();
    const disposed: string[] = [];
    const { app, harness, session } = await buildMounted(flags, disposed);
    flags.runner = true;

    const res = await postSwitch(app, { root: rootB });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'a test run is in progress — wait for it to finish and try again',
    });
    expect(harness.getWorkspaceRoot()).toBe(rootA);
    expect(harness.getSession()).toBe(session);
    expect(disposed).toEqual([]);

    await closeWorkspaceSession(session);
  });

  it('409s while a generation is running — the shared guard covers the LLM engines too', async () => {
    const flags = idleFlags();
    const { app, harness, session } = await buildMounted(flags);
    flags.generation = true;

    const res = await postSwitch(app, { root: rootB });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'a generation is in progress — wait for it to finish and try again',
    });
    expect(harness.getSession()).toBe(session);

    await closeWorkspaceSession(session);
  });

  it('400s on a root that is not an initialized workspace, naming the resolved path', async () => {
    const { app, session } = await buildMounted(idleFlags());
    const missing = path.join(tempHome, 'not-a-workspace');
    const res = await postSwitch(app, { root: missing });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      `no questions/ directory found at ${missing} — run \`ace init\` there first`,
    );
    await closeWorkspaceSession(session);
  });

  it('400s on a missing/non-string root and on invalid JSON', async () => {
    const { app, session } = await buildMounted(idleFlags());

    expect((await postSwitch(app, {})).status).toBe(400);
    expect((await postSwitch(app, { root: 42 })).status).toBe(400);
    expect((await postSwitch(app, { root: '   ' })).status).toBe(400);

    const res = await request(app, `http://localhost/api/workspace/switch?t=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);

    await closeWorkspaceSession(session);
  });

  it('while the swapping flag is set: switch -> 409, mutating request -> 503 (the autosave race)', async () => {
    const { app, harness, session } = await buildMounted(idleFlags());
    harness.setSwapping(true);
    try {
      const switchRes = await postSwitch(app, { root: rootB });
      expect(switchRes.status).toBe(409);
      expect((await switchRes.json()) as { error: string }).toEqual({
        error: 'a workspace reset or switch is already in progress',
      });

      // A mid-swap autosave is rejected by the gate instead of racing the
      // teardown.
      const putRes = await request(app, `http://localhost/api/file?t=${TOKEN}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: 'questions/js-ts/alpha-q/solution.ts',
          content: 'export const alpha = 9;\n',
        }),
      });
      expect(putRes.status).toBe(503);

      const questionsRes = await request(app, `http://localhost/api/questions?t=${TOKEN}`);
      expect(questionsRes.status).toBe(503);
    } finally {
      harness.setSwapping(false);
    }
    await closeWorkspaceSession(session);
  });
});

describe('picker mode (booted unmounted)', () => {
  function buildUnmounted() {
    const bus = createBus();
    const engines = busyEngines(idleFlags());
    const harness = makeHarness(null, null);
    const app = buildApp(bus, harness, engines);
    return { app, harness, bus };
  }

  it('workspace-bound routes 409, health/recents/events serve, and a switch mounts the workspace', async () => {
    const { app, harness } = buildUnmounted();

    const questionsRes = await request(app, `http://localhost/api/questions?t=${TOKEN}`);
    expect(questionsRes.status).toBe(409);
    expect((await questionsRes.json()) as { error: string }).toEqual({
      error: 'no workspace mounted',
    });
    expect((await request(app, `http://localhost/api/workspace?t=${TOKEN}`)).status).toBe(409);
    expect(
      (
        await request(app, `http://localhost/api/workspace/reset?t=${TOKEN}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'progress', confirm: 'x' }),
        })
      ).status,
    ).toBe(409);

    expect((await request(app, `http://localhost/api/health?t=${TOKEN}`)).status).toBe(200);
    const recentsRes = await request(app, `http://localhost/api/workspace/recents?t=${TOKEN}`);
    expect(recentsRes.status).toBe(200);
    expect((await recentsRes.json()) as { recents: unknown[] }).toEqual({ recents: [] });

    // The hello still flows, carrying the unmounted nulls.
    expect(await readHello(app)).toEqual({
      version: '0.0.0-test',
      workspaceRoot: null,
      epoch: null,
    });

    // Mounting via switch brings the whole API up.
    const switchRes = await postSwitch(app, { root: rootB });
    expect(switchRes.status).toBe(200);
    expect(harness.getWorkspaceRoot()).toBe(rootB);
    const afterRes = await request(app, `http://localhost/api/questions?t=${TOKEN}`);
    expect(afterRes.status).toBe(200);
    expect(((await afterRes.json()) as Array<{ slug: string }>).map((q) => q.slug)).toEqual([
      'beta-q',
    ]);
    expect(readRegistryRoots()).toEqual([rootB]);

    await closeWorkspaceSession(harness.getSession()!);
  });
});

describe('POST /api/workspace/switch — failure recovery', () => {
  /** Wraps `base` so brainstorm-engine creation throws for the given roots. */
  function throwingEngines(base: EngineFactories, throwForRoots: Set<string>): EngineFactories {
    return {
      ...base,
      createBrainstormEngine: (opts) => {
        if (throwForRoots.has(opts.workspaceRoot)) {
          throw new Error('brainstorm engine exploded');
        }
        return base.createBrainstormEngine(opts);
      },
    };
  }

  it('remounts the old root when the new one fails to mount: 500 names the failure, old workspace serves, flag cleared, epoch unchanged', async () => {
    const bus = createBus();
    const disposed: string[] = [];
    const engines = throwingEngines(busyEngines(idleFlags(), disposed), new Set([rootB]));
    const oldSession = createWorkspaceSession({ workspaceRoot: rootA, bus, watch: false, engines });
    const oldEpoch = oldSession.epoch;
    const watcherClose = vi.fn(async () => {});
    oldSession.watcher = { close: watcherClose };
    const harness = makeHarness(rootA, oldSession);
    const app = buildApp(bus, harness, engines);
    const events = collectSwitched(bus);

    const res = await postSwitch(app, { root: rootB });
    expect(res.status).toBe(500);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(`workspace switch to ${rootB} failed`);
    expect(error).toContain('brainstorm engine exploded');
    expect(error).toContain(`the previous workspace at ${rootA} is still mounted`);

    // The old session was genuinely torn down before the failure...
    expect(watcherClose).toHaveBeenCalledTimes(1);
    // ...and a fresh one over the SAME db was remounted: same root, same
    // persisted epoch (this is NOT a reset), different session object.
    expect(harness.getWorkspaceRoot()).toBe(rootA);
    const recovered = harness.getSession()!;
    expect(recovered).not.toBe(oldSession);
    expect(recovered.epoch).toBe(oldEpoch);
    expect(harness.isSwapping()).toBe(false);
    expect(events).toEqual([]);

    const questionsRes = await request(app, `http://localhost/api/questions?t=${TOKEN}`);
    expect(questionsRes.status).toBe(200);
    expect(((await questionsRes.json()) as Array<{ slug: string }>).map((q) => q.slug)).toEqual([
      'alpha-q',
    ]);

    await closeWorkspaceSession(recovered);
  });

  it('falls back to unmounted (picker keeps serving) when the remount also fails', async () => {
    const bus = createBus();
    const engines = throwingEngines(busyEngines(idleFlags()), new Set([rootA, rootB]));
    // Build the initial session with non-throwing engines — only the
    // mid-switch rebuilds go through the throwing set.
    const oldSession = createWorkspaceSession({
      workspaceRoot: rootA,
      bus,
      watch: false,
      engines: busyEngines(idleFlags()),
    });
    const harness = makeHarness(rootA, oldSession);
    const app = buildApp(bus, harness, engines);

    const res = await postSwitch(app, { root: rootB });
    expect(res.status).toBe(500);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(`remounting ${rootA} also failed`);
    expect(error).toContain('no workspace is mounted');

    expect(harness.getWorkspaceRoot()).toBeNull();
    expect(harness.getSession()).toBeNull();
    expect(harness.isSwapping()).toBe(false);

    // The server keeps serving the picker surface.
    expect((await request(app, `http://localhost/api/questions?t=${TOKEN}`)).status).toBe(409);
    expect((await request(app, `http://localhost/api/workspace/recents?t=${TOKEN}`)).status).toBe(
      200,
    );
    expect((await readHello(app)).workspaceRoot).toBeNull();
  });
});
