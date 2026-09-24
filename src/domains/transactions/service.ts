/**
 * The ledger (spec §5.3): the post() engine (account status, limit and funds checks; the
 * APPROVED -> ACTIVE flip through accounts.adjust; rollingAccountBalance), card authorisation holds
 * (authorise / increase / decrease / reverse / cancel / settle), general credit/debit, transfers,
 * search and tags. Emits one domain event per state change (events.ts maps them to TRANSACTION
 * webhooks) and publishes itself as ctx.services.transactions for cards, utilities, bpay,
 * direct-entry, stacks and payto.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import type { AppContext } from '../../context.js'
import { compact, type ActionOwner } from '../../events/notify.js'
import { isoUtc } from '../../lib/clock.js'
import { badRequest, notFound, unprocessable } from '../../lib/errors.js'
import { LOCAL_BSB, uuid } from '../../lib/ids.js'
import { fromCents, hasAtMostTwoDecimals, toCents, type Cents } from '../../lib/money.js'
import type { InternalLimitType, LimitOutcome } from '../accounts/products.js'
import type { Account } from '../accounts/repo.js'
import { computeBalances, type Balances } from '../accounts/service.js'
import type { Customer } from '../customers/repo.js'
import { deps } from './deps.js'
import type { HoldChangeKind, RefusedAttempt } from './events.js'
import type {
  AuthorisationHold, CardUsageDetails, CounterpartDetails, CountryOfExpenditure, ExternalIdentifier, ExternalMerchantDetails, FinancialTransaction, Hold,
  HoldPortion, HoldType, LedgerTransaction, LedgerType, MandatePaymentDetails, OriginChannel, OriginType, ReturnReason, SortBy, TagRow, TransactionChannel,
  TransactionRepo, WebhookOutcome, WebhookTransactionType,
} from './repo.js'

type S = components['schemas']
export type TransactionOutcome = S['TransactionOutcome']
export type RestOutcome = NonNullable<TransactionOutcome['outcome']>
export type CreateTransactionRequestBody = S['CreateTransactionRequestBody']
export type TransferOutRequestBody = S['TransferOutRequestBody']
export type SearchTransactionsRequestBody = S['SearchTransactionsRequestBody']
export type ModifyTagsRequestBody = S['ModifyTagsRequestBody']
export type TagsResponseBody = S['TagsResponseBody']
export type Tag = S['Tag']

/**
 * Ledger outcome vocabulary: the webhook TransactionEventDto.outcome enum (the superset of every REST
 * surface) plus the two REST-only values the ledger produces — REFUSED_LIMIT_BREACH (limits with no
 * dedicated value) and REFUSED_INVALID_PAY_ID. Only WebhookOutcome values reach a TRANSACTION webhook.
 */
export type LedgerOutcome = WebhookOutcome | RestOnlyOutcome
type RestOnlyOutcome = 'REFUSED_LIMIT_BREACH' | 'REFUSED_INVALID_PAY_ID'
const REST_ONLY_OUTCOMES: ReadonlySet<string> = new Set<RestOnlyOutcome>(['REFUSED_LIMIT_BREACH', 'REFUSED_INVALID_PAY_ID'])

/** docs/map/00-balance.md §3.2 L3: an outcome with no webhook value produces no webhook. */
export function isWebhookOutcome(outcome: LedgerOutcome): outcome is WebhookOutcome {
  return !REST_ONLY_OUTCOMES.has(outcome)
}

export interface Money { amountCents: Cents; currency: string }

export interface PostInput {
  /** The posting's id; default a fresh uuid. Direct entry posts an outbound DD's credit leg under the DD transactionId (00-open-questions I3). */
  id?: string
  accountId: string
  /** signed cents: credit > 0, debit < 0 */
  amountCents: Cents
  type: LedgerType
  channel: TransactionChannel
  /** TRANSACTION webhook transactionType; defaults per ledger type (WEBHOOK_TYPE). */
  webhookType?: WebhookTransactionType
  counterpart?: CounterpartDetails
  description?: string
  category?: string
  reference?: string
  originType?: OriginType
  originId?: string
  originChannel?: OriginChannel
  relatedHoldId?: string
  /** ISO date-time (microseconds preserved); defaults to now. clearingTimeUtc is always now. 400 when malformed. */
  transactionTimeUtc?: string
  cardId?: string
  cardUsage?: CardUsageDetails
  countryOfExpenditure?: CountryOfExpenditure
  externalIdentifiers?: ExternalIdentifier[]
  originalAmount?: Money
  mandatePayment?: MandatePaymentDetails
  returnReason?: ReturnReason
  /** Limit types to check, in order; default defaultLimits(type, amount). Also what the posting counts toward afterwards. */
  limits?: InternalLimitType[]
  /** false skips the status / limit / funds checks (settlement of an authorised hold: funds were reserved). Default true. */
  checks?: boolean
  /** Held cents released atomically with the posting (hold settlement). */
  releaseHeldCents?: Cents
  /** Webhook actionOwner: CLIENT when an API call caused the posting, PLATFORM (default) otherwise. */
  actionOwner?: ActionOwner
  /** Emit a TRANSACTION webhook with the refused outcome (card authorisations do; the general ops do not). Skipped when the outcome has no webhook value. */
  notifyRefusal?: boolean
}

export interface PostResult { outcome: LedgerOutcome; transaction?: LedgerTransaction }

/** Pre-validated card context supplied by the cards / utilities domains (card status and preferences are theirs). */
export interface CardContext {
  cardHayId: string
  cardToken?: string
  lastFour?: string
  cardUsage?: CardUsageDetails
  merchant?: ExternalMerchantDetails
}

/** Refusal decided by the caller (card status, preferences, processor decline): nothing is held, the refused webhook is emitted. */
export interface CallerRefusal {
  outcome: WebhookOutcome
  cardPreferenceOutcome?: RefusedAttempt['cardPreferenceOutcome']
  cardProcessorResponse?: RefusedAttempt['cardProcessorResponse']
}

export interface AuthoriseHoldInput {
  accountId: string
  card: CardContext
  /** positive cents */
  amountCents: Cents
  /** default from cardUsage: ATM -> ATM_WITHDRAWAL, card present -> CARD_PRESENT_PAYMENT, else CARD_NOT_PRESENT_PAYMENT */
  type?: HoldType
  /** default from cardUsage / type (VISA_ATM, VISA_CONTACTLESS, VISA_CARD_PRESENT, VISA_CARD_NOT_PRESENT, APPLE_PAY_*), _INTERNATIONAL when the original currency differs */
  channel?: TransactionChannel
  /** positive cents, like amountCents; webhooks and reads render it negative */
  originalAmount?: Money
  description?: string
  category?: string
  countryOfExpenditure?: CountryOfExpenditure
  externalIdentifiers?: ExternalIdentifier[]
  refusal?: CallerRefusal
  /** default: SINGLE_CARD_TRANSACTION, CARD_PAYMENTS_DAILY (+ ATM_WITHDRAWAL_PER_DAY for ATM) */
  limits?: InternalLimitType[]
  actionOwner?: ActionOwner
  transactionTimeUtc?: string
}

