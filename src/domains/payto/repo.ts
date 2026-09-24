/**
 * SQL for mandates, mandate_actions, mandate_instructions and mandate_schedules: rows <-> entities.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import type Database from 'better-sqlite3'
import { json, nextSeq, type Db } from '../../db/index.js'
import type { Cents } from '../../lib/money.js'

type S = components['schemas']

export type MandateStatus = 'CREATED' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED'
export type CxMandateStatus =
  | 'ACTION_REQUIRED' | 'ACTIVE_TRANSFER_INITIATED' | 'PAUSED_TRANSFER_INITIATED' | 'TRANSFERRED' | 'ACTIVE'
  | 'PAUSED_BY_PAYMENT_INITIATOR' | 'PAUSED_BY_CUSTOMER' | 'PAUSED_BY_PAYER_INSTITUTION'
  | 'CANCELLED_AUTHORISATION_TIMED_OUT' | 'CANCELLED_BY_PAYMENT_INITIATOR' | 'CANCELLED'
/** Who acts: the creditor side (INITIATOR), the debtor side (PAYER) or Shaype / the MMS (PLATFORM). */
export type MandateSide = 'INITIATOR' | 'PAYER' | 'PLATFORM'
export type PurposeCode = NonNullable<S['GetMandateResponseBody']['purposeCode']>
export type PartyType = 'ORGANISATION' | 'PERSON'
export type AccountAliasType = 'AUSTRALIAN_BUSINESS_NUMBER' | 'EMAIL_ADDRESS' | 'ORGANISATION_ID' | 'PHONE_NUMBER'
export type Frequency = NonNullable<S['GetPaymentTermsDto']['frequency']>
export type PaymentTermsType = NonNullable<S['GetPaymentTermsDto']['type']>
export type ActionType = 'AMEND' | 'CREATE' | 'PORT' | 'STATUS_CHANGE'
export type ActionStatus = 'COMPLETED' | 'DECLINED' | 'PENDING' | 'RECALLED' | 'TIMED_OUT'
export type PartyRole = 'DEBTOR' | 'PAYMENT_INITIATOR'
export type StatusChange = 'CANCEL' | 'RELEASE' | 'SUSPEND'
export type InstructionStatus = NonNullable<S['PaymentInstruction']['transactionStatus']>
export type MmsInstructionStatus = 'RECV' | 'UNDV' | 'SENT' | 'SAFD' | 'ACCP' | 'ACSP' | 'ACSC' | 'RJCT'
export type InstructionOrigin = 'ADHOC' | 'SCHEDULED' | 'INBOUND' | 'STUB'

export interface Money { amountCents: Cents; currency: string }

export interface PartyDetails {
  /** local platform account (when the party is on the platform) */
  accountId?: string
  /** BSB + account number */
  accountNumber?: string
  accountAliasIdentification?: string
  accountAliasType?: AccountAliasType
  partyName?: string
  partyReference?: string
  partyType?: PartyType
  ultimatePartyName?: string
}

export interface PaymentTerms {
  frequency: Frequency
  type: PaymentTermsType
  amount?: Money
  maximumAmount?: Money
  countPerPeriod?: string
  pointInTime?: string
  firstPayment?: { amount?: Money; date?: string }
  lastPayment?: { amount?: Money; date?: string }
}

export interface Mandate {
  id: string
  status: MandateStatus
  cxStatus: CxMandateStatus
  creditor: PartyDetails
  debtor: PartyDetails
  description?: string
  purposeCode?: PurposeCode
  transferArrangement?: string
  validityStartDate: string
  validityEndDate?: string
  paymentTerms: PaymentTerms
  resolutionRequestedBy?: string
  suspendedBy?: MandateSide
  /** Due date (YYYY-MM-DD) of the last scheduled payment initiated; owned by the scheduler (setLastDueDate), never written by saveMandate */
  lastDueDate?: string
  registrationDateTime: string
  createdAt: string
  updatedAt?: string
}

/**
 * GetMandateActionsDetailsDto in the value space the JSON schemas validate (the generated TS types keep the
 * spec's comma-joined single-string enums for these DTOs, so the shape is declared here and cast on output).
 */
