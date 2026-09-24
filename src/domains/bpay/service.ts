/**
 * BPAY (spec §5.7): saved billers per account, biller / CRN validation against the directory, and
 * BPAY payments posted through the ledger as BPAY_TRANSFER_OUT (the TRANSACTION webhook with
 * counterpartDetails.bpayDetails is the ledger's). Publishes itself as ctx.services.bpay for the
 * scheduled-payments and utilities domains (post() runs a payment without a request body).
 */
import type { components } from '../../contract/generated/b2b-types.js'
import type { AppContext } from '../../context.js'
import { compact, type ActionOwner } from '../../events/notify.js'
import { isoUtc } from '../../lib/clock.js'
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js'
import { uuid } from '../../lib/ids.js'
import type { Cents } from '../../lib/money.js'
import type { LedgerOutcome, LedgerTransaction, OriginType } from '../transactions/index.js'
import { requestCents } from '../transactions/index.js'
import { lookupBiller, validateDirectory, type CrnFailure, type DirectoryBiller, type DirectoryResult } from './directory.js'
import type { BpayRepo, Page, SavedBiller } from './repo.js'

type S = components['schemas']
export type BPayBillerResponse = S['BPayBillerResponse']
export type BPayBillerDetails = S['BPayBillerDetails']
export type BPayBillerAddRequestBody = S['BPayBillerAddRequestBody']
export type BPayBillerRequestBody = S['BPayBillerRequestBody']
export type BPayBillerUpdateRequestBody = S['BPayBillerUpdateRequestBody']
export type BPayPaymentRequestBody = S['BPayPaymentRequestBody']
export type BpayPaymentResponseBody = S['BpayPaymentResponseBody']
/** BpayPaymentResponseBody.outcome — this endpoint's own 14-value enum. */
export type BpayOutcome = NonNullable<BpayPaymentResponseBody['outcome']>

declare module '../../context.js' {
  interface ServiceMap {
    bpay: BpayService
  }
}

/** A BPAY payment without a request body (scheduled payments, mocks). */
export interface BpayPostInput {
  accountId: string
  /** a positive integer number of cents (400 otherwise) */
  amountCents: Cents
  billerCode: string
  /** customer reference number */
  reference: string
  category?: string
  description?: string
  /** payer-supplied nickname; the biller's registered name when absent (webhook counterpartName) */
  name?: string
  originType?: OriginType
  originId?: string
  /** default PLATFORM (an API call passes CLIENT) */
  actionOwner?: ActionOwner
}

export interface BpayPostResult { outcome: BpayOutcome; transaction?: LedgerTransaction; biller?: DirectoryBiller }

const BPAY_OUTCOMES: ReadonlySet<string> = new Set<BpayOutcome>([
  'ACCEPTED', 'INVALID_PAYMENT', 'REFUSED_INSUFFICIENT_FUNDS', 'INTERNAL_ERROR', 'REFUSED_DAILY_BPAY_LIMIT_BREACHED',
  'REFUSED_BPAY_INVALID_BILLER_CODE', 'REFUSED_BPAY_INVALID_REFERENCE', 'REFUSED_BPAY_INVALID_PAYMENT', 'REFUSED_BPAY_REJECTED',
  'REFUSED_ACCOUNT_BLOCKED', 'REFUSED_RECIPIENT_ACCOUNT_BLOCKED', 'REFUSED_ACCOUNT_CLOSED', 'REFUSED_RECIPIENT_ACCOUNT_CLOSED', 'REFUSED_CAPABILITY_NOT_ENABLED',
])

/**
 * Ledger outcome -> BpayPaymentResponseBody.outcome (spec §4 "Outcome enums": each surface uses its own
 * enum verbatim): the funds check is REFUSED_INSUFFICIENT_FUNDS, the BPAY daily limit
 * REFUSED_DAILY_BPAY_LIMIT_BREACHED; any other limit breach (TOTAL_SPEND_PER_YEAR) has no value of its
 * own on this surface and answers the same limit value [decision]; anything else unmapped is INTERNAL_ERROR.
 */
