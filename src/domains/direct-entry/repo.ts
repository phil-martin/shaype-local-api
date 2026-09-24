/**
 * Row access for outbound Direct Entry instructions and scheduled payments.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import { json, nextSeq, type Db } from '../../db/index.js'
import type { Cents } from '../../lib/money.js'

type S = components['schemas']
export type HayScheduledPayment = S['HayScheduledPayment']
export type HayArchivedScheduledPayment = S['HayArchivedScheduledPayment']
export type ScheduledPaymentRecipient = S['ScheduledPaymentRecipient']
export type DeStatus = NonNullable<S['DirectDebitResponseV1']['outcome']>
export type DeStatusV0 = NonNullable<S['DirectDebitResponse']['outcome']>
export type ScheduleStatus = NonNullable<HayScheduledPayment['status']>
export type ScheduleType = NonNullable<HayScheduledPayment['type']>
export type ScheduleFrequency = NonNullable<HayScheduledPayment['frequency']>

export const DE_STATUSES: readonly DeStatus[] = ['RECEIVED', 'ACCEPTED', 'REJECTED', 'SUBMITTED', 'RETURNED', 'COMPLETE', 'INCOMPLETE']
/** Statuses after which nothing more happens to an instruction (docs/map/de-dd-scheduled.md §3.2). */
export const DE_TERMINAL: ReadonlySet<DeStatus> = new Set<DeStatus>(['REJECTED', 'RETURNED', 'COMPLETE', 'INCOMPLETE'])
export const SCHEDULE_TERMINAL: ReadonlySet<ScheduleStatus> = new Set<ScheduleStatus>(['CANCELLED', 'DELETED', 'FAILED', 'REJECTED', 'COMPLETED', 'REPLACED'])

export interface DeInstruction {
  id: string
  seq: number
  idempotencyKey: string
  accountId?: string
  amount: Cents
  description: string
  senderBsb: string
  senderAccountNumber: string
  senderName: string
  recipientBsb: string
  recipientAccountNumber: string
  recipientName: string
  status: DeStatus
  details?: string
  processingDate: string
  ledgerTransactionId?: string
  returnReason?: string
  createdAt: string
  updatedAt: string
}

export interface ScheduledPayment {
  id: string
  seq: number
  accountId: string
  customerId: string
  amount: Cents
  currency: string
  description?: string
  reference?: string
  type: ScheduleType
  frequency?: ScheduleFrequency
  startDate: string
  endDate?: string
  numberOfPayments?: number
  numberOfProcessedPayments: number
  nextRunDate?: string
  lastProcessedAt?: string
  shouldCancelOnFailure: boolean
  recipient: ScheduledPaymentRecipient
  status: ScheduleStatus
  previousVersions: HayArchivedScheduledPayment[]
  lastOutcome?: string
  createdAt: string
  updatedAt: string
}

export interface DeListFilter {
  /** inclusive isoUtc lower bound on created_at */
  from: string
  /** exclusive isoUtc upper bound on created_at */
  to: string
  statuses?: readonly DeStatus[]
  senderAccountNumber?: string
  limit: number
  offset: number
}

const undef = <T>(v: T | null): T | undefined => (v === null ? undefined : v)

export class DirectEntryRepo {
  constructor(private readonly db: Db) {}

  nextInstructionSeq(): number {
    return nextSeq(this.db, 'de_instruction')
  }

  nextScheduleSeq(): number {
    return nextSeq(this.db, 'scheduled_payment')
  }

  // ---------------------------------------------------------------- instructions

