/**
 * Scheduled and recurring payments (spec §5.8, docs/map/de-dd-scheduled.md §2.1–2.3, §3.1, §4.5).
 * Definitions are created only through Shaype's portal, so locally they come from
 * POST /_admin/scheduled-payments (routes.ts). Due occurrences are executed by a scheduler tick job
 * through the ledger (originType SCHEDULED_PAYMENT, originId = hayId, actionOwner PLATFORM).
 */
import type { AppContext } from '../../context.js'
import { compact, type ActionOwner } from '../../events/notify.js'
import { isoDate, isoUtc } from '../../lib/clock.js'
import { badRequest, notFound, unprocessable } from '../../lib/errors.js'
import { LOCAL_BSB, isUuid, uuid } from '../../lib/ids.js'
import { fromCents } from '../../lib/money.js'
import type { Account } from '../accounts/repo.js'
import type { Customer } from '../customers/repo.js'
import type { LedgerTransaction } from '../transactions/repo.js'
import { requestCents, type LedgerOutcome, type PostInput } from '../transactions/service.js'
import { isIsoDate, nextOccurrence } from './dates.js'
import { SCHEDULE_TERMINAL, type DirectEntryRepo, type HayArchivedScheduledPayment, type HayScheduledPayment, type ScheduledPayment, type ScheduledPaymentRecipient, type ScheduleFrequency, type ScheduleStatus, type ScheduleType } from './repo.js'

/** Body of POST /_admin/scheduled-payments (the portal's createScheduledPayment / updateSchedulePayment stand-in). */
export interface CreateScheduleInput {
  accountId: string
  /** The initiating customer; default the account's (first) holder. Must hold the account. */
  customerHayId?: string
  /** positive, <= 2 dp; currency defaults to the account's */
  amount: number
  currency?: string
  description?: string
  reference?: string
  /** default RECURRING when `frequency` is given, else ONE_TIME */
  type?: ScheduleType
  frequency?: ScheduleFrequency
  /** YYYY-MM-DD: the single processing date, or the first occurrence */
  startDate: string
  endDate?: string
  numberOfPayments?: number
  shouldCancelOnFailure?: boolean
  recipient: ScheduledPaymentRecipient
  /** hayId of an ACTIVE schedule this definition updates in place (the old version is archived as REPLACED). */
  replaces?: string
}

export interface OccurrenceResult { schedule: ScheduledPayment; outcome: LedgerOutcome; transaction?: LedgerTransaction }