export function toBpayOutcome(outcome: LedgerOutcome): BpayOutcome {
  if (outcome === 'REFUSED_NOT_ENOUGH_FUNDS') return 'REFUSED_INSUFFICIENT_FUNDS'
  if (outcome === 'REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED') return 'REFUSED_DAILY_BPAY_LIMIT_BREACHED'
  if (BPAY_OUTCOMES.has(outcome)) return outcome as BpayOutcome
  if (outcome.includes('LIMIT')) return 'REFUSED_DAILY_BPAY_LIMIT_BREACHED'
  return 'INTERNAL_ERROR'
}

const REFUSAL_OUTCOME: Record<CrnFailure, BpayOutcome> = {
  BILLER_CODE: 'REFUSED_BPAY_INVALID_BILLER_CODE',
  REFERENCE: 'REFUSED_BPAY_INVALID_REFERENCE',
  AMOUNT: 'REFUSED_BPAY_INVALID_PAYMENT',
}
const REFUSAL_CODE: Record<CrnFailure, string> = { BILLER_CODE: 'INVALID_BILLER_CODE', REFERENCE: 'INVALID_REFERENCE', AMOUNT: 'INVALID_PAYMENT' }

export class BpayService {
  constructor(private readonly ctx: AppContext, private readonly repo: BpayRepo) {}

  private get accounts() {
    return this.ctx.services.accounts
  }

  // ---------------------------------------------------------------- directory

  /** Directory entry for a biller code (active or deactivated), undefined when the code is not a biller code. */
  biller(billerCode: string): DirectoryBiller | undefined {
    return lookupBiller(billerCode)
  }

  /** Biller code, CRN and (optionally) amount against the directory; the first failure names the field. */
  validate(billerCode: string, reference: string, amountCents?: Cents): DirectoryResult {
    return validateDirectory(billerCode, reference, amountCents)
  }

  /**
   * validateBpay: the biller's directory details with the reference echoed as referenceNumber.
   * @throws 422 INVALID_BILLER_CODE / INVALID_REFERENCE
   */
  validateBpay(body: BPayBillerRequestBody): BPayBillerDetails {
    const biller = this.requireValid(body.billerCode, body.reference)
    return details(biller, body.reference)
  }

  private requireValid(billerCode: string, reference: string): DirectoryBiller {
    const v = this.validate(billerCode, reference)
    if (!v.ok) throw unprocessable(`${REFUSAL_CODE[v.failure]}: ${v.message}`)
    return v.biller
  }

  // ---------------------------------------------------------------- saved billers

  /**
   * createBPayBiller: the account must exist (404), the nickname must not be blank (400 — the schema
   * leaves it unconstrained), the biller code / CRN must pass the directory rules (422), and no active
   * biller of the account may already hold the same (billerCode, reference) pair or the same trimmed
   * nickname (409 Conflict — the one declared 409 in the contract). Status ACTIVE; the image is the
   * directory's logo URL.
   */
  createBiller(accountId: string, body: BPayBillerAddRequestBody): SavedBiller {
    this.accounts.get(accountId)
    const name = nickname(body.name)
    const biller = this.requireValid(body.billerCode, body.reference)
    if (this.repo.activeByCodeAndReference(accountId, body.billerCode, body.reference)) {
      throw conflict(`DUPLICATE_BILLER: Biller code ${body.billerCode} with reference ${body.reference} is already saved on account ${accountId}`)
    }
    if (this.repo.activeByName(accountId, name)) throw conflict(`DUPLICATE_BILLER_NAME: A biller named ${name} is already saved on account ${accountId}`)
    const b: SavedBiller = {
      id: uuid(),
      accountId,
      billerCode: body.billerCode,
      reference: body.reference,
      name,
      image: biller.image,
      shortName: biller.shortName,
      longName: biller.longName,
      industryAnzsicCode: biller.industryAnzsicCode,
      status: 'ACTIVE',
      createdAt: isoUtc(this.ctx.clock.now()),
    }
    this.repo.insert(b)
    this.ctx.events.emit('bpay.billerChanged', { biller: b, kind: 'CREATED' })
    return b
  }

