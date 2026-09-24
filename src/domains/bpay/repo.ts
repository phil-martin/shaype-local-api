/**
 * SQL for bpay_billers: rows <-> SavedBiller entities, per-account listing and the uniqueness lookups.
 */
import { nextSeq, type Db } from '../../db/index.js'

export type BillerStatus = 'ACTIVE' | 'DISMISSED'

export interface SavedBiller {
  id: string
  accountId: string
  billerCode: string
  reference: string
  name: string
  image?: string
  shortName: string
  longName: string
  industryAnzsicCode: string
  status: BillerStatus
  createdAt: string
  updatedAt?: string
}

export interface Page { offset: number; limit: number }

type Row = Record<string, unknown>

export class BpayRepo {
  constructor(private readonly db: Db) {}

  insert(b: SavedBiller): void {
    this.db
      .prepare(
        `INSERT INTO bpay_billers(id, seq, account_id, biller_code, reference, name, image, short_name, long_name, industry_anzsic_code, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(b.id, nextSeq(this.db, 'bpay-biller'), b.accountId, b.billerCode, b.reference, b.name, b.image ?? null, b.shortName, b.longName, b.industryAnzsicCode, b.status, b.createdAt, b.updatedAt ?? null)
  }

  save(b: SavedBiller): void {
    this.db
      .prepare('UPDATE bpay_billers SET reference = ?, name = ?, image = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(b.reference, b.name, b.image ?? null, b.status, b.updatedAt ?? null, b.id)
  }

  byId(id: string): SavedBiller | undefined {
    const r = this.db.prepare('SELECT * FROM bpay_billers WHERE id = ?').get(id) as Row | undefined
    return r ? fromRow(r) : undefined
  }

  /** Non-dismissed billers of an account, creation order, paged. */
  activeForAccount(accountId: string, page: Page): SavedBiller[] {
    return (this.db
      .prepare(`SELECT * FROM bpay_billers WHERE account_id = ? AND status = 'ACTIVE' ORDER BY seq ASC LIMIT ? OFFSET ?`)
      .all(accountId, page.limit, page.offset) as Row[]).map(fromRow)
  }

  /** The active biller of the account saved under the same (billerCode, reference) pair, other than `exceptId`. */
  activeByCodeAndReference(accountId: string, billerCode: string, reference: string, exceptId?: string): SavedBiller | undefined {
    const r = this.db
      .prepare(`SELECT * FROM bpay_billers WHERE account_id = ? AND status = 'ACTIVE' AND biller_code = ? AND reference = ? AND id <> ? LIMIT 1`)
      .get(accountId, billerCode, reference, exceptId ?? '') as Row | undefined
    return r ? fromRow(r) : undefined
  }

  /** The active biller of the account with the same nickname (case-insensitive), other than `exceptId`. */
  activeByName(accountId: string, name: string, exceptId?: string): SavedBiller | undefined {
    const r = this.db
      .prepare(`SELECT * FROM bpay_billers WHERE account_id = ? AND status = 'ACTIVE' AND name = ? COLLATE NOCASE AND id <> ? LIMIT 1`)
      .get(accountId, name, exceptId ?? '') as Row | undefined
    return r ? fromRow(r) : undefined
  }
}

function fromRow(r: Row): SavedBiller {
  const b: SavedBiller = {
    id: r.id as string,
    accountId: r.account_id as string,
    billerCode: r.biller_code as string,
    reference: r.reference as string,
    name: r.name as string,
    shortName: r.short_name as string,
    longName: r.long_name as string,
    industryAnzsicCode: r.industry_anzsic_code as string,
    status: r.status as BillerStatus,
    createdAt: r.created_at as string,
  }
  if (r.image != null) b.image = r.image as string
  if (r.updated_at != null) b.updatedAt = r.updated_at as string
  return b
}
