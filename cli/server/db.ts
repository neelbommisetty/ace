import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AceDb,
  AttemptEndReason,
  AttemptEventRow,
  AttemptEventType,
  AttemptRow,
  BrainstormSessionRow,
  BrainstormSessionStatus,
  BrainstormTurn,
  Difficulty,
  DisputeRow,
  DisputeVerdict,
  GenerationJobRow,
  GenerationJobStatus,
  HistoryItem,
  QuestionRow,
  QuestionSource,
  QuestionStats,
  QuestionStatus,
  QuestionWithStats,
  ReviewRow,
  SnapshotRow,
  SnapshotTrigger,
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
    score: (r.score as number | null) ?? null,
    dimensions:
      r.dimensions_json == null
        ? null
        : (JSON.parse(r.dimensions_json as string) as Record<string, number>),
    bodyMd: r.body_md as string,
    snapshotHash: (r.snapshot_hash as string | null) ?? null,
    source: r.source as 'user' | 'import',
  };
}

function rowToDispute(r: SqlRow): DisputeRow {
  return {
    id: r.id as string,
    questionId: r.question_id as string,
    attemptId: (r.attempt_id as string | null) ?? null,
    testRunId: r.test_run_id as string,
    at: r.at as string,
    argument: (r.argument as string | null) ?? null,
    verdict: r.verdict as DisputeVerdict,
    summary: r.summary as string,
    detailsMd: r.details_md as string,
    fixedTestCode: (r.fixed_test_code as string | null) ?? null,
    testRelPath: r.test_rel_path as string,
    hint: (r.hint as string | null) ?? null,
    appliedAt: (r.applied_at as string | null) ?? null,
  };
}

function rowToSnapshot(r: SqlRow): SnapshotRow {
  return {
    id: r.id as string,
    questionId: r.question_id as string,
    attemptId: (r.attempt_id as string | null) ?? null,
    relPath: r.rel_path as string,
    hash: r.hash as string,
    at: r.at as string,
    trigger: r.trigger as SnapshotTrigger,
  };
}

