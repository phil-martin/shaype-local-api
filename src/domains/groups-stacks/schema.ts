import { registerSchema } from '../../db/index.js'

/**
 * groups: one row per HayGroup (no lifecycle status — spec has none); membership in group_members
 * (join order kept for customerHayIds). stacks: one row per HayStack with its balance in INTEGER cents
 * (the account's `stacks` column is the sum of OPEN stack balances — accounts.adjust keeps it in step).
 * stack_transactions: the stack sub-ledger (HayStackTransaction), amount signed from the stack's
 * perspective (deposit +, withdrawal −; 00-transactions C12), never updated or deleted.
 */
export const GROUPS_STACKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id                   TEXT PRIMARY KEY,
  seq                  INTEGER NOT NULL,          -- creation order
  name                 TEXT NOT NULL,
  group_type           TEXT NOT NULL,             -- PERSONAL | BUSINESS
  business_identifiers TEXT,                      -- JSON BusinessIdentifiers, or NULL when none
  created_at           TEXT NOT NULL,
  updated_at           TEXT
);
CREATE INDEX IF NOT EXISTS groups_seq ON groups(seq);

CREATE TABLE IF NOT EXISTS group_members (
  group_id     TEXT NOT NULL,
  customer_id  TEXT NOT NULL,
  seq          INTEGER NOT NULL,                  -- join order
  PRIMARY KEY (group_id, customer_id)
);
CREATE INDEX IF NOT EXISTS group_members_customer ON group_members(customer_id);

CREATE TABLE IF NOT EXISTS stacks (
  id             TEXT PRIMARY KEY,
  seq            INTEGER NOT NULL,                -- creation order
  account_id     TEXT NOT NULL,
  name           TEXT NOT NULL,
  image_url      TEXT,
  target_amount  INTEGER,                         -- cents, NULL when no goal was set
  balance        INTEGER NOT NULL DEFAULT 0,      -- cents, >= 0
  status         TEXT NOT NULL,                   -- OPEN | CLOSED
  created_at     TEXT NOT NULL,
  closed_at      TEXT,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS stacks_account ON stacks(account_id, seq);

CREATE TABLE IF NOT EXISTS stack_transactions (
  id                         TEXT PRIMARY KEY,
  seq                        INTEGER NOT NULL,    -- posting order
  account_id                 TEXT NOT NULL,
  stack_id                   TEXT NOT NULL,
  amount                     INTEGER NOT NULL,    -- signed cents from the stack's perspective
  customer_id                TEXT,                -- initiator (absent on a platform sweep of a group account)
  notes                      TEXT,
  counterpart_transaction_id TEXT,                -- the other leg of a stack-to-stack transfer
  origin_id                  TEXT,
  origin_type                TEXT NOT NULL,       -- HayStackTransaction.originType
  type                       TEXT NOT NULL,       -- STANDARD | ROUND_UP
  transaction_time           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stack_transactions_account ON stack_transactions(account_id, seq);
CREATE INDEX IF NOT EXISTS stack_transactions_stack ON stack_transactions(stack_id, seq);
`

registerSchema(GROUPS_STACKS_SCHEMA)
