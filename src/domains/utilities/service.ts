/**
 * The 13 staging mock generators (spec §5.5, docs/map/utilities.md, docs/map/00-webhook-matrix.md §3 / §8).
 * They own no state: each one resolves its card / account / mandate through the other domains' services
 * and drives them — cards (card-side checks, expiry), transactions (holds, the posting engine: every money
 * movement and TRANSACTION webhook), direct-entry (returns of outbound direct debits) and payto (MANDATE /
 * MANDATE_PAYMENT, RAPAIN, search stubs). Deferred steps (settlement, hold update) run through
 * ctx.scheduler.later on the virtual clock.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import type { AppContext } from '../../context.js'
import { compact } from '../../events/notify.js'
import { isoUtc } from '../../lib/clock.js'
import { badRequest, notFound, unprocessable } from '../../lib/errors.js'
import { LOCAL_BSB } from '../../lib/ids.js'
import { fromCents, hasAtMostTwoDecimals, toCents, type Cents } from '../../lib/money.js'
import type { Account } from '../accounts/repo.js'
import type { Card, CardProcessorResponse } from '../cards/index.js'
import type { MandateTrigger } from '../payto/index.js'
import { cardChannel, requestCents } from '../transactions/index.js'
import type { CallerRefusal, CardUsageDetails, CounterpartDetails, LedgerOutcome, LedgerTransaction, Money, PostInput, RefusalDetails, ReturnReason } from '../transactions/index.js'

type S = components['schemas']
export type GenerateCardTransactionRequestBody = S['GenerateCardTransactionRequestBody']
export type GenerateCardHoldTransactionRequestBody = S['GenerateCardHoldTransactionRequestBody']
export type GenerateCardHoldAndSettleTransactionRequestBody = S['GenerateCardHoldAndSettleTransactionRequestBody']
export type GenerateUpdateHoldTransactionRequestBody = S['GenerateUpdateHoldTransactionRequestBody']
export type GenerateInboundNppTransactionRequestBody = S['GenerateInboundNppTransactionRequestBody']
export type GenerateRapRequestBody = S['GenerateRapRequestBody']
export type GenerateInboundDeRequestBody = S['GenerateInboundDeRequestBody']
export type GenerateInitiatorMandateNotificationRequestBody = S['GenerateInitiatorMandateNotificationRequestBody']
export type GeneratePayerMandateNotificationRequestBody = S['GeneratePayerMandateNotificationRequestBody']
export type GenerateRapainRequestBody = S['GenerateRapainRequestBody']
export type CreateStubForMandateSearchPaymentInstructionsRequestBody = S['CreateStubForMandateSearchPaymentInstructionsRequestBody']
export type ChangeCardExpiryDateRequestBody = S['ChangeCardExpiryDateRequestBody']
export type GenericMessage = S['GenericMessage']
export type MerchantDetails = S['MerchantDetails']
export type CardUsage = NonNullable<GenerateCardHoldTransactionRequestBody['cardUsage']>
export type DeclineReason = NonNullable<GenerateCardHoldTransactionRequestBody['declineReason']>
type ExternalMerchantDetails = S['ExternalMerchantDetails']
/** The hold-based mock bodies (hold, hold + settlement, hold + update) share these fields. */
type HoldBody = GenerateCardHoldTransactionRequestBody

declare module '../../context.js' {
  interface ServiceMap {
    utilities: UtilitiesService
  }
}

/**
 * GenericMessage texts: the four documented literals (RAPAIN, RAP, Initiator notification; the search stub
 * declares no body) and the same "<what> generated." style, from each operation's summary, for the rest.
 */
export const MESSAGES = {
  generateAtmTransaction: 'Mock ATM card transaction generated.',
  generateAuthHold: 'Mock card Hold generated.',
  generateCardTransaction: 'Mock card Hold and Settlement generated.',
  generateHoldAndUpdateHoldTransactions: 'Mock card Hold and Hold Update generated.',
  generateRefundTransaction: 'Mock refund card transaction generated.',
  generateInboundNppTransaction: 'Inbound NPP transaction generated.',
  generateInboundNppTransactionV2: 'Receive A Payment generated.',
  generateInboundDeTransaction: 'Inbound Direct Entry request generated.',
  generateMandateNotificationForInitiator: 'Mandate Notification for Initiator generated.',
  generateMandateNotificationForPayer: 'Mandate Notification for Payer generated.',
  generateReceiveAPaymentInstruction: 'Receive A Payment Instruction generated.',
  changeCardExpiryDate: 'Card expiry date changed successfully.',
} as const

