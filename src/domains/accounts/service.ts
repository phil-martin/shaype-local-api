/**
 * Account rules (spec §5.2): creation, the balance model, the status machine, limits, rules, risk
 * level, custom data, block/unblock/close cascades. Emits one domain event per state change and
 * publishes itself as ctx.services.accounts for the ledger, cards, groups and payment domains.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import type { AppContext } from '../../context.js'
import { compact, type ActionOwner } from '../../events/notify.js'
import { isoUtc } from '../../lib/clock.js'
import { ApiError, badRequest, notFound, unprocessable } from '../../lib/errors.js'
import { LOCAL_BSB, accountNumber as accountNumberFor, uuid } from '../../lib/ids.js'
import { centsToString, fromCents, hasAtMostTwoDecimals, toCents, type Cents } from '../../lib/money.js'
import { deps } from './deps.js'
import {
  FX_CURRENCIES, HOME_CURRENCY, LIMIT_KIND, LIMIT_OUTCOME, LIMIT_TYPES, LOCAL_PRODUCT_ID, PRODUCTS, SETTABLE_LIMIT_TYPES, findProduct,
  type InternalLimitType, type LimitOutcome, type LimitType, type Product,
} from './products.js'
import type { Account, AccountRepo, AccountRule, AccountStatus, BlockedBy, CloseReason, HolderType, RiskLevel, RuleDetails, RuleType } from './repo.js'

type S = components['schemas']
export type HayAccount = S['HayAccount']
export type ProductSummary = S['ProductSummary']
export type CloseAccountResponse = S['CloseAccountResponse']
export type ClosureCheckerError = S['ClosureCheckerError']
export type BlockAccountResponse = S['BlockAccountResponse']
export type ExternalLimitAmounts = S['ExternalLimitAmounts']
export type RuleResponse = S['ExternalTransactionRuleResponse']
export type AddRuleInput = S['ExternalAddTransactionRuleRequest']
export type FxData = S['AccountFxDataRequest']

export interface CreateAccountInput {
  accountHolderType: HolderType
  accountHolderId: string
  /** Defaults to the seeded local product (the legacy v0 create bodies carry none). */
  productId?: string
  accountNumber?: string | null
  currency?: string | null
  customData?: Record<string, unknown> | null
  parentAccountId?: string | null
  fx?: FxData
}

export type MovementRefusal = 'REFUSED_ACCOUNT_BLOCKED' | 'REFUSED_ACCOUNT_CLOSED'

/** All in cents; magnitudes positive (technicalOverdraftBalance included), totals signed. */
export interface Balances {
  totalBalance: Cents
  availableBalance: Cents
  heldBalance: Cents
  lockedBalance: Cents
  stacksBalance: Cents
  overdraftBalance: Cents
  overdraftLimit: Cents
  technicalOverdraftBalance: Cents
}

export interface BalanceDeltas { ledgerDelta?: Cents; heldDelta?: Cents; lockedDelta?: Cents; stacksDelta?: Cents }

export interface StatusOptions {
  actionOwner: ActionOwner
  blockedBy?: BlockedBy
  closeReason?: CloseReason
}

export interface MerchantInput { mcc?: number | null; merchantId?: string | null; merchantName?: string | null }

/**
 * Registered by the transactions domain: sum (cents, positive) of the postings that count against
 * `limitType` on the account since `windowStartIso` (rolling 24 h / 365 d windows).
 */
export type LimitUsageProvider = (accountId: string, limitType: InternalLimitType, windowStartIso: string) => Cents

/** Registered by domains with closure preconditions (direct-entry: in-flight outbound direct debits). */
export type ClosureChecker = (account: Account) => ClosureCheckerError[]

declare module '../../context.js' {
  interface ServiceMap {
    accounts: AccountsService
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
const YEAR_MS = 365 * DAY_MS
/** Largest instant a JS Date can hold (±8.64e15 ms); beyond it `new Date()` is Invalid. */
const MAX_DATE_MS = 8.64e15

export function computeBalances(a: Pick<Account, 'ledger' | 'held' | 'locked' | 'stacks' | 'overdraftLimit'>): Balances {
  const overdraftBalance = Math.max(0, Math.min(-a.ledger, a.overdraftLimit))
  const technicalOverdraftBalance = Math.max(0, -a.ledger - a.overdraftLimit)
  const totalBalance = a.ledger + a.overdraftLimit
  return {
    totalBalance,
    availableBalance: totalBalance - a.held - a.locked - a.stacks,
    heldBalance: a.held,
    lockedBalance: a.locked,
    stacksBalance: a.stacks,
    overdraftBalance,
    overdraftLimit: a.overdraftLimit,
    technicalOverdraftBalance,
  }
}

export function balancesToJson(b: Balances): Balances {
  const out = {} as Balances
  for (const k of Object.keys(b) as (keyof Balances)[]) out[k] = fromCents(b[k])
  return out
}

/** Statuses on which money may move (DORMANT behaves as ACTIVE). */
const OPEN: ReadonlySet<AccountStatus> = new Set(['APPROVED', 'ACTIVE', 'ACTIVE_IN_ARREARS', 'DORMANT'])

export class AccountsService {
  private usageProvider: LimitUsageProvider = () => 0
  private readonly closureCheckers: ClosureChecker[] = []

  constructor(private readonly ctx: AppContext, private readonly repo: AccountRepo) {}

