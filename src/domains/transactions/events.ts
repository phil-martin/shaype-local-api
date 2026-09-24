/**
 * Domain events emitted by the ledger and their TRANSACTION webhook mapping (docs/map/webhooks.md §2.4
 * TransactionEventDto, §5 samples): one NotificationDto per owning customer, compact form, amounts
 * signed (debits / holds / settlements negative, credits / refunds / releases positive),
 * updatedBalance = post-event availableBalance, accountBalances = the post-event snapshot.
 * Pending hold events carry transactionHayId == holdHayId; a settlement gets a new transactionHayId.
 */
import type { components as whComponents } from '../../contract/generated/webhook-types.js'
import type { AppContext } from '../../context.js'
import { compact, notifyV0, type ActionOwner } from '../../events/notify.js'
import { uuid } from '../../lib/ids.js'
import { fromCents, type Cents } from '../../lib/money.js'
import type { Account } from '../accounts/repo.js'
import type { Balances } from '../accounts/service.js'
import type { CardUsageDetails, CounterpartDetails, ExternalMerchantDetails, Hold, LedgerTransaction, OriginType, WebhookOutcome, WebhookTransactionType } from './repo.js'
import type { Money } from './service.js'

type TransactionEventDto = whComponents['schemas']['TransactionEventDto']
type WhCurrencyAmount = whComponents['schemas']['CurrencyAmount']

export type HoldChangeKind = 'AUTHORISED' | 'INCREASED' | 'DECREASED' | 'REVERSED' | 'CANCELLED'

/** A movement that was refused: nothing posted or held, webhook with the refused outcome and unchanged balances. */
export interface RefusedAttempt {
  account: Account
  balances: Balances
  actionOwner: ActionOwner
  outcome: WebhookOutcome
  /** signed cents of the attempt */
  amountCents: Cents
  originalAmount?: Money
  webhookType: WebhookTransactionType
  transactionTime: string
  isPending: boolean
  isAtm?: boolean
  /** the hold a refused increment was for */
  holdId?: string
  cardId?: string
  cardUsage?: CardUsageDetails
  merchant?: ExternalMerchantDetails
  counterpart?: CounterpartDetails
  description?: string
  category?: string
  reference?: string
  originType?: OriginType
  originId?: string
  ruleDetails?: { ruleId: string }
  cardPreferenceOutcome?: TransactionEventDto['cardPreferenceOutcome']
  cardProcessorResponse?: TransactionEventDto['cardProcessorResponse']
}

declare module '../../events/bus.js' {
  interface DomainEventMap {
    /** A FinancialTransaction was posted (balances moved). `account` / `balances` are the post-event state. */
    'transaction.posted': { transaction: LedgerTransaction; account: Account; balances: Balances; actionOwner: ActionOwner }
    /** A card authorisation (or an opted-in posting) was refused. */
    'transaction.refused': RefusedAttempt
    /** A hold was authorised, increased, decreased, reversed or cancelled; `deltaCents` is the positive amount moved. */
    'hold.changed': { hold: Hold; kind: HoldChangeKind; deltaCents: Cents; account: Account; balances: Balances; actionOwner: ActionOwner }
  }
}

