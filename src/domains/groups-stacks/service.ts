/**
 * Groups (spec §5.9): membership, the all-members-ACTIVE gate for group accounts, the removal cascade.
 * Stacks: per-account savings jars whose balances live inside the account's ledger but outside its
 * availableBalance (accounts.adjust({ stacksDelta })), with their own sub-ledger (HayStackTransaction).
 * Publishes ctx.services.groups and ctx.services.stacks.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import type { AppContext } from '../../context.js'
import { compact, type ActionOwner } from '../../events/notify.js'
import { isoUtc } from '../../lib/clock.js'
import { badRequest, notFound, unprocessable } from '../../lib/errors.js'
import { uuid } from '../../lib/ids.js'
import { fromCents, hasAtMostTwoDecimals, toCents, type Cents } from '../../lib/money.js'
import type { Account } from '../accounts/index.js'
import { deps } from './deps.js'
import type { BusinessIdentifiers, Group, GroupType, GroupsStacksRepo, Stack, StackOriginType, StackTransaction, StackTransactionType } from './repo.js'

type S = components['schemas']
export type HayGroup = S['HayGroup']
export type HayJointAccount = S['HayJointAccount']
export type HayStack = S['HayStack']
export type StackDto = S['Stack']
export type HayStackTransaction = S['HayStackTransaction']
export type StackOutcome = NonNullable<S['StackTransactionResponse']['outcome']>
export type UpdateStackResponse = S['UpdateStackResponse']

export interface CreateGroupInput {
  customerHayIds: string[]
  groupName?: string | null
  groupType?: GroupType | null
  businessIdentifiers?: BusinessIdentifiers | null
}

export interface UpdateGroupInput {
  groupName?: string | null
  groupType?: GroupType | null
  businessIdentifiers?: BusinessIdentifiers | null
}

export interface CreateStackInput { name: string; imageUrl?: string | null; targetAmount?: number | null }
export interface UpdateStackInput { name?: string | null; imageUrl?: string | null; targetAmount?: number | null }

export interface StackMoveInput {
  /** Request magnitude (JSON number, > 0, <= 2 dp -> 400 otherwise). */
  amount: number
  customerId: string
  description?: string | null
}

export interface StackMoveResult { outcome: StackOutcome; transactionId?: string }
export interface StackToStackResult { outcome: StackOutcome; withdrawalTransactionId?: string; depositTransactionId?: string }

declare module '../../context.js' {
  interface ServiceMap {
    groups: GroupsService
    stacks: StacksService
  }
}

/** Customer statuses that can never join a group: closed or rejected records. */
const UNJOINABLE: ReadonlySet<string> = new Set(['INACTIVE', 'REJECTED'])
const EMOJI_RE = /\p{Extended_Pictographic}/u

/** Request amount -> cents; more than two decimal places or a non-positive value is a 400, never rounded. */
function requestCents(amount: number, field: string, opts: { allowZero?: boolean } = {}): Cents {
  if (typeof amount !== 'number' || !hasAtMostTwoDecimals(amount)) throw badRequest(`BAD_REQUEST: ${field} must be a number with at most 2 decimal places`)
  if (amount < 0 || (amount === 0 && !opts.allowZero)) throw badRequest(`BAD_REQUEST: ${field} must be greater than 0`)
  return toCents(amount)
}

// ====================================================================== groups

export class GroupsService {
  constructor(private readonly ctx: AppContext, private readonly repo: GroupsStacksRepo) {}

  find(id: string): Group | undefined {
    return this.repo.groupById(id)
  }

  /** @throws 404 NOT_FOUND */
  get(id: string): Group {
    const g = this.repo.groupById(id)
    if (!g) throw notFound(`NOT_FOUND: Group ${id} not found`)
    return g
  }

  /** Alias of get(): the group must exist. */
  require(id: string): Group {
    return this.get(id)
  }

  /** Member customer ids in join order. @throws 404 for an unknown group */
  members(groupId: string): string[] {
    return this.get(groupId).customerHayIds
  }

  /** accounts dep: member ids, empty for an unknown group (never throws). */
  memberIds(groupId: string): string[] {
    return this.repo.memberIds(groupId)
  }

