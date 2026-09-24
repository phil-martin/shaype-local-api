/**
 * SQL for transactions, transaction_tags and holds: rows <-> entities.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import type { components as whComponents } from '../../contract/generated/webhook-types.js'
import { json, nextSeq, type Db } from '../../db/index.js'
import type { Cents } from '../../lib/money.js'
import type { InternalLimitType } from '../accounts/products.js'

type S = components['schemas']
export type FinancialTransaction = S['FinancialTransaction']
export type AuthorisationHold = S['AuthorisationHold']
export type LedgerType = NonNullable<FinancialTransaction['type']>
export type TransactionChannel = NonNullable<FinancialTransaction['transactionChannel']>
export type OriginType = NonNullable<FinancialTransaction['originType']>
export type OriginChannel = NonNullable<FinancialTransaction['originChannel']>
export type CountryOfExpenditure = NonNullable<FinancialTransaction['countryOfExpenditure']>
export type ExternalMerchantDetails = S['ExternalMerchantDetails']
export type ExternalIdentifier = S['ExternalIdentifier']
export type MandatePaymentDetails = S['ExternalMandatePaymentDetails']
export type WebhookTransactionType = NonNullable<whComponents['schemas']['TransactionEventDto']['transactionType']>
export type WebhookOutcome = NonNullable<whComponents['schemas']['TransactionEventDto']['outcome']>
export type CardUsageDetails = whComponents['schemas']['CardUsageDetails']
export type ReturnReason = whComponents['schemas']['ReturnReason']
export type BpayDetails = whComponents['schemas']['BpayDetails']

export type HoldState = 'AUTHORISED' | 'SETTLED' | 'REVERSED' | 'CANCELLED'
export type HoldType = 'CARD_PRESENT_PAYMENT' | 'CARD_NOT_PRESENT_PAYMENT' | 'ATM_WITHDRAWAL'

/** Internal counterpart record: the union of ExternalCounterpartDetails (REST) and CounterpartDetails (webhook). */
export interface CounterpartDetails {
  accountId?: string
  customerId?: string
  name?: string
  basicAccountNumber?: { accountNumber: string; branchNumber: string }
  merchantDetails?: ExternalMerchantDetails
  bpayDetails?: BpayDetails
}

export interface LedgerTransaction {
  id: string
  accountId: string
  customerId: string
  productId: string
  type: LedgerType
  channel: TransactionChannel
  webhookType: WebhookTransactionType
  /** signed cents: credits positive, debits negative */
  amount: Cents
  currency: string
  originalAmount?: Cents
  originalCurrency?: string
  /** totalBalance after the posting, cents */
  rollingBalance: Cents
  transactionTime: string
  clearingTime: string
  description?: string
  category?: string
  reference?: string
  counterpartName?: string
  counterpart?: CounterpartDetails
  originType?: OriginType
  originId?: string
  originChannel?: OriginChannel
  cardId?: string
  cardUsage?: CardUsageDetails
  relatedHoldId?: string
  countryOfExpenditure?: CountryOfExpenditure
  externalIdentifiers?: ExternalIdentifier[]
  mandatePayment?: MandatePaymentDetails
  returnReason?: ReturnReason
  limitKinds: InternalLimitType[]
  createdAt: string
}

export interface Hold {
  id: string
  accountId: string
  customerId: string
  productId: string
  cardId: string
  cardToken?: string
  lastFour?: string
  state: HoldState
  type: HoldType
  channel: TransactionChannel
  /** current hold amount, positive cents */
  amount: Cents
  currency: string
  originalAmount?: Cents
  originalCurrency?: string
  description?: string
  category?: string
  merchant?: ExternalMerchantDetails
  cardUsage?: CardUsageDetails
  countryOfExpenditure?: CountryOfExpenditure
  externalIdentifiers?: ExternalIdentifier[]
  limitKinds: InternalLimitType[]
  authorisedAt: string
  updatedAt?: string
  closedAt?: string
  settledTransactionId?: string
}

export interface TagRow {
  id: string
  transactionId: string
  category: string
  value: string
  createdAt: string
}

export type SortBy = 'CLEARING_TIME' | 'TRANSACTION_TIME'

export interface SearchQuery {
  accountId?: string
  originChannel?: string
  originId?: string
  originType?: string
  /** normalised isoUtc bounds, both inclusive */
  from: string
  to: string
  sortBy: SortBy
  limit: number
  offset: number
}

type Row = Record<string, unknown>

export class TransactionRepo {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- transactions

