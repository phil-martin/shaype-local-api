import { registerSchema } from '../../db/index.js'

/**
 * Saved BPAY billers ("just like contacts"): one row per BPayBillerResponse. The biller directory
 * itself (biller names, CRN rules, amount bounds) is static reference data in directory.ts, so only
 * the per-account saved record is persisted. `status` (ACTIVE | DISMISSED) is internal: the spec
 * exposes it on the PATCH body but on no response.
 */
export const BPAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS bpay_billers (
  id                   TEXT PRIMARY KEY,          -- BPayBillerResponse.hayId (== the billerId path param)
  seq                  INTEGER NOT NULL,          -- creation order
  account_id           TEXT NOT NULL,
  biller_code          TEXT NOT NULL,             -- as supplied (leading zeros kept, compared as a string)
  reference            TEXT NOT NULL,             -- customer reference number (CRN)
  name                 TEXT NOT NULL,             -- nickname
  image                TEXT,                      -- URL
  short_name           TEXT NOT NULL,             -- directory lookup at creation
  long_name            TEXT NOT NULL,
  industry_anzsic_code TEXT NOT NULL,
  status               TEXT NOT NULL,             -- ACTIVE | DISMISSED
  created_at           TEXT NOT NULL,
  updated_at           TEXT
);
CREATE INDEX IF NOT EXISTS bpay_billers_account ON bpay_billers(account_id, status, seq);
`

registerSchema(BPAY_SCHEMA)
