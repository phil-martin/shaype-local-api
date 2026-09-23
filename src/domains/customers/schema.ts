import { registerSchema } from '../../db/index.js'

/** One row per HayCustomer. Nested blobs (address, customData, taxObligations) are JSON text. */
export const CUSTOMERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id                                TEXT PRIMARY KEY,
  seq                               INTEGER NOT NULL,        -- creation order
  status                            TEXT NOT NULL,           -- HayCustomer.status
  status_reason                     TEXT,                    -- INACTIVE reason (SUSPICIOUS|DECEASED|CUSTOMER|OPERATIONAL)
  blocked_by                        TEXT,                    -- CLIENT|PLATFORM while BLOCKED
  tier                              TEXT NOT NULL,
  email                             TEXT NOT NULL,
  phone_prefix                      TEXT NOT NULL,           -- countryCodePrefix without leading '+'
  phone_number                      TEXT NOT NULL,
  address                           TEXT NOT NULL,           -- JSON Address
  first_name                        TEXT NOT NULL,
  middle_name                       TEXT,
  last_name                         TEXT NOT NULL,
  preferred_name                    TEXT,
  title                             TEXT,
  gender                            TEXT,
  date_of_birth                     TEXT NOT NULL,           -- YYYY-MM-DD
  custom_data                       TEXT,                    -- JSON object or NULL
  external_customer_id              TEXT,
  device_id                         TEXT NOT NULL,
  identity_document_type            TEXT,
  identity_document_number          TEXT,
  identity_document_card_number     TEXT,
  identity_document_expiry          TEXT,
  identity_document_issuing_country TEXT,
  identity_document_region          TEXT,
  identity_verification_case_id     TEXT,
  skip_kyc                          INTEGER NOT NULL DEFAULT 0,
  only_sanctions_check              INTEGER NOT NULL DEFAULT 0,
  tax_obligations                   TEXT,                    -- JSON array or NULL (write-only in the API)
  block_note                        TEXT,
  created_at                        TEXT NOT NULL,
  approved_at                       TEXT,
  closed_at                         TEXT,
  updated_at                        TEXT
);
CREATE INDEX IF NOT EXISTS customers_seq ON customers(seq);
CREATE INDEX IF NOT EXISTS customers_email ON customers(email COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS customers_status ON customers(status);
`

registerSchema(CUSTOMERS_SCHEMA)