  /** accounts dep: ids of the groups the customer belongs to. */
  groupIdsForCustomer(customerHayId: string): string[] {
    return this.repo.groupIdsForCustomer(customerHayId)
  }

  isMember(groupId: string, customerId: string): boolean {
    return this.repo.isMember(groupId, customerId)
  }

  /**
   * Group-account creation gate (accounts dep): every member ACTIVE.
   * @throws 404 for an unknown group; 422 with the spec's verbatim message otherwise
   */
  requireAllMembersActive(groupHayId: string): void {
    const g = this.get(groupHayId)
    const customers = this.ctx.services.customers
    for (const cid of g.customerHayIds) {
      if (customers.find(cid)?.status !== 'ACTIVE') {
        throw unprocessable(`PERMISSION_DENIED: Account cannot be created for group with id ${groupHayId}, all members of the group should have an ACTIVE status`)
      }
    }
  }

  /** The group's accounts (accountHolderType GROUP), creation order. */
  accounts(groupId: string): Account[] {
    return this.ctx.services.accounts.listEntitiesForHolder(groupId, 'GROUP')
  }

  toResponse(g: Group): HayGroup {
    return compact({ groupHayId: g.id, groupName: g.name, groupType: g.groupType, customerHayIds: [...g.customerHayIds], businessIdentifiers: g.businessIdentifiers })
  }

  /**
   * HayJointAccount: the group plus its account — `account` when the caller just created one, else the
   * group's first-created account; omitted while the group has none.
   */
  toJointAccount(g: Group, account?: Account): HayJointAccount {
    const a = account ?? this.accounts(g.id)[0]
    return compact({
      groupHayId: g.id,
      name: g.name,
      groupType: g.groupType,
      customerHayIds: [...g.customerHayIds],
      businessIdentifiers: g.businessIdentifiers,
      hayAccount: a ? this.ctx.services.accounts.toResponse(a) : undefined,
    })
  }

  /**
   * createHayGroup: >= 1 member (422), members must exist (404) and not be INACTIVE / REJECTED (422);
   * duplicates collapse; groupType defaults to PERSONAL; groupName defaults to "<clientId> Group <n>".
   * Idempotency is the route's concern.
   */
  create(input: CreateGroupInput): Group {
    const members = this.checkMembers(input.customerHayIds)
    if (!members.length) throw unprocessable('INVALID_ARGUMENT: customerHayIds must contain at least one customer')
    const seq = this.repo.nextGroupSeq()
    const g: Group = compact({
      id: uuid(),
      name: input.groupName ?? `${this.ctx.config.clientId} Group ${seq}`,
      groupType: input.groupType ?? 'PERSONAL',
      businessIdentifiers: input.businessIdentifiers === null ? undefined : input.businessIdentifiers,
      customerHayIds: members,
      createdAt: isoUtc(this.ctx.clock.now()),
    })
    this.repo.insertGroup(g, seq)
    this.ctx.events.emit('group.created', { group: structuredClone(g) })
    return g
  }

  /** updateGroup: only supplied fields change; businessIdentifiers is replaced as a whole. */
  update(id: string, input: UpdateGroupInput): Group {
    const g = this.get(id)
    if (input.groupName !== undefined && input.groupName !== null) g.name = input.groupName
    if (input.groupType !== undefined && input.groupType !== null) g.groupType = input.groupType
    if (input.businessIdentifiers !== undefined) {
      if (input.businessIdentifiers === null) delete g.businessIdentifiers
      else g.businessIdentifiers = { ...input.businessIdentifiers }
    }
    g.updatedAt = isoUtc(this.ctx.clock.now())
    this.repo.saveGroup(g)
    this.ctx.events.emit('group.updated', { group: structuredClone(g) })
    return g
  }

  /** addCustomersToGroup: set union — existing members and duplicates are ignored; unknown -> 404, INACTIVE / REJECTED -> 422. */
  addMembers(id: string, customerHayIds: string[]): Group {
    const g = this.get(id)
    const added = this.checkMembers(customerHayIds).filter((cid) => !g.customerHayIds.includes(cid))
    if (!added.length) return g
    this.ctx.db.transaction(() => {
      for (const cid of added) this.repo.addMember(g.id, cid)
      g.updatedAt = isoUtc(this.ctx.clock.now())
      this.repo.saveGroup(g)
    })()
    g.customerHayIds.push(...added)
    this.ctx.events.emit('group.membershipChanged', { group: structuredClone(g), added, removed: [] })
    return g
  }

