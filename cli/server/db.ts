import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AceDb,
  AttemptEndReason,
  AttemptEventRow,
  AttemptEventType,
  AttemptRow,
  Difficulty,
  QuestionRow,
  QuestionSource,
  QuestionStats,
  QuestionStatus,
  QuestionWithStats,
  ReviewRow,
  TestCaseResult,
  TestRunRow,
  TestRunStatus,
  TestRunSummary,
  TestRunTrigger,
} from './types.js';
import { nowIso, uuidv7 } from './ids.js';
import { MIGRATIONS } from './migrations.js';

const SCHEMA_VERSION_KEY = 'schema_version';

// node:sqlite returns rows as null-prototype objects; values are
// string | number | null for our schema.
type SqlRow = Record<string, string | number | null>;

function rowToQuestion(r: SqlRow): QuestionRow {
  return {
    id: r.id as string,
    category: r.category as string,
    slug: r.slug as string,
    title: r.title as string,
    difficulty: r.difficulty as Difficulty,
    suggestedMinutes: r.suggested_minutes as number,
    dirPath: r.dir_path as string,
    source: r.source as QuestionSource,
    createdAt: r.created_at as string,
    archivedAt: (r.archived_at as string | null) ?? null,
    missingAt: (r.missing_at as string | null) ?? null,
  };
}

function rowToAttempt(r: SqlRow): AttemptRow {
  return {
    id: r.id as string,
    questionId: r.question_id as string,
    number: r.number as number,
    startedAt: r.started_at as string,
    endedAt: (r.ended_at as string | null) ?? null,
    endReason: (r.end_reason as AttemptEndReason | null) ?? null,
    activeSeconds: r.active_seconds as number,
    hintsUsed: r.hints_used as number,
    imported: r.imported === 1,
  };
}

function rowToAttemptEvent(r: SqlRow): AttemptEventRow {
  return {
    id: r.id as string,
    attemptId: r.attempt_id as string,
    at: r.at as string,
    type: r.type as AttemptEventType,
    payload:
      r.payload_json == null
        ? null
        : (JSON.parse(r.payload_json as string) as Record<string, unknown>),
  };
}