  // ---------------------------------------------------------------- products

  products(): Product[] {
    return [...PRODUCTS]
  }

  /** getAllProducts: the spec binds the endpoint to the perk ProductSummary schema, so only its id/name/description fields carry the banking product. */
  productSummaries(): ProductSummary[] {
    return PRODUCTS.map((p) => ({ id: p.id, name: p.name, description: p.description, countryIsoCode: 'AUS' }))
  }

  product(id: string): Product {
    const p = findProduct(id)
    if (!p) throw unprocessable(`PRODUCT_NOT_FOUND: Product ${id} not found`)
    return p
  }

  // ---------------------------------------------------------------- reads

  find(id: string): Account | undefined {
    return this.repo.byId(id)
  }

  /** @throws 404 NOT_FOUND */
  get(id: string): Account {
    const a = this.repo.byId(id)
    if (!a) throw notFound(`NOT_FOUND: Account ${id} not found`)
    return a
  }

  /** Alias of get(): the account must exist. */
  require(id: string): Account {
    return this.get(id)
  }

  /**
   * Gate for every money movement (posting, hold, stack move): the account entity when it is open,
   * otherwise the outcome code the caller returns (REFUSED_ACCOUNT_BLOCKED / REFUSED_ACCOUNT_CLOSED).
   * @throws 404 when unknown
   */
  requireOpenForMovement(id: string): Account | MovementRefusal {
    const a = this.get(id)
    if (a.status === 'LOCKED') return 'REFUSED_ACCOUNT_BLOCKED'
    if (a.status === 'CLOSED') return 'REFUSED_ACCOUNT_CLOSED'
    // Only PENDING_APPROVAL remains, and setStatus() refuses it (accounts created through this API are
    // always APPROVED), so this branch is unreachable; it keeps the status switch exhaustive.
    if (!OPEN.has(a.status)) return 'REFUSED_ACCOUNT_BLOCKED'
    return a
  }

  /** Personal + group accounts whose holder id is the given id, every status, creation order (HayAccount bodies). */
  listForHolder(holderId: string): HayAccount[] {
    return this.repo.byHolder(holderId).map((a) => this.toResponse(a))
  }

  listEntitiesForHolder(holderId: string, holderType?: HolderType): Account[] {
    return this.repo.byHolder(holderId, holderType)
  }

  children(parentId: string): Account[] {
    return this.repo.children(parentId)
  }

  /** searchAccounts: exact accountNumber match, every status. */
  search(accountNumber: string): HayAccount[] {
    return this.repo.byAccountNumber(accountNumber).map((a) => this.toResponse(a))
  }

  balances(id: string): { cents: Balances; json: Balances } {
    const cents = computeBalances(this.get(id))
    return { cents, json: balancesToJson(cents) }
  }

  /** Customer ids that own the account: the holder, or every member for a GROUP holder (the group id itself when groups are not loaded). */
  holderCustomerIds(a: Account): string[] {
    if (a.holderType === 'CUSTOMER') return [a.holderId]
    const members = deps(this.ctx).groups?.memberIds(a.holderId) ?? []
    return members.length ? members : [a.holderId]
  }

  /**
   * HayAccount body. customData is included only when `expandCustomData` (null when none is stored).
   * homeCurrencyBalanceEquivalent is the identity on home-currency accounts and omitted on FX children
   * (no FX rates locally).
   */
  toResponse(a: Account, opts: { expandCustomData?: boolean } = {}): HayAccount {
    const b = balancesToJson(computeBalances(a))
    const homeCurrencyBalanceEquivalent = a.currency === HOME_CURRENCY
      ? { currency: HOME_CURRENCY, totalBalance: b.totalBalance, availableBalance: b.availableBalance, heldBalance: b.heldBalance }
      : undefined
    const body = compact({
      accountHayId: a.id,
      accountHolderId: a.holderId,
      accountHolderType: a.holderType,
      accountNumber: a.accountNumber,
      bsb: a.bsb,
      currency: a.currency,
      productId: a.productId,
      status: a.status,
      blockedBy: a.blockedBy,
      parentAccountId: a.parentAccountId,
      totalBalance: b.totalBalance,
      availableBalance: b.availableBalance,
      heldBalance: b.heldBalance,
      lockedBalance: b.lockedBalance,
      stacksBalance: b.stacksBalance,
      overdraftLimit: b.overdraftLimit,
      overdraftBalance: b.overdraftBalance,
      technicalOverdraftBalance: b.technicalOverdraftBalance,
      homeCurrencyBalanceEquivalent,
      creationDateTimeUtc: a.createdAt,
      closedDateTimeUtc: a.closedAt,
    }) as Record<string, unknown>
    if (opts.expandCustomData) body.customData = a.customData ?? null
    return body as unknown as HayAccount
  }

  // ---------------------------------------------------------------- create

  /**
   * createAccount / createHayAccount / createHayAccountForGroup. Holder must exist and be ACTIVE (all
   * members for a GROUP) -> 422 PERMISSION_DENIED; unknown product -> 422 PRODUCT_NOT_FOUND; status
   * APPROVED, risk level config.defaultRiskLevel, balances 0. Emits account.created (ACCOUNT_STATUS_CHANGE
   * APPROVED, PLATFORM). Idempotency is the caller's (route) concern. Returns the HayAccount body.
   */
  create(input: CreateAccountInput, _opts: { actionOwner?: ActionOwner } = {}): HayAccount {
    return this.toResponse(this.createEntity(input))
  }