export interface PartyInformation {
  accountAliasIdentification?: string
  accountAliasTypeCode?: AccountAliasType
  accountId?: string
  accountIdentificationTypeCode?: 'BASIC_BANK_ACCOUNT_NUMBER' | 'ALIAS'
  accountNumber?: string
  accountServicerBic?: string
  partyName?: string
  partyReference?: string
  partyType?: PartyType
  ultimatePartyName?: string
}
export interface PaymentInformation {
  amount?: { amount: string; currency: string }
  countPerPeriod?: string
  firstPaymentAmount?: { amount: string; currency: string }
  firstPaymentDate?: string
  lastPaymentAmount?: { amount: string; currency: string }
  lastPaymentDate?: string
  maximumAmount?: { amount: string; currency: string }
  paymentAmountType?: PaymentTermsType
  paymentFrequency?: Frequency
  pointInTime?: string
}
export interface ActionDetails {
  creation?: {
    automaticExtensionIndicator: boolean
    creditorInformation?: PartyInformation
    debtorInformation: PartyInformation
    description?: string
    establishmentScheme: 'AUTHORISED_PAYMENT_MANDATE' | 'MIGRATED_BY_CREDITOR' | 'UNILATERAL_BY_DEBTOR'
    initiationRequestIdentification: string
    mandatePurposeCode?: PurposeCode
    mandateType: 'DIRECT_DEBIT' | 'STANDING_ORDER'
    paymentInformation: PaymentInformation
    paymentInitiatorInformation: { partyIdentification: string; partyIdentificationTypeCode: string; partyLegalName: string; partyName: string; partyServicerBic?: string }
    resolutionRequestedBy?: string
    transferArrangement?: string
    validityEndDate?: string
    validityStartDate: string
  }
  amendment?: {
    creditorInformation?: PartyInformation
    debtorInformation?: PartyInformation
    paymentInformation?: PaymentInformation
    resolutionRequestedBy?: string
    validityEndDate?: string
  }
  porting?: Record<string, unknown>
  statusChange?: { change: StatusChange; reasonCode?: string; reasonDescription?: string }
}

/** Internal record of what a pending bilateral AMEND proposes; applied on acceptance (paymentTerms replace the agreement's). */
export interface AmendProposal {
  paymentTerms?: PaymentTerms
  validityEndDate?: string
}

export interface MandateAction {
  id: string
  mandateId: string
  type: ActionType
  status: ActionStatus
  bilateral?: boolean
  partyRole: PartyRole
  /** ISO ms UTC (the spec's action-time pattern allows at most 3 fractional digits) */
  creationTime: string
  resolutionTime?: string
  resolutionReasonCode?: string
  resolutionReasonDescription?: string
  details?: ActionDetails
  proposal?: AmendProposal
  expiryTime?: string
  resolutionRequestedBy?: string
  cxEventNameCreation?: string
  cxEventNameResolution?: string
}

export interface PaymentInstruction {
  id: string
  mandateId: string
  origin: InstructionOrigin
  /** positive cents */
  amountCents: Cents
  currency: string
  endToEndId: string
  description?: string
  status: InstructionStatus
  reasonCode?: string
  transactionId?: string
  creationDateTime: string
  updatedAt?: string
  /** What searchPaymentsInstructions reports instead, set by a search stub naming this (non-STUB) instruction's id; never written by saveInstruction */
  stub?: StubView
}

/** The fields of a search stub entry (PaymentInstructionSummary) laid over a real instruction. */
export interface StubView { amountCents: Cents; status: InstructionStatus; reasonCode?: string; creationDateTime: string }

export interface ScheduledPayment {
  notificationId: string
  mandateId: string
  dueDate: string
  paymentDateTime: string
  amountCents?: Cents
  /** whether MANDATE_DUE_PAYMENT announces it (USAGE_BASED / VARIABLE terms) */
  announce: boolean
  announcedAt?: string
  createdAt: string
}

export interface MandateFilter {
  /** BSB + account number strings the debtor must match one of (OR-ed with debtorAccountIds) */
  debtorAccountNumbers?: string[]
  /** local debtor account ids the debtor must match one of (OR-ed with debtorAccountNumbers) */
  debtorAccountIds?: string[]
  statuses?: MandateStatus[]
}

type Row = Record<string, unknown>
type Statement = Database.Statement<unknown[]>

