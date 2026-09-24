/**
 * SQL for groups, group_members, stacks and stack_transactions: rows <-> entities.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import { nextSeq, type Db } from '../../db/index.js'
import type { Cents } from '../../lib/money.js'

export type GroupType = 'PERSONAL' | 'BUSINESS'
export type BusinessIdentifiers = components['schemas']['BusinessIdentifiers']
export type StackStatus = 'OPEN' | 'CLOSED'
export type StackTransactionType = 'STANDARD' | 'ROUND_UP'
export type StackOriginType = 'CUSTOMER' | 'SCHEDULED_PAYMENT' | 'HAAS_OPERATIONS' | 'OPERATIONS' | 'MANDATE_PAYMENT' | 'DIRECT_DEBIT' | 'TRANSACTION'

export interface Group {
  id: string
  name: string
  groupType: GroupType
  businessIdentifiers?: BusinessIdentifiers
  /** Member customer ids in join order. */
  customerHayIds: string[]
  createdAt: string
  updatedAt?: string
}

export interface Stack {
  id: string
  accountId: string
  name: string
  imageUrl?: string
  targetAmount?: Cents
  balance: Cents
  status: StackStatus
  createdAt: string
  closedAt?: string
  updatedAt?: string
}

export interface StackTransaction {
  id: string
  accountId: string
  stackId: string
  /** Signed cents from the stack's perspective: deposit > 0, withdrawal < 0. */
  amount: Cents
  customerId?: string
  notes?: string
  counterpartTransactionId?: string
  originId?: string
  originType: StackOriginType
  type: StackTransactionType
  transactionTime: string
}

export interface StackTransactionFilter {
  accountId: string
  stackId?: string
  type?: StackTransactionType
  offset: number
  limit: number
}

type Row = Record<string, unknown>

export class GroupsStacksRepo {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- groups

  nextGroupSeq(): number {
    return nextSeq(this.db, 'group')
  }