  /**
   * `provisioning` marks platform-driven child provisioning (fx.childAccounts): the parent was already
   * authorised, so the holder-status check is skipped and a LOCKED parent is accepted (the caller then
   * blocks the child to match).
   */
  createEntity(input: CreateAccountInput, opts: { provisioning?: boolean } = {}): Account {
    const product = this.product(input.productId ?? LOCAL_PRODUCT_ID)
    const currency = input.currency ?? HOME_CURRENCY
    this.validateFx(input.fx, currency, input.parentAccountId ?? undefined)
    if (!opts.provisioning) this.requireHolderActive(input.accountHolderType, input.accountHolderId)
    const parent = this.resolveParent(input, currency, opts)

    if (input.accountNumber && this.repo.accountNumberExists(input.accountNumber)) {
      throw unprocessable(`DUPLICATE_ACCOUNT_NUMBER: Account number ${input.accountNumber} is already in use`)
    }
    const now = isoUtc(this.ctx.clock.now())
    const a: Account = {
      id: uuid(),
      holderType: input.accountHolderType,
      holderId: input.accountHolderId,
      productId: product.id,
      accountNumber: input.accountNumber ?? this.nextAccountNumber(),
      bsb: LOCAL_BSB,
      currency,
      status: 'APPROVED',
      ledger: 0,
      held: 0,
      locked: 0,
      stacks: 0,
      overdraftLimit: 0,
      riskLevel: this.ctx.config.defaultRiskLevel,
      copOptOut: false,
      createdAt: now,
    }
    if (parent) a.parentAccountId = parent.id
    if (input.customData !== undefined) a.customData = input.customData
    this.repo.insert(a)
    this.ctx.events.emit('account.created', { account: structuredClone(a) })
    this.provisionChildren(a, input.fx)
    return a
  }

  private nextAccountNumber(): string {
    for (;;) {
      const n = accountNumberFor(this.repo.nextAccountSeq())
      if (!this.repo.accountNumberExists(n)) return n
    }
  }

  private requireHolderActive(type: HolderType, id: string): void {
    if (type === 'CUSTOMER') {
      this.ctx.services.customers.requireActive(id, 'Account')
      return
    }
    const groups = deps(this.ctx).groups
    if (!groups) throw notFound(`NOT_FOUND: Group ${id} not found`)
    groups.requireAllMembersActive(id)
  }

  /** Documented bulk-account-opening 422s (docs/map/accounts.md createAccount). */
  private validateFx(fx: FxData | undefined, currency: string, parentAccountId: string | undefined): void {
    const child = fx?.childAccounts
    if (!child) return
    if (parentAccountId || currency !== HOME_CURRENCY) throw unprocessable('INVALID_ARGUMENT: fx.childAccounts can only be provided for a home currency parent account')
    const has = child.currencies !== undefined && child.currencies !== null
    if (child.initMode === 'CUSTOM' && !has) throw unprocessable('INVALID_ARGUMENT: fx.childAccounts.currencies is mandatory when initMode is CUSTOM')
    if (child.initMode === 'ALL' && has) throw unprocessable('INVALID_ARGUMENT: fx.childAccounts.currencies must not be provided when initMode is ALL')
    if (child.initMode === 'NONE' && has) throw unprocessable('INVALID_ARGUMENT: fx.childAccounts.currencies must not be provided when initMode is NONE')
    if (has && child.currencies!.length === 0) throw unprocessable('INVALID_ARGUMENT: fx.childAccounts.currencies size must be between 1 and 2147483647')
  }

  /** A CLOSED parent is always refused; a LOCKED one is refused for client creates (a blocked wallet must not be partly reopened). */
  private resolveParent(input: CreateAccountInput, currency: string, opts: { provisioning?: boolean }): Account | undefined {
    if (!input.parentAccountId) {
      if (currency !== HOME_CURRENCY) throw unprocessable(`INVALID_ARGUMENT: parentAccountId is mandatory for a non-${HOME_CURRENCY} account`)
      return undefined
    }
    const parent = this.get(input.parentAccountId)
    if (currency === HOME_CURRENCY) throw unprocessable(`INVALID_ARGUMENT: a child account cannot use the home currency ${HOME_CURRENCY}`)
    if (parent.parentAccountId) throw unprocessable(`INVALID_ARGUMENT: parent account ${parent.id} is itself a child account`)
    if (parent.holderType !== input.accountHolderType || parent.holderId !== input.accountHolderId) {
      throw unprocessable(`INVALID_ARGUMENT: parent account ${parent.id} belongs to a different account holder`)
    }
    if (parent.status === 'CLOSED') throw unprocessable(`ACCOUNT_CLOSED: parent account ${parent.id} is CLOSED`)
    if (parent.status === 'LOCKED' && !opts.provisioning) throw unprocessable(`ACCOUNT_BLOCKED: parent account ${parent.id} is LOCKED`)
    if (this.repo.children(parent.id).some((c) => c.currency === currency)) {
      throw unprocessable(`DUPLICATE_CHILD_CURRENCY: parent account ${parent.id} already has a ${currency} child account`)
    }
    return parent
  }

