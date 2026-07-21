import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AceDb, QuestionRow, TestCaseResult } from './types.js';
import { openDb } from './db.js';
import { nowIso, uuidv7 } from './ids.js';
import { MIGRATIONS } from './migrations.js';

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
    expect(db.getMeta('schema_version')).toBe('3');
  });

  it('reopens an existing db without re-running migrations', () => {
    const q = makeQuestion();
    db.setMeta('custom', 'kept');
    db.close();

    db = openDb(tempRoot);
    expect(db.getMeta('schema_version')).toBe('3');
    expect(db.getMeta('custom')).toBe('kept');
    expect(db.getQuestionById(q.id)?.slug).toBe('debounce');
  });
});

describe('migration 3 (generation jobs + brainstorm sessions)', () => {
  it('lands schema_version=3 and creates the new tables + indexes', () => {
    expect(db.getMeta('schema_version')).toBe('3');

    const raw = new DatabaseSync(path.join(tempRoot, '.ace', 'ace.db'));
    try {
      const tables = (
        raw
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN ('generation_jobs', 'brainstorm_sessions')
             ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toEqual(['brainstorm_sessions', 'generation_jobs']);

      const indexes = (
        raw
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index'
               AND name IN ('idx_generation_jobs_created_at', 'idx_brainstorm_sessions_updated_at')
             ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(indexes).toEqual(['idx_brainstorm_sessions_updated_at', 'idx_generation_jobs_created_at']);
    } finally {
      raw.close();
    }
  });

  it('migrates a db pre-seeded at schema_version 2 cleanly to 3, preserving existing data', () => {
    // Rebuild the db file from scratch with only the first two migrations
    // applied (mirrors main's schema before M3 landed).
    db.close();
    const dbPath = path.join(tempRoot, '.ace', 'ace.db');
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });

    const seed = new DatabaseSync(dbPath);
    seed.exec('PRAGMA journal_mode = WAL');
    for (let i = 0; i < 2; i++) seed.exec(MIGRATIONS[i]);
    seed.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '2');
    seed
      .prepare(
        `INSERT INTO questions
          (id, category, slug, title, difficulty, suggested_minutes, dir_path, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'seed-q1',
        'js-ts',
        'debounce',
        'Debounce',
        'medium',
        30,
        '/tmp/debounce',
        'manual',
        nowIso(),
      );
    seed.close();

    db = openDb(tempRoot);
    expect(db.getMeta('schema_version')).toBe('3');
    expect(db.getQuestionById('seed-q1')?.slug).toBe('debounce');

    const raw = new DatabaseSync(dbPath);
    try {
      const tables = raw
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN ('generation_jobs', 'brainstorm_sessions')`,
        )
        .all();
      expect(tables).toHaveLength(2);
    } finally {
      raw.close();
    }
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

describe('reviews (M2 extensions)', () => {
  it('round-trips score, dimensions and snapshotHash', () => {
    const q = makeQuestion();
    const dimensions = { Requirements: 4, 'Trade-offs': 3 };
    const hash = 'a'.repeat(40);
    const created = db.createReview({
      questionId: q.id,
      attemptId: null,
      bodyMd: 'Overall 4/5 — solid work.',
      score: 4,
      dimensions,
      snapshotHash: hash,
      model: 'gpt-5.2',
      source: 'user',
    });
    expect(created.score).toBe(4);
    expect(created.dimensions).toEqual(dimensions);
    expect(created.snapshotHash).toBe(hash);
    expect(created.model).toBe('gpt-5.2');

    const fetched = db.getReview(created.id);
    expect(fetched).toEqual(created);
  });

  it('defaults the new fields to null', () => {
    const q = makeQuestion();
    const review = db.createReview({
      questionId: q.id,
      attemptId: null,
      bodyMd: 'plain',
      source: 'import',
    });
    expect(review.score).toBeNull();
    expect(review.dimensions).toBeNull();
    expect(review.snapshotHash).toBeNull();
  });

  it('getReview returns null for unknown ids', () => {
    expect(db.getReview('nope')).toBeNull();
  });

  it('listReviews returns all versions for the question, newest first', () => {
    const qa = makeQuestion({ slug: 'a' });
    const qb = makeQuestion({ slug: 'b' });
    const v1 = db.createReview({ questionId: qa.id, attemptId: null, bodyMd: 'v1', source: 'user' });
    const v2 = db.createReview({ questionId: qa.id, attemptId: null, bodyMd: 'v2', source: 'user' });
    db.createReview({ questionId: qb.id, attemptId: null, bodyMd: 'other', source: 'user' });

    const listed = db.listReviews(qa.id);
    expect(listed.map((r) => r.id)).toEqual([v2.id, v1.id]);
    expect(listed.map((r) => r.version)).toEqual([2, 1]);
    expect(db.listReviews('nope')).toEqual([]);
  });
});

describe('disputes', () => {
  function makeDispute(questionId: string, overrides: Partial<Parameters<AceDb['createDispute']>[0]> = {}) {
    const run = db.createTestRun({ questionId, attemptId: null, trigger: 'manual' });
    return db.createDispute({
      questionId,
      attemptId: null,
      testRunId: run.id,
      argument: null,
      verdict: 'test_incorrect',
      summary: 'The test asserts the wrong value',
      detailsMd: '### Per-test\n\n- rounds: wrong expectation',
      fixedTestCode: 'expect(round(1.5)).toBe(2)',
      testRelPath: 'questions/js-ts/debounce/solution.test.ts',
      hint: null,
      ...overrides,
    });
  }

  it('round-trips a dispute', () => {
    const q = makeQuestion();
    const attempt = db.createAttempt(q.id);
    const run = db.createTestRun({ questionId: q.id, attemptId: attempt.id, trigger: 'manual' });
    const dispute = db.createDispute({
      questionId: q.id,
      attemptId: attempt.id,
      testRunId: run.id,
      argument: 'my rounding is banker-style on purpose',
      verdict: 'ambiguous',
      summary: 'Spec does not pin the rounding mode',
      detailsMd: 'Both behaviors are defensible.',
      fixedTestCode: null,
      testRelPath: 'questions/js-ts/debounce/solution.test.ts',
      hint: 'consider Math.round semantics',
    });

    expect(dispute.questionId).toBe(q.id);
    expect(dispute.attemptId).toBe(attempt.id);
    expect(dispute.testRunId).toBe(run.id);
    expect(dispute.argument).toBe('my rounding is banker-style on purpose');
    expect(dispute.verdict).toBe('ambiguous');
    expect(dispute.summary).toBe('Spec does not pin the rounding mode');
    expect(dispute.detailsMd).toBe('Both behaviors are defensible.');
    expect(dispute.fixedTestCode).toBeNull();
    expect(dispute.testRelPath).toBe('questions/js-ts/debounce/solution.test.ts');
    expect(dispute.hint).toBe('consider Math.round semantics');
    expect(dispute.appliedAt).toBeNull();
    expect(dispute.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(db.getDispute(dispute.id)).toEqual(dispute);
    expect(db.getDispute('nope')).toBeNull();
  });

  it('lists disputes per question, newest first', () => {
    const qa = makeQuestion({ slug: 'a' });
    const qb = makeQuestion({ slug: 'b' });
    const d1 = makeDispute(qa.id);
    const d2 = makeDispute(qa.id);
    makeDispute(qb.id);

    expect(db.listDisputes(qa.id).map((d) => d.id)).toEqual([d2.id, d1.id]);
    expect(db.listDisputes('nope')).toEqual([]);
  });

  it('markDisputeApplied sets applied_at once and keeps the first value', () => {
    const q = makeQuestion();
    const dispute = makeDispute(q.id);

    const applied = db.markDisputeApplied(dispute.id);
    expect(applied.appliedAt).not.toBeNull();

    const again = db.markDisputeApplied(dispute.id);
    expect(again.appliedAt).toBe(applied.appliedAt);
    expect(() => db.markDisputeApplied('nope')).toThrow(/unknown dispute/);
  });
});

describe('snapshots', () => {
  it('round-trips a snapshot', () => {
    const q = makeQuestion();
    const attempt = db.createAttempt(q.id);
    const snap = db.addSnapshot({
      questionId: q.id,
      attemptId: attempt.id,
      relPath: 'questions/js-ts/debounce/solution.ts',
      hash: 'b'.repeat(40),
      trigger: 'review',
    });
    expect(snap.questionId).toBe(q.id);
    expect(snap.attemptId).toBe(attempt.id);
    expect(snap.relPath).toBe('questions/js-ts/debounce/solution.ts');
    expect(snap.hash).toBe('b'.repeat(40));
    expect(snap.trigger).toBe('review');
    expect(snap.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('getLatestSnapshot is scoped to question + relPath and prefers the newest', () => {
    const q = makeQuestion();
    const rel = 'questions/js-ts/debounce/solution.ts';
    expect(db.getLatestSnapshot(q.id, rel)).toBeNull();

    db.addSnapshot({ questionId: q.id, attemptId: null, relPath: rel, hash: '1'.repeat(40), trigger: 'save' });
    const latest = db.addSnapshot({ questionId: q.id, attemptId: null, relPath: rel, hash: '2'.repeat(40), trigger: 'save' });
    db.addSnapshot({
      questionId: q.id,
      attemptId: null,
      relPath: 'questions/js-ts/debounce/notes.md',
      hash: '3'.repeat(40),
      trigger: 'reset',
    });

    expect(db.getLatestSnapshot(q.id, rel)?.id).toBe(latest.id);
    expect(db.getLatestSnapshot(q.id, rel)?.hash).toBe('2'.repeat(40));
    expect(db.getLatestSnapshot(q.id, 'questions/js-ts/debounce/nope.ts')).toBeNull();
    expect(db.getLatestSnapshot('nope', rel)).toBeNull();
  });
});

describe('generation jobs', () => {
  it('round-trips a generation job', () => {
    const job = db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'hard',
      topic: 'a debounce utility with cancel support',
      brainstormSessionId: 'bs-1',
    });

    expect(job.status).toBe('running');
    expect(job.category).toBe('js-ts');
    expect(job.difficulty).toBe('hard');
    expect(job.topic).toBe('a debounce utility with cancel support');
    expect(job.brainstormSessionId).toBe('bs-1');
    expect(job.title).toBeNull();
    expect(job.slug).toBeNull();
    expect(job.result).toBeNull();
    expect(job.rawText).toBeNull();
    expect(job.errorMessage).toBeNull();
    expect(job.questionId).toBeNull();
    expect(job.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(job.finishedAt).toBeNull();

    expect(db.getGenerationJob(job.id)).toEqual(job);
    expect(db.getGenerationJob('nope')).toBeNull();
  });

  it('createGenerationJob defaults brainstormSessionId to null when omitted', () => {
    const job = db.createGenerationJob({ category: 'js-ts', difficulty: 'easy', topic: 'foo' });
    expect(job.brainstormSessionId).toBeNull();
  });

  it('patches through running -> llm_done -> done, stamping finished_at only at done', () => {
    const job = db.createGenerationJob({ category: 'js-ts', difficulty: 'medium', topic: 'x' });

    const llmDone = db.patchGenerationJob(job.id, {
      status: 'llm_done',
      title: 'Debounce Utility',
      slug: 'debounce-utility',
      result: { slug: 'debounce-utility', title: 'Debounce Utility' },
    });
    expect(llmDone.status).toBe('llm_done');
    expect(llmDone.title).toBe('Debounce Utility');
    expect(llmDone.slug).toBe('debounce-utility');
    expect(llmDone.result).toEqual({ slug: 'debounce-utility', title: 'Debounce Utility' });
    expect(llmDone.finishedAt).toBeNull();

    const q = makeQuestion({ slug: 'debounce-utility' });
    const done = db.patchGenerationJob(job.id, { status: 'done', questionId: q.id });
    expect(done.status).toBe('done');
    expect(done.questionId).toBe(q.id);
    // fields not touched by this patch are preserved from the prior patch
    expect(done.title).toBe('Debounce Utility');
    expect(done.slug).toBe('debounce-utility');
    expect(done.result).toEqual({ slug: 'debounce-utility', title: 'Debounce Utility' });
    expect(done.finishedAt).not.toBeNull();
    expect(done.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('stamps finished_at on a transition straight to error and preserves rawText salvage', () => {
    const job = db.createGenerationJob({ category: 'js-ts', difficulty: 'medium', topic: 'x' });
    const errored = db.patchGenerationJob(job.id, {
      status: 'error',
      errorMessage: 'LLM call timed out',
      rawText: 'not quite json',
    });
    expect(errored.status).toBe('error');
    expect(errored.errorMessage).toBe('LLM call timed out');
    expect(errored.rawText).toBe('not quite json');
    expect(errored.finishedAt).not.toBeNull();
  });

  it('throws when patching an already-done job', () => {
    const job = db.createGenerationJob({ category: 'js-ts', difficulty: 'medium', topic: 'x' });
    db.patchGenerationJob(job.id, { status: 'done' });
    expect(() => db.patchGenerationJob(job.id, { title: 'too late' })).toThrow(
      /done and cannot be patched/,
    );
  });

  it('throws when patching an unknown job', () => {
    expect(() => db.patchGenerationJob('nope', { status: 'error' })).toThrow(
      /unknown generation job/,
    );
  });

  it('lists jobs newest first and truncates to the limit', () => {
    const j1 = db.createGenerationJob({ category: 'js-ts', difficulty: 'easy', topic: 'one' });
    const j2 = db.createGenerationJob({ category: 'js-ts', difficulty: 'easy', topic: 'two' });
    const j3 = db.createGenerationJob({ category: 'js-ts', difficulty: 'easy', topic: 'three' });

    expect(db.listGenerationJobs().map((j) => j.id)).toEqual([j3.id, j2.id, j1.id]);
    expect(db.listGenerationJobs(2).map((j) => j.id)).toEqual([j3.id, j2.id]);
    expect(db.listGenerationJobs(1).map((j) => j.id)).toEqual([j3.id]);
  });

  it('setQuestionSource flips provenance and a later upsertQuestion rescan does not revert it', () => {
    const q = makeQuestion({ slug: 'generated-one' });
    expect(q.source).toBe('manual');

    db.setQuestionSource(q.id, 'generated');
    expect(db.getQuestionById(q.id)?.source).toBe('generated');

    // insert-only source semantics: a later rescan upsert must not revert it
    const rescanned = db.upsertQuestion({
      category: q.category,
      slug: q.slug,
      title: 'Debounce (renamed)',
      difficulty: 'hard',
      suggestedMinutes: 45,
      dirPath: q.dirPath,
      source: 'manual',
    });
    expect(rescanned.source).toBe('generated');
    expect(rescanned.title).toBe('Debounce (renamed)');

    expect(db.getQuestionById(q.id)?.source).toBe('generated');
  });
});