  insertGroup(g: Group, seq: number): void {
    this.db
      .prepare('INSERT INTO groups(id, seq, name, group_type, business_identifiers, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(g.id, seq, g.name, g.groupType, g.businessIdentifiers === undefined ? null : JSON.stringify(g.businessIdentifiers), g.createdAt, g.updatedAt ?? null)
    for (const cid of g.customerHayIds) this.addMember(g.id, cid)
  }

  saveGroup(g: Group): void {
    this.db
      .prepare('UPDATE groups SET name = ?, group_type = ?, business_identifiers = ?, updated_at = ? WHERE id = ?')
      .run(g.name, g.groupType, g.businessIdentifiers === undefined ? null : JSON.stringify(g.businessIdentifiers), g.updatedAt ?? null, g.id)
  }

  groupById(id: string): Group | undefined {
    const r = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as Row | undefined
    return r ? this.groupFromRow(r) : undefined
  }

  memberIds(groupId: string): string[] {
    return (this.db.prepare('SELECT customer_id FROM group_members WHERE group_id = ? ORDER BY seq ASC').all(groupId) as { customer_id: string }[]).map((r) => r.customer_id)
  }

  isMember(groupId: string, customerId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND customer_id = ?').get(groupId, customerId)
  }

  /** Ids of the groups the customer belongs to, in group creation order. */
  groupIdsForCustomer(customerId: string): string[] {
    return (this.db
      .prepare('SELECT m.group_id FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.customer_id = ? ORDER BY g.seq ASC')
      .all(customerId) as { group_id: string }[]).map((r) => r.group_id)
  }

  addMember(groupId: string, customerId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO group_members(group_id, customer_id, seq) VALUES (?,?,?)').run(groupId, customerId, nextSeq(this.db, 'group-member'))
  }

  removeMember(groupId: string, customerId: string): boolean {
    return this.db.prepare('DELETE FROM group_members WHERE group_id = ? AND customer_id = ?').run(groupId, customerId).changes > 0
  }

  private groupFromRow(r: Row): Group {
    const g: Group = {
      id: r.id as string,
      name: r.name as string,
      groupType: r.group_type as GroupType,
      customerHayIds: this.memberIds(r.id as string),
      createdAt: r.created_at as string,
    }
    if (r.business_identifiers !== null && r.business_identifiers !== undefined) g.businessIdentifiers = JSON.parse(r.business_identifiers as string) as BusinessIdentifiers
    if (r.updated_at !== null && r.updated_at !== undefined) g.updatedAt = r.updated_at as string
    return g
  }

  // ---------------------------------------------------------------- stacks

  insertStack(s: Stack): void {
    this.db
      .prepare('INSERT INTO stacks(id, seq, account_id, name, image_url, target_amount, balance, status, created_at, closed_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(s.id, nextSeq(this.db, 'stack'), s.accountId, s.name, s.imageUrl ?? null, s.targetAmount ?? null, s.balance, s.status, s.createdAt, s.closedAt ?? null, s.updatedAt ?? null)
  }

  saveStack(s: Stack): void {
    this.db
      .prepare('UPDATE stacks SET name = ?, image_url = ?, target_amount = ?, balance = ?, status = ?, closed_at = ?, updated_at = ? WHERE id = ?')
      .run(s.name, s.imageUrl ?? null, s.targetAmount ?? null, s.balance, s.status, s.closedAt ?? null, s.updatedAt ?? null, s.id)
  }

  stackById(id: string): Stack | undefined {
    const r = this.db.prepare('SELECT * FROM stacks WHERE id = ?').get(id) as Row | undefined
    return r ? stackFromRow(r) : undefined
  }

  /** Stacks of the account in creation order; OPEN only unless `includeClosed`. */
  stacksForAccount(accountId: string, includeClosed: boolean): Stack[] {
    const sql = includeClosed
      ? 'SELECT * FROM stacks WHERE account_id = ? ORDER BY seq ASC'
      : `SELECT * FROM stacks WHERE account_id = ? AND status = 'OPEN' ORDER BY seq ASC`
    return (this.db.prepare(sql).all(accountId) as Row[]).map(stackFromRow)
  }

  /** An OPEN stack of the account with exactly this name (other than `excludeId`). */
  openStackNamed(accountId: string, name: string, excludeId?: string): Stack | undefined {
    const r = this.db
      .prepare(`SELECT * FROM stacks WHERE account_id = ? AND status = 'OPEN' AND name = ? AND id != ? LIMIT 1`)
      .get(accountId, name, excludeId ?? '') as Row | undefined
    return r ? stackFromRow(r) : undefined
  }

  // ---------------------------------------------------------------- stack transactions

  insertTransaction(t: StackTransaction): void {
    this.db
      .prepare('INSERT INTO stack_transactions(id, seq, account_id, stack_id, amount, customer_id, notes, counterpart_transaction_id, origin_id, origin_type, type, transaction_time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(t.id, nextSeq(this.db, 'stack-transaction'), t.accountId, t.stackId, t.amount, t.customerId ?? null, t.notes ?? null, t.counterpartTransactionId ?? null, t.originId ?? null, t.originType, t.type, t.transactionTime)
  }

  transactionById(id: string): StackTransaction | undefined {
    const r = this.db.prepare('SELECT * FROM stack_transactions WHERE id = ?').get(id) as Row | undefined
    return r ? transactionFromRow(r) : undefined
  }

  /** Posting (= creation) order, oldest first (spec §4: no sortBy -> creation time ascending), paged. */
  transactions(f: StackTransactionFilter): StackTransaction[] {
    const where = ['account_id = ?']
    const args: unknown[] = [f.accountId]
    if (f.stackId) { where.push('stack_id = ?'); args.push(f.stackId) }
    if (f.type) { where.push('type = ?'); args.push(f.type) }
    args.push(f.limit, f.offset)
    return (this.db
      .prepare(`SELECT * FROM stack_transactions WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ? OFFSET ?`)
      .all(...args) as Row[]).map(transactionFromRow)
  }
}

function stackFromRow(r: Row): Stack {
  const s: Stack = {
    id: r.id as string,
    accountId: r.account_id as string,
    name: r.name as string,
    balance: r.balance as number,
    status: r.status as StackStatus,
    createdAt: r.created_at as string,
  }
  const opt: [keyof Stack, unknown][] = [['imageUrl', r.image_url], ['targetAmount', r.target_amount], ['closedAt', r.closed_at], ['updatedAt', r.updated_at]]
  for (const [k, v] of opt) if (v !== null && v !== undefined) (s as unknown as Record<string, unknown>)[k] = v
  return s
}

function transactionFromRow(r: Row): StackTransaction {
  const t: StackTransaction = {
    id: r.id as string,
    accountId: r.account_id as string,
    stackId: r.stack_id as string,
    amount: r.amount as number,
    originType: r.origin_type as StackOriginType,
    type: r.type as StackTransactionType,
    transactionTime: r.transaction_time as string,
  }
  const opt: [keyof StackTransaction, unknown][] = [
    ['customerId', r.customer_id], ['notes', r.notes], ['counterpartTransactionId', r.counterpart_transaction_id], ['originId', r.origin_id],
  ]
  for (const [k, v] of opt) if (v !== null && v !== undefined) (t as unknown as Record<string, unknown>)[k] = v
  return t
}