  /**
   * fx.childAccounts: children are provisioned asynchronously, one per requested FX currency (home
   * currency skipped, duplicates ignored). The parent was authorised at request time, so the job does
   * not re-check the holder; a parent blocked in the meantime yields a child that is LOCKED the same
   * way (blockedBy / note inherited, ACCOUNT_STATUS_CHANGE BLOCKED as PLATFORM). Only a CLOSED parent
   * abandons the child.
   */
  private provisionChildren(parent: Account, fx: FxData | undefined): void {
    const child = fx?.childAccounts
    if (!child || child.initMode === 'NONE') return
    const wanted = child.initMode === 'ALL' ? FX_CURRENCIES : [...new Set(child.currencies ?? [])]
    for (const currency of wanted) {
      if (currency === HOME_CURRENCY) continue
      this.ctx.scheduler.later(() => {
        const p = this.repo.byId(parent.id)
        if (!p || p.status === 'CLOSED' || this.repo.children(p.id).some((c) => c.currency === currency)) return
        this.ctx.db.transaction(() => {
          const c = this.createEntity({ accountHolderType: p.holderType, accountHolderId: p.holderId, productId: p.productId, currency, parentAccountId: p.id }, { provisioning: true })
          if (p.status === 'LOCKED') {
            if (p.blockNote !== undefined) c.blockNote = p.blockNote
            this.transition(c, 'LOCKED', { actionOwner: 'PLATFORM', blockedBy: p.blockedBy })
          }
        })()
      })
    }
  }

  // ---------------------------------------------------------------- balances and the ledger-driven status flips

  /**
   * Applies balance deltas atomically and re-evaluates the ledger-driven statuses: APPROVED/DORMANT ->
   * ACTIVE on the first ledger or stack movement, ACTIVE <-> ACTIVE_IN_ARREARS on technicalOverdraft.
   * Status changes emit account.statusChanged (PLATFORM). LOCKED/CLOSED accounts keep their status.
   */
  adjust(id: string, d: BalanceDeltas): Account {
    return this.ctx.db.transaction(() => {
      const a = this.get(id)
      a.ledger += d.ledgerDelta ?? 0
      a.held += d.heldDelta ?? 0
      a.locked += d.lockedDelta ?? 0
      a.stacks += d.stacksDelta ?? 0
      for (const [k, v] of [['held', a.held], ['locked', a.locked], ['stacks', a.stacks]] as const) {
        if (v < 0) throw new Error(`accounts.adjust: ${k} would become negative on ${id}`)
      }
      a.updatedAt = isoUtc(this.ctx.clock.now())
      this.repo.save(a)
      const moved = (d.ledgerDelta ?? 0) !== 0 || (d.stacksDelta ?? 0) !== 0
      this.reevaluateStatus(a, 'PLATFORM', moved)
      return a
    })()
  }

  /** Pure function of balances vs limit for open accounts; `activate` promotes APPROVED/DORMANT to ACTIVE first. */
  private reevaluateStatus(a: Account, actionOwner: ActionOwner, activate: boolean): void {
    if (!OPEN.has(a.status)) return
    let target = a.status
    if (activate && (target === 'APPROVED' || target === 'DORMANT')) target = 'ACTIVE'
    if (target === 'ACTIVE' || target === 'ACTIVE_IN_ARREARS') {
      target = computeBalances(a).technicalOverdraftBalance > 0 ? 'ACTIVE_IN_ARREARS' : 'ACTIVE'
    }
    if (target !== a.status) this.transition(a, target, { actionOwner })
  }

  /** Funds check for a debit or hold: `amount <= availableBalance` (overdraft spendable, stacks never drawn). */
  checkFunds(id: string, amountCents: Cents): null | 'REFUSED_INSUFFICIENT_FUNDS' {
    return computeBalances(this.get(id)).availableBalance >= amountCents ? null : 'REFUSED_INSUFFICIENT_FUNDS'
  }

  // ---------------------------------------------------------------- limits

  setUsageProvider(fn: LimitUsageProvider): void {
    this.usageProvider = fn
  }

  /**
   * Effective limit in cents: 0 while risk level HIGH, else the account override capped by the product
   * limit. `overrides` lets a caller that already loaded the account's overrides pass them in.
   */
  effectiveLimit(a: Account, type: InternalLimitType, overrides?: Partial<Record<LimitType, Cents>>): Cents {
    if (a.riskLevel === 'HIGH') return 0
    const productLimit = this.product(a.productId).limits[type]
    const override = type === 'TRANSFERS_OUT_PER_DAY' ? undefined : (overrides ?? this.repo.limitOverrides(a.id))[type]
    return override === undefined ? productLimit : Math.min(override, productLimit)
  }

  /**
   * null when the movement fits, else the detailed outcome (LIMIT_OUTCOME). Per-transaction types
   * compare the amount; MAX_BALANCE compares ledger + amount; daily / yearly types add the provider's
   * rolling-window usage (24 h / 365 d). `unused` and `floor` types never refuse here.
   */
  checkLimit(id: string, type: InternalLimitType, amountCents: Cents): null | LimitOutcome {
    const a = this.get(id)
    const kind = LIMIT_KIND[type]
    if (kind === 'unused' || kind === 'floor') return null
    const limit = this.effectiveLimit(a, type)
    let projected: Cents
    switch (kind) {
      case 'perTransaction': projected = amountCents; break
      case 'balance': projected = a.ledger + amountCents; break
      case 'daily': projected = this.usageProvider(id, type, isoUtc(new Date(this.ctx.clock.now().getTime() - DAY_MS))) + amountCents; break
      case 'yearly': projected = this.usageProvider(id, type, isoUtc(new Date(this.ctx.clock.now().getTime() - YEAR_MS))) + amountCents; break
    }
    return projected > limit ? LIMIT_OUTCOME[type] : null
  }

