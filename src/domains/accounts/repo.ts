/**
 * SQL for accounts, account_limits and account_rules: rows <-> entities.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import { json, nextSeq, type Db } from '../../db/index.js'
import type { Cents } from '../../lib/money.js'
import type { LimitType } from './products.js'

export type AccountStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'ACTIVE' | 'LOCKED' | 'DORMANT' | 'CLOSED' | 'ACTIVE_IN_ARREARS'
export type HolderType = 'CUSTOMER' | 'GROUP'
export type BlockedBy = 'CLIENT' | 'PLATFORM'
export type RiskLevel = 'HIGH' | 'LOW'
export type CloseReason = 'SUSPICIOUS' | 'DECEASED' | 'CUSTOMER' | 'OPERATIONAL'
export type RuleType = 'MERCHANT_CODE_BLOCK' | 'MERCHANT_ID_BLOCK' | 'MERCHANT_NAME_BLOCK'
export type RuleDetails = components['schemas']['RuleDetails']

export interface Account {
  id: string
  holderType: HolderType
  holderId: string
  productId: string
  accountNumber: string
  bsb: string
  currency: string
  status: AccountStatus
  blockedBy?: BlockedBy
  blockNote?: string
  /** Customers held BLOCKED by this account's block; released when the last LOCKED account holding them is unblocked. */
  blockedCustomerIds?: string[]
  parentAccountId?: string
  /** undefined = no custom data stored; null = explicitly cleared / null */
  customData?: Record<string, unknown> | null
  ledger: Cents
  held: Cents
  locked: Cents
  stacks: Cents
  overdraftLimit: Cents
  riskLevel: RiskLevel
  copOptOut: boolean
  closeReason?: CloseReason
  createdAt: string
  closedAt?: string
  updatedAt?: string
}

export interface AccountRule {
  id: string
  accountId: string
  name: string
  ruleType: RuleType
  ruleDetails: RuleDetails
  ownerId: string
  disabled: boolean
  expiresAt?: string
  createdAt: string
}

export class AccountRepo {
  constructor(private readonly db: Db) {}

  nextAccountSeq(): number {
    return nextSeq(this.db, 'account')
  }