  /**
   * removeCustomerFromGroup: unknown customer -> 404; not a member -> 422 NOT_A_MEMBER; the final member
   * -> 422 LAST_GROUP_MEMBER. Synchronous cascade (00-open-questions T1/S18): the customer's cards on the
   * group's accounts are cancelled (cards dep, when present) and the customer becomes INACTIVE when it
   * is linked only to CLOSED accounts (its own and those of its remaining groups).
   */
  removeMember(id: string, customerId: string): Group {
    const g = this.get(id)
    const customers = this.ctx.services.customers
    customers.get(customerId)
    if (!g.customerHayIds.includes(customerId)) throw unprocessable(`NOT_A_MEMBER: Customer ${customerId} is not a member of group ${id}`)
    if (g.customerHayIds.length === 1) throw unprocessable(`LAST_GROUP_MEMBER: Customer ${customerId} is the final member of group ${id} and cannot be removed`)
    this.ctx.db.transaction(() => {
      this.repo.removeMember(g.id, customerId)
      g.customerHayIds = g.customerHayIds.filter((c) => c !== customerId)
      g.updatedAt = isoUtc(this.ctx.clock.now())
      this.repo.saveGroup(g)
    })()
    this.ctx.events.emit('group.membershipChanged', { group: structuredClone(g), added: [], removed: [customerId] })

    const groupAccounts = this.accounts(g.id)
    const cards = deps(this.ctx).cards
    if (cards) {
      if (typeof cards.cancelForCustomerOnAccount === 'function') {
        for (const a of groupAccounts) cards.cancelForCustomerOnAccount(customerId, a.id, 'Customer removed from group')
      } else {
        this.ctx.log.warn({ groupId: g.id, customerId }, 'groups: cards.cancelForCustomerOnAccount is not implemented; cards on the group accounts were not cancelled')
      }
    }
    const accounts = this.ctx.services.accounts
    const c = customers.find(customerId)
    if (c && c.status !== 'INACTIVE' && !accounts.hasOpenAccounts(customerId) && this.hasAnyAccount(customerId)) customers.markInactive(customerId)
    return g
  }

  /** Whether the customer is linked to at least one account (personal, or through a group it still belongs to). */
  private hasAnyAccount(customerId: string): boolean {
    const accounts = this.ctx.services.accounts
    if (accounts.listEntitiesForHolder(customerId, 'CUSTOMER').length) return true
    return this.repo.groupIdsForCustomer(customerId).some((gid) => accounts.listEntitiesForHolder(gid, 'GROUP').length > 0)
  }

  /** De-duplicated member ids that exist (404) and can join (422 for INACTIVE / REJECTED). */
  private checkMembers(ids: string[]): string[] {
    const customers = this.ctx.services.customers
    const out: string[] = []
    for (const cid of new Set(ids)) {
      const c = customers.get(cid)
      if (UNJOINABLE.has(c.status)) throw unprocessable(`PERMISSION_DENIED: Customer ${cid} cannot be added to a group as their status is currently ${c.status}`)
      out.push(cid)
    }
    return out
  }
}

// ====================================================================== stacks

export class StacksService {
  constructor(private readonly ctx: AppContext, private readonly repo: GroupsStacksRepo) {}

  // ---------------------------------------------------------------- reads

  find(id: string): Stack | undefined {
    return this.repo.stackById(id)
  }

  /** The stack, which must belong to the account. @throws 404 when unknown or on another account */
  get(accountId: string, stackId: string): Stack {
    const s = this.repo.stackById(stackId)
    if (!s || s.accountId !== accountId) throw notFound(`NOT_FOUND: Stack ${stackId} not found`)
    return s
  }

  /** getAllStacks: creation order; CLOSED stacks only with `includeClosed`. @throws 404 for an unknown account */
  list(accountId: string, includeClosed: boolean): HayStack[] {
    this.ctx.services.accounts.get(accountId)
    return this.repo.stacksForAccount(accountId, includeClosed).map((s) => this.toResponse(s))
  }

