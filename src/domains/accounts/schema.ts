import { registerColumn, registerSchema } from '../../db/index.js'

/**
 * accounts: one row per HayAccount. Money columns are INTEGER cents (spec §5.2 balance model):
 * ledger = net settled postings (may be negative when overdrawn; includes money earmarked in stacks),
 * held / locked / stacks = positive magnitudes, overdraft_limit = the facility. Everything else on
 * HayAccount is derived (see service.ts computeBalances).
 */
export const ACCOUNTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id                   TEXT PRIMARY KEY,
  seq                  INTEGER NOT NULL,          -- creation order
  holder_type          TEXT NOT NULL,             -- CUSTOMER | GROUP
  holder_id            TEXT NOT NULL,             -- customerHayId | groupHayId
  product_id           TEXT NOT NULL,
  account_number       TEXT NOT NULL UNIQUE,
  bsb                  TEXT NOT NULL,
  currency             TEXT NOT NULL,
  status               TEXT NOT NULL,             -- HayAccount.status (LOCKED stored; webhook renders BLOCKED)
  blocked_by           TEXT,                      -- CLIENT | PLATFORM while LOCKED
  block_note           TEXT,
  blocked_customer_ids TEXT,                      -- JSON array: customers held BLOCKED by this block (released when the last such LOCKED account is unblocked)
  parent_account_id    TEXT,                      -- FX child accounts only
  custom_data          TEXT,                      -- JSON object, or NULL when none
  ledger               INTEGER NOT NULL DEFAULT 0,
  held                 INTEGER NOT NULL DEFAULT 0,
  locked               INTEGER NOT NULL DEFAULT 0,
  stacks               INTEGER NOT NULL DEFAULT 0,
  overdraft_limit      INTEGER NOT NULL DEFAULT 0,
  risk_level           TEXT NOT NULL,             -- HIGH | LOW
  cop_opt_out          INTEGER NOT NULL DEFAULT 0,
  close_reason         TEXT,                      -- SUSPICIOUS | DECEASED | CUSTOMER | OPERATIONAL
  created_at           TEXT NOT NULL,
  closed_at            TEXT,
  updated_at           TEXT
);
CREATE INDEX IF NOT EXISTS accounts_seq ON accounts(seq);
CREATE INDEX IF NOT EXISTS accounts_holder ON accounts(holder_type, holder_id);
CREATE INDEX IF NOT EXISTS accounts_parent ON accounts(parent_account_id);

-- Account-level limit overrides (effective = override if set else product limit).
CREATE TABLE IF NOT EXISTS account_limits (
  account_id   TEXT NOT NULL,
  limit_type   TEXT NOT NULL,
  amount       INTEGER NOT NULL,                  -- cents
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (account_id, limit_type)
);

-- Merchant blocking rules evaluated on card authorisations.
CREATE TABLE IF NOT EXISTS account_rules (
  id           TEXT PRIMARY KEY,
  seq          INTEGER NOT NULL,
  account_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  rule_type    TEXT NOT NULL,                     -- MERCHANT_CODE_BLOCK | MERCHANT_ID_BLOCK | MERCHANT_NAME_BLOCK
  rule_details TEXT NOT NULL,                     -- JSON RuleDetails as submitted
  owner_id     TEXT NOT NULL,                     -- account holder id
  disabled     INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT,                              -- ISO UTC, NULL = never
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS account_rules_account ON account_rules(account_id, seq);
`

registerSchema(ACCOUNTS_SCHEMA)
// set when closeAccount accepts the closure (202): movements are refused until the asynchronous cascade closes the account
registerColumn('accounts', 'close_requested_at', 'TEXT')
