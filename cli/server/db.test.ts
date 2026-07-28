import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(db.getMeta('schema_version')).toBe('6');
  });

  it('reopens an existing db without re-running migrations', () => {
    const q = makeQuestion();
    db.setMeta('custom', 'kept');
    db.close();

    db = openDb(tempRoot);
    expect(db.getMeta('schema_version')).toBe('6');
    expect(db.getMeta('custom')).toBe('kept');
    expect(db.getQuestionById(q.id)?.slug).toBe('debounce');
  });
});

describe('migration 3 (generation jobs + brainstorm sessions)', () => {
  it('lands schema_version=3 and creates the new tables + indexes', () => {
    expect(db.getMeta('schema_version')).toBe('6');

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
    // openDb runs every migration after the seeded version, so this now also
    // picks up migration 4 (NEE-178 backfill), migration 5 (NEE-266 AI
    // activity log) and migration 6 (NEE-277 run_started_at) on top of
    // migration 3.
    expect(db.getMeta('schema_version')).toBe('6');
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

describe('migration 4 (NEE-178 backfill: close stale solved-question attempts)', () => {
  it('closes only attempts whose question is solved by a run at/after started_at, leaves the rest alone', () => {
    // Rebuild the db file from scratch at schema_version 3 (all pre-NEE-178
    // migrations applied), hand-seed questions/attempts/test_runs, then
    // reopen so openDb applies migration 4 and we assert on the result.
    db.close();
    const dbPath = path.join(tempRoot, '.ace', 'ace.db');
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });

    const seed = new DatabaseSync(dbPath);
    seed.exec('PRAGMA journal_mode = WAL');
    for (const m of MIGRATIONS.slice(0, 3)) seed.exec(m);
    seed.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '3');

    const insertQuestion = seed.prepare(
      `INSERT INTO questions
        (id, category, slug, title, difficulty, suggested_minutes, dir_path, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAttempt = seed.prepare(
      `INSERT INTO attempts
        (id, question_id, number, started_at, ended_at, end_reason, active_seconds, hints_used, imported)
       VALUES (?, ?, 1, ?, ?, ?, 0, 0, 0)`,
    );
    const insertRun = seed.prepare(
      `INSERT INTO test_runs
        (id, attempt_id, question_id, at, "trigger", status, total, passed, failed, skipped)
       VALUES (?, NULL, ?, ?, 'manual', ?, ?, ?, ?, ?)`,
    );

    for (const slug of ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']) {
      insertQuestion.run(slug, 'js-ts', slug, slug, 'medium', 30, `/tmp/${slug}`, 'manual', '2026-01-01T00:00:00.000Z');
    }

    // q1: open attempt, fully-passing done run AFTER started_at -> closed 'solved'.
    insertAttempt.run('a1', 'q1', '2026-01-01T00:00:00.000Z', null, null);
    insertRun.run('r1', 'q1', '2026-01-01T00:10:00.000Z', 'done', 5, 5, 0, 0);

    // q2: open attempt, failing done run -> stays open.
    insertAttempt.run('a2', 'q2', '2026-01-01T00:00:00.000Z', null, null);
    insertRun.run('r2', 'q2', '2026-01-01T00:10:00.000Z', 'done', 5, 3, 2, 0);

    // q3: open attempt, passing done run followed by newer failing done run -> stays open.
    insertAttempt.run('a3', 'q3', '2026-01-01T00:00:00.000Z', null, null);
    insertRun.run('r3a', 'q3', '2026-01-01T00:10:00.000Z', 'done', 5, 5, 0, 0);
    insertRun.run('r3b', 'q3', '2026-01-01T00:20:00.000Z', 'done', 5, 2, 3, 0);

    // q4: already-ended attempt on a green question -> original end_reason untouched.
    insertAttempt.run('a4', 'q4', '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z', 'abandoned');
    insertRun.run('r4', 'q4', '2026-01-01T00:10:00.000Z', 'done', 5, 5, 0, 0);

    // q5 (stale-run case): attempt started AFTER the question's only passing
    // done run, no newer runs -> stays open (this is the re-attempt case the
    // t.at >= attempts.started_at clause protects).
    insertRun.run('r5', 'q5', '2026-01-01T00:00:00.000Z', 'done', 5, 5, 0, 0);
    insertAttempt.run('a5', 'q5', '2026-01-01T00:10:00.000Z', null, null);

    // q6: 'done' run with NULL total -> attempt stays open (NULL falls out
    // of the `t.total > 0 AND t.passed = t.total` = 1 comparison).
    insertAttempt.run('a6', 'q6', '2026-01-01T00:00:00.000Z', null, null);
    seed
      .prepare(
        `INSERT INTO test_runs
          (id, attempt_id, question_id, at, "trigger", status, total, passed, failed, skipped)
         VALUES (?, NULL, ?, ?, 'manual', 'done', NULL, NULL, NULL, NULL)`,
      )
      .run('r6', 'q6', '2026-01-01T00:10:00.000Z');

    seed.close();

    db = openDb(tempRoot);
    expect(db.getMeta('schema_version')).toBe('6');

    const a1 = db.getAttempt('a1')!;
    expect(a1.endReason).toBe('solved');
    expect(a1.endedAt).toBe('2026-01-01T00:10:00.000Z');
    expect(a1.endedAt! >= a1.startedAt).toBe(true);

    expect(db.getAttempt('a2')!.endedAt).toBeNull();
    expect(db.getAttempt('a3')!.endedAt).toBeNull();

    const a4 = db.getAttempt('a4')!;
    expect(a4.endReason).toBe('abandoned');
    expect(a4.endedAt).toBe('2026-01-01T00:05:00.000Z');

    expect(db.getAttempt('a5')!.endedAt).toBeNull();
    expect(db.getAttempt('a6')!.endedAt).toBeNull();
  });
});

describe('migration 5 (NEE-266: ai activity log)', () => {
  it('creates ai_runs/ai_steps and their indexes', () => {
    expect(db.getMeta('schema_version')).toBe('6');

    const raw = new DatabaseSync(path.join(tempRoot, '.ace', 'ace.db'));
    try {
      const tables = (
        raw
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN ('ai_runs', 'ai_steps')
             ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toEqual(['ai_runs', 'ai_steps']);

      const indexes = (
        raw
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index'
               AND name IN ('idx_ai_runs_started_at', 'idx_ai_runs_ref', 'idx_ai_steps_run_seq')
             ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(indexes).toEqual(['idx_ai_runs_ref', 'idx_ai_runs_started_at', 'idx_ai_steps_run_seq']);
    } finally {
      raw.close();
    }
  });

  it('migrates a db pre-seeded at schema_version 4 cleanly to 5, preserving existing data', () => {
    db.close();
    const dbPath = path.join(tempRoot, '.ace', 'ace.db');
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });

    const seed = new DatabaseSync(dbPath);
    seed.exec('PRAGMA journal_mode = WAL');
    for (const m of MIGRATIONS.slice(0, 4)) seed.exec(m);
    seed.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '4');
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
    expect(db.getMeta('schema_version')).toBe('6');
    expect(db.getQuestionById('seed-q1')?.slug).toBe('debounce');
    expect(db.listAiRuns()).toEqual([]);
  });
});

describe('migration 6 (NEE-277: generation_jobs.run_started_at)', () => {
  it('migrates a db pre-seeded at schema_version 5 and backfills run_started_at to created_at', () => {
    db.close();
    const dbPath = path.join(tempRoot, '.ace', 'ace.db');
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });

    const seed = new DatabaseSync(dbPath);
    seed.exec('PRAGMA journal_mode = WAL');
    for (const m of MIGRATIONS.slice(0, 5)) seed.exec(m);
    seed.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '5');
    // A pre-migration job row has no run_started_at column at all.
    seed
      .prepare(
        `INSERT INTO generation_jobs
          (id, status, category, difficulty, topic, error_message, created_at, finished_at)
         VALUES (?, 'error', 'js-ts', 'medium', 'pre-migration job', 'boom', ?, ?)`,
      )
      .run('gj-old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z');
    seed.close();

    db = openDb(tempRoot);
    expect(db.getMeta('schema_version')).toBe('6');
    const migrated = db.getGenerationJob('gj-old')!;
    // Backfilled to created_at so historical jobs keep their current reading.
    expect(migrated.runStartedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(migrated.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(migrated.status).toBe('error');
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

    const ended = db.patchAttempt(attempt.id, { end: { reason: 'solved' } });
    expect(ended.endedAt).not.toBeNull();
    expect(ended.endReason).toBe('solved');

    // a second end must not overwrite the first
    const again = db.patchAttempt(attempt.id, { end: { reason: 'abandoned' } });
    expect(again.endReason).toBe('solved');
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

  it('getLatestAttempt returns the newest attempt regardless of ended state', () => {
    const q = makeQuestion();
    expect(db.getLatestAttempt(q.id)).toBeNull();

    const first = db.createAttempt(q.id, { startedAt: '2026-07-01T10:00:00.000Z' });
    expect(db.getLatestAttempt(q.id)?.id).toBe(first.id);

    db.patchAttempt(first.id, { end: { reason: 'submitted' } });
    // still the newest even though it's now ended
    expect(db.getLatestAttempt(q.id)?.id).toBe(first.id);

    const second = db.createAttempt(q.id, { startedAt: '2026-07-02T10:00:00.000Z' });
    expect(db.getLatestAttempt(q.id)?.id).toBe(second.id);
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

  it('getLatestCompletedTestRun returns the newest done run, skipping running/error rows', () => {
    const q = makeQuestion();
    expect(db.getLatestCompletedTestRun(q.id)).toBeNull();

    const r1 = db.createTestRun({ questionId: q.id, attemptId: null, trigger: 'manual' });
    db.finishTestRun(r1.id, {
      status: 'done',
      summary: { total: 2, passed: 1, failed: 1, skipped: 0, durationMs: 10 },
    });

    // a still-running run must not shadow the completed one
    db.createTestRun({ questionId: q.id, attemptId: null, trigger: 'save' });
    expect(db.getLatestCompletedTestRun(q.id)?.id).toBe(r1.id);

    // an errored run must not shadow the completed one either
    const errored = db.createTestRun({ questionId: q.id, attemptId: null, trigger: 'save' });
    db.finishTestRun(errored.id, { status: 'error', errorMessage: 'boom' });
    expect(db.getLatestCompletedTestRun(q.id)?.id).toBe(r1.id);

    const r2 = db.createTestRun({ questionId: q.id, attemptId: null, trigger: 'manual' });
    db.finishTestRun(r2.id, {
      status: 'done',
      summary: { total: 2, passed: 2, failed: 0, skipped: 0, durationMs: 10 },
    });
    expect(db.getLatestCompletedTestRun(q.id)?.id).toBe(r2.id);
    expect(db.getLatestCompletedTestRun('nope')).toBeNull();
  });
});

describe('question stats', () => {
  it('derives not-attempted → in-progress → solved', () => {
    const q = makeQuestion();
    expect(db.listQuestions()[0].stats).toEqual({
      attemptCount: 0,
      lastRun: null,
      lastActivityAt: null,
      status: 'not-attempted',
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
    expect(stats.status).toBe('solved');
    expect(stats.lastRun?.passed).toBe(3);
    expect(stats.lastRun?.total).toBe(3);
    // run happened after the attempt started → run.at wins last activity
    expect(stats.lastActivityAt).toBe(stats.lastRun?.at);
  });

  it('a later failing run takes status back off solved', () => {
    const q = makeQuestion();
    const attempt = db.createAttempt(q.id);
    const solved = db.createTestRun({ questionId: q.id, attemptId: attempt.id, trigger: 'manual' });
    db.finishTestRun(solved.id, {
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

  it('an all-pass run with zero tests is not solved', () => {
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
    expect(job.runStartedAt).toBe(job.createdAt); // first run starts at creation
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

  it('re-stamps run_started_at only when the patch supplies it, preserving created_at', () => {
    const job = db.createGenerationJob({ category: 'js-ts', difficulty: 'medium', topic: 'x' });

    // Ordinary patches (stage results, error transitions) leave it alone.
    const errored = db.patchGenerationJob(job.id, { status: 'error', errorMessage: 'boom' });
    expect(errored.runStartedAt).toBe(job.runStartedAt);

    // A retry-shaped patch re-stamps it; created_at (strip ordering) and
    // finished_at (cleared on the way back to 'running') behave as before.
    const restarted = db.patchGenerationJob(job.id, {
      status: 'running',
      errorMessage: null,
      runStartedAt: '2026-07-27T12:00:00.000Z',
    });
    expect(restarted.runStartedAt).toBe('2026-07-27T12:00:00.000Z');
    expect(restarted.createdAt).toBe(job.createdAt);
    expect(restarted.finishedAt).toBeNull();
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

describe('brainstorm sessions', () => {
  it('creates a session seeded with the first user turn, thinking, title truncated', () => {
    const session = db.createBrainstormSession('an idea about debounced React hooks 🎯');

    expect(session.status).toBe('thinking');
    expect(session.title).toBe('an idea about debounced React hooks 🎯');
    expect(session.messages).toEqual([
      { role: 'user', content: 'an idea about debounced React hooks 🎯' },
    ]);
    expect(session.errorMessage).toBeNull();
    expect(session.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(session.updatedAt).toBe(session.createdAt);

    expect(db.getBrainstormSession(session.id)).toEqual(session);
    expect(db.getBrainstormSession('nope')).toBeNull();
  });

  it('truncates a long first message for the title but keeps full content in messages', () => {
    const long = 'x'.repeat(200);
    const session = db.createBrainstormSession(long);

    expect(session.title.length).toBe(80);
    expect(session.title.endsWith('…')).toBe(true);
    expect(session.messages[0].content).toBe(long);
  });

  it('round-trips multi-turn conversations verbatim, including unicode and code fences', () => {
    const session = db.createBrainstormSession('give me an array question idea 😀');

    const codeFence = [
      '```ts',
      'function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number) {',
      "  // handles 'quotes', \"double quotes\", and emoji 🚀",
      '  let t: ReturnType<typeof setTimeout> | undefined;',
      '  return (...args: Parameters<T>) => {',
      '    clearTimeout(t);',
      '    t = setTimeout(() => fn(...args), ms);',
      '  };',
      '}',
      '```',
    ].join('\n');

    const withIdeas = db.appendBrainstormTurn(
      session.id,
      {
        role: 'assistant',
        content: `Here are a few ideas:\n\n${codeFence}`,
        ideas: [
          {
            title: 'Debounce with cancel — 取消可能なデバウンス',
            category: 'js-ts',
            difficulty: 'medium',
            pitch: 'A classic closures + timers exercise.',
            topic: 'implement a debounce utility with a cancel() method',
          },
        ],
      },
      'idle',
    );

    expect(withIdeas.status).toBe('idle');
    expect(withIdeas.messages).toHaveLength(2);
    expect(withIdeas.messages[1].content).toBe(`Here are a few ideas:\n\n${codeFence}`);
    expect(withIdeas.messages[1].ideas).toEqual([
      {
        title: 'Debounce with cancel — 取消可能なデバウンス',
        category: 'js-ts',
        difficulty: 'medium',
        pitch: 'A classic closures + timers exercise.',
        topic: 'implement a debounce utility with a cancel() method',
      },
    ]);
    expect(withIdeas.updatedAt >= session.createdAt).toBe(true);

    const withFollowup = db.appendBrainstormTurn(
      session.id,
      { role: 'user', content: 'give me another one, more advanced' },
      'thinking',
    );
    expect(withFollowup.status).toBe('thinking');
    expect(withFollowup.messages).toHaveLength(3);
    // earlier turns preserved exactly
    expect(withFollowup.messages[0]).toEqual({
      role: 'user',
      content: 'give me an array question idea 😀',
    });
    expect(withFollowup.messages[1]).toEqual(withIdeas.messages[1]);

    expect(db.getBrainstormSession(session.id)).toEqual(withFollowup);
  });

  it('throws appending a turn to an unknown session', () => {
    expect(() =>
      db.appendBrainstormTurn('nope', { role: 'assistant', content: 'hi' }, 'idle'),
    ).toThrow(/unknown brainstorm session/);
  });

  it('leaves messages_json byte-for-byte unchanged when the append transaction fails mid-write', () => {
    const session = db.createBrainstormSession('a starting idea');
    const before = db.getBrainstormSession(session.id)!;

    const raw = (db as unknown as { db: DatabaseSync }).db;
    const originalPrepare = raw.prepare.bind(raw);
    raw.prepare = ((sql: string) => {
      if (sql.includes('UPDATE brainstorm_sessions')) {
        throw new Error('boom - simulated mid-transaction failure');
      }
      return originalPrepare(sql);
    }) as typeof raw.prepare;

    try {
      expect(() =>
        db.appendBrainstormTurn(session.id, { role: 'assistant', content: 'reply' }, 'idle'),
      ).toThrow('boom - simulated mid-transaction failure');
    } finally {
      raw.prepare = originalPrepare;
    }

    const after = db.getBrainstormSession(session.id);
    expect(after).toEqual(before);
    expect(after?.messages).toEqual(before.messages);
    expect(after?.status).toBe('thinking');
    expect(after?.updatedAt).toBe(before.updatedAt);
  });

  it('setBrainstormStatus flips status/errorMessage without touching messages', () => {
    const session = db.createBrainstormSession('idea time');

    const errored = db.setBrainstormStatus(session.id, 'error', 'LLM call failed');
    expect(errored.status).toBe('error');
    expect(errored.errorMessage).toBe('LLM call failed');
    expect(errored.messages).toEqual(session.messages);

    // omitted errorMessage clears any stale error on the next transition
    const recovered = db.setBrainstormStatus(session.id, 'thinking');
    expect(recovered.status).toBe('thinking');
    expect(recovered.errorMessage).toBeNull();
    expect(recovered.messages).toEqual(session.messages);
  });

  it('appendBrainstormTurn clears a stale error_message left over from a previous failed turn', () => {
    const session = db.createBrainstormSession('idea time');
    db.setBrainstormStatus(session.id, 'error', 'the model API is down');

    // Retrying re-enters via a user turn (status 'thinking') — the stale
    // error from the previous attempt must not survive it.
    const retried = db.appendBrainstormTurn(
      session.id,
      { role: 'user', content: 'try again' },
      'thinking',
    );
    expect(retried.status).toBe('thinking');
    expect(retried.errorMessage).toBeNull();
  });

  it('throws setting status on an unknown session', () => {
    expect(() => db.setBrainstormStatus('nope', 'error', 'x')).toThrow(
      /unknown brainstorm session/,
    );
  });

  it('lists sessions newest-first by updatedAt and truncates to the limit', () => {
    // node:sqlite's default text timestamp resolution is 1ms; fake timers
    // force distinct updated_at values so ordering reflects updatedAt (not
    // just insertion/id order) deterministically.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const s1 = db.createBrainstormSession('first');
      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
      const s2 = db.createBrainstormSession('second');
      vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
      const s3 = db.createBrainstormSession('third');

      // bump s1's updated_at above s2/s3 via an append
      vi.setSystemTime(new Date('2026-01-01T00:00:03.000Z'));
      db.appendBrainstormTurn(s1.id, { role: 'assistant', content: 'reply' }, 'idle');

      const listed = db.listBrainstormSessions();
      expect(listed.map((s) => s.id)).toEqual([s1.id, s3.id, s2.id]);
      expect(db.listBrainstormSessions(2).map((s) => s.id)).toEqual([s1.id, s3.id]);
      expect(db.listBrainstormSessions(1).map((s) => s.id)).toEqual([s1.id]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ai activity log', () => {
  it('round-trips a run', () => {
    const run = db.createAiRun({
      kind: 'generation',
      refId: 'job-1',
      questionId: null,
      label: 'Generate: debounce utility',
    });

    expect(run.kind).toBe('generation');
    expect(run.refId).toBe('job-1');
    expect(run.questionId).toBeNull();
    expect(run.label).toBe('Generate: debounce utility');
    expect(run.status).toBe('running');
    expect(run.errorMessage).toBeNull();
    expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(run.finishedAt).toBeNull();

    expect(db.getAiRun(run.id)).toEqual(run);
    expect(db.getAiRun('nope')).toBeNull();
  });

  it('createAiRun defaults refId/questionId to null when omitted', () => {
    const run = db.createAiRun({ kind: 'brainstorm', label: 'Brainstorm' });
    expect(run.refId).toBeNull();
    expect(run.questionId).toBeNull();
  });

  it('finishAiRun stamps finishedAt for done and error outcomes', () => {
    const done = db.finishAiRun(db.createAiRun({ kind: 'review', label: 'r' }).id, {
      status: 'done',
    });
    expect(done.status).toBe('done');
    expect(done.errorMessage).toBeNull();
    expect(done.finishedAt).not.toBeNull();

    const errored = db.finishAiRun(db.createAiRun({ kind: 'dispute', label: 'd' }).id, {
      status: 'error',
      errorMessage: 'LLM call timed out',
    });
    expect(errored.status).toBe('error');
    expect(errored.errorMessage).toBe('LLM call timed out');
    expect(errored.finishedAt).not.toBeNull();

    expect(() => db.finishAiRun('nope', { status: 'done' })).toThrow(/unknown ai run/);
  });

  it('createAiStep assigns seq per run and round-trips fields', () => {
    const run = db.createAiRun({ kind: 'generation', refId: 'job-1', label: 'g' });
    const other = db.createAiRun({ kind: 'generation', refId: 'job-2', label: 'g2' });

    const s1 = db.createAiStep({
      runId: run.id,
      kind: 'llm',
      slug: 'generate',
      label: 'Author question',
      promptText: 'the masked prompt',
      withheldKeys: ['referenceSolution', 'interviewerPacket'],
    });
    expect(s1.runId).toBe(run.id);
    expect(s1.seq).toBe(1);
    expect(s1.kind).toBe('llm');
    expect(s1.slug).toBe('generate');
    expect(s1.label).toBe('Author question');
    expect(s1.status).toBe('running');
    expect(s1.attempt).toBe(1);
    expect(s1.promptText).toBe('the masked prompt');
    expect(s1.promptWithheld).toBe(false);
    expect(s1.responseText).toBeNull();
    expect(s1.withheldKeys).toEqual(['referenceSolution', 'interviewerPacket']);
    expect(s1.detail).toBeNull();
    expect(s1.errorMessage).toBeNull();
    expect(s1.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(s1.finishedAt).toBeNull();

    const s2 = db.createAiStep({
      runId: run.id,
      kind: 'sandbox',
      slug: 'verify',
      label: 'Verify tests',
      attempt: 2,
    });
    expect(s2.seq).toBe(2);
    expect(s2.attempt).toBe(2);
    expect(s2.promptText).toBeNull();
    expect(s2.withheldKeys).toBeNull();

    // seq is scoped per run, not global
    const sOther = db.createAiStep({ runId: other.id, kind: 'llm', slug: 'generate', label: 'x' });
    expect(sOther.seq).toBe(1);

    expect(db.getAiStep(s1.id)).toEqual(s1);
    expect(db.getAiStep('nope')).toBeNull();
    expect(() =>
      db.createAiStep({ runId: 'nope', kind: 'llm', slug: 'generate', label: 'x' }),
    ).toThrow(/unknown ai run/);
  });

  it('a fully withheld prompt stores promptWithheld with a null promptText', () => {
    const run = db.createAiRun({ kind: 'generation', label: 'g' });
    const step = db.createAiStep({
      runId: run.id,
      kind: 'llm',
      slug: 'edge-audit',
      label: 'Edge audit',
      promptText: null,
      promptWithheld: true,
    });
    expect(step.promptText).toBeNull();
    expect(step.promptWithheld).toBe(true);
  });

  it('appendAiStepResponse replaces the accumulated snapshot, idempotently', () => {
    const run = db.createAiRun({ kind: 'generation', label: 'g' });
    const step = db.createAiStep({ runId: run.id, kind: 'llm', slug: 'generate', label: 'x' });

    expect(db.appendAiStepResponse(step.id, 'partial').responseText).toBe('partial');
    expect(db.appendAiStepResponse(step.id, 'partial, now longer').responseText).toBe(
      'partial, now longer',
    );
    // re-flushing the same accumulated buffer is a no-op
    expect(db.appendAiStepResponse(step.id, 'partial, now longer').responseText).toBe(
      'partial, now longer',
    );
    expect(() => db.appendAiStepResponse('nope', 'x')).toThrow(/unknown ai step/);
  });

  it('caps oversized prompt/response text head-and-tail with an elision marker', () => {
    const cap = 64 * 1024;
    const big = 'a'.repeat(100_000);
    const run = db.createAiRun({ kind: 'generation', label: 'g' });

    const step = db.createAiStep({
      runId: run.id,
      kind: 'llm',
      slug: 'repair',
      label: 'Repair',
      promptText: big,
    });
    // head + tail survive around the marker; total stays near the cap
    expect(step.promptText!.length).toBeLessThan(cap + 100);
    expect(step.promptText!.startsWith('a'.repeat(1000))).toBe(true);
    expect(step.promptText!.endsWith('a'.repeat(1000))).toBe(true);
    expect(step.promptText).toContain(`… (${100_000 - cap} chars elided) …`);

    const flushed = db.appendAiStepResponse(step.id, big);
    expect(flushed.responseText).toContain('chars elided');
    expect(flushed.responseText!.length).toBeLessThan(cap + 100);

    // under-cap text is stored verbatim
    const small = db.createAiStep({
      runId: run.id,
      kind: 'llm',
      slug: 'generate',
      label: 'x',
      promptText: 'short prompt',
    });
    expect(small.promptText).toBe('short prompt');
  });

  it('finishAiStep sets a terminal status and preserves streamed response when omitted', () => {
    const run = db.createAiRun({ kind: 'generation', label: 'g' });
    const step = db.createAiStep({ runId: run.id, kind: 'sandbox', slug: 'verify', label: 'v' });
    db.appendAiStepResponse(step.id, 'streamed so far');

    const done = db.finishAiStep(step.id, { status: 'done', detail: '12/12 passed' });
    expect(done.status).toBe('done');
    expect(done.detail).toBe('12/12 passed');
    expect(done.responseText).toBe('streamed so far');
    expect(done.errorMessage).toBeNull();
    expect(done.finishedAt).not.toBeNull();

    const errored = db.finishAiStep(
      db.createAiStep({ runId: run.id, kind: 'llm', slug: 'repair', label: 'r' }).id,
      { status: 'error', errorMessage: 'boom', responseText: 'final salvage' },
    );
    expect(errored.status).toBe('error');
    expect(errored.errorMessage).toBe('boom');
    expect(errored.responseText).toBe('final salvage');

    const skipped = db.finishAiStep(
      db.createAiStep({ runId: run.id, kind: 'llm', slug: 'edge-audit', label: 'e' }).id,
      { status: 'skipped' },
    );
    expect(skipped.status).toBe('skipped');

    expect(() => db.finishAiStep('nope', { status: 'done' })).toThrow(/unknown ai step/);
  });

  it('listAiRuns returns newest first with limit/kind/refId filters', () => {
    const r1 = db.createAiRun({ kind: 'generation', refId: 'job-1', label: 'one' });
    const r2 = db.createAiRun({ kind: 'review', refId: 'rev-1', label: 'two' });
    // a retry of job-1: same ref_id, fresh run — per-retry history for free
    const r3 = db.createAiRun({ kind: 'generation', refId: 'job-1', label: 'three' });

    expect(db.listAiRuns().map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
    expect(db.listAiRuns({ limit: 2 }).map((r) => r.id)).toEqual([r3.id, r2.id]);
    expect(db.listAiRuns({ kind: 'generation' }).map((r) => r.id)).toEqual([r3.id, r1.id]);
    expect(db.listAiRuns({ refId: 'job-1' }).map((r) => r.id)).toEqual([r3.id, r1.id]);
    expect(db.listAiRuns({ kind: 'review', refId: 'rev-1' }).map((r) => r.id)).toEqual([r2.id]);
    expect(db.listAiRuns({ kind: 'review', refId: 'job-1' })).toEqual([]);
    expect(db.listAiRuns({ kind: 'generation', refId: 'job-1', limit: 1 }).map((r) => r.id)).toEqual(
      [r3.id],
    );
  });

  it('pruneAiRuns keeps the newest N and cascade-deletes their steps', () => {
    const runs = ['one', 'two', 'three', 'four', 'five'].map((label) => {
      const run = db.createAiRun({ kind: 'generation', label });
      const step = db.createAiStep({ runId: run.id, kind: 'llm', slug: 'generate', label });
      return { run, step };
    });

    expect(db.pruneAiRuns(2)).toBe(3);
    expect(db.listAiRuns().map((r) => r.id)).toEqual([runs[4].run.id, runs[3].run.id]);

    // ON DELETE CASCADE dropped the pruned runs' steps, kept the rest
    expect(db.getAiStep(runs[0].step.id)).toBeNull();
    expect(db.getAiStep(runs[1].step.id)).toBeNull();
    expect(db.getAiStep(runs[2].step.id)).toBeNull();
    expect(db.getAiStep(runs[3].step.id)).not.toBeNull();
    expect(db.getAiStep(runs[4].step.id)).not.toBeNull();

    // pruning again is a no-op
    expect(db.pruneAiRuns(2)).toBe(0);
    // and the default keep of 200 deletes nothing here
    expect(db.pruneAiRuns()).toBe(0);
    expect(db.listAiRuns()).toHaveLength(2);
  });
});

describe('sweepInterruptedGenerationState', () => {
  it('flips only non-terminal generation_jobs/brainstorm_sessions rows, preserving llm_done payload', () => {
    const running = db.createGenerationJob({ category: 'js-ts', difficulty: 'easy', topic: 'a' });

    const llmDoneSeed = db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'hard',
      topic: 'b',
    });
    const llmDone = db.patchGenerationJob(llmDoneSeed.id, {
      status: 'llm_done',
      title: 'Some Title',
      slug: 'some-slug',
      result: { slug: 'some-slug', title: 'Some Title', testCode: 'x'.repeat(500) },
    });

    const doneSeed = db.createGenerationJob({ category: 'js-ts', difficulty: 'easy', topic: 'c' });
    const q = makeQuestion({ slug: 'sweep-done' });
    const done = db.patchGenerationJob(doneSeed.id, { status: 'done', questionId: q.id });

    const erroredSeed = db.createGenerationJob({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'd',
    });
    const errored = db.patchGenerationJob(erroredSeed.id, {
      status: 'error',
      errorMessage: 'already errored',
    });

    const idleSession = db.createBrainstormSession('idle to start');
    db.setBrainstormStatus(idleSession.id, 'idle');

    const thinkingSession = db.createBrainstormSession('mid-generation when it crashed');

    const erroredSession = db.createBrainstormSession('already errored session');
    db.setBrainstormStatus(erroredSession.id, 'error', 'pre-existing error');

    db.sweepInterruptedGenerationState();

    const sweptRunning = db.getGenerationJob(running.id)!;
    expect(sweptRunning.status).toBe('error');
    expect(sweptRunning.errorMessage).toBe('interrupted by a server restart — retry');
    expect(sweptRunning.finishedAt).not.toBeNull();

    const sweptLlmDone = db.getGenerationJob(llmDone.id)!;
    expect(sweptLlmDone.status).toBe('error');
    expect(sweptLlmDone.errorMessage).toBe(
      'interrupted by a server restart — retry (no new LLM call)',
    );
    expect(sweptLlmDone.finishedAt).not.toBeNull();
    // llm_done payload survives so retry can be scaffold-only, no re-spend
    expect(sweptLlmDone.title).toBe('Some Title');
    expect(sweptLlmDone.slug).toBe('some-slug');
    expect(sweptLlmDone.result).toEqual(llmDone.result);

    // terminal rows untouched
    expect(db.getGenerationJob(done.id)).toEqual(done);
    expect(db.getGenerationJob(errored.id)).toEqual(errored);

    const sweptThinking = db.getBrainstormSession(thinkingSession.id)!;
    expect(sweptThinking.status).toBe('error');
    expect(sweptThinking.errorMessage).toBe('interrupted by a server restart');
    expect(sweptThinking.messages).toEqual(thinkingSession.messages);

    // idle / already-error sessions untouched
    const idleAfter = db.getBrainstormSession(idleSession.id)!;
    expect(idleAfter.status).toBe('idle');
    expect(idleAfter.errorMessage).toBeNull();

    const erroredSessionAfter = db.getBrainstormSession(erroredSession.id)!;
    expect(erroredSessionAfter.status).toBe('error');
    expect(erroredSessionAfter.errorMessage).toBe('pre-existing error');
  });

  it('flips running ai runs/steps to error, leaving terminal rows untouched', () => {
    const interrupted = db.createAiRun({ kind: 'generation', refId: 'job-1', label: 'mid-run' });
    const runningStep = db.createAiStep({
      runId: interrupted.id,
      kind: 'llm',
      slug: 'generate',
      label: 'Author question',
    });
    const doneStep = db.createAiStep({
      runId: interrupted.id,
      kind: 'sandbox',
      slug: 'verify',
      label: 'Verify tests',
    });
    db.finishAiStep(doneStep.id, { status: 'done', detail: '5/5 passed' });

    const finishedSeed = db.createAiRun({ kind: 'review', label: 'already finished' });
    const finishedStep = db.createAiStep({
      runId: finishedSeed.id,
      kind: 'llm',
      slug: 'review',
      label: 'Review',
    });
    const terminalStep = db.finishAiStep(finishedStep.id, { status: 'done' });
    const finished = db.finishAiRun(finishedSeed.id, { status: 'done' });

    db.sweepInterruptedGenerationState();

    const sweptRun = db.getAiRun(interrupted.id)!;
    expect(sweptRun.status).toBe('error');
    expect(sweptRun.errorMessage).toBe('interrupted by a server restart');
    expect(sweptRun.finishedAt).not.toBeNull();

    const sweptStep = db.getAiStep(runningStep.id)!;
    expect(sweptStep.status).toBe('error');
    expect(sweptStep.errorMessage).toBe('interrupted by a server restart');
    expect(sweptStep.finishedAt).not.toBeNull();

    // terminal rows untouched, even inside the swept run
    const doneStepAfter = db.getAiStep(doneStep.id)!;
    expect(doneStepAfter.status).toBe('done');
    expect(doneStepAfter.detail).toBe('5/5 passed');
    expect(doneStepAfter.errorMessage).toBeNull();

    expect(db.getAiRun(finished.id)).toEqual(finished);
    expect(db.getAiStep(terminalStep.id)).toEqual(terminalStep);
  });
});
