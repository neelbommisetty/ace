// @vitest-environment node
//
// Route-level tests for POST /api/starter-pack (NEE-301) — the endpoint
// that lets an ALREADY-initialized workspace adopt the bundled starter
// questions, so a user whose library is empty is not stuck behind an API key
// and a paid generation. Same harness as the other app-*.test.ts files: a real
// Hono app over a real temp-dir db, fake engines, no LLM.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STARTER_PACK } from '../lib/starter-pack.js';
import { makeApp, makeWorkspace, setKeyless, type WorkspaceHandle } from './test-support.js';
import type { QuestionWithStats, StarterPackInstallResult } from './types.js';

let ws: WorkspaceHandle;

beforeEach(() => {
  ws = makeWorkspace('app-starter-pack');
});

afterEach(() => {
  ws.cleanup();
});

function buildApp() {
  // Same bus as the session's, so the broadcast test can observe what the
  // route emits.
  return makeApp({ bus: ws.bus, getWorkspaceRoot: () => ws.root, getSession: () => ws.session })
    .fetch;
}

const ALL_IDS = STARTER_PACK.map((q) => `${q.category}/${q.slug}`);

describe('POST /api/starter-pack', () => {
  it('copies the pack onto disk and into the db with no provider configured', async () => {
    // The whole point: this path must work keyless. setKeyless() strips the
    // dev machine's real ~/.ace and *_API_KEY out of the picture.
    setKeyless();
    const fetch = buildApp();

    const res = await fetch('/api/starter-pack', { method: 'POST' });

    expect(res.status).toBe(200);
    const result = (await res.json()) as StarterPackInstallResult;
    expect(result.installed).toEqual(ALL_IDS);
    expect(result.skipped).toEqual([]);
    expect(result.unavailable).toEqual([]);

    for (const question of STARTER_PACK) {
      const dir = path.join(ws.root, 'questions', question.category, question.slug);
      expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
    }

    // Reconciled inline, so the library is populated by the time the caller
    // refetches — no waiting on the watcher debounce.
    const questions = (await (await fetch('/api/questions')).json()) as QuestionWithStats[];
    expect(questions).toHaveLength(STARTER_PACK.length);
    for (const question of STARTER_PACK) {
      const row = questions.find((q) => q.category === question.category && q.slug === question.slug);
      expect(row?.title).toBe(question.title);
    }
  });

  it('broadcasts questions-changed so other tabs refresh', async () => {
    const fetch = buildApp();
    const seen: string[] = [];
    const unsubscribe = ws.bus.subscribe((name) => {
      seen.push(name);
    });

    try {
      await fetch('/api/starter-pack', { method: 'POST' });
    } finally {
      unsubscribe();
    }

    expect(seen).toContain('questions-changed');
  });

  it('is idempotent: a second POST installs nothing and leaves edits alone', async () => {
    const fetch = buildApp();
    await fetch('/api/starter-pack', { method: 'POST' });

    const first = STARTER_PACK[0];
    const readme = path.join(ws.root, 'questions', first.category, first.slug, 'README.md');
    fs.writeFileSync(readme, '# Edited locally\n', 'utf8');

    const result = (await (
      await fetch('/api/starter-pack', { method: 'POST' })
    ).json()) as StarterPackInstallResult;

    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual(ALL_IDS);
    expect(fs.readFileSync(readme, 'utf8')).toBe('# Edited locally\n');

    // And no duplicate rows.
    const questions = (await (await fetch('/api/questions')).json()) as QuestionWithStats[];
    expect(questions).toHaveLength(STARTER_PACK.length);
  });

  it('backfills only what is missing after a question is deleted', async () => {
    const fetch = buildApp();
    await fetch('/api/starter-pack', { method: 'POST' });
    const dropped = STARTER_PACK[2];
    fs.rmSync(path.join(ws.root, 'questions', dropped.category, dropped.slug), {
      recursive: true,
      force: true,
    });

    const result = (await (
      await fetch('/api/starter-pack', { method: 'POST' })
    ).json()) as StarterPackInstallResult;

    expect(result.installed).toEqual([`${dropped.category}/${dropped.slug}`]);
    expect(result.skipped).toHaveLength(STARTER_PACK.length - 1);
  });

  it('401s without the token and 409s with no workspace mounted', async () => {
    const noToken = await makeApp({
      getWorkspaceRoot: () => ws.root,
      getSession: () => ws.session,
    }).app.request('http://localhost/api/starter-pack', {
      method: 'POST',
      headers: { host: 'localhost' },
    });
    expect(noToken.status).toBe(401);

    const unmounted = makeApp({ getWorkspaceRoot: () => null, getSession: () => null }).fetch;
    expect((await unmounted('/api/starter-pack', { method: 'POST' })).status).toBe(409);
  });
});