function rowToGenerationJob(r: SqlRow): GenerationJobRow {
  return {
    id: r.id as string,
    status: r.status as GenerationJobStatus,
    category: r.category as string,
    difficulty: r.difficulty as Difficulty,
    topic: r.topic as string,
    brainstormSessionId: (r.brainstorm_session_id as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    slug: (r.slug as string | null) ?? null,
    result:
      r.result_json == null
        ? null
        : (JSON.parse(r.result_json as string) as Record<string, unknown>),
    rawText: (r.raw_text as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    questionId: (r.question_id as string | null) ?? null,
    createdAt: r.created_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

function rowToBrainstormSession(r: SqlRow): BrainstormSessionRow {
  return {
    id: r.id as string,
    status: r.status as BrainstormSessionStatus,
    title: r.title as string,
    messages: JSON.parse(r.messages_json as string) as BrainstormTurn[],
    errorMessage: (r.error_message as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

const BRAINSTORM_TITLE_MAX = 80;

/** Collapses whitespace and truncates to `BRAINSTORM_TITLE_MAX` chars with an ellipsis. */
function truncateBrainstormTitle(message: string): string {
  const collapsed = message.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= BRAINSTORM_TITLE_MAX) return collapsed;
  // Truncate on code points (not UTF-16 code units) so we never split a
  // surrogate pair, which node:sqlite would otherwise persist as U+FFFD.
  const codePoints = [...collapsed];
  return `${codePoints.slice(0, BRAINSTORM_TITLE_MAX - 1).join('').trimEnd()}…`;
}

/**
 * Turns raw user input into a safe FTS5 MATCH expression: each
 * whitespace-separated term becomes a quoted phrase (embedded double quotes
 * doubled), so operators like AND/OR/NEAR are matched literally, never parsed.
 * Terms are implicitly ANDed. Returns '' when no terms survive.
 */
function toFtsMatchQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' ');
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
  private ftsAvailable: boolean;

  constructor(workspaceRoot: string, db: DatabaseSync, ftsAvailable: boolean) {
    this.workspaceRoot = workspaceRoot;
    this.db = db;
    this.ftsAvailable = ftsAvailable;
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
    score?: number | null;
    dimensions?: Record<string, number> | null;
    snapshotHash?: string | null;
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
        `INSERT INTO reviews
          (id, question_id, attempt_id, version, at, model, verdict, score,
           dimensions_json, body_md, snapshot_hash, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.questionId,
        r.attemptId,
        version,
        r.at ?? nowIso(),
        r.model ?? null,
        r.verdict ?? null,
        r.score ?? null,
        r.dimensions ? JSON.stringify(r.dimensions) : null,
        r.bodyMd,
        r.snapshotHash ?? null,
        r.source,
      );
    if (this.ftsAvailable) {
      // Kept in sync on insert only (reviews are immutable); a boot-time count
      // check rebuilds the index if this ever drifts.
      this.db
        .prepare('INSERT INTO reviews_fts (review_id, body_md) VALUES (?, ?)')
        .run(id, r.bodyMd);
    }
    const row = this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as SqlRow;
    return rowToReview(row);
  }

  getReview(id: string): ReviewRow | null {
    const r = this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return r ? rowToReview(r) : null;
  }

  listReviews(questionId: string): ReviewRow[] {
    const rows = this.db
      .prepare('SELECT * FROM reviews WHERE question_id = ? ORDER BY version DESC')
      .all(questionId) as SqlRow[];
    return rows.map(rowToReview);
  }

  // -- disputes -------------------------------------------------------------

  createDispute(d: {
    questionId: string;
    attemptId: string | null;
    testRunId: string;
    argument: string | null;
    verdict: DisputeVerdict;
    summary: string;
    detailsMd: string;
    fixedTestCode: string | null;
    testRelPath: string;
    hint: string | null;
  }): DisputeRow {
    const id = uuidv7();
    this.db
      .prepare(
        `INSERT INTO disputes
          (id, question_id, attempt_id, test_run_id, at, argument, verdict,
           summary, details_md, fixed_test_code, test_rel_path, hint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        d.questionId,
        d.attemptId,
        d.testRunId,
        nowIso(),
        d.argument,
        d.verdict,
        d.summary,
        d.detailsMd,
        d.fixedTestCode,
        d.testRelPath,
        d.hint,
      );
    const row = this.getDispute(id);
    if (!row) throw new Error(`createDispute failed for question ${d.questionId}`);
    return row;
  }

  getDispute(id: string): DisputeRow | null {
    const r = this.db.prepare('SELECT * FROM disputes WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return r ? rowToDispute(r) : null;
  }

  listDisputes(questionId: string): DisputeRow[] {
    const rows = this.db
      .prepare('SELECT * FROM disputes WHERE question_id = ? ORDER BY at DESC, id DESC')
      .all(questionId) as SqlRow[];
    return rows.map(rowToDispute);
  }

  markDisputeApplied(id: string): DisputeRow {
    const existing = this.getDispute(id);
    if (!existing) throw new Error(`unknown dispute: ${id}`);
    // applying is one-way: the first applied_at sticks
    if (existing.appliedAt == null) {
      this.db.prepare('UPDATE disputes SET applied_at = ? WHERE id = ?').run(nowIso(), id);
    }
    const row = this.getDispute(id);
    if (!row) throw new Error(`unknown dispute: ${id}`);
    return row;
  }

  // -- snapshots ------------------------------------------------------------

  addSnapshot(s: {
    questionId: string;
    attemptId: string | null;
    relPath: string;
    hash: string;
    trigger: SnapshotTrigger;
  }): SnapshotRow {
    const id = uuidv7();
    this.db
      .prepare(
        `INSERT INTO snapshots (id, question_id, attempt_id, rel_path, hash, at, "trigger")
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, s.questionId, s.attemptId, s.relPath, s.hash, nowIso(), s.trigger);
    const r = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as SqlRow;
    return rowToSnapshot(r);
  }

  getLatestSnapshot(
    questionId: string,
    relPath: string,
    trigger?: SnapshotTrigger,
  ): SnapshotRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM snapshots WHERE question_id = ? AND rel_path = ?
         ${trigger ? 'AND "trigger" = ?' : ''}
         ORDER BY at DESC, id DESC LIMIT 1`,
      )
      .get(...(trigger ? [questionId, relPath, trigger] : [questionId, relPath])) as
      | SqlRow
      | undefined;
    return r ? rowToSnapshot(r) : null;
  }

  getFirstSnapshot(
    questionId: string,
    relPath: string,
    trigger?: SnapshotTrigger,
  ): SnapshotRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM snapshots WHERE question_id = ? AND rel_path = ?
         ${trigger ? 'AND "trigger" = ?' : ''}
         ORDER BY at ASC, id ASC LIMIT 1`,
      )
      .get(...(trigger ? [questionId, relPath, trigger] : [questionId, relPath])) as
      | SqlRow
      | undefined;
    return r ? rowToSnapshot(r) : null;
  }

  // -- generation jobs --------------------------------------------------------

  createGenerationJob(j: {
    category: string;
    difficulty: Difficulty;
    topic: string;
    brainstormSessionId?: string | null;
  }): GenerationJobRow {
    const id = uuidv7();
    this.db
      .prepare(
        `INSERT INTO generation_jobs
          (id, status, category, difficulty, topic, brainstorm_session_id, created_at)
         VALUES (?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(id, j.category, j.difficulty, j.topic, j.brainstormSessionId ?? null, nowIso());
    const row = this.getGenerationJob(id);
    if (!row) throw new Error(`createGenerationJob failed for ${j.category}`);
    return row;
  }

  patchGenerationJob(
    id: string,
    patch: {
      status?: GenerationJobStatus;
      title?: string | null;
      slug?: string | null;
      result?: Record<string, unknown> | null;
      rawText?: string | null;
      errorMessage?: string | null;
      questionId?: string | null;
    },
  ): GenerationJobRow {
    const existing = this.getGenerationJob(id);
    if (!existing) throw new Error(`unknown generation job: ${id}`);
    if (existing.status === 'done') {
      throw new Error(`generation job ${id} is done and cannot be patched further`);
    }

    const status = patch.status ?? existing.status;
    const title = patch.title !== undefined ? patch.title : existing.title;
    const slug = patch.slug !== undefined ? patch.slug : existing.slug;
    const result = patch.result !== undefined ? patch.result : existing.result;
    const rawText = patch.rawText !== undefined ? patch.rawText : existing.rawText;
    const errorMessage =
      patch.errorMessage !== undefined ? patch.errorMessage : existing.errorMessage;
    const questionId = patch.questionId !== undefined ? patch.questionId : existing.questionId;
    // finished_at is stamped only when the resulting status is terminal
    // ('done' | 'error'); any other status (including a retry moving an
    // 'error' row back to 'running') leaves it null.
    const finishedAt = status === 'done' || status === 'error' ? nowIso() : null;

    this.db
      .prepare(
        `UPDATE generation_jobs SET
           status = ?, title = ?, slug = ?, result_json = ?, raw_text = ?,
           error_message = ?, question_id = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        title,
        slug,
        result != null ? JSON.stringify(result) : null,
        rawText,
        errorMessage,
        questionId,
        finishedAt,
        id,
      );
    const row = this.getGenerationJob(id);
    if (!row) throw new Error(`unknown generation job: ${id}`);
    return row;
  }

  getGenerationJob(id: string): GenerationJobRow | null {
    const r = this.db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return r ? rowToGenerationJob(r) : null;
  }

  listGenerationJobs(limit = 20): GenerationJobRow[] {
    const rows = this.db
      .prepare('SELECT * FROM generation_jobs ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as SqlRow[];
    return rows.map(rowToGenerationJob);
  }

  setQuestionSource(id: string, source: QuestionSource): void {
    this.db.prepare('UPDATE questions SET source = ? WHERE id = ?').run(source, id);
  }

  // -- brainstorm sessions ----------------------------------------------------

  createBrainstormSession(firstMessage: string): BrainstormSessionRow {
    const id = uuidv7();
    const now = nowIso();
    const messages: BrainstormTurn[] = [{ role: 'user', content: firstMessage }];
    this.db
      .prepare(
        `INSERT INTO brainstorm_sessions
          (id, status, title, messages_json, created_at, updated_at)
         VALUES (?, 'thinking', ?, ?, ?, ?)`,
      )
      .run(id, truncateBrainstormTitle(firstMessage), JSON.stringify(messages), now, now);
    const row = this.getBrainstormSession(id);
    if (!row) throw new Error(`createBrainstormSession failed`);
    return row;
  }

  getBrainstormSession(id: string): BrainstormSessionRow | null {
    const r = this.db.prepare('SELECT * FROM brainstorm_sessions WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return r ? rowToBrainstormSession(r) : null;
  }

  listBrainstormSessions(limit = 20): BrainstormSessionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM brainstorm_sessions ORDER BY updated_at DESC, id DESC LIMIT ?')
      .all(limit) as SqlRow[];
    return rows.map(rowToBrainstormSession);
  }

  appendBrainstormTurn(
    id: string,
    turn: BrainstormTurn,
    status: BrainstormSessionStatus,
  ): BrainstormSessionRow {
    return this.transaction(() => {
      const existing = this.getBrainstormSession(id);
      if (!existing) throw new Error(`unknown brainstorm session: ${id}`);
      const messages = [...existing.messages, turn];
      // A new turn is always forward progress away from a bare error state
      // (retrying re-enters via 'thinking', succeeding lands on 'idle'), so
      // clear any stale error_message left over from a previous failed turn
      // — otherwise a healthy 'idle' session can keep reporting a resolved
      // error forever.
      this.db
        .prepare(
          `UPDATE brainstorm_sessions SET messages_json = ?, status = ?, error_message = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(messages), status, nowIso(), id);
      const row = this.getBrainstormSession(id);
      if (!row) throw new Error(`unknown brainstorm session: ${id}`);
      return row;
    });
  }

  setBrainstormStatus(
    id: string,
    status: BrainstormSessionStatus,
    errorMessage: string | null = null,
  ): BrainstormSessionRow {
    const existing = this.getBrainstormSession(id);
    if (!existing) throw new Error(`unknown brainstorm session: ${id}`);
    this.db
      .prepare('UPDATE brainstorm_sessions SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
      .run(status, errorMessage, nowIso(), id);
    const row = this.getBrainstormSession(id);
    if (!row) throw new Error(`unknown brainstorm session: ${id}`);
    return row;
  }

  // -- interrupted-state sweep ------------------------------------------------

  sweepInterruptedGenerationState(): void {
    this.transaction(() => {
      const now = nowIso();
      this.db
        .prepare(
          `UPDATE generation_jobs SET status = 'error', error_message = ?, finished_at = ?
           WHERE status = 'running'`,
        )
        .run('interrupted by a server restart — retry', now);
      this.db
        .prepare(
          `UPDATE generation_jobs SET status = 'error', error_message = ?, finished_at = ?
           WHERE status = 'llm_done'`,
        )
        .run('interrupted by a server restart — retry (no new LLM call)', now);
      this.db
        .prepare(
          `UPDATE brainstorm_sessions SET status = 'error', error_message = ?, updated_at = ?
           WHERE status = 'thinking'`,
        )
        .run('interrupted by a server restart', now);
    });
  }

  // -- history search -------------------------------------------------------

  searchHistory(opts: {
    q?: string;
    category?: string;
    type?: 'review' | 'dispute';
    questionId?: string;
    limit?: number;
  }): HistoryItem[] {
    const q = (opts.q ?? '').trim();
    const limit = opts.limit ?? 100;

    const questionCache = new Map<string, QuestionRow | null>();
    const questionFor = (id: string): QuestionRow | null => {
      let question = questionCache.get(id);
      if (question === undefined) {
        question = this.getQuestionById(id);
        questionCache.set(id, question);
      }
      return question;
    };

    const items: HistoryItem[] = [];
    if (opts.type !== 'dispute') {
      for (const review of this.searchReviews(q)) {
        if (opts.questionId && review.questionId !== opts.questionId) continue;
        const question = questionFor(review.questionId);
        if (!question) continue;
        if (opts.category && question.category !== opts.category) continue;
        items.push({ type: 'review', at: review.at, question, review });
      }
    }
    if (opts.type !== 'review') {
      for (const dispute of this.searchDisputes(q)) {
        if (opts.questionId && dispute.questionId !== opts.questionId) continue;
        const question = questionFor(dispute.questionId);
        if (!question) continue;
        if (opts.category && question.category !== opts.category) continue;
        items.push({ type: 'dispute', at: dispute.at, question, dispute });
      }
    }

    // Newest first; uuidv7 ids break same-millisecond ties by creation order.
    items.sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? 1 : -1;
      const aId = a.type === 'review' ? a.review.id : a.dispute.id;
      const bId = b.type === 'review' ? b.review.id : b.dispute.id;
      return aId < bId ? 1 : aId > bId ? -1 : 0;
    });
    return items.slice(0, limit);
  }

  private searchReviews(q: string): ReviewRow[] {
    if (q === '') {
      const rows = this.db
        .prepare('SELECT * FROM reviews ORDER BY at DESC, id DESC')
        .all() as SqlRow[];
      return rows.map(rowToReview);
    }
    if (this.ftsAvailable) {
      const match = toFtsMatchQuery(q);
      if (match !== '') {
        try {
          const rows = this.db
            .prepare(
              `SELECT * FROM reviews
               WHERE id IN (SELECT review_id FROM reviews_fts WHERE reviews_fts MATCH ?)
               ORDER BY at DESC, id DESC`,
            )
            .all(match) as SqlRow[];
          return rows.map(rowToReview);
        } catch {
          // hostile input the term-quoting couldn't neutralize — LIKE fallback
        }
      }
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM reviews WHERE body_md LIKE ? COLLATE NOCASE
         ORDER BY at DESC, id DESC`,
      )
      .all(`%${q}%`) as SqlRow[];
    return rows.map(rowToReview);
  }

  private searchDisputes(q: string): DisputeRow[] {
    if (q === '') {
      const rows = this.db
        .prepare('SELECT * FROM disputes ORDER BY at DESC, id DESC')
        .all() as SqlRow[];
      return rows.map(rowToDispute);
    }
    const pattern = `%${q}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM disputes
         WHERE summary LIKE ? COLLATE NOCASE OR details_md LIKE ? COLLATE NOCASE
         ORDER BY at DESC, id DESC`,
      )
      .all(pattern, pattern) as SqlRow[];
    return rows.map(rowToDispute);
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

/**
 * reviews_fts is created outside numbered migrations so node:sqlite builds
 * without FTS5 keep working (search falls back to LIKE). When available, a
 * count mismatch with reviews (rows written by an FTS-less build, or a fresh
 * virtual table) triggers a full rebuild. Returns whether FTS is usable.
 */
function ensureReviewsFts(db: DatabaseSync): boolean {
  try {
    db.exec(
      'CREATE VIRTUAL TABLE IF NOT EXISTS reviews_fts USING fts5(review_id UNINDEXED, body_md)',
    );
    const reviews = db.prepare('SELECT COUNT(*) AS n FROM reviews').get() as SqlRow;
    const indexed = db.prepare('SELECT COUNT(*) AS n FROM reviews_fts').get() as SqlRow;
    if (reviews.n !== indexed.n) {
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM reviews_fts');
        db.exec('INSERT INTO reviews_fts (review_id, body_md) SELECT id, body_md FROM reviews');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function openDb(workspaceRoot: string, opts?: { disableFts?: boolean }): AceDb {
  const aceDir = path.join(workspaceRoot, '.ace');
  fs.mkdirSync(path.join(aceDir, 'tmp'), { recursive: true });
  const db = new DatabaseSync(path.join(aceDir, 'ace.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  runMigrations(db);
  // disableFts exists for tests exercising the LIKE fallback path.
  const ftsAvailable = opts?.disableFts ? false : ensureReviewsFts(db);
  return new SqliteAceDb(workspaceRoot, db, ftsAvailable);
}