  /** getAccountLimits: one row per spec limit type, in enum order. accountLimit only when an override exists. */
  limits(id: string): ExternalLimitAmounts[] {
    const a = this.get(id)
    const product = this.product(a.productId)
    const overrides = this.repo.limitOverrides(id)
    return LIMIT_TYPES.map((type) => {
      const override = overrides[type]
      const row: ExternalLimitAmounts = { type, productLimit: fromCents(product.limits[type]), effectiveLimit: fromCents(this.effectiveLimit(a, type, overrides)) }
      if (override !== undefined) row.accountLimit = fromCents(override)
      return row
    })
  }

  /** Request amount -> cents; more than two decimal places is a 400 (spec: "value to 2 decimal places"), never silently rounded. */
  private requestCents(amount: number, field: string): Cents {
    if (!hasAtMostTwoDecimals(amount)) throw badRequest(`BAD_REQUEST: ${field} must have at most 2 decimal places`)
    return toCents(amount)
  }

  /** setAccountLimit / updateMaxBalanceLimit: override <= product limit (422), > 0 with <= 2 dp (400), not on a CLOSED account. `field` names the request property in errors. */
  setLimit(id: string, type: LimitType, amount: number, field = 'limitAmount'): { accountId: string; limitType: LimitType; limitAmount: number } {
    const a = this.requireNotClosed(id)
    if (!SETTABLE_LIMIT_TYPES.includes(type)) throw unprocessable(`LIMIT_NOT_SETTABLE: ${type} cannot be set at account level`)
    const cents = this.requestCents(amount, field)
    if (cents <= 0) throw badRequest(`BAD_REQUEST: ${field} must be greater than 0`)
    const productLimit = this.product(a.productId).limits[type]
    if (cents > productLimit) {
      throw unprocessable(`LIMIT_EXCEEDS_PRODUCT_LIMIT: ${type} limit ${centsToString(cents)} cannot exceed the product limit ${centsToString(productLimit)}`)
    }
    this.repo.setLimitOverride(id, type, cents, isoUtc(this.ctx.clock.now()))
    return { accountId: id, limitType: type, limitAmount: fromCents(cents) }
  }

  /** deleteAccountLimit: removes the override (success true even when none existed); non-settable types answer success false. */
  deleteLimit(id: string, type: LimitType): boolean {
    this.requireNotClosed(id)
    if (!SETTABLE_LIMIT_TYPES.includes(type)) return false
    this.repo.deleteLimitOverride(id, type)
    return true
  }

  // ---------------------------------------------------------------- simple attributes

  riskLevel(id: string): RiskLevel {
    return this.get(id).riskLevel
  }

  setRiskLevel(id: string, level: RiskLevel, _reason: string): Account {
    const a = this.requireNotClosed(id)
    if (a.riskLevel === level) return a
    a.riskLevel = level
    a.updatedAt = isoUtc(this.ctx.clock.now())
    this.repo.save(a)
    return a
  }

  setCopOptOut(id: string, optOut: boolean): Account {
    const a = this.requireNotClosed(id)
    a.copOptOut = optOut
    a.updatedAt = isoUtc(this.ctx.clock.now())
    this.repo.save(a)
    return a
  }

  /** updateOverdraftLimit: 0..OVERDRAFT_PRODUCT_LIMIT with <= 2 dp; lowering below the drawn amount flips ACTIVE -> ACTIVE_IN_ARREARS (and back). */
  setOverdraftLimit(id: string, amount: number): Account {
    const a = this.requireNotClosed(id)
    const cents = this.requestCents(amount, 'overdraftLimit')
    if (cents < 0) throw badRequest('BAD_REQUEST: overdraftLimit must be a positive value')
    const cap = this.product(a.productId).limits.OVERDRAFT_PRODUCT_LIMIT
    if (cents > cap) throw unprocessable(`LIMIT_EXCEEDS_PRODUCT_LIMIT: overdraft limit ${centsToString(cents)} cannot exceed the product overdraft limit ${centsToString(cap)}`)
    return this.ctx.db.transaction(() => {
      a.overdraftLimit = cents
      a.updatedAt = isoUtc(this.ctx.clock.now())
      this.repo.save(a)
      this.reevaluateStatus(a, 'CLIENT', false)
      return a
    })()
  }

  /** createAccountCustomData: replaces the whole object. */
  setCustomData(id: string, customData: Record<string, unknown>): Account {
    const a = this.requireNotClosed(id)
    a.customData = customData
    a.updatedAt = isoUtc(this.ctx.clock.now())
    this.repo.save(a)
    return a
  }

  /** deleteAccountCustomData: clears it (idempotent). */
  deleteCustomData(id: string): Account {
    const a = this.get(id)
    a.customData = null
    a.updatedAt = isoUtc(this.ctx.clock.now())
    this.repo.save(a)
    return a
  }

  // ---------------------------------------------------------------- rules

