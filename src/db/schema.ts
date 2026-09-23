/**
 * SQLite schema. Applied idempotently on open. Domain tables are appended by each domain module's
 * `schema` export and collected in src/db/index.ts, so this file only holds cross-cutting tables.
 */
export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Outbound webhook notifications (Shaype -> client). One row per notification; retries update the row.
CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,           -- == payload.idempotencyKey
  version         TEXT NOT NULL,              -- 'v0' | 'v1'
  type            TEXT NOT NULL,              -- NotificationDto.type / NotificationDtoV1.type
  payload         TEXT NOT NULL,              -- JSON
  status          TEXT NOT NULL,              -- queued | delivered | failed | stored (no webhook url)
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_status     INTEGER,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  next_attempt_at TEXT,
  delivered_at    TEXT,
  seq             INTEGER NOT NULL            -- emission order
);
CREATE INDEX IF NOT EXISTS notifications_status ON notifications(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS notifications_type ON notifications(type, seq);

-- Idempotency replay cache for request bodies carrying idempotencyKey (scoped per operation).
CREATE TABLE IF NOT EXISTS idempotency (
  scope        TEXT NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status       INTEGER NOT NULL,
  body         TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
`
