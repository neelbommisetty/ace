// @vitest-environment node
//
// Route-level tests for follow-up probes (POST/GET
// /api/questions/:category/:slug/probes, NEE-345). Mirrors
// app-generation.test.ts's pattern: a real Hono app + real Request/Response
// over a real (temp-dir) db, with a FAKE probe engine injected via
// EngineFactories so no LLM call ever runs — only the route's own
// guard/bound/gating logic is under test.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scaffoldQuestionAt } from '../lib/scaffold.js';
import {
  fakeEngines,
  makeApp,
  makeWorkspace,
  setKeyless,
  setProviderConfigured,
  type WorkspaceHandle,
} from './test-support.js';
import type { ProbeSetRow, QuestionRow } from './types.js';

let ws: WorkspaceHandle;

function buildSession(isRunning: (questionId: string) => boolean = () => false): void {
  ws = makeWorkspace('app-probes', {
    engines: fakeEngines({
      probes: { isRunning: vi.fn(isRunning) },
    }),
  });
}

/** A behavioral question, scaffolded on disk and upserted into the db. */
function scaffoldStory(slug: string, opts: { story?: string } = {}): QuestionRow {
  const { dir } = scaffoldQuestionAt(ws.root, {
    title: 'A Conflict You Navigated',
    slug,
    category: 'behavioral',
    difficulty: 'medium',
    description: 'Tell me about a time you disagreed with a decision.',
  });
  if (opts.story !== undefined) {
    fs.writeFileSync(path.join(dir, 'story.md'), opts.story, 'utf8');
  }
  return ws.session.db.upsertQuestion({
    category: 'behavioral',
    slug,
    title: 'A Conflict You Navigated',
    difficulty: 'medium',
    suggestedMinutes: 20,
    dirPath: dir,
    source: 'manual',
  });
}

const REAL_STORY =
  '## Situation\nA teammate and I disagreed about the caching strategy.\n\n## Action\nI proposed a spike to compare both approaches.\n';

beforeEach(() => {
  setKeyless();
  buildSession();
});

afterEach(() => {
  ws.cleanup();
});

function buildApp() {
  return makeApp({ getWorkspaceRoot: () => ws.root, getSession: () => ws.session }).fetch;
}

describe('POST /api/questions/:category/:slug/probes', () => {
  it('202s with a probeJobId on the happy path', async () => {
    setProviderConfigured();
    const question = scaffoldStory('conflict-happy', { story: REAL_STORY });
    const fetch = buildApp();
    const res = await fetch(`/api/questions/behavioral/${question.slug}/probes`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { probeJobId: string };
    expect(body.probeJobId).toBe('fake-probe-job-id');
  });

  it('400s when the story has no meaningful content yet (untouched scaffold)', async () => {
    setProviderConfigured();
    const question = scaffoldStory('conflict-empty');
    const fetch = buildApp();
    const res = await fetch(`/api/questions/behavioral/${question.slug}/probes`, {
      method: 'POST',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no story yet/);
  });

  it('400s for a non-prose category (nothing to drill into)', async () => {
    setProviderConfigured();
    const { dir } = scaffoldQuestionAt(ws.root, {
      title: 'Two Sum',
      slug: 'two-sum',
      category: 'js-ts',
      difficulty: 'easy',
      description: 'Return indices of the two numbers that add up to target.',
    });
    const question = ws.session.db.upsertQuestion({
      category: 'js-ts',
      slug: 'two-sum',
      title: 'Two Sum',
      difficulty: 'easy',
      suggestedMinutes: 15,
      dirPath: dir,
      source: 'manual',
    });
    const fetch = buildApp();
    const res = await fetch(`/api/questions/js-ts/${question.slug}/probes`, { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('409s when a probe run is already in progress for this question', async () => {
    setProviderConfigured();
    buildSession(() => true);
    const question = scaffoldStory('conflict-running', { story: REAL_STORY });
    const fetch = buildApp();
    const res = await fetch(`/api/questions/behavioral/${question.slug}/probes`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
  });

  it('409s when a probe set already exists for the active attempt (the bound)', async () => {
    setProviderConfigured();
    const question = scaffoldStory('conflict-bound', { story: REAL_STORY });
    const attempt = ws.session.db.createAttempt(question.id);
    ws.session.db.createProbeSet({
      questionId: question.id,
      attemptId: attempt.id,
      probes: [{ question: 'What would the other engineer say?', source: 'derived' }],
      model: 'claude-sonnet-5',
    });
    const fetch = buildApp();
    const res = await fetch(`/api/questions/behavioral/${question.slug}/probes`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already been generated/);
  });

  it('a probe set for a DIFFERENT attempt does not trip the bound', async () => {
    setProviderConfigured();
    const question = scaffoldStory('conflict-different-attempt', { story: REAL_STORY });
    const oldAttempt = ws.session.db.createAttempt(question.id);
    ws.session.db.patchAttempt(oldAttempt.id, { end: { reason: 'abandoned' } });
    ws.session.db.createProbeSet({
      questionId: question.id,
      attemptId: oldAttempt.id,
      probes: [{ question: 'What would the other engineer say?', source: 'derived' }],
      model: 'claude-sonnet-5',
    });
    // A fresh attempt has no probe set of its own yet.
    ws.session.db.createAttempt(question.id);
    const fetch = buildApp();
    const res = await fetch(`/api/questions/behavioral/${question.slug}/probes`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
  });

  it('503s keyless', async () => {
    const question = scaffoldStory('conflict-keyless', { story: REAL_STORY });
    const fetch = buildApp();
    const res = await fetch(`/api/questions/behavioral/${question.slug}/probes`, {
      method: 'POST',
    });
    expect(res.status).toBe(503);
  });

  it('404s on an unknown question', async () => {
    setProviderConfigured();
    const fetch = buildApp();
    const res = await fetch('/api/questions/behavioral/does-not-exist/probes', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/questions/:category/:slug/probes', () => {
  it('lists probe sets for the question, newest first', async () => {
    const question = scaffoldStory('conflict-list', { story: REAL_STORY });
    const first = ws.session.db.createProbeSet({
      questionId: question.id,
      attemptId: null,
      probes: [{ question: 'first round question', source: 'derived' }],
      model: 'claude-sonnet-5',
    });
    const second = ws.session.db.createProbeSet({
      questionId: question.id,
      attemptId: null,
      probes: [{ question: 'second round question', source: 'bank' }],
      model: 'claude-sonnet-5',
    });
    const fetch = buildApp();
    const res = await fetch(`/api/questions/behavioral/${question.slug}/probes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProbeSetRow[];
    expect(body.map((p) => p.id)).toEqual([second.id, first.id]);
  });

  it('returns an empty list for a question with no probe sets yet', async () => {
    const question = scaffoldStory('conflict-list-empty', { story: REAL_STORY });
    const fetch = buildApp();
    const res = await fetch(`/api/questions/behavioral/${question.slug}/probes`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