export interface HoldResult { outcome: LedgerOutcome; hold?: Hold; transaction?: LedgerTransaction }

export interface HoldOptions { actionOwner?: ActionOwner }

export interface SearchPage { limit: number; offset: number; sortBy?: SortBy }

/** What a refusal webhook needs beyond the account snapshot and the outcome. */
export type RefusalDetails = Omit<RefusedAttempt, 'account' | 'balances' | 'actionOwner' | 'outcome'>

declare module '../../context.js' {
  interface ServiceMap {
    transactions: TransactionsService
  }
}

export const TAGS_400_MESSAGE = 'BAD_REQUEST: Invalid request - tag validation failed, list is empty, or operation is missing'
const TAG_RE = /^\S(.*\S)?$/
const BSB_RE = /^\d{6}$/
const ACCOUNT_NUMBER_RE = /^\d{5,9}$/
/** Fractional seconds of an ISO date-time (before the zone designator, if any). */
const ISO_FRACTION_RE = /[.,](\d+)(?:Z|[+-]\d{2}:?\d{2})?$/i

/** TransactionOutcome.outcome — the 21 REST values. */
const REST_OUTCOMES: ReadonlySet<string> = new Set([
  'ACCEPTED', 'INTERNAL_ERROR', 'REFUSED_LIMIT_BREACH', 'REFUSED_FRAUD', 'REFUSED_CUSTOMER_PREFERENCE', 'REFUSED_INSUFFICIENT_FUNDS',
  'REFUSED_ACCOUNT_BLOCKED', 'REFUSED_RECIPIENT_ACCOUNT_BLOCKED', 'REFUSED_ACCOUNT_CLOSED', 'REFUSED_RECIPIENT_ACCOUNT_CLOSED', 'REFUSED_INVALID_PAY_ID',
  'UNKNOWN', 'REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED', 'REFUSED_MAX_BALANCE_EXCEEDED', 'REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED',
  'REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED', 'REFUSED_TOTAL_NET_VISA_DAILY_LIMIT_BREACHED', 'REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED',
  'REFUSED_SENDER_ACCOUNT_NOT_VERIFIED', 'REFUSED_CAPABILITY_NOT_ENABLED', 'REFUSED_QUOTE_EXPIRED',
])

/**
 * Ledger outcome -> TransactionOutcome.outcome: the funds check is REFUSED_INSUFFICIENT_FUNDS on REST,
 * limits without a REST value collapse to REFUSED_LIMIT_BREACH, and the deprecated v0 create ops
 * (`legacy`) also collapse the two detailed limit outcomes to REFUSED_LIMIT_BREACH (spec v0 description).
 */
export function toRestOutcome(outcome: LedgerOutcome, opts: { legacy?: boolean } = {}): RestOutcome {
  let o: string = outcome
  if (o === 'REFUSED_NOT_ENOUGH_FUNDS') o = 'REFUSED_INSUFFICIENT_FUNDS'
  if (opts.legacy && (o === 'REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED' || o === 'REFUSED_MAX_BALANCE_EXCEEDED')) o = 'REFUSED_LIMIT_BREACH'
  if (!REST_OUTCOMES.has(o)) o = o.includes('LIMIT') ? 'REFUSED_LIMIT_BREACH' : o === 'REFUSED_RULES' || o === 'REFUSED_CARD_PREFERENCE' ? 'REFUSED_CUSTOMER_PREFERENCE' : 'UNKNOWN'
  return o as RestOutcome
}

/**
 * TRANSACTION webhook transactionType per ledger type. An NPP return is emitted under INTERBANK_TRANSFER_OUT
 * like the docs sample; BPAY_TRANSFER_IN (a BPAY-funded top-up, no docs sample) maps to HAY_TOP_UP ("An
 * account top-up") [decision].
 */
export const WEBHOOK_TYPE: Record<LedgerType, WebhookTransactionType> = {
  CARD_PRESENT_PAYMENT: 'CARD_TRANSACTION_SETTLED',
  CARD_NOT_PRESENT_PAYMENT: 'CARD_TRANSACTION_SETTLED',
  ATM_WITHDRAWAL: 'CARD_TRANSACTION',
  CARD_PAYMENT_REVERSAL: 'CARD_TRANSACTION_REFUND',
  INTRABANK_TRANSFER_IN: 'INTRABANK_TRANSFER_IN',
  INTRABANK_TRANSFER_OUT: 'INTRABANK_TRANSFER_OUT',
  INTERBANK_TRANSFER_IN: 'INTERBANK_TRANSFER_IN',
  INTERBANK_TRANSFER_OUT: 'INTERBANK_TRANSFER_OUT',
  INTERBANK_TRANSFER_OUT_REVERSAL: 'INTERBANK_TRANSFER_OUT',
  DIRECT_DEBIT_TRANSFER: 'DIRECT_DEBIT_TRANSFER',
  GENERAL_CREDIT: 'GENERAL_CREDIT',
  GENERAL_DEBIT: 'GENERAL_DEBIT',
  ORIGINAL_CREDIT: 'ORIGINAL_CREDIT',
  BPAY_TRANSFER_OUT: 'BPAY_TRANSFER_OUT',
  BPAY_TRANSFER_IN: 'HAY_TOP_UP',
}

const CARD_LIMITS: InternalLimitType[] = ['SINGLE_CARD_TRANSACTION', 'CARD_PAYMENTS_DAILY']
const ATM_LIMITS: InternalLimitType[] = ['SINGLE_CARD_TRANSACTION', 'ATM_WITHDRAWAL_PER_DAY', 'CARD_PAYMENTS_DAILY']
const TRANSFER_OUT_LIMITS: InternalLimitType[] = ['PAYMENT_TO_ACCOUNT_NUMBER', 'TRANSFERS_OUT_PER_DAY', 'TOTAL_SPEND_PER_YEAR']

const DEBIT_LIMITS: Partial<Record<LedgerType, InternalLimitType[]>> = {
  GENERAL_DEBIT: ['TRANSFERS_OUT_PER_DAY', 'TOTAL_SPEND_PER_YEAR'],
  INTRABANK_TRANSFER_OUT: TRANSFER_OUT_LIMITS,
  INTERBANK_TRANSFER_OUT: TRANSFER_OUT_LIMITS,
  DIRECT_DEBIT_TRANSFER: ['DIRECT_DEBIT_PER_DAY'],
  BPAY_TRANSFER_OUT: ['BPAY_DAILY_LIMIT', 'TOTAL_SPEND_PER_YEAR'],
  ATM_WITHDRAWAL: ATM_LIMITS,
  CARD_PRESENT_PAYMENT: CARD_LIMITS,
  CARD_NOT_PRESENT_PAYMENT: CARD_LIMITS,
}
const CREDIT_EXTRA_LIMITS: Partial<Record<LedgerType, InternalLimitType[]>> = {
  INTERBANK_TRANSFER_IN: ['BANK_TRANSFER_TOP_UP_PER_DAY'],
}

