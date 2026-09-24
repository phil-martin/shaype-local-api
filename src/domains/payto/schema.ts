import { registerSchema } from '../../db/index.js'

/**
 * PayTo tables: one row per mandate (party details and payment terms as JSON), its MMS action log,
 * its payment instructions (adhoc, scheduled, inbound RAPAIN, stubbed) and the single next scheduled
 * payment of a non-ADHOC mandate. Ids are hyphenated lowercase UUIDs in the v1 layout the spec's
 * action DTOs demand; the 32-hex MMS form is derived on the way out and accepted on the way in.
 */
export const PAYTO_SCHEMA = `
CREATE TABLE IF NOT EXISTS mandates (
  id                      TEXT PRIMARY KEY,
  seq                     INTEGER NOT NULL,        -- creation order
  status                  TEXT NOT NULL,           -- CREATED|ACTIVE|SUSPENDED|CANCELLED
  cx_status               TEXT NOT NULL,           -- MMS cx extended status
  creditor_account_id     TEXT,                    -- local creditor account (NULL when the initiator is external, mock-created)
  creditor                TEXT NOT NULL,           -- JSON PartyDetails
  debtor_account_id       TEXT,                    -- local debtor account when the payer is on the platform
  debtor_account_number   TEXT,                    -- BSB + account number (getMandates.accountIds)
  debtor                  TEXT NOT NULL,           -- JSON PartyDetails
  description             TEXT,
  purpose_code            TEXT,
  transfer_arrangement    TEXT,
  validity_start_date     TEXT NOT NULL,           -- YYYY-MM-DD
  validity_end_date       TEXT,
  payment_terms           TEXT NOT NULL,           -- JSON PaymentTerms (cents)
  resolution_requested_by TEXT,
  suspended_by            TEXT,                    -- INITIATOR|PAYER|PLATFORM while SUSPENDED
  last_due_date           TEXT,                    -- due date of the last scheduled payment initiated (never scheduled again)
  registration_date_time  TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT
);
CREATE INDEX IF NOT EXISTS mandates_seq ON mandates(seq);
CREATE INDEX IF NOT EXISTS mandates_creditor ON mandates(creditor_account_id);
CREATE INDEX IF NOT EXISTS mandates_debtor_account ON mandates(debtor_account_id);
CREATE INDEX IF NOT EXISTS mandates_debtor_number ON mandates(debtor_account_number);
CREATE INDEX IF NOT EXISTS mandates_validity ON mandates(status, validity_end_date);

CREATE TABLE IF NOT EXISTS mandate_actions (
  id                            TEXT PRIMARY KEY,
  mandate_id                    TEXT NOT NULL,
  seq                           INTEGER NOT NULL,
  type                          TEXT NOT NULL,     -- AMEND|CREATE|PORT|STATUS_CHANGE
  status                        TEXT NOT NULL,     -- COMPLETED|DECLINED|PENDING|RECALLED|TIMED_OUT
  bilateral                     INTEGER,           -- NULL for status changes
  party_role                    TEXT NOT NULL,     -- creationEvent.partyRole: DEBTOR|PAYMENT_INITIATOR
  creation_time                 TEXT NOT NULL,     -- ISO ms UTC
  resolution_time               TEXT,
  resolution_reason_code        TEXT,
  resolution_reason_description TEXT,
  details                       TEXT,              -- JSON GetMandateActionsDetailsDto
  proposal                      TEXT,              -- JSON internal proposed changes of a pending AMEND
  expiry_time                   TEXT,
  resolution_requested_by       TEXT,
  cx_event_name_creation        TEXT,
  cx_event_name_resolution      TEXT
);
CREATE INDEX IF NOT EXISTS mandate_actions_mandate ON mandate_actions(mandate_id, seq);
CREATE INDEX IF NOT EXISTS mandate_actions_pending ON mandate_actions(status, expiry_time);

CREATE TABLE IF NOT EXISTS mandate_instructions (
  id                  TEXT PRIMARY KEY,            -- 35-char NPP instruction id
  mandate_id          TEXT NOT NULL,
  seq                 INTEGER NOT NULL,
  origin              TEXT NOT NULL,               -- ADHOC|SCHEDULED|INBOUND|STUB
  amount              INTEGER NOT NULL,            -- cents, positive
  currency            TEXT NOT NULL,
  end_to_end_id       TEXT NOT NULL,
  description         TEXT,
  status              TEXT NOT NULL,               -- PaymentInstruction.transactionStatus
  reason_code         TEXT,
  transaction_id      TEXT,                        -- ledger posting (creditor leg when local, else debtor leg)
  creation_date_time  TEXT NOT NULL,
  updated_at          TEXT
);
CREATE INDEX IF NOT EXISTS mandate_instructions_mandate ON mandate_instructions(mandate_id, seq);

CREATE TABLE IF NOT EXISTS mandate_schedules (
  notification_id   TEXT PRIMARY KEY,              -- MANDATE_DUE_PAYMENT.notificationId
  mandate_id        TEXT NOT NULL UNIQUE,          -- only the next payment is ever scheduled
  due_date          TEXT NOT NULL,                 -- YYYY-MM-DD
  payment_date_time TEXT NOT NULL,                 -- isoUtc: when the PIR is initiated
  amount            INTEGER,                       -- cents set through setScheduledPaymentInitiationRequestAmount
  announce          INTEGER NOT NULL DEFAULT 0,    -- 1: MANDATE_DUE_PAYMENT is sent (USAGE_BASED / VARIABLE terms)
  announced_at      TEXT,                          -- when MANDATE_DUE_PAYMENT was sent
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mandate_schedules_due ON mandate_schedules(payment_date_time);
`

registerSchema(PAYTO_SCHEMA)
