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
];