/** declineReason -> TransactionEventDto.cardProcessorResponse (00-webhook-matrix C17 / §3). */
export const DECLINE_PROCESSOR_RESPONSE: Record<DeclineReason, CardProcessorResponse> = {
  CARD_EXPIRED: 'EXPIRED_CARD',
  WRONG_CVV: 'CVV_FAIL',
  CVV_BLOCKED: 'CVV2_FAILURE',
  INCORRECT_PIN: 'INCORRECT_PIN',
  ALLOWED_PIN_RETRIES_EXCEEDED: 'ALLOWED_PIN_RETRIES_EXCEEDED',
  INVALID_MERCHANT: 'INVALID_MERCHANT',
  CARD_IS_NOT_ACTIVE: 'CARD_IS_NOT_ACTIVE',
  RESTRICTED_CARD: 'RESTRICTED_CARD',
}

const usage = (u: Partial<CardUsageDetails>): CardUsageDetails => ({
  isMagneticStripePayment: false, isContactless: false, isCardPresent: false, isMobileWalletPayment: false, isAtmWithdrawal: false, ...u,
})
/** cardUsage -> webhook cardUsageDetails; an omitted cardUsage is a chip card-present payment (the docs hold sample). */
export const CARD_USAGE: Record<CardUsage, CardUsageDetails> = {
  CARD_PRESENT: usage({ isCardPresent: true }),
  CONTACTLESS: usage({ isCardPresent: true, isContactless: true }),
  MAGNETIC_STRIPE: usage({ isCardPresent: true, isMagneticStripePayment: true }),
}
const ATM_USAGE = usage({ isCardPresent: true, isAtmWithdrawal: true })
/** The refund sample: card not present, no wallet, no ATM. */
const REFUND_USAGE = usage({})

/** Mandate-notification triggers the MMS mocks cannot send (docs: "doesn't allow to use this trigger"; C14). */
const RECALL_TRIGGERS: ReadonlySet<string> = new Set(['MCRR', 'MAMR'])

/**
 * NPP payment-return reason codes (ISO 20022 ExternalReturnReason) -> webhook ReturnReason. The docs sample's
 * CUSTOMER_REQUEST message is verbatim; anything unmapped is OTHER.
 */
const NPP_RETURN_REASONS: Record<string, ReturnReason> = {
  AC01: { code: 'ACCOUNT_INVALID', message: 'Incorrect account number' },
  AC02: { code: 'ACCOUNT_INVALID', message: 'Invalid debtor account number' },
  AC03: { code: 'ACCOUNT_INVALID', message: 'Invalid creditor account number' },
  AC04: { code: 'ACCOUNT_CLOSED', message: 'Closed account number' },
  AC06: { code: 'ACCOUNT_BLOCKED', message: 'Blocked account' },
  AC07: { code: 'ACCOUNT_CLOSED', message: 'Closed creditor account number' },
  AM01: { code: 'AMOUNT_INVALID', message: 'Zero amount' },
  AM02: { code: 'AMOUNT_INVALID', message: 'Not allowed amount' },
  AM03: { code: 'CURRENCY_INVALID', message: 'Not allowed currency' },
  AM05: { code: 'DUPLICATE', message: 'Duplication' },
  AM09: { code: 'AMOUNT_INVALID', message: 'Wrong amount' },
  BE01: { code: 'ACCOUNT_INVALID', message: 'Inconsistent with end customer' },
  CUST: { code: 'CUSTOMER_REQUEST', message: 'Return of funds requested by end customer' },
  DUPL: { code: 'DUPLICATE', message: 'Duplicate payment' },
  FOCR: { code: 'CANCELLED', message: 'Following cancellation request' },
  FR01: { code: 'FRAUD', message: 'Fraudulent origin' },
  FRAD: { code: 'FRAUD', message: 'Fraudulent origin' },
  MD06: { code: 'CUSTOMER_REQUEST', message: 'Return of funds requested by end customer' },
}