/** Limits a posting is checked against when the caller names none: credits MAX_BALANCE (+ top-up caps), debits the type's outbound caps. */
export function defaultLimits(type: LedgerType, amountCents: Cents): InternalLimitType[] {
  if (amountCents >= 0) return ['MAX_BALANCE', ...(CREDIT_EXTRA_LIMITS[type] ?? [])]
  return DEBIT_LIMITS[type] ?? []
}

export class TransactionsService {
  readonly holds: HoldsService

  constructor(private readonly ctx: AppContext, private readonly repo: TransactionRepo) {
    this.holds = new HoldsService(ctx, repo, this)
  }

  private get accounts() {
    return this.ctx.services.accounts
  }

  // ---------------------------------------------------------------- reads

  find(id: string): LedgerTransaction | undefined {
    return this.repo.transactionById(id)
  }

  /** @throws 404 NOT_FOUND */
  get(id: string): LedgerTransaction {
    const t = this.repo.transactionById(id)
    if (!t) throw notFound(`NOT_FOUND: Transaction ${id} not found`)
    return t
  }

  /** Postings of an account, newest first (default page 1000). */
  listForAccount(accountId: string, page: { limit?: number; offset?: number } = {}): LedgerTransaction[] {
    return this.repo.listForAccount(accountId, { limit: page.limit ?? 1000, offset: page.offset ?? 0 })
  }

  /** Limit usage provider for accounts.checkLimit: cents counted against the limit type since `since`. */
  usage(accountId: string, limitType: InternalLimitType, since: string): Cents {
    return this.repo.usage(accountId, limitType, since)
  }

  /** FinancialTransaction body (tags always present; pass `tags` when already loaded for a page). */
  toResponse(t: LedgerTransaction, tags: TagRow[] = this.repo.tagsFor(t.id)): FinancialTransaction {
    const cp = t.counterpart
    return compact({
      transactionHayId: t.id,
      accountHayId: t.accountId,
      customerId: t.customerId,
      productId: t.productId,
      type: t.type,
      transactionChannel: t.channel,
      currencyAmount: { amount: fromCents(t.amount), currency: t.currency },
      originalCurrencyAmount: t.originalAmount !== undefined ? { amount: fromCents(t.originalAmount), currency: t.originalCurrency ?? t.currency } : undefined,
      rollingAccountBalance: fromCents(t.rollingBalance),
      transactionTimeUtc: t.transactionTime,
      clearingTimeUtc: t.clearingTime,
      description: t.description,
      category: t.category,
      reference: t.reference,
      counterpartName: t.counterpartName ?? cp?.name,
      counterpartDetails: cp ? { accountId: cp.accountId, customerId: cp.customerId, name: cp.name, basicAccountNumber: cp.basicAccountNumber, merchantDetails: cp.merchantDetails } : undefined,
      originType: t.originType,
      originId: t.originId,
      originChannel: t.originChannel,
      cardId: t.cardId,
      relatedHoldHayId: t.relatedHoldId,
      countryOfExpenditure: t.countryOfExpenditure,
      externalIdentifiers: t.externalIdentifiers,
      mandatePaymentDetails: t.mandatePayment,
      reportedFraudulent: false,
      tags: tags.map(tagToResponse),
    }) as FinancialTransaction
  }

  // ---------------------------------------------------------------- the posting engine

  /**
   * Posts one FinancialTransaction: account status (REFUSED_ACCOUNT_BLOCKED / _CLOSED), the limits in
   * order (detailed LIMIT_OUTCOME), then funds for a debit (REFUSED_NOT_ENOUGH_FUNDS); on ACCEPTED the
   * ledger moves through accounts.adjust (APPROVED -> ACTIVE, arrears), rollingAccountBalance is the
   * totalBalance after, and transaction.posted is emitted. Refusals post nothing.
   * @throws 404 when the account is unknown; 400 when transactionTimeUtc is malformed
   */
  post(input: PostInput): PostResult {
    const outcome = this.evaluate(input)
    if (outcome !== 'ACCEPTED') {
      if (input.notifyRefusal) {
        this.notifyRefused(this.accounts.get(input.accountId), input.actionOwner ?? 'PLATFORM', outcome, compact({
          amountCents: input.amountCents,
          originalAmount: input.originalAmount,
          webhookType: input.webhookType ?? WEBHOOK_TYPE[input.type],
          transactionTime: input.transactionTimeUtc ? normaliseTime(input.transactionTimeUtc, 'transactionTimeUtc') : isoUtc(this.ctx.clock.now()),
          isPending: false,
          isAtm: input.type === 'ATM_WITHDRAWAL',
          cardId: input.cardId,
          cardUsage: input.cardUsage,
          merchant: input.counterpart?.merchantDetails,
          counterpart: input.counterpart,
          description: input.description,
          category: input.category,
          reference: input.reference,
          originType: input.originType,
          originId: input.originId,
          mandatePayment: input.mandatePayment,
          returnReason: input.returnReason,
        }))
      }
      return { outcome }
    }
    return { outcome, transaction: this.apply(input) }
  }

  /** The checks of post() without the posting: status -> limits -> funds; 'ACCEPTED' when the movement fits. */
  evaluate(input: PostInput): LedgerOutcome {
    if (input.checks === false) {
      this.accounts.get(input.accountId)
      return 'ACCEPTED'
    }
    const gate = this.accounts.requireOpenForMovement(input.accountId)
    if (typeof gate === 'string') return gate
    return this.checkLimits(input) ?? this.checkFunds(input) ?? 'ACCEPTED'
  }

  /** The posting's limits in order (input.limits, else defaultLimits): the first breached outcome, or null. */
  checkLimits(input: PostInput): LimitOutcome | null {
    const magnitude = Math.abs(input.amountCents)
    for (const type of input.limits ?? defaultLimits(input.type, input.amountCents)) {
      const breached = this.accounts.checkLimit(input.accountId, type, magnitude)
      if (breached) return breached
    }
    return null
  }

  /** Funds check for a debit posting (credits always fit). */
  checkFunds(input: PostInput): 'REFUSED_NOT_ENOUGH_FUNDS' | null {
    return input.amountCents < 0 && this.accounts.checkFunds(input.accountId, -input.amountCents) ? 'REFUSED_NOT_ENOUGH_FUNDS' : null
  }