  insert(a: Account): void {
    const r = toRow(a)
    const cols = Object.keys(r)
    this.db.prepare(`INSERT INTO accounts(seq, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(nextSeq(this.db, 'account-row'), ...cols.map((k) => r[k]))
  }

  save(a: Account): void {
    const r = toRow(a)
    const cols = Object.keys(r).filter((k) => k !== 'id')
    this.db.prepare(`UPDATE accounts SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => r[k]), a.id)
  }

  byId(id: string): Account | undefined {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined
    return r ? fromRow(r) : undefined
  }

  byAccountNumber(accountNumber: string): Account[] {
    return (this.db.prepare('SELECT * FROM accounts WHERE account_number = ? ORDER BY seq ASC').all(accountNumber) as Row[]).map(fromRow)
  }

  accountNumberExists(accountNumber: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM accounts WHERE account_number = ?').get(accountNumber)
  }

  byHolder(holderId: string, holderType?: HolderType): Account[] {
    const sql = holderType
      ? 'SELECT * FROM accounts WHERE holder_id = ? AND holder_type = ? ORDER BY seq ASC'
      : 'SELECT * FROM accounts WHERE holder_id = ? ORDER BY seq ASC'
    const args = holderType ? [holderId, holderType] : [holderId]
    return (this.db.prepare(sql).all(...args) as Row[]).map(fromRow)
  }

  children(parentId: string): Account[] {
    return (this.db.prepare('SELECT * FROM accounts WHERE parent_account_id = ? ORDER BY seq ASC').all(parentId) as Row[]).map(fromRow)
  }

  /** LOCKED accounts whose block transitioned the given customer (blocked_customer_ids contains it), creation order. */
  lockedBlockersOf(customerId: string): Account[] {
    return (this.db
      .prepare(`SELECT a.* FROM accounts a WHERE a.status = 'LOCKED' AND a.blocked_customer_ids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(a.blocked_customer_ids) WHERE json_each.value = ?) ORDER BY a.seq ASC`)
      .all(customerId) as Row[]).map(fromRow)
  }

  /** Non-CLOSED accounts held by any of the given holder ids (customer id and/or group ids). */
  countOpenForHolders(holderIds: string[]): number {
    if (!holderIds.length) return 0
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE status != 'CLOSED' AND holder_id IN (${holderIds.map(() => '?').join(', ')})`)
      .get(...holderIds) as { n: number }
    return row.n
  }

  // --- limits ---

  limitOverrides(accountId: string): Partial<Record<LimitType, Cents>> {
    const rows = this.db.prepare('SELECT limit_type, amount FROM account_limits WHERE account_id = ?').all(accountId) as { limit_type: LimitType; amount: number }[]
    const out: Partial<Record<LimitType, Cents>> = {}
    for (const r of rows) out[r.limit_type] = r.amount
    return out
  }

  setLimitOverride(accountId: string, type: LimitType, amount: Cents, now: string): void {
    this.db
      .prepare('INSERT INTO account_limits(account_id, limit_type, amount, updated_at) VALUES (?,?,?,?) ON CONFLICT(account_id, limit_type) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at')
      .run(accountId, type, amount, now)
  }

  deleteLimitOverride(accountId: string, type: LimitType): boolean {
    return this.db.prepare('DELETE FROM account_limits WHERE account_id = ? AND limit_type = ?').run(accountId, type).changes > 0
  }

  // --- rules ---

  insertRule(r: AccountRule): void {
    this.db
      .prepare('INSERT INTO account_rules(id, seq, account_id, name, rule_type, rule_details, owner_id, disabled, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(r.id, nextSeq(this.db, 'account-rule'), r.accountId, r.name, r.ruleType, JSON.stringify(r.ruleDetails), r.ownerId, r.disabled ? 1 : 0, r.expiresAt ?? null, r.createdAt)
  }

  ruleById(id: string): AccountRule | undefined {
    const r = this.db.prepare('SELECT * FROM account_rules WHERE id = ?').get(id) as Row | undefined
    return r ? ruleFromRow(r) : undefined
  }

  rulesForAccount(accountId: string): AccountRule[] {
    return (this.db.prepare('SELECT * FROM account_rules WHERE account_id = ? ORDER BY seq ASC').all(accountId) as Row[]).map(ruleFromRow)
  }

  disableRule(id: string): void {
    this.db.prepare('UPDATE account_rules SET disabled = 1 WHERE id = ?').run(id)
  }
}

type Row = Record<string, unknown>

function toRow(a: Account): Row {
  return {
    id: a.id,
    holder_type: a.holderType,
    holder_id: a.holderId,
    product_id: a.productId,
    account_number: a.accountNumber,
    bsb: a.bsb,
    currency: a.currency,
    status: a.status,
    blocked_by: a.blockedBy ?? null,
    block_note: a.blockNote ?? null,
    blocked_customer_ids: json.stringify(a.blockedCustomerIds),
    parent_account_id: a.parentAccountId ?? null,
    custom_data: a.customData === undefined ? null : JSON.stringify(a.customData),
    ledger: a.ledger,
    held: a.held,
    locked: a.locked,
    stacks: a.stacks,
    overdraft_limit: a.overdraftLimit,
    risk_level: a.riskLevel,
    cop_opt_out: a.copOptOut ? 1 : 0,
    close_reason: a.closeReason ?? null,
    created_at: a.createdAt,
    closed_at: a.closedAt ?? null,
    updated_at: a.updatedAt ?? null,
  }
}

function fromRow(r: Row): Account {
  const a: Account = {
    id: r.id as string,
    holderType: r.holder_type as HolderType,
    holderId: r.holder_id as string,
    productId: r.product_id as string,
    accountNumber: r.account_number as string,
    bsb: r.bsb as string,
    currency: r.currency as string,
    status: r.status as AccountStatus,
    ledger: r.ledger as number,
    held: r.held as number,
    locked: r.locked as number,
    stacks: r.stacks as number,
    overdraftLimit: r.overdraft_limit as number,
    riskLevel: r.risk_level as RiskLevel,
    copOptOut: r.cop_opt_out === 1,
    createdAt: r.created_at as string,
  }
  if (r.custom_data !== null && r.custom_data !== undefined) a.customData = JSON.parse(r.custom_data as string) as Record<string, unknown> | null
  const blocked = json.parse<string[]>(r.blocked_customer_ids as string | null)
  if (blocked !== undefined) a.blockedCustomerIds = blocked
  const opt: [keyof Account, unknown][] = [
    ['blockedBy', r.blocked_by], ['blockNote', r.block_note], ['parentAccountId', r.parent_account_id], ['closeReason', r.close_reason],
    ['closedAt', r.closed_at], ['updatedAt', r.updated_at],
  ]
  for (const [k, v] of opt) if (v !== null && v !== undefined) (a as unknown as Record<string, unknown>)[k] = v
  return a
}

function ruleFromRow(r: Row): AccountRule {
  const rule: AccountRule = {
    id: r.id as string,
    accountId: r.account_id as string,
    name: r.name as string,
    ruleType: r.rule_type as RuleType,
    ruleDetails: JSON.parse(r.rule_details as string) as RuleDetails,
    ownerId: r.owner_id as string,
    disabled: r.disabled === 1,
    createdAt: r.created_at as string,
  }
  if (r.expires_at !== null && r.expires_at !== undefined) rule.expiresAt = r.expires_at as string
  return rule
}