const BSB_RE = /^\d{6}$/
const DE_ACCOUNT_RE = /^\d{5,9}$/
const NPP_RECEIVER_ACCOUNT_RE = /^\d{8}$/
const NPP_SENDER_ACCOUNT_RE = /^\d{6,9}$/
/** BBAN account identification: BSB (6 digits) followed by the account number (5-9 digits). */
const BBAN_RE = /^(\d{6})(\d{5,9})$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export class UtilitiesService {
  constructor(private readonly ctx: AppContext) {}

  private get cards() { return this.ctx.services.cards }
  private get accounts() { return this.ctx.services.accounts }
  private get ledger() { return this.ctx.services.transactions }
  private get payto() { return this.ctx.services.payto }
  private get directEntry() { return this.ctx.services.directEntry }

  // ---------------------------------------------------------------- card mocks

  /** generateAuthHold: the authorisation only (no settlement follows). */
  authHold(body: GenerateCardHoldTransactionRequestBody): GenericMessage {
    this.authorise(body)
    return { message: MESSAGES.generateAuthHold }
  }

  /** generateCardTransaction: the authorisation, then its settlement settlementDelayInSeconds later (config.asyncDelayMs when omitted). */
  holdAndSettle(body: GenerateCardHoldAndSettleTransactionRequestBody): GenericMessage {
    const r = this.authorise(body)
    if (r.holdId) {
      const holdId = r.holdId
      this.ctx.scheduler.later(() => this.settle(holdId), this.delayMs(body.settlementDelayInSeconds))
    }
    return { message: MESSAGES.generateCardTransaction }
  }

  /**
   * generateHoldAndUpdateHoldTransactions: the authorisation; updateHoldDelayInSeconds later the update
   * (negative updateHoldAmount: an incremental authorisation, re-checked like the first one; positive: a
   * partial reversal, or a full one when it equals the hold); settlementDelayInSeconds after the update the
   * settlement of the updated hold (none after a full reversal). A delay that is omitted is config.asyncDelayMs.
   */
  holdAndUpdate(body: GenerateUpdateHoldTransactionRequestBody): GenericMessage {
    const holdCents = cardAmountCents(body.amount)
    const u = body.updateHoldAmount
    if (typeof u !== 'number' || !hasAtMostTwoDecimals(u)) throw badRequest('BAD_REQUEST: updateHoldAmount must be a number with at most 2 decimal places')
    if (u === 0) throw badRequest('BAD_REQUEST: updateHoldAmount must not be 0 (negative increases the hold, positive decreases it)')
    const updateCents = toCents(u)
    if (updateCents > holdCents) throw badRequest(`BAD_REQUEST: updateHoldAmount ${u} would release more than the hold of ${fromCents(holdCents)}`)
    const r = this.authorise(body)
    if (r.holdId) {
      const holdId = r.holdId
      const updateDelay = this.delayMs(body.updateHoldDelayInSeconds)
      const settleDelay = this.delayMs(body.settlementDelayInSeconds)
      const updateDue = this.ctx.clock.now().getTime() + updateDelay
      this.ctx.scheduler.later(() => {
        this.updateHold(holdId, updateCents)
        // measured from when the update was due, so one clock jump past both runs both
        this.at(updateDue + settleDelay, () => this.settle(holdId))
      }, updateDelay)
    }
    return { message: MESSAGES.generateHoldAndUpdateHoldTransactions }
  }

  /**
   * generateRefundTransaction: a settled merchant refund crediting abs(amount) (spec: amount < 0; docs sample:
   * positive credit, C20) as CARD_PAYMENT_REVERSAL / CARD_TRANSACTION_REFUND with its own id. It is a credit,
   * not a spend: no card-side checks, only the ledger's (account status, MAX_BALANCE).
   */
  refund(body: GenerateCardTransactionRequestBody): GenericMessage {
    const { card, account } = this.cardAndAccount(body.cardToken)
    const cents = cardAmountCents(body.amount)
    const original = this.originalAmount(body.currency, account, cents)
    const m = merchant(body.merchantDetails)
    this.ledger.post(compact({
      accountId: account.id,
      amountCents: cents,
      type: 'CARD_PAYMENT_REVERSAL' as const,
      channel: original ? 'VISA_REFUND_INTERNATIONAL' as const : 'VISA_REFUND_DOMESTIC' as const,
      counterpart: merchantCounterpart(m),
      category: mccCategory(m),
      cardId: card.id,
      cardUsage: REFUND_USAGE,
      originalAmount: original,
      actionOwner: 'PLATFORM' as const,
      notifyRefusal: true,
    }))
    return { message: MESSAGES.generateRefundTransaction }
  }

  /**
   * generateAtmTransaction: a Visa stand-in cash withdrawal with no hold — one settled ATM_WITHDRAWAL posting
   * (CARD_TRANSACTION, isPending false, isAtmTransaction). Check order as a card authorisation: account
   * status, card-side checks (cashWithdrawalEnabled, PIN), account rules, then the posting's ATM / card
   * limits and funds; a refusal emits the refused CARD_TRANSACTION.
   */
  atm(body: GenerateCardTransactionRequestBody): GenericMessage {
    const { card, account } = this.cardAndAccount(body.cardToken)
    const cents = cardAmountCents(body.amount)
    const original = this.originalAmount(body.currency, account, cents)
    const m = merchant(body.merchantDetails)
    const posting: PostInput = compact({
      accountId: account.id,
      amountCents: -cents,
      type: 'ATM_WITHDRAWAL' as const,
      channel: cardChannel('ATM_WITHDRAWAL', ATM_USAGE, original !== undefined),
      counterpart: merchantCounterpart(m),
      category: mccCategory(m),
      cardId: card.id,
      cardUsage: ATM_USAGE,
      originalAmount: original && { amountCents: -original.amountCents, currency: original.currency },
      actionOwner: 'PLATFORM' as const,
      notifyRefusal: true,
    })
    const refuse = (outcome: LedgerOutcome, extra: Partial<RefusalDetails> = {}): GenericMessage => {
      this.ledger.notifyRefused(this.accounts.get(account.id), 'PLATFORM', outcome, compact({
        amountCents: -cents,
        originalAmount: posting.originalAmount,
        webhookType: 'CARD_TRANSACTION' as const,
        transactionTime: isoUtc(this.ctx.clock.now()),
        isPending: false,
        isAtm: true,
        cardId: card.id,
        cardUsage: ATM_USAGE,
        merchant: m,
        category: posting.category,
        ...extra,
      }))
      return { message: MESSAGES.generateAtmTransaction }
    }
    const gate = this.accounts.requireOpenForMovement(account.id)
    if (typeof gate === 'string') return refuse(gate)
    const cardRefusal = this.cards.authorise(card, { cardUsage: ATM_USAGE, type: 'ATM_WITHDRAWAL' })
    if (cardRefusal) return refuse(cardRefusal.outcome, { cardPreferenceOutcome: cardRefusal.cardPreferenceOutcome, cardProcessorResponse: cardRefusal.cardProcessorResponse })
    const rule = this.accounts.evaluateRules(account.id, { mcc: m?.merchantCategoryCode, merchantId: m?.merchantId, merchantName: m?.name })
    if (rule) return refuse('REFUSED_RULES', { ruleDetails: rule })
    this.ledger.post(posting)
    return { message: MESSAGES.generateAtmTransaction }
  }

  /** changeCardExpiryDate: through cards.setExpiryDate (month-end; a past date expires the card with CARD_STATUS_CHANGE). */
  changeExpiryDate(cardId: string, body: ChangeCardExpiryDateRequestBody): GenericMessage {
    this.cards.setExpiryDate(cardId, body.expiryDate)
    return { message: MESSAGES.changeCardExpiryDate }
  }

  /** The hold-based authorisation shared by the three hold mocks; `holdId` when a hold was created. */
  private authorise(body: HoldBody): { holdId?: string } {
    const { card, account } = this.cardAndAccount(body.cardToken)
    const cents = cardAmountCents(body.amount)
    const refusal = body.declineReason ? this.processorDecline(card, body.declineReason) : undefined
    const r = this.cards.authoriseHold(card, compact({
      amountCents: cents,
      cardUsage: CARD_USAGE[body.cardUsage ?? 'CARD_PRESENT'],
      merchant: merchant(body.merchantDetails),
      originalAmount: this.originalAmount(body.currency, account, cents),
      actionOwner: 'PLATFORM' as const,
      refusal,
    }))
    return r.outcome === 'ACCEPTED' && r.hold ? { holdId: r.hold.id } : {}
  }

  /**
   * A processor decline (00-open-questions W5): REFUSED_RULES with cardPreferenceOutcome OK and the mapped
   * cardProcessorResponse, like the cards domain's own processor declines. The card state follows the
   * reason: a wrong CVV / PIN spends a try, CVV_BLOCKED / ALLOWED_PIN_RETRIES_EXCEEDED block it.
   */
  private processorDecline(card: Card, reason: DeclineReason): CallerRefusal {
    if (reason === 'WRONG_CVV') this.cards.recordCvvFailure(card.id)
    else if (reason === 'CVV_BLOCKED') this.cards.blockCvv(card.id)
    else if (reason === 'INCORRECT_PIN') this.cards.recordPinFailure(card.id)
    else if (reason === 'ALLOWED_PIN_RETRIES_EXCEEDED') this.cards.blockPin(card.id)
    return { outcome: 'REFUSED_RULES', cardPreferenceOutcome: 'OK', cardProcessorResponse: DECLINE_PROCESSOR_RESPONSE[reason] }
  }

  /** The hold update: a partial / full reversal, or an increment that passes the card checks again (then the ledger's). No-op once the hold is closed. */
  private updateHold(holdId: string, updateCents: Cents): void {
    const holds = this.ledger.holds
    const hold = holds.find(holdId)
    if (!hold || hold.state !== 'AUTHORISED') return
    if (updateCents > 0) {
      holds.decrease(holdId, updateCents, { actionOwner: 'PLATFORM' })
      return
    }
    const delta = -updateCents
    const card = this.cards.find(hold.cardId)
    const refusal = card ? this.cards.authorise(card, { cardUsage: hold.cardUsage, type: hold.type }) : null
    if (refusal) {
      this.ledger.notifyRefused(this.accounts.get(hold.accountId), 'PLATFORM', refusal.outcome, compact({
        amountCents: -delta,
        webhookType: 'CARD_TRANSACTION' as const,
        transactionTime: hold.authorisedAt,
        isPending: false,
        isAtm: hold.type === 'ATM_WITHDRAWAL',
        holdId: hold.id,
        cardId: hold.cardId,
        cardUsage: hold.cardUsage,
        merchant: hold.merchant,
        description: hold.description,
        category: hold.category,
        cardPreferenceOutcome: refusal.cardPreferenceOutcome,
        cardProcessorResponse: refusal.cardProcessorResponse,
      }))
      return
    }
    holds.increase(holdId, delta, { actionOwner: 'PLATFORM' })
  }

  /** Settles the whole (possibly updated) hold; no-op once it is closed (reversed, cancelled, settled). */
  private settle(holdId: string): void {
    const hold = this.ledger.holds.find(holdId)
    if (!hold || hold.state !== 'AUTHORISED') return
    this.ledger.holds.settle(holdId, undefined, { actionOwner: 'PLATFORM' })
  }

  /** The card (by token or id; 404) and its account, whatever its status (the ledger's account gate refuses a LOCKED / CLOSED one). */
  private cardAndAccount(ref: string): { card: Card; account: Account } {
    const card = this.cards.resolve(ref)
    return { card, account: this.accounts.get(card.accountId) }
  }

  /** originalCurrencyAmount when the transaction currency (default AUD) is not the account's: 1:1, no FX rates locally. */
  private originalAmount(currency: string | null | undefined, account: Account, cents: Cents): Money | undefined {
    const c = currency ?? 'AUD'
    return c === account.currency ? undefined : { amountCents: cents, currency: c }
  }

  // ---------------------------------------------------------------- inbound NPP / DE mocks

  /**
   * generateInboundNppTransaction: an NPP credit into the receiver account (BSB + 8-digit account number),
   * INTERBANK_TRANSFER_IN / CUSCAL_NPP_TRANSFER_IN with the sender as counterpart. Ledger refusals (blocked
   * account, MAX_BALANCE, inbound caps) emit the refused TRANSACTION. Idempotency is the route's.
   */
  inboundNpp(body: GenerateInboundNppTransactionRequestBody): GenericMessage {
    anchored(body.receiverBsb, BSB_RE, 'receiverBsb')
    anchored(body.receiverAccountNumber, NPP_RECEIVER_ACCOUNT_RE, 'receiverAccountNumber')
    anchored(body.senderBsb, BSB_RE, 'senderBsb')
    anchored(body.senderAccountNumber, NPP_SENDER_ACCOUNT_RE, 'senderAccountNumber')
    const cents = requestCents(body.amount, 'amount')
    const account = this.localAccount(body.receiverBsb, body.receiverAccountNumber, 'Receiver')
    this.ledger.post(compact({
      accountId: account.id,
      amountCents: cents,
      type: 'INTERBANK_TRANSFER_IN' as const,
      channel: 'CUSCAL_NPP_TRANSFER_IN' as const,
      counterpart: { name: body.senderName, basicAccountNumber: { accountNumber: body.senderAccountNumber, branchNumber: body.senderBsb } },
      description: body.description,
      reference: body.reference,
      category: 'BANK_TRANSFER',
      actionOwner: 'PLATFORM' as const,
      notifyRefusal: true,
    }))
    return { message: MESSAGES.generateInboundNppTransaction }
  }

  /**
   * generateInboundNppTransactionV2 (Receive A Payment): credits the creditor account (BBAN = BSB + account
   * number) with instructedAmount, INTERBANK_TRANSFER_IN with the debtor as counterpart and the end-to-end id
   * as reference. With mandateInformation it is the PayTo creditor leg: the mandate must exist (404), the
   * instruction id and initiating party must be given (400), and the posting carries mandatePaymentDetails,
   * originType MANDATE_PAYMENT, originId = mandate id (no MANDATE_PAYMENT: the RAPAIN owns it). With
   * paymentReturnInformation.returnReasonCode it is an inbound return (returnInbound()).
   */
  receivePayment(body: GenerateRapRequestBody): GenericMessage {
    const pi = body.paymentInformation
    const creditor = this.bbanAccount(body.creditorInformation.accountIdentification, 'Creditor')
    const counterpart = compact({ name: body.debtorInformation.partyName || undefined, basicAccountNumber: bban(body.debtorInformation.accountIdentification) })
    const ret = body.paymentReturnInformation
    if (ret?.returnReasonCode) {
      const cents = decimalCents(ret.returnAmount ?? pi.instructedAmount, ret.returnAmount !== undefined ? 'paymentReturnInformation.returnAmount' : 'paymentInformation.instructedAmount')
      this.returnInbound(creditor, cents, ret.returnReasonCode, ret.originalTransactionIdentification, { counterpart, description: pi.remittanceInformationUnstructured, reference: pi.endToEndIdentification })
      return { message: MESSAGES.generateInboundNppTransactionV2 }
    }
    const cents = decimalCents(pi.instructedAmount, 'paymentInformation.instructedAmount')
    let mandate: Pick<PostInput, 'mandatePayment' | 'originType' | 'originId'> = {}
    const mi = body.mandateInformation
    if (mi) {
      if (!mi.instructionIdentification || !mi.initiatingPartyName) {
        throw badRequest('BAD_REQUEST: mandateInformation.instructionIdentification and mandateInformation.initiatingPartyName must be populated for mandate payments')
      }
      const m = this.payto.get(mi.mandateIdentification)
      mandate = { mandatePayment: { mandateId: m.id, instructionId: mi.instructionIdentification, initiatingPartyName: mi.initiatingPartyName }, originType: 'MANDATE_PAYMENT', originId: m.id }
    }
    this.ledger.post(compact({
      accountId: creditor.id,
      amountCents: cents,
      type: 'INTERBANK_TRANSFER_IN' as const,
      channel: 'CUSCAL_NPP_TRANSFER_IN' as const,
      counterpart: Object.keys(counterpart).length ? counterpart : undefined,
      description: pi.remittanceInformationUnstructured || undefined,
      reference: pi.endToEndIdentification || undefined,
      category: 'BANK_TRANSFER',
      ...mandate,
      actionOwner: 'PLATFORM' as const,
      notifyRefusal: true,
    }))
    return { message: MESSAGES.generateInboundNppTransactionV2 }
  }

  /**
   * An inbound NPP payment return: the outbound NPP payment of the creditor account named by
   * originalTransactionIdentification (a PayTo instruction id, its I/N letter ignored), else the most recent
   * one of the returned amount, not returned yet (404 when none; a return larger than the payment is 422)
   * comes back as a positive INTERBANK_TRANSFER_OUT / NPP_RETURN_IN posting, originType TRANSACTION,
   * originId = the original posting, with the webhook's returnReason (00-transactions C4, docs return sample).
   */
  private returnInbound(account: Account, cents: Cents, reasonCode: string, originalId: string | undefined, extra: Pick<PostInput, 'counterpart' | 'description' | 'reference'>): void {
    const postings = this.ledger.listForAccount(account.id)
    const returned = new Set(postings.filter((t) => t.channel === 'NPP_RETURN_IN' && t.originId).map((t) => t.originId))
    const outbound = postings.filter((t) => t.type === 'INTERBANK_TRANSFER_OUT' && t.amount < 0 && !returned.has(t.id))
    const sameId = (a: string, b: string): boolean => a.length === 35 && b.length === 35 && a.slice(0, 11) === b.slice(0, 11) && a.slice(12) === b.slice(12)
    const original: LedgerTransaction | undefined =
      (originalId ? outbound.find((t) => t.mandatePayment?.instructionId && sameId(t.mandatePayment.instructionId, originalId)) : undefined) ??
      outbound.find((t) => -t.amount === cents)
    if (!original) throw notFound(`NOT_FOUND: No outbound NPP payment of ${fromCents(cents)} on account ${account.id} to return`)
    if (cents > -original.amount) throw unprocessable(`INVALID_AMOUNT: The return of ${fromCents(cents)} exceeds the original payment of ${fromCents(-original.amount)}`)
    this.ledger.post(compact({
      accountId: account.id,
      amountCents: cents,
      type: 'INTERBANK_TRANSFER_OUT' as const,
      channel: 'NPP_RETURN_IN' as const,
      counterpart: original.counterpart ?? extra.counterpart,
      description: original.description ?? extra.description,
      reference: extra.reference,
      category: 'BANK_TRANSFER',
      originType: 'TRANSACTION' as const,
      originId: original.id,
      mandatePayment: original.mandatePayment,
      returnReason: NPP_RETURN_REASONS[reasonCode] ?? { code: 'OTHER', message: `Payment returned with reason code ${reasonCode}` },
      limits: ['MAX_BALANCE' as const],
      actionOwner: 'PLATFORM' as const,
      notifyRefusal: true,
    }))
  }

  /**
   * generateInboundDeTransaction. DIRECT: the local account is the recipient; CREDIT -> INTERBANK_TRANSFER_IN
   * (CUSCAL_DE_CREDIT_IN), DEBIT -> DIRECT_DEBIT_TRANSFER (negative, CUSCAL_DE_DEBIT_IN, originType
   * DIRECT_DEBIT, DIRECT_DEBIT_PER_DAY + funds), the sender as counterpart; refusals emit the refused
   * TRANSACTION. RETURN (DEBIT): the local account is the sender of an outbound direct debit in flight, which
   * direct-entry marks RETURNED (DIRECT_ENTRY webhook only; 404 when nothing matches). REFUSAL (DEBIT; spec
   * §5.5, W7): the local account is the recipient (the docs sample), the sender of an outbound direct debit
   * in flight, which direct-entry marks INCOMPLETE (DIRECT_ENTRY webhook only; 404 when nothing matches).
   * Idempotency is the route's.
   */
  inboundDe(body: GenerateInboundDeRequestBody): GenericMessage {
    anchored(body.recipientBsb, BSB_RE, 'recipientBsb')
    anchored(body.recipientAccountNumber, DE_ACCOUNT_RE, 'recipientAccountNumber')
    anchored(body.senderBsb, BSB_RE, 'senderBsb')
    anchored(body.senderAccountNumber, DE_ACCOUNT_RE, 'senderAccountNumber')
    const cents = requestCents(body.amount, 'amount')
    const done = { message: MESSAGES.generateInboundDeTransaction }

    if (body.recordType === 'RETURN') {
      if (!body.returnReason) throw badRequest('BAD_REQUEST: returnReason is required for record type RETURN')
      if (body.transactionType !== 'DEBIT') throw unprocessable('INVALID_ARGUMENT: only returns of outbound direct debits (transactionType DEBIT) are supported')
      const returned = this.directEntry.returnOutbound({ senderBsb: body.senderBsb, senderAccountNumber: body.senderAccountNumber, amountCents: cents, returnReason: body.returnReason })
      if (!returned) throw notFound(`NOT_FOUND: No outbound direct debit of ${fromCents(cents)} from BSB ${body.senderBsb} account ${body.senderAccountNumber} is awaiting settlement`)
      return done
    }
    if (body.recordType === 'REFUSAL') {
      if (!body.refusalReason) throw badRequest('BAD_REQUEST: refusalReason is required for record type REFUSAL')
      if (body.transactionType !== 'DEBIT') throw unprocessable('INVALID_ARGUMENT: only refusals of outbound direct debits (transactionType DEBIT) are supported')
      // the docs sample's orientation: the local account (the direct debit's sender) is the recipient here
      const refused = this.directEntry.refuseOutbound({ senderBsb: body.recipientBsb, senderAccountNumber: body.recipientAccountNumber, amountCents: cents, refusalReason: body.refusalReason })
      if (!refused) throw notFound(`NOT_FOUND: No outbound direct debit of ${fromCents(cents)} from BSB ${body.recipientBsb} account ${body.recipientAccountNumber} is awaiting settlement`)
      return done
    }

    const account = this.localAccount(body.recipientBsb, body.recipientAccountNumber, 'Recipient')
    const common = {
      accountId: account.id,
      counterpart: compact({ name: body.senderName, basicAccountNumber: { accountNumber: body.senderAccountNumber, branchNumber: body.senderBsb } }),
      description: body.description,
      category: 'BANK_TRANSFER',
      actionOwner: 'PLATFORM' as const,
      notifyRefusal: true,
    }
    this.ledger.post(compact(body.transactionType === 'CREDIT'
      ? { ...common, amountCents: cents, type: 'INTERBANK_TRANSFER_IN' as const, channel: 'CUSCAL_DE_CREDIT_IN' as const }
      : { ...common, amountCents: -cents, type: 'DIRECT_DEBIT_TRANSFER' as const, channel: 'CUSCAL_DE_DEBIT_IN' as const, originType: 'DIRECT_DEBIT' as const }))
    return done
  }

  // ---------------------------------------------------------------- PayTo mocks

  /**
   * generateMandateNotificationForInitiator / ForPayer: one MANDATE with the requested trigger to that side,
   * the MMS state it implies applied by payto.emitMandateNotification. The recall triggers MCRR / MAMR are
   * refused (400, C14). An unknown mandate is 404 on the Initiator side; on the Payer side it is an external
   * Initiator's mandate reaching a local debtor and is registered from mandateDetails (404 when the debtor
   * account is not local either).
   */
  mandateNotification(side: 'INITIATOR' | 'PAYER', trigger: MandateTrigger, body: GenerateInitiatorMandateNotificationRequestBody | GeneratePayerMandateNotificationRequestBody): GenericMessage {
    if (RECALL_TRIGGERS.has(trigger)) throw badRequest(`BAD_REQUEST: trigger ${trigger} (a recall) cannot be generated by the mandate notification mocks`)
    const d = body.mandateDetails
    for (const [field, value] of [['validityStartDate', d.validityStartDate], ['validityEndDate', d.validityEndDate]] as const) {
      if (value !== undefined && !DATE_RE.test(value)) throw badRequest(`BAD_REQUEST: mandateDetails.${field} must be a date of the form YYYY-MM-DD`)
    }
    const known = this.payto.find(d.mandateId)
    if (!known && (side === 'INITIATOR' || !this.bbanLocal(d.debtorInformation.accountIdentification))) {
      throw notFound(`NOT_FOUND: Mandate ${d.mandateId} not found`)
    }
    this.payto.emitMandateNotification(side, d.mandateId, trigger, compact({
      actionId: body.actionDetails.actionId,
      actionOwner: 'PLATFORM' as const,
      mandateDetails: known ? undefined : d,
    }))
    return { message: side === 'INITIATOR' ? MESSAGES.generateMandateNotificationForInitiator : MESSAGES.generateMandateNotificationForPayer }
  }

  /**
   * generateReceiveAPaymentInstruction (RAPAIN): payto.receivePaymentInstruction — ACCP debits the mandate's
   * local debtor (INTERBANK_TRANSFER_OUT with mandatePaymentDetails) and answers MANDATE_PAYMENT_ACCEPTED; RJCT
   * or a refused debit answers MANDATE_PAYMENT_REJECTED. Unknown mandate 404.
   */
  receivePaymentInstruction(body: GenerateRapainRequestBody): GenericMessage {
    const cents = decimalCents(body.paymentInformation.instructedAmount, 'paymentInformation.instructedAmount')
    this.payto.receivePaymentInstruction(compact({
      mandateId: body.mandateInformation.mandateIdentification,
      instructionId: body.paymentInformation.instructionIdentification,
      amountCents: cents,
      initiatingPartyName: body.mandateInformation.initiatingPartyName,
      // the generated TS type keeps the spec's comma-joined enum literal; the runtime schema allows ACCP / RJCT
      status: body.transactionStatusInformation.transactionStatus as string as 'ACCP' | 'RJCT',
      description: body.paymentInformation.remittanceInformationUnstructured,
      actionOwner: 'PLATFORM' as const,
    }))
    return { message: MESSAGES.generateReceiveAPaymentInstruction }
  }

  /** createStubForMandateSearchPaymentInstructions: replaces the mandate's search stub (payto). Unknown mandate 404. */
  stubSearchInstructions(body: CreateStubForMandateSearchPaymentInstructionsRequestBody): void {
    this.payto.addStubInstructions(body.mandateIdentification, body.paymentInstructionSummaries)
  }

  // ---------------------------------------------------------------- helpers

  /**
   * A local account by BSB + account number (an open one wins over a closed one with the same number). 404
   * when none; a LOCKED / CLOSED one is returned and refused by the ledger's account gate (spec §5.2).
   */
  private localAccount(bsb: string, accountNumber: string, party: string): Account {
    const account = bsb === LOCAL_BSB ? this.findLocal(accountNumber) : undefined
    if (!account) throw notFound(`NOT_FOUND: ${party} account BSB ${bsb} account number ${accountNumber} not found`)
    return account
  }

  /** A local account named by a BBAN account identification (BSB + account number). */
  private bbanAccount(identification: string, party: string): Account {
    const b = bban(identification)
    if (!b) throw notFound(`NOT_FOUND: ${party} account ${identification} not found`)
    return this.localAccount(b.branchNumber, b.accountNumber, party)
  }

  private bbanLocal(identification: string): Account | undefined {
    const b = bban(identification)
    return b && b.branchNumber === LOCAL_BSB ? this.findLocal(b.accountNumber) : undefined
  }

  private findLocal(accountNumber: string): Account | undefined {
    const hits = this.accounts.search(accountNumber)
    const hit = hits.find((a) => a.status !== 'CLOSED') ?? hits[0]
    return hit?.accountHayId ? this.accounts.find(hit.accountHayId) : undefined
  }

  /** Delay of a deferred mock step: the given seconds, else config.asyncDelayMs. */
  private delayMs(seconds: number | undefined): number {
    return seconds === undefined ? this.ctx.config.asyncDelayMs : seconds * 1000
  }

  /** Runs `fn` when the virtual clock reaches `dueAt` (epoch ms): inline when already due, else through the scheduler. */
  private at(dueAt: number, fn: () => void): void {
    const delay = dueAt - this.ctx.clock.now().getTime()
    if (delay <= 0) fn()
    else this.ctx.scheduler.later(fn, delay)
  }
}

