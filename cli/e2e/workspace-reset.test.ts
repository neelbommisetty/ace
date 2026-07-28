// @vitest-environment node
//
// In-process integration coverage for "clear workspace" (NEE-165) over a REAL
// booted server — startAceServer(), driven entirely through fetch (including
// the raw SSE stream), against a workspace produced by the real `ace init`
// command plus an in-process scaffold (see seedWorkspace below).
// No LLM calls: ACE_E2E_MOCK_LLM=1 throughout
// (set before the server module graph is evaluated, since llm.ts computes its
// mock flag at import time — see the dynamic import below).
//
// Node's real fetch is required (not happy-dom's polyfill, the project
// default): happy-dom enforces browser same-origin/CORS semantics against a
// real cross-port loopback server, and its Headers implementation drops the
// `Host` header the app's DNS-rebinding guard needs (see the identical note
// in cli/server/reset-endpoint.test.ts).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempWorkspace, linkNodeModules, runAce } from './e2e-utils.js';

process.env.ACE_E2E_MOCK_LLM = '1';

// Imported dynamically (after the env var above is set) so llm.ts — pulled in
// transitively via server/index.js -> session.js -> reviews.js/disputes.js —
// evaluates its module-level mock-provider flag correctly. See the identical
// pattern in cli/server/workspace-reset.test.ts.
const { startAceServer } = await import('../server/index.js');
const { openDb } = await import('../server/db.js');
const { readBlob } = await import('../server/blobs.js');
const { getStubContent, scaffoldQuestionAt } = await import('../lib/scaffold.js');
type AceServer = Awaited<ReturnType<typeof startAceServer>>;

function isAddrInUse(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
  );
}

/** Boots a real ace server bound to workspaceRoot, scanning past busy ports. */
async function bootServer(
  workspaceRoot: string,
): Promise<{ server: AceServer; token: string; baseUrl: string }> {
  const token = crypto.randomUUID();
  const basePort = 4300 + Math.floor(Math.random() * 5000);
  let lastErr: unknown;
  for (let port = basePort; port < basePort + 40; port++) {
    try {
      const server = await startAceServer({ workspaceRoot, port, token, uiDir: null });
      return { server, token, baseUrl: server.url };
    } catch (err) {
      if (isAddrInUse(err)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('failed to bind a free test port');
}

function apiUrl(baseUrl: string, token: string, p: string): string {
  return `${baseUrl}${p}${p.includes('?') ? '&' : '?'}t=${token}`;
}

async function apiJson<T = unknown>(
  baseUrl: string,
  token: string,
  p: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const res = await fetch(apiUrl(baseUrl, token, p), init);
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

/** Minimal SSE client over a raw fetch() reader — decodes `event:`/`data:`
 * frames and lets tests await a named event with a clear timeout error. */
interface SseClient {
  events: Array<{ event: string; data: unknown }>;
  waitFor(eventName: string, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

async function connectSse(baseUrl: string, token: string): Promise<SseClient> {
  const controller = new AbortController();
  const res = await fetch(apiUrl(baseUrl, token, '/api/events'), { signal: controller.signal });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: unknown }> = [];
  const waiters: Array<{
    eventName: string;
    resolve: (data: unknown) => void;
  }> = [];
  let buffer = '';

  function dispatch(eventName: string, data: unknown): void {
    events.push({ event: eventName, data });
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].eventName === eventName) {
        const [w] = waiters.splice(i, 1);
        w.resolve(data);
      }
    }
  }

  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let eventName = 'message';
          let dataStr = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) eventName = line.slice(7);
            else if (line.startsWith('data: ')) dataStr += line.slice(6);
          }
          if (!dataStr) continue; // heartbeat comment lines etc.
          let data: unknown;
          try {
            data = JSON.parse(dataStr);
          } catch {
            data = dataStr;
          }
          dispatch(eventName, data);
        }
      }
    } catch {
      // aborted on close() — expected
    }
  })();

  return {
    events,
    waitFor(eventName, timeoutMs = 15000) {
      const existing = events.find((e) => e.event === eventName);
      if (existing) return Promise.resolve(existing.data);
      return new Promise((resolve, reject) => {
        const entry = {
          eventName,
          resolve: (data: unknown) => {
            clearTimeout(timer);
            resolve(data);
          },
        };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(entry);
          if (i !== -1) waiters.splice(i, 1);
          reject(
            new Error(
              `timed out after ${timeoutMs}ms waiting for SSE event "${eventName}" (saw: ${events.map((e) => e.event).join(', ') || 'none'})`,
            ),
          );
        }, timeoutMs);
        waiters.push(entry);
      });
    },
    close() {
      controller.abort();
    },
  };
}

