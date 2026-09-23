/**
 * Seeded reference data: the single local product (spec §5.2) with its product-level limits, the
 * limit-type vocabulary and the outcome each breached limit produces (docs/map/transactions-holds.md
 * §4.4, docs/map/00-balance.md §3.2). Amounts are cents.
 */
import type { Cents } from '../../lib/money.js'

export const LOCAL_PRODUCT_ID = 'a1b2c3d4-0000-4000-8000-000000000001'

/** ExternalLimitAmounts.type — the 16 spec values, in spec order. */
export const LIMIT_TYPES = [
  'MAX_BALANCE', 'MIN_BALANCE', 'TOTAL_SPEND_PER_YEAR', 'ATM_WITHDRAWAL_PER_DAY', 'TOP_UP_PER_DAY', 'CARD_TOP_UP_PER_DAY',
  'BPAY_TOP_UP_PER_DAY', 'BANK_TRANSFER_TOP_UP_PER_DAY', 'PAYMENT_TO_ACCOUNT_NUMBER', 'PAYMENT_TO_PAY_ID', 'CARD_PAYMENTS_DAILY',
  'SINGLE_CARD_TRANSACTION', 'MIN_STACK_BALANCE', 'DIRECT_DEBIT_PER_DAY', 'OVERDRAFT_PRODUCT_LIMIT', 'BPAY_DAILY_LIMIT',
] as const
export type LimitType = (typeof LIMIT_TYPES)[number]

/** setAccountLimit path enum — the 11 client-settable types. */
export const SETTABLE_LIMIT_TYPES: readonly LimitType[] = [
  'MAX_BALANCE', 'TOTAL_SPEND_PER_YEAR', 'ATM_WITHDRAWAL_PER_DAY', 'TOP_UP_PER_DAY', 'BANK_TRANSFER_TOP_UP_PER_DAY',
  'PAYMENT_TO_ACCOUNT_NUMBER', 'PAYMENT_TO_PAY_ID', 'CARD_PAYMENTS_DAILY', 'SINGLE_CARD_TRANSACTION', 'DIRECT_DEBIT_PER_DAY', 'BPAY_DAILY_LIMIT',
]

/**
 * The daily transfers-out cap has an outcome (REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED) but no
 * spec limit type: it is a hidden product-level limit, never listed or settable through the API.
 */
export type InternalLimitType = LimitType | 'TRANSFERS_OUT_PER_DAY'

export type LimitKind = 'balance' | 'perTransaction' | 'daily' | 'yearly' | 'floor' | 'unused'

export const LIMIT_KIND: Record<InternalLimitType, LimitKind> = {
  MAX_BALANCE: 'balance',
  MIN_BALANCE: 'floor',
  TOTAL_SPEND_PER_YEAR: 'yearly',
  ATM_WITHDRAWAL_PER_DAY: 'daily',
  TOP_UP_PER_DAY: 'daily',
  CARD_TOP_UP_PER_DAY: 'unused',
  BPAY_TOP_UP_PER_DAY: 'unused',
  BANK_TRANSFER_TOP_UP_PER_DAY: 'daily',
  PAYMENT_TO_ACCOUNT_NUMBER: 'perTransaction',
  PAYMENT_TO_PAY_ID: 'perTransaction',
  CARD_PAYMENTS_DAILY: 'daily',
  SINGLE_CARD_TRANSACTION: 'perTransaction',
  MIN_STACK_BALANCE: 'floor',
  DIRECT_DEBIT_PER_DAY: 'daily',
  OVERDRAFT_PRODUCT_LIMIT: 'unused',
  BPAY_DAILY_LIMIT: 'daily',
  TRANSFERS_OUT_PER_DAY: 'daily',
}

/**
 * Detailed outcome per breached limit (webhook TransactionEventDto.outcome vocabulary, which is the
 * superset). The ledger maps these onto each REST surface's own enum (v0 collapses to
 * REFUSED_LIMIT_BREACH, BPAY uses REFUSED_DAILY_BPAY_LIMIT_BREACHED, …).
 */