  addRule(id: string, input: AddRuleInput): RuleResponse {
    const a = this.requireNotClosed(id)
    const details = validateRuleDetails(input.ruleType, input.ruleDetails)
    const now = this.ctx.clock.now()
    const rule: AccountRule = {
      id: uuid(),
      accountId: a.id,
      name: input.name,
      ruleType: input.ruleType,
      ruleDetails: details,
      ownerId: a.holderId,
      disabled: false,
      createdAt: isoUtc(now),
    }
    if (input.expiresIn !== undefined && input.expiresIn !== null) {
      // int64 with only `minimum: 1`: anything past the Date range would make isoUtc() throw (500)
      const expiresMs = now.getTime() + input.expiresIn * 1000
      if (!Number.isFinite(expiresMs) || expiresMs > MAX_DATE_MS) throw unprocessable('INVALID_RULE: expiresIn is too large')
      rule.expiresAt = isoUtc(new Date(expiresMs))
    }
    this.repo.insertRule(rule)
    return this.ruleToResponse(rule)
  }

  rules(id: string): RuleResponse[] {
    this.get(id)
    return this.repo.rulesForAccount(id).map((r) => this.ruleToResponse(r))
  }

  /** @throws 404 when the rule is unknown or belongs to another account */
  rule(id: string, ruleId: string): RuleResponse {
    return this.ruleToResponse(this.requireRule(id, ruleId))
  }

  disableRule(id: string, ruleId: string): boolean {
    const r = this.requireRule(id, ruleId)
    if (!r.disabled) this.repo.disableRule(r.id)
    return true
  }

  /** First enabled, unexpired rule (creation order) matching the merchant, as the TRANSACTION webhook's ruleDetails; null when none. */
  evaluateRules(id: string, merchant: MerchantInput): { ruleId: string } | null {
    const now = this.ctx.clock.now().getTime()
    for (const r of this.repo.rulesForAccount(id)) {
      if (r.disabled || (r.expiresAt && new Date(r.expiresAt).getTime() <= now)) continue
      if (ruleMatches(r, merchant)) return { ruleId: r.id }
    }
    return null
  }

  private requireRule(accountId: string, ruleId: string): AccountRule {
    this.get(accountId)
    const r = this.repo.ruleById(ruleId)
    if (!r || r.accountId !== accountId) throw notFound(`NOT_FOUND: Rule ${ruleId} not found`)
    return r
  }

  private ruleToResponse(r: AccountRule): RuleResponse {
    const expired = r.expiresAt !== undefined && new Date(r.expiresAt).getTime() <= this.ctx.clock.now().getTime()
    return compact({
      id: r.id,
      name: r.name,
      ruleType: r.ruleType,
      rule: { ...r.ruleDetails } as RuleResponse['rule'],
      ownerId: r.ownerId,
      disabled: r.disabled || expired,
      expiresAtUtc: r.expiresAt,
    })
  }

  // ---------------------------------------------------------------- status machine

  /**
   * Generic status change (other domains / admin). Same status -> no-op. Leaving CLOSED, or moving to
   * PENDING_APPROVAL (never produced: accounts created through this API are always APPROVED) -> 422
   * INVALID_STATE. Sets blockedBy on LOCKED (cleared otherwise), closedDateTimeUtc on CLOSED. Emits
   * account.statusChanged.
   */
  setStatus(id: string, status: AccountStatus, opts: StatusOptions): Account {
    if (status === 'PENDING_APPROVAL') throw unprocessable(`INVALID_STATE: Account ${id} cannot move to PENDING_APPROVAL`)
    return this.transition(this.get(id), status, opts)
  }

  private transition(a: Account, to: AccountStatus, opts: StatusOptions): Account {
    if (a.status === to) return a
    if (a.status === 'CLOSED') throw unprocessable(`INVALID_STATE: Account ${a.id} is CLOSED and cannot move to ${to}`)
    const from = a.status
    const now = isoUtc(this.ctx.clock.now())
    a.status = to
    a.updatedAt = now
    if (to === 'LOCKED') a.blockedBy = opts.blockedBy ?? opts.actionOwner
    else { delete a.blockedBy; delete a.blockedCustomerIds }
    if (to === 'CLOSED') {
      a.closedAt = now
      if (opts.closeReason) a.closeReason = opts.closeReason
    }
    this.repo.save(a)
    this.ctx.events.emit('account.statusChanged', { account: structuredClone(a), previousStatus: from, actionOwner: opts.actionOwner })
    return a
  }

  private requireNotClosed(id: string): Account {
    const a = this.get(id)
    if (a.status === 'CLOSED') throw unprocessable(`ACCOUNT_CLOSED: Account ${id} is CLOSED`)
    return a
  }