  insertTransaction(t: LedgerTransaction): void {
    const r = transactionToRow(t)
    const cols = Object.keys(r)
    this.db.prepare(`INSERT INTO transactions(seq, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(nextSeq(this.db, 'transaction'), ...cols.map((k) => r[k]))
  }

  transactionById(id: string): LedgerTransaction | undefined {
    const r = this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Row | undefined
    return r ? transactionFromRow(r) : undefined
  }

  /** Postings of an account, newest first. */
  listForAccount(accountId: string, page: { limit: number; offset: number }): LedgerTransaction[] {
    return (this.db.prepare('SELECT * FROM transactions WHERE account_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?').all(accountId, page.limit, page.offset) as Row[]).map(transactionFromRow)
  }

  search(q: SearchQuery): LedgerTransaction[] {
    const col = q.sortBy === 'TRANSACTION_TIME' ? 'transaction_time' : 'clearing_time'
    const where: string[] = [`${col} >= ?`, `${col} <= ?`]
    const args: unknown[] = [q.from, q.to]
    for (const [column, value] of [['account_id', q.accountId], ['origin_channel', q.originChannel], ['origin_id', q.originId], ['origin_type', q.originType]] as const) {
      if (value === undefined) continue
      where.push(`${column} = ?`)
      args.push(value)
    }
    args.push(q.limit, q.offset)
    return (this.db.prepare(`SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY ${col} DESC, seq DESC LIMIT ? OFFSET ?`).all(...args) as Row[]).map(transactionFromRow)
  }

  /**
   * Cents (positive) counted against `limitType` on the account since `since`: posted transactions
   * (by transaction time) plus open card holds (by authorisation time) whose limit kinds include it.
   */
  usage(accountId: string, limitType: InternalLimitType, since: string): Cents {
    const posted = this.db
      .prepare(`SELECT COALESCE(SUM(ABS(amount)), 0) AS n FROM transactions WHERE account_id = ? AND transaction_time >= ? AND EXISTS (SELECT 1 FROM json_each(transactions.limit_kinds) WHERE json_each.value = ?)`)
      .get(accountId, since, limitType) as { n: number }
    const held = this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM holds WHERE account_id = ? AND state = 'AUTHORISED' AND authorised_at >= ? AND EXISTS (SELECT 1 FROM json_each(holds.limit_kinds) WHERE json_each.value = ?)`)
      .get(accountId, since, limitType) as { n: number }
    return posted.n + held.n
  }

  // ---------------------------------------------------------------- tags

  tagsFor(transactionId: string): TagRow[] {
    return (this.db.prepare('SELECT * FROM transaction_tags WHERE transaction_id = ? ORDER BY seq ASC').all(transactionId) as Row[]).map(tagFromRow)
  }

  tagById(id: string): TagRow | undefined {
    const r = this.db.prepare('SELECT * FROM transaction_tags WHERE id = ?').get(id) as Row | undefined
    return r ? tagFromRow(r) : undefined
  }

  findTag(transactionId: string, category: string, value: string): TagRow | undefined {
    const r = this.db.prepare('SELECT * FROM transaction_tags WHERE transaction_id = ? AND category = ? AND value = ?').get(transactionId, category, value) as Row | undefined
    return r ? tagFromRow(r) : undefined
  }

  insertTag(t: TagRow): void {
    this.db.prepare('INSERT INTO transaction_tags(id, seq, transaction_id, category, value, created_at) VALUES (?,?,?,?,?,?)').run(t.id, nextSeq(this.db, 'transaction-tag'), t.transactionId, t.category, t.value, t.createdAt)
  }

  deleteTag(id: string): void {
    this.db.prepare('DELETE FROM transaction_tags WHERE id = ?').run(id)
  }

  // ---------------------------------------------------------------- holds

  insertHold(h: Hold): void {
    const r = holdToRow(h)
    const cols = Object.keys(r)
    this.db.prepare(`INSERT INTO holds(seq, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(nextSeq(this.db, 'hold'), ...cols.map((k) => r[k]))
  }

  saveHold(h: Hold): void {
    const r = holdToRow(h)
    const cols = Object.keys(r).filter((k) => k !== 'id')
    this.db.prepare(`UPDATE holds SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => r[k]), h.id)
  }

  holdById(id: string): Hold | undefined {
    const r = this.db.prepare('SELECT * FROM holds WHERE id = ?').get(id) as Row | undefined
    return r ? holdFromRow(r) : undefined
  }

  /** AUTHORISED holds of the account, authorisation order. */
  openHolds(accountId: string): Hold[] {
    return (this.db.prepare(`SELECT * FROM holds WHERE account_id = ? AND state = 'AUTHORISED' ORDER BY seq ASC`).all(accountId) as Row[]).map(holdFromRow)
  }
}

// ---------------------------------------------------------------- row mapping