/**
 * `ace init` + a scaffolded js-ts/two-sum question, into a fresh temp
 * workspace ready for a real server boot.
 *
 * The question is scaffolded in-process rather than shelled out to a CLI
 * command: generation is no longer a CLI surface, and this test only needs a
 * question dir on disk to reset — not the generation pipeline. The values
 * mirror what the old `ACE_MOCK_LLM_MODE=generate` payload produced, so the
 * scaffolded files are byte-identical to what this suite ran against before.
 */
function seedWorkspace(): { root: string; home: string; cleanup: () => void } {
  const { root, home, cleanup } = createTempWorkspace();
  const initResult = runAce(['init', '--skip-install'], { cwd: root, env: { HOME: home } });
  expect(initResult.status).toBe(0);
  scaffoldQuestionAt(root, {
    title: 'Two Sum',
    slug: 'two-sum',
    category: 'js-ts',
    difficulty: 'easy',
    description: 'Return indices of the two numbers such that they add up to target.',
    signature: 'export function twoSum(nums: number[], target: number): number[]',
  });
  return { root, home, cleanup };
}

const QUESTION_DIR = ['questions', 'js-ts', 'two-sum'];
const SOLUTION_REL = [...QUESTION_DIR, 'solution.ts'].join('/');

function solutionAbsPath(root: string): string {
  return path.join(root, ...QUESTION_DIR, 'solution.ts');
}

/** Opens an archived `.ace-archive-*` db read-only by copying it under a
 * throwaway root — openDb requires its child literally named `.ace`. */
function openArchivedDbReadOnly(archivedTo: string) {
  const throwawayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-reset-archive-check-'));
  fs.cpSync(archivedTo, path.join(throwawayRoot, '.ace'), { recursive: true });
  const db = openDb(throwawayRoot);
  return {
    db,
    /** readBlob needs the throwaway ROOT (whose child is `.ace/blobs/...`), not archivedTo itself. */
    root: throwawayRoot,
    cleanup() {
      db.close();
      fs.rmSync(throwawayRoot, { recursive: true, force: true });
    },
  };
}

