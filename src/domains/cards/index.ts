/**
 * cards domain — spec §5.4 (docs/superpowers/specs/2026-09-24-shaype-local-api-design.md) and docs/map/cards.md.
 * Owns the 19 "Cards API" operations and publishes ctx.services.cards (service.ts) for accounts (closure
 * cascade), customers (card list), groups (member removal), utilities (mock transactions, expiry date) and
 * the ledger (card-side authorisation checks). Card state changes emit CARD_STATUS_CHANGE; the expiry job
 * (scheduler tick) emits REMINDER / CARD_EXPIRY_* and flips expired cards.
 *
 * Contract deviations: none — every response follows the declared schema. rewards answers 201 on first
 * enrolment and 200 afterwards; its declared 429 is never produced (rate limiting is a non-goal).
 *
 * Decisions beyond the spec (all covered in test/cards.test.ts):
 * - createHayCard also requires the cardholder to hold the account (personal holder or group member):
 *   422 PERMISSION_DENIED otherwise; LOCKED / CLOSED accounts are 422 ACCOUNT_BLOCKED / ACCOUNT_CLOSED. The
 *   create pin must be 4–12 digits (400); nameOnCard keeps the case it was given (default: "first last"
 *   under 23 characters, else "F last"). Re-issue and renew apply the same customer / account gate.
 * - Same-state calls are idempotent no-ops with no webhook (block on BLOCKED, cancel on INACTIVE, PIN /
 *   CVV unblock when not blocked); illegal transitions are 422 INVALID_CARD_STATUS. unblockCard restores
 *   the status held before the block (ACTIVE for the documented case, AWAITING_ACTIVATION for a card
 *   blocked before activation) and also clears PLATFORM blocks. cancelCard is allowed from every
 *   non-INACTIVE status (EXPIRED included).
 * - Re-issue is allowed from ACTIVE, BLOCKED and EXPIRED (never AWAITING_ACTIVATION / INACTIVE); the new
 *   card gets a new PAN / token / CVV / expiry, copies name on card, delivery address (body override),
 *   phone, design and PIN, and starts with default preferences and fresh PIN / CVV tries; wallet tokens of
 *   the old card are disabled. Renew is allowed from ACTIVE only, within 2 months before the expiry date
 *   (422 RENEWAL_WINDOW), once per card; the renewal shares PAN and token, copies preferences and takes over
 *   the wallet tokens; a VIRTUAL renewal retires the old card immediately, a PHYSICAL one on activation.
 * - Preferences are stored as given (cardEnabled true / mobileWalletPaymentsEnabled true by default) and
 *   never derived from status; updatePaymentPreferences needs ACTIVE (docs sentence; the per-phase table is
 *   ignored). changeCardPin needs ACTIVE or AWAITING_ACTIVATION and never answers 403 locally (every client
 *   holds the privilege). rewards / PIN / CVV unblock refuse INACTIVE and EXPIRED cards.
 * - Expiry tick: ACTIVE / AWAITING_ACTIVATION cards past their expiry date become EXPIRED (PLATFORM);
 *   reminders CARD_EXPIRY_MONTH / 2_WEEK / DAY go once each to non-terminal, not-yet-renewed cards once
 *   their threshold is reached (a clock jump past several thresholds sends every reminder due). BLOCKED
 *   cards do not expire (they keep their status). setExpiryDate normalises to the month end, restarts the
 *   reminders and expires a card whose new date is already past.
 * - Authorisation vocabulary: BLOCKED -> REFUSED_CARD_PREFERENCE / CARD_BLOCKED / REFUSED_CARD_BLOCKED;
 *   EXPIRED -> REFUSED_RULES / EXPIRED_CARD; AWAITING_ACTIVATION or INACTIVE -> REFUSED_RULES /
 *   CARD_IS_NOT_ACTIVE (the critics' processor-decline mapping); preference declines carry
 *   REFUSED_CARD_PREFERENCE with the matching cardPreferenceOutcome; a blocked PIN (ATM / chip) or CVV
 *   (card not present) -> REFUSED_RULES with ALLOWED_PIN_RETRIES_EXCEEDED / CVV2_FAILURE. Wallet payments
 *   are gated by mobileWalletPaymentsEnabled alone (cardEnabled does not override it).
 * - Digital wallets are provisioned through the service (provisionWallet, ACTIVE cards only) with a
 *   CARD_ADDED_TO_WALLET webhook; the read lists tokens in both ACTIVE_TOKEN and INACTIVE_TOKEN states and
 *   reports the provider as APPLE / GOOGLE / SAMSUNG / DEFAULT. OEM provisioning data is plain (no encryption).
 * - Webhook actionOwner: CLIENT for API-driven changes including the renewal cascade on activation;
 *   PLATFORM for expiry, wallet provisioning and the account-closure / group-removal cascades.
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import './schema.js'
import { CardRepo } from './repo.js'
import { CardsService } from './service.js'
import { registerEvents } from './events.js'
import { registerRoutes } from './routes.js'

export { CardsService, DEFAULT_PREFERENCES, MAX_CVV_TRIES, MAX_PIN_TRIES, EXPIRY_YEARS, RENEWAL_WINDOW_MONTHS, defaultNameOnCard, expiryDateFrom, addMonthsClamped } from './service.js'
export type { CreateCardInput, ReissueInput, RenewInput, StatusOptions, CardRefusal, CardCheckInput, CardHoldInput, HayCard, CardPreferenceOutcome, CardProcessorResponse } from './service.js'
export type { Card, CardStatus, CardType, CardPreferences, BlockedBy, DeliveryMethod, ExpiryReminderType, Wallet, WalletType, WalletStatus } from './repo.js'

export function register(app: FastifyInstance, ctx: AppContext): void {
  const svc = new CardsService(ctx, new CardRepo(ctx.db))
  ctx.services.cards = svc
  registerEvents(ctx)
  registerRoutes(app, ctx, svc)
  ctx.scheduler.onTick(() => svc.tick())
}
