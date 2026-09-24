import { registerSchema } from '../../db/index.js'

/**
 * Outbound Direct Entry instructions (createDirectDebitV1/V0) and scheduled-payment definitions
 * (spec §5.8, docs/map/de-dd-scheduled.md §2). `de_instructions.id` is the client-supplied
 * transactionId (docs/map/00-open-questions.md I3: one id across create, webhooks and status lookup).
 * Money is INTEGER cents; dates are YYYY-MM-DD (UTC); timestamps are isoUtc.
 */
export const DIRECT_ENTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS de_instructions (
  id                       TEXT PRIMARY KEY,        -- client transactionId == DeTransactionDetails.transactionHayId
  seq                      INTEGER NOT NULL,        -- creation order
  idempotency_key          TEXT NOT NULL,
  account_id               TEXT,                    -- resolved sender (credited) account; NULL when the sender could not be resolved (REJECTED)
  amount                   INTEGER NOT NULL,        -- positive cents
  description              TEXT NOT NULL,
  sender_bsb               TEXT NOT NULL,
  sender_account_number    TEXT NOT NULL,
  sender_name              TEXT NOT NULL,
  recipient_bsb            TEXT NOT NULL,
  recipient_account_number TEXT NOT NULL,
  recipient_name           TEXT NOT NULL,
  status                   TEXT NOT NULL,           -- RECEIVED | ACCEPTED | REJECTED | SUBMITTED | RETURNED | COMPLETE | INCOMPLETE
  details                  TEXT,                    -- DirectDebitResponse.details
  processing_date          TEXT NOT NULL,           -- YYYY-MM-DD
  ledger_transaction_id    TEXT,                    -- the DIRECT_DEBIT_TRANSFER posting at COMPLETE
  return_reason            TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS de_instructions_created ON de_instructions(created_at, seq);
CREATE INDEX IF NOT EXISTS de_instructions_account_status ON de_instructions(account_id, status);

CREATE TABLE IF NOT EXISTS scheduled_payments (
  id                           TEXT PRIMARY KEY,    -- HayScheduledPayment.hayId
  seq                          INTEGER NOT NULL,
  account_id                   TEXT NOT NULL,
  customer_id                  TEXT NOT NULL,
  amount                       INTEGER NOT NULL,    -- positive cents
  currency                     TEXT NOT NULL,
  description                  TEXT,
  reference                    TEXT,
  type                         TEXT NOT NULL,       -- RECURRING | ONE_TIME
  frequency                    TEXT,                -- WEEKLY | FORTNIGHTLY | MONTHLY | QUARTERLY (RECURRING only)
  start_date                   TEXT NOT NULL,       -- YYYY-MM-DD
  end_date                     TEXT,
  number_of_payments           INTEGER,
  number_of_processed_payments INTEGER NOT NULL DEFAULT 0,
  next_run_date                TEXT,                -- YYYY-MM-DD of the next occurrence (NULL once terminal)
  last_processed_at            TEXT,
  should_cancel_on_failure     INTEGER NOT NULL DEFAULT 0,
  recipient                    TEXT NOT NULL,       -- JSON ScheduledPaymentRecipient
  status                       TEXT NOT NULL,       -- ACTIVE | CANCELLED | DELETED | FAILED | REJECTED | COMPLETED | REPLACED
  previous_versions            TEXT NOT NULL,       -- JSON array of HayArchivedScheduledPayment
  last_outcome                 TEXT,                -- ledger outcome of the last occurrence
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduled_payments_account ON scheduled_payments(account_id, seq);
CREATE INDEX IF NOT EXISTS scheduled_payments_due ON scheduled_payments(status, next_run_date);
`

registerSchema(DIRECT_ENTRY_SCHEMA)