  /** retrieveBillers: the account's ACTIVE billers, creation order, paged. @throws 404 unknown account */
  listBillers(accountId: string, page: Page): SavedBiller[] {
    this.accounts.get(accountId)
    return this.repo.activeForAccount(accountId, page)
  }

  find(id: string): SavedBiller | undefined {
    return this.repo.byId(id)
  }

  /** retrieveBpayBiller (every status). @throws 404 NOT_FOUND */
  getBiller(id: string): SavedBiller {
    const b = this.repo.byId(id)
    if (!b) throw notFound(`NOT_FOUND: Biller ${id} not found`)
    return b
  }

  /**
   * updateBpayBiller: partial update of name / image / reference / status. A new reference must pass
   * the biller's CRN rules and, like a new name (trimmed, not blank — 400), the uniqueness rules (422
   * here — 409 is not declared).
   * DISMISSED is terminal: a dismissed biller accepts no further change (422 INVALID_STATE), and it
   * frees its name and reference for the account. status outside ACTIVE / DISMISSED is a 400.
   * @throws 404; 400; 422
   */
  updateBiller(id: string, body: BPayBillerUpdateRequestBody): SavedBiller {
    const b = this.getBiller(id)
    if (body.status !== undefined && body.status !== 'ACTIVE' && body.status !== 'DISMISSED') throw badRequest('BAD_REQUEST: status must be ACTIVE or DISMISSED')
    const name = body.name === undefined ? undefined : nickname(body.name)
    if (b.status === 'DISMISSED') throw unprocessable(`INVALID_STATE: Biller ${id} is DISMISSED`)
    if (body.reference !== undefined && body.reference !== b.reference) {
      this.requireValid(b.billerCode, body.reference)
      if (this.repo.activeByCodeAndReference(b.accountId, b.billerCode, body.reference, b.id)) {
        throw unprocessable(`DUPLICATE_BILLER: Biller code ${b.billerCode} with reference ${body.reference} is already saved on account ${b.accountId}`)
      }
    }
    if (name !== undefined && this.repo.activeByName(b.accountId, name, b.id)) {
      throw unprocessable(`DUPLICATE_BILLER_NAME: A biller named ${name} is already saved on account ${b.accountId}`)
    }
    if (name !== undefined) b.name = name
    if (body.image !== undefined) b.image = body.image
    if (body.reference !== undefined) b.reference = body.reference
    if (body.status !== undefined) b.status = body.status
    b.updatedAt = isoUtc(this.ctx.clock.now())
    this.repo.save(b)
    this.ctx.events.emit('bpay.billerChanged', { biller: b, kind: b.status === 'DISMISSED' ? 'DISMISSED' : 'UPDATED' })
    return b
  }

  /** BPayBillerResponse body (status stays internal, as in the contract). */
  toResponse(b: SavedBiller): BPayBillerResponse {
    return compact({
      hayId: b.id,
      accountHayId: b.accountId,
      name: b.name,
      image: b.image,
      billerDetails: details(b, b.reference),
    })
  }

  // ---------------------------------------------------------------- payments

