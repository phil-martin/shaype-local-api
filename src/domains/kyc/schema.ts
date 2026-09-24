import { registerSchema } from '../../db/index.js'

/**
 * kyc_cases: one row per identity-verification case (ExternalCase + the consent body it was created with).
 * kyc_onboarding_stages: the per-customer onboarding stage record the three approve*Check operations act on
 * (no schema exposes it; docs/map/kyc.md §2 "Onboarding stage record"). A row exists only once a stage
 * failed (platform outcome) or was approved (client operator).
 */
export const KYC_SCHEMA = `
CREATE TABLE IF NOT EXISTS kyc_cases (
  id                    TEXT PRIMARY KEY,
  seq                   INTEGER NOT NULL,        -- creation order
  customer_id           TEXT,                    -- set when createHayCustomer links the case (identityVerificationCaseId)
  outcome               TEXT NOT NULL,           -- NOT_EXECUTED | REJECTED | WARNING | PASSED
  created_at            TEXT NOT NULL,           -- ExternalCase.timestamp
  consent_obtained      TEXT,                    -- yes | no | na
  consent_obtained_at   TEXT,
  user_ip               TEXT,
  user_location_country TEXT NOT NULL,
  user_location_state   TEXT,
  mobile_token          TEXT NOT NULL,
  web_link              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kyc_cases_customer ON kyc_cases(customer_id);

CREATE TABLE IF NOT EXISTS kyc_onboarding_stages (
  customer_id        TEXT NOT NULL,
  stage              TEXT NOT NULL,              -- DOCUMENT_SCAN | SANCTIONS_SCAN | KYC_AML_SCAN | DUPLICATE_CHECK
  seq                INTEGER NOT NULL,           -- record order
  result             TEXT NOT NULL,              -- FAILED | APPROVED
  submission_failure INTEGER NOT NULL DEFAULT 0,
  comments           TEXT,
  failed_at          TEXT,
  approved_at        TEXT,
  PRIMARY KEY (customer_id, stage)
);
`

registerSchema(KYC_SCHEMA)