  /**
   * blockAccount: the account and every child account -> LOCKED (blockedBy = `blockedBy` or the action
   * owner); already LOCKED or CLOSED accounts count as success (idempotent, no event). Unless
   * ACCOUNT_ONLY, every owning customer is blocked too — also when the account was already LOCKED, so a
   * default-style call widens an earlier ACCOUNT_ONLY block (a CLOSED root never blocks its customer);
   * a customer that cannot be blocked (INACTIVE) is a partial success (still 200). The root records the
   * customers it holds BLOCKED (blockedCustomerIds, appended): the ones it transitioned plus those
   * another LOCKED account is already holding, so unblock releases a customer only with its last such account.
   */
  block(id: string, opts: { note: string; style?: 'ACCOUNT_ONLY' | 'ACCOUNT_AND_CUSTOMER' | null; actionOwner?: ActionOwner; blockedBy?: BlockedBy }): BlockAccountResponse {
    const actionOwner = opts.actionOwner ?? 'CLIENT'
    const blockedBy = opts.blockedBy ?? actionOwner
    const root = this.get(id)
    const failedCustomers: string[] = []
    this.ctx.db.transaction(() => {
      for (const a of [root, ...this.repo.children(root.id)]) {
        if (a.status === 'LOCKED' || a.status === 'CLOSED') continue
        a.blockNote = opts.note
        this.transition(a, 'LOCKED', { actionOwner, blockedBy })
      }
      if (opts.style === 'ACCOUNT_ONLY' || root.status !== 'LOCKED') return
      const customers = this.ctx.services.customers
      const held: string[] = []
      for (const cid of this.holderCustomerIds(root)) {
        const c = customers.find(cid)
        if (!c) continue
        if (c.status === 'BLOCKED') {
          // already BLOCKED: hold it here too when an account block put it there (a blockCustomer block is left alone)
          if (this.repo.lockedBlockersOf(cid).length) held.push(cid)
          continue
        }
        try {
          customers.block(cid, { note: opts.note, actionOwner, blockedBy })
          held.push(cid)
        } catch (err) {
          if (!(err instanceof ApiError)) throw err
          failedCustomers.push(cid)
        }
      }
      if (held.length) {
        root.blockedCustomerIds = [...new Set([...(root.blockedCustomerIds ?? []), ...held])]
        this.repo.save(root)
      }
    })()
    const message = failedCustomers.length
      ? `Account blocked; customer(s) could not be blocked: ${failedCustomers.join(', ')}`
      : 'Account blocked successfully.'
    return { failedAccounts: [], message }
  }

  /**
   * unblockAccount: LOCKED -> ACTIVE (ACTIVE_IN_ARREARS when technically overdrawn), LOCKED child
   * accounts follow. The customers held BLOCKED by these accounts are released unless another LOCKED
   * account still holds them; customers blocked independently (blockCustomer) are never touched.
   * Not LOCKED -> 422 INVALID_STATE.
   */
  unblock(id: string, opts: { note?: string; actionOwner?: ActionOwner } = {}): Account {
    const actionOwner = opts.actionOwner ?? 'CLIENT'
    const root = this.get(id)
    if (root.status !== 'LOCKED') throw unprocessable(`INVALID_STATE: Account ${id} is not LOCKED (status is ${root.status})`)
    return this.ctx.db.transaction(() => {
      const scope = [root, ...this.repo.children(root.id)].filter((a) => a.status === 'LOCKED')
      const heldCustomers = [...new Set(scope.flatMap((a) => a.blockedCustomerIds ?? []))]
      for (const a of scope) {
        if (opts.note !== undefined) a.blockNote = opts.note
        this.transition(a, computeBalances(a).technicalOverdraftBalance > 0 ? 'ACTIVE_IN_ARREARS' : 'ACTIVE', { actionOwner })
      }
      const customers = this.ctx.services.customers
      for (const cid of heldCustomers) {
        if (customers.find(cid)?.status !== 'BLOCKED') continue
        if (this.repo.lockedBlockersOf(cid).length) continue // another LOCKED account still holds this customer
        customers.unblock(cid, { actionOwner })
      }
      return root
    })()
  }

  addClosureChecker(fn: ClosureChecker): void {
    this.closureCheckers.push(fn)
  }

  /** Synchronous closure validation: every failing check, in ClosureCheckerError.type order. */
  closureErrors(a: Account): ClosureCheckerError[] {
    const b = computeBalances(a)
    const errors: ClosureCheckerError[] = []
    if (a.ledger !== 0) errors.push({ type: 'ACCOUNT_BALANCE_TOTAL', errorMessage: `Account has ${centsToString(a.ledger)} total balance.` })
    if (b.stacksBalance !== 0) errors.push({ type: 'ACCOUNT_BALANCE_STACKS', errorMessage: `Account has ${centsToString(b.stacksBalance)} stacks balance.` })
    if (b.heldBalance !== 0) errors.push({ type: 'ACCOUNT_BALANCE_HELD', errorMessage: `Account has ${centsToString(b.heldBalance)} held balance.` })
    if (b.lockedBalance !== 0) errors.push({ type: 'ACCOUNT_BALANCE_LOCKED', errorMessage: `Account has ${centsToString(b.lockedBalance)} locked balance.` })
    if (b.overdraftBalance !== 0) errors.push({ type: 'ACCOUNT_BALANCE_OVERDRAFT', errorMessage: `Account has ${centsToString(b.overdraftBalance)} overdraft balance.` })
    if (b.technicalOverdraftBalance !== 0) errors.push({ type: 'ACCOUNT_BALANCE_TECHNICAL_OVERDRAFT', errorMessage: `Account has ${centsToString(b.technicalOverdraftBalance)} technical overdraft balance.` })
    for (const check of this.closureCheckers) errors.push(...check(a))
    const openChildren = this.repo.children(a.id).filter((c) => c.status !== 'CLOSED')
    if (openChildren.length) {
      errors.push({ type: 'CHILD_ACCOUNT_STATUS', errorMessage: `Account has ${openChildren.length} child accounts not closed: [${openChildren.map((c) => c.id).join(', ')}]` })
    }
    return errors
  }