  insertInstruction(r: DeInstruction): void {
    this.db.prepare(`INSERT INTO de_instructions(
      id, seq, idempotency_key, account_id, amount, description, sender_bsb, sender_account_number, sender_name,
      recipient_bsb, recipient_account_number, recipient_name, status, details, processing_date, ledger_transaction_id,
      return_reason, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      r.id, r.seq, r.idempotencyKey, r.accountId ?? null, r.amount, r.description, r.senderBsb, r.senderAccountNumber, r.senderName,
      r.recipientBsb, r.recipientAccountNumber, r.recipientName, r.status, r.details ?? null, r.processingDate, r.ledgerTransactionId ?? null,
      r.returnReason ?? null, r.createdAt, r.updatedAt,
    )
  }

  updateInstruction(id: string, patch: Partial<Pick<DeInstruction, 'status' | 'details' | 'ledgerTransactionId' | 'returnReason'>> & { updatedAt: string }): void {
    const sets: string[] = ['updated_at = ?']
    const args: unknown[] = [patch.updatedAt]
    if (patch.status !== undefined) { sets.push('status = ?'); args.push(patch.status) }
    if ('details' in patch) { sets.push('details = ?'); args.push(patch.details ?? null) }
    if (patch.ledgerTransactionId !== undefined) { sets.push('ledger_transaction_id = ?'); args.push(patch.ledgerTransactionId) }
    if (patch.returnReason !== undefined) { sets.push('return_reason = ?'); args.push(patch.returnReason) }
    args.push(id)
    this.db.prepare(`UPDATE de_instructions SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  }

  instructionById(id: string): DeInstruction | undefined {
    const r = this.db.prepare('SELECT * FROM de_instructions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? toInstruction(r) : undefined
  }

  /** Creation-time ascending within [from, to) (docs/superpowers spec §4: lists ordered by creation time ascending). */
  listInstructions(f: DeListFilter): DeInstruction[] {
    const where = ['created_at >= ?', 'created_at < ?']
    const args: unknown[] = [f.from, f.to]
    if (f.statuses?.length) { where.push(`status IN (${f.statuses.map(() => '?').join(',')})`); args.push(...f.statuses) }
    if (f.senderAccountNumber !== undefined) { where.push('sender_account_number = ?'); args.push(f.senderAccountNumber) }
    args.push(f.limit, f.offset)
    const rows = this.db.prepare(`SELECT * FROM de_instructions WHERE ${where.join(' AND ')} ORDER BY created_at ASC, seq ASC LIMIT ? OFFSET ?`).all(...args) as Record<string, unknown>[]
    return rows.map(toInstruction)
  }

  /** Instructions of an account that are not in a terminal status, creation order. */
  inflightForAccount(accountId: string): DeInstruction[] {
    const rows = this.db
      .prepare(`SELECT * FROM de_instructions WHERE account_id = ? AND status IN ('RECEIVED','ACCEPTED','SUBMITTED') ORDER BY seq ASC`)
      .all(accountId) as Record<string, unknown>[]
    return rows.map(toInstruction)
  }

  /** Most recent instruction in one of `statuses` matching the sender BSB + account number + amount. */
  findMatching(senderBsb: string, senderAccountNumber: string, amount: Cents, statuses: readonly DeStatus[]): DeInstruction | undefined {
    const r = this.db
      .prepare(`SELECT * FROM de_instructions WHERE sender_bsb = ? AND sender_account_number = ? AND amount = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT 1`)
      .get(senderBsb, senderAccountNumber, amount, ...statuses) as Record<string, unknown> | undefined
    return r ? toInstruction(r) : undefined
  }

  // ---------------------------------------------------------------- scheduled payments

  insertSchedule(s: ScheduledPayment): void {
    this.db.prepare(`INSERT INTO scheduled_payments(
      id, seq, account_id, customer_id, amount, currency, description, reference, type, frequency, start_date, end_date,
      number_of_payments, number_of_processed_payments, next_run_date, last_processed_at, should_cancel_on_failure, recipient,
      status, previous_versions, last_outcome, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      s.id, s.seq, s.accountId, s.customerId, s.amount, s.currency, s.description ?? null, s.reference ?? null, s.type, s.frequency ?? null,
      s.startDate, s.endDate ?? null, s.numberOfPayments ?? null, s.numberOfProcessedPayments, s.nextRunDate ?? null, s.lastProcessedAt ?? null,
      s.shouldCancelOnFailure ? 1 : 0, JSON.stringify(s.recipient), s.status, JSON.stringify(s.previousVersions), s.lastOutcome ?? null,
      s.createdAt, s.updatedAt,
    )
  }

  /** Full-row replace (the schedule is small; every mutation goes through the service). */
  saveSchedule(s: ScheduledPayment): void {
    this.db.prepare(`UPDATE scheduled_payments SET
      account_id = ?, customer_id = ?, amount = ?, currency = ?, description = ?, reference = ?, type = ?, frequency = ?, start_date = ?, end_date = ?,
      number_of_payments = ?, number_of_processed_payments = ?, next_run_date = ?, last_processed_at = ?, should_cancel_on_failure = ?, recipient = ?,
      status = ?, previous_versions = ?, last_outcome = ?, updated_at = ?
      WHERE id = ?`).run(
      s.accountId, s.customerId, s.amount, s.currency, s.description ?? null, s.reference ?? null, s.type, s.frequency ?? null, s.startDate, s.endDate ?? null,
      s.numberOfPayments ?? null, s.numberOfProcessedPayments, s.nextRunDate ?? null, s.lastProcessedAt ?? null, s.shouldCancelOnFailure ? 1 : 0, JSON.stringify(s.recipient),
      s.status, JSON.stringify(s.previousVersions), s.lastOutcome ?? null, s.updatedAt,
      s.id,
    )
  }

  scheduleById(id: string): ScheduledPayment | undefined {
    const r = this.db.prepare('SELECT * FROM scheduled_payments WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? toSchedule(r) : undefined
  }

  schedulesForAccount(accountId: string): ScheduledPayment[] {
    const rows = this.db.prepare('SELECT * FROM scheduled_payments WHERE account_id = ? ORDER BY seq ASC').all(accountId) as Record<string, unknown>[]
    return rows.map(toSchedule)
  }

  /** ACTIVE schedules whose next occurrence date is on or before `date` (YYYY-MM-DD), creation order. */
  dueSchedules(date: string): ScheduledPayment[] {
    const rows = this.db
      .prepare(`SELECT * FROM scheduled_payments WHERE status = 'ACTIVE' AND next_run_date IS NOT NULL AND next_run_date <= ? ORDER BY seq ASC`)
      .all(date) as Record<string, unknown>[]
    return rows.map(toSchedule)
  }

  activeSchedulesForAccount(accountId: string): ScheduledPayment[] {
    const rows = this.db.prepare(`SELECT * FROM scheduled_payments WHERE account_id = ? AND status = 'ACTIVE' ORDER BY seq ASC`).all(accountId) as Record<string, unknown>[]
    return rows.map(toSchedule)
  }
}

function toInstruction(r: Record<string, unknown>): DeInstruction {
  const out: DeInstruction = {
    id: r.id as string,
    seq: r.seq as number,
    idempotencyKey: r.idempotency_key as string,
    amount: r.amount as number,
    description: r.description as string,
    senderBsb: r.sender_bsb as string,
    senderAccountNumber: r.sender_account_number as string,
    senderName: r.sender_name as string,
    recipientBsb: r.recipient_bsb as string,
    recipientAccountNumber: r.recipient_account_number as string,
    recipientName: r.recipient_name as string,
    status: r.status as DeStatus,
    processingDate: r.processing_date as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
  const accountId = undef(r.account_id as string | null)
  if (accountId !== undefined) out.accountId = accountId
  const details = undef(r.details as string | null)
  if (details !== undefined) out.details = details
  const ledgerTransactionId = undef(r.ledger_transaction_id as string | null)
  if (ledgerTransactionId !== undefined) out.ledgerTransactionId = ledgerTransactionId
  const returnReason = undef(r.return_reason as string | null)
  if (returnReason !== undefined) out.returnReason = returnReason
  return out
}

function toSchedule(r: Record<string, unknown>): ScheduledPayment {
  const out: ScheduledPayment = {
    id: r.id as string,
    seq: r.seq as number,
    accountId: r.account_id as string,
    customerId: r.customer_id as string,
    amount: r.amount as number,
    currency: r.currency as string,
    type: r.type as ScheduleType,
    startDate: r.start_date as string,
    numberOfProcessedPayments: r.number_of_processed_payments as number,
    shouldCancelOnFailure: (r.should_cancel_on_failure as number) === 1,
    recipient: json.parse<ScheduledPaymentRecipient>(r.recipient as string) ?? {},
    status: r.status as ScheduleStatus,
    previousVersions: json.parse<HayArchivedScheduledPayment[]>(r.previous_versions as string) ?? [],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
  const opt = <K extends keyof ScheduledPayment>(key: K, value: ScheduledPayment[K] | null): void => {
    if (value !== null && value !== undefined) out[key] = value
  }
  opt('description', r.description as string | null)
  opt('reference', r.reference as string | null)
  opt('frequency', r.frequency as ScheduleFrequency | null)
  opt('endDate', r.end_date as string | null)
  opt('numberOfPayments', r.number_of_payments as number | null)
  opt('nextRunDate', r.next_run_date as string | null)
  opt('lastProcessedAt', r.last_processed_at as string | null)
  opt('lastOutcome', r.last_outcome as string | null)
  return out
}