/** Card-mock amount: negative (schema), at most 2 dp -> positive cents. */
function cardAmountCents(amount: number): Cents {
  if (typeof amount !== 'number' || !hasAtMostTwoDecimals(amount)) throw badRequest('BAD_REQUEST: amount must be a number with at most 2 decimal places')
  if (!(amount < 0)) throw badRequest('BAD_REQUEST: amount must be negative')
  return toCents(-amount)
}

/** Decimal-string amount (RAP / RAPAIN pattern) -> positive cents; 0 or empty is a 400. */
function decimalCents(value: string, field: string): Cents {
  const n = Number(value)
  if (!/^\d*(\.\d{0,2})?$/.test(value) || !Number.isFinite(n) || n <= 0) throw badRequest(`BAD_REQUEST: ${field} must be an amount greater than 0 with at most 2 decimal places`)
  return toCents(n)
}

/** Full-match a spec pattern the contract leaves unanchored (00-open-questions I7). */
function anchored(value: string, re: RegExp, field: string): void {
  if (!re.test(value)) throw badRequest(`BAD_REQUEST: ${field} must match ${re.source}`)
}

function bban(identification: string | undefined): { accountNumber: string; branchNumber: string } | undefined {
  const m = identification ? BBAN_RE.exec(identification) : null
  return m ? { branchNumber: m[1]!, accountNumber: m[2]! } : undefined
}

/** MerchantDetails (request) -> the ledger's ExternalMerchantDetails. */
function merchant(m: MerchantDetails | undefined): ExternalMerchantDetails | undefined {
  if (!m) return undefined
  const out: ExternalMerchantDetails = compact({
    name: m.merchantName ?? undefined,
    merchantId: m.merchantId ?? undefined,
    merchantCategoryCode: m.merchantCategoryCode != null ? Number(m.merchantCategoryCode) : undefined,
  })
  return Object.keys(out).length ? out : undefined
}

function merchantCounterpart(m: ExternalMerchantDetails | undefined): CounterpartDetails | undefined {
  return m ? compact({ name: m.name, merchantDetails: m }) : undefined
}

/** The posting category of a card transaction: its merchant category code, as holds.authorise records it. */
function mccCategory(m: ExternalMerchantDetails | undefined): string | undefined {
  return m?.merchantCategoryCode !== undefined ? String(m.merchantCategoryCode) : undefined
}
