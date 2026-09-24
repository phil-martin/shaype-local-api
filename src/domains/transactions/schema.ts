import { registerSchema } from '../../db/index.js'

/**
 * The ledger (spec §5.3). `transactions` holds every posted FinancialTransaction (immutable except
 * tags); `holds` keeps card authorisation holds with their internal state; `transaction_tags` is the
 * per-transaction tag association ordered by creation. Money columns are INTEGER cents; transaction
 * amounts are signed (credits +, debits -), hold amounts are positive magnitudes.
 */
export const TRANSACTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id                     TEXT PRIMARY KEY,          -- transactionHayId
  seq                    INTEGER NOT NULL,          -- posting order
  account_id             TEXT NOT NULL,
  customer_id            TEXT NOT NULL,
  product_id             TEXT NOT NULL,
  type                   TEXT NOT NULL,             -- FinancialTransaction.type
  channel                TEXT NOT NULL,             -- FinancialTransaction.transactionChannel
  webhook_type           TEXT NOT NULL,             -- TransactionEventDto.transactionType used for the TRANSACTION webhook
  amount                 INTEGER NOT NULL,          -- signed cents
  currency               TEXT NOT NULL,
  original_amount        INTEGER,                   -- signed cents in the original spend currency (FX card spend)
  original_currency      TEXT,
  rolling_balance        INTEGER NOT NULL,          -- totalBalance after the posting (cents)
  transaction_time       TEXT NOT NULL,             -- initiated / authorised
  clearing_time          TEXT NOT NULL,             -- posted
  description            TEXT,
  category               TEXT,
  reference              TEXT,
  counterpart_name       TEXT,
  counterpart            TEXT,                      -- JSON counterpart details (accountId, customerId, name, basicAccountNumber, merchantDetails, bpayDetails)
  origin_type            TEXT,
  origin_id              TEXT,
  origin_channel         TEXT,
  card_id                TEXT,
  card_usage             TEXT,                      -- JSON CardUsageDetails (card transactions)
  related_hold_id        TEXT,
  country_of_expenditure TEXT,
  external_identifiers   TEXT,                      -- JSON array of {source, type, value}
  mandate_payment        TEXT,                      -- JSON ExternalMandatePaymentDetails
  return_reason          TEXT,                      -- JSON {code, message} (webhook only)
  limit_kinds            TEXT NOT NULL,             -- JSON array of the limit types this posting counts toward
  created_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transactions_account_clearing ON transactions(account_id, clearing_time);
CREATE INDEX IF NOT EXISTS transactions_clearing ON transactions(clearing_time);
CREATE INDEX IF NOT EXISTS transactions_transaction_time ON transactions(transaction_time);
CREATE INDEX IF NOT EXISTS transactions_related_hold ON transactions(related_hold_id);

CREATE TABLE IF NOT EXISTS transaction_tags (
  id             TEXT PRIMARY KEY,
  seq            INTEGER NOT NULL,                  -- createdAt order
  transaction_id TEXT NOT NULL,
  category       TEXT NOT NULL,
  value          TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (transaction_id, category, value)
);
CREATE INDEX IF NOT EXISTS transaction_tags_transaction ON transaction_tags(transaction_id, seq);

CREATE TABLE IF NOT EXISTS holds (
  id                     TEXT PRIMARY KEY,          -- holdHayId (== transactionHayId of the pending webhooks)
  seq                    INTEGER NOT NULL,
  account_id             TEXT NOT NULL,
  customer_id            TEXT NOT NULL,
  product_id             TEXT NOT NULL,
  card_id                TEXT NOT NULL,
  card_token             TEXT,
  last_four              TEXT,
  state                  TEXT NOT NULL,             -- AUTHORISED | SETTLED | REVERSED | CANCELLED
  type                   TEXT NOT NULL,             -- CARD_PRESENT_PAYMENT | CARD_NOT_PRESENT_PAYMENT | ATM_WITHDRAWAL
  channel                TEXT NOT NULL,
  amount                 INTEGER NOT NULL,          -- current hold amount, positive cents
  portions               TEXT NOT NULL,             -- JSON array of {amount, at}: the amount split by authorisation time (daily-limit windows)
  currency               TEXT NOT NULL,
  original_amount        INTEGER,
  original_currency      TEXT,
  description            TEXT,
  category               TEXT,
  merchant               TEXT,                      -- JSON ExternalMerchantDetails
  card_usage             TEXT,                      -- JSON CardUsageDetails
  country_of_expenditure TEXT,
  external_identifiers   TEXT,
  limit_kinds            TEXT NOT NULL,
  authorised_at          TEXT NOT NULL,
  updated_at             TEXT,
  closed_at              TEXT,
  settled_transaction_id TEXT
);
CREATE INDEX IF NOT EXISTS holds_account_state ON holds(account_id, state, seq);
`

registerSchema(TRANSACTIONS_SCHEMA)
