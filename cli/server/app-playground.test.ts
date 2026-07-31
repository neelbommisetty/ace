// @vitest-environment node
//
// Route-level tests for POST /api/playground (NEE-387) — the zero-LLM
// "scratch pad" scaffold. Same harness as the other app-*.test.ts files: a
// real Hono app over a real temp-dir db, fake engines, no LLM. Modeled on
// app-starter-pack.test.ts.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, makeWorkspace, setKeyless, type WorkspaceHandle } from './test-support.js';
import type { PlaygroundCreateResult, QuestionWithStats } from './types.js';

let ws: WorkspaceHandle;

beforeEach(() => {
  ws = makeWorkspace('app-playground');
});

afterEach(() => {
  ws.cleanup();
});

function buildApp() {
  return makeApp({ bus: ws.bus, getWorkspaceRoot: () => ws.root, getSession: () => ws.session }).fetch;
}

describe('POST /api/playground', () => {
  it('scaffolds a react scratch pad keyless, with no scorecard and no test file', async () => {
    // The whole point: zero LLM calls, so this must work keyless.
    setKeyless();
    const fetch = buildApp();

    const res = await fetch('/api/playground', {
      method: 'POST',
      body: JSON.stringify({ kind: 'react' }),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as PlaygroundCreateResult;
    expect(result).toEqual({ category: 'playground', slug: 'scratch-1' });

    const dir = path.join(ws.root, 'questions', 'playground', 'scratch-1');
    expect(fs.existsSync(path.join(dir, 'App.tsx'))).toBe(true);
    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    expect(readme).toMatch(/^\*\*Difficulty:\*\* easy$/m);
    expect(readme).toMatch(/^\*\*Suggested Time:\*\* ~30 minutes$/m);

    expect(fs.existsSync(path.join(dir, 'scorecard.json'))).toBe(false);
    expect(fs.readdirSync(dir).some((f) => f.includes('.test.'))).toBe(false);

    // Reconciled inline, so the row is there by the time the caller refetches.
    const questions = (await (await fetch('/api/questions')).json()) as QuestionWithStats[];
    const row = questions.find((q) => q.category === 'playground' && q.slug === 'scratch-1');
    expect(row).toBeDefined();
    expect(row?.difficulty).toBe('easy');
    expect(row?.suggestedMinutes).toBe(30);
    expect(row?.source).toBe('manual');
    expect(row?.stats.status).toBe('not-attempted');
  });

  it('numbers a second react scratch pad scratch-2', async () => {
    const fetch = buildApp();
    await fetch('/api/playground', { method: 'POST', body: JSON.stringify({ kind: 'react' }) });
    const second = (await (
      await fetch('/api/playground', { method: 'POST', body: JSON.stringify({ kind: 'react' }) })
    ).json()) as PlaygroundCreateResult;
    expect(second).toEqual({ category: 'playground', slug: 'scratch-2' });
  });

  it('scaffolds a ts scratch pad under playground-ts with index.ts', async () => {
    const fetch = buildApp();
    const result = (await (
      await fetch('/api/playground', { method: 'POST', body: JSON.stringify({ kind: 'ts' }) })
    ).json()) as PlaygroundCreateResult;
    expect(result).toEqual({ category: 'playground-ts', slug: 'scratch-1' });
    const dir = path.join(ws.root, 'questions', 'playground-ts', 'scratch-1');
    expect(fs.existsSync(path.join(dir, 'index.ts'))).toBe(true);
  });

  it('the two playground kinds number independently', async () => {
    const fetch = buildApp();
    await fetch('/api/playground', { method: 'POST', body: JSON.stringify({ kind: 'react' }) });
    const ts = (await (
      await fetch('/api/playground', { method: 'POST', body: JSON.stringify({ kind: 'ts' }) })
    ).json()) as PlaygroundCreateResult;
    expect(ts).toEqual({ category: 'playground-ts', slug: 'scratch-1' });
  });

  it('400s on an invalid or missing kind', async () => {
    const fetch = buildApp();
    const invalid = await fetch('/api/playground', {
      method: 'POST',
      body: JSON.stringify({ kind: 'not-a-kind' }),
    });
    expect(invalid.status).toBe(400);

    const missing = await fetch('/api/playground', { method: 'POST', body: JSON.stringify({}) });
    expect(missing.status).toBe(400);
  });

  it('broadcasts questions-changed', async () => {
    const fetch = buildApp();
    const seen: string[] = [];
    const unsubscribe = ws.bus.subscribe((name) => {
      seen.push(name);
    });

    try {
      await fetch('/api/playground', { method: 'POST', body: JSON.stringify({ kind: 'react' }) });
    } finally {
      unsubscribe();
    }

    expect(seen).toContain('questions-changed');
  });

  it('a later reconcile leaves the row intact and reports no skippedDirs', async () => {
    const fetch = buildApp();
    await fetch('/api/playground', { method: 'POST', body: JSON.stringify({ kind: 'react' }) });

    ws.session.reconcile();
    expect(ws.session.skippedDirs).toEqual([]);

    const questions = (await (await fetch('/api/questions')).json()) as QuestionWithStats[];
    expect(questions.filter((q) => q.category === 'playground')).toHaveLength(1);
  });

  it('401s without the token and 409s with no workspace mounted', async () => {
    const noToken = await makeApp({
      getWorkspaceRoot: () => ws.root,
      getSession: () => ws.session,
    }).app.request('http://localhost/api/playground', {
      method: 'POST',
      headers: { host: 'localhost' },
      body: JSON.stringify({ kind: 'react' }),
    });
    expect(noToken.status).toBe(401);

    const unmounted = makeApp({ getWorkspaceRoot: () => null, getSession: () => null }).fetch;
    expect(
      (
        await unmounted('/api/playground', { method: 'POST', body: JSON.stringify({ kind: 'react' }) })
      ).status,
    ).toBe(409);
  });
});