function transactionToRow(t: LedgerTransaction): Row {
  return {
    id: t.id,
    account_id: t.accountId,
    customer_id: t.customerId,
    product_id: t.productId,
    type: t.type,
    channel: t.channel,
    webhook_type: t.webhookType,
    amount: t.amount,
    currency: t.currency,
    original_amount: t.originalAmount ?? null,
    original_currency: t.originalCurrency ?? null,
    rolling_balance: t.rollingBalance,
    transaction_time: t.transactionTime,
    clearing_time: t.clearingTime,
    description: t.description ?? null,
    category: t.category ?? null,
    reference: t.reference ?? null,
    counterpart_name: t.counterpartName ?? null,
    counterpart: json.stringify(t.counterpart),
    origin_type: t.originType ?? null,
    origin_id: t.originId ?? null,
    origin_channel: t.originChannel ?? null,
    card_id: t.cardId ?? null,
    card_usage: json.stringify(t.cardUsage),
    related_hold_id: t.relatedHoldId ?? null,
    country_of_expenditure: t.countryOfExpenditure ?? null,
    external_identifiers: json.stringify(t.externalIdentifiers),
    mandate_payment: json.stringify(t.mandatePayment),
    return_reason: json.stringify(t.returnReason),
    limit_kinds: JSON.stringify(t.limitKinds),
    created_at: t.createdAt,
  }
}

function transactionFromRow(r: Row): LedgerTransaction {
  const t: LedgerTransaction = {
    id: r.id as string,
    accountId: r.account_id as string,
    customerId: r.customer_id as string,
    productId: r.product_id as string,
    type: r.type as LedgerType,
    channel: r.channel as TransactionChannel,
    webhookType: r.webhook_type as WebhookTransactionType,
    amount: r.amount as number,
    currency: r.currency as string,
    rollingBalance: r.rolling_balance as number,
    transactionTime: r.transaction_time as string,
    clearingTime: r.clearing_time as string,
    limitKinds: JSON.parse(r.limit_kinds as string) as InternalLimitType[],
    createdAt: r.created_at as string,
  }
  setIfPresent(t, [
    ['originalAmount', r.original_amount], ['originalCurrency', r.original_currency], ['description', r.description], ['category', r.category],
    ['reference', r.reference], ['counterpartName', r.counterpart_name], ['counterpart', json.parse(r.counterpart as string | null)],
    ['originType', r.origin_type], ['originId', r.origin_id], ['originChannel', r.origin_channel], ['cardId', r.card_id],
    ['cardUsage', json.parse(r.card_usage as string | null)], ['relatedHoldId', r.related_hold_id], ['countryOfExpenditure', r.country_of_expenditure],
    ['externalIdentifiers', json.parse(r.external_identifiers as string | null)], ['mandatePayment', json.parse(r.mandate_payment as string | null)],
    ['returnReason', json.parse(r.return_reason as string | null)],
  ])
  return t
}

function holdToRow(h: Hold): Row {
  return {
    id: h.id,
    account_id: h.accountId,
    customer_id: h.customerId,
    product_id: h.productId,
    card_id: h.cardId,
    card_token: h.cardToken ?? null,
    last_four: h.lastFour ?? null,
    state: h.state,
    type: h.type,
    channel: h.channel,
    amount: h.amount,
    currency: h.currency,
    original_amount: h.originalAmount ?? null,
    original_currency: h.originalCurrency ?? null,
    description: h.description ?? null,
    category: h.category ?? null,
    merchant: json.stringify(h.merchant),
    card_usage: json.stringify(h.cardUsage),
    country_of_expenditure: h.countryOfExpenditure ?? null,
    external_identifiers: json.stringify(h.externalIdentifiers),
    limit_kinds: JSON.stringify(h.limitKinds),
    authorised_at: h.authorisedAt,
    updated_at: h.updatedAt ?? null,
    closed_at: h.closedAt ?? null,
    settled_transaction_id: h.settledTransactionId ?? null,
  }
}

function holdFromRow(r: Row): Hold {
  const h: Hold = {
    id: r.id as string,
    accountId: r.account_id as string,
    customerId: r.customer_id as string,
    productId: r.product_id as string,
    cardId: r.card_id as string,
    state: r.state as HoldState,
    type: r.type as HoldType,
    channel: r.channel as TransactionChannel,
    amount: r.amount as number,
    currency: r.currency as string,
    limitKinds: JSON.parse(r.limit_kinds as string) as InternalLimitType[],
    authorisedAt: r.authorised_at as string,
  }
  setIfPresent(h, [
    ['cardToken', r.card_token], ['lastFour', r.last_four], ['originalAmount', r.original_amount], ['originalCurrency', r.original_currency],
    ['description', r.description], ['category', r.category], ['merchant', json.parse(r.merchant as string | null)],
    ['cardUsage', json.parse(r.card_usage as string | null)], ['countryOfExpenditure', r.country_of_expenditure],
    ['externalIdentifiers', json.parse(r.external_identifiers as string | null)], ['updatedAt', r.updated_at], ['closedAt', r.closed_at],
    ['settledTransactionId', r.settled_transaction_id],
  ])
  return h
}

function tagFromRow(r: Row): TagRow {
  return { id: r.id as string, transactionId: r.transaction_id as string, category: r.category as string, value: r.value as string, createdAt: r.created_at as string }
}

function setIfPresent<T extends object>(target: T, entries: [keyof T, unknown][]): void {
  for (const [k, v] of entries) if (v !== null && v !== undefined) (target as Record<keyof T, unknown>)[k] = v
}
