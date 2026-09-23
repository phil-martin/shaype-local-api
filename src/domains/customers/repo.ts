/**
 * SQL for the customers table: rows <-> Customer entities, paging, search and the uniqueness lookup.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import { json, nextSeq, type Db } from '../../db/index.js'

export type CustomerStatus = 'ACTIVE' | 'INACTIVE' | 'REJECTED' | 'BLOCKED' | 'PENDING_APPROVAL' | 'REFERRED'
export type StatusReason = 'SUSPICIOUS' | 'DECEASED' | 'CUSTOMER' | 'OPERATIONAL'
export type BlockedBy = 'CLIENT' | 'PLATFORM'
export type Tier = 'FOUNDER' | 'STANDARD' | 'PREMIUM'
export type Address = components['schemas']['Address']
export type PhoneNumber = components['schemas']['PhoneNumber']
export type CustomerDetails = components['schemas']['CustomerDetails']
export type TaxObligation = components['schemas']['TaxObligation']

export interface IdentityDocument {
  type?: 'DRIVING_LICENSE' | 'PASSPORT'
  number?: string
  cardNumber?: string
  expiry?: string
  issuingCountry?: string
  region?: string
}

export interface Customer {
  id: string
  status: CustomerStatus
  statusReason?: StatusReason
  blockedBy?: BlockedBy
  tier: Tier
  email: string
  phoneNumber: PhoneNumber
  address: Address
  customerDetails: CustomerDetails
  customData?: Record<string, unknown> | null
  externalCustomerId?: string
  deviceId: string
  identityDocument: IdentityDocument
  identityVerificationCaseId?: string
  skipKyc: boolean
  onlySanctionsCheck: boolean
  taxObligations?: TaxObligation[]
  blockNote?: string
  createdAt: string
  approvedAt?: string
  closedAt?: string
  updatedAt?: string
}

export interface Page { offset: number; limit: number }

export interface SearchFilters {
  customerIds?: string[]
  dateOfBirth?: string
  email?: string
  firstName?: string
  lastName?: string
  phoneNumber?: PhoneNumber
  status?: CustomerStatus
}

export type DuplicateRule = 'email' | 'phone number' | 'identity document' | 'name and date of birth'

/** Customers that take part in the uniqueness checks: everyone except those closed at the customer's or the client's request. */
const LIVE = `NOT (status = 'INACTIVE' AND (status_reason IS NULL OR status_reason IN ('CUSTOMER', 'OPERATIONAL')))`

/** countryCodePrefix is stored and rendered without its leading '+' (docs sample: "+61" in, "61" out). */
export function normalizePhone(p: PhoneNumber): PhoneNumber {
  return { countryCodePrefix: p.countryCodePrefix.replace(/^\++/, ''), numberAfterPrefix: p.numberAfterPrefix }
}

export class CustomerRepo {
  constructor(private readonly db: Db) {}

  insert(c: Customer): void {
    const r = toRow(c)
    const cols = Object.keys(r)
    this.db.prepare(`INSERT INTO customers(seq, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(nextSeq(this.db, 'customer'), ...cols.map((k) => r[k]))
  }

  save(c: Customer): void {
    const r = toRow(c)
    const cols = Object.keys(r).filter((k) => k !== 'id')
    this.db.prepare(`UPDATE customers SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => r[k]), c.id)
  }

  byId(id: string): Customer | undefined {
    const r = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Row | undefined
    return r ? fromRow(r) : undefined
  }

  list(page: Page): Customer[] {
    return (this.db.prepare('SELECT * FROM customers ORDER BY seq ASC LIMIT ? OFFSET ?').all(page.limit, page.offset) as Row[]).map(fromRow)
  }

  search(f: SearchFilters, page: Page): Customer[] {
    const where: string[] = []
    const args: unknown[] = []
    if (f.customerIds?.length) { where.push(`id IN (${f.customerIds.map(() => '?').join(', ')})`); args.push(...f.customerIds) }
    if (f.email !== undefined) { where.push('email = ? COLLATE NOCASE'); args.push(f.email) }
    if (f.firstName !== undefined) { where.push('first_name = ? COLLATE NOCASE'); args.push(f.firstName) }
    if (f.lastName !== undefined) { where.push('last_name = ? COLLATE NOCASE'); args.push(f.lastName) }
    if (f.dateOfBirth !== undefined) { where.push('date_of_birth = ?'); args.push(f.dateOfBirth) }
    if (f.phoneNumber !== undefined) {
      const p = normalizePhone(f.phoneNumber)
      where.push('phone_prefix = ? AND phone_number = ?'); args.push(p.countryCodePrefix, p.numberAfterPrefix)
    }
    if (f.status !== undefined) { where.push('status = ?'); args.push(f.status) }
    const sql = `SELECT * FROM customers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ASC LIMIT ? OFFSET ?`
    return (this.db.prepare(sql).all(...args, page.limit, page.offset) as Row[]).map(fromRow)
  }

  /** First live customer (other than excludeId) sharing an identity key with the candidate. */
  findDuplicate(c: Pick<Customer, 'email' | 'phoneNumber' | 'identityDocument' | 'customerDetails'>, excludeId?: string): { rule: DuplicateRule; id: string } | undefined {
    const checks: { rule: DuplicateRule; where: string; args: unknown[] }[] = [
      { rule: 'email', where: 'email = ? COLLATE NOCASE', args: [c.email] },
      { rule: 'phone number', where: 'phone_prefix = ? AND phone_number = ?', args: [c.phoneNumber.countryCodePrefix, c.phoneNumber.numberAfterPrefix] },
      { rule: 'name and date of birth', where: 'first_name = ? COLLATE NOCASE AND last_name = ? COLLATE NOCASE AND date_of_birth = ?', args: [c.customerDetails.firstName, c.customerDetails.lastName, c.customerDetails.dateOfBirth] },
    ]
    if (c.identityDocument.type && c.identityDocument.number) {
      checks.push({ rule: 'identity document', where: 'identity_document_type = ? AND identity_document_number = ? COLLATE NOCASE', args: [c.identityDocument.type, c.identityDocument.number] })
    }
    for (const check of checks) {
      const row = this.db
        .prepare(`SELECT id FROM customers WHERE ${LIVE} AND ${check.where} ${excludeId ? 'AND id != ?' : ''} ORDER BY seq ASC LIMIT 1`)
        .get(...check.args, ...(excludeId ? [excludeId] : [])) as { id: string } | undefined
      if (row) return { rule: check.rule, id: row.id }
    }
    return undefined
  }
}