  /** The posting of post() without the checks (callers that evaluated every leg first, e.g. transfers). Atomic. */
  apply(input: PostInput): LedgerTransaction {
    const transactionTime = input.transactionTimeUtc ? normaliseTime(input.transactionTimeUtc, 'transactionTimeUtc') : undefined
    return this.ctx.db.transaction(() => {
      const before = this.accounts.get(input.accountId)
      const now = isoUtc(this.ctx.clock.now())
      const after = this.accounts.adjust(input.accountId, { ledgerDelta: input.amountCents, heldDelta: -(input.releaseHeldCents ?? 0) })
      const balances = computeBalances(after)
      const t: LedgerTransaction = compact({
        id: input.id ?? uuid(),
        accountId: after.id,
        customerId: this.primaryCustomer(before),
        productId: after.productId,
        type: input.type,
        channel: input.channel,
        webhookType: input.webhookType ?? WEBHOOK_TYPE[input.type],
        amount: input.amountCents,
        currency: after.currency,
        originalAmount: input.originalAmount?.amountCents,
        originalCurrency: input.originalAmount?.currency,
        rollingBalance: balances.totalBalance,
        transactionTime: transactionTime ?? now,
        clearingTime: now,
        description: input.description,
        category: input.category,
        reference: input.reference,
        counterpartName: input.counterpart?.name,
        counterpart: input.counterpart,
        originType: input.originType,
        originId: input.originId,
        originChannel: input.originChannel,
        cardId: input.cardId,
        cardUsage: input.cardUsage,
        relatedHoldId: input.relatedHoldId,
        countryOfExpenditure: input.countryOfExpenditure,
        externalIdentifiers: input.externalIdentifiers,
        mandatePayment: input.mandatePayment,
        returnReason: input.returnReason,
        limitKinds: input.limits ?? defaultLimits(input.type, input.amountCents),
        createdAt: now,
      })
      this.repo.insertTransaction(t)
      this.ctx.events.emit('transaction.posted', { transaction: t, account: after, balances, actionOwner: input.actionOwner ?? 'PLATFORM' })
      return t
    })()
  }

  /**
   * Emits transaction.refused (-> TRANSACTION webhook with the refused outcome and the account's
   * unchanged balances) — unless the outcome has no webhook value (REFUSED_LIMIT_BREACH), in which
   * case nothing is emitted (docs/map/00-balance.md §3.2 L3).
   */
  notifyRefused(account: Account, actionOwner: ActionOwner, outcome: LedgerOutcome, details: RefusalDetails): void {
    if (!isWebhookOutcome(outcome)) return
    this.ctx.events.emit('transaction.refused', compact({ account, balances: computeBalances(account), actionOwner, outcome, ...details }))
  }

  /** The customer a posting is attributed to: the holder, or the first member of a group. */
  primaryCustomer(account: Account): string {
    return this.accounts.holderCustomerIds(account)[0] ?? account.holderId
  }

  // ---------------------------------------------------------------- general credit / debit

  /**
   * createCreditTransactionV1/V0 and createDebitTransactionV1/V0: amount is a positive magnitude with
   * <= 2 dp (400 otherwise), the endpoint fixes the direction; GENERAL_CREDIT is checked against
   * MAX_BALANCE, GENERAL_DEBIT against the daily transfers-out cap, TOTAL_SPEND_PER_YEAR and funds.
   * `legacy` collapses the detailed limit outcomes to REFUSED_LIMIT_BREACH. Idempotency is the route's.
   * @throws 404 unknown account
   */
  createGeneral(direction: 'CREDIT' | 'DEBIT', body: CreateTransactionRequestBody, opts: { legacy?: boolean } = {}): TransactionOutcome {
    const cents = requestCents(body.amount, 'amount')
    const r = this.post(compact({
      accountId: body.accountHayId,
      amountCents: direction === 'CREDIT' ? cents : -cents,
      type: direction === 'CREDIT' ? 'GENERAL_CREDIT' : 'GENERAL_DEBIT',
      channel: body.transactionChannel,
      counterpart: { name: body.counterpartName },
      description: body.description,
      category: body.category,
      reference: body.reference,
      originType: body.originType,
      originId: body.originId,
      originChannel: body.originChannel,
      actionOwner: 'CLIENT',
    }))
    return this.outcomeBody(r, opts)
  }

  private outcomeBody(r: PostResult, opts: { legacy?: boolean } = {}): TransactionOutcome {
    const body: TransactionOutcome = { outcome: toRestOutcome(r.outcome, opts) }
    if (r.transaction) body.transactionId = r.transaction.id
    return body
  }

  // ---------------------------------------------------------------- transfers

  /**
   * makeTransferV1/V0 (served identically) from `accountId`. INTERNAL, and ACCOUNT with the local BSB,
   * post both legs atomically (INTRABANK_TRANSFER_OUT / _IN); ACCOUNT with another BSB posts
   * INTERBANK_TRANSFER_OUT immediately (NPP); PAY_ID resolves through services.payid
   * (REFUSED_INVALID_PAY_ID when unknown or no PayID service is loaded).
   *
   * Check order (docs/map/00-balance.md §3.2): request shape (400/422) -> sender status -> rails (an FX
   * child may only transfer INTERNAL; no FX: the recipient must share the sender's currency ->
   * REFUSED_CAPABILITY_NOT_ENABLED) -> recipient resolution -> recipient status
   * (REFUSED_RECIPIENT_ACCOUNT_BLOCKED / _CLOSED) -> sender limits (PAYMENT_TO_ACCOUNT_NUMBER, daily
   * transfers-out, TOTAL_SPEND_PER_YEAR) -> recipient MAX_BALANCE -> sender funds.
   * @throws 404 unknown sender account / customer / recipient account; 422 PERMISSION_DENIED when the
   * customer does not hold the account; 400 when the transfer-type object is missing or malformed
   */
  transfer(accountId: string, body: TransferOutRequestBody, opts: { actionOwner?: ActionOwner } = {}): TransactionOutcome {
    const cents = requestCents(body.amount, 'amount')
    const sender = this.accounts.get(accountId)
    const senderCustomer = this.ctx.services.customers.get(body.senderCustomerHayId)
    if (!this.accounts.holderCustomerIds(sender).includes(body.senderCustomerHayId)) {
      throw unprocessable(`PERMISSION_DENIED: Customer ${body.senderCustomerHayId} does not hold account ${accountId}`)
    }
    const spec = transferSpec(body)
    const refused = (outcome: LedgerOutcome): TransactionOutcome => ({ outcome: toRestOutcome(outcome) })

    const gate = this.accounts.requireOpenForMovement(sender.id)
    if (typeof gate === 'string') return refused(gate)
    if (sender.parentAccountId && spec.transferType !== 'INTERNAL') return refused('REFUSED_CAPABILITY_NOT_ENABLED')
    const target = this.resolveTarget(sender, spec)
    if ('outcome' in target) return refused(target.outcome)
    const actionOwner = opts.actionOwner ?? 'CLIENT'
    const common = { description: body.description, category: body.category, reference: body.reference ?? spec.reference, originType: 'CUSTOMER' as const, actionOwner }

    if (target.kind === 'external') {
      const r = this.post(compact({
        ...common,
        accountId: sender.id,
        amountCents: -cents,
        type: 'INTERBANK_TRANSFER_OUT',
        channel: 'CUSCAL_NPP_TRANSFER_OUT',
        counterpart: { name: spec.recipientName, basicAccountNumber: { accountNumber: target.accountNumber, branchNumber: target.bsb } },
      }))
      return this.outcomeBody(r)
    }

    const recipient = target.account
    if (recipient.currency !== sender.currency) return refused('REFUSED_CAPABILITY_NOT_ENABLED')
    const recipientGate = this.accounts.requireOpenForMovement(recipient.id)
    if (recipientGate === 'REFUSED_ACCOUNT_BLOCKED') return refused('REFUSED_RECIPIENT_ACCOUNT_BLOCKED')
    if (recipientGate === 'REFUSED_ACCOUNT_CLOSED') return refused('REFUSED_RECIPIENT_ACCOUNT_CLOSED')
    const out: PostInput = compact({
      ...common,
      accountId: sender.id,
      amountCents: -cents,
      type: 'INTRABANK_TRANSFER_OUT',
      channel: 'HAAS_TRANSFER_INTERNAL_OUT',
      counterpart: { accountId: recipient.id, customerId: this.primaryCustomer(recipient), name: spec.recipientName },
    })
    const into: PostInput = compact({
      ...common,
      accountId: recipient.id,
      amountCents: cents,
      type: 'INTRABANK_TRANSFER_IN',
      channel: 'HAAS_TRANSFER_INTERNAL_IN',
      counterpart: { accountId: sender.id, customerId: senderCustomer.id, name: spec.senderName ?? customerName(senderCustomer) },
      limits: ['MAX_BALANCE'],
    })
    const breached = this.checkLimits(out) ?? this.checkLimits(into) ?? this.checkFunds(out)
    if (breached) return refused(breached)

    const sent = this.ctx.db.transaction(() => {
      const t = this.apply(out)
      this.apply(into)
      return t
    })()
    return { outcome: 'ACCEPTED', transactionId: sent.id }
  }