describe('workspace reset — progress mode over a live server', () => {
  let root: string;
  let cleanupWorkspace: () => void;
  let server: AceServer;
  let token: string;
  let baseUrl: string;

  beforeAll(async () => {
    const seeded = seedWorkspace();
    root = seeded.root;
    cleanupWorkspace = seeded.cleanup;
    const booted = await bootServer(root);
    server = booted.server;
    token = booted.token;
    baseUrl = booted.baseUrl;
  });

  afterAll(async () => {
    await server.close();
    cleanupWorkspace();
  });

  it(
    'archives the old workspace, wipes progress, keeps files, broadcasts over SSE, and the re-init watcher still fires',
    async () => {
      // Connect BEFORE the reset so we can observe both its `hello` epoch and
      // the eventual `workspace-reset` broadcast on the same connection.
      const sse = await connectSse(baseUrl, token);
      const helloBefore = (await sse.waitFor('hello')) as { epoch: string };
      expect(helloBefore.epoch).toBeTruthy();

      // Create an attempt and edit the solution file — this is the "progress"
      // a progress-mode reset must wipe (attempts) while leaving the file
      // untouched on disk.
      const attemptRes = await apiJson<{ attempt: { id: string } }>(
        baseUrl,
        token,
        '/api/questions/js-ts/two-sum/attempts',
        { method: 'POST' },
      );
      expect(attemptRes.status).toBe(200);

      const editedContent = 'export function twoSum() {\n  return "edited-before-reset";\n}\n';
      const putRes = await apiJson<{ hash: string }>(baseUrl, token, '/api/file', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: SOLUTION_REL, content: editedContent }),
      });
      expect(putRes.status).toBe(200);

      const workspaceRoot = path.basename(root);
      const resetRes = await apiJson<{
        mode: string;
        archivedTo: string;
        restored: { questions: number; files: number };
        workspace: { counts: { questions: number; attempts: number } };
      }>(baseUrl, token, '/api/workspace/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'progress', confirm: workspaceRoot }),
      });
      expect(resetRes.status).toBe(200);
      const { archivedTo } = resetRes.body;

      // The old .ace was archived with its db and blobs intact.
      expect(fs.existsSync(path.join(archivedTo, 'ace.db'))).toBe(true);
      expect(fs.existsSync(path.join(archivedTo, 'blobs'))).toBe(true);
      expect(fs.existsSync(path.join(root, '.ace', 'ace.db'))).toBe(true);

      // Progress mode: file content on disk is untouched byte-for-byte.
      expect(fs.readFileSync(solutionAbsPath(root), 'utf-8')).toBe(editedContent);
      expect(resetRes.body.restored).toEqual({ questions: 0, files: 0 });

      // Fresh db: same question count, zeroed attempts.
      expect(resetRes.body.workspace.counts.questions).toBe(1);
      expect(resetRes.body.workspace.counts.attempts).toBe(0);

      // Confirm via a fresh GET too, not just the POST response's echo.
      const workspaceGet = await apiJson<{ counts: { questions: number; attempts: number } }>(
        baseUrl,
        token,
        '/api/workspace',
      );
      expect(workspaceGet.status).toBe(200);
      expect(workspaceGet.body.counts).toEqual({ questions: 1, attempts: 0, testRuns: 0 });

      // The already-connected SSE client received exactly the broadcast for
      // this reset.
      const broadcast = await sse.waitFor('workspace-reset', 20000);
      expect(broadcast).toMatchObject({ mode: 'progress', archivedTo });

      // Watcher re-init proof: touch a question file directly on disk (NOT
      // through the API) and expect the NEW session's chokidar watcher to
      // notice and emit `file-changed` over the same long-lived bus/SSE
      // connection. awaitWriteFinish adds ~200ms stability delay on top of
      // the fs event itself, but native fsevents (macOS) can occasionally
      // coalesce or delay delivery right after a watcher is torn down and a
      // fresh one registered on the same directory — observed in practice
      // under system load. Nudge with a few spaced-out writes rather than
      // trusting a single write to always be observed promptly; each
      // still-outstanding wait re-checks already-arrived events first, so a
      // late-arriving event from an earlier write is still picked up.
      let fileChanged: unknown;
      for (let attempt = 0; attempt < 4 && fileChanged === undefined; attempt++) {
        fs.writeFileSync(
          solutionAbsPath(root),
          `export function twoSum() { return "external-edit-${attempt}"; }\n`,
        );
        try {
          fileChanged = await sse.waitFor('file-changed', 5000);
        } catch {
          // try again with a fresh write
        }
      }
      if (fileChanged === undefined) {
        throw new Error('file-changed SSE event never arrived after 4 write attempts');
      }
      expect(fileChanged).toMatchObject({ relPath: SOLUTION_REL });

      // A brand new SSE connection opened after the reset sees a `hello`
      // whose epoch differs from the pre-reset connection's — pins the
      // reconnect-detection contract end to end for tabs that missed the
      // one-shot `workspace-reset` broadcast.
      const sse2 = await connectSse(baseUrl, token);
      const helloAfter = (await sse2.waitFor('hello')) as { epoch: string };
      expect(helloAfter.epoch).not.toBe(helloBefore.epoch);

      sse.close();
      sse2.close();
    },
    // Generous per-test override (the global testTimeout is 10s): the
    // watcher-nudge loop above can itself take up to ~20s in the worst case
    // observed under load, on top of a full reset cycle.
    45_000,
  );
});