  toResponse(s: Stack): HayStack {
    return compact({ ...this.stackFields(s), stackHayId: s.id })
  }

  /** The `Stack` projection returned by updateStack: same record, identifier named `hayId`. */
  toStackDto(s: Stack): StackDto {
    return compact({ ...this.stackFields(s), hayId: s.id })
  }

  private stackFields(s: Stack) {
    return {
      accountHayId: s.accountId,
      name: s.name,
      imageUrl: s.imageUrl,
      targetAmount: s.targetAmount === undefined ? undefined : fromCents(s.targetAmount),
      balance: fromCents(s.balance),
      status: s.status,
      createdAtUtc: s.createdAt,
      closedAtUtc: s.closedAt,
    }
  }

  transactionToResponse(t: StackTransaction): HayStackTransaction {
    const stack = this.repo.stackById(t.stackId)
    return compact({
      hayId: t.id,
      accountHayId: t.accountId,
      stackHayId: t.stackId,
      stack: stack ? this.toResponse(stack) : undefined,
      amount: fromCents(t.amount),
      customerId: t.customerId,
      notes: t.notes,
      counterpartTransactionId: t.counterpartTransactionId,
      originId: t.originId,
      originType: t.originType,
      type: t.type,
      transactionTimeUtc: t.transactionTime,
    })
  }