  private resolveTarget(sender: Account, spec: TransferSpec): TransferTarget | { outcome: LedgerOutcome } {
    switch (spec.transferType) {
      case 'INTERNAL':
        return this.internalTarget(sender, this.accounts.get(spec.recipientAccountId))
      case 'ACCOUNT':
        return this.accountTarget(sender, spec.bsb, spec.accountNumber)
      case 'PAY_ID': {
        const resolved = deps(this.ctx).payid?.resolve(spec.payId)
        if (!resolved) return { outcome: 'REFUSED_INVALID_PAY_ID' }
        return this.accountTarget(sender, resolved.branchNumber, resolved.accountNumber)
      }
    }
  }

  /** A local BSB is converted to an internal transfer (the account number must exist); any other BSB goes out through NPP. */
  private accountTarget(sender: Account, bsb: string, accountNumber: string): TransferTarget {
    if (bsb !== LOCAL_BSB) return { kind: 'external', bsb, accountNumber }
    const account = this.ctx.services.accounts.search(accountNumber).map((a) => this.accounts.get(a.accountHayId!))[0]
    if (!account) throw unprocessable(`INVALID_RECIPIENT: No account with number ${accountNumber} at BSB ${bsb}`)
    return this.internalTarget(sender, account)
  }

  private internalTarget(sender: Account, account: Account): TransferTarget {
    if (account.id === sender.id) throw unprocessable(`INVALID_RECIPIENT: Account ${sender.id} cannot transfer to itself`)
    return { kind: 'internal', account }
  }

  // ---------------------------------------------------------------- search

  /**
   * searchTransactions: posted transactions whose clearing time (sortBy CLEARING_TIME, default) or
   * transaction time (TRANSACTION_TIME) lies within [from, to] (both inclusive, compared at microsecond
   * precision), filters AND-ed exact, newest first, paged (limit 1..1000, offset >= 0, else 400).
   * from > to is a 400.
   */
  search(body: SearchTransactionsRequestBody, page: SearchPage): FinancialTransaction[] {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 1000) throw badRequest('BAD_REQUEST: limit must be a value between 1 and 1000')
    if (!Number.isInteger(page.offset) || page.offset < 0) throw badRequest('BAD_REQUEST: offset must be 0 or greater')
    const from = normaliseTime(body.fromDateTimeUtc, 'fromDateTimeUtc')
    const to = normaliseTime(body.toDateTimeUtc, 'toDateTimeUtc')
    if (from > to) throw badRequest('BAD_REQUEST: fromDateTimeUtc must not be after toDateTimeUtc')
    const rows = this.repo.search(compact({
      accountId: body.accountId,
      originChannel: body.originChannel,
      originId: body.originId,
      originType: body.originType,
      from,
      to,
      sortBy: page.sortBy ?? 'CLEARING_TIME',
      limit: page.limit,
      offset: page.offset,
    }))
    const tags = this.repo.tagsForMany(rows.map((t) => t.id))
    return rows.map((t) => this.toResponse(t, tags.get(t.id) ?? []))
  }

  // ---------------------------------------------------------------- tags

  /** getTagsForTransaction: every tag of the transaction, creation order. @throws 404 */
  listTags(transactionId: string): TagsResponseBody {
    this.get(transactionId)
    return { tags: this.repo.tagsFor(transactionId).map(tagToResponse) }
  }

  /**
   * modifyTagsForTransaction. ADD is idempotent per (category, value); a tag `id` references an existing
   * association (on this transaction: no-op; on another: its category/value pair is added here; unknown,
   * or sent with a category/value that disagrees with it: 400). REMOVE by id (an association on this
   * transaction; one on another transaction is a no-op) or by pair; absent tags are a no-op. Returns the
   * full list after the change.
   * @throws 404 unknown transaction; 400 (TAGS_400_MESSAGE) on validation failure
   */
  modifyTags(transactionId: string, body: ModifyTagsRequestBody): TagsResponseBody {
    validateTagsBody(body)
    this.get(transactionId)
    const now = isoUtc(this.ctx.clock.now())
    const pairs = body.tags.map((tag) => this.resolveTagPair(transactionId, tag, body.operation)) // every id must resolve before anything changes
    this.ctx.db.transaction(() => {
      for (const pair of pairs) {
        if (!pair) continue
        const existing = this.repo.findTag(transactionId, pair.category, pair.value)
        if (body.operation === 'ADD') {
          if (!existing) this.repo.insertTag({ id: uuid(), transactionId, category: pair.category, value: pair.value, createdAt: now })
        } else if (existing) {
          this.repo.deleteTag(existing.id)
        }
      }
    })()
    return { tags: this.repo.tagsFor(transactionId).map(tagToResponse) }
  }

  /** The (category, value) a tag entry denotes; null when a REMOVE names an association that is not on this transaction. */
  private resolveTagPair(transactionId: string, tag: Tag, operation: ModifyTagsRequestBody['operation']): { category: string; value: string } | null {
    if (!tag.id) return { category: tag.category!, value: tag.value! }
    const ref = this.repo.tagById(tag.id)
    if (!ref) throw badRequest(TAGS_400_MESSAGE)
    if ((tag.category != null && tag.category !== ref.category) || (tag.value != null && tag.value !== ref.value)) throw badRequest(TAGS_400_MESSAGE)
    if (operation === 'REMOVE' && ref.transactionId !== transactionId) return null
    return { category: ref.category, value: ref.value }
  }
}

/** The transfer request's type-specific object, shape-validated (400) but not yet resolved. */
type TransferSpec = { recipientName: string; senderName?: string; reference?: string } & (
  | { transferType: 'INTERNAL'; recipientAccountId: string }
  | { transferType: 'ACCOUNT'; bsb: string; accountNumber: string }
  | { transferType: 'PAY_ID'; payId: string }
)

type TransferTarget =
  | { kind: 'internal'; account: Account }
  | { kind: 'external'; bsb: string; accountNumber: string }

