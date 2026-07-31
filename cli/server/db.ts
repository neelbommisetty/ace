import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  AceDb,
  AiRunKind,
  AiRunRow,
  AiRunStatus,
  AiStepKind,
  AiStepRow,
  AiStepStatus,
  AiStepSummary,
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
  Probe,
  ProbeSetRow,
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
import { CATEGORIES, CATEGORY_SLUGS, hasTests } from '../lib/categories.js';
import { isPositiveVerdict } from '../../shared/verdicts.js';
import { nowIso, uuidv7 } from './ids.js';
import { MIGRATIONS } from './migrations.js';

const SCHEMA_VERSION_KEY = 'schema_version';

/**
 * Category slugs with an empty `testFiles` (design/behavioral, NEE-353) —
 * these can never produce a test run, so `listQuestions` derives their
 * `solved` status from the latest review's VERDICT instead (NEE-356).
 * Computed once from `CATEGORIES` so the SQL below never hardcodes a slug.
 * `isQuestionSolved` / `isAttemptSolved` (app.ts) encode the identical
 * no-test-category rule per-question via `hasTests`/`lookupCategoryConfig`
 * instead of this precomputed set, and share the verdict half through
 * `isPositiveVerdict` — keep all three sites in sync if the rule ever
 * changes.
 */
const NO_TEST_CATEGORY_SLUGS = CATEGORY_SLUGS.filter((slug) => !hasTests(CATEGORIES[slug]));

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