  /** getAllStackTransactions / getTransactionsForStack: newest first, `type` filter, offset/limit (limit 1..1000, offset >= 0 -> 400). */
  listTransactions(accountId: string, page: { offset: number; limit: number; type?: StackTransactionType | null }, stackId?: string): HayStackTransaction[] {
    this.ctx.services.accounts.get(accountId)
    if (stackId) this.get(accountId, stackId)
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 1000) throw badRequest('BAD_REQUEST: limit must be between 1 and 1000')
    if (!Number.isInteger(page.offset) || page.offset < 0) throw badRequest('BAD_REQUEST: offset must be greater than or equal to 0')
    return this.repo.transactions({ accountId, stackId, type: page.type ?? undefined, offset: page.offset, limit: page.limit }).map((t) => this.transactionToResponse(t))
  }

  // ---------------------------------------------------------------- create / update / close

  /**
   * createStack: account not CLOSED (422 ACCOUNT_CLOSED); name without emojis (422 INVALID_ARGUMENT),
   * unique among the account's OPEN stacks (422 STACK_NAME_ALREADY_IN_USE); targetAmount <= 2 dp (400)
   * and at most the account's MAX_BALANCE limit (422). No count limit. Returns the new stack (the
   * operation's own response is a bare `true`).
   */
  create(accountId: string, input: CreateStackInput): Stack {
    const a = this.requireNotClosed(accountId)
    this.validateName(input.name)
    if (this.repo.openStackNamed(accountId, input.name)) throw unprocessable(`STACK_NAME_ALREADY_IN_USE: Account ${accountId} already has an open stack named '${input.name}'`)
    const s: Stack = compact({
      id: uuid(),
      accountId,
      name: input.name,
      imageUrl: input.imageUrl ?? undefined,
      targetAmount: this.targetCents(a, input.targetAmount),
      balance: 0,
      status: 'OPEN',
      createdAt: isoUtc(this.ctx.clock.now()),
    })
    this.repo.insertStack(s)
    this.ctx.events.emit('stack.created', { stack: structuredClone(s) })
    return s
  }

  /**
   * updateStack: OPEN stack only (422 STACK_CLOSED); supplied fields replace; a name already used by
   * another open stack answers `{ error: STACK_NAME_ALREADY_IN_USE }` (200, no stack) as the spec's
   * UpdateStackResponse.error suggests.
   */
  update(accountId: string, stackId: string, input: UpdateStackInput): UpdateStackResponse {
    const a = this.requireNotClosed(accountId)
    const s = this.requireOpen(accountId, stackId)
    if (input.name !== undefined && input.name !== null) {
      this.validateName(input.name)
      if (this.repo.openStackNamed(accountId, input.name, s.id)) return { error: 'STACK_NAME_ALREADY_IN_USE' }
      s.name = input.name
    }
    if (input.imageUrl !== undefined && input.imageUrl !== null) s.imageUrl = input.imageUrl
    if (input.targetAmount !== undefined && input.targetAmount !== null) s.targetAmount = this.targetCents(a, input.targetAmount)
    s.updatedAt = isoUtc(this.ctx.clock.now())
    this.repo.saveStack(s)
    this.ctx.events.emit('stack.updated', { stack: structuredClone(s) })
    return { stack: this.toStackDto(s) }
  }

  /**
   * closeStack: OPEN -> CLOSED (closedAtUtc = now); a balance is swept back to the account (stacks −b,
   * available +b) as a STANDARD withdrawal by OPERATIONS (customerId = the holder of a personal account,
   * absent for a group account). Sweeping needs an account open for movement (422 ACCOUNT_BLOCKED /
   * ACCOUNT_CLOSED); an empty stack closes on any account. Already CLOSED -> no-op (docs: "responds
   * confirming the account is closed on each attempt").
   */
  close(accountId: string, stackId: string, opts: { actionOwner?: ActionOwner } = {}): Stack {
    const s = this.get(accountId, stackId)
    if (s.status === 'CLOSED') return s
    const accounts = this.ctx.services.accounts
    const a = accounts.get(accountId)
    if (s.balance > 0) this.requireOpenForMovement(accountId)
    const now = isoUtc(this.ctx.clock.now())
    const swept = s.balance
    this.ctx.db.transaction(() => {
      if (swept > 0) {
        accounts.adjust(accountId, { stacksDelta: -swept })
        this.repo.insertTransaction(this.record({
          accountId, stackId: s.id, amount: -swept, originType: 'OPERATIONS', customerId: a.holderType === 'CUSTOMER' ? a.holderId : undefined, notes: 'Stack closed', transactionTime: now,
        }))
      }
      s.balance = 0
      s.status = 'CLOSED'
      s.closedAt = now
      s.updatedAt = now
      this.repo.saveStack(s)
    })()
    this.ctx.events.emit('stack.closed', { stack: structuredClone(s), sweptCents: swept, actionOwner: opts.actionOwner ?? 'CLIENT' })
    return s
  }

  /** Account-closure cascade: the account's remaining OPEN stacks (empty — closure requires stacksBalance 0) are closed by the platform. */
  closeAllForAccount(accountId: string): void {
    for (const s of this.repo.stacksForAccount(accountId, false)) {
      if (s.balance === 0) this.close(accountId, s.id, { actionOwner: 'PLATFORM' })
    }
  }

  // ---------------------------------------------------------------- movements

  /**
   * accountToStackTransfer: available −a, stacks +a (the account's total is unchanged; the move counts as
   * the account's first transaction — APPROVED -> ACTIVE). Checks: amount (400), customer holds the
   * account (404 / 422 PERMISSION_DENIED), account open for movement (422), stack OPEN (422 STACK_CLOSED),
   * then funds: `a <= availableBalance` else REFUSED_INSUFFICIENT_FUNDS (200). No daily-limit check
   * (docs: internal moves are exempt); MAX_BALANCE is unaffected (the money is already on the ledger).
   */
  transferIn(accountId: string, stackId: string, input: StackMoveInput): StackMoveResult {
    const cents = requestCents(input.amount, 'amount')
    const s = this.get(accountId, stackId)
    this.requireHolder(accountId, input.customerId)
    this.requireOpenForMovement(accountId)
    this.requireOpenStack(s)
    const accounts = this.ctx.services.accounts
    if (accounts.checkFunds(accountId, cents)) return { outcome: 'REFUSED_INSUFFICIENT_FUNDS' }
    const t = this.ctx.db.transaction(() => {
      accounts.adjust(accountId, { stacksDelta: cents })
      s.balance += cents
      s.updatedAt = isoUtc(this.ctx.clock.now())
      this.repo.saveStack(s)
      const t = this.record({ accountId, stackId: s.id, amount: cents, originType: 'CUSTOMER', customerId: input.customerId, notes: input.description ?? undefined })
      this.repo.insertTransaction(t)
      return t
    })()
    this.ctx.events.emit('stack.transactionPosted', { transaction: t, stack: structuredClone(s) })
    return { outcome: 'ACCEPTED', transactionId: t.id }
  }

  /** stackToAccountTransfer: stacks −a, available +a; `a <= stack.balance` else REFUSED_INSUFFICIENT_FUNDS (200). Same gates as transferIn. */
  transferOut(accountId: string, stackId: string, input: StackMoveInput): StackMoveResult {
    const cents = requestCents(input.amount, 'amount')
    const s = this.get(accountId, stackId)
    this.requireHolder(accountId, input.customerId)
    this.requireOpenForMovement(accountId)
    this.requireOpenStack(s)
    if (s.balance < cents) return { outcome: 'REFUSED_INSUFFICIENT_FUNDS' }
    const accounts = this.ctx.services.accounts
    const t = this.ctx.db.transaction(() => {
      accounts.adjust(accountId, { stacksDelta: -cents })
      s.balance -= cents
      s.updatedAt = isoUtc(this.ctx.clock.now())
      this.repo.saveStack(s)
      const t = this.record({ accountId, stackId: s.id, amount: -cents, originType: 'CUSTOMER', customerId: input.customerId, notes: input.description ?? undefined })
      this.repo.insertTransaction(t)
      return t
    })()
    this.ctx.events.emit('stack.transactionPosted', { transaction: t, stack: structuredClone(s) })
    return { outcome: 'ACCEPTED', transactionId: t.id }
  }

  /**
   * stackToStackTransfer: two records cross-linked by counterpartTransactionId — a withdrawal (−a) on the
   * source and a deposit (+a) on the destination; the account's balances do not move (an APPROVED /
   * DORMANT account still becomes ACTIVE: a stack move is a transactional action). Both stacks must be
   * OPEN stacks of the account (404 / 422 STACK_CLOSED) and differ (422 INVALID_ARGUMENT); source
   * balance < a -> REFUSED_INSUFFICIENT_FUNDS (200).
   */
  transferBetween(accountId: string, input: StackMoveInput & { withdrawalStackId: string; depositStackId: string }): StackToStackResult {
    const cents = requestCents(input.amount, 'amount')
    const from = this.get(accountId, input.withdrawalStackId)
    const to = this.get(accountId, input.depositStackId)
    if (from.id === to.id) throw unprocessable('INVALID_ARGUMENT: withdrawalStackId and depositStackId must be different stacks')
    this.requireHolder(accountId, input.customerId)
    const a = this.requireOpenForMovement(accountId)
    this.requireOpenStack(from)
    this.requireOpenStack(to)
    if (from.balance < cents) return { outcome: 'REFUSED_INSUFFICIENT_FUNDS' }
    const now = isoUtc(this.ctx.clock.now())
    const [withdrawal, deposit] = this.ctx.db.transaction((): [StackTransaction, StackTransaction] => {
      from.balance -= cents
      from.updatedAt = now
      to.balance += cents
      to.updatedAt = now
      this.repo.saveStack(from)
      this.repo.saveStack(to)
      const withdrawalId = uuid()
      const depositId = uuid()
      const base = { accountId, originType: 'CUSTOMER' as const, customerId: input.customerId, notes: input.description ?? undefined, transactionTime: now }
      const withdrawal = this.record({ ...base, id: withdrawalId, stackId: from.id, amount: -cents, counterpartTransactionId: depositId })
      const deposit = this.record({ ...base, id: depositId, stackId: to.id, amount: cents, counterpartTransactionId: withdrawalId })
      this.repo.insertTransaction(withdrawal)
      this.repo.insertTransaction(deposit)
      if (a.status === 'APPROVED' || a.status === 'DORMANT') this.ctx.services.accounts.setStatus(accountId, 'ACTIVE', { actionOwner: 'PLATFORM' })
      return [withdrawal, deposit]
    })()
    this.ctx.events.emit('stack.transactionPosted', { transaction: withdrawal, stack: structuredClone(from) })
    this.ctx.events.emit('stack.transactionPosted', { transaction: deposit, stack: structuredClone(to) })
    return { outcome: 'ACCEPTED', withdrawalTransactionId: withdrawal.id, depositTransactionId: deposit.id }
  }

  /**
   * Platform round-up (no B2B operation creates these; a hook for the utilities / test tooling): account
   * -> stack as a ROUND_UP record by TRANSACTION origin, gated and accounted like transferIn.
   */
  roundUp(accountId: string, stackId: string, amountCents: Cents, opts: { originId?: string } = {}): StackMoveResult {
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw badRequest('BAD_REQUEST: amountCents must be a positive integer')
    const s = this.get(accountId, stackId)
    this.requireOpenForMovement(accountId)
    this.requireOpenStack(s)
    const accounts = this.ctx.services.accounts
    if (accounts.checkFunds(accountId, amountCents)) return { outcome: 'REFUSED_INSUFFICIENT_FUNDS' }
    const t = this.ctx.db.transaction(() => {
      accounts.adjust(accountId, { stacksDelta: amountCents })
      s.balance += amountCents
      s.updatedAt = isoUtc(this.ctx.clock.now())
      this.repo.saveStack(s)
      const t = this.record({ accountId, stackId: s.id, amount: amountCents, originType: 'TRANSACTION', originId: opts.originId, type: 'ROUND_UP', notes: 'Round up' })
      this.repo.insertTransaction(t)
      return t
    })()
    this.ctx.events.emit('stack.transactionPosted', { transaction: t, stack: structuredClone(s) })
    return { outcome: 'ACCEPTED', transactionId: t.id }
  }

  // ---------------------------------------------------------------- guards

  private record(t: Partial<StackTransaction> & Pick<StackTransaction, 'accountId' | 'stackId' | 'amount' | 'originType'>): StackTransaction {
    return compact({ id: uuid(), type: 'STANDARD' as const, transactionTime: isoUtc(this.ctx.clock.now()), ...t })
  }

  private requireNotClosed(accountId: string): Account {
    const a = this.ctx.services.accounts.get(accountId)
    if (a.status === 'CLOSED') throw unprocessable(`ACCOUNT_CLOSED: Account ${accountId} is CLOSED`)
    return a
  }

  /** LOCKED / CLOSED accounts refuse stack movements; the outcome enums have no value for it, so 422 (00-balance S1). */
  private requireOpenForMovement(accountId: string): Account {
    const r = this.ctx.services.accounts.requireOpenForMovement(accountId)
    if (r === 'REFUSED_ACCOUNT_BLOCKED') throw unprocessable(`ACCOUNT_BLOCKED: Account ${accountId} is LOCKED`)
    if (r === 'REFUSED_ACCOUNT_CLOSED') throw unprocessable(`ACCOUNT_CLOSED: Account ${accountId} is CLOSED`)
    return r
  }

  private requireOpen(accountId: string, stackId: string): Stack {
    return this.requireOpenStack(this.get(accountId, stackId))
  }

  private requireOpenStack(s: Stack): Stack {
    if (s.status !== 'OPEN') throw unprocessable(`STACK_CLOSED: Stack ${s.id} is CLOSED and can no longer be used`)
    return s
  }

  /** The initiating customer must exist (404) and hold the account: the holder, or a member of the holding group (422). */
  private requireHolder(accountId: string, customerId: string): void {
    this.ctx.services.customers.get(customerId)
    if (!this.ctx.services.accounts.holderCustomerIds(this.ctx.services.accounts.get(accountId)).includes(customerId)) {
      throw unprocessable(`PERMISSION_DENIED: Customer ${customerId} does not hold account ${accountId}`)
    }
  }

  private validateName(name: string): void {
    if (EMOJI_RE.test(name)) throw unprocessable('INVALID_ARGUMENT: Stack names cannot contain emojis')
  }

  /** targetAmount: <= 2 dp (400); at most the account's MAX_BALANCE limit (account override, else product) (422). */
  private targetCents(a: Account, amount: number | null | undefined): Cents | undefined {
    if (amount === undefined || amount === null) return undefined
    const cents = requestCents(amount, 'targetAmount', { allowZero: true })
    const row = this.ctx.services.accounts.limits(a.id).find((l) => l.type === 'MAX_BALANCE')
    const cap = row ? toCents(row.accountLimit ?? row.productLimit ?? 0) : undefined
    if (cap !== undefined && cents > cap) throw unprocessable(`INVALID_ARGUMENT: targetAmount ${fromCents(cents)} exceeds the account's MAX_BALANCE limit ${fromCents(cap)}`)
    return cents
  }
}

export type { Group, GroupType, BusinessIdentifiers, Stack, StackStatus, StackTransaction, StackTransactionType, StackOriginType } from './repo.js'
