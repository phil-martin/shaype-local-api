import { registerSchema } from '../../db/index.js'

/**
 * Timer cutoff expressions (ISO strings compare lexicographically). The timer queries in repo.ts use these
 * exact expressions so SQLite serves them from the (status, expression) indexes below instead of scanning
 * every row of the status on each scheduler tick.
 */
export const PORTABLE_SINCE = 'coalesce(portable_since, updated_at)'
export const DEREGISTERED_SINCE = 'coalesce(deregistered_at, updated_at)'
/** Last activity of a registration: registration, update (details / status) or resolution. */
export const LAST_ACTIVITY = "max(registered_at, updated_at, coalesce(last_resolved_at, ''))"

/**
 * payids: one row per PayID registration (the NPP Addressing Service record). A value that is
 * deregistered and registered again gets a new row, so an account's list keeps its history and the
 * invariant "at most one non-DEREGISTERED row per (value, type)" is enforced by the partial index.
 * pay_id_value is stored normalised (EMAIL lower-cased) and compared case-insensitively.
 *
 * payid_deregistrations: the de-register history (getPayIdDeregisterHistory), one entry per
 * deregistration; it outlives the 90-day purge of the DEREGISTERED row.
 */
export const PAYID_SCHEMA = `
CREATE TABLE IF NOT EXISTS payids (
  id               TEXT PRIMARY KEY,
  seq              INTEGER NOT NULL,          -- registration order
  pay_id_value     TEXT NOT NULL,
  pay_id_type      TEXT NOT NULL,             -- EMAIL | TELEPHONE | INDIVIDUAL_AUSTRALIAN_BUSINESS | ORGANISATION
  account_id       TEXT NOT NULL,             -- linked HayAccount (historical link once DEREGISTERED)
  status           TEXT NOT NULL,             -- ACTIVE | DISABLED | PORTABLE | DEREGISTERED
  reason           TEXT,                      -- FROD | CUST | DECD | LEGL | PART
  pay_id_name      TEXT NOT NULL,
  owner_name       TEXT NOT NULL,
  registered_at    TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_resolved_at TEXT,
  portable_since   TEXT,                      -- set while PORTABLE (14-day revert timer)
  deregistered_at  TEXT                       -- set while DEREGISTERED (90-day purge timer)
);
CREATE INDEX IF NOT EXISTS payids_seq ON payids(seq);
CREATE INDEX IF NOT EXISTS payids_value ON payids(pay_id_value COLLATE NOCASE, pay_id_type);
CREATE INDEX IF NOT EXISTS payids_account ON payids(account_id);
CREATE INDEX IF NOT EXISTS payids_status ON payids(status);
CREATE UNIQUE INDEX IF NOT EXISTS payids_live ON payids(pay_id_value COLLATE NOCASE, pay_id_type) WHERE status <> 'DEREGISTERED';
CREATE INDEX IF NOT EXISTS payids_portable_timer ON payids(status, ${PORTABLE_SINCE}) WHERE status = 'PORTABLE';
CREATE INDEX IF NOT EXISTS payids_purge_timer ON payids(status, ${DEREGISTERED_SINCE}) WHERE status = 'DEREGISTERED';
CREATE INDEX IF NOT EXISTS payids_inactivity_timer ON payids(status, ${LAST_ACTIVITY}) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS payid_deregistrations (
  id               TEXT PRIMARY KEY,
  seq              INTEGER NOT NULL,
  pay_id_id        TEXT NOT NULL,
  pay_id_value     TEXT NOT NULL,
  pay_id_type      TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  pay_id_name      TEXT NOT NULL,
  reason           TEXT,
  registered_at    TEXT NOT NULL,
  deregistered_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payid_deregistrations_value ON payid_deregistrations(pay_id_value COLLATE NOCASE);
`

registerSchema(PAYID_SCHEMA)