  /**
   * closeAccount: 202 SUCCESS when every closure check passes (already CLOSED -> SUCCESS, idempotent),
   * then the cascade runs through the scheduler: CLOSED + closedDateTimeUtc (ACCOUNT_STATUS_CHANGE
   * CLOSED), cards cancelled, owning customer(s) INACTIVE when no other open account remains.
   * @throws ApiError 422 with the CloseAccountResponse body when a check fails
   */
  close(id: string, reason?: CloseReason | null): CloseAccountResponse {
    const a = this.get(id)
    if (a.status === 'CLOSED') return { result: 'SUCCESS', description: 'Account is already closed.', errors: [] }
    const errors = this.closureErrors(a)
    if (errors.length) {
      const body: CloseAccountResponse = { result: 'FAILURE', description: 'Account closure failed. Check errors for more details.', errors }
      throw new ApiError(422, `ACCOUNT_CLOSURE_FAILED: ${errors.map((e) => e.type).join(', ')}`, body)
    }
    this.ctx.scheduler.later(() => this.completeClosure(id, reason ?? undefined))
    return { result: 'SUCCESS', description: 'Account closure request accepted.', errors: [] }
  }

  /** The asynchronous closure cascade (runs once; a second close request for the same account is a no-op here). */
  completeClosure(id: string, reason?: CloseReason): void {
    const a = this.repo.byId(id)
    if (!a || a.status === 'CLOSED') return
    if (this.closureErrors(a).length) return // balances moved between the request and the cascade: leave the account open
    this.ctx.db.transaction(() => {
      this.transition(a, 'CLOSED', { actionOwner: 'CLIENT', closeReason: reason })
    })()
    deps(this.ctx).cards?.cancelAllForAccount(a.id, reason)
    this.deactivateOrphanedHolders(a, reason)
  }

  /** Customer -> INACTIVE (closure reason stored) when none of its personal or group accounts remains open. */
  private deactivateOrphanedHolders(a: Account, reason?: CloseReason): void {
    const customers = this.ctx.services.customers
    for (const cid of this.holderCustomerIds(a)) {
      const c = customers.find(cid)
      if (!c || c.status === 'INACTIVE') continue
      if (this.hasOpenAccounts(cid)) continue
      customers.markInactive(cid, reason)
    }
  }

  hasOpenAccounts(customerId: string): boolean {
    const holders = [customerId, ...(deps(this.ctx).groups?.groupIdsForCustomer(customerId) ?? [])]
    return this.repo.countOpenForHolders(holders) > 0
  }
}

// ---------------------------------------------------------------- rule helpers

const MERCHANT_ID_RE = /^[A-Za-z0-9]{1,15}$/

/** Conditional requirements from the RuleDetails descriptions -> 422 INVALID_RULE. Returns the details relevant to the type. */
export function validateRuleDetails(type: RuleType, d: RuleDetails | undefined): RuleDetails {
  const details = d ?? {}
  switch (type) {
    case 'MERCHANT_CODE_BLOCK': {
      const codes = details.blockedMerchantCategoryCodes
      if (!codes?.length) throw unprocessable('INVALID_RULE: blockedMerchantCategoryCodes is required for rule type MERCHANT_CODE_BLOCK')
      for (const c of codes) if (!Number.isInteger(c) || c < 0 || c > 9999) throw unprocessable(`INVALID_RULE: merchant category code ${c} must be a four digit ISO 18245 code`)
      return { blockedMerchantCategoryCodes: [...codes] }
    }
    case 'MERCHANT_ID_BLOCK': {
      const ids = details.blockedMerchantIds
      if (!ids?.length) throw unprocessable('INVALID_RULE: blockedMerchantIds is required for rule type MERCHANT_ID_BLOCK')
      for (const m of ids) if (!MERCHANT_ID_RE.test(m)) throw unprocessable(`INVALID_RULE: merchant id '${m}' must be up to 15 alphanumeric characters`)
      return { blockedMerchantIds: [...ids] }
    }
    case 'MERCHANT_NAME_BLOCK': {
      if (!details.blockedMerchantName) throw unprocessable('INVALID_RULE: blockedMerchantName is required for rule type MERCHANT_NAME_BLOCK')
      if (!details.merchantNameMatchingOperator) throw unprocessable('INVALID_RULE: merchantNameMatchingOperator is required for rule type MERCHANT_NAME_BLOCK')
      return { blockedMerchantName: details.blockedMerchantName, merchantNameMatchingOperator: details.merchantNameMatchingOperator }
    }
  }
}

export function ruleMatches(r: AccountRule, m: MerchantInput): boolean {
  const d = r.ruleDetails
  switch (r.ruleType) {
    case 'MERCHANT_CODE_BLOCK':
      return m.mcc !== undefined && m.mcc !== null && (d.blockedMerchantCategoryCodes ?? []).includes(m.mcc)
    case 'MERCHANT_ID_BLOCK':
      return !!m.merchantId && (d.blockedMerchantIds ?? []).some((id) => id.toLowerCase() === m.merchantId!.toLowerCase())
    case 'MERCHANT_NAME_BLOCK': {
      if (!m.merchantName || !d.blockedMerchantName) return false
      const name = m.merchantName.toLowerCase()
      const value = d.blockedMerchantName.toLowerCase()
      switch (d.merchantNameMatchingOperator) {
        case 'EXACT': return name === value
        case 'STARTS_WITH': return name.startsWith(value)
        case 'ENDS_WITH': return name.endsWith(value)
        default: return name.includes(value)
      }
    }
  }
}
