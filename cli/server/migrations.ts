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
];
