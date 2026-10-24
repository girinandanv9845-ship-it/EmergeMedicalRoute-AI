/**
 * SQLite persistence using Node's built-in `node:sqlite` module (no native build step).
 * All queries are parameterised. Migrations are idempotent and run at start-up.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';

// Loaded via require so bundlers/test runners never try to transform the builtin.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export type SqlParam = SQLInputValue;

export class Database {
  private readonly db: DatabaseSyncType;
  private open = true;

  constructor(readonly location: string) {
    if (location !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(location)), { recursive: true });
    this.db = new DatabaseSync(location);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (location !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    migrate(this);
  }

  get isOpen(): boolean {
    return this.open;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* connection may already be closed */
      }
      throw err;
    }
  }

  ping(): boolean {
    try {
      return this.get<{ ok: number }>('SELECT 1 AS ok')?.ok === 1;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.open) {
      this.db.close();
      this.open = false;
    }
  }
}

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS policy_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  policy_name TEXT NOT NULL,
  policy_definition TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appointment_requests (
  id TEXT PRIMARY KEY CHECK (id LIKE 'SYN-%'),
  seq INTEGER NOT NULL UNIQUE,
  synthetic_patient_id TEXT NOT NULL CHECK (synthetic_patient_id LIKE 'SYN-P-%'),
  age_group TEXT NOT NULL,
  symptom_description TEXT NOT NULL,
  symptom_onset TEXT NOT NULL,
  requested_urgency TEXT NOT NULL CHECK (requested_urgency IN ('ROUTINE','URGENT')),
  preferred_date TEXT NOT NULL,
  preferred_time_range TEXT NOT NULL,
  administrative_notes TEXT,
  is_follow_up INTEGER NOT NULL DEFAULT 0,
  data_origin TEXT NOT NULL CHECK (data_origin IN ('synthetic_seed','synthetic_intake')),
  seed_key TEXT UNIQUE,
  scenario_label TEXT,
  client_submission_id TEXT UNIQUE,
  review_status TEXT NOT NULL DEFAULT 'AWAITING_REVIEW'
    CHECK (review_status IN ('AWAITING_REVIEW','APPROVED','OVERRIDDEN','CLARIFICATION_REQUESTED')),
  assigned_staff_id TEXT,
  final_route TEXT,
  current_recommendation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_created ON appointment_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_requests_status ON appointment_requests(review_status);
CREATE INDEX IF NOT EXISTS idx_requests_patient ON appointment_requests(synthetic_patient_id);

CREATE TABLE IF NOT EXISTS routing_recommendations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES appointment_requests(id) ON DELETE CASCADE,
  recommended_route TEXT NOT NULL,
  matched_rule_ids TEXT NOT NULL,
  primary_rule_id TEXT,
  explanation TEXT NOT NULL,
  payload TEXT NOT NULL,
  uncertainty_present INTEGER NOT NULL,
  requires_human_review INTEGER NOT NULL,
  emergency_guidance_required INTEGER NOT NULL,
  policy_version TEXT NOT NULL REFERENCES policy_versions(version),
  ai_status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recs_request ON routing_recommendations(request_id);
CREATE INDEX IF NOT EXISTS idx_recs_route ON routing_recommendations(recommended_route);

CREATE TABLE IF NOT EXISTS staff_reviews (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES appointment_requests(id) ON DELETE CASCADE,
  original_recommendation_id TEXT NOT NULL REFERENCES routing_recommendations(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('APPROVE','REQUEST_CLARIFICATION','ASSIGN_TO_ME','OVERRIDE')),
  original_route TEXT NOT NULL,
  final_route TEXT,
  override_reason TEXT,
  note TEXT,
  staff_actor_id TEXT NOT NULL,
  review_status TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  safety_flags TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (action <> 'OVERRIDE' OR (override_reason IS NOT NULL AND length(trim(override_reason)) >= 10 AND final_route IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_reviews_request ON staff_reviews(request_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  request_id TEXT,
  policy_version TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system','staff','requester','ai_provider')),
  actor_id TEXT,
  description TEXT NOT NULL,
  matched_rule_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_events(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(event_type);

-- Append-only protections
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS recommendation_no_update BEFORE UPDATE ON routing_recommendations
BEGIN SELECT RAISE(ABORT, 'routing recommendations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS review_no_update BEFORE UPDATE ON staff_reviews
BEGIN SELECT RAISE(ABORT, 'staff reviews are immutable'); END;

CREATE TABLE IF NOT EXISTS test_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed','failed','skipped')),
  safety_critical INTEGER NOT NULL,
  critical_failure INTEGER NOT NULL,
  expected_result TEXT NOT NULL,
  actual_result TEXT,
  failure_reason TEXT,
  policy_version TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_runs_run ON test_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_test ON test_runs(test_id);
`,
  },
];

function migrate(db: Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
  for (const m of MIGRATIONS) {
    const done = db.get<{ version: number }>('SELECT version FROM schema_migrations WHERE version = ?', m.version);
    if (done) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', m.version, new Date().toISOString());
    });
  }
}
