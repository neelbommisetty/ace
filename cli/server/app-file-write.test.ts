// @vitest-environment node
//
// Route-level tests for PUT /api/file's optimistic-concurrency precondition
// (NEE-359). Two tabs used to silently overwrite each other: echo suppression
// for file writes was process-global, so tab B never saw tab A's save and its
// next keystroke PUT B's whole stale buffer over A's work — and the route
// validated `expectedRoot` but ignored what version the client thought it was
// writing on top of. `savedHash` is that missing precondition.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha1 } from './files.js';
import { makeApp, makeWorkspace, type WorkspaceHandle } from './test-support.js';

let ws: WorkspaceHandle;

const REL = 'questions/js-ts/debounce/solution.ts';

function abs(): string {
  return path.join(ws.root, REL);
}

function seed(content: string): string {
  fs.mkdirSync(path.dirname(abs()), { recursive: true });
  fs.writeFileSync(abs(), content, 'utf8');
  return sha1(content);
}

function buildApp() {
  return makeApp({ getWorkspaceRoot: () => ws.root, getSession: () => ws.session }).fetch;
}

function put(
  fetch: ReturnType<typeof buildApp>,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch('/api/file', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  ws = makeWorkspace('app-file-write');
});

afterEach(() => {
  ws.cleanup();
});

describe('PUT /api/file savedHash precondition (NEE-359)', () => {
  it('writes when savedHash matches the current disk hash', async () => {
    const hash = seed('const a = 1;\n');
    const fetch = buildApp();

    const res = await put(fetch, { path: REL, content: 'const a = 2;\n', savedHash: hash });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hash: sha1('const a = 2;\n') });
    expect(fs.readFileSync(abs(), 'utf8')).toBe('const a = 2;\n');
  });

  it('409s with code "stale-write" when disk moved on, leaving the newer content intact', async () => {
    const staleHash = seed('const a = 1;\n');
    const fetch = buildApp();

    // tab A saves
    expect((await put(fetch, { path: REL, content: 'A wrote this\n', savedHash: staleHash })).status).toBe(200);

    // tab B still believes the original hash and PUTs its own stale buffer
    const res = await put(fetch, { path: REL, content: 'B stale buffer\n', savedHash: staleHash });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'file changed on disk since you last loaded it',
      code: 'stale-write',
      hash: sha1('A wrote this\n'),
    });
    // A's work survived
    expect(fs.readFileSync(abs(), 'utf8')).toBe('A wrote this\n');
  });

  it('the 409 carries a code distinct from the workspace-anchor 409, so the client can tell them apart', async () => {
    const hash = seed('const a = 1;\n');
    const fetch = buildApp();

    const anchorRes = await put(fetch, {
      path: REL,
      content: 'x\n',
      savedHash: hash,
      expectedRoot: '/some/other/workspace',
    });

    expect(anchorRes.status).toBe(409);
    expect((await anchorRes.json()) as { code: string }).toMatchObject({
      code: 'workspace-changed',
    });
  });

  it('omitting savedHash keeps last-write-wins (unversioned callers are unaffected)', async () => {
    seed('const a = 1;\n');
    const fetch = buildApp();

    const res = await put(fetch, { path: REL, content: 'forced\n' });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(abs(), 'utf8')).toBe('forced\n');
  });

  it('recreates a file that vanished from disk rather than 409ing (no writer to lose)', async () => {
    const hash = seed('const a = 1;\n');
    fs.rmSync(abs());
    const fetch = buildApp();

    const res = await put(fetch, { path: REL, content: 'const a = 3;\n', savedHash: hash });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(abs(), 'utf8')).toBe('const a = 3;\n');
  });

  it('rejects a non-string savedHash by ignoring it rather than throwing', async () => {
    seed('const a = 1;\n');
    const fetch = buildApp();

    const res = await put(fetch, { path: REL, content: 'y\n', savedHash: 42 });

    expect(res.status).toBe(200);
  });
});