const FREQUENCIES: readonly ScheduleFrequency[] = ['WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'QUARTERLY']
const BSB_RE = /^\d{6}$/
const ACCOUNT_NUMBER_RE = /^\d{5,9}$/
const BILLER_CODE_RE = /^\d{3,10}$/
const BILLER_REFERENCE_RE = /^\d{2,20}$/
const MAX_CATCH_UP = 400
/** Refusals decided on the receiving side -> REJECTED rather than FAILED (HayScheduledPayment.status descriptions). */
const RECIPIENT_REFUSALS: ReadonlySet<string> = new Set(['REFUSED_RECIPIENT_ACCOUNT_BLOCKED', 'REFUSED_RECIPIENT_ACCOUNT_CLOSED', 'REFUSED_BPAY_INVALID_BILLER_CODE', 'REFUSED_BPAY_INVALID_REFERENCE', 'REFUSED_BPAY_INVALID_PAYMENT', 'REFUSED_BPAY_REJECTED'])

export class ScheduledPaymentsService {
  constructor(private readonly ctx: AppContext, private readonly repo: DirectEntryRepo) {}

  private get accounts() {
    return this.ctx.services.accounts
  }

  private get ledger() {
    return this.ctx.services.transactions
  }

  // ---------------------------------------------------------------- reads

  find(hayId: string): ScheduledPayment | undefined {
    return this.repo.scheduleById(hayId)
  }

  /** getScheduledPayments: every schedule of the account regardless of status, creation order. @throws 404 unknown account */
  listForAccount(accountId: string): ScheduledPayment[] {
    this.accounts.get(accountId)
    return this.repo.schedulesForAccount(accountId)
  }

  /** getScheduledPaymentById: the schedule must exist under that account. @throws 404 */
  get(accountId: string, hayId: string): ScheduledPayment {
    this.accounts.get(accountId)
    const s = this.repo.scheduleById(hayId)
    if (!s || s.accountId !== accountId) throw notFound(`NOT_FOUND: Scheduled payment ${hayId} not found for account ${accountId}`)
    return s
  }

  toResponse(s: ScheduledPayment): HayScheduledPayment {
    return { ...this.toArchived(s), previousVersions: s.previousVersions }
  }

  toArchived(s: ScheduledPayment): HayArchivedScheduledPayment {
    return compact({
      hayId: s.id,
      accountId: s.accountId,
      customerHayId: s.customerId,
      amount: { currency: s.currency as NonNullable<HayScheduledPayment['amount']>['currency'], amount: fromCents(s.amount) },
      creationDateTimeUtc: s.createdAt,
      description: s.description,
      reference: s.reference,
      type: s.type,
      frequency: s.frequency,
      startDate: s.startDate,
      endDate: s.endDate,
      numberOfPayments: s.numberOfPayments,
      numberOfProcessedPayments: s.numberOfProcessedPayments,
      lastProcessedDateTimeUtc: s.lastProcessedAt,
      shouldCancelOnFailure: s.shouldCancelOnFailure,
      recipient: s.recipient,
      status: s.status,
    })
  }

  // ---------------------------------------------------------------- create (admin) / cancel

  /**
   * Creates an ACTIVE schedule (SCHEDULED_PAYMENT webhook) or, with `replaces`, updates that ACTIVE
   * schedule in place, archiving its previous definition as REPLACED in previousVersions (no webhook:
   * the event is a creation notification). Validation failures are 400; an unknown account 404; a
   * customer that does not hold the account 422 PERMISSION_DENIED; replacing a non-ACTIVE schedule 422.
   */
  create(input: CreateScheduleInput): ScheduledPayment {
    if (!isUuid(input.accountId)) throw badRequest('BAD_REQUEST: accountId must be a UUID')
    const account = this.accounts.get(input.accountId)
    const holders = this.accounts.holderCustomerIds(account)
    const customerId = input.customerHayId ?? holders[0] ?? account.holderId
    if (!holders.includes(customerId)) throw unprocessable(`PERMISSION_DENIED: Customer ${customerId} does not hold account ${account.id}`)
    const cents = requestCents(input.amount, 'amount')
    const currency = input.currency ?? account.currency
    if (currency !== account.currency) throw badRequest(`BAD_REQUEST: currency must be the account currency ${account.currency}`)
    if (!isIsoDate(input.startDate)) throw badRequest('BAD_REQUEST: startDate must be a date (YYYY-MM-DD)')
    const type: ScheduleType = input.type ?? (input.frequency ? 'RECURRING' : 'ONE_TIME')
    if (type !== 'RECURRING' && type !== 'ONE_TIME') throw badRequest('BAD_REQUEST: type must be RECURRING or ONE_TIME')
    if (type === 'RECURRING' && (!input.frequency || !FREQUENCIES.includes(input.frequency))) throw badRequest(`BAD_REQUEST: a RECURRING schedule needs frequency ${FREQUENCIES.join(' | ')}`)
    if (type === 'ONE_TIME' && (input.frequency || input.endDate || (input.numberOfPayments !== undefined && input.numberOfPayments !== 1))) {
      throw badRequest('BAD_REQUEST: a ONE_TIME schedule has no frequency, endDate or numberOfPayments other than 1')
    }
    if (input.endDate !== undefined && (!isIsoDate(input.endDate) || input.endDate < input.startDate)) throw badRequest('BAD_REQUEST: endDate must be a date on or after startDate')
    if (input.numberOfPayments !== undefined && (!Number.isInteger(input.numberOfPayments) || input.numberOfPayments < 1)) throw badRequest('BAD_REQUEST: numberOfPayments must be a positive integer')
    const recipient = validateRecipient(input.recipient)
    if (recipient.recipientType === 'ACCOUNT') {
      const target = recipient.recipientAccountNumber!
      if (target.branchNumber === LOCAL_BSB && !this.accounts.search(target.accountNumber!).length) throw badRequest(`BAD_REQUEST: no local account with account number ${target.accountNumber}`)
      if (target.branchNumber === account.bsb && target.accountNumber === account.accountNumber) throw badRequest('BAD_REQUEST: the recipient is the paying account')
    }

    const now = isoUtc(this.ctx.clock.now())
    const previous = input.replaces !== undefined ? this.repo.scheduleById(input.replaces) : undefined
    if (input.replaces !== undefined) {
      if (!previous) throw notFound(`NOT_FOUND: Scheduled payment ${input.replaces} not found`)
      if (previous.accountId !== account.id) throw unprocessable(`PERMISSION_DENIED: Scheduled payment ${previous.id} does not belong to account ${account.id}`)
      if (previous.status !== 'ACTIVE') throw unprocessable(`INVALID_STATUS_TRANSITION: Scheduled payment ${previous.id} is ${previous.status} and cannot be updated`)
    }
    const s: ScheduledPayment = compact({
      id: previous?.id ?? uuid(),
      seq: previous?.seq ?? this.repo.nextScheduleSeq(),
      accountId: account.id,
      customerId,
      amount: cents,
      currency,
      description: input.description,
      reference: input.reference,
      type,
      frequency: type === 'RECURRING' ? input.frequency : undefined,
      startDate: input.startDate,
      endDate: input.endDate,
      numberOfPayments: type === 'ONE_TIME' ? 1 : input.numberOfPayments,
      numberOfProcessedPayments: 0,
      nextRunDate: input.startDate,
      shouldCancelOnFailure: input.shouldCancelOnFailure ?? false,
      recipient,
      status: 'ACTIVE',
      previousVersions: previous ? [...previous.previousVersions, { ...this.toArchived(previous), status: 'REPLACED' }] : [],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    })
    if (previous) this.repo.saveSchedule(s)
    else {
      this.repo.insertSchedule(s)
      this.ctx.events.emit('scheduledPayment.created', { schedule: s, actionOwner: 'CLIENT' })
    }
    return s
  }

  /**
   * cancelScheduledPayment: ACTIVE -> CANCELLED (no further occurrences, the record stays readable).
   * Already CANCELLED is an idempotent no-op; any other terminal status is 422 INVALID_STATUS_TRANSITION.
   * @throws 404 unknown account / schedule
   */
  cancel(accountId: string, hayId: string, opts: { actionOwner?: ActionOwner } = {}): ScheduledPayment {
    const s = this.get(accountId, hayId)
    if (s.status === 'CANCELLED') return s
    if (s.status !== 'ACTIVE') throw unprocessable(`INVALID_STATUS_TRANSITION: Scheduled payment ${hayId} is ${s.status} and cannot be cancelled`)
    return this.setStatus(s, 'CANCELLED', opts.actionOwner ?? 'CLIENT')
  }

  /** Account closure: every ACTIVE schedule of the account is cancelled by the platform. */
  cancelAllForAccount(accountId: string): void {
    for (const s of this.repo.activeSchedulesForAccount(accountId)) this.setStatus(s, 'CANCELLED', 'PLATFORM')
  }

  // ---------------------------------------------------------------- execution

  /** Scheduler tick job: executes every occurrence due on or before today (UTC), catching up missed periods in order. */
  runDue(): OccurrenceResult[] {
    const today = isoDate(this.ctx.clock.now())
    const results: OccurrenceResult[] = []
    for (const due of this.repo.dueSchedules(today)) {
      let s: ScheduledPayment | undefined = due
      for (let i = 0; s && s.status === 'ACTIVE' && s.nextRunDate !== undefined && s.nextRunDate <= today && i < MAX_CATCH_UP; i++) {
        const r = this.execute(s)
        results.push(r)
        s = r.schedule
      }
    }
    return results
  }

  /**
   * One occurrence: ACCOUNT recipients transfer like makeTransferV1 (internal legs for BSB 636220,
   * INTERBANK_TRANSFER_OUT otherwise), BPAY recipients post BPAY_TRANSFER_OUT; every leg is stamped
   * originType SCHEDULED_PAYMENT / originId hayId. A refusal emits the TRANSACTION webhook with the
   * refused outcome, and either ends the schedule (ONE_TIME, or shouldCancelOnFailure: recipient-side
   * refusals -> REJECTED, others -> FAILED) or skips to the next occurrence.
   */
  execute(s: ScheduledPayment): OccurrenceResult {
    const account = this.accounts.find(s.accountId)
    if (!account) return { schedule: this.setStatus(s, 'FAILED', 'PLATFORM', 'REFUSED_ACCOUNT_CLOSED'), outcome: 'REFUSED_ACCOUNT_CLOSED' }
    const { outcome, transaction } = this.pay(s, account)
    const now = isoUtc(this.ctx.clock.now())
    const next: ScheduledPayment = { ...s, lastOutcome: outcome, updatedAt: now }
    if (outcome === 'ACCEPTED') {
      next.numberOfProcessedPayments += 1
      next.lastProcessedAt = now
    }
    let status: ScheduleStatus = 'ACTIVE'
    if (outcome !== 'ACCEPTED' && (s.type === 'ONE_TIME' || s.shouldCancelOnFailure)) status = RECIPIENT_REFUSALS.has(outcome) ? 'REJECTED' : 'FAILED'
    else if (s.type === 'ONE_TIME' || (s.numberOfPayments !== undefined && next.numberOfProcessedPayments >= s.numberOfPayments)) status = 'COMPLETED'
    else {
      const following = nextOccurrence(s.startDate, s.frequency!, s.nextRunDate ?? s.startDate)
      if (s.endDate !== undefined && following > s.endDate) status = 'COMPLETED'
      else next.nextRunDate = following
    }
    next.status = status
    if (status !== 'ACTIVE') delete next.nextRunDate
    this.repo.saveSchedule(next)
    if (status !== s.status) this.ctx.events.emit('scheduledPayment.statusChanged', { schedule: next, previousStatus: s.status, actionOwner: 'PLATFORM' })
    this.ctx.events.emit('scheduledPayment.executed', compact({ schedule: next, outcome, transaction }))
    return compact({ schedule: next, outcome, transaction })
  }

  private pay(s: ScheduledPayment, account: Account): { outcome: LedgerOutcome; transaction?: LedgerTransaction } {
    const common = {
      description: s.description,
      reference: s.reference,
      originType: 'SCHEDULED_PAYMENT' as const,
      originId: s.id,
      actionOwner: 'PLATFORM' as const,
      notifyRefusal: true,
    }
    const recipient = s.recipient
    if (recipient.recipientType === 'BPAY') {
      const bpay = recipient.bpayDetails ?? {}
      const r = this.ledger.post(compact({
        ...common,
        accountId: account.id,
        amountCents: -s.amount,
        type: 'BPAY_TRANSFER_OUT',
        channel: 'CUSCAL_BPAY_TRANSFER_OUT',
        counterpart: compact({ name: recipient.recipientName ?? bpay.billerName, bpayDetails: bpay }),
      }))
      return compact({ outcome: r.outcome, transaction: r.transaction })
    }

    const target = recipient.recipientAccountNumber!
    const local = target.branchNumber === LOCAL_BSB ? this.accounts.search(target.accountNumber!)[0] : undefined
    const recipientAccount = local?.accountHayId ? this.accounts.find(local.accountHayId) : undefined
    if (target.branchNumber !== LOCAL_BSB) {
      const r = this.ledger.post(compact({
        ...common,
        accountId: account.id,
        amountCents: -s.amount,
        type: 'INTERBANK_TRANSFER_OUT',
        channel: 'CUSCAL_NPP_TRANSFER_OUT',
        counterpart: compact({ name: recipient.recipientName, basicAccountNumber: { accountNumber: target.accountNumber!, branchNumber: target.branchNumber! } }),
      }))
      return compact({ outcome: r.outcome, transaction: r.transaction })
    }

    const out: PostInput = compact({
      ...common,
      accountId: account.id,
      amountCents: -s.amount,
      type: 'INTRABANK_TRANSFER_OUT',
      channel: 'HAAS_TRANSFER_INTERNAL_OUT',
      counterpart: compact({ accountId: recipientAccount?.id, customerId: recipientAccount && this.ledger.primaryCustomer(recipientAccount), name: recipient.recipientName }),
    })
    const refuse = (outcome: LedgerOutcome): { outcome: LedgerOutcome } => {
      this.ledger.notifyRefused(account, 'PLATFORM', outcome, {
        amountCents: -s.amount, webhookType: 'INTRABANK_TRANSFER_OUT', transactionTime: isoUtc(this.ctx.clock.now()), isPending: false,
        counterpart: out.counterpart, description: s.description, reference: s.reference, originType: 'SCHEDULED_PAYMENT', originId: s.id,
      })
      return { outcome }
    }
    const senderGate = this.ledger.evaluate(out)
    if (senderGate !== 'ACCEPTED') return refuse(senderGate)
    if (!recipientAccount) return refuse('REFUSED_RECIPIENT_ACCOUNT_CLOSED')
    const recipientGate = this.accounts.requireOpenForMovement(recipientAccount.id)
    if (recipientGate === 'REFUSED_ACCOUNT_BLOCKED') return refuse('REFUSED_RECIPIENT_ACCOUNT_BLOCKED')
    if (recipientGate === 'REFUSED_ACCOUNT_CLOSED') return refuse('REFUSED_RECIPIENT_ACCOUNT_CLOSED')
    if (recipientAccount.currency !== account.currency) return refuse('REFUSED_CAPABILITY_NOT_ENABLED')
    const into: PostInput = compact({
      ...common,
      notifyRefusal: false,
      accountId: recipientAccount.id,
      amountCents: s.amount,
      type: 'INTRABANK_TRANSFER_IN',
      channel: 'HAAS_TRANSFER_INTERNAL_IN',
      counterpart: { accountId: account.id, customerId: s.customerId, name: senderName(this.ctx.services.customers.find(s.customerId)) },
      limits: ['MAX_BALANCE'],
    })
    const recipientOutcome = this.ledger.evaluate(into)
    if (recipientOutcome !== 'ACCEPTED') return refuse(recipientOutcome)
    const sent = this.ctx.db.transaction(() => {
      const t = this.ledger.apply(out)
      this.ledger.apply(into)
      return t
    })()
    return { outcome: 'ACCEPTED', transaction: sent }
  }

  private setStatus(s: ScheduledPayment, status: ScheduleStatus, actionOwner: ActionOwner, lastOutcome?: string): ScheduledPayment {
    if (SCHEDULE_TERMINAL.has(s.status)) throw unprocessable(`INVALID_STATUS_TRANSITION: Scheduled payment ${s.id} is ${s.status}`)
    const next: ScheduledPayment = compact({ ...s, status, lastOutcome: lastOutcome ?? s.lastOutcome, updatedAt: isoUtc(this.ctx.clock.now()) })
    delete next.nextRunDate
    this.repo.saveSchedule(next)
    this.ctx.events.emit('scheduledPayment.statusChanged', { schedule: next, previousStatus: s.status, actionOwner })
    return next
  }
}

function senderName(c: Customer | undefined): string | undefined {
  if (!c) return undefined
  const d = c.customerDetails as { firstName?: string; lastName?: string }
  const name = [d.firstName, d.lastName].filter(Boolean).join(' ')
  return name || undefined
}

/** ScheduledPaymentRecipient as the portal would validate it: ACCOUNT needs a BSB + account number, BPAY a biller code + CRN. @throws 400 */
export function validateRecipient(r: ScheduledPaymentRecipient | undefined): ScheduledPaymentRecipient {
  if (!r || typeof r !== 'object') throw badRequest('BAD_REQUEST: recipient is required')
  if (r.recipientType === 'ACCOUNT') {
    const a = r.recipientAccountNumber
    if (!a || typeof a.branchNumber !== 'string' || !BSB_RE.test(a.branchNumber) || typeof a.accountNumber !== 'string' || !ACCOUNT_NUMBER_RE.test(a.accountNumber)) {
      throw badRequest('BAD_REQUEST: recipient.recipientAccountNumber needs branchNumber (6 digits) and accountNumber (5-9 digits)')
    }
    return compact({ recipientType: 'ACCOUNT', recipientName: r.recipientName, recipientAccountNumber: { branchNumber: a.branchNumber, accountNumber: a.accountNumber } })
  }
  if (r.recipientType === 'BPAY') {
    const b = r.bpayDetails
    if (!b || typeof b.billerCode !== 'string' || !BILLER_CODE_RE.test(b.billerCode) || typeof b.billerReference !== 'string' || !BILLER_REFERENCE_RE.test(b.billerReference)) {
      throw badRequest('BAD_REQUEST: recipient.bpayDetails needs billerCode (3-10 digits) and billerReference (2-20 digits)')
    }
    return compact({ recipientType: 'BPAY', recipientName: r.recipientName, bpayDetails: compact({ billerCode: b.billerCode, billerReference: b.billerReference, billerName: b.billerName, billerImage: b.billerImage, category: b.category }) })
  }
  throw badRequest('BAD_REQUEST: recipient.recipientType must be ACCOUNT or BPAY')
}
