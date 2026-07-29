// @vitest-environment node
//
// Route-level tests for GET /api/reviews/:id and GET /api/disputes/:id
// (NEE-306): the History detail routes fetch by id directly on a reload, so
// both responses must embed the owning `question` alongside the row itself.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, makeWorkspace, type WorkspaceHandle } from './test-support.js';
import type { DisputeRow, QuestionRow, ReviewRow } from './types.js';

let ws: WorkspaceHandle;

beforeEach(() => {
  ws = makeWorkspace('app-review-dispute-by-id');
});

afterEach(() => {
  ws.cleanup();
});

function buildApp() {
  return makeApp({ getWorkspaceRoot: () => ws.root, getSession: () => ws.session }).fetch;
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

describe('GET /api/reviews/:id', () => {
  it('embeds the owning question alongside the review row', async () => {
    const q = makeQuestion();
    const review = ws.session.db.createReview({
      questionId: q.id,
      attemptId: null,
      bodyMd: '## Ways to improve\n\n- Extract the helper',
      verdict: 'Hire',
      source: 'user',
    });

    const fetch = buildApp();
    const res = await fetch(`/api/reviews/${review.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReviewRow & { question: QuestionRow; snapshotContent: null };
    expect(body.id).toBe(review.id);
    expect(body.question.id).toBe(q.id);
    expect(body.question.slug).toBe('debounce');
    expect(body.snapshotContent).toBeNull();
  });

  it('404s for an unknown id', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/reviews/nope');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/disputes/:id', () => {
  it('embeds the owning question alongside the dispute row', async () => {
    const q = makeQuestion();
    const run = ws.session.db.createTestRun({ questionId: q.id, attemptId: null, trigger: 'manual' });
    const dispute = ws.session.db.createDispute({
      questionId: q.id,
      attemptId: null,
      testRunId: run.id,
      argument: 'The test asserts the wrong call count.',
      verdict: 'test_incorrect',
      summary: 'The test undercounts trailing calls.',
      detailsMd: 'details',
      fixedTestCode: null,
      testRelPath: 'questions/js-ts/debounce/test.ts',
      hint: null,
    });

    const fetch = buildApp();
    const res = await fetch(`/api/disputes/${dispute.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DisputeRow & { question: QuestionRow };
    expect(body.id).toBe(dispute.id);
    expect(body.question.id).toBe(q.id);
    expect(body.question.slug).toBe('debounce');
  });

  it('404s for an unknown id', async () => {
    const fetch = buildApp();
    const res = await fetch('/api/disputes/nope');
    expect(res.status).toBe(404);
  });
});
