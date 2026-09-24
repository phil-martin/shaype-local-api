/**
 * bpay domain — spec §5.7 (docs/superpowers/specs/2026-09-24-shaype-local-api-design.md) and
 * docs/map/bpay.md. Owns the 6 "BPAY API" operations and publishes ctx.services.bpay (service.ts:
 * validate / validateBpay, saved billers, pay / post) for scheduled payments and mocks.
 *
 * Contract deviations:
 * - retrieveBillers answers `BPayBillerResponse[]` (paged) although the spec declares a single
 *   BPayBillerResponse (spec §4 "Contract fidelity"; docs/map/00-open-questions.md F1).
 * - updateBpayBiller's 204 carries no body although the spec declares an empty JSON object (E11).
 *
 * Decisions beyond the spec (all covered in test/bpay.test.ts):
 * - Directory: every 4–10 digit biller code is an active biller with synthesised names (shortName
 *   `BILLER <code>`, longName `BILLER LONG NAME <code>`, ANZSIC 9999, image
 *   https://billers.local/<code>.png); `000000` is deactivated (spec §5.7). The five Staging fixtures
 *   (docs/map/bpay.md §2) are seeded verbatim: their names and ANZSIC codes, accepted CRN lengths
 *   (7773: 8; 93849: 7/9/10; 93880: 12), amount bounds (7773 $20–$50,000; 93849 $10–$20,000; 93880
 *   $10–$4,000; 600015 exactly $104.00 — ICRNAMT) and 1016 as the deactivated biller. A CRN is valid
 *   when all digits, 2–20 long and of an accepted length; check digits are not modelled. A 3-digit code
 *   passes the schema (minLength 3) and fails the directory (4–10 digits).
 * - Failures map per surface: validateBpay / createBPayBiller -> 422 INVALID_BILLER_CODE /
 *   INVALID_REFERENCE; makeBpayPayment -> HTTP 200 REFUSED_BPAY_INVALID_BILLER_CODE / _REFERENCE /
 *   _PAYMENT (amount outside the biller's bounds).
 * - Saved billers: uniqueness per account among non-dismissed billers on the (billerCode, reference) pair
 *   (DUPLICATE_BILLER) and on the nickname, case-insensitive (DUPLICATE_BILLER_NAME): 409 on create (the
 *   contract's one Conflict), 422 on update. Status starts ACTIVE and is never exposed; retrieveBillers
 *   lists ACTIVE billers only (creation order, limit 1..1000 / offset >= 0 else 400) while
 *   retrieveBpayBiller returns a dismissed biller too. DISMISSED is terminal: any further PATCH is 422
 *   INVALID_STATE; a dismissed biller frees its name and reference. status outside ACTIVE / DISMISSED is
 *   400 (the schema has no enum). PATCH image overrides the directory logo.
 * - Payment: amount > 0 with <= 2 dp (400), account and senderCustomerHayId must exist (404) and the
 *   customer must hold the account (422 PERMISSION_DENIED, as makeTransfer). Check order: account status
 *   -> FX child (REFUSED_CAPABILITY_NOT_ENABLED) -> biller / CRN / amount -> BPAY_DAILY_LIMIT and
 *   TOTAL_SPEND_PER_YEAR (rolling windows, risk HIGH => 0) -> funds. Outcomes use this endpoint's enum:
 *   REFUSED_INSUFFICIENT_FUNDS, REFUSED_DAILY_BPAY_LIMIT_BREACHED (also for a TOTAL_SPEND_PER_YEAR breach,
 *   which has no value of its own here); the webhook keeps REFUSED_NOT_ENOUGH_FUNDS /
 *   REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED (spec §4). Refusals post nothing, emit no webhook
 *   and carry no transactionId; a refused outcome replays under its idempotencyKey (scope
 *   makeBpayPayment, the accountId part of the hashed request). No saved biller is needed and none is
 *   auto-saved. REFUSED_RECIPIENT_ACCOUNT_*, REFUSED_BPAY_REJECTED, INVALID_PAYMENT, INTERNAL_ERROR are
 *   never produced (no local trigger; late Cuscal rejections are not modelled).
 * - Accepted: BPAY_TRANSFER_OUT on CUSCAL_BPAY_TRANSFER_OUT, originType CUSTOMER, posted immediately (no
 *   hold), transaction reference = the CRN (the only place it can surface on FinancialTransaction),
 *   counterpartName = the request nickname or the biller's long name, description / category echoed
 *   (no default description). The TRANSACTION webhook (ledger) carries counterpartDetails { name,
 *   bpayDetails { billerCode, billerReference, billerName = long name, billerImage } }, actionOwner CLIENT.
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import './schema.js'
import { BpayRepo } from './repo.js'
import { BpayService } from './service.js'
import { registerEvents } from './events.js'
import { registerRoutes } from './routes.js'

export { BpayService, toBpayOutcome } from './service.js'
export type { BpayPostInput, BpayPostResult, BpayOutcome, BPayBillerResponse, BPayBillerDetails, BpayPaymentResponseBody } from './service.js'
export { STAGING_BILLERS, DEACTIVATED_BILLER_CODE, lookupBiller, validateDirectory, billerImage } from './directory.js'
export type { DirectoryBiller, DirectoryResult, DirectoryRefusal, CrnFailure } from './directory.js'
export type { SavedBiller, BillerStatus } from './repo.js'
export type { BillerChangeKind } from './events.js'

export function register(app: FastifyInstance, ctx: AppContext): void {
  const svc = new BpayService(ctx, new BpayRepo(ctx.db))
  ctx.services.bpay = svc
  registerEvents(ctx)
  registerRoutes(app, ctx, svc)
}
