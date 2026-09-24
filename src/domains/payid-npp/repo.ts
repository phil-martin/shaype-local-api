/**
 * SQL for payids and payid_deregistrations: rows <-> entities, lookups by value / account, timers.
 */
import { nextSeq, type Db } from '../../db/index.js'

export type PayIdType = 'EMAIL' | 'TELEPHONE' | 'INDIVIDUAL_AUSTRALIAN_BUSINESS' | 'ORGANISATION'
export type PayIdStatus = 'ACTIVE' | 'DEREGISTERED' | 'DISABLED' | 'PORTABLE'
export type PayIdReason = 'FROD' | 'CUST' | 'DECD' | 'LEGL' | 'PART'

export const PAY_ID_TYPES: readonly PayIdType[] = ['EMAIL', 'TELEPHONE', 'INDIVIDUAL_AUSTRALIAN_BUSINESS', 'ORGANISATION']
export const PAY_ID_STATUSES: readonly PayIdStatus[] = ['ACTIVE', 'DEREGISTERED', 'DISABLED', 'PORTABLE']
export const PAY_ID_REASONS: readonly PayIdReason[] = ['FROD', 'CUST', 'DECD', 'LEGL', 'PART']

export interface PayId {
  id: string
  value: string
  type: PayIdType
  accountId: string
  status: PayIdStatus
  reason?: PayIdReason
  payIdName: string
  ownerName: string
  registeredAt: string
  updatedAt: string
  lastResolvedAt?: string
  portableSince?: string
  deregisteredAt?: string
}

export interface Deregistration {
  id: string
  payIdId: string
  value: string
  type: PayIdType
  accountId: string
  payIdName: string
  reason?: PayIdReason
  registeredAt: string
  deregisteredAt: string
}

interface Row {
  id: string
  seq: number
  pay_id_value: string
  pay_id_type: PayIdType
  account_id: string
  status: PayIdStatus
  reason: PayIdReason | null
  pay_id_name: string
  owner_name: string
  registered_at: string
  updated_at: string
  last_resolved_at: string | null
  portable_since: string | null
  deregistered_at: string | null
}

interface DeregRow {
  id: string
  seq: number
  pay_id_id: string
  pay_id_value: string
  pay_id_type: PayIdType
  account_id: string
  pay_id_name: string
  reason: PayIdReason | null
  registered_at: string
  deregistered_at: string
}

/** Lookup priority when several rows share a value: the live one first (ACTIVE, PORTABLE, DISABLED), then the latest DEREGISTERED. */
const STATUS_RANK = `CASE status WHEN 'ACTIVE' THEN 0 WHEN 'PORTABLE' THEN 1 WHEN 'DISABLED' THEN 2 ELSE 3 END`

export class PayIdRepo {
  constructor(private readonly db: Db) {}

  insert(p: PayId): void {
    const r = toRow(p)
    const cols = Object.keys(r)
    this.db.prepare(`INSERT INTO payids(seq, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(nextSeq(this.db, 'payid'), ...cols.map((k) => r[k]))
  }

  save(p: PayId): void {
    const r = toRow(p)
    const cols = Object.keys(r).filter((k) => k !== 'id')
    this.db.prepare(`UPDATE payids SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => r[k]), p.id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM payids WHERE id = ?').run(id)
  }

  byId(id: string): PayId | undefined {
    const r = this.db.prepare('SELECT * FROM payids WHERE id = ?').get(id) as Row | undefined
    return r ? fromRow(r) : undefined
  }

  /**
   * The record a value currently denotes: the live row for (value, type) when one exists, otherwise
   * the most recent DEREGISTERED one. Without a type, the same priority across every type.
   */
  current(value: string, type?: PayIdType): PayId | undefined {
    const r = (type
      ? this.db.prepare(`SELECT * FROM payids WHERE pay_id_value = ? COLLATE NOCASE AND pay_id_type = ? ORDER BY ${STATUS_RANK}, seq DESC LIMIT 1`).get(value, type)
      : this.db.prepare(`SELECT * FROM payids WHERE pay_id_value = ? COLLATE NOCASE ORDER BY ${STATUS_RANK}, seq DESC LIMIT 1`).get(value)) as Row | undefined
    return r ? fromRow(r) : undefined
  }

