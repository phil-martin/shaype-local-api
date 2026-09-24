/**
 * Outbound Direct Entry instructions (spec §5.8, docs/map/de-dd-scheduled.md §1, §3.2, §4.3):
 * createDirectDebitV1/V0 pulls funds from an external (recipient) account into a local (sender)
 * account. RECEIVED -> ACCEPTED happen synchronously with the request; ACCEPTED -> SUBMITTED ->
 * COMPLETE run through ctx.scheduler.later() (one hop each, config.asyncDelayMs apart); COMPLETE
 * posts the DIRECT_DEBIT_TRANSFER credit through the ledger. One directEntry.statusChanged event per
 * transition (events.ts maps it to the DIRECT_ENTRY webhook). Publishes ctx.services.directEntry.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import type { AppContext } from '../../context.js'
import { compact, type ActionOwner } from '../../events/notify.js'
import { isoDate, isoUtc } from '../../lib/clock.js'
import { badRequest, notFound, unprocessable } from '../../lib/errors.js'
import { LOCAL_BSB } from '../../lib/ids.js'
import { fromCents, type Cents } from '../../lib/money.js'
import type { Account } from '../accounts/repo.js'
import type { ClosureCheckerError } from '../accounts/service.js'
import type { LedgerOutcome, PostInput } from '../transactions/service.js'
import { requestCents } from '../transactions/service.js'
import { addDays, isIsoDate, nextBusinessDay } from './dates.js'
import { DE_TERMINAL, type DeInstruction, type DeStatus, type DeStatusV0, type DirectEntryRepo } from './repo.js'
import { ScheduledPaymentsService } from './schedules.js'

type S = components['schemas']
export type CreateDirectDebitRequestBody = S['CreateDirectDebitRequestBody']
export type DirectDebitResponseV1 = S['DirectDebitResponseV1']
export type DirectDebitResponse = S['DirectDebitResponse']
export type DeTransactionDetailsV1 = S['DeTransactionDetailsV1']
export type DeTransactionDetails = S['DeTransactionDetails']
export type DirectEntryStatusResponseV1 = S['DirectEntryStatusResponseV1']
export type DeReturnReason = 'INVALID_BSB_NUMBER' | 'PAYMENT_STOPPED' | 'ACCOUNT_CLOSED' | 'CUSTOMER_DECEASED' | 'NO_ACCOUNT_OR_INCORRECT_ACCOUNT_NUMBER' | 'REFER_TO_CUSTOMER' | 'INVALID_USER_ID' | 'TECHNICAL_INVALID'

export interface CreateResult<T> { status: number; body: T }

export interface ListQuery {
  /** YYYY-MM-DD, inclusive */
  fromUtc: string
  /** YYYY-MM-DD, inclusive (the whole day) */
  toUtc: string
  offset: number
  limit: number
  senderAccountNumber?: string
}

export interface ReturnInput {
  senderBsb: string
  senderAccountNumber: string
  /** positive cents */
  amountCents: Cents
  returnReason?: DeReturnReason
}

declare module '../../context.js' {
  interface ServiceMap {
    directEntry: DirectEntryService
  }
}

/** A recipient BSB that always rejects (docs/superpowers spec §5.6 uses the same value for verifyBranchIdentifier). */
export const REJECTING_BSB = '999999'
const BSB_RE = /^\d{6}$/
const ACCOUNT_NUMBER_RE = /^\d{5,9}$/

/** v1 -> v0 status rendering (docs/map/00-open-questions.md S14). */
export const V0_STATUS: Record<DeStatus, DeStatusV0> = {
  RECEIVED: 'ACCEPTED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  SUBMITTED: 'SUBMITTED',
  RETURNED: 'RETURNED',
  COMPLETE: 'SUBMITTED',
  INCOMPLETE: 'RETURNED',
}

/** The v1 statuses a v0 list filter value stands for. */
export function v0FilterStatuses(status: DeStatusV0): DeStatus[] {
  return (Object.keys(V0_STATUS) as DeStatus[]).filter((s) => V0_STATUS[s] === status)
}

/** Ledger refusal on the recipient (debtor) side -> the BECS return reason the debtor institution would quote. */
function returnReasonFor(outcome: LedgerOutcome): DeReturnReason {
  if (outcome === 'REFUSED_ACCOUNT_CLOSED') return 'ACCOUNT_CLOSED'
  if (outcome === 'REFUSED_ACCOUNT_BLOCKED') return 'PAYMENT_STOPPED'
  return 'REFER_TO_CUSTOMER'
}