  /**
   * makeBpayPayment: amount is a positive magnitude with <= 2 dp (400 otherwise); the account and the
   * sender customer must exist (404) and the customer must hold the account (422 PERMISSION_DENIED);
   * then post(). Refusals are HTTP 200 with the outcome and no transactionId. Idempotency is the route's.
   */
  pay(accountId: string, body: BPayPaymentRequestBody, opts: { actionOwner?: ActionOwner } = {}): BpayPaymentResponseBody {
    const amountCents = requestCents(body.amount, 'amount')
    const account = this.accounts.get(accountId)
    this.ctx.services.customers.get(body.senderCustomerHayId)
    if (!this.accounts.holderCustomerIds(account).includes(body.senderCustomerHayId)) {
      throw unprocessable(`PERMISSION_DENIED: Customer ${body.senderCustomerHayId} does not hold account ${accountId}`)
    }
    const r = this.post(compact({
      accountId,
      amountCents,
      billerCode: body.billerCode,
      reference: body.reference,
      category: body.category,
      description: body.description,
      name: body.name,
      originType: 'CUSTOMER',
      actionOwner: opts.actionOwner ?? 'CLIENT',
    }))
    const out: BpayPaymentResponseBody = { outcome: r.outcome }
    if (r.transaction) out.transactionId = r.transaction.id
    return out
  }

  /**
   * Posts a BPAY payment: account status (REFUSED_ACCOUNT_BLOCKED / _CLOSED) -> an FX child cannot pay
   * BPAY (REFUSED_CAPABILITY_NOT_ENABLED) -> biller code, CRN and amount against the directory
   * (REFUSED_BPAY_INVALID_BILLER_CODE / _REFERENCE / _PAYMENT) -> the ledger's BPAY_DAILY_LIMIT and
   * TOTAL_SPEND_PER_YEAR checks and the funds check. Accepted: BPAY_TRANSFER_OUT on channel
   * CUSCAL_BPAY_TRANSFER_OUT is posted immediately (no hold), the CRN stored as the transaction reference,
   * the counterpart carrying the nickname and bpayDetails; the ledger emits the TRANSACTION webhook.
   * Refusals post nothing and emit no webhook. A blank nickname counts as absent.
   * @throws 400 amountCents not a positive integer; 404 unknown account
   */
  post(input: BpayPostInput): BpayPostResult {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw badRequest('BAD_REQUEST: amountCents must be a positive integer')
    const account = this.accounts.get(input.accountId)
    const gate = this.accounts.requireOpenForMovement(account.id)
    if (typeof gate === 'string') return { outcome: gate }
    if (account.parentAccountId) return { outcome: 'REFUSED_CAPABILITY_NOT_ENABLED' }
    const v = this.validate(input.billerCode, input.reference, input.amountCents)
    if (!v.ok) return { outcome: REFUSAL_OUTCOME[v.failure] }
    const biller = v.biller
    const r = this.ctx.services.transactions.post(compact({
      accountId: account.id,
      amountCents: -input.amountCents,
      type: 'BPAY_TRANSFER_OUT',
      channel: 'CUSCAL_BPAY_TRANSFER_OUT',
      counterpart: {
        name: input.name?.trim() || biller.longName,
        bpayDetails: { billerCode: biller.billerCode, billerReference: input.reference, billerName: biller.longName, billerImage: biller.image },
      },
      description: input.description,
      category: input.category,
      reference: input.reference,
      originType: input.originType,
      originId: input.originId,
      actionOwner: input.actionOwner ?? 'PLATFORM',
    }))
    if (!r.transaction) return { outcome: toBpayOutcome(r.outcome), biller }
    this.ctx.events.emit('bpay.paymentAccepted', { transaction: r.transaction, biller, accountId: account.id })
    return { outcome: 'ACCEPTED', transaction: r.transaction, biller }
  }
}

/** A saved biller's nickname as stored: trimmed, and never blank. @throws 400 */
function nickname(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw badRequest('BAD_REQUEST: name must not be blank')
  return trimmed
}

function details(b: Pick<DirectoryBiller, 'billerCode' | 'shortName' | 'longName' | 'industryAnzsicCode'>, reference: string): BPayBillerDetails {
  return { billerCode: b.billerCode, shortName: b.shortName, longName: b.longName, industryAnzsicCode: b.industryAnzsicCode, referenceNumber: reference }
}