function rowToProbeSet(r: SqlRow): ProbeSetRow {
  return {
    id: r.id as string,
    questionId: r.question_id as string,
    attemptId: (r.attempt_id as string | null) ?? null,
    at: r.at as string,
    probes: JSON.parse(r.probes_json as string) as Probe[],
    model: (r.model as string | null) ?? null,
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
    feedback: (r.feedback as string | null) ?? null,
    sourceQuestionId: (r.source_question_id as string | null) ?? null,
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
    // Backfilled to created_at by migration 6, so non-null in practice; the
    // fallback only guards a row somehow written without it.
    runStartedAt: (r.run_started_at as string | null) ?? (r.created_at as string),
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

function rowToAiRun(r: SqlRow): AiRunRow {
  return {
    id: r.id as string,
    kind: r.kind as AiRunKind,
    refId: (r.ref_id as string | null) ?? null,
    questionId: (r.question_id as string | null) ?? null,
    label: r.label as string,
    status: r.status as AiRunStatus,
    errorMessage: (r.error_message as string | null) ?? null,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

function rowToAiStep(r: SqlRow): AiStepRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    seq: r.seq as number,
    kind: r.kind as AiStepKind,
    slug: r.slug as string,
    label: r.label as string,
    status: r.status as AiStepStatus,
    attempt: r.attempt as number,
    promptText: (r.prompt_text as string | null) ?? null,
    promptWithheld: r.prompt_withheld === 1,
    responseText: (r.response_text as string | null) ?? null,
    withheldKeys:
      r.withheld_keys == null ? null : (JSON.parse(r.withheld_keys as string) as string[]),
    detail: (r.detail as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

/**
 * For rows fetched WITHOUT the prompt_text/response_text columns —
 * rowToAiStep maps their absence to null, and the destructure drops them.
 */
function rowToAiStepSummary(r: SqlRow): AiStepSummary {
  const { promptText: _prompt, responseText: _response, ...summary } = rowToAiStep(r);
  return summary;
}

/**
 * Per-field write cap for ai_steps prompt/response text (mirrors
 * FAILURE_REPORT_CAP in gen-verify.ts). The repair prompt embeds a >20KB
 * question JSON and responses run up to the pipeline's 16k output tokens
 * (~64KB), so oversized text is stored head-and-tail around an elision
 * marker rather than unbounded.
 */
export const AI_LOG_TEXT_CAP = 64 * 1024;

function capAiLogText(text: string): string {
  if (text.length <= AI_LOG_TEXT_CAP) return text;
  const half = Math.floor(AI_LOG_TEXT_CAP / 2);
  let head = text.slice(0, half);
  let tail = text.slice(text.length - half);
  // Never split a surrogate pair at either cut point — node:sqlite would
  // persist the dangling half as U+FFFD.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  const elided = text.length - head.length - tail.length;
  return `${head}\n… (${elided} chars elided) …\n${tail}`;
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
  private readonly stmtCache = new Map<string, StatementSync>();

  constructor(workspaceRoot: string, db: DatabaseSync, ftsAvailable: boolean) {
    this.workspaceRoot = workspaceRoot;
    this.db = db;
    this.ftsAvailable = ftsAvailable;
  }

  /**
   * Memoizes DatabaseSync.prepare() — sqlite3_prepare_v2 does real parsing
   * and query-planning work per call. Every call site passes a stable string
   * (literals, or interpolations over a closed set of variants), so the SQL
   * text is a safe cache key. close() clears the cache: a StatementSync must
   * never outlive its DatabaseSync, and workspace reset closes and reopens
   * the db.
   */
  private stmt(sql: string): StatementSync {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  // -- questions ------------------------------------------------------------

  listQuestions(): QuestionWithStats[] {
    // 'done' or 'compile-error' — the latest run whose outcome is knowable,
    // so a compile failure surfaces in the library list distinctly instead
    // of silently falling back to a stale prior run (NEE-332). A still
    // 'running'/'error'/'cancelled' run never shadows what finished before it.
    const latestDone =
      "SELECT t.%COL% FROM test_runs t WHERE t.question_id = q.id " +
      "AND t.status IN ('done', 'compile-error') " +
      'ORDER BY t.at DESC, t.id DESC LIMIT 1';
    // Categories with no test suite (design/behavioral, NEE-353) can never
    // produce a test run, so their `solved` status comes from the LATEST
    // review's verdict instead (NEE-356) — reviews are only ever persisted
    // in full (createReview inserts one row, atomically, once the streamed
    // body is complete; there is no pending/partial row), so a review row
    // IS a completed review. `ORDER BY version DESC` is byte-consistent
    // with AceDb.getLatestReview, which is what isQuestionSolved (app.ts)
    // reads — the two must resolve the same row. The slug set is a bound
    // parameter, not interpolated, so this SQL never hardcodes a category.
    const noTestPlaceholders = NO_TEST_CATEGORY_SLUGS.map(() => '?').join(', ');
    const categoryHasNoTests =
      NO_TEST_CATEGORY_SLUGS.length > 0 ? `q.category IN (${noTestPlaceholders})` : '0';
    const rows = this.stmt(
      `SELECT q.*,
        (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id) AS attempt_count,
        EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id AND a.imported = 1) AS has_imported,
        (SELECT MAX(a.started_at) FROM attempts a WHERE a.question_id = q.id) AS last_attempt_at,
        (${latestDone.replace('%COL%', 'passed')}) AS last_done_passed,
        (${latestDone.replace('%COL%', 'total')}) AS last_done_total,
        (${latestDone.replace('%COL%', 'at')}) AS last_done_at,
        (${latestDone.replace('%COL%', 'status')}) AS last_done_status,
        (SELECT MAX(t.at) FROM test_runs t WHERE t.question_id = q.id) AS last_run_at,
        (${categoryHasNoTests}) AS category_has_no_tests,
        (SELECT rv.verdict FROM reviews rv WHERE rv.question_id = q.id
         ORDER BY rv.version DESC LIMIT 1) AS last_review_verdict
      FROM questions q
      ORDER BY q.category, q.slug`,
    ).all(...NO_TEST_CATEGORY_SLUGS) as SqlRow[];

    return rows.map((r) => {
      const attemptCount = r.attempt_count as number;
      const lastRun =
        r.last_done_at != null
          ? {
              passed: (r.last_done_passed as number | null) ?? 0,
              total: (r.last_done_total as number | null) ?? 0,
              at: r.last_done_at as string,
              status: (r.last_done_status as 'done' | 'compile-error') ?? 'done',
            }
          : null;
      const categoryHasNoTests = r.category_has_no_tests === 1;
      const lastReviewVerdict = r.last_review_verdict as string | null;
      let status: QuestionStatus = 'not-attempted';
      if (categoryHasNoTests) {
        // No test suite exists to derive status from — the latest review's
        // verdict is the only signal (NEE-353, verdict-aware since
        // NEE-356). Solved requires a POSITIVE verdict: a 'No Hire' means
        // the question was assessed and missed, and must stay in-progress
        // so the Library and "Practice next" keep offering it. Latest
        // review wins, mirroring the latest-run-wins rule in the test
        // branch below and isQuestionSolved's getLatestReview (app.ts).
        if (isPositiveVerdict(lastReviewVerdict)) {
          status = 'solved';
        } else if (attemptCount > 0) {
          status = 'in-progress';
        }
      } else if (
        lastRun &&
        lastRun.status === 'done' &&
        lastRun.total > 0 &&
        lastRun.passed === lastRun.total
      ) {
        status = 'solved';
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
    const r = this.stmt('SELECT * FROM questions WHERE id = ?').get(id) as SqlRow | undefined;
    return r ? rowToQuestion(r) : null;
  }

  getQuestion(category: string, slug: string): QuestionRow | null {
    const r = this.stmt('SELECT * FROM questions WHERE category = ? AND slug = ?').get(
      category,
      slug,
    ) as SqlRow | undefined;
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
    this.stmt(
      `INSERT INTO questions
        (id, category, slug, title, difficulty, suggested_minutes, dir_path, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (category, slug) DO UPDATE SET
         title = excluded.title,
         difficulty = excluded.difficulty,
         suggested_minutes = excluded.suggested_minutes,
         dir_path = excluded.dir_path`,
    ).run(
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
    const clear = this.stmt(
      'UPDATE questions SET missing_at = NULL WHERE id = ? AND missing_at IS NOT NULL',
    );
    const mark = this.stmt(
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

  /**
   * Sets `archived_at` (NEE-296) — hides the question from the Library's
   * default view without touching files on disk, attempts, reviews, or
   * disputes. Idempotent: archiving an already-archived question just
   * refreshes the timestamp. Returns the updated row, or null if `id` doesn't
   * exist (the route 404s on that).
   */
  archiveQuestion(id: string): QuestionRow | null {
    const r = this.stmt('UPDATE questions SET archived_at = ? WHERE id = ? RETURNING *').get(
      nowIso(),
      id,
    ) as SqlRow | undefined;
    return r ? rowToQuestion(r) : null;
  }

  /** Clears `archived_at` (NEE-296) — the Library's "Restore" action. */
  unarchiveQuestion(id: string): QuestionRow | null {
    const r = this.stmt('UPDATE questions SET archived_at = NULL WHERE id = ? RETURNING *').get(
      id,
    ) as SqlRow | undefined;
    return r ? rowToQuestion(r) : null;
  }

  // -- attempts -------------------------------------------------------------

  getActiveAttempt(questionId: string): AttemptRow | null {
    const r = this.stmt(
      `SELECT * FROM attempts WHERE question_id = ? AND ended_at IS NULL
       ORDER BY started_at DESC, id DESC LIMIT 1`,
    ).get(questionId) as SqlRow | undefined;
    return r ? rowToAttempt(r) : null;
  }

  getLatestActiveAttempt(): { attempt: AttemptRow; question: QuestionRow } | null {
    const r = this.stmt(
      `SELECT a.* FROM attempts a WHERE a.ended_at IS NULL
       ORDER BY a.started_at DESC, a.id DESC LIMIT 1`,
    ).get() as SqlRow | undefined;
    if (!r) return null;
    const attempt = rowToAttempt(r);
    const question = this.getQuestionById(attempt.questionId);
    if (!question) return null;
    return { attempt, question };
  }

  getLatestAttempt(questionId: string): AttemptRow | null {
    const r = this.stmt(
      `SELECT * FROM attempts WHERE question_id = ?
       ORDER BY started_at DESC, id DESC LIMIT 1`,
    ).get(questionId) as SqlRow | undefined;
    return r ? rowToAttempt(r) : null;
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

    const countRow = this.stmt('SELECT COUNT(*) AS n FROM attempts WHERE question_id = ?').get(
      questionId,
    ) as SqlRow;
    const number = (countRow.n as number) + 1;

    const row = this.stmt(
      `INSERT INTO attempts (id, question_id, number, started_at, imported)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    ).get(
      uuidv7(),
      questionId,
      number,
      opts?.startedAt ?? nowIso(),
      opts?.imported ? 1 : 0,
    ) as SqlRow;
    return rowToAttempt(row);
  }

  getAttempt(id: string): AttemptRow | null {
    const r = this.stmt('SELECT * FROM attempts WHERE id = ?').get(id) as SqlRow | undefined;
    return r ? rowToAttempt(r) : null;
  }

  patchAttempt(
    id: string,
    patch: { activeSecondsDelta?: number; end?: { reason: AttemptEndReason } },
  ): AttemptRow {
    const existing = this.getAttempt(id);
    if (!existing) throw new Error(`unknown attempt: ${id}`);
    let row = existing;
    if (patch.activeSecondsDelta) {
      row = rowToAttempt(
        this.stmt(
          'UPDATE attempts SET active_seconds = active_seconds + ? WHERE id = ? RETURNING *',
        ).get(patch.activeSecondsDelta, id) as SqlRow,
      );
    }
    // ending is one-way: an already-ended attempt keeps its first end
    if (patch.end && existing.endedAt == null) {
      row = rowToAttempt(
        this.stmt(
          'UPDATE attempts SET ended_at = ?, end_reason = ? WHERE id = ? RETURNING *',
        ).get(nowIso(), patch.end.reason, id) as SqlRow,
      );
    }
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
      const existing = this.stmt(
        `SELECT * FROM attempt_events WHERE attempt_id = ? AND type = ?
         ORDER BY at ASC, id ASC LIMIT 1`,
      ).get(attemptId, type) as SqlRow | undefined;
      if (existing) return rowToAttemptEvent(existing);
    }

    const r = this.stmt(
      `INSERT INTO attempt_events (id, attempt_id, at, type, payload_json)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    ).get(
      uuidv7(),
      attemptId,
      nowIso(),
      type,
      payload ? JSON.stringify(payload) : null,
    ) as SqlRow;
    return rowToAttemptEvent(r);
  }

  hasAttemptEvent(attemptId: string, type: AttemptEventType): boolean {
    const r = this.stmt(
      'SELECT 1 AS one FROM attempt_events WHERE attempt_id = ? AND type = ? LIMIT 1',
    ).get(attemptId, type);
    return r != null;
  }

  listAttemptEvents(attemptId: string): AttemptEventRow[] {
    const rows = this.stmt(
      'SELECT * FROM attempt_events WHERE attempt_id = ? ORDER BY at ASC, id ASC',
    ).all(attemptId) as SqlRow[];
    return rows.map(rowToAttemptEvent);
  }

  /** Workspace-wide attempt count in one query, e.g. for GET /api/workspace. */
  countAttempts(): number {
    const r = this.stmt('SELECT COUNT(*) AS n FROM attempts').get() as SqlRow;
    return r.n as number;
  }

  // -- test runs ------------------------------------------------------------

  createTestRun(r: {
    questionId: string;
    attemptId: string | null;
    trigger: TestRunTrigger;
  }): TestRunRow {
    const row = this.stmt(
      `INSERT INTO test_runs (id, attempt_id, question_id, at, "trigger", status)
       VALUES (?, ?, ?, ?, ?, 'running') RETURNING *`,
    ).get(uuidv7(), r.attemptId, r.questionId, nowIso(), r.trigger) as SqlRow;
    return rowToTestRun(row);
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
    const row = this.stmt(
      `UPDATE test_runs SET
         status = ?,
         total = ?, passed = ?, failed = ?, skipped = ?, duration_ms = ?,
         results_json = ?, stdout_text = ?, stderr_text = ?, error_message = ?
       WHERE id = ? RETURNING *`,
    ).get(
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
    ) as SqlRow | undefined;
    if (!row) throw new Error(`unknown test run: ${id}`);
    return rowToTestRun(row);
  }

  getTestRun(id: string): TestRunRow | null {
    const r = this.stmt('SELECT * FROM test_runs WHERE id = ?').get(id) as SqlRow | undefined;
    return r ? rowToTestRun(r) : null;
  }

  listTestRuns(questionId: string, limit = 50): TestRunRow[] {
    const rows = this.stmt(
      `SELECT * FROM test_runs WHERE question_id = ?
       ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(questionId, limit) as SqlRow[];
    return rows.map(rowToTestRun);
  }

  /**
   * Workspace-wide test run count in one query — avoids materialising every
   * row (results_json, stdout_text, stderr_text) just to read `.length`.
   */
  countTestRuns(): number {
    const r = this.stmt('SELECT COUNT(*) AS n FROM test_runs').get() as SqlRow;
    return r.n as number;
  }

  getLatestTestRun(questionId: string): TestRunRow | null {
    const runs = this.listTestRuns(questionId, 1);
    return runs.length > 0 ? runs[0] : null;
  }

  getLatestCompletedTestRun(questionId: string): TestRunRow | null {
    const r = this.stmt(
      `SELECT * FROM test_runs WHERE question_id = ? AND status = 'done'
       ORDER BY at DESC, id DESC LIMIT 1`,
    ).get(questionId) as SqlRow | undefined;
    return r ? rowToTestRun(r) : null;
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
    const versionRow = this.stmt(
      'SELECT COALESCE(MAX(version), 0) AS v FROM reviews WHERE question_id = ?',
    ).get(r.questionId) as SqlRow;
    const version = (versionRow.v as number) + 1;
    const row = this.stmt(
      `INSERT INTO reviews
        (id, question_id, attempt_id, version, at, model, verdict, score,
         dimensions_json, body_md, snapshot_hash, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(
      uuidv7(),
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
    ) as SqlRow;
    if (this.ftsAvailable) {
      // Kept in sync on insert only (reviews are immutable); a boot-time count
      // check rebuilds the index if this ever drifts.
      this.stmt('INSERT INTO reviews_fts (review_id, body_md) VALUES (?, ?)').run(
        row.id as string,
        r.bodyMd,
      );
    }
    return rowToReview(row);
  }

  getReview(id: string): ReviewRow | null {
    const r = this.stmt('SELECT * FROM reviews WHERE id = ?').get(id) as SqlRow | undefined;
    return r ? rowToReview(r) : null;
  }

  listReviews(questionId: string): ReviewRow[] {
    const rows = this.stmt(
      'SELECT * FROM reviews WHERE question_id = ? ORDER BY version DESC',
    ).all(questionId) as SqlRow[];
    return rows.map(rowToReview);
  }

  getLatestReview(questionId: string): ReviewRow | null {
    const r = this.stmt(
      'SELECT * FROM reviews WHERE question_id = ? ORDER BY version DESC LIMIT 1',
    ).get(questionId) as SqlRow | undefined;
    return r ? rowToReview(r) : null;
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
    const row = this.stmt(
      `INSERT INTO disputes
        (id, question_id, attempt_id, test_run_id, at, argument, verdict,
         summary, details_md, fixed_test_code, test_rel_path, hint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(
      uuidv7(),
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
    ) as SqlRow;
    return rowToDispute(row);
  }

  getDispute(id: string): DisputeRow | null {
    const r = this.stmt('SELECT * FROM disputes WHERE id = ?').get(id) as SqlRow | undefined;
    return r ? rowToDispute(r) : null;
  }

  listDisputes(questionId: string): DisputeRow[] {
    const rows = this.stmt(
      'SELECT * FROM disputes WHERE question_id = ? ORDER BY at DESC, id DESC',
    ).all(questionId) as SqlRow[];
    return rows.map(rowToDispute);
  }

  markDisputeApplied(id: string): DisputeRow {
    const existing = this.getDispute(id);
    if (!existing) throw new Error(`unknown dispute: ${id}`);
    // applying is one-way: the first applied_at sticks
    if (existing.appliedAt != null) return existing;
    const row = this.stmt('UPDATE disputes SET applied_at = ? WHERE id = ? RETURNING *').get(
      nowIso(),
      id,
    ) as SqlRow;
    return rowToDispute(row);
  }

  // -- probe sets -------------------------------------------------------------

  createProbeSet(p: {
    questionId: string;
    attemptId: string | null;
    probes: Probe[];
    model: string | null;
  }): ProbeSetRow {
    const row = this.stmt(
      `INSERT INTO probe_sets (id, question_id, attempt_id, at, probes_json, model)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(
      uuidv7(),
      p.questionId,
      p.attemptId,
      nowIso(),
      JSON.stringify(p.probes),
      p.model,
    ) as SqlRow;
    return rowToProbeSet(row);
  }

  getProbeSet(id: string): ProbeSetRow | null {
    const r = this.stmt('SELECT * FROM probe_sets WHERE id = ?').get(id) as SqlRow | undefined;
    return r ? rowToProbeSet(r) : null;
  }

  listProbeSets(questionId: string): ProbeSetRow[] {
    const rows = this.stmt(
      'SELECT * FROM probe_sets WHERE question_id = ? ORDER BY at DESC, id DESC',
    ).all(questionId) as SqlRow[];
    return rows.map(rowToProbeSet);
  }

  markProbeSetApplied(id: string): ProbeSetRow {
    const existing = this.getProbeSet(id);
    if (!existing) throw new Error(`unknown probe set: ${id}`);
    // applying is one-way: the first applied_at sticks
    if (existing.appliedAt != null) return existing;
    const row = this.stmt('UPDATE probe_sets SET applied_at = ? WHERE id = ? RETURNING *').get(
      nowIso(),
      id,
    ) as SqlRow;
    return rowToProbeSet(row);
  }

  // -- snapshots ------------------------------------------------------------

  addSnapshot(s: {
    questionId: string;
    attemptId: string | null;
    relPath: string;
    hash: string;
    trigger: SnapshotTrigger;
  }): SnapshotRow {
    const r = this.stmt(
      `INSERT INTO snapshots (id, question_id, attempt_id, rel_path, hash, at, "trigger")
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(uuidv7(), s.questionId, s.attemptId, s.relPath, s.hash, nowIso(), s.trigger) as SqlRow;
    return rowToSnapshot(r);
  }

  getLatestSnapshot(
    questionId: string,
    relPath: string,
    trigger?: SnapshotTrigger,
  ): SnapshotRow | null {
    return this.getSnapshotAtExtreme('DESC', questionId, relPath, trigger);
  }

  getFirstSnapshot(
    questionId: string,
    relPath: string,
    trigger?: SnapshotTrigger,
  ): SnapshotRow | null {
    return this.getSnapshotAtExtreme('ASC', questionId, relPath, trigger);
  }

  /**
   * DESC walks from the newest snapshot, ASC from the oldest. The
   * interpolations yield four distinct SQL strings (direction × optional
   * trigger filter), which the statement cache keys apart correctly.
   */
  private getSnapshotAtExtreme(
    direction: 'ASC' | 'DESC',
    questionId: string,
    relPath: string,
    trigger?: SnapshotTrigger,
  ): SnapshotRow | null {
    const r = this.stmt(
      `SELECT * FROM snapshots WHERE question_id = ? AND rel_path = ?
       ${trigger ? 'AND "trigger" = ?' : ''}
       ORDER BY at ${direction}, id ${direction} LIMIT 1`,
    ).get(...(trigger ? [questionId, relPath, trigger] : [questionId, relPath])) as
      | SqlRow
      | undefined;
    return r ? rowToSnapshot(r) : null;
  }

  getSnapshot(id: string): SnapshotRow | null {
    const r = this.stmt('SELECT * FROM snapshots WHERE id = ?').get(id) as SqlRow | undefined;
    return r ? rowToSnapshot(r) : null;
  }

  listSnapshotsForQuestion(questionId: string): SnapshotRow[] {
    const rows = this.stmt(
      'SELECT * FROM snapshots WHERE question_id = ? ORDER BY at DESC, id DESC',
    ).all(questionId) as SqlRow[];
    return rows.map(rowToSnapshot);
  }

  // -- generation jobs --------------------------------------------------------

  createGenerationJob(j: {
    category: string;
    difficulty: Difficulty;
    topic: string;
    brainstormSessionId?: string | null;
    // NEE-386: set together (or neither) — the regenerate-with-feedback flow.
    feedback?: string | null;
    sourceQuestionId?: string | null;
  }): GenerationJobRow {
    const now = nowIso();
    const row = this.stmt(
      `INSERT INTO generation_jobs
        (id, status, category, difficulty, topic, brainstorm_session_id, feedback, source_question_id, created_at, run_started_at)
       VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(
      uuidv7(),
      j.category,
      j.difficulty,
      j.topic,
      j.brainstormSessionId ?? null,
      j.feedback ?? null,
      j.sourceQuestionId ?? null,
      now,
      now,
    ) as SqlRow;
    return rowToGenerationJob(row);
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
      runStartedAt?: string;
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
    // run_started_at is re-stamped only when the patch supplies it (retry
    // does, so the elapsed clock restarts) — every other patch preserves it.
    const runStartedAt =
      patch.runStartedAt !== undefined ? patch.runStartedAt : existing.runStartedAt;
    // finished_at is stamped only when the resulting status is terminal
    // ('done' | 'error'); any other status (including a retry moving an
    // 'error' row back to 'running') leaves it null.
    const finishedAt = status === 'done' || status === 'error' ? nowIso() : null;

    const row = this.stmt(
      `UPDATE generation_jobs SET
         status = ?, title = ?, slug = ?, result_json = ?, raw_text = ?,
         error_message = ?, question_id = ?, run_started_at = ?, finished_at = ?
       WHERE id = ? RETURNING *`,
    ).get(
      status,
      title,
      slug,
      result != null ? JSON.stringify(result) : null,
      rawText,
      errorMessage,
      questionId,
      runStartedAt,
      finishedAt,
      id,
    ) as SqlRow;
    return rowToGenerationJob(row);
  }

  getGenerationJob(id: string): GenerationJobRow | null {
    const r = this.stmt('SELECT * FROM generation_jobs WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return r ? rowToGenerationJob(r) : null;
  }

  listGenerationJobs(limit = 20): GenerationJobRow[] {
    const rows = this.stmt(
      'SELECT * FROM generation_jobs ORDER BY created_at DESC, id DESC LIMIT ?',
    ).all(limit) as SqlRow[];
    return rows.map(rowToGenerationJob);
  }

  // Newest done job for a question — the regenerate flow's source of the
  // prior result_json (server-side use only, the result is answer key).
  // Ordering matches listGenerationJobs (created_at DESC, id DESC).
  getLatestDoneGenerationJobForQuestion(questionId: string): GenerationJobRow | null {
    const r = this.stmt(
      `SELECT * FROM generation_jobs WHERE question_id = ? AND status = 'done'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(questionId) as SqlRow | undefined;
    return r ? rowToGenerationJob(r) : null;
  }

  setQuestionSource(id: string, source: QuestionSource): void {
    this.stmt('UPDATE questions SET source = ? WHERE id = ?').run(source, id);
  }

  // -- brainstorm sessions ----------------------------------------------------

  createBrainstormSession(firstMessage: string): BrainstormSessionRow {
    const now = nowIso();
    const messages: BrainstormTurn[] = [{ role: 'user', content: firstMessage }];
    const row = this.stmt(
      `INSERT INTO brainstorm_sessions
        (id, status, title, messages_json, created_at, updated_at)
       VALUES (?, 'thinking', ?, ?, ?, ?) RETURNING *`,
    ).get(
      uuidv7(),
      truncateBrainstormTitle(firstMessage),
      JSON.stringify(messages),
      now,
      now,
    ) as SqlRow;
    return rowToBrainstormSession(row);
  }

  getBrainstormSession(id: string): BrainstormSessionRow | null {
    const r = this.stmt('SELECT * FROM brainstorm_sessions WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return r ? rowToBrainstormSession(r) : null;
  }

  listBrainstormSessions(limit = 20): BrainstormSessionRow[] {
    const rows = this.stmt(
      'SELECT * FROM brainstorm_sessions ORDER BY updated_at DESC, id DESC LIMIT ?',
    ).all(limit) as SqlRow[];
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
      const row = this.stmt(
        `UPDATE brainstorm_sessions SET messages_json = ?, status = ?, error_message = NULL, updated_at = ?
         WHERE id = ? RETURNING *`,
      ).get(JSON.stringify(messages), status, nowIso(), id) as SqlRow;
      return rowToBrainstormSession(row);
    });
  }

  setBrainstormStatus(
    id: string,
    status: BrainstormSessionStatus,
    errorMessage: string | null = null,
  ): BrainstormSessionRow {
    const row = this.stmt(
      `UPDATE brainstorm_sessions SET status = ?, error_message = ?, updated_at = ?
       WHERE id = ? RETURNING *`,
    ).get(status, errorMessage, nowIso(), id) as SqlRow | undefined;
    if (!row) throw new Error(`unknown brainstorm session: ${id}`);
    return rowToBrainstormSession(row);
  }

  // -- ai activity log --------------------------------------------------------

  createAiRun(r: {
    kind: AiRunKind;
    refId?: string | null;
    questionId?: string | null;
    label: string;
  }): AiRunRow {
    const row = this.stmt(
      `INSERT INTO ai_runs (id, kind, ref_id, question_id, label, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?) RETURNING *`,
    ).get(uuidv7(), r.kind, r.refId ?? null, r.questionId ?? null, r.label, nowIso()) as SqlRow;
    return rowToAiRun(row);
  }

  finishAiRun(
    id: string,
    patch: { status: 'done' | 'error'; errorMessage?: string | null },
  ): AiRunRow {
    const row = this.stmt(
      'UPDATE ai_runs SET status = ?, error_message = ?, finished_at = ? WHERE id = ? RETURNING *',
    ).get(patch.status, patch.errorMessage ?? null, nowIso(), id) as SqlRow | undefined;
    if (!row) throw new Error(`unknown ai run: ${id}`);
    return rowToAiRun(row);
  }

  createAiStep(s: {
    runId: string;
    kind: AiStepKind;
    slug: string;
    label: string;
    attempt?: number;
    promptText?: string | null;
    promptWithheld?: boolean;
    withheldKeys?: string[] | null;
  }): AiStepRow {
    const run = this.getAiRun(s.runId);
    if (!run) throw new Error(`unknown ai run: ${s.runId}`);
    const seqRow = this.stmt(
      'SELECT COALESCE(MAX(seq), 0) AS s FROM ai_steps WHERE run_id = ?',
    ).get(s.runId) as SqlRow;
    const seq = (seqRow.s as number) + 1;
    const row = this.stmt(
      `INSERT INTO ai_steps
        (id, run_id, seq, kind, slug, label, status, attempt, prompt_text,
         prompt_withheld, withheld_keys, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?) RETURNING *`,
    ).get(
      uuidv7(),
      s.runId,
      seq,
      s.kind,
      s.slug,
      s.label,
      s.attempt ?? 1,
      s.promptText != null ? capAiLogText(s.promptText) : null,
      s.promptWithheld ? 1 : 0,
      s.withheldKeys && s.withheldKeys.length > 0 ? JSON.stringify(s.withheldKeys) : null,
      nowIso(),
    ) as SqlRow;
    return rowToAiStep(row);
  }

  appendAiStepResponse(id: string, responseText: string): AiStepRow {
    // Snapshot semantics: the full accumulated text replaces the previous
    // flush, so throttled re-flushes are idempotent (see AceDb contract).
    const row = this.stmt(
      'UPDATE ai_steps SET response_text = ? WHERE id = ? RETURNING *',
    ).get(capAiLogText(responseText), id) as SqlRow | undefined;
    if (!row) throw new Error(`unknown ai step: ${id}`);
    return rowToAiStep(row);
  }

  finishAiStep(
    id: string,
    patch: {
      status: 'done' | 'error' | 'skipped';
      detail?: string | null;
      errorMessage?: string | null;
      responseText?: string | null;
    },
  ): AiStepRow {
    const existing = this.getAiStep(id);
    if (!existing) throw new Error(`unknown ai step: ${id}`);
    // Omitted fields keep their current values — notably response_text
    // streamed in via appendAiStepResponse before the finish.
    const detail = patch.detail !== undefined ? patch.detail : existing.detail;
    const errorMessage =
      patch.errorMessage !== undefined ? patch.errorMessage : existing.errorMessage;
    const responseText =
      patch.responseText !== undefined
        ? patch.responseText != null
          ? capAiLogText(patch.responseText)
          : null
        : existing.responseText;
    const row = this.stmt(
      `UPDATE ai_steps SET status = ?, detail = ?, error_message = ?, response_text = ?,
         finished_at = ?
       WHERE id = ? RETURNING *`,
    ).get(patch.status, detail, errorMessage, responseText, nowIso(), id) as SqlRow;
    return rowToAiStep(row);
  }

  listAiRuns(opts: { limit?: number; kind?: AiRunKind; refId?: string } = {}): AiRunRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    if (opts.refId) {
      where.push('ref_id = ?');
      params.push(opts.refId);
    }
    const rows = this.stmt(
      `SELECT * FROM ai_runs ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY started_at DESC, id DESC LIMIT ?`,
    ).all(...params, opts.limit ?? 50) as SqlRow[];
    return rows.map(rowToAiRun);
  }

  getAiRun(id: string): AiRunRow | null {
    const r = this.stmt('SELECT * FROM ai_runs WHERE id = ?').get(id) as SqlRow | undefined;
    return r ? rowToAiRun(r) : null;
  }

  getAiStep(id: string): AiStepRow | null {
    const r = this.stmt('SELECT * FROM ai_steps WHERE id = ?').get(id) as SqlRow | undefined;
    return r ? rowToAiStep(r) : null;
  }

  listAiSteps(runId: string): AiStepSummary[] {
    // Summary shape by construction: the multi-KB prompt/response columns
    // are never even selected, which is what keeps a 30-run feed cheap.
    const rows = this.stmt(
      `SELECT id, run_id, seq, kind, slug, label, status, attempt, prompt_withheld,
              withheld_keys, detail, error_message, started_at, finished_at
       FROM ai_steps WHERE run_id = ? ORDER BY seq`,
    ).all(runId) as SqlRow[];
    return rows.map(rowToAiStepSummary);
  }

  pruneAiRuns(keep = 200): number {
    const result = this.stmt(
      `DELETE FROM ai_runs WHERE id NOT IN (
         SELECT id FROM ai_runs ORDER BY started_at DESC, id DESC LIMIT ?
       )`,
    ).run(keep);
    return Number(result.changes);
  }

  // -- interrupted-state sweep ------------------------------------------------

  sweepInterruptedGenerationState(): void {
    this.transaction(() => {
      const now = nowIso();
      this.stmt(
        `UPDATE generation_jobs SET status = 'error', error_message = ?, finished_at = ?
         WHERE status = 'running'`,
      ).run('interrupted by a server restart — retry', now);
      this.stmt(
        `UPDATE generation_jobs SET status = 'error', error_message = ?, finished_at = ?
         WHERE status = 'llm_done'`,
      ).run('interrupted by a server restart — retry (no new LLM call)', now);
      this.stmt(
        `UPDATE brainstorm_sessions SET status = 'error', error_message = ?, updated_at = ?
         WHERE status = 'thinking'`,
      ).run('interrupted by a server restart', now);
      // AI activity log rows: without this, Activity shows a run pulsing
      // forever with no engine behind it after a restart.
      this.stmt(
        `UPDATE ai_steps SET status = 'error', error_message = ?, finished_at = ?
         WHERE status = 'running'`,
      ).run('interrupted by a server restart', now);
      this.stmt(
        `UPDATE ai_runs SET status = 'error', error_message = ?, finished_at = ?
         WHERE status = 'running'`,
      ).run('interrupted by a server restart', now);
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

    // Each side is bounded to `limit` rows in SQL (filtered by questionId /
    // category / text match there too) so the merge below can never under-
    // fill the final top-`limit` slice: the true merged top-`limit` can
    // contain at most `limit` reviews and at most `limit` disputes.
    const sqlFilter = { questionId: opts.questionId, category: opts.category, limit };

    const items: HistoryItem[] = [];
    if (opts.type !== 'dispute') {
      for (const review of this.searchReviews(q, sqlFilter)) {
        const question = questionFor(review.questionId);
        if (!question) continue;
        items.push({ type: 'review', at: review.at, question, review });
      }
    }
    if (opts.type !== 'review') {
      for (const dispute of this.searchDisputes(q, sqlFilter)) {
        const question = questionFor(dispute.questionId);
        if (!question) continue;
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

  private searchReviews(
    q: string,
    opts: { questionId?: string; category?: string; limit: number },
  ): ReviewRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.questionId) {
      where.push('r.question_id = ?');
      params.push(opts.questionId);
    }
    if (opts.category) {
      where.push('qs.category = ?');
      params.push(opts.category);
    }

    if (q === '') {
      const rows = this.stmt(
        `SELECT r.* FROM reviews r JOIN questions qs ON qs.id = r.question_id
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY r.at DESC, r.id DESC LIMIT ?`,
      ).all(...params, opts.limit) as SqlRow[];
      return rows.map(rowToReview);
    }
    if (this.ftsAvailable) {
      const match = toFtsMatchQuery(q);
      if (match !== '') {
        try {
          const ftsWhere = [
            ...where,
            'r.id IN (SELECT review_id FROM reviews_fts WHERE reviews_fts MATCH ?)',
          ];
          const rows = this.stmt(
            `SELECT r.* FROM reviews r JOIN questions qs ON qs.id = r.question_id
             WHERE ${ftsWhere.join(' AND ')}
             ORDER BY r.at DESC, r.id DESC LIMIT ?`,
          ).all(...params, match, opts.limit) as SqlRow[];
          return rows.map(rowToReview);
        } catch {
          // hostile input the term-quoting couldn't neutralize — LIKE fallback
        }
      }
    }
    const likeWhere = [...where, 'r.body_md LIKE ? COLLATE NOCASE'];
    const rows = this.stmt(
      `SELECT r.* FROM reviews r JOIN questions qs ON qs.id = r.question_id
       WHERE ${likeWhere.join(' AND ')}
       ORDER BY r.at DESC, r.id DESC LIMIT ?`,
    ).all(...params, `%${q}%`, opts.limit) as SqlRow[];
    return rows.map(rowToReview);
  }

  private searchDisputes(
    q: string,
    opts: { questionId?: string; category?: string; limit: number },
  ): DisputeRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.questionId) {
      where.push('d.question_id = ?');
      params.push(opts.questionId);
    }
    if (opts.category) {
      where.push('qs.category = ?');
      params.push(opts.category);
    }

    if (q === '') {
      const rows = this.stmt(
        `SELECT d.* FROM disputes d JOIN questions qs ON qs.id = d.question_id
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY d.at DESC, d.id DESC LIMIT ?`,
      ).all(...params, opts.limit) as SqlRow[];
      return rows.map(rowToDispute);
    }
    const pattern = `%${q}%`;
    const likeWhere = [
      ...where,
      '(d.summary LIKE ? COLLATE NOCASE OR d.details_md LIKE ? COLLATE NOCASE)',
    ];
    const rows = this.stmt(
      `SELECT d.* FROM disputes d JOIN questions qs ON qs.id = d.question_id
       WHERE ${likeWhere.join(' AND ')}
       ORDER BY d.at DESC, d.id DESC LIMIT ?`,
    ).all(...params, pattern, pattern, opts.limit) as SqlRow[];
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
    const r = this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as SqlRow | undefined;
    return r ? (r.value as string) : null;
  }

  setMeta(key: string, value: string): void {
    this.stmt(
      'INSERT INTO meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  close(): void {
    // Cached statements must not outlive the DatabaseSync they were prepared
    // on (workspace reset closes this db and opens a fresh one).
    this.stmtCache.clear();
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