export const LIMIT_OUTCOME: Record<InternalLimitType, string> = {
  MAX_BALANCE: 'REFUSED_MAX_BALANCE_EXCEEDED',
  MIN_BALANCE: 'REFUSED_NOT_ENOUGH_FUNDS',
  TOTAL_SPEND_PER_YEAR: 'REFUSED_ANNUAL_SPENDING_LIMIT_BREACHED',
  ATM_WITHDRAWAL_PER_DAY: 'REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED',
  TOP_UP_PER_DAY: 'REFUSED_DAILY_TOP_UP_LIMIT_BREACHED',
  CARD_TOP_UP_PER_DAY: 'REFUSED_DAILY_TOP_UP_LIMIT_BREACHED',
  BPAY_TOP_UP_PER_DAY: 'REFUSED_DAILY_TOP_UP_LIMIT_BREACHED',
  BANK_TRANSFER_TOP_UP_PER_DAY: 'REFUSED_DAILY_TOP_UP_LIMIT_BREACHED',
  PAYMENT_TO_ACCOUNT_NUMBER: 'REFUSED_LIMIT_BREACH',
  PAYMENT_TO_PAY_ID: 'REFUSED_LIMIT_BREACH',
  CARD_PAYMENTS_DAILY: 'REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED',
  SINGLE_CARD_TRANSACTION: 'REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED',
  MIN_STACK_BALANCE: 'REFUSED_NOT_ENOUGH_FUNDS',
  DIRECT_DEBIT_PER_DAY: 'REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED',
  OVERDRAFT_PRODUCT_LIMIT: 'REFUSED_LIMIT_BREACH',
  BPAY_DAILY_LIMIT: 'REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED',
  TRANSFERS_OUT_PER_DAY: 'REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED',
}

export interface Product {
  id: string
  name: string
  description: string
  currency: string
  limits: Record<InternalLimitType, Cents>
}

const D = 100 // dollars -> cents

/** Product defaults from spec §5.2 [decision]; types the spec leaves silent are marked below. */
export const LOCAL_PRODUCT: Product = {
  id: LOCAL_PRODUCT_ID,
  name: 'Local Everyday Account',
  description: 'Default transaction account product of the local Shaype re-implementation (AUD).',
  currency: 'AUD',
  limits: {
    MAX_BALANCE: 1_000_000 * D,
    MIN_BALANCE: 0, // [decision] no floor below zero beyond the overdraft facility
    TOTAL_SPEND_PER_YEAR: 10_000_000 * D,
    ATM_WITHDRAWAL_PER_DAY: 5_000 * D,
    TOP_UP_PER_DAY: 100_000 * D,
    CARD_TOP_UP_PER_DAY: 0, // "Not currently used" [spec]
    BPAY_TOP_UP_PER_DAY: 0, // "Not currently used" [spec]
    BANK_TRANSFER_TOP_UP_PER_DAY: 100_000 * D,
    PAYMENT_TO_ACCOUNT_NUMBER: 50_000 * D,
    PAYMENT_TO_PAY_ID: 50_000 * D, // [decision] mirrors PAYMENT_TO_ACCOUNT_NUMBER so the settable type accepts a value
    CARD_PAYMENTS_DAILY: 50_000 * D,
    SINGLE_CARD_TRANSACTION: 20_000 * D,
    MIN_STACK_BALANCE: 0, // [decision]
    DIRECT_DEBIT_PER_DAY: 50_000 * D,
    OVERDRAFT_PRODUCT_LIMIT: 10_000 * D, // [decision] cap for updateOverdraftLimit
    BPAY_DAILY_LIMIT: 50_000 * D,
    TRANSFERS_OUT_PER_DAY: 100_000 * D, // [decision] hidden daily transfers-out cap
  },
}

export const PRODUCTS: readonly Product[] = [LOCAL_PRODUCT]

export function findProduct(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id)
}

/** CreateAccountRequestBody.currency enum (31 values) [spec]. */
export const CREATE_CURRENCIES = [
  'AED', 'AUD', 'BHD', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'ILS', 'JPY', 'KES', 'KWD', 'MXN', 'NOK', 'NZD',
  'OMR', 'PLN', 'QAR', 'RON', 'SAR', 'SEK', 'SGD', 'THB', 'TRY', 'UGX', 'USD', 'ZAR',
] as const

export const HOME_CURRENCY = 'AUD'

/** FX child currencies provisioned by fx.childAccounts.initMode ALL: every create-enum currency except the home currency (30). */
export const FX_CURRENCIES: readonly string[] = CREATE_CURRENCIES.filter((c) => c !== HOME_CURRENCY)
