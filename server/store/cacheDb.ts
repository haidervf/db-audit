import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir } from '../config/paths';

export type Db = Database.Database;

export const SCHEMA_VERSION = 2;

/**
 * Migrations, applied in order on open. `meta.schema_version` records the last applied one.
 * Keys used by analysis / ai_descriptions (`target_key`) are graph node ids:
 * `procedure:dbo.Name`, `job:<jobId>`, `jobstep:<jobId>#<stepId>`.
 */
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE objects (
  id                INTEGER PRIMARY KEY,
  kind              TEXT NOT NULL,
  schema_name       TEXT NOT NULL COLLATE NOCASE,
  name              TEXT NOT NULL COLLATE NOCASE,
  server_object_id  INTEGER,
  type_code         TEXT,
  create_date       TEXT,
  modify_date       TEXT,
  definition        TEXT,
  is_encrypted      INTEGER NOT NULL DEFAULT 0,
  definition_sha256 TEXT,
  details_json      TEXT NOT NULL DEFAULT '{}',
  row_count         INTEGER,
  content_sha256    TEXT,
  fetched_at        TEXT NOT NULL,
  UNIQUE (kind, schema_name, name)
);

CREATE TABLE dependencies (
  id                  INTEGER PRIMARY KEY,
  from_kind           TEXT NOT NULL,
  from_schema         TEXT NOT NULL COLLATE NOCASE,
  from_name           TEXT NOT NULL COLLATE NOCASE,
  ref_server          TEXT COLLATE NOCASE,
  ref_database        TEXT COLLATE NOCASE,
  ref_schema          TEXT COLLATE NOCASE,
  ref_name            TEXT NOT NULL COLLATE NOCASE,
  ref_kind            TEXT NOT NULL,
  ref_type_code       TEXT,
  ref_resolved        INTEGER NOT NULL DEFAULT 0,
  is_ambiguous        INTEGER NOT NULL DEFAULT 0,
  is_caller_dependent INTEGER NOT NULL DEFAULT 0,
  is_selected         INTEGER,
  is_updated          INTEGER,
  is_select_all       INTEGER,
  is_incomplete       INTEGER,
  columns_json        TEXT,
  source              TEXT NOT NULL
);
CREATE INDEX ix_dependencies_from ON dependencies (from_kind, from_schema, from_name);
CREATE INDEX ix_dependencies_ref ON dependencies (ref_name, ref_schema);

-- which (object_id, modify_date) each object's dependencies were computed for (incremental refresh)
CREATE TABLE dependency_state (
  kind             TEXT NOT NULL,
  schema_name      TEXT NOT NULL COLLATE NOCASE,
  name             TEXT NOT NULL COLLATE NOCASE,
  server_object_id INTEGER,
  modify_date      TEXT,
  computed_at      TEXT NOT NULL,
  PRIMARY KEY (kind, schema_name, name)
);

-- source: 'agent' (msdb on the target server) | 'elastic' (Elastic Jobs job database)
CREATE TABLE jobs (
  job_id         TEXT PRIMARY KEY,
  source         TEXT NOT NULL,
  name           TEXT NOT NULL COLLATE NOCASE,
  enabled        INTEGER NOT NULL,
  version        INTEGER NOT NULL,
  details_json   TEXT NOT NULL,
  content_sha256 TEXT,
  fetched_at     TEXT NOT NULL,
  UNIQUE (source, name)
);

CREATE TABLE job_executions (
  id                   INTEGER PRIMARY KEY,
  source               TEXT NOT NULL,
  job_execution_id     TEXT NOT NULL,
  job_id               TEXT,
  job_name             TEXT NOT NULL COLLATE NOCASE,
  step_id              INTEGER,
  step_name            TEXT,
  lifecycle            TEXT,
  is_active            INTEGER NOT NULL DEFAULT 0,
  create_time          TEXT,
  start_time           TEXT,
  end_time             TEXT,
  last_message         TEXT,
  target_server_name   TEXT,
  target_database_name TEXT,
  current_attempts     INTEGER,
  details_json         TEXT
);
CREATE INDEX ix_job_executions_job ON job_executions (job_id, create_time);

-- Phase B: static analysis results (left empty in Phase A)
CREATE TABLE analysis (
  target_key        TEXT NOT NULL,
  analyzer_version  TEXT NOT NULL,
  definition_sha256 TEXT,
  analysis_json     TEXT NOT NULL,
  analyzed_at       TEXT NOT NULL,
  PRIMARY KEY (target_key, analyzer_version)
);

-- Phase B: AI descriptions (left empty in Phase A)
CREATE TABLE ai_descriptions (
  target_key        TEXT NOT NULL,
  definition_sha256 TEXT,
  model             TEXT NOT NULL,
  content_json      TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (target_key, model)
);

CREATE TABLE refresh_runs (
  id                  TEXT PRIMARY KEY,
  status              TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  request_json        TEXT NOT NULL,
  progress_json       TEXT NOT NULL,
  counts_json         TEXT NOT NULL,
  warnings_json       TEXT NOT NULL,
  segment_errors_json TEXT,
  error               TEXT
);
CREATE INDEX ix_refresh_runs_started ON refresh_runs (started_at);
`,
  },
  {
    // Phase B: compact per-analysis columns (summary flags + the refs the graph / resolver need, so list and
    // graph requests do not parse every full analysis), and AI descriptions keyed by model + prompt version.
    version: 2,
    sql: `
ALTER TABLE analysis ADD COLUMN flags_json TEXT;
ALTER TABLE analysis ADD COLUMN refs_json TEXT;

CREATE TABLE ai_descriptions_v2 (
  target_key        TEXT NOT NULL,
  definition_sha256 TEXT,
  model             TEXT NOT NULL,
  prompt_version    TEXT NOT NULL,
  effort            TEXT NOT NULL,
  content_json      TEXT NOT NULL,
  usage_json        TEXT,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (target_key, model, prompt_version)
);
INSERT INTO ai_descriptions_v2 (target_key, definition_sha256, model, prompt_version, effort, content_json, usage_json, created_at)
  SELECT target_key, definition_sha256, model, 'v0', 'unknown', content_json, NULL, created_at FROM ai_descriptions;
DROP TABLE ai_descriptions;
ALTER TABLE ai_descriptions_v2 RENAME TO ai_descriptions;
`,
  },
];

export function openCacheDb(file: string): Db {
  ensurePrivateDir(path.dirname(file));
  const existed = fs.existsSync(file);
  const db = new Database(file);
  if (!existed) fs.chmodSync(file, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  const row = db.prepare(`SELECT v FROM meta WHERE k = 'schema_version'`).get() as { v: string } | undefined;
  let current = row ? Number(row.v) : 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare(`INSERT INTO meta (k, v) VALUES ('schema_version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).run(String(m.version));
    })();
    current = m.version;
  }
}