function transferSpec(body: TransferOutRequestBody): TransferSpec {
  switch (body.transferType) {
    case 'INTERNAL': {
      const it = body.internalTransfer
      if (!it) throw badRequest('BAD_REQUEST: internalTransfer is required when transferType is INTERNAL')
      return compact({ transferType: 'INTERNAL', recipientAccountId: it.recipientAccountHayId, recipientName: it.recipientName, senderName: it.senderName })
    }
    case 'ACCOUNT': {
      const at = body.accountTransfer
      if (!at) throw badRequest('BAD_REQUEST: accountTransfer is required when transferType is ACCOUNT')
      if (!BSB_RE.test(at.bsb)) throw badRequest('BAD_REQUEST: accountTransfer/bsb must be 6 digits')
      if (!ACCOUNT_NUMBER_RE.test(at.accountNumber)) throw badRequest('BAD_REQUEST: accountTransfer/accountNumber must be 5-9 digits')
      return compact({ transferType: 'ACCOUNT', bsb: at.bsb, accountNumber: at.accountNumber, recipientName: at.recipientName, senderName: at.senderName, reference: at.reference })
    }
    case 'PAY_ID': {
      const pt = body.payIdTransfer
      if (!pt) throw badRequest('BAD_REQUEST: payIdTransfer is required when transferType is PAY_ID')
      return compact({ transferType: 'PAY_ID', payId: pt.payId, recipientName: pt.recipientName, senderName: pt.senderName, reference: pt.reference })
    }
  }
}

/** The sending customer's name, used as the recipient leg's counterpart when the request names no senderName. */
export function customerName(c: Customer): string {
  return [c.customerDetails.firstName, c.customerDetails.lastName].filter(Boolean).join(' ')
}

// ---------------------------------------------------------------- holds

/**
 * Card authorisation holds. A hold reserves funds (held +a, available -a, total unchanged) until it is
 * settled (a new FinancialTransaction with relatedHoldHayId), reversed or cancelled. Every event is
 * notified through TRANSACTION webhooks whose transactionHayId is the hold id while pending.
 */
export class HoldsService {
  constructor(private readonly ctx: AppContext, private readonly repo: TransactionRepo, private readonly ledger: TransactionsService) {}

  private get accounts() {
    return this.ctx.services.accounts
  }

  find(id: string): Hold | undefined {
    return this.repo.holdById(id)
  }

  /** @throws 404 NOT_FOUND (every state is retrievable) */
  get(id: string): Hold {
    const h = this.repo.holdById(id)
    if (!h) throw notFound(`NOT_FOUND: Hold ${id} not found`)
    return h
  }

  /** getPendingHolds: AUTHORISED holds of the account, authorisation order. @throws 404 unknown account */
  listOpen(accountId: string): Hold[] {
    this.accounts.get(accountId)
    return this.repo.openHolds(accountId)
  }

  /** AuthorisationHold body: currencyAmount is the current hold amount, negative like the webhook. */
  toResponse(h: Hold): AuthorisationHold {
    return compact({
      holdHayId: h.id,
      accountHayId: h.accountId,
      cardId: h.cardId,
      customerId: h.customerId,
      currencyAmount: { amount: fromCents(-h.amount), currency: h.currency },
      originalCurrencyAmount: h.originalAmount !== undefined ? { amount: fromCents(-h.originalAmount), currency: h.originalCurrency ?? h.currency } : undefined,
      description: h.description,
      category: h.category,
      merchantDetails: h.merchant,
      transactionChannel: h.channel,
      transactionTimeUtc: h.authorisedAt,
      type: h.type,
    }) as AuthorisationHold
  }

  /**
   * Authorise a card hold: account status -> caller refusal (card status / preferences / processor) ->
   * account rules (REFUSED_RULES) -> limits (SINGLE_CARD_TRANSACTION, CARD_PAYMENTS_DAILY,
   * ATM_WITHDRAWAL_PER_DAY for ATM) -> funds. Accepted: held +a, hold AUTHORISED, webhook CARD_TRANSACTION
   * isPending true. Refused: nothing held, webhook CARD_TRANSACTION with the refused outcome.
   * @throws 404 unknown account; 400 non-positive amount or malformed transactionTimeUtc
   */
  authorise(input: AuthoriseHoldInput): HoldResult {
    if (!(input.amountCents > 0)) throw badRequest('BAD_REQUEST: hold amount must be greater than 0')
    const account = this.accounts.get(input.accountId)
    const usage = input.card.cardUsage
    const type: HoldType = input.type ?? (usage?.isAtmWithdrawal ? 'ATM_WITHDRAWAL' : usage?.isCardPresent ? 'CARD_PRESENT_PAYMENT' : 'CARD_NOT_PRESENT_PAYMENT')
    const channel = input.channel ?? cardChannel(type, usage, input.originalAmount !== undefined && input.originalAmount.currency !== account.currency)
    const limits = input.limits ?? (type === 'ATM_WITHDRAWAL' ? ATM_LIMITS : CARD_LIMITS)
    const now = isoUtc(this.ctx.clock.now())
    const transactionTime = input.transactionTimeUtc ? normaliseTime(input.transactionTimeUtc, 'transactionTimeUtc') : now
    const actionOwner = input.actionOwner ?? 'PLATFORM'
    const m = input.card.merchant
    const refuse = (outcome: LedgerOutcome, extra: Partial<RefusalDetails> = {}): HoldResult => {
      this.ledger.notifyRefused(account, actionOwner, outcome, compact({
        amountCents: -input.amountCents,
        // signed like amountCents (the input carries the positive magnitude, as the accepted hold stores it)
        originalAmount: input.originalAmount && { amountCents: -input.originalAmount.amountCents, currency: input.originalAmount.currency },
        webhookType: 'CARD_TRANSACTION',
        transactionTime,
        isPending: false,
        isAtm: type === 'ATM_WITHDRAWAL',
        cardId: input.card.cardHayId,
        cardUsage: usage,
        merchant: m,
        description: input.description,
        category: input.category,
        ...extra,
      }))
      return { outcome }
    }

    const gate = this.accounts.requireOpenForMovement(account.id)
    if (typeof gate === 'string') return refuse(gate)
    if (input.refusal) return refuse(input.refusal.outcome, { cardPreferenceOutcome: input.refusal.cardPreferenceOutcome, cardProcessorResponse: input.refusal.cardProcessorResponse })
    const rule = this.accounts.evaluateRules(account.id, { mcc: m?.merchantCategoryCode, merchantId: m?.merchantId, merchantName: m?.name })
    if (rule) return refuse('REFUSED_RULES', { ruleDetails: rule })
    for (const limitType of limits) {
      const breached = this.accounts.checkLimit(account.id, limitType, input.amountCents)
      if (breached) return refuse(breached)
    }
    if (this.accounts.checkFunds(account.id, input.amountCents)) return refuse('REFUSED_NOT_ENOUGH_FUNDS')

    const hold = this.ctx.db.transaction(() => {
      const after = this.accounts.adjust(account.id, { heldDelta: input.amountCents })
      const h: Hold = compact({
        id: uuid(),
        accountId: after.id,
        customerId: this.ledger.primaryCustomer(after),
        productId: after.productId,
        cardId: input.card.cardHayId,
        cardToken: input.card.cardToken,
        lastFour: input.card.lastFour,
        state: 'AUTHORISED',
        type,
        channel,
        amount: input.amountCents,
        portions: [{ amount: input.amountCents, at: transactionTime }],
        currency: after.currency,
        originalAmount: input.originalAmount?.amountCents,
        originalCurrency: input.originalAmount?.currency,
        description: input.description,
        category: input.category ?? m?.merchantCategoryCode?.toString(),
        merchant: m,
        cardUsage: usage,
        countryOfExpenditure: input.countryOfExpenditure,
        externalIdentifiers: input.externalIdentifiers,
        limitKinds: limits,
        authorisedAt: transactionTime,
      })
      this.repo.insertHold(h)
      this.emitChange(h, 'AUTHORISED', input.amountCents, after, actionOwner)
      return h
    })()
    return { outcome: 'ACCEPTED', hold }
  }