function rowToTestRun(r: SqlRow): TestRunRow {
  return {
    id: r.id as string,
    attemptId: (r.attempt_id as string | null) ?? null,
    questionId: r.question_id as string,
    at: r.at as string,
    trigger: r.trigger as TestRunTrigger,
    status: r.status as TestRunStatus,
    total: (r.total as number | null) ?? null,
    passed: (r.passed as number | null) ?? null,
    failed: (r.failed as number | null) ?? null,
    skipped: (r.skipped as number | null) ?? null,
    durationMs: (r.duration_ms as number | null) ?? null,
    results:
      r.results_json == null
        ? null
        : (JSON.parse(r.results_json as string) as TestCaseResult[]),
    stdout: (r.stdout_text as string | null) ?? null,
    stderr: (r.stderr_text as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
  };
}

function rowToReview(r: SqlRow): ReviewRow {
  return {
    id: r.id as string,
    questionId: r.question_id as string,
    attemptId: (r.attempt_id as string | null) ?? null,
    version: r.version as number,
    at: r.at as string,
    model: (r.model as string | null) ?? null,
    verdict: (r.verdict as string | null) ?? null,
    dimensions:
      r.dimensions_json == null
        ? null
        : (JSON.parse(r.dimensions_json as string) as Record<string, number>),
    bodyMd: r.body_md as string,
    source: r.source as 'user' | 'import',
  };
}

function runMigrations(db: DatabaseSync): void {
  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  let version = 0;
  if (hasMeta) {
    const row = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(SCHEMA_VERSION_KEY) as SqlRow | undefined;
    if (row) version = Number(row.value);
  }
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      ).run(SCHEMA_VERSION_KEY, String(i + 1));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

class SqliteAceDb implements AceDb {
  readonly workspaceRoot: string;
  private db: DatabaseSync;

  constructor(workspaceRoot: string, db: DatabaseSync) {
    this.workspaceRoot = workspaceRoot;
    this.db = db;
  }

  // -- questions ------------------------------------------------------------

  listQuestions(): QuestionWithStats[] {
    const latestDone =
      "SELECT t.%COL% FROM test_runs t WHERE t.question_id = q.id AND t.status = 'done' " +
      'ORDER BY t.at DESC, t.id DESC LIMIT 1';
    const rows = this.db
      .prepare(
        `SELECT q.*,
          (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id) AS attempt_count,
          EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.imported = 1) AS has_imported,
          (SELECT MAX(a.started_at) FROM attempts a WHERE a.question_id = q.id) AS last_attempt_at,
          (${latestDone.replace('%COL%', 'passed')}) AS last_done_passed,
          (${latestDone.replace('%COL%', 'total')}) AS last_done_total,
          (${latestDone.replace('%COL%', 'at')}) AS last_done_at,
          (SELECT MAX(t.at) FROM test_runs t WHERE t.question_id = q.id) AS last_run_at
        FROM questions q
        ORDER BY q.category, q.slug`,
      )
      .all() as SqlRow[];

    return rows.map((r) => {
      const attemptCount = r.attempt_count as number;
      const lastRun =
        r.last_done_at != null
          ? {
              passed: (r.last_done_passed as number | null) ?? 0,
              total: (r.last_done_total as number | null) ?? 0,
              at: r.last_done_at as string,
            }
          : null;
      let status: QuestionStatus = 'not-started';
      if (lastRun && lastRun.total > 0 && lastRun.passed === lastRun.total) {
        status = 'green';
      } else if (attemptCount > 0) {
        status = 'in-progress';
      }
      const lastAttemptAt = r.last_attempt_at as string | null;
      const lastRunAt = r.last_run_at as string | null;
      let lastActivityAt: string | null = lastAttemptAt;
      if (lastRunAt != null && (lastActivityAt == null || lastRunAt > lastActivityAt)) {
        lastActivityAt = lastRunAt;
      }
      const stats: QuestionStats = {
        attemptCount,
        lastRun,
        lastActivityAt,
        status,
        imported: r.has_imported === 1,
      };
      return { ...rowToQuestion(r), stats };
    });
  }

  getQuestionById(id: string): QuestionRow | null {
    const r = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return r ? rowToQuestion(r) : null;
  }

  getQuestion(category: string, slug: string): QuestionRow | null {
    const r = this.db
      .prepare('SELECT * FROM questions WHERE category = ? AND slug = ?')
      .get(category, slug) as SqlRow | undefined;
    return r ? rowToQuestion(r) : null;
  }

  upsertQuestion(q: {
    category: string;
    slug: string;
    title: string;
    difficulty: Difficulty;
    suggestedMinutes: number;
    dirPath: string;
    source: QuestionSource;
  }): QuestionRow {
    // source is set on insert only — provenance never flips on a rescan
    this.db
      .prepare(
        `INSERT INTO questions
          (id, category, slug, title, difficulty, suggested_minutes, dir_path, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (category, slug) DO UPDATE SET
           title = excluded.title,
           difficulty = excluded.difficulty,
           suggested_minutes = excluded.suggested_minutes,
           dir_path = excluded.dir_path`,
      )
      .run(
        uuidv7(),
        q.category,
        q.slug,
        q.title,
        q.difficulty,
        q.suggestedMinutes,
        q.dirPath,
        q.source,
        nowIso(),
      );
    const row = this.getQuestion(q.category, q.slug);
    if (!row) throw new Error(`upsertQuestion failed for ${q.category}/${q.slug}`);
    return row;
  }

  setMissing(presentIds: string[], missingIds: string[]): void {
    const clear = this.db.prepare(
      'UPDATE questions SET missing_at = NULL WHERE id = ? AND missing_at IS NOT NULL',
    );
    const mark = this.db.prepare(
      'UPDATE questions SET missing_at = ? WHERE id = ? AND missing_at IS NULL',
    );
    this.db.exec('BEGIN');
    try {
      const now = nowIso();
      for (const id of presentIds) clear.run(id);
      for (const id of missingIds) mark.run(now, id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // -- attempts -------------------------------------------------------------

  getActiveAttempt(questionId: string): AttemptRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM attempts WHERE question_id = ? AND ended_at IS NULL
         ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(questionId) as SqlRow | undefined;
    return r ? rowToAttempt(r) : null;
  }

  getLatestActiveAttempt(): { attempt: AttemptRow; question: QuestionRow } | null {
    const r = this.db
      .prepare(
        `SELECT a.* FROM attempts a WHERE a.ended_at IS NULL
         ORDER BY a.started_at DESC, a.id DESC LIMIT 1`,
      )
      .get() as SqlRow | undefined;
    if (!r) return null;
    const attempt = rowToAttempt(r);
    const question = this.getQuestionById(attempt.questionId);
    if (!question) return null;
    return { attempt, question };
  }

  createAttempt(
    questionId: string,
    opts?: { imported?: boolean; startedAt?: string },
  ): AttemptRow {
    const question = this.getQuestionById(questionId);
    if (!question) throw new Error(`unknown question: ${questionId}`);

    // Imported (historical) attempts must never touch the live attempt.
    if (!opts?.imported) {
      const active = this.getActiveAttempt(questionId);
      if (active) {
        this.patchAttempt(active.id, { end: { reason: 'superseded' } });
      }
    }

    const countRow = this.db
      .prepare('SELECT COUNT(*) AS n FROM attempts WHERE question_id = ?')
      .get(questionId) as SqlRow;
    const number = (countRow.n as number) + 1;

    const id = uuidv7();
    this.db
      .prepare(
        `INSERT INTO attempts (id, question_id, number, started_at, imported)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, questionId, number, opts?.startedAt ?? nowIso(), opts?.imported ? 1 : 0);
    const row = this.getAttempt(id);
    if (!row) throw new Error(`createAttempt failed for question ${questionId}`);
    return row;
  }

  getAttempt(id: string): AttemptRow | null {
    const r = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return r ? rowToAttempt(r) : null;
  }

  patchAttempt(
    id: string,
    patch: { activeSecondsDelta?: number; end?: { reason: AttemptEndReason } },
  ): AttemptRow {
    const existing = this.getAttempt(id);
    if (!existing) throw new Error(`unknown attempt: ${id}`);
    if (patch.activeSecondsDelta) {
      this.db
        .prepare('UPDATE attempts SET active_seconds = active_seconds + ? WHERE id = ?')
        .run(patch.activeSecondsDelta, id);
    }
    // ending is one-way: an already-ended attempt keeps its first end
    if (patch.end && existing.endedAt == null) {
      this.db
        .prepare('UPDATE attempts SET ended_at = ?, end_reason = ? WHERE id = ?')
        .run(nowIso(), patch.end.reason, id);
    }
    const row = this.getAttempt(id);
    if (!row) throw new Error(`unknown attempt: ${id}`);
    return row;
  }

  addAttemptEvent(
    attemptId: string,
    type: AttemptEventType,
    payload?: Record<string, unknown>,
  ): AttemptEventRow {
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new Error(`unknown attempt: ${attemptId}`);

    if (type === 'first_edit' || type === 'all_green') {
      const existing = this.db
        .prepare(
          `SELECT * FROM attempt_events WHERE attempt_id = ? AND type = ?
           ORDER BY at ASC, id ASC LIMIT 1`,
        )
        .get(attemptId, type) as SqlRow | undefined;
      if (existing) return rowToAttemptEvent(existing);
    }

    const id = uuidv7();
    this.db
      .prepare(
        'INSERT INTO attempt_events (id, attempt_id, at, type, payload_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, attemptId, nowIso(), type, payload ? JSON.stringify(payload) : null);
    const r = this.db.prepare('SELECT * FROM attempt_events WHERE id = ?').get(id) as SqlRow;
    return rowToAttemptEvent(r);
  }

  hasAttemptEvent(attemptId: string, type: AttemptEventType): boolean {
    const r = this.db
      .prepare('SELECT 1 AS one FROM attempt_events WHERE attempt_id = ? AND type = ? LIMIT 1')
      .get(attemptId, type);
    return r != null;
  }

  listAttemptEvents(attemptId: string): AttemptEventRow[] {
    const rows = this.db
      .prepare('SELECT * FROM attempt_events WHERE attempt_id = ? ORDER BY at ASC, id ASC')
      .all(attemptId) as SqlRow[];
    return rows.map(rowToAttemptEvent);
  }

  // -- test runs ------------------------------------------------------------

  createTestRun(r: {
    questionId: string;
    attemptId: string | null;
    trigger: TestRunTrigger;
  }): TestRunRow {
    const id = uuidv7();
    this.db
      .prepare(
        `INSERT INTO test_runs (id, attempt_id, question_id, at, "trigger", status)
         VALUES (?, ?, ?, ?, ?, 'running')`,
      )
      .run(id, r.attemptId, r.questionId, nowIso(), r.trigger);
    const row = this.getTestRun(id);
    if (!row) throw new Error(`createTestRun failed for question ${r.questionId}`);
    return row;
  }

  finishTestRun(
    id: string,
    patch: {
      status: TestRunStatus;
      summary?: TestRunSummary;
      results?: TestCaseResult[];
      stdout?: string;
      stderr?: string;
      errorMessage?: string;
    },
  ): TestRunRow {
    const existing = this.getTestRun(id);
    if (!existing) throw new Error(`unknown test run: ${id}`);
    this.db
      .prepare(
        `UPDATE test_runs SET
           status = ?,
           total = ?, passed = ?, failed = ?, skipped = ?, duration_ms = ?,
           results_json = ?, stdout_text = ?, stderr_text = ?, error_message = ?
         WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.summary?.total ?? null,
        patch.summary?.passed ?? null,
        patch.summary?.failed ?? null,
        patch.summary?.skipped ?? null,
        patch.summary?.durationMs ?? null,
        patch.results ? JSON.stringify(patch.results) : null,
        patch.stdout ?? null,
        patch.stderr ?? null,
        patch.errorMessage ?? null,
        id,
      );
    const row = this.getTestRun(id);
    if (!row) throw new Error(`unknown test run: ${id}`);
    return row;
  }

  getTestRun(id: string): TestRunRow | null {
    const r = this.db.prepare('SELECT * FROM test_runs WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return r ? rowToTestRun(r) : null;
  }

  listTestRuns(questionId: string, limit = 50): TestRunRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM test_runs WHERE question_id = ?
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(questionId, limit) as SqlRow[];
    return rows.map(rowToTestRun);
  }

  getLatestTestRun(questionId: string): TestRunRow | null {
    const runs = this.listTestRuns(questionId, 1);
    return runs.length > 0 ? runs[0] : null;
  }

  // -- reviews --------------------------------------------------------------

  createReview(r: {
    questionId: string;
    attemptId: string | null;
    bodyMd: string;
    verdict?: string | null;
    model?: string | null;
    source: 'user' | 'import';
    at?: string;
  }): ReviewRow {
    const versionRow = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM reviews WHERE question_id = ?')
      .get(r.questionId) as SqlRow;
    const version = (versionRow.v as number) + 1;
    const id = uuidv7();
    this.db
      .prepare(
        `INSERT INTO reviews (id, question_id, attempt_id, version, at, model, verdict, body_md, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.questionId,
        r.attemptId,
        version,
        r.at ?? nowIso(),
        r.model ?? null,
        r.verdict ?? null,
        r.bodyMd,
        r.source,
      );
    const row = this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as SqlRow;
    return rowToReview(row);
  }

  // -- meta -----------------------------------------------------------------

  transaction<T>(fn: () => T): T {
    // Non-nested: SQLite has no nested BEGIN; callers must not nest these.
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | SqlRow
      | undefined;
    return r ? (r.value as string) : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

export function openDb(workspaceRoot: string): AceDb {
  const aceDir = path.join(workspaceRoot, '.ace');
  fs.mkdirSync(path.join(aceDir, 'tmp'), { recursive: true });
  const db = new DatabaseSync(path.join(aceDir, 'ace.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  runMigrations(db);
  return new SqliteAceDb(workspaceRoot, db);
}