export class DirectEntryService {
  readonly schedules: ScheduledPaymentsService
  /**
   * Delay of each asynchronous hop (ACCEPTED -> SUBMITTED, SUBMITTED -> COMPLETE). Undefined = the
   * scheduler's default (config.asyncDelayMs). Tests raise it to observe the intermediate statuses and
   * drive the hops with the virtual clock.
   */
  progressDelayMs: number | undefined = undefined

  constructor(private readonly ctx: AppContext, private readonly repo: DirectEntryRepo) {
    this.schedules = new ScheduledPaymentsService(ctx, repo)
  }

  private get accounts() {
    return this.ctx.services.accounts
  }

  private get ledger() {
    return this.ctx.services.transactions
  }

  // ---------------------------------------------------------------- reads

  find(transactionId: string): DeInstruction | undefined {
    return this.repo.instructionById(transactionId)
  }

  /** @throws 404 NOT_FOUND */
  get(transactionId: string): DeInstruction {
    const r = this.repo.instructionById(transactionId)
    if (!r) throw notFound(`NOT_FOUND: Direct Entry transaction ${transactionId} not found`)
    return r
  }

  /**
   * getDirectDebitsV1 / V0: instructions created within [fromUtc, toUtc] (whole days, UTC), optional
   * status filter (v0 values expand to their v1 statuses) and sender account number, creation order.
   * @throws 400 when fromUtc > toUtc, limit is outside 1..1000 or offset is negative
   */
  list(q: ListQuery, statuses?: readonly DeStatus[]): DeInstruction[] {
    if (!isIsoDate(q.fromUtc) || !isIsoDate(q.toUtc)) throw badRequest('BAD_REQUEST: fromUtc and toUtc must be dates (YYYY-MM-DD)')
    if (q.fromUtc > q.toUtc) throw badRequest('BAD_REQUEST: fromUtc must not be after toUtc')
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 1000) throw badRequest('BAD_REQUEST: limit must be between 1 and 1000')
    if (!Number.isInteger(q.offset) || q.offset < 0) throw badRequest('BAD_REQUEST: offset must be 0 or greater')
    return this.repo.listInstructions(compact({
      from: `${q.fromUtc}T00:00:00.000000Z`,
      to: `${addDays(q.toUtc, 1)}T00:00:00.000000Z`,
      statuses,
      senderAccountNumber: q.senderAccountNumber,
      limit: q.limit,
      offset: q.offset,
    }))
  }

  /** Instructions of the account that are not yet terminal (closeAccount's INFLIGHT_OUTBOUND_DIRECT_DEBITS check). */
  inflightFor(accountId: string): DeInstruction[] {
    return this.repo.inflightForAccount(accountId)
  }

  closureErrors(account: Account): ClosureCheckerError[] {
    const inflight = this.inflightFor(account.id)
    if (!inflight.length) return []
    return [{ type: 'INFLIGHT_OUTBOUND_DIRECT_DEBITS', errorMessage: `Account has ${inflight.length} inflight outbound direct entries: [${inflight.map((i) => i.id).join(', ')}]` }]
  }

  detailsV1(r: DeInstruction): DeTransactionDetailsV1 {
    return {
      amount: fromCents(r.amount),
      description: r.description,
      outcome: r.status,
      processingDate: r.processingDate,
      recipientAccountNumber: r.recipientAccountNumber,
      recipientBsb: r.recipientBsb,
      recipientName: r.recipientName,
      senderAccountNumber: r.senderAccountNumber,
      senderBsb: r.senderBsb,
      senderName: r.senderName,
      transactionHayId: r.id,
      type: 'DEBIT',
    }
  }

  detailsV0(r: DeInstruction): DeTransactionDetails {
    return { ...this.detailsV1(r), outcome: V0_STATUS[r.status] }
  }

  responseV1(r: DeInstruction): DirectDebitResponseV1 {
    return compact({ transactionId: r.id, outcome: r.status, details: r.details, transactionDetails: this.detailsV1(r) })
  }

  responseV0(r: DeInstruction): DirectDebitResponse {
    return compact({ transactionId: r.id, outcome: V0_STATUS[r.status], details: r.details, transactionDetails: this.detailsV0(r) })
  }

  statusResponse(r: DeInstruction): DirectEntryStatusResponseV1 {
    return { transactionId: r.id, status: r.status }
  }

  // ---------------------------------------------------------------- create

  /**
   * createDirectDebitV1 / V0 (idempotency is the route's). Validation the schema cannot express is a 400
   * (amount > 0 with <= 2 dp; anchored BSB / account-number patterns); a transactionId already used with
   * another idempotencyKey is 422 DUPLICATE_TRANSACTION_ID. The sender (credited) account must be a local
   * account (BSB 636220 + account number) that is open, and the recipient BSB must not be the rejecting
   * 999999, else the instruction is REJECTED (v1: 200 with the outcome; v0: 422 with the declared
   * DirectDebitResponse body). Otherwise RECEIVED and ACCEPTED are recorded and notified synchronously and
   * the SUBMITTED hop is scheduled.
   */
  create(body: CreateDirectDebitRequestBody, opts: { version: 'v0' | 'v1' }): CreateResult<DirectDebitResponseV1 | DirectDebitResponse> {
    const cents = requestCents(body.amount, 'amount')
    for (const [field, re] of [['senderBsb', BSB_RE], ['recipientBsb', BSB_RE], ['senderAccountNumber', ACCOUNT_NUMBER_RE], ['recipientAccountNumber', ACCOUNT_NUMBER_RE]] as const) {
      if (!re.test(body[field])) throw badRequest(`BAD_REQUEST: ${field} must match ${re.source}`)
    }
    if (this.repo.instructionById(body.transactionId)) {
      throw unprocessable(`DUPLICATE_TRANSACTION_ID: Direct Entry transaction ${body.transactionId} already exists`)
    }

    const now = this.ctx.clock.now()
    const stamp = isoUtc(now)
    const sender = this.resolveSender(body.senderBsb, body.senderAccountNumber)
    const row: DeInstruction = compact({
      id: body.transactionId,
      seq: this.repo.nextInstructionSeq(),
      idempotencyKey: body.idempotencyKey,
      accountId: sender?.id,
      amount: cents,
      description: body.description,
      senderBsb: body.senderBsb,
      senderAccountNumber: body.senderAccountNumber,
      senderName: body.senderName,
      recipientBsb: body.recipientBsb,
      recipientAccountNumber: body.recipientAccountNumber,
      recipientName: body.recipientName,
      status: 'RECEIVED',
      processingDate: nextBusinessDay(isoDate(now)),
      createdAt: stamp,
      updatedAt: stamp,
    })

    let rejection: string | undefined
    if (!sender) rejection = `Sender account not found for BSB ${body.senderBsb} account number ${body.senderAccountNumber}`
    else {
      const gate = this.accounts.requireOpenForMovement(sender.id)
      if (typeof gate === 'string') rejection = gate
      else if (body.recipientBsb === REJECTING_BSB) rejection = `Invalid recipient BSB ${body.recipientBsb}`
    }

    const stored = this.ctx.db.transaction(() => {
      this.repo.insertInstruction(row)
      if (sender) this.emit(row, sender, 'CLIENT')
      if (rejection !== undefined) return this.transition(row, 'REJECTED', 'CLIENT', { details: rejection })
      return this.transition(row, 'ACCEPTED', 'CLIENT')
    })()

    if (stored.status === 'ACCEPTED') this.later(() => this.submit(stored.id))
    if (opts.version === 'v0') return { status: stored.status === 'REJECTED' ? 422 : 200, body: this.responseV0(stored) }
    return { status: 200, body: this.responseV1(stored) }
  }

  /** The local account a BSB + account number denote, if any. */
  resolveSender(bsb: string, accountNumber: string): Account | undefined {
    if (bsb !== LOCAL_BSB) return undefined
    const hit = this.accounts.search(accountNumber)[0]
    return hit?.accountHayId ? this.accounts.find(hit.accountHayId) : undefined
  }

  // ---------------------------------------------------------------- platform progression

  /** ACCEPTED -> SUBMITTED (the next Direct Entry batch); schedules the COMPLETE hop. No-op unless ACCEPTED. */
  submit(transactionId: string): DeInstruction | undefined {
    const r = this.repo.instructionById(transactionId)
    if (!r || r.status !== 'ACCEPTED') return r
    const updated = this.transition(r, 'SUBMITTED', 'PLATFORM')
    this.later(() => this.complete(transactionId))
    return updated
  }

  /**
   * SUBMITTED -> COMPLETE: the DIRECT_DEBIT_TRANSFER credit (positive, CUSCAL_DE_DEBIT_OUT, originType
   * DIRECT_DEBIT, originId = transactionId) is posted to the sender account; a ledger refusal there
   * (MAX_BALANCE, blocked / closed account) leaves the instruction INCOMPLETE with the outcome in
   * `details`. When the recipient is also a local account its debit leg (negative, CUSCAL_DE_DEBIT_IN,
   * DIRECT_DEBIT_PER_DAY + funds) is evaluated first; a refusal there is a return from the debtor
   * institution -> RETURNED. No-op unless SUBMITTED.
   */
  complete(transactionId: string): DeInstruction | undefined {
    const r = this.repo.instructionById(transactionId)
    if (!r || r.status !== 'SUBMITTED' || !r.accountId) return r
    const credit: PostInput = {
      accountId: r.accountId,
      amountCents: r.amount,
      type: 'DIRECT_DEBIT_TRANSFER',
      channel: 'CUSCAL_DE_DEBIT_OUT',
      counterpart: { name: r.recipientName, basicAccountNumber: { accountNumber: r.recipientAccountNumber, branchNumber: r.recipientBsb } },
      description: r.description,
      category: 'BANK_TRANSFER',
      originType: 'DIRECT_DEBIT',
      originId: r.id,
      actionOwner: 'PLATFORM',
    }
    const debtor = this.resolveSender(r.recipientBsb, r.recipientAccountNumber)
    const debit: PostInput | undefined = debtor && {
      accountId: debtor.id,
      amountCents: -r.amount,
      type: 'DIRECT_DEBIT_TRANSFER',
      channel: 'CUSCAL_DE_DEBIT_IN',
      counterpart: { name: r.senderName, basicAccountNumber: { accountNumber: r.senderAccountNumber, branchNumber: r.senderBsb } },
      description: r.description,
      category: 'BANK_TRANSFER',
      originType: 'DIRECT_DEBIT',
      originId: r.id,
      actionOwner: 'PLATFORM',
    }

    return this.ctx.db.transaction(() => {
      if (debit) {
        const refused = this.ledger.evaluate(debit)
        if (refused !== 'ACCEPTED') return this.transition(r, 'RETURNED', 'PLATFORM', { details: refused, returnReason: returnReasonFor(refused) })
      }
      const outcome = this.ledger.evaluate(credit)
      if (outcome !== 'ACCEPTED') return this.transition(r, 'INCOMPLETE', 'PLATFORM', { details: outcome })
      if (debit) this.ledger.apply(debit)
      const posted = this.ledger.apply(credit)
      return this.transition(r, 'COMPLETE', 'PLATFORM', { ledgerTransactionId: posted.id })
    })()
  }

  /**
   * A return from the recipient institution (utilities: generate-de-inbound RETURN/DEBIT), matched to the
   * most recent SUBMITTED (else ACCEPTED) instruction with the same sender BSB + account number + amount.
   * Nothing has moved before COMPLETE, so only the status changes. Returns undefined when nothing matches.
   */
  returnOutbound(input: ReturnInput): DeInstruction | undefined {
    const r = this.repo.findMatching(input.senderBsb, input.senderAccountNumber, input.amountCents, ['SUBMITTED', 'ACCEPTED'])
    if (!r) return undefined
    const reason = input.returnReason ?? 'REFER_TO_CUSTOMER'
    return this.transition(r, 'RETURNED', 'PLATFORM', { details: `Returned by the recipient institution: ${reason}`, returnReason: reason })
  }

  // ---------------------------------------------------------------- internals

  private later(fn: () => void): void {
    if (this.progressDelayMs === undefined) this.ctx.scheduler.later(fn)
    else this.ctx.scheduler.later(fn, this.progressDelayMs)
  }

  private transition(r: DeInstruction, status: DeStatus, actionOwner: ActionOwner, patch: { details?: string; ledgerTransactionId?: string; returnReason?: string } = {}): DeInstruction {
    if (DE_TERMINAL.has(r.status)) throw new Error(`Direct Entry ${r.id} is ${r.status}; cannot move to ${status}`)
    const updatedAt = isoUtc(this.ctx.clock.now())
    this.repo.updateInstruction(r.id, { status, ...patch, updatedAt })
    const updated: DeInstruction = compact({ ...r, status, ...patch, updatedAt })
    const account = updated.accountId ? this.accounts.find(updated.accountId) : undefined
    if (account) this.emit(updated, account, actionOwner, r.status)
    return updated
  }

  private emit(r: DeInstruction, account: Account, actionOwner: ActionOwner, previousStatus?: DeStatus): void {
    this.ctx.events.emit('directEntry.statusChanged', compact({ instruction: r, account, previousStatus, actionOwner }))
  }
}
