/**
 * Schema migrations, embedded as SQL strings (never external .sql files so the
 * non-bundled tsup compile ships them). Applied in order; the last applied
 * index + 1 is tracked in meta under 'schema_version'.
 */
export const MIGRATIONS: string[] = [
  `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  suggested_minutes INTEGER NOT NULL,
  dir_path TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  missing_at TEXT,
  UNIQUE (category, slug)
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions (id),
  number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  hints_used INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE attempt_events (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts (id),
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT
);

CREATE TABLE test_runs (
  id TEXT PRIMARY KEY,
  attempt_id TEXT,
  question_id TEXT NOT NULL REFERENCES questions (id),
  at TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  status TEXT NOT NULL,
  total INTEGER,
  passed INTEGER,
  failed INTEGER,
  skipped INTEGER,
  duration_ms INTEGER,
  results_json TEXT,
  stdout_text TEXT,
  stderr_text TEXT,
  error_message TEXT
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions (id),
  attempt_id TEXT,
  version INTEGER NOT NULL,
  at TEXT NOT NULL,
  model TEXT,
  verdict TEXT,
  dimensions_json TEXT,
  body_md TEXT NOT NULL,
  source TEXT NOT NULL
);

CREATE INDEX idx_attempts_question_id ON attempts (question_id);
CREATE INDEX idx_attempt_events_attempt_id ON attempt_events (attempt_id);
CREATE INDEX idx_test_runs_question_at ON test_runs (question_id, at);
`,
  // Migration 2 (M2 "The Corpus"): review scoring + snapshots + disputes.
  // Pure ALTER/CREATE only — the reviews_fts virtual table is created at openDb
  // (never here) so node:sqlite builds without FTS5 don't brick the db.
  `
ALTER TABLE reviews ADD COLUMN score REAL;
ALTER TABLE reviews ADD COLUMN snapshot_hash TEXT;

CREATE TABLE disputes (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions (id),
  attempt_id TEXT,
  test_run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  argument TEXT,
  verdict TEXT NOT NULL,
  summary TEXT NOT NULL,
  details_md TEXT NOT NULL,
  fixed_test_code TEXT,
  test_rel_path TEXT NOT NULL,
  hint TEXT,
  applied_at TEXT
);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions (id),
  attempt_id TEXT,
  rel_path TEXT NOT NULL,
  hash TEXT NOT NULL,
  at TEXT NOT NULL,
  "trigger" TEXT NOT NULL
);

CREATE INDEX idx_disputes_question_id ON disputes (question_id);
CREATE INDEX idx_snapshots_question_rel_path_at ON snapshots (question_id, rel_path, at);
`,
  // Migration 3 (M3 "The Room"): background generation jobs + brainstorm
  // sessions. Pure CREATE only — no ALTERs to existing tables.
  `
CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,          -- 'running' | 'llm_done' | 'done' | 'error'
  category TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  topic TEXT NOT NULL,
  brainstorm_session_id TEXT,
  title TEXT,
  slug TEXT,
  result_json TEXT,
  raw_text TEXT,
  error_message TEXT,
  question_id TEXT REFERENCES questions (id),
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE brainstorm_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,          -- 'idle' | 'thinking' | 'error'
  title TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_generation_jobs_created_at ON generation_jobs (created_at);
CREATE INDEX idx_brainstorm_sessions_updated_at ON brainstorm_sessions (updated_at);
`,
  // Migration 4 (NEE-178): backfill — close stale open attempts on questions
  // that are actually solved (latest completed run fully passing), reason
  // 'solved'. Pure UPDATE only.
  //
  // Both subqueries are scoped to `t.at >= attempts.started_at` (attempt-
  // scoped, mirrors isAttemptSolved in app.ts): without this clause, a user
  // who solved a question and then clicked "New attempt" (no run yet on the
  // fresh attempt) would have that live, in-progress re-attempt closed using
  // the old solve's run — and since that run predates the new attempt's
  // started_at, ended_at would end up before started_at. Scoping to the
  // latest completed run *at or after* started_at ensures only a run that
  // actually happened within (or after the start of) this attempt can close
  // it.
  //
  // status = 'done' stays inside every subquery: error/running rows carry
  // NULL total/passed and must never be treated as a pass.
  //
  // This intentionally DOES close an attempt the user was actively polishing
  // on a solved-and-still-green question — per the ticket's decision, the
  // "solve moment" is leaving the room with tests passing, and a stale open
  // attempt with a passing run already on record means that moment has
  // already happened, backfill or not.
  //
  // ORDER BY is byte-consistent with listQuestions' latestDone subquery and
  // AceDb.getLatestCompletedTestRun.
  `
UPDATE attempts
SET end_reason = 'solved',
    ended_at = (
      SELECT t.at FROM test_runs t
      WHERE t.question_id = attempts.question_id
        AND t.status = 'done'
        AND t.at >= attempts.started_at
      ORDER BY t.at DESC, t.id DESC LIMIT 1
    )
WHERE ended_at IS NULL
  AND (
    SELECT t.total > 0 AND t.passed = t.total FROM test_runs t
    WHERE t.question_id = attempts.question_id
      AND t.status = 'done'
      AND t.at >= attempts.started_at
    ORDER BY t.at DESC, t.id DESC LIMIT 1
  ) = 1;
`,
  // Migration 5 (NEE-266): AI activity log. Two tables, not one flat event
  // log: review and dispute jobs use ephemeral in-memory ids with no db row
  // at all, so a run table is needed regardless, and it keeps status
  // derivation and pruning off the hot read path. Deliberately NOT built: the
  // llm_usage table sketched in docs/m3-spec.md — the user ruled out
  // tokens/model/cost for this feature. ai_runs.id is minted per run and is
  // NOT the engine's jobId on purpose: retry() re-runs the *same* generation
  // job id, so a fresh run per attempt gives per-retry history keyed by
  // ref_id for free. Pure CREATE only.
  `
CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,              -- uuidv7, minted per run (NOT the engine's jobId)
  kind TEXT NOT NULL,               -- 'generation'|'review'|'dispute'|'brainstorm'
  ref_id TEXT,                      -- generation_jobs.id | review jobId | disputeJobId | brainstorm session id
  question_id TEXT,                 -- no FK: a generation run precedes its question row
  label TEXT NOT NULL,
  status TEXT NOT NULL,             -- 'running'|'done'|'error'
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE ai_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_runs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- 'llm'|'sandbox'|'static-check'|'scaffold'
  slug TEXT NOT NULL,               -- 'generate'|'edge-audit'|'verify'|'repair'|'scaffold'|…
  label TEXT NOT NULL,
  status TEXT NOT NULL,             -- 'running'|'done'|'error'|'skipped'
  attempt INTEGER NOT NULL DEFAULT 1,
  prompt_text TEXT,                 -- ALREADY MASKED at write time; NULL when withheld
  prompt_withheld INTEGER NOT NULL DEFAULT 0,
  response_text TEXT,               -- ALREADY MASKED at write time
  withheld_keys TEXT,               -- JSON array: ["referenceSolution","interviewerPacket"]
  detail TEXT,                      -- one-line collapsed outcome, e.g. '12/12 passed'
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX idx_ai_runs_started_at ON ai_runs (started_at);
CREATE INDEX idx_ai_runs_ref ON ai_runs (kind, ref_id);
CREATE INDEX idx_ai_steps_run_seq ON ai_steps (run_id, seq);
`,
];