  /**
   * Incremental authorisation: the increment is checked against the account status, the hold's limits
   * (SINGLE_CARD_TRANSACTION on the increment, daily caps on the running usage) and funds; accepted ->
   * held +d, same hold id, a new dated portion (windowed from now by the daily limits), webhook
   * CARD_TRANSACTION with the new total. @throws 404; 422 INVALID_STATE
   */
  increase(holdId: string, deltaCents: Cents, opts: HoldOptions = {}): HoldResult {
    const hold = this.requireOpen(holdId)
    if (!(deltaCents > 0)) throw badRequest('BAD_REQUEST: increase amount must be greater than 0')
    const actionOwner = opts.actionOwner ?? 'PLATFORM'
    const account = this.accounts.get(hold.accountId)
    const refuse = (outcome: LedgerOutcome): HoldResult => {
      this.ledger.notifyRefused(account, actionOwner, outcome, holdRefusalDetails(hold, -deltaCents, 'CARD_TRANSACTION'))
      return { outcome, hold }
    }
    const gate = this.accounts.requireOpenForMovement(account.id)
    if (typeof gate === 'string') return refuse(gate)
    for (const limitType of hold.limitKinds) {
      const breached = this.accounts.checkLimit(account.id, limitType, deltaCents)
      if (breached) return refuse(breached)
    }
    if (this.accounts.checkFunds(account.id, deltaCents)) return refuse('REFUSED_NOT_ENOUGH_FUNDS')
    this.ctx.db.transaction(() => {
      const after = this.accounts.adjust(account.id, { heldDelta: deltaCents })
      const now = isoUtc(this.ctx.clock.now())
      rescaleOriginal(hold, hold.amount + deltaCents)
      hold.amount += deltaCents
      hold.portions = [...hold.portions, { amount: deltaCents, at: now }]
      hold.updatedAt = now
      this.repo.saveHold(hold)
      this.emitChange(hold, 'INCREASED', deltaCents, after, actionOwner)
    })()
    return { outcome: 'ACCEPTED', hold }
  }

  /**
   * Partial reversal: held -d, same hold id, webhook CARD_TRANSACTION_REFUND (+d, pending); the newest
   * portions are released first. A decrease by the whole amount is a full reversal.
   * @throws 404; 422 INVALID_STATE / INVALID_AMOUNT
   */
  decrease(holdId: string, deltaCents: Cents, opts: HoldOptions = {}): HoldResult {
    const hold = this.requireOpen(holdId)
    if (!(deltaCents > 0)) throw badRequest('BAD_REQUEST: decrease amount must be greater than 0')
    if (deltaCents > hold.amount) throw unprocessable(`INVALID_AMOUNT: Hold ${holdId} holds ${fromCents(hold.amount)}, cannot release ${fromCents(deltaCents)}`)
    if (deltaCents === hold.amount) return this.reverse(holdId, opts)
    this.ctx.db.transaction(() => {
      const after = this.accounts.adjust(hold.accountId, { heldDelta: -deltaCents })
      rescaleOriginal(hold, hold.amount - deltaCents)
      hold.amount -= deltaCents
      hold.portions = releasePortions(hold.portions, deltaCents)
      hold.updatedAt = isoUtc(this.ctx.clock.now())
      this.repo.saveHold(hold)
      this.emitChange(hold, 'DECREASED', deltaCents, after, opts.actionOwner ?? 'PLATFORM')
    })()
    return { outcome: 'ACCEPTED', hold }
  }

  /** Full reversal: the whole hold is released (REVERSED, terminal), webhook CARD_TRANSACTION_REFUND (+h, pending). */
  reverse(holdId: string, opts: HoldOptions = {}): HoldResult {
    return this.release(holdId, 'REVERSED', opts)
  }

  /** Ops-console cancellation: like a full reversal, terminal state CANCELLED. */
  cancel(holdId: string, opts: HoldOptions = {}): HoldResult {
    return this.release(holdId, 'CANCELLED', opts)
  }

  private release(holdId: string, state: 'REVERSED' | 'CANCELLED', opts: HoldOptions): HoldResult {
    const hold = this.requireOpen(holdId)
    this.ctx.db.transaction(() => {
      const after = this.accounts.adjust(hold.accountId, { heldDelta: -hold.amount })
      const now = isoUtc(this.ctx.clock.now())
      hold.state = state
      hold.updatedAt = now
      hold.closedAt = now
      this.repo.saveHold(hold)
      this.emitChange(hold, state, hold.amount, after, opts.actionOwner ?? 'PLATFORM')
    })()
    return { outcome: 'ACCEPTED', hold }
  }

  /**
   * Settlement: releases the whole hold (held -h) and posts -s (default s = h) as a new
   * FinancialTransaction with relatedHoldHayId (total -s, available -s + h), bypassing the status and
   * limit checks already made at authorisation. Only h was reserved: a settlement larger than the hold
   * funds-checks the excess (s - h <= availableBalance, else REFUSED_NOT_ENOUGH_FUNDS with a refused
   * CARD_TRANSACTION_SETTLED webhook and the hold left AUTHORISED). Webhook CARD_TRANSACTION_SETTLED with
   * the new transactionHayId and holdHayId.
   * @throws 404; 422 INVALID_STATE; 400 for a settlement of 0 or less (reverse() releases a hold)
   */
  settle(holdId: string, settleCents?: Cents, opts: HoldOptions = {}): HoldResult {
    const hold = this.requireOpen(holdId)
    const s = settleCents ?? hold.amount
    if (!(s > 0)) throw badRequest('BAD_REQUEST: settlement amount must be greater than 0 (reverse the hold to release it)')
    const actionOwner = opts.actionOwner ?? 'PLATFORM'
    if (s > hold.amount && this.accounts.checkFunds(hold.accountId, s - hold.amount)) {
      this.ledger.notifyRefused(this.accounts.get(hold.accountId), actionOwner, 'REFUSED_NOT_ENOUGH_FUNDS', holdRefusalDetails(hold, -s, 'CARD_TRANSACTION_SETTLED'))
      return { outcome: 'REFUSED_NOT_ENOUGH_FUNDS', hold }
    }
    const transaction = this.ctx.db.transaction(() => {
      const t = this.ledger.apply(compact({
        accountId: hold.accountId,
        amountCents: -s,
        type: hold.type,
        channel: hold.channel,
        webhookType: 'CARD_TRANSACTION_SETTLED',
        counterpart: hold.merchant ? { name: hold.merchant.name, merchantDetails: hold.merchant } : undefined,
        description: hold.description,
        category: hold.category,
        relatedHoldId: hold.id,
        transactionTimeUtc: hold.authorisedAt,
        cardId: hold.cardId,
        cardUsage: hold.cardUsage,
        countryOfExpenditure: hold.countryOfExpenditure,
        externalIdentifiers: hold.externalIdentifiers,
        originalAmount: hold.originalAmount !== undefined ? { amountCents: -hold.originalAmount, currency: hold.originalCurrency ?? hold.currency } : undefined,
        limits: hold.limitKinds,
        checks: false,
        releaseHeldCents: hold.amount,
        actionOwner,
      }))
      const now = isoUtc(this.ctx.clock.now())
      hold.state = 'SETTLED'
      hold.settledTransactionId = t.id
      hold.updatedAt = now
      hold.closedAt = now
      this.repo.saveHold(hold)
      return t
    })()
    return { outcome: 'ACCEPTED', hold, transaction }
  }