type Row = Record<string, unknown>

function toRow(c: Customer): Row {
  const d = c.customerDetails
  const doc = c.identityDocument
  return {
    id: c.id,
    status: c.status,
    status_reason: c.statusReason ?? null,
    blocked_by: c.blockedBy ?? null,
    tier: c.tier,
    email: c.email,
    phone_prefix: c.phoneNumber.countryCodePrefix,
    phone_number: c.phoneNumber.numberAfterPrefix,
    address: JSON.stringify(c.address),
    first_name: d.firstName,
    middle_name: d.middleName ?? null,
    last_name: d.lastName,
    preferred_name: d.preferredName ?? null,
    title: d.title ?? null,
    gender: d.gender ?? null,
    date_of_birth: d.dateOfBirth,
    custom_data: c.customData === undefined ? null : JSON.stringify(c.customData),
    external_customer_id: c.externalCustomerId ?? null,
    device_id: c.deviceId,
    identity_document_type: doc.type ?? null,
    identity_document_number: doc.number ?? null,
    identity_document_card_number: doc.cardNumber ?? null,
    identity_document_expiry: doc.expiry ?? null,
    identity_document_issuing_country: doc.issuingCountry ?? null,
    identity_document_region: doc.region ?? null,
    identity_verification_case_id: c.identityVerificationCaseId ?? null,
    skip_kyc: c.skipKyc ? 1 : 0,
    only_sanctions_check: c.onlySanctionsCheck ? 1 : 0,
    tax_obligations: json.stringify(c.taxObligations),
    block_note: c.blockNote ?? null,
    created_at: c.createdAt,
    approved_at: c.approvedAt ?? null,
    closed_at: c.closedAt ?? null,
    updated_at: c.updatedAt ?? null,
  }
}

const str = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v))

function fromRow(r: Row): Customer {
  const customData = r.custom_data === null || r.custom_data === undefined ? undefined : (JSON.parse(r.custom_data as string) as Record<string, unknown> | null)
  const c: Customer = {
    id: r.id as string,
    status: r.status as CustomerStatus,
    tier: r.tier as Tier,
    email: r.email as string,
    phoneNumber: { countryCodePrefix: r.phone_prefix as string, numberAfterPrefix: r.phone_number as string },
    address: JSON.parse(r.address as string) as Address,
    customerDetails: {
      firstName: r.first_name as string,
      lastName: r.last_name as string,
      dateOfBirth: r.date_of_birth as string,
      middleName: str(r.middle_name),
      preferredName: str(r.preferred_name),
      title: str(r.title),
      gender: str(r.gender),
    },
    deviceId: r.device_id as string,
    identityDocument: {
      type: str(r.identity_document_type) as IdentityDocument['type'],
      number: str(r.identity_document_number),
      cardNumber: str(r.identity_document_card_number),
      expiry: str(r.identity_document_expiry),
      issuingCountry: str(r.identity_document_issuing_country),
      region: str(r.identity_document_region),
    },
    skipKyc: r.skip_kyc === 1,
    onlySanctionsCheck: r.only_sanctions_check === 1,
    createdAt: r.created_at as string,
  }
  if (customData !== undefined) c.customData = customData
  const opt: [keyof Customer, unknown][] = [
    ['statusReason', r.status_reason], ['blockedBy', r.blocked_by], ['externalCustomerId', r.external_customer_id],
    ['identityVerificationCaseId', r.identity_verification_case_id], ['blockNote', r.block_note],
    ['approvedAt', r.approved_at], ['closedAt', r.closed_at], ['updatedAt', r.updated_at],
  ]
  for (const [k, v] of opt) if (v !== null && v !== undefined) (c as unknown as Record<string, unknown>)[k] = v
  const tax = json.parse<TaxObligation[]>(r.tax_obligations as string | null)
  if (tax !== undefined) c.taxObligations = tax
  return stripUndefined(c)
}

function stripUndefined<T extends object>(o: T): T {
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) delete (o as Record<string, unknown>)[k]
    else if (v && typeof v === 'object' && !Array.isArray(v)) stripUndefined(v as object)
  }
  return o
}
