import { registerSchema } from '../../db/index.js'

/**
 * cards: one row per HayCard plus the create-time configuration the API never reads back (delivery
 * address, phone, names, design, PIN) because re-issue copies it. The PAN is stored but only its last
 * four digits are ever exposed; the PIN is a salted hash. Preferences are the six CardPaymentPreferences
 * booleans. card_wallets holds the digital-wallet tokens (device provisioning is outside the B2B API;
 * the local implementation provisions them through the service for tests).
 */
export const CARDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id                     TEXT PRIMARY KEY,
  seq                    INTEGER NOT NULL,          -- creation order
  account_id             TEXT NOT NULL,
  customer_id            TEXT NOT NULL,
  status                 TEXT NOT NULL,             -- ACTIVE | AWAITING_ACTIVATION | BLOCKED | INACTIVE | EXPIRED
  status_before_block    TEXT,                      -- status restored by unblockCard
  card_type              TEXT NOT NULL,             -- PHYSICAL | VIRTUAL
  blocked_by             TEXT,                      -- CLIENT | PLATFORM while BLOCKED
  block_note             TEXT,
  pan                    TEXT NOT NULL,             -- never exposed beyond lastFourDigits
  card_token             TEXT NOT NULL,             -- 9-digit public token (shared by a renewed card and its renewal)
  cvv                    TEXT NOT NULL,             -- never exposed
  expiry_date            TEXT NOT NULL,             -- YYYY-MM-DD, always a month end
  issued_at              TEXT NOT NULL,
  void_at                TEXT,
  renewed_into_card_id   TEXT,
  replaced_by_card_id    TEXT,                      -- re-issue bookkeeping (not on HayCard)
  delivery_method        TEXT NOT NULL,
  delivery_address       TEXT NOT NULL,             -- JSON Address
  phone_number           TEXT NOT NULL,             -- JSON PhoneNumber
  email                  TEXT NOT NULL,
  first_name             TEXT NOT NULL,
  last_name              TEXT NOT NULL,
  title                  TEXT,
  card_sub_design        TEXT NOT NULL,
  name_on_card           TEXT NOT NULL,
  name_on_card_line2     TEXT,
  pin_hash               TEXT NOT NULL,
  pin_enabled            INTEGER NOT NULL DEFAULT 1,
  pin_remaining_tries    INTEGER NOT NULL DEFAULT 3,
  cvv_remaining_tries    INTEGER NOT NULL DEFAULT 3,
  pref_card_enabled      INTEGER NOT NULL DEFAULT 1,
  pref_card_not_present  INTEGER NOT NULL DEFAULT 0,
  pref_cash_withdrawal   INTEGER NOT NULL DEFAULT 0,
  pref_contactless       INTEGER NOT NULL DEFAULT 0,
  pref_magnetic_stripe   INTEGER NOT NULL DEFAULT 0,
  pref_mobile_wallet     INTEGER NOT NULL DEFAULT 1,
  rewards_enrolled       INTEGER NOT NULL DEFAULT 0,
  reminders_sent         TEXT NOT NULL DEFAULT '[]', -- JSON array of CARD_EXPIRY_* reminder types already sent
  created_at             TEXT NOT NULL,
  updated_at             TEXT
);
CREATE INDEX IF NOT EXISTS cards_seq ON cards(seq);
CREATE INDEX IF NOT EXISTS cards_account ON cards(account_id, seq);
CREATE INDEX IF NOT EXISTS cards_customer ON cards(customer_id, seq);
CREATE INDEX IF NOT EXISTS cards_token ON cards(card_token);
CREATE INDEX IF NOT EXISTS cards_status_expiry ON cards(status, expiry_date);

CREATE TABLE IF NOT EXISTS card_wallets (
  id                          TEXT PRIMARY KEY,
  seq                         INTEGER NOT NULL,
  card_id                     TEXT NOT NULL,
  wallet_type                 TEXT NOT NULL,        -- DEFAULT_WALLET | APPLE_WALLET | ANDROID_WALLET | SAMSUNG_WALLET
  status                      TEXT NOT NULL,        -- ACTIVE_TOKEN | INACTIVE_TOKEN
  reference                   TEXT NOT NULL,        -- the digitiser's token reference
  primary_account_identifier  TEXT NOT NULL,
  created_at                  TEXT NOT NULL,
  expires_at                  TEXT NOT NULL         -- card expiry date
);
CREATE INDEX IF NOT EXISTS card_wallets_card ON card_wallets(card_id, seq);
`

registerSchema(CARDS_SCHEMA)