describe('workspace reset — full mode over a live server', () => {
  let root: string;
  let cleanupWorkspace: () => void;
  let server: AceServer;
  let token: string;
  let baseUrl: string;

  beforeAll(async () => {
    const seeded = seedWorkspace();
    root = seeded.root;
    cleanupWorkspace = seeded.cleanup;
    const booted = await bootServer(root);
    server = booted.server;
    token = booted.token;
    baseUrl = booted.baseUrl;
  });

  afterAll(async () => {
    await server.close();
    cleanupWorkspace();
  });

  it('restores the solution file to its captured scaffold baseline and snapshots the solved code into the archive', async () => {
    // Opening the Room once (first-ever attempt) captures the scaffold
    // baseline from the CURRENT on-disk content.
    const baselineContent = fs.readFileSync(solutionAbsPath(root), 'utf-8');
    const attemptRes = await apiJson<{ attempt: { id: string; number: number } }>(
      baseUrl,
      token,
      '/api/questions/js-ts/two-sum/attempts',
      { method: 'POST' },
    );
    expect(attemptRes.status).toBe(200);
    expect(attemptRes.body.attempt.number).toBe(1);

    const solvedContent = 'export function twoSum() {\n  return "solved-before-full-reset";\n}\n';
    const putRes = await apiJson<{ hash: string }>(baseUrl, token, '/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: SOLUTION_REL, content: solvedContent }),
    });
    expect(putRes.status).toBe(200);

    const workspaceRoot = path.basename(root);
    const resetRes = await apiJson<{
      mode: string;
      archivedTo: string;
      restored: { questions: number; files: number };
    }>(baseUrl, token, '/api/workspace/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'full', confirm: workspaceRoot }),
    });
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.mode).toBe('full');
    expect(resetRes.body.restored).toEqual({ questions: 1, files: 1 });

    // Solution file on disk is restored to exactly the pre-edit baseline.
    expect(fs.readFileSync(solutionAbsPath(root), 'utf-8')).toBe(baselineContent);

    // The archived (old) db holds a 'reset' snapshot of the pre-reset
    // (solved) code — the user's final code travels into the archive.
    const { archivedTo } = resetRes.body;
    const archived = openArchivedDbReadOnly(archivedTo);
    try {
      const question = archived.db.getQuestion('js-ts', 'two-sum');
      expect(question).not.toBeNull();
      const resetSnap = archived.db.getLatestSnapshot(question!.id, SOLUTION_REL, 'reset');
      expect(resetSnap).not.toBeNull();
      expect(readBlob(archived.root, resetSnap!.hash)).toBe(solvedContent);
    } finally {
      archived.cleanup();
    }

    // A new attempt on the (freshly reconciled) question starts back at 1.
    const freshAttemptRes = await apiJson<{ attempt: { number: number } }>(
      baseUrl,
      token,
      '/api/questions/js-ts/two-sum/attempts',
      { method: 'POST' },
    );
    expect(freshAttemptRes.status).toBe(200);
    expect(freshAttemptRes.body.attempt.number).toBe(1);
  });
});

describe('workspace reset — full mode with no prior scaffold snapshot', () => {
  it('falls back to the rendered template stub', async () => {
    // Its own fresh workspace/server: no attempt is ever opened before the
    // reset, so the restore plan has no 'scaffold' snapshot to read and must
    // fall back to getStubContent — proven end to end over a live server.
    const { root, cleanup } = seedWorkspace();
    try {
      const { server, token, baseUrl } = await bootServer(root);
      try {
        const resetRes = await apiJson<{ mode: string }>(baseUrl, token, '/api/workspace/reset', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'full', confirm: path.basename(root) }),
        });
        expect(resetRes.status).toBe(200);
        expect(fs.readFileSync(solutionAbsPath(root), 'utf-8')).toBe(
          getStubContent('js-ts', 'solution.ts'),
        );
      } finally {
        await server.close();
      }
    } finally {
      cleanup();
    }
  });
});