  /** The non-DEREGISTERED row for (value, type), if any. */
  live(value: string, type: PayIdType): PayId | undefined {
    const r = this.db.prepare(`SELECT * FROM payids WHERE pay_id_value = ? COLLATE NOCASE AND pay_id_type = ? AND status <> 'DEREGISTERED' LIMIT 1`).get(value, type) as Row | undefined
    return r ? fromRow(r) : undefined
  }

  /** Every row linked to the account (all statuses), registration order. */
  byAccount(accountId: string): PayId[] {
    return (this.db.prepare('SELECT * FROM payids WHERE account_id = ? ORDER BY seq').all(accountId) as Row[]).map(fromRow)
  }

  /** Live rows on the given accounts (owner-name propagation). */
  liveByAccounts(accountIds: string[]): PayId[] {
    if (!accountIds.length) return []
    const marks = accountIds.map(() => '?').join(', ')
    return (this.db.prepare(`SELECT * FROM payids WHERE account_id IN (${marks}) AND status <> 'DEREGISTERED' ORDER BY seq`).all(...accountIds) as Row[]).map(fromRow)
  }

  /** PORTABLE rows whose portability started at or before `cutoff` (ISO strings compare lexicographically). */
  portableSince(cutoff: string): PayId[] {
    return (this.db.prepare(`SELECT * FROM payids WHERE status = 'PORTABLE' AND coalesce(portable_since, updated_at) <= ? ORDER BY seq`).all(cutoff) as Row[]).map(fromRow)
  }

  /** DEREGISTERED rows deregistered at or before `cutoff`. */
  deregisteredSince(cutoff: string): PayId[] {
    return (this.db.prepare(`SELECT * FROM payids WHERE status = 'DEREGISTERED' AND coalesce(deregistered_at, updated_at) <= ? ORDER BY seq`).all(cutoff) as Row[]).map(fromRow)
  }

  /** ACTIVE rows whose last activity (registration, update or resolution) is at or before `cutoff`. */
  inactiveSince(cutoff: string): PayId[] {
    return (this.db.prepare(`SELECT * FROM payids WHERE status = 'ACTIVE' AND max(registered_at, updated_at, coalesce(last_resolved_at, '')) <= ? ORDER BY seq`).all(cutoff) as Row[]).map(fromRow)
  }

  insertDeregistration(d: Deregistration): void {
    this.db
      .prepare('INSERT INTO payid_deregistrations(id, seq, pay_id_id, pay_id_value, pay_id_type, account_id, pay_id_name, reason, registered_at, deregistered_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(d.id, nextSeq(this.db, 'payid-dereg'), d.payIdId, d.value, d.type, d.accountId, d.payIdName, d.reason ?? null, d.registeredAt, d.deregisteredAt)
  }

  /** De-register history of a value across every type, oldest first. */
  deregistrations(value: string): Deregistration[] {
    const rows = this.db.prepare('SELECT * FROM payid_deregistrations WHERE pay_id_value = ? COLLATE NOCASE ORDER BY seq').all(value) as DeregRow[]
    return rows.map((r) => ({
      id: r.id,
      payIdId: r.pay_id_id,
      value: r.pay_id_value,
      type: r.pay_id_type,
      accountId: r.account_id,
      payIdName: r.pay_id_name,
      reason: r.reason ?? undefined,
      registeredAt: r.registered_at,
      deregisteredAt: r.deregistered_at,
    }))
  }
}

function toRow(p: PayId): Record<string, unknown> {
  return {
    id: p.id,
    pay_id_value: p.value,
    pay_id_type: p.type,
    account_id: p.accountId,
    status: p.status,
    reason: p.reason ?? null,
    pay_id_name: p.payIdName,
    owner_name: p.ownerName,
    registered_at: p.registeredAt,
    updated_at: p.updatedAt,
    last_resolved_at: p.lastResolvedAt ?? null,
    portable_since: p.portableSince ?? null,
    deregistered_at: p.deregisteredAt ?? null,
  }
}

function fromRow(r: Row): PayId {
  const p: PayId = {
    id: r.id,
    value: r.pay_id_value,
    type: r.pay_id_type,
    accountId: r.account_id,
    status: r.status,
    payIdName: r.pay_id_name,
    ownerName: r.owner_name,
    registeredAt: r.registered_at,
    updatedAt: r.updated_at,
  }
  if (r.reason) p.reason = r.reason
  if (r.last_resolved_at) p.lastResolvedAt = r.last_resolved_at
  if (r.portable_since) p.portableSince = r.portable_since
  if (r.deregistered_at) p.deregisteredAt = r.deregistered_at
  return p
}
