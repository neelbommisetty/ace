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
    const probeSet = ws.session.db.createProbeSet({
      questionId: question.id,
      attemptId: attempt.id,
      probes: [{ question: 'What would the other engineer say?', source: 'derived' }],
      model: 'claude-sonnet-5',
    });
    // The bound only counts APPLIED probe sets (NEE-357) — an unapplied row
    // (as if the story.md write had failed) must not 409 forever.
    ws.session.db.markProbeSetApplied(probeSet.id);
    const fetch = buildApp();
    const res = await fetch(`/api/questions/behavioral/${question.slug}/probes`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already been generated/);
  });

  it('an unapplied probe set (as if the story.md write had failed) does not trip the bound (NEE-357)', async () => {
    setProviderConfigured();
    const question = scaffoldStory('conflict-orphaned', { story: REAL_STORY });
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
    expect(res.status).toBe(202);
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

  // NEE-356: the per-attempt bound above was effectively "one round EVER"
  // for prose questions, because their attempts never ended and so no
  // second attempt was reachable. The probes route itself needed no change
  // — this walks the now-unlocked loop through the real routes to prove it.
  it('a second attempt, unlocked by the review that ended the first, gets a fresh probe round (NEE-356)', async () => {
    setProviderConfigured();
    const question = scaffoldStory('conflict-second-round', { story: REAL_STORY });
    const fetch = buildApp();
    const attemptsUrl = `/api/questions/behavioral/${question.slug}/attempts`;
    const probesUrl = `/api/questions/behavioral/${question.slug}/probes`;

    const first = (await (await fetch(attemptsUrl, { method: 'POST' })).json()) as {
      attempt: { id: string; number: number };
    };
    expect(first.attempt.number).toBe(1);

    // Round 1 lands, and the bound holds within the attempt. The bound only
    // counts APPLIED probe sets (NEE-357), so mark this one applied — this
    // walk is exercising the per-attempt bound, not the orphan carve-out.
    const probeSet = ws.session.db.createProbeSet({
      questionId: question.id,
      attemptId: first.attempt.id,
      probes: [{ question: 'What would the other engineer say?', source: 'derived' }],
      model: 'claude-sonnet-5',
    });
    ws.session.db.markProbeSetApplied(probeSet.id);
    expect((await fetch(probesUrl, { method: 'POST' })).status).toBe(409);

    // The review completes: reviews.ts persists it and closes the attempt
    // (endProseAttemptOnReview) — 'submitted' here, since the verdict fell
    // short of the hire bar and must not mark the question solved.
    ws.session.db.createReview({
      questionId: question.id,
      attemptId: first.attempt.id,
      bodyMd: 'The conflict is described but the resolution is thin.',
      verdict: 'No Hire',
      source: 'user',
    });
    ws.session.db.patchAttempt(first.attempt.id, { end: { reason: 'submitted' } });

    // Reopening the room mints attempt #2 (the question is NOT solved, so
    // this is an editable attempt, not a readonly reference).
    const second = (await (await fetch(attemptsUrl, { method: 'POST' })).json()) as {
      attempt: { id: string; number: number } | null;
      readonly?: boolean;
    };
    expect(second.readonly).toBeUndefined();
    expect(second.attempt?.number).toBe(2);

    // …and that fresh attempt has its own probe budget.
    expect((await fetch(probesUrl, { method: 'POST' })).status).toBe(202);
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
  it('lists probe sets in the null-attempt bucket, newest first, when no attemptId is given', async () => {
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

  // NEE-345 follow-up: the POST bound is per-attempt (hasProbeSetForAttempt),
  // but the GET used to return every attempt's probe sets regardless — the
  // UI had no way to tell attempt 1's stale probes from attempt 2 having
  // none yet. `attemptId` scopes the response the same way the bound scopes
  // the write.
  it('only returns probe sets for the requested attemptId, not other attempts on the same question', async () => {
    const question = scaffoldStory('conflict-scoped', { story: REAL_STORY });
    const attemptOne = ws.session.db.createAttempt(question.id);
    ws.session.db.patchAttempt(attemptOne.id, { end: { reason: 'abandoned' } });
    const attemptTwo = ws.session.db.createAttempt(question.id);
    ws.session.db.createProbeSet({
      questionId: question.id,
      attemptId: attemptOne.id,
      probes: [{ question: 'attempt 1 probe', source: 'derived' }],
      model: 'claude-sonnet-5',
    });
    const fetch = buildApp();

    const attemptTwoRes = await fetch(
      `/api/questions/behavioral/${question.slug}/probes?attemptId=${attemptTwo.id}`,
    );
    expect(await attemptTwoRes.json()).toEqual([]);

    const attemptOneRes = await fetch(
      `/api/questions/behavioral/${question.slug}/probes?attemptId=${attemptOne.id}`,
    );
    const attemptOneBody = (await attemptOneRes.json()) as ProbeSetRow[];
    expect(attemptOneBody).toHaveLength(1);
    expect(attemptOneBody[0].attemptId).toBe(attemptOne.id);
  });

  it('treats a missing attemptId as the null bucket, distinct from any real attempt', async () => {
    const question = scaffoldStory('conflict-scoped-null', { story: REAL_STORY });
    const attempt = ws.session.db.createAttempt(question.id);
    ws.session.db.createProbeSet({
      questionId: question.id,
      attemptId: attempt.id,
      probes: [{ question: 'attempt probe', source: 'derived' }],
      model: 'claude-sonnet-5',
    });
    const fetch = buildApp();
    const res = await fetch(`/api/questions/behavioral/${question.slug}/probes`);
    expect(await res.json()).toEqual([]);
  });
});