describe('workspace reset — 409 guard against a real running test', () => {
  let root: string;
  let cleanupWorkspace: () => void;
  let server: AceServer;
  let token: string;
  let baseUrl: string;

  beforeAll(async () => {
    const seeded = seedWorkspace();
    root = seeded.root;
    cleanupWorkspace = seeded.cleanup;
    linkNodeModules(root); // needed: the runner spawns the real node_modules/.bin/vitest
    fs.writeFileSync(
      path.join(root, ...QUESTION_DIR, 'solution.test.ts'),
      [
        "import { describe, it, expect } from 'vitest';",
        '',
        "describe('two sum', () => {",
        "  it('is deliberately slow', async () => {",
        '    await new Promise((resolve) => setTimeout(resolve, 3000));',
        '    expect(true).toBe(true);',
        '  });',
        '});',
        '',
      ].join('\n'),
      'utf-8',
    );
    const booted = await bootServer(root);
    server = booted.server;
    token = booted.token;
    baseUrl = booted.baseUrl;
  });

  afterAll(async () => {
    await server.close();
    cleanupWorkspace();
  });

  it(
    'rejects a reset while a real vitest run is in flight, then succeeds once it finishes',
    async () => {
      const attemptRes = await apiJson<{ attempt: { id: string } }>(
        baseUrl,
        token,
        '/api/questions/js-ts/two-sum/attempts',
        { method: 'POST' },
      );
      expect(attemptRes.status).toBe(200);
      const attemptId = attemptRes.body.attempt.id;

      const sse = await connectSse(baseUrl, token);
      await sse.waitFor('hello');

      const startRes = await apiJson<{ runId: string }>(
        baseUrl,
        token,
        `/api/attempts/${attemptId}/test-runs`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trigger: 'manual' }),
        },
      );
      expect(startRes.status).toBe(200);

      // Runner.start() synchronously registers the in-flight entry before the
      // HTTP handler returns, so isBusy() is already true here — no polling
      // needed to observe the race.
      const workspaceRoot = path.basename(root);
      const bodyBusy = { mode: 'progress', confirm: workspaceRoot };
      const busyRes = await apiJson<{ error: string }>(baseUrl, token, '/api/workspace/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bodyBusy),
      });
      expect(busyRes.status).toBe(409);
      expect(busyRes.body).toEqual({
        error: 'a test run is in progress — wait for it to finish and try again',
      });
      // .ace was left untouched by the rejected reset.
      expect(fs.existsSync(path.join(root, '.ace', 'ace.db'))).toBe(true);

      // Wait for the real vitest run to actually finish, and assert it
      // genuinely ran (not merely that the runner reported *some* outcome —
      // an instantly-failing spawn also emits a matching run-done). This is
      // the guard against a regression of the realpath fix in 8457ca2: without
      // it the spawned vitest process fails before executing any test, and
      // status/summary catch that even though runId still matches.
      const runDone = (await sse.waitFor('run-done', 25_000)) as {
        runId: string;
        status: string;
        summary: { total: number; passed: number; failed: number } | null;
      };
      expect(runDone.runId).toBe(startRes.body.runId);
      expect(runDone.status).toBe('done');
      expect(runDone.summary).toEqual(
        expect.objectContaining({ total: 1, passed: 1, failed: 0 }),
      );
      sse.close();

      const okRes = await apiJson<{ mode: string }>(baseUrl, token, '/api/workspace/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'progress', confirm: workspaceRoot }),
      });
      expect(okRes.status).toBe(200);
    },
    30_000,
  );
});

describe('workspace reset — server shutdown after a reset', () => {
  it('server.close() resolves promptly after a reset, leaving no dangling watcher/db handles', async () => {
    const { root, cleanup } = seedWorkspace();
    try {
      const { server, token, baseUrl } = await bootServer(root);

      const resetRes = await apiJson<{ mode: string }>(baseUrl, token, '/api/workspace/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'progress', confirm: path.basename(root) }),
      });
      expect(resetRes.status).toBe(200);

      // Race close() against a generous timeout: a leaked watcher/db handle
      // from the PRE-reset session (torn down mid-reset, not at close())
      // would otherwise hang this indefinitely and eventually fail the whole
      // suite via vitest's own timeout with a much less specific error.
      const raceResult = await Promise.race([
        server.close().then(() => 'closed' as const),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 8000)),
      ]);
      expect(raceResult).toBe('closed');

      // The port is actually free — not just that close() resolved.
      await expect(fetch(`${baseUrl}/api/health`)).rejects.toThrow();
    } finally {
      cleanup();
    }
  }, 15_000);
});
