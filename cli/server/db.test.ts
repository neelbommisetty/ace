import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AceDb, QuestionRow, TestCaseResult } from './types.js';
import { openDb } from './db.js';
import { nowIso, uuidv7 } from './ids.js';

let tempRoot = '';
let db: AceDb;

function makeQuestion(overrides: { category?: string; slug?: string } = {}): QuestionRow {
  return db.upsertQuestion({
    category: overrides.category ?? 'js-ts',
    slug: overrides.slug ?? 'debounce',
    title: 'Debounce',
    difficulty: 'medium',
    suggestedMinutes: 30,
    dirPath: path.join(tempRoot, 'questions', 'js-ts', overrides.slug ?? 'debounce'),
    source: 'manual',
  });
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-test-'));
  db = openDb(tempRoot);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('ids', () => {
  it('generates well-formed uuidv7 values', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('sorts lexicographically by creation order', () => {
    const ids = Array.from({ length: 500 }, () => uuidv7());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('nowIso returns an ISO 8601 UTC string', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('openDb', () => {
  it('creates .ace and .ace/tmp and tracks schema_version', () => {
    expect(fs.existsSync(path.join(tempRoot, '.ace', 'ace.db'))).toBe(true);
    expect(fs.statSync(path.join(tempRoot, '.ace', 'tmp')).isDirectory()).toBe(true);
    expect(db.getMeta('schema_version')).toBe('1');
  });

  it('reopens an existing db without re-running migrations', () => {
    const q = makeQuestion();
    db.setMeta('custom', 'kept');
    db.close();

    db = openDb(tempRoot);
    expect(db.getMeta('schema_version')).toBe('1');
    expect(db.getMeta('custom')).toBe('kept');
    expect(db.getQuestionById(q.id)?.slug).toBe('debounce');
  });
});

describe('questions', () => {
  it('upserts by (category, slug), keeping id and source on update', () => {
    const first = makeQuestion();
    const second = db.upsertQuestion({
      category: 'js-ts',
      slug: 'debounce',
      title: 'Debounce v2',
      difficulty: 'hard',
      suggestedMinutes: 45,
      dirPath: first.dirPath,
      source: 'generated',
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('Debounce v2');
    expect(second.difficulty).toBe('hard');
    expect(second.suggestedMinutes).toBe(45);
    expect(second.source).toBe('manual');
    expect(db.listQuestions()).toHaveLength(1);
  });

  it('looks up by id and by category/slug', () => {
    const q = makeQuestion();
    expect(db.getQuestionById(q.id)?.id).toBe(q.id);
    expect(db.getQuestion('js-ts', 'debounce')?.id).toBe(q.id);
    expect(db.getQuestionById('nope')).toBeNull();
    expect(db.getQuestion('js-ts', 'nope')).toBeNull();
  });

  it('setMissing marks vanished rows and clears returned ones', () => {
    const a = makeQuestion({ slug: 'a' });
    const b = makeQuestion({ slug: 'b' });

    db.setMissing([a.id], [b.id]);
    expect(db.getQuestionById(a.id)?.missingAt).toBeNull();
    expect(db.getQuestionById(b.id)?.missingAt).not.toBeNull();

    const firstMissingAt = db.getQuestionById(b.id)?.missingAt;
    db.setMissing([a.id], [b.id]);
    expect(db.getQuestionById(b.id)?.missingAt).toBe(firstMissingAt);

    db.setMissing([a.id, b.id], []);
    expect(db.getQuestionById(b.id)?.missingAt).toBeNull();
  });
});

describe('attempt lifecycle', () => {
  it('numbers attempts sequentially and supersedes the active one', () => {
    const q = makeQuestion();
    const first = db.createAttempt(q.id);
    expect(first.number).toBe(1);
    expect(first.endedAt).toBeNull();
    expect(first.imported).toBe(false);
    expect(db.getActiveAttempt(q.id)?.id).toBe(first.id);

    const second = db.createAttempt(q.id);
    expect(second.number).toBe(2);
    expect(db.getActiveAttempt(q.id)?.id).toBe(second.id);

    const superseded = db.getAttempt(first.id);
    expect(superseded?.endedAt).not.toBeNull();
    expect(superseded?.endReason).toBe('superseded');
  });

  it('rejects attempts for unknown questions', () => {
    expect(() => db.createAttempt('missing-question')).toThrow(/unknown question/);
  });

  it('accumulates activeSecondsDelta and ends once', () => {
    const q = makeQuestion();
    const attempt = db.createAttempt(q.id);

    expect(db.patchAttempt(attempt.id, { activeSecondsDelta: 15 }).activeSeconds).toBe(15);
    expect(db.patchAttempt(attempt.id, { activeSecondsDelta: 10 }).activeSeconds).toBe(25);

    const ended = db.patchAttempt(attempt.id, { end: { reason: 'green' } });
    expect(ended.endedAt).not.toBeNull();
    expect(ended.endReason).toBe('green');

    // a second end must not overwrite the first
    const again = db.patchAttempt(attempt.id, { end: { reason: 'abandoned' } });
    expect(again.endReason).toBe('green');
    expect(again.endedAt).toBe(ended.endedAt);
    expect(db.getActiveAttempt(q.id)).toBeNull();
  });

  it('getLatestActiveAttempt spans questions and prefers the newest start', () => {
    expect(db.getLatestActiveAttempt()).toBeNull();

    const qa = makeQuestion({ slug: 'a' });
    const qb = makeQuestion({ slug: 'b' });
    db.createAttempt(qa.id, { startedAt: '2026-07-01T10:00:00.000Z' });
    const newer = db.createAttempt(qb.id, { startedAt: '2026-07-02T10:00:00.000Z' });

    const latest = db.getLatestActiveAttempt();
    expect(latest?.attempt.id).toBe(newer.id);
    expect(latest?.question.id).toBe(qb.id);

    db.patchAttempt(newer.id, { end: { reason: 'submitted' } });
    expect(db.getLatestActiveAttempt()?.question.id).toBe(qa.id);
  });
});

describe('attempt events', () => {
  it('dedupes first_edit and all_green per attempt', () => {
    const q = makeQuestion();
    const attempt = db.createAttempt(q.id);

    const first = db.addAttemptEvent(attempt.id, 'first_edit');
    const dupe = db.addAttemptEvent(attempt.id, 'first_edit');
    expect(dupe.id).toBe(first.id);

    db.addAttemptEvent(attempt.id, 'all_green');
    db.addAttemptEvent(attempt.id, 'all_green');
    db.addAttemptEvent(attempt.id, 'test_run', { runId: 'r1' });
    db.addAttemptEvent(attempt.id, 'test_run', { runId: 'r2' });

    const events = db.listAttemptEvents(attempt.id);
    expect(events.map((e) => e.type)).toEqual(['first_edit', 'all_green', 'test_run', 'test_run']);
    expect(events[2].payload).toEqual({ runId: 'r1' });
    expect(events[0].payload).toBeNull();
  });

  it('dedupe is scoped to the attempt', () => {
    const q = makeQuestion();
    const a1 = db.createAttempt(q.id);
    db.addAttemptEvent(a1.id, 'first_edit');
    const a2 = db.createAttempt(q.id);
    db.addAttemptEvent(a2.id, 'first_edit');

    expect(db.hasAttemptEvent(a1.id, 'first_edit')).toBe(true);
    expect(db.hasAttemptEvent(a2.id, 'first_edit')).toBe(true);
    expect(db.hasAttemptEvent(a2.id, 'all_green')).toBe(false);
    expect(db.listAttemptEvents(a2.id)).toHaveLength(1);
  });
});

describe('test runs', () => {
  const results: TestCaseResult[] = [
    { name: 'adds', suite: 'math', status: 'passed', durationMs: 3, error: null },
    { name: 'subtracts', suite: 'math', status: 'failed', durationMs: 5, error: 'expected 1' },
  ];

  it('round-trips a finished run', () => {
    const q = makeQuestion();
    const attempt = db.createAttempt(q.id);
    const run = db.createTestRun({ questionId: q.id, attemptId: attempt.id, trigger: 'manual' });
    expect(run.status).toBe('running');
    expect(run.total).toBeNull();
    expect(run.results).toBeNull();

    const done = db.finishTestRun(run.id, {
      status: 'done',
      summary: { total: 2, passed: 1, failed: 1, skipped: 0, durationMs: 120 },
      results,
      stdout: 'out',
      stderr: 'err',
    });
    expect(done.status).toBe('done');
    expect(done.total).toBe(2);
    expect(done.passed).toBe(1);
    expect(done.failed).toBe(1);
    expect(done.skipped).toBe(0);
    expect(done.durationMs).toBe(120);
    expect(done.results).toEqual(results);
    expect(done.stdout).toBe('out');
    expect(done.stderr).toBe('err');
    expect(done.errorMessage).toBeNull();
    expect(done.trigger).toBe('manual');

    expect(db.getTestRun(run.id)).toEqual(done);
  });

  it('records error runs with a message', () => {
    const q = makeQuestion();
    const run = db.createTestRun({ questionId: q.id, attemptId: null, trigger: 'save' });
    const errored = db.finishTestRun(run.id, {
      status: 'error',
      errorMessage: 'vitest not installed in workspace — run npm install',
    });
    expect(errored.status).toBe('error');
    expect(errored.errorMessage).toMatch(/vitest not installed/);
    expect(errored.total).toBeNull();
  });

  it('lists runs newest-first with a limit', () => {
    const q = makeQuestion();
    const r1 = db.createTestRun({ questionId: q.id, attemptId: null, trigger: 'manual' });
    const r2 = db.createTestRun({ questionId: q.id, attemptId: null, trigger: 'save' });
    const r3 = db.createTestRun({ questionId: q.id, attemptId: null, trigger: 'save' });

    expect(db.listTestRuns(q.id).map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
    expect(db.listTestRuns(q.id, 2).map((r) => r.id)).toEqual([r3.id, r2.id]);
    expect(db.getLatestTestRun(q.id)?.id).toBe(r3.id);
    expect(db.getLatestTestRun('nope')).toBeNull();
  });
});

describe('question stats', () => {
  it('derives not-started → in-progress → green', () => {
    const q = makeQuestion();
    expect(db.listQuestions()[0].stats).toEqual({
      attemptCount: 0,
      lastRun: null,
      lastActivityAt: null,
      status: 'not-started',
      imported: false,
    });

    const attempt = db.createAttempt(q.id, { startedAt: '2026-07-01T09:00:00.000Z' });
    let stats = db.listQuestions()[0].stats;
    expect(stats.status).toBe('in-progress');
    expect(stats.attemptCount).toBe(1);
    expect(stats.lastActivityAt).toBe('2026-07-01T09:00:00.000Z');

    const run = db.createTestRun({ questionId: q.id, attemptId: attempt.id, trigger: 'manual' });
    // a running (not done) run does not affect status
    expect(db.listQuestions()[0].stats.status).toBe('in-progress');
    expect(db.listQuestions()[0].stats.lastRun).toBeNull();

    db.finishTestRun(run.id, {
      status: 'done',
      summary: { total: 3, passed: 3, failed: 0, skipped: 0, durationMs: 50 },
      results: [],
    });
    stats = db.listQuestions()[0].stats;
    expect(stats.status).toBe('green');
    expect(stats.lastRun?.passed).toBe(3);
    expect(stats.lastRun?.total).toBe(3);
    // run happened after the attempt started → run.at wins last activity
    expect(stats.lastActivityAt).toBe(stats.lastRun?.at);
  });

  it('a later failing run takes status back off green', () => {
    const q = makeQuestion();
    const attempt = db.createAttempt(q.id);
    const green = db.createTestRun({ questionId: q.id, attemptId: attempt.id, trigger: 'manual' });
    db.finishTestRun(green.id, {
      status: 'done',
      summary: { total: 2, passed: 2, failed: 0, skipped: 0, durationMs: 10 },
      results: [],
    });
    const red = db.createTestRun({ questionId: q.id, attemptId: attempt.id, trigger: 'save' });
    db.finishTestRun(red.id, {
      status: 'done',
      summary: { total: 2, passed: 1, failed: 1, skipped: 0, durationMs: 10 },
      results: [],
    });

    const stats = db.listQuestions()[0].stats;
    expect(stats.status).toBe('in-progress');
    expect(stats.lastRun?.passed).toBe(1);
  });

  it('an all-pass run with zero tests is not green', () => {
    const q = makeQuestion();
    db.createAttempt(q.id);
    const run = db.createTestRun({ questionId: q.id, attemptId: null, trigger: 'manual' });
    db.finishTestRun(run.id, {
      status: 'done',
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 5 },
      results: [],
    });
    expect(db.listQuestions()[0].stats.status).toBe('in-progress');
  });

  it('flags questions with imported attempts', () => {
    const q = makeQuestion();
    const attempt = db.createAttempt(q.id, { imported: true, startedAt: '2026-01-01T00:00:00.000Z' });
    db.patchAttempt(attempt.id, { end: { reason: 'submitted' } });
    const stats = db.listQuestions()[0].stats;
    expect(stats.imported).toBe(true);
    expect(stats.status).toBe('in-progress');
  });
});

describe('reviews and meta', () => {
  it('auto-increments review versions per question', () => {
    const q = makeQuestion();
    const first = db.createReview({
      questionId: q.id,
      attemptId: null,
      bodyMd: '## Feedback\n\nSolid.',
      verdict: 'Hire',
      source: 'import',
      at: '2026-02-01T00:00:00.000Z',
    });
    expect(first.version).toBe(1);
    expect(first.verdict).toBe('Hire');
    expect(first.model).toBeNull();
    expect(first.dimensions).toBeNull();
    expect(first.at).toBe('2026-02-01T00:00:00.000Z');

    const second = db.createReview({
      questionId: q.id,
      attemptId: null,
      bodyMd: 'Round two',
      source: 'user',
    });
    expect(second.version).toBe(2);
    expect(second.verdict).toBeNull();
    expect(second.source).toBe('user');
  });

  it('get/set meta round-trips and overwrites', () => {
    expect(db.getMeta('nope')).toBeNull();
    db.setMeta('k', 'v1');
    expect(db.getMeta('k')).toBe('v1');
    db.setMeta('k', 'v2');
    expect(db.getMeta('k')).toBe('v2');
  });

  it('imported attempts never supersede a live attempt', () => {
    const q = makeQuestion({ slug: 'import-vs-live' });
    const live = db.createAttempt(q.id);

    const imported = db.createAttempt(q.id, {
      imported: true,
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    db.patchAttempt(imported.id, { end: { reason: 'submitted' } });

    const stillLive = db.getActiveAttempt(q.id);
    expect(stillLive?.id).toBe(live.id);
    expect(stillLive?.endedAt).toBeNull();
  });

  it('transaction rolls back every write on throw', () => {
    const q = makeQuestion({ slug: 'txn-rollback' });
    expect(() =>
      db.transaction(() => {
        db.createAttempt(q.id, { imported: true, startedAt: '2026-01-01T00:00:00.000Z' });
        db.setMeta('txn-key', 'set');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.listQuestions().find((x) => x.slug === 'txn-rollback')?.stats.attemptCount).toBe(0);
    expect(db.getMeta('txn-key')).toBeNull();
  });
});