export class MandateRepo {
  /** Prepared statements by SQL text: tick() runs on every request, so nothing is re-prepared per call. */
  private readonly statements = new Map<string, Statement>()

  constructor(private readonly db: Db) {}

  private stmt(sql: string): Statement {
    let s = this.statements.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.statements.set(sql, s)
    }
    return s
  }

  // ---------------------------------------------------------------- settings (meta table: wiped by /_admin/reset)

  setting(key: string): string | undefined {
    return (this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
  }

  setSetting(key: string, value: string | undefined): void {
    if (value === undefined) this.stmt('DELETE FROM meta WHERE key = ?').run(key)
    else this.stmt('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // ---------------------------------------------------------------- mandates

  insertMandate(m: Mandate): void {
    const r = mandateToRow(m)
    const cols = Object.keys(r)
    this.stmt(`INSERT INTO mandates(seq, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(nextSeq(this.db, 'mandate'), ...cols.map((k) => r[k]))
  }

  saveMandate(m: Mandate): void {
    const r = mandateToRow(m)
    const cols = Object.keys(r).filter((k) => k !== 'id')
    this.stmt(`UPDATE mandates SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => r[k]), m.id)
  }

  setLastDueDate(mandateId: string, dueDate: string): void {
    this.stmt('UPDATE mandates SET last_due_date = ? WHERE id = ?').run(dueDate, mandateId)
  }

  mandateById(id: string): Mandate | undefined {
    const r = this.stmt('SELECT * FROM mandates WHERE id = ?').get(id) as Row | undefined
    return r ? mandateFromRow(r) : undefined
  }

  mandateIdsForCreditorAccount(accountId: string): string[] {
    return (this.stmt('SELECT id FROM mandates WHERE creditor_account_id = ? ORDER BY seq ASC').all(accountId) as { id: string }[]).map((r) => r.id)
  }

  mandatesForAccount(accountId: string): Mandate[] {
    return (this.stmt('SELECT * FROM mandates WHERE creditor_account_id = ? OR debtor_account_id = ? ORDER BY seq ASC').all(accountId, accountId) as Row[]).map(mandateFromRow)
  }

  /** Mandates whose validity ended before `today` (YYYY-MM-DD) and are not yet CANCELLED. */
  expiredMandates(today: string): Mandate[] {
    return (this.stmt(`SELECT * FROM mandates WHERE status != 'CANCELLED' AND validity_end_date IS NOT NULL AND validity_end_date < ? ORDER BY seq ASC`).all(today) as Row[]).map(mandateFromRow)
  }

  /** Payer-side search: only mandates whose debtor is a local account (Cuscal restricts the cache to the Payer's own accounts). */
  searchMandates(filter: MandateFilter, page: { offset: number; limit: number }): { result: Mandate[]; totalCount: number } {
    const where: string[] = ['debtor_account_id IS NOT NULL']
    const args: unknown[] = []
    if (filter.debtorAccountNumbers || filter.debtorAccountIds) {
      const numbers = filter.debtorAccountNumbers ?? []
      const ids = filter.debtorAccountIds ?? []
      if (!numbers.length && !ids.length) return { result: [], totalCount: 0 }
      const any: string[] = []
      if (numbers.length) any.push(`debtor_account_number IN (${numbers.map(() => '?').join(', ')})`)
      if (ids.length) any.push(`debtor_account_id IN (${ids.map(() => '?').join(', ')})`)
      where.push(`(${any.join(' OR ')})`)
      args.push(...numbers, ...ids)
    }
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`)
      args.push(...filter.statuses)
    }
    const sql = `WHERE ${where.join(' AND ')}`
    const totalCount = (this.db.prepare(`SELECT COUNT(*) AS n FROM mandates ${sql}`).get(...args) as { n: number }).n
    const result = (this.db.prepare(`SELECT * FROM mandates ${sql} ORDER BY seq ASC LIMIT ? OFFSET ?`).all(...args, page.limit, page.offset) as Row[]).map(mandateFromRow)
    return { result, totalCount }
  }

  // ---------------------------------------------------------------- actions

  insertAction(a: MandateAction): void {
    const r = actionToRow(a)
    const cols = Object.keys(r)
    this.stmt(`INSERT INTO mandate_actions(seq, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(nextSeq(this.db, 'mandate-action'), ...cols.map((k) => r[k]))
  }

  saveAction(a: MandateAction): void {
    const r = actionToRow(a)
    const cols = Object.keys(r).filter((k) => k !== 'id')
    this.stmt(`UPDATE mandate_actions SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => r[k]), a.id)
  }

  actionById(id: string): MandateAction | undefined {
    const r = this.stmt('SELECT * FROM mandate_actions WHERE id = ?').get(id) as Row | undefined
    return r ? actionFromRow(r) : undefined
  }

  actionsForMandate(mandateId: string): MandateAction[] {
    return (this.stmt('SELECT * FROM mandate_actions WHERE mandate_id = ? ORDER BY seq ASC').all(mandateId) as Row[]).map(actionFromRow)
  }

  /** Oldest PENDING action of the mandate, optionally of one type. */
  pendingAction(mandateId: string, type?: ActionType): MandateAction | undefined {
    const r = (type
      ? this.stmt(`SELECT * FROM mandate_actions WHERE mandate_id = ? AND status = 'PENDING' AND type = ? ORDER BY seq ASC LIMIT 1`).get(mandateId, type)
      : this.stmt(`SELECT * FROM mandate_actions WHERE mandate_id = ? AND status = 'PENDING' ORDER BY seq ASC LIMIT 1`).get(mandateId)) as Row | undefined
    return r ? actionFromRow(r) : undefined
  }

  latestAction(mandateId: string): MandateAction | undefined {
    const r = this.stmt('SELECT * FROM mandate_actions WHERE mandate_id = ? ORDER BY seq DESC LIMIT 1').get(mandateId) as Row | undefined
    return r ? actionFromRow(r) : undefined
  }

  /** PENDING actions whose expiryTime (ISO ms) is at or before `nowIso`. */
  expiredPendingActions(nowIso: string): MandateAction[] {
    return (this.stmt(`SELECT * FROM mandate_actions WHERE status = 'PENDING' AND expiry_time IS NOT NULL AND expiry_time <= ? ORDER BY seq ASC`).all(nowIso) as Row[]).map(actionFromRow)
  }

  // ---------------------------------------------------------------- instructions

  nextInstructionSeq(): number {
    return nextSeq(this.db, 'mandate-instruction')
  }

  insertInstruction(i: PaymentInstruction): void {
    const r = instructionToRow(i)
    const cols = Object.keys(r)
    this.stmt(`INSERT INTO mandate_instructions(seq, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(nextSeq(this.db, 'mandate-instruction-row'), ...cols.map((k) => r[k]))
  }

  saveInstruction(i: PaymentInstruction): void {
    const r = instructionToRow(i)
    const cols = Object.keys(r).filter((k) => k !== 'id')
    this.stmt(`UPDATE mandate_instructions SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => r[k]), i.id)
  }

  instructionById(id: string): PaymentInstruction | undefined {
    const r = this.stmt('SELECT * FROM mandate_instructions WHERE id = ?').get(id) as Row | undefined
    return r ? instructionFromRow(r) : undefined
  }

  /** Newest first (docs/map/00-open-questions.md G2: payment-instruction lists are newest first). */
  instructionsForMandate(mandateId: string): PaymentInstruction[] {
    return (this.stmt('SELECT * FROM mandate_instructions WHERE mandate_id = ? ORDER BY seq DESC').all(mandateId) as Row[]).map(instructionFromRow)
  }

  setStub(instructionId: string, stub: StubView): void {
    this.stmt('UPDATE mandate_instructions SET stub = ? WHERE id = ?').run(JSON.stringify(stub), instructionId)
  }

  clearStubs(mandateId: string): void {
    this.stmt('UPDATE mandate_instructions SET stub = NULL WHERE mandate_id = ? AND stub IS NOT NULL').run(mandateId)
  }

  deleteInstruction(id: string): void {
    this.stmt('DELETE FROM mandate_instructions WHERE id = ?').run(id)
  }

  deleteInstructions(mandateId: string, origin: InstructionOrigin): void {
    this.stmt('DELETE FROM mandate_instructions WHERE mandate_id = ? AND origin = ?').run(mandateId, origin)
  }

  // ---------------------------------------------------------------- schedules

  insertSchedule(s: ScheduledPayment): void {
    this
      .stmt('INSERT INTO mandate_schedules(notification_id, mandate_id, due_date, payment_date_time, amount, announce, announced_at, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(s.notificationId, s.mandateId, s.dueDate, s.paymentDateTime, s.amountCents ?? null, s.announce ? 1 : 0, s.announcedAt ?? null, s.createdAt)
  }

  saveSchedule(s: ScheduledPayment): void {
    this
      .stmt('UPDATE mandate_schedules SET due_date = ?, payment_date_time = ?, amount = ?, announce = ?, announced_at = ? WHERE notification_id = ?')
      .run(s.dueDate, s.paymentDateTime, s.amountCents ?? null, s.announce ? 1 : 0, s.announcedAt ?? null, s.notificationId)
  }

  /** Schedules to announce whose initiation time is at or before `untilIso` (isoUtc) and that were not announced yet. */
  schedulesToAnnounce(untilIso: string): ScheduledPayment[] {
    return (this.stmt('SELECT * FROM mandate_schedules WHERE announce = 1 AND announced_at IS NULL AND payment_date_time <= ? ORDER BY payment_date_time ASC').all(untilIso) as Row[]).map(scheduleFromRow)
  }

  scheduleById(notificationId: string): ScheduledPayment | undefined {
    const r = this.stmt('SELECT * FROM mandate_schedules WHERE notification_id = ?').get(notificationId) as Row | undefined
    return r ? scheduleFromRow(r) : undefined
  }

  scheduleForMandate(mandateId: string): ScheduledPayment | undefined {
    const r = this.stmt('SELECT * FROM mandate_schedules WHERE mandate_id = ?').get(mandateId) as Row | undefined
    return r ? scheduleFromRow(r) : undefined
  }

  deleteSchedule(mandateId: string): void {
    this.stmt('DELETE FROM mandate_schedules WHERE mandate_id = ?').run(mandateId)
  }

  dueSchedules(nowIso: string): ScheduledPayment[] {
    return (this.stmt('SELECT * FROM mandate_schedules WHERE payment_date_time <= ? ORDER BY payment_date_time ASC').all(nowIso) as Row[]).map(scheduleFromRow)
  }
}

// ---------------------------------------------------------------- row mapping

function mandateToRow(m: Mandate): Row {
  return {
    id: m.id,
    status: m.status,
    cx_status: m.cxStatus,
    creditor_account_id: m.creditor.accountId ?? null,
    creditor: JSON.stringify(m.creditor),
    debtor_account_id: m.debtor.accountId ?? null,
    debtor_account_number: m.debtor.accountNumber ?? null,
    debtor: JSON.stringify(m.debtor),
    description: m.description ?? null,
    purpose_code: m.purposeCode ?? null,
    transfer_arrangement: m.transferArrangement ?? null,
    validity_start_date: m.validityStartDate,
    validity_end_date: m.validityEndDate ?? null,
    payment_terms: JSON.stringify(m.paymentTerms),
    resolution_requested_by: m.resolutionRequestedBy ?? null,
    suspended_by: m.suspendedBy ?? null,
    registration_date_time: m.registrationDateTime,
    created_at: m.createdAt,
    updated_at: m.updatedAt ?? null,
  }
}

function mandateFromRow(r: Row): Mandate {
  const m: Mandate = {
    id: r.id as string,
    status: r.status as MandateStatus,
    cxStatus: r.cx_status as CxMandateStatus,
    creditor: json.parse<PartyDetails>(r.creditor as string) ?? {},
    debtor: json.parse<PartyDetails>(r.debtor as string) ?? {},
    validityStartDate: r.validity_start_date as string,
    paymentTerms: json.parse<PaymentTerms>(r.payment_terms as string)!,
    registrationDateTime: r.registration_date_time as string,
    createdAt: r.created_at as string,
  }
  if (r.description != null) m.description = r.description as string
  if (r.purpose_code != null) m.purposeCode = r.purpose_code as PurposeCode
  if (r.transfer_arrangement != null) m.transferArrangement = r.transfer_arrangement as string
  if (r.validity_end_date != null) m.validityEndDate = r.validity_end_date as string
  if (r.resolution_requested_by != null) m.resolutionRequestedBy = r.resolution_requested_by as string
  if (r.suspended_by != null) m.suspendedBy = r.suspended_by as MandateSide
  if (r.last_due_date != null) m.lastDueDate = r.last_due_date as string
  if (r.updated_at != null) m.updatedAt = r.updated_at as string
  return m
}

function actionToRow(a: MandateAction): Row {
  return {
    id: a.id,
    mandate_id: a.mandateId,
    type: a.type,
    status: a.status,
    bilateral: a.bilateral === undefined ? null : a.bilateral ? 1 : 0,
    party_role: a.partyRole,
    creation_time: a.creationTime,
    resolution_time: a.resolutionTime ?? null,
    resolution_reason_code: a.resolutionReasonCode ?? null,
    resolution_reason_description: a.resolutionReasonDescription ?? null,
    details: json.stringify(a.details),
    proposal: json.stringify(a.proposal),
    expiry_time: a.expiryTime ?? null,
    resolution_requested_by: a.resolutionRequestedBy ?? null,
    cx_event_name_creation: a.cxEventNameCreation ?? null,
    cx_event_name_resolution: a.cxEventNameResolution ?? null,
  }
}

function actionFromRow(r: Row): MandateAction {
  const a: MandateAction = {
    id: r.id as string,
    mandateId: r.mandate_id as string,
    type: r.type as ActionType,
    status: r.status as ActionStatus,
    partyRole: r.party_role as PartyRole,
    creationTime: r.creation_time as string,
  }
  if (r.bilateral != null) a.bilateral = r.bilateral === 1
  if (r.resolution_time != null) a.resolutionTime = r.resolution_time as string
  if (r.resolution_reason_code != null) a.resolutionReasonCode = r.resolution_reason_code as string
  if (r.resolution_reason_description != null) a.resolutionReasonDescription = r.resolution_reason_description as string
  const details = json.parse<ActionDetails>(r.details as string | null)
  if (details) a.details = details
  const proposal = json.parse<AmendProposal>(r.proposal as string | null)
  if (proposal) a.proposal = proposal
  if (r.expiry_time != null) a.expiryTime = r.expiry_time as string
  if (r.resolution_requested_by != null) a.resolutionRequestedBy = r.resolution_requested_by as string
  if (r.cx_event_name_creation != null) a.cxEventNameCreation = r.cx_event_name_creation as string
  if (r.cx_event_name_resolution != null) a.cxEventNameResolution = r.cx_event_name_resolution as string
  return a
}

function instructionToRow(i: PaymentInstruction): Row {
  return {
    id: i.id,
    mandate_id: i.mandateId,
    origin: i.origin,
    amount: i.amountCents,
    currency: i.currency,
    end_to_end_id: i.endToEndId,
    description: i.description ?? null,
    status: i.status,
    reason_code: i.reasonCode ?? null,
    transaction_id: i.transactionId ?? null,
    creation_date_time: i.creationDateTime,
    updated_at: i.updatedAt ?? null,
  }
}

function instructionFromRow(r: Row): PaymentInstruction {
  const i: PaymentInstruction = {
    id: r.id as string,
    mandateId: r.mandate_id as string,
    origin: r.origin as InstructionOrigin,
    amountCents: r.amount as number,
    currency: r.currency as string,
    endToEndId: r.end_to_end_id as string,
    status: r.status as InstructionStatus,
    creationDateTime: r.creation_date_time as string,
  }
  if (r.description != null) i.description = r.description as string
  if (r.reason_code != null) i.reasonCode = r.reason_code as string
  if (r.transaction_id != null) i.transactionId = r.transaction_id as string
  if (r.updated_at != null) i.updatedAt = r.updated_at as string
  const stub = json.parse<StubView>(r.stub as string | null)
  if (stub) i.stub = stub
  return i
}

function scheduleFromRow(r: Row): ScheduledPayment {
  const s: ScheduledPayment = {
    notificationId: r.notification_id as string,
    mandateId: r.mandate_id as string,
    dueDate: r.due_date as string,
    paymentDateTime: r.payment_date_time as string,
    announce: r.announce === 1,
    createdAt: r.created_at as string,
  }
  if (r.amount != null) s.amountCents = r.amount as number
  if (r.announced_at != null) s.announcedAt = r.announced_at as string
  return s
}