export function registerEvents(ctx: AppContext): void {
  const notify = (account: Account, actionOwner: ActionOwner, event: TransactionEventDto): void => {
    for (const customerHayId of ctx.services.accounts.holderCustomerIds(account)) {
      notifyV0(ctx, {
        customerHayId,
        type: 'TRANSACTION',
        actionOwner,
        productId: account.productId,
        transactionEvent: compact({ ...event, customerHayId }),
      })
    }
  }

  ctx.events.on('transaction.posted', ({ transaction: t, account, balances, actionOwner }) => {
    const cp = t.counterpart
    notify(account, actionOwner, {
      transactionHayId: t.id,
      holdHayId: t.relatedHoldId,
      accountHayId: t.accountId,
      currencyAmount: money(t.amount, t.currency),
      originalCurrencyAmount: t.originalAmount !== undefined ? money(t.originalAmount, t.originalCurrency ?? t.currency) : undefined,
      updatedBalance: money(balances.availableBalance, account.currency),
      isPending: false,
      counterpartName: t.counterpartName ?? cp?.name,
      outcome: 'ACCEPTED',
      transactionTimeUtc: t.transactionTime,
      isAtmTransaction: t.type === 'ATM_WITHDRAWAL',
      transactionType: t.webhookType,
      cardUsageDetails: t.cardUsage,
      accountBalances: accountBalances(balances, account.currency),
      cardHayId: t.cardId,
      ruleDetails: undefined,
      counterpartDetails: counterpart(cp),
      originId: t.originId,
      originType: t.originType,
      category: t.category,
      merchantId: cp?.merchantDetails?.merchantId ?? undefined,
      description: t.description,
      mandatePaymentDetails: t.mandatePayment,
      returnReason: t.returnReason,
      reference: t.reference,
      externalIdentifiers: t.externalIdentifiers?.map((e) => ({ source: e.source, identifierType: e.type, value: e.value })),
    })
  })

  ctx.events.on('transaction.refused', (r) => {
    const { account, balances } = r
    notify(account, r.actionOwner, {
      transactionHayId: r.holdId ?? uuid(),
      holdHayId: r.holdId,
      accountHayId: account.id,
      currencyAmount: money(r.amountCents, account.currency),
      originalCurrencyAmount: r.originalAmount ? money(r.originalAmount.amountCents, r.originalAmount.currency) : undefined,
      updatedBalance: money(balances.availableBalance, account.currency),
      isPending: r.isPending,
      counterpartName: r.merchant?.name ?? r.counterpart?.name,
      outcome: r.outcome,
      transactionTimeUtc: r.transactionTime,
      cardPreferenceOutcome: r.cardPreferenceOutcome,
      cardProcessorResponse: r.cardProcessorResponse,
      isAtmTransaction: r.isAtm ?? false,
      transactionType: r.webhookType,
      cardUsageDetails: r.cardUsage,
      accountBalances: accountBalances(balances, account.currency),
      cardHayId: r.cardId,
      ruleDetails: r.ruleDetails,
      counterpartDetails: counterpart(r.counterpart),
      originId: r.originId,
      originType: r.originType,
      category: r.category,
      merchantId: r.merchant?.merchantId ?? undefined,
      description: r.description,
      reference: r.reference,
    })
  })

  ctx.events.on('hold.changed', ({ hold, kind, deltaCents, account, balances, actionOwner }) => {
    // AUTHORISED / INCREASED: CARD_TRANSACTION with the cumulative hold (negative); DECREASED / REVERSED / CANCELLED: CARD_TRANSACTION_REFUND with the released portion (positive)
    const increasing = kind === 'AUTHORISED' || kind === 'INCREASED'
    notify(account, actionOwner, {
      transactionHayId: hold.id,
      holdHayId: hold.id,
      accountHayId: hold.accountId,
      currencyAmount: money(increasing ? -hold.amount : deltaCents, hold.currency),
      originalCurrencyAmount: increasing && hold.originalAmount !== undefined ? money(-hold.originalAmount, hold.originalCurrency ?? hold.currency) : undefined,
      updatedBalance: money(balances.availableBalance, account.currency),
      isPending: true,
      counterpartName: hold.merchant?.name,
      outcome: 'ACCEPTED',
      transactionTimeUtc: hold.authorisedAt,
      isAtmTransaction: hold.type === 'ATM_WITHDRAWAL',
      transactionType: increasing ? 'CARD_TRANSACTION' : 'CARD_TRANSACTION_REFUND',
      cardUsageDetails: hold.cardUsage,
      accountBalances: accountBalances(balances, account.currency),
      cardHayId: hold.cardId,
      category: hold.category,
      merchantId: hold.merchant?.merchantId ?? undefined,
      description: hold.description,
      externalIdentifiers: hold.externalIdentifiers?.map((e) => ({ source: e.source, identifierType: e.type, value: e.value })),
    })
  })
}

function money(cents: Cents, currency: string): WhCurrencyAmount {
  return { currency: currency as WhCurrencyAmount['currency'], amount: fromCents(cents) }
}

function accountBalances(b: Balances, currency: string): TransactionEventDto['accountBalances'] {
  return {
    totalBalance: money(b.totalBalance, currency),
    heldBalance: money(b.heldBalance, currency),
    lockedBalance: money(b.lockedBalance, currency),
    stacksBalance: money(b.stacksBalance, currency),
    availableBalance: money(b.availableBalance, currency),
  }
}

/**
 * Webhook CounterpartDetails: accountId / customerId / name / bpayDetails / basicAccountNumber. A merchant
 * counterpart (card transactions) is carried by counterpartName / merchantId instead, as in the docs samples.
 */
function counterpart(cp: CounterpartDetails | undefined): TransactionEventDto['counterpartDetails'] {
  if (!cp || cp.merchantDetails) return undefined
  const out = compact({ accountId: cp.accountId, customerId: cp.customerId, name: cp.name, bpayDetails: cp.bpayDetails, basicAccountNumber: cp.basicAccountNumber })
  return Object.keys(out).length ? out : undefined
}
