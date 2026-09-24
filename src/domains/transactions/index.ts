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
 * - Outcomes are computed in the webhook vocabulary and mapped per REST surface: the funds check is
 *   REFUSED_INSUFFICIENT_FUNDS on REST / REFUSED_NOT_ENOUGH_FUNDS on webhooks; limits with no REST value
 *   (annual spend, top-ups, PAYMENT_TO_ACCOUNT_NUMBER, card caps) answer REFUSED_LIMIT_BREACH; the v0
 *   create/transfer ops also collapse REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED / REFUSED_MAX_BALANCE_EXCEEDED.
 *   transactionId is omitted (not null) on a refused TransactionOutcome.
 * - Check order: account status -> limits (credits: MAX_BALANCE; general debits: daily transfers-out then
 *   TOTAL_SPEND_PER_YEAR; transfers: PAYMENT_TO_ACCOUNT_NUMBER, daily transfers-out, TOTAL_SPEND_PER_YEAR;
 *   holds: SINGLE_CARD_TRANSACTION, CARD_PAYMENTS_DAILY, + ATM_WITHDRAWAL_PER_DAY for ATM) -> funds. Risk
 *   level HIGH therefore refuses credits with REFUSED_MAX_BALANCE_EXCEEDED and debits with the daily
 *   transfers-out outcome. Daily / yearly usage sums posted transactions by transaction time plus open
 *   card holds by authorisation time, each counted against the limit types it was checked with.
 * - Refused general credits/debits and transfers post nothing and emit no webhook; refused card
 *   authorisations (and postings that opt in with notifyRefusal) emit TRANSACTION with the refused outcome,
 *   isPending false, unchanged balances and a fresh transactionHayId (the hold id for a refused increment).
 * - Request amounts are positive magnitudes with <= 2 dp (400 otherwise); the endpoint fixes the direction.
 *   A general credit/debit carries originType CUSTOMER only when the client sends it; transfers are stamped
 *   originType CUSTOMER. counterpartName is mirrored into counterpartDetails.name.
 * - Transfers: senderCustomerHayId must exist (404) and hold the account (422 PERMISSION_DENIED); the
 *   transfer-type object must be present (400); a local-BSB account number that does not exist and a
 *   transfer to the sending account itself are 422 INVALID_RECIPIENT; intrabank legs use
 *   HAAS_TRANSFER_INTERNAL_OUT/IN, NPP legs CUSCAL_NPP_TRANSFER_OUT; the response transactionId is the
 *   sender's posting; the recipient leg carries the sender as counterpart; PAY_ID without a loaded PayID
 *   service is REFUSED_INVALID_PAY_ID; the deprecated per-object reference is honoured when the top-level
 *   one is absent; the reference is stored on every transfer kind.
 * - Holds: card-only; retrievable in every state (currencyAmount negative, the last held amount);
 *   getPendingHolds lists AUTHORISED holds only; settlement bypasses status/limit/funds checks (reserved at
 *   authorisation), releases the whole hold and posts the settled amount (default the hold amount) with
 *   the hold's transaction time; a decrease by the whole amount is a full reversal; console cancellation is
 *   exposed as holds.cancel (CANCELLED, same webhook as a reversal). Account rules are evaluated here
 *   (REFUSED_RULES + ruleDetails); card status/preference refusals arrive pre-decided from the caller.
 *   Hold category defaults to the merchant category code. Hold events use the authorisation time.
 * - Search: both bounds inclusive on the sortBy timestamp, newest first, ties by posting order; an unknown
 *   accountId filter answers []; from > to, limit outside 1..1000 and a negative offset are 400.
 * - Tags: matching is exact (case-sensitive); an `id` may reference an association on another transaction
 *   (its pair is added here); an unknown id, an empty list, a missing operation or a malformed pair answer
 *   the spec's 400 text; unknown transaction ids are 404 (spec convention) rather than 422.
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

export { TransactionsService, HoldsService, toRestOutcome, defaultLimits, cardChannel, requestCents, WEBHOOK_TYPE, TAGS_400_MESSAGE } from './service.js'
export type { PostInput, PostResult, AuthoriseHoldInput, HoldResult, HoldOptions, CardContext, CallerRefusal, LedgerOutcome, RestOutcome, Money, SearchPage } from './service.js'
export type { LedgerTransaction, Hold, HoldState, HoldType, LedgerType, TransactionChannel, WebhookTransactionType, WebhookOutcome, CounterpartDetails, CardUsageDetails, OriginType, OriginChannel, ReturnReason, BpayDetails, SortBy } from './repo.js'
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
