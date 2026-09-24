/**
 * transactions domain — spec §5.3 (docs/superpowers/specs/2026-09-24-shaype-local-api-design.md) and
 * docs/map/transactions-holds.md. Owns the "Transactions API" and "Holds API" operations plus
 * getPendingHolds and makeTransferV0/V1 from the Accounts API. Publishes ctx.services.transactions
 * (service.ts: post / evaluate / apply, holds, transfer, search, tags) for cards, utilities, bpay,
 * direct-entry, stacks and payto, and registers the limit-usage provider with accounts.
 *
 * Contract deviations: none — every response follows the declared schema.
 *
 * Decisions beyond the spec (all covered in test/transactions.test.ts):
 * - Outcomes are computed in the ledger vocabulary (the webhook TransactionEventDto.outcome enum plus
 *   REFUSED_LIMIT_BREACH for limits with no dedicated value) and mapped per REST surface: the funds check
 *   is REFUSED_INSUFFICIENT_FUNDS on REST / REFUSED_NOT_ENOUGH_FUNDS on webhooks; limits with no REST
 *   value (annual spend, top-ups, card caps) answer REFUSED_LIMIT_BREACH; PAYMENT_TO_ACCOUNT_NUMBER /
 *   PAYMENT_TO_PAY_ID / OVERDRAFT_PRODUCT_LIMIT are REFUSED_LIMIT_BREACH everywhere and, having no webhook
 *   value, never produce a refusal webhook (00-balance §3.2 L3). Only createCredit/DebitTransactionV0
 *   collapse REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED / REFUSED_MAX_BALANCE_EXCEEDED (their spec
 *   description); makeTransferV0 is served exactly like V1. transactionId is omitted (not null) on a
 *   refused TransactionOutcome; a refused outcome replays under its idempotencyKey like an accepted one.
 * - Check order (00-balance §3.2): account status -> rails -> caller / rule refusals -> limits (credits:
 *   MAX_BALANCE; general debits: daily transfers-out then TOTAL_SPEND_PER_YEAR; transfers:
 *   PAYMENT_TO_ACCOUNT_NUMBER, daily transfers-out, TOTAL_SPEND_PER_YEAR, then the recipient's MAX_BALANCE;
 *   holds: SINGLE_CARD_TRANSACTION, CARD_PAYMENTS_DAILY, + ATM_WITHDRAWAL_PER_DAY for ATM) -> funds. Risk
 *   level HIGH therefore refuses credits with REFUSED_MAX_BALANCE_EXCEEDED, general debits with the daily
 *   transfers-out outcome and transfers with REFUSED_LIMIT_BREACH. Daily / yearly usage sums posted
 *   transactions by transaction time plus the dated portions of open card holds (the authorisation and each
 *   increment carry their own time; a decrease releases the newest portions first), each counted against
 *   the limit types it was checked with; a settlement counts from the hold's authorisation time.
 * - Refused general credits/debits and transfers post nothing and emit no webhook; refused card
 *   authorisations, increments and settlements (and postings that opt in with notifyRefusal) emit
 *   TRANSACTION with the refused outcome, isPending false, unchanged balances and a fresh transactionHayId
 *   (the hold id for a refused increment / settlement); a refused posting's origin, returnReason and
 *   mandatePaymentDetails ride along (a refused NPP return still says what it returns).
 * - Request amounts are positive magnitudes with <= 2 dp (400 otherwise); the endpoint fixes the direction.
 *   A general credit/debit carries originType CUSTOMER only when the client sends it; transfers are stamped
 *   originType CUSTOMER. counterpartName is mirrored into counterpartDetails.name.
 * - Transfers: senderCustomerHayId must exist (404) and hold the account (422 PERMISSION_DENIED); the
 *   transfer-type object must be present (400); a local-BSB account number that does not exist and a
 *   transfer to the sending account itself are 422 INVALID_RECIPIENT; intrabank legs use
 *   HAAS_TRANSFER_INTERNAL_OUT/IN, NPP legs CUSCAL_NPP_TRANSFER_OUT; the response transactionId is the
 *   sender's posting; the recipient leg carries the sender as counterpart, named by senderName or, when
 *   absent, the sending customer's first and last name; PAY_ID without a loaded PayID service is
 *   REFUSED_INVALID_PAY_ID; the deprecated per-object reference is honoured when the top-level one is
 *   absent; the reference is stored on every transfer kind. No FX (spec §4): an FX child account may
 *   only transfer INTERNAL and only between accounts of the same currency, else REFUSED_CAPABILITY_NOT_ENABLED.
 * - Holds: card-only; retrievable in every state (currencyAmount negative, the last held amount);
 *   getPendingHolds lists AUTHORISED holds only; settlement bypasses status/limit checks (reserved at
 *   authorisation), releases the whole hold and posts the settled amount (default the hold amount) with
 *   the hold's transaction time; a settlement larger than the hold funds-checks the excess
 *   (REFUSED_NOT_ENOUGH_FUNDS, hold left open) and a settlement of 0 is a 400 (reverse releases a hold);
 *   a decrease by the whole amount is a full reversal; console cancellation is exposed as holds.cancel
 *   (CANCELLED, same webhook as a reversal). Account rules are evaluated here (REFUSED_RULES +
 *   ruleDetails); card status/preference refusals arrive pre-decided from the caller and are applied after
 *   the account status gate. Hold category defaults to the merchant category code. Hold events use the
 *   authorisation time. An FX hold's original-currency amount follows increases / decreases at the
 *   authorisation's rate (rounded to the cent); every webhook renders it signed like currencyAmount,
 *   refusals included.
 * - Time: caller-supplied transactionTimeUtc and search bounds keep their microsecond digits (Date only
 *   holds milliseconds); a malformed value is a 400.
 * - Search: both bounds inclusive on the sortBy timestamp, newest first, ties by posting order; an unknown
 *   accountId filter answers []; from > to, limit outside 1..1000 and a negative offset are 400.
 * - Tags: matching is exact (case-sensitive); an ADD `id` may reference an association on another
 *   transaction (its pair is added here) but a category/value sent with it must agree (else 400); a REMOVE
 *   `id` must be an association on this transaction (one on another transaction is a no-op); an unknown
 *   id, an empty list, a missing operation or a malformed pair answer the spec's 400 text; unknown
 *   transaction ids are 404 (spec convention) rather than 422.
 * - TRANSACTION webhooks: one per owning customer, envelope cardHayId omitted (transactionEvent.cardHayId
 *   carries it, as in the docs samples), isAtmTransaction always present, merchantName omitted (null in
 *   every sample), counterpartDetails omitted when empty.
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import './schema.js'
import { assertDeps } from './deps.js'
import { TransactionRepo } from './repo.js'
import { TransactionsService } from './service.js'
import { registerEvents } from './events.js'
import { registerRoutes } from './routes.js'

export { TransactionsService, HoldsService, toRestOutcome, isWebhookOutcome, defaultLimits, cardChannel, requestCents, normaliseTime, WEBHOOK_TYPE, TAGS_400_MESSAGE } from './service.js'
export type { PostInput, PostResult, AuthoriseHoldInput, HoldResult, HoldOptions, CardContext, CallerRefusal, LedgerOutcome, RestOutcome, RefusalDetails, Money, SearchPage } from './service.js'
export type { LedgerTransaction, Hold, HoldPortion, HoldState, HoldType, LedgerType, TransactionChannel, WebhookTransactionType, WebhookOutcome, CounterpartDetails, CardUsageDetails, OriginType, OriginChannel, ReturnReason, BpayDetails, SortBy } from './repo.js'
export type { PayIdDep, ResolvedPayId, PayIdType } from './deps.js'
export type { HoldChangeKind, RefusedAttempt } from './events.js'

export function register(app: FastifyInstance, ctx: AppContext): void {
  const svc = new TransactionsService(ctx, new TransactionRepo(ctx.db))
  ctx.services.transactions = svc
  ctx.services.accounts.setUsageProvider((accountId, limitType, since) => svc.usage(accountId, limitType, since))
  registerEvents(ctx)
  registerRoutes(app, ctx, svc)
  app.addHook('onReady', async () => assertDeps(ctx))
}