  private requireOpen(holdId: string): Hold {
    const hold = this.get(holdId)
    if (hold.state !== 'AUTHORISED') throw unprocessable(`INVALID_STATE: Hold ${holdId} is ${hold.state}`)
    return hold
  }

  private emitChange(hold: Hold, kind: HoldChangeKind, deltaCents: Cents, account: Account, actionOwner: ActionOwner): void {
    this.ctx.events.emit('hold.changed', { hold: structuredClone(hold), kind, deltaCents, account, balances: computeBalances(account), actionOwner })
  }
}

/** Refusal webhook details for a movement on an existing hold (increment, settlement): the hold id, card and merchant ride along. */
function holdRefusalDetails(hold: Hold, amountCents: Cents, webhookType: WebhookTransactionType): RefusalDetails {
  return compact({
    amountCents,
    webhookType,
    transactionTime: hold.authorisedAt,
    isPending: false,
    isAtm: hold.type === 'ATM_WITHDRAWAL',
    holdId: hold.id,
    cardId: hold.cardId,
    cardUsage: hold.cardUsage,
    merchant: hold.merchant,
    description: hold.description,
    category: hold.category,
  })
}

/**
 * An FX hold's original-currency amount follows its amount at the authorisation's rate (original / amount),
 * so an increment or a partial reversal keeps the two consistent through to the settlement [decision].
 */
function rescaleOriginal(hold: Hold, newAmount: Cents): void {
  if (hold.originalAmount === undefined || !(hold.amount > 0)) return
  hold.originalAmount = Math.round((hold.originalAmount * newAmount) / hold.amount)
}

/** Releases `cents` from the newest portions first (a partial reversal corrects the latest authorisation) [decision]. */
export function releasePortions(portions: HoldPortion[], cents: Cents): HoldPortion[] {
  const out = [...portions]
  let left = cents
  while (left > 0 && out.length) {
    const last = out[out.length - 1]!
    const take = Math.min(last.amount, left)
    left -= take
    if (take === last.amount) out.pop()
    else out[out.length - 1] = { ...last, amount: last.amount - take }
  }
  return out
}

// ---------------------------------------------------------------- helpers

/** Card channel from usage (Apple/Google wallet -> APPLE_PAY_*, contactless -> VISA_CONTACTLESS, present -> VISA_CARD_PRESENT, ATM -> VISA_ATM, else VISA_CARD_NOT_PRESENT), _INTERNATIONAL for FX spend. */
export function cardChannel(type: HoldType, usage: CardUsageDetails | undefined, international: boolean): TransactionChannel {
  let base: string
  if (type === 'ATM_WITHDRAWAL') base = 'VISA_ATM'
  else if (usage?.isMobileWalletPayment) base = usage.isCardPresent ? 'APPLE_PAY_CARD_PRESENT' : 'APPLE_PAY_CARD_NOT_PRESENT'
  else if (usage?.isContactless) base = 'VISA_CONTACTLESS'
  else if (type === 'CARD_PRESENT_PAYMENT') base = 'VISA_CARD_PRESENT'
  else base = 'VISA_CARD_NOT_PRESENT'
  return (international ? `${base}_INTERNATIONAL` : base) as TransactionChannel
}

/** Request amount -> cents: > 0 with <= 2 dp, else 400 (never silently rounded). */
export function requestCents(amount: number, field: string): Cents {
  if (typeof amount !== 'number' || !hasAtMostTwoDecimals(amount)) throw badRequest(`BAD_REQUEST: ${field} must be a number with at most 2 decimal places`)
  if (amount <= 0) throw badRequest(`BAD_REQUEST: ${field} must be greater than 0`)
  return toCents(amount)
}

/**
 * Any ISO date-time -> the isoUtc rendering (comparable with stored timestamps). Fractional seconds
 * beyond the millisecond that Date keeps are preserved from the input (microsecond precision, further
 * digits truncated), so a client-supplied stamp round-trips and an inclusive search bound stays inclusive.
 * @throws 400 `<field> must be a valid date-time`
 */
export function normaliseTime(value: string, field = 'date-time'): string {
  const d = new Date(value)
  if (typeof value !== 'string' || Number.isNaN(d.getTime())) throw badRequest(`BAD_REQUEST: ${field} must be a valid date-time`)
  const rendered = isoUtc(d)
  const digits = ISO_FRACTION_RE.exec(value)?.[1]
  if (!digits || digits.length <= 3) return rendered
  return rendered.replace(/\.\d{6}Z$/, `.${digits.padEnd(6, '0').slice(0, 6)}Z`)
}

function tagToResponse(t: TagRow): Tag {
  return { id: t.id, category: t.category, value: t.value }
}

/**
 * The spec's 400 for modifyTagsForTransaction ("tag validation failed, list is empty, or operation is
 * missing"): operation ADD/REMOVE, 1..100 tags, each with an id or a category/value pair of 1..64
 * characters without leading/trailing whitespace. Runs before schema validation so the message is the spec's.
 */
export function validateTagsBody(body: unknown): asserts body is ModifyTagsRequestBody {
  const fail = (): never => { throw badRequest(TAGS_400_MESSAGE) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail()
  const b = body as Record<string, unknown>
  if (b.operation !== 'ADD' && b.operation !== 'REMOVE') fail()
  if (!Array.isArray(b.tags) || b.tags.length < 1 || b.tags.length > 100) fail()
  for (const tag of b.tags as unknown[]) {
    if (!tag || typeof tag !== 'object' || Array.isArray(tag)) fail()
    const t = tag as Record<string, unknown>
    if (t.id !== undefined && t.id !== null && typeof t.id !== 'string') fail()
    if (t.id) continue
    for (const k of ['category', 'value']) {
      const v = t[k]
      if (typeof v !== 'string' || v.length < 1 || v.length > 64 || !TAG_RE.test(v)) fail()
    }
  }
}
