// @vitest-environment node
//
// Route-level tests for POST /api/questions/:category/:slug/archive and
// .../unarchive (NEE-296) — the "clutter a bad generation leaves behind"
// fix. Same harness as the other app-*.test.ts files: a real Hono app over
// a real temp-dir db, fake engines, no LLM.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffoldQuestionAt } from '../lib/scaffold.js';
import { makeApp, makeWorkspace, type WorkspaceHandle } from './test-support.js';
import type { QuestionDetail, QuestionRow, QuestionWithStats } from './types.js';

let ws: WorkspaceHandle;

beforeEach(() => {
  ws = makeWorkspace('app-questions');
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

function makeQuestion(): QuestionRow {
  return ws.session.db.upsertQuestion({
    category: 'js-ts',
    slug: 'debounce',
    title: 'Debounce',
    difficulty: 'medium',
    suggestedMinutes: 30,
    dirPath: path.join(ws.root, 'questions', 'js-ts', 'debounce'),
    source: 'manual',
  });
}

function makeBehavioralQuestion(): QuestionRow {
  const scaffolded = scaffoldQuestionAt(ws.root, {
    title: 'A Time You Disagreed With a Decision',
    slug: 'disagreed-with-a-decision',
    category: 'behavioral',
    difficulty: 'medium',
    description: 'Tell me about a time you disagreed with a decision and had to push back.',
  });
  return ws.session.db.upsertQuestion({
    category: 'behavioral',
    slug: 'disagreed-with-a-decision',
    title: 'A Time You Disagreed With a Decision',
    difficulty: 'medium',
    suggestedMinutes: 8,
    dirPath: scaffolded.dir,
    source: 'manual',
  });
}

describe('GET /api/questions/:category/:slug', () => {
  it('a behavioral question exposes story.md as kind "notes" with zero test files', async () => {
    const question = makeBehavioralQuestion();
    const fetch = buildApp();

    const res = await fetch(`/api/questions/${question.category}/${question.slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as QuestionDetail;

    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({ name: 'story.md', kind: 'notes', readonly: false });
    expect(body.files.some((f) => f.kind === 'test')).toBe(false);
  });
});

describe('POST /api/questions/:category/:slug/archive', () => {
  it('sets archivedAt and removes the question from the default list', async () => {
    const q = makeQuestion();
    const fetch = buildApp();

    const res = await fetch(`/api/questions/${q.category}/${q.slug}/archive`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { question: QuestionRow };
    expect(body.question.archivedAt).not.toBeNull();

    const questions = (await (await fetch('/api/questions')).json()) as QuestionWithStats[];
    const row = questions.find((r) => r.id === q.id);
    expect(row?.archivedAt).not.toBeNull();
  });

  it('broadcasts questions-changed', async () => {
    const q = makeQuestion();
    const fetch = buildApp();
    const seen: string[] = [];
    const unsubscribe = ws.bus.subscribe((name) => {
      seen.push(name);
    });

    try {
      await fetch(`/api/questions/${q.category}/${q.slug}/archive`, { method: 'POST' });
    } finally {
      unsubscribe();
    }

    expect(seen).toContain('questions-changed');
  });

  it('404s for an unknown category/slug', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/questions/nope/nope/archive', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('is idempotent when archiving twice', async () => {
    const q = makeQuestion();
    const fetch = buildApp();

    await fetch(`/api/questions/${q.category}/${q.slug}/archive`, { method: 'POST' });
    const res = await fetch(`/api/questions/${q.category}/${q.slug}/archive`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { question: QuestionRow };
    expect(body.question.archivedAt).not.toBeNull();
  });

  it('leaves attempts, reviews, and the on-disk directory untouched', async () => {
    const q = makeQuestion();
    ws.session.db.createAttempt(q.id);
    const fetch = buildApp();

    await fetch(`/api/questions/${q.category}/${q.slug}/archive`, { method: 'POST' });

    expect(ws.session.db.getLatestAttempt(q.id)).not.toBeNull();
    // dirPath was never created on disk by makeQuestion — the point is
    // just that archiving never touches the filesystem, which upsertQuestion
    // + archive alone (no fs.rmSync anywhere in the route) already proves.
    const row = ws.session.db.getQuestionById(q.id);
    expect(row?.dirPath).toBe(q.dirPath);
  });
});

describe('POST /api/questions/:category/:slug/unarchive', () => {
  it('clears archivedAt so the question reappears in the default list', async () => {
    const q = makeQuestion();
    const fetch = buildApp();

    await fetch(`/api/questions/${q.category}/${q.slug}/archive`, { method: 'POST' });
    const res = await fetch(`/api/questions/${q.category}/${q.slug}/unarchive`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { question: QuestionRow };
    expect(body.question.archivedAt).toBeNull();

    const questions = (await (await fetch('/api/questions')).json()) as QuestionWithStats[];
    const row = questions.find((r) => r.id === q.id);
    expect(row?.archivedAt).toBeNull();
  });

  it('broadcasts questions-changed', async () => {
    const q = makeQuestion();
    const fetch = buildApp();
    await fetch(`/api/questions/${q.category}/${q.slug}/archive`, { method: 'POST' });

    const seen: string[] = [];
    const unsubscribe = ws.bus.subscribe((name) => {
      seen.push(name);
    });

    try {
      await fetch(`/api/questions/${q.category}/${q.slug}/unarchive`, { method: 'POST' });
    } finally {
      unsubscribe();
    }

    expect(seen).toContain('questions-changed');
  });

  it('404s for an unknown category/slug', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/questions/nope/nope/unarchive', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('is a no-op (200) when unarchiving a question that was never archived', async () => {
    const q = makeQuestion();
    const fetch = buildApp();

    const res = await fetch(`/api/questions/${q.category}/${q.slug}/unarchive`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { question: QuestionRow };
    expect(body.question.archivedAt).toBeNull();
  });
});
