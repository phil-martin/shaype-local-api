/**
 * PayTo mandates (spec §5.11, docs/map/payto.md): the mandate status machine on both sides, the MMS
 * action log, payment instructions (adhoc, scheduled, inbound RAPAIN, stubbed) settled through the
 * ledger, and the MANDATE / MANDATE_PAYMENT / MANDATE_DUE_PAYMENT notifications (events.ts).
 * Publishes itself as ctx.services.payto for the utilities mock generators.
 *
 * Single tenant: the client is the Initiator of every mandate whose creditor account is local and the
 * Payer of every mandate whose debtor account is local. Payer-only operations on a mandate whose debtor
 * is not on the platform are refused with 403.
 */
import { randomUUID } from 'node:crypto'
import type { components } from '../../contract/generated/b2b-types.js'
import type { AppContext } from '../../context.js'
import { compact, type ActionOwner } from '../../events/notify.js'
import { isoDate, isoUtc } from '../../lib/clock.js'
import { badRequest, forbidden, notFound, unprocessable } from '../../lib/errors.js'
import { LOCAL_BSB, uuid } from '../../lib/ids.js'
import { fromCents, hasAtMostTwoDecimals, toCents, type Cents } from '../../lib/money.js'
import type { Account } from '../accounts/repo.js'
import type { PayIdDep, PayIdType } from '../transactions/deps.js'
import type { LedgerOutcome, PostInput } from '../transactions/service.js'
import type {
  AccountAliasType, ActionDetails, ActionStatus, ActionType, AmendProposal, CxMandateStatus, Frequency, InstructionOrigin, InstructionStatus, Mandate,
  MandateAction, MandateRepo, MandateSide, MandateStatus, MmsInstructionStatus, Money, PartyDetails, PartyInformation, PartyRole, PaymentInformation,
  PaymentInstruction, PaymentTerms, ScheduledPayment, StatusChange,
} from './repo.js'

type S = components['schemas']
export type CreateMandateRequestBody = S['CreateMandateRequestBody']
export type CreatePaymentTermsDto = S['CreatePaymentTermsDto']
export type CurrencyAmount = S['CurrencyAmount']
export type AmendMandateByInitiatorRequestBody = S['AmendMandateByInitiatorRequestBody']
export type AmendMandateByPayerRequestBody = S['AmendMandateByPayerRequestBody']
export type AmendMandatePaymentTermsRequestBody = S['AmendMandatePaymentTermsRequestBody']
export type CancelMandateRequestBody = S['CancelMandateRequestBody']
export type SuspendMandateRequestBody = S['SuspendMandateRequestBody']
export type MakeAdhocPaymentRequestBody = S['MakeAdhocPaymentRequestBody']
export type MakeAdhocPaymentResponseBody = S['MakeAdhocPaymentResponseBody']
export type SetScheduledPaymentInitiationAmountRequestBody = S['SetScheduledPaymentInitiationAmountRequestBody']
export type GetMandateResponseBody = S['GetMandateResponseBody']
export type GetMandateSummaryDto = S['GetMandateSummaryDto']
export type GetMandateActionsActionDto = S['GetMandateActionsActionDto']
export type GetMandatePaymentStatusResponseBody = S['GetMandatePaymentStatusResponseBody']
export type PaymentInstructionDto = S['PaymentInstruction']
export type PaymentInstructionSummary = S['PaymentInstructionSummary']
export type MandateDetailsDto = S['GenerateMandateNotificationMandateDetailsDto']
export type Resolution = 'ACCEPT' | 'REJECT'

/** MandateEventDto.trigger (32 MMS codes). */
export type MandateTrigger =
  | 'MAMN' | 'MAMP' | 'MAMR' | 'MAMX' | 'MCRP' | 'MCRR' | 'MCRT' | 'MCRX' | 'MPOF' | 'MPOT' | 'MPOX' | 'MSCH' | 'CSCH'
  | 'PAMC' | 'PAMD' | 'PAMN' | 'PCRC' | 'PCRD' | 'PPOT' | 'PSCH' | 'PPOI' | 'PPOR' | 'MCRC' | 'MCRD' | 'MAMC' | 'MAMD'
  | 'CCRR' | 'IAMN' | 'ISCH' | 'IAMP' | 'IAMR' | 'ICRR'

/** Verbatim trigger meanings from MandateEventDto.trigger; also the webhook `description`. */
export const TRIGGER_DESCRIPTION: Record<MandateTrigger, string> = {
  CCRR: 'Cuscal mandate create recalled', CSCH: 'Cuscal mandate status changed', IAMN: 'Initiator mandate amended',
  IAMP: 'Initiator mandate amend proposed', IAMR: 'Initiator mandate amend recalled', ICRR: 'Initiator mandate create recalled',
  ISCH: 'Initiator mandate status changed', MAMC: 'Mandate amend confirmed', MAMD: 'Mandate amend declined', MAMN: 'Mandate amended',
  MAMP: 'Mandate amend proposed', MAMR: 'Mandate amend recalled', MAMX: 'Mandate amend expired', MCRC: 'Mandate create confirmed',
  MCRD: 'Mandate create declined', MCRP: 'Mandate create proposed', MCRR: 'Mandate create recalled', MCRT: 'Mandate created',
  MCRX: 'Mandate create expired', MPOF: 'Mandate port finalised', MPOT: 'Mandate ported', MPOX: 'Mandate port expired',
  MSCH: 'Mandate status changed', PAMC: 'Payer mandate amend confirmed', PAMD: 'Payer mandate amend declined', PAMN: 'Payer mandate amended',
  PCRC: 'Payer mandate create confirmed', PCRD: 'Payer mandate create declined', PPOI: 'Payer mandate port initiated',
  PPOR: 'Payer mandate port recalled', PPOT: 'Payer mandate ported', PSCH: 'Payer mandate status changed',
}
export const MANDATE_TRIGGERS = Object.keys(TRIGGER_DESCRIPTION) as MandateTrigger[]

/** MakeAdhocPaymentResponseBody.transactionStatusDisplay (documented pairs plus the same style for the rest). */
export const STATUS_DISPLAY: Record<InstructionStatus, string> = {
  RECEIVED: 'Received', UNDELIVERED: 'Undelivered', SENT: 'Sent', STORE_AND_FORWARD: 'Store & Forward',
  ACCEPTED_FOR_CLEARANCE: 'Accepted for Clearance', SETTLEMENT_ABORTED: 'Settlement Aborted', ACCEPTED_AND_SETTLED: 'Accepted and Settled',
  REJECTED: 'Rejected', PENDING: 'Pending',
}
export const MMS_STATUS: Record<MmsInstructionStatus, InstructionStatus> = {
  RECV: 'RECEIVED', UNDV: 'UNDELIVERED', SENT: 'SENT', SAFD: 'STORE_AND_FORWARD', ACCP: 'ACCEPTED_FOR_CLEARANCE', ACSP: 'SETTLEMENT_ABORTED', ACSC: 'ACCEPTED_AND_SETTLED', RJCT: 'REJECTED',
}
const FINAL_STATUSES: ReadonlySet<InstructionStatus> = new Set(['UNDELIVERED', 'ACCEPTED_AND_SETTLED', 'REJECTED'])
export const isFinalStatus = (s: InstructionStatus): boolean => FINAL_STATUSES.has(s)

/** MandatePaymentEventDto.paymentStatus per instruction status. */
export const PAYMENT_STATUS: Record<InstructionStatus, string> = {
  RECEIVED: 'MANDATE_PAYMENT_RECEIVED', UNDELIVERED: 'MANDATE_PAYMENT_UNDELIVERED', SENT: 'MANDATE_PAYMENT_SENT', STORE_AND_FORWARD: 'MANDATE_PAYMENT_STORE_AND_FORWARD',
  ACCEPTED_FOR_CLEARANCE: 'MANDATE_PAYMENT_ACCEPTED_FOR_CLEARANCE', SETTLEMENT_ABORTED: 'MANDATE_PAYMENT_SETTLEMENT_ABORTED', ACCEPTED_AND_SETTLED: 'MANDATE_PAYMENT_ACCEPTED',
  REJECTED: 'MANDATE_PAYMENT_REJECTED', PENDING: 'MANDATE_PAYMENT_PENDING',
}

export const SUCCESS_MESSAGE = {
  amended: 'Mandate amended successfully.',
  amendProposed: 'Mandate payment terms amendment proposed successfully.',
  suspended: 'Mandate suspended successfully.',
  released: 'Mandate released successfully.',
  cancelled: 'Mandate cancelled successfully.',
  resolved: 'Mandate resolved successfully.',
  recalled: 'Mandate action recalled successfully.',
  amountSet: 'Scheduled payment amount set successfully.',
  adhoc: 'Adhoc payment executed successfully.',
} as const

/** The documented createMandate system rejection, reused for the debtor side. */
export const ACCOUNT_DETAILS_INCORRECT = (party: 'Creditor' | 'Debtor') => `NOT_FOUND: CUS.API.100522 - ${party} account details incorrect (M900 - No matching record found)`
export const BIC = 'ANNCAU22XXX'
/** Every 6-digit BSB supports PayTo except the staging fixture 000000 and the local "unsupported" BSB 999999 (spec §5.6). */
export const UNSUPPORTED_BSBS: ReadonlySet<string> = new Set(['000000', '999999'])
export const NOT_PROVIDED = 'Not provided'
const DAY_MS = 24 * 60 * 60 * 1000
/** MMS authorisation window for bilateral actions (docs: 6 days). */
export const ACTION_EXPIRY_MS = 6 * DAY_MS
/** Lead time between MANDATE_DUE_PAYMENT and the scheduled initiation. */
export const DUE_PAYMENT_LEAD_MS = DAY_MS

const HEX32 = /^[0-9a-f]{32}$/i
const UUID36 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BSB_ACCOUNT_RE = /^\d{11,15}$/
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/

/** Hyphenated lowercase form of a mandate / action id given in either encoding (unknown shapes pass through). */
export function normaliseMandateId(id: string): string {
  if (HEX32.test(id)) return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`.toLowerCase()
  return UUID36.test(id) ? id.toLowerCase() : id
}
/** The 32-hex MMS form ("UUID version 1 without the 4 hyphen separators"). */
export const mmsId = (id: string): string => normaliseMandateId(id).replace(/-/g, '')
/** A random id in the UUID v1 layout the spec's action DTOs require (version nibble 1, RFC variant). */
export function v1Uuid(): string {
  const u = randomUUID()
  return `${u.slice(0, 14)}1${u.slice(15)}`
}

export interface MandatePage { pageNumber: number; pageSize: number }
export interface ActionsQuery { from?: string; to?: string; pendingOnly?: boolean }

export interface NotificationDetails {
  /** MMS action id (either encoding); defaults to the action the trigger concerns, else the latest action */
  actionId?: string
  description?: string
  actionOwner?: ActionOwner
  /** GenerateMandateNotificationMandateDetailsDto: creates the mandate locally when it is unknown (an external Initiator's mandate reaching a local Payer) */
  mandateDetails?: MandateDetailsDto
}

export interface ReceivePaymentInput {
  mandateId: string
  instructionId: string
  /** positive cents */
  amountCents: Cents
  currency?: string
  initiatingPartyName?: string
  status: 'ACCP' | 'RJCT'
  reasonCode?: string
  endToEndId?: string
  description?: string
  actionOwner?: ActionOwner
}

export interface PaymentOutcome { status: InstructionStatus; reasonCode?: string; transactionId?: string }

declare module '../../context.js' {
  interface ServiceMap {
    payto: PayToService
  }
}

export class PayToService {
  /**
   * Delay of the asynchronous hop of a staging payment trajectory (non-final -> final status). Undefined =
   * the scheduler's default (config.asyncDelayMs). Tests raise it to observe the non-final status and drive
   * the hop with the virtual clock.
   */
  paymentProgressDelayMs: number | undefined = undefined

  constructor(private readonly ctx: AppContext, private readonly repo: MandateRepo) {}

  private get accounts() { return this.ctx.services.accounts }
  private get customers() { return this.ctx.services.customers }
  private get transactions() { return this.ctx.services.transactions }
  private get payid(): PayIdDep | undefined { return (this.ctx.services as Partial<{ payid: PayIdDep }>).payid }

  // ---------------------------------------------------------------- reads

  find(id: string): Mandate | undefined {
    return this.repo.mandateById(normaliseMandateId(id))
  }

  /** @throws 404 NOT_FOUND */
  get(id: string): Mandate {
    const m = this.find(id)
    if (!m) throw notFound(`NOT_FOUND: Mandate ${id} not found`)
    return m
  }

  require(id: string): Mandate {
    return this.get(id)
  }

  /** The client is the Payer only for a local debtor account. @throws 404 unknown, 403 otherwise */
  requireAsPayer(id: string): Mandate {
    const m = this.get(id)
    if (!m.debtor.accountId) throw forbidden(`FORBIDDEN: the client is not the Payer of mandate ${m.id}`)
    return m
  }

  /** The client is the Initiator only for a local creditor account (not for a mandate an external Initiator sent). @throws 404 unknown, 403 otherwise */
  requireAsInitiator(id: string): Mandate {
    const m = this.get(id)
    if (!m.creditor.accountId) throw forbidden(`FORBIDDEN: the client is not the Initiator of mandate ${m.id}`)
    return m
  }

  requireAs(id: string, side: 'INITIATOR' | 'PAYER'): Mandate {
    return side === 'PAYER' ? this.requireAsPayer(id) : this.requireAsInitiator(id)
  }

  actions(id: string, q: ActionsQuery = {}): MandateAction[] {
    const m = this.get(id)
    const now = this.ctx.clock.now().getTime()
    const bound = (v: string | undefined, name: string, fallback: number): number => {
      if (v === undefined) return fallback
      const t = new Date(v).getTime()
      if (!Number.isFinite(t)) throw badRequest(`BAD_REQUEST: ${name} is not a valid ISO-8601 UTC date-time`)
      if (t > now) throw badRequest(`BAD_REQUEST: ${name} must not be a time in the future`)
      return t
    }
    const from = bound(q.from, 'from', new Date(m.createdAt).getTime())
    const to = bound(q.to, 'to', now)
    if (from > to) throw badRequest('BAD_REQUEST: from must not be after to')
    return this.repo.actionsForMandate(m.id).filter((a) => {
      const t = new Date(a.creationTime).getTime()
      return t >= from && t <= to && (!q.pendingOnly || a.status === 'PENDING')
    })
  }

  mandateIdsForCreditorAccount(accountId: string): string[] {
    this.accounts.get(accountId)
    return this.repo.mandateIdsForCreditorAccount(accountId)
  }

  /**
   * getMandates: Payer-side search by debtor BSB + account numbers (repeated or comma-separated; a platform
   * account id is accepted too, matching the debtor account), 1-based pages of at most 50.
   */
  search(accountIds: string[], statuses: MandateStatus[] | undefined, page: MandatePage): { result: Mandate[]; totalCount: number } {
    const values = [...new Set(accountIds.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean))]
    const debtorAccountIds = values.filter((v) => UUID36.test(v)).map((v) => v.toLowerCase())
    const debtorAccountNumbers = values.filter((v) => !UUID36.test(v)).map((v) => v.replace(/[\s-]/g, ''))
    return this.repo.searchMandates({ debtorAccountNumbers, debtorAccountIds, statuses }, { offset: (page.pageNumber - 1) * page.pageSize, limit: page.pageSize })
  }

  instructions(mandateId: string): PaymentInstruction[] {
    return this.repo.instructionsForMandate(this.get(mandateId).id)
  }

  /** @throws 404 when the instruction is unknown or belongs to another mandate */
  instruction(mandateId: string, instructionId: string): PaymentInstruction {
    const m = this.get(mandateId)
    const i = this.repo.instructionById(instructionId)
    if (!i || i.mandateId !== m.id) throw notFound(`NOT_FOUND: Payment instruction ${instructionId} not found for mandate ${m.id}`)
    return i
  }

  schedule(mandateId: string): ScheduledPayment | undefined {
    return this.repo.scheduleForMandate(normaliseMandateId(mandateId))
  }

  bsbSupported(bsb: string): boolean {
    return /^\d{6}$/.test(bsb) && !UNSUPPORTED_BSBS.has(bsb)
  }

  // ---------------------------------------------------------------- responses

  mandatesForAccount(accountId: string): Mandate[] {
    return this.repo.mandatesForAccount(accountId)
  }

  toResponse(m: Mandate): GetMandateResponseBody {
    return compact({
      mandateId: m.id,
      // creditorDetails.accountId is required by the DTO: a mandate known only through an MMS notification has none, so the object is omitted
      creditorDetails: m.creditor.accountId
        ? { accountId: m.creditor.accountId, partyReference: m.creditor.partyReference, partyType: m.creditor.partyType, ultimatePartyName: m.creditor.ultimatePartyName }
        : undefined,
      debtorDetails: {
        accountId: m.debtor.accountId, accountNumber: m.debtor.accountNumber, partyName: m.debtor.partyName, partyReference: m.debtor.partyReference,
        partyType: m.debtor.partyType, ultimatePartyName: m.debtor.ultimatePartyName,
      },
      description: m.description,
      paymentTerms: termsToJson(m.paymentTerms),
      purposeCode: m.purposeCode,
      registrationDateTime: m.registrationDateTime,
      status: m.status,
      transferArrangement: m.transferArrangement,
      validityEndDate: m.validityEndDate,
      validityStartDate: m.validityStartDate,
    })
  }

  toSummary(m: Mandate): GetMandateSummaryDto {
    const t = m.paymentTerms
    // purposeCode is required by the DTO but absent on a mandate known only through an MMS notification
    return compact({
      debtorAccountId: m.debtor.accountId,
      description: m.description,
      mandateId: m.id,
      paymentTerms: compact({ amount: moneyJson(t.amount), frequency: t.frequency, maximumAmount: moneyJson(t.maximumAmount) }),
      purposeCode: m.purposeCode,
      status: m.status,
      validityEndDate: m.validityEndDate,
    }) as GetMandateSummaryDto
  }

  /** GetMandateActionsActionDto (its generated TS type carries the spec's comma-joined enums, hence the cast). */
  actionToResponse(a: MandateAction): GetMandateActionsActionDto {
    return compact({
      actionIdentification: a.id,
      mandateIdentification: a.mandateId,
      type: a.type,
      status: a.status,
      bilateral: a.bilateral,
      notificationPriority: 'NORMAL',
      creationEvent: { partyRole: a.partyRole, servicerBic: BIC, sponsorBic: BIC, time: a.creationTime },
      resolutionEvent: a.resolutionTime
        ? compact({ time: a.resolutionTime, servicerBic: BIC, sponsorBic: BIC, reasonCode: a.resolutionReasonCode, reasonDescription: a.resolutionReasonDescription })
        : undefined,
      details: a.details,
      expiryTime: a.expiryTime,
      resolutionRequestedBy: a.resolutionRequestedBy,
      cxEventNameCreation: a.cxEventNameCreation,
      cxEventNameResolution: a.cxEventNameResolution,
    }) as unknown as GetMandateActionsActionDto
  }

  instructionToResponse(i: PaymentInstruction): PaymentInstructionDto {
    return compact({ id: i.id, amount: fromCents(i.amountCents), creationDateTime: i.creationDateTime, endToEndId: i.endToEndId, transactionStatus: i.status, transactionStatusReasonCode: i.reasonCode })
  }

  paymentStatus(mandateId: string, instructionId: string): GetMandatePaymentStatusResponseBody {
    const i = this.instruction(mandateId, instructionId)
    return compact({ transactionStatus: i.status, transactionStatusReasonCode: i.reasonCode }) as GetMandatePaymentStatusResponseBody
  }

  // ---------------------------------------------------------------- create

  /** createMandate (the route owns idempotency): CREATED with a pending bilateral CREATE action; MCRT to a local Payer. */
  create(body: CreateMandateRequestBody, opts: { actionOwner?: ActionOwner } = {}): Mandate {
    const creditorAccount = this.accounts.find(body.creditorDetails.accountId)
    if (!creditorAccount || creditorAccount.status === 'CLOSED') throw unprocessable(ACCOUNT_DETAILS_INCORRECT('Creditor'))
    const creditor: PartyDetails = compact({
      accountId: creditorAccount.id,
      accountNumber: creditorAccount.bsb + creditorAccount.accountNumber,
      accountAliasIdentification: body.creditorDetails.accountAliasIdentification,
      accountAliasType: body.creditorDetails.accountAliasType,
      partyReference: body.creditorDetails.partyReference,
      partyType: body.creditorDetails.partyType,
      ultimatePartyName: body.creditorDetails.ultimatePartyName,
    })
    const debtor = this.resolveDebtor(body.debtorDetails)
    if (debtor.accountId === creditor.accountId) throw unprocessable('INVALID_ARGUMENT: the debtor account must differ from the creditor account')
    const paymentTerms = parseTerms(body.paymentTerms)
    if (body.validityEndDate && body.validityEndDate < body.validityStartDate) throw unprocessable('INVALID_ARGUMENT: validityEndDate must not precede validityStartDate')
    if (body.resolutionRequestedBy !== undefined && !ISO_DATETIME_RE.test(body.resolutionRequestedBy)) throw badRequest('BAD_REQUEST: resolutionRequestedBy must be a UTC date-time like 2023-09-10T10:00:00.000Z')

    const now = this.ctx.clock.now()
    const m: Mandate = compact({
      id: v1Uuid(),
      status: 'CREATED' as const,
      cxStatus: 'ACTION_REQUIRED' as const,
      creditor,
      debtor,
      description: body.description,
      purposeCode: body.purposeCode,
      transferArrangement: body.transferArrangement,
      validityStartDate: body.validityStartDate,
      validityEndDate: body.validityEndDate,
      paymentTerms,
      resolutionRequestedBy: body.resolutionRequestedBy,
      registrationDateTime: isoUtc(now),
      createdAt: isoUtc(now),
    })
    const actionOwner = opts.actionOwner ?? 'CLIENT'
    const action = this.ctx.db.transaction(() => {
      this.repo.insertMandate(m)
      const a = this.addAction(m, {
        type: 'CREATE', status: 'PENDING', bilateral: true, partyRole: 'PAYMENT_INITIATOR', expires: true, resolutionRequestedBy: body.resolutionRequestedBy,
        details: { creation: this.creationDetails(m, body) }, cxEventNameCreation: 'Payment agreement received',
      })
      return a
    })()
    this.ctx.events.emit('mandate.created', { mandate: m })
    this.notify(m, 'PAYER', 'MCRT', action, actionOwner)
    return m
  }

  /**
   * Debtor identification: accountId (local account) | accountNumber (BSB + account; the local BSB must
   * resolve to a local account, any other BSB is an external debtor) | alias
   * (resolved through the PayID service when one is loaded, else external).
   */
  private resolveDebtor(d: CreateMandateRequestBody['debtorDetails']): PartyDetails {
    const out: PartyDetails = compact({
      accountAliasIdentification: d.accountAliasIdentification, accountAliasType: d.accountAliasType, partyName: d.partyName,
      partyReference: d.partyReference, partyType: d.partyType, ultimatePartyName: d.ultimatePartyName,
    })
    const hasAlias = d.accountAliasIdentification !== undefined || d.accountAliasType !== undefined
    if (hasAlias && (!d.accountAliasIdentification || !d.accountAliasType)) throw badRequest('BAD_REQUEST: debtorDetails.accountAliasIdentification and accountAliasType must be given together')
    if (!d.accountId && !d.accountNumber && !hasAlias) throw badRequest('BAD_REQUEST: debtorDetails must identify the debtor by accountId, accountNumber or account alias')
    if (d.accountId) {
      const a = this.accounts.find(d.accountId)
      if (!a || a.status === 'CLOSED') throw unprocessable(ACCOUNT_DETAILS_INCORRECT('Debtor'))
      if (d.accountNumber && d.accountNumber !== a.bsb + a.accountNumber) throw unprocessable('INVALID_ARGUMENT: debtorDetails.accountNumber does not match debtorDetails.accountId')
      return { ...out, accountId: a.id, accountNumber: a.bsb + a.accountNumber }
    }
    if (d.accountNumber) {
      if (!BSB_ACCOUNT_RE.test(d.accountNumber)) throw badRequest('BAD_REQUEST: debtorDetails.accountNumber must be a 6-digit BSB followed by a 5-9 digit account number')
      // no PayTo-support check: "For the debtor, any BSB can be used when creating a mandate" (checkBsbIsSupportedByPayTo is advisory)
      const local = this.localAccountByNumber(d.accountNumber)
      if (d.accountNumber.startsWith(LOCAL_BSB) && !local) throw unprocessable(ACCOUNT_DETAILS_INCORRECT('Debtor'))
      return local ? { ...out, accountId: local.id, accountNumber: d.accountNumber } : { ...out, accountNumber: d.accountNumber }
    }
    const resolved = this.resolveAlias(d.accountAliasIdentification!, d.accountAliasType!)
    if (!resolved) return out
    const local = this.localAccountByNumber(resolved)
    return local ? { ...out, accountId: local.id, accountNumber: resolved } : { ...out, accountNumber: resolved }
  }

  private localAccountByNumber(bsbAndNumber: string): Account | undefined {
    if (!bsbAndNumber.startsWith(LOCAL_BSB)) return undefined
    const hit = this.accounts.search(bsbAndNumber.slice(6)).find((a) => a.status !== 'CLOSED') ?? this.accounts.search(bsbAndNumber.slice(6))[0]
    return hit?.accountHayId ? this.accounts.find(hit.accountHayId) : undefined
  }

  /**
   * BSB + account number behind an account alias: a PayID registered on the platform (PayID service), else
   * the staging alias form `<bsb><account number>@<domain>` (EMAIL_ADDRESS), else undefined (external).
   */
  private resolveAlias(alias: string, type: AccountAliasType): string | undefined {
    const payIdType: Record<AccountAliasType, PayIdType> = { EMAIL_ADDRESS: 'EMAIL', PHONE_NUMBER: 'TELEPHONE', AUSTRALIAN_BUSINESS_NUMBER: 'INDIVIDUAL_AUSTRALIAN_BUSINESS', ORGANISATION_ID: 'ORGANISATION' }
    try {
      const r = this.payid?.resolve(alias, payIdType[type])
      if (r) return r.branchNumber + r.accountNumber
    } catch {
      // an unknown / malformed PayID is not an error here: the alias may still be external
    }
    const staging = type === 'EMAIL_ADDRESS' ? /^(\d{11,15})@[^@\s]+$/.exec(alias) : null
    return staging?.[1]
  }

  /**
   * createMandate with a creditor identified by alias instead of accountId (docs:payto-staging-testing-suite
   * "an alias might be used instead"): the alias must resolve to a local account that is not CLOSED.
   * @throws 422 the documented `Creditor account details incorrect` rejection otherwise
   */
  resolveCreditorAlias(alias: string, type: AccountAliasType): string {
    const number = this.resolveAlias(alias, type)
    const account = number ? this.localAccountByNumber(number) : undefined
    if (!account || account.status === 'CLOSED') throw unprocessable(ACCOUNT_DETAILS_INCORRECT('Creditor'))
    return account.id
  }

  // ---------------------------------------------------------------- amendments

  /** amendMandateByInitiator: unilateral change of the creditor account (same holder, ACTIVE) and/or ultimate party name; MAMN to the Payer. */
  amendByInitiator(id: string, body: AmendMandateByInitiatorRequestBody): Mandate {
    const m = this.requireAsInitiator(id)
    this.requireStatus(m, ['ACTIVE', 'SUSPENDED'], 'amend')
    const current = m.creditor.accountId ? this.accounts.find(m.creditor.accountId) : undefined
    const next = this.requireAmendTarget(body.creditorAccountId, current, m, 'creditor')
    m.creditor = compact({ ...m.creditor, accountId: next.id, accountNumber: next.bsb + next.accountNumber, ultimatePartyName: body.ultimatePartyName ?? m.creditor.ultimatePartyName })
    m.updatedAt = isoUtc(this.ctx.clock.now())
    const action = this.ctx.db.transaction(() => {
      this.repo.saveMandate(m)
      return this.addAction(m, {
        type: 'AMEND', status: 'COMPLETED', bilateral: false, partyRole: 'PAYMENT_INITIATOR', resolved: true,
        details: { amendment: { creditorInformation: compact({ accountId: next.id, accountNumber: next.bsb + next.accountNumber, ultimatePartyName: body.ultimatePartyName }) } },
        cxEventNameCreation: 'Payment agreement amended', cxEventNameResolution: 'Payment agreement amended',
      })
    })()
    this.notify(m, 'PAYER', 'MAMN', action, 'CLIENT')
    return m
  }

  /** amendMandateByPayer: unilateral change of the debtor account (same holder, ACTIVE; mandate ACTIVE or SUSPENDED); MAMN to the Initiator. */
  amendByPayer(id: string, body: AmendMandateByPayerRequestBody): Mandate {
    const m = this.requireAsPayer(id)
    this.requireStatus(m, ['ACTIVE', 'SUSPENDED'], 'amend')
    const current = this.accounts.find(m.debtor.accountId!)
    const next = this.requireAmendTarget(body.debtorAccountId, current, m, 'debtor')
    m.debtor = { ...m.debtor, accountId: next.id, accountNumber: next.bsb + next.accountNumber }
    m.updatedAt = isoUtc(this.ctx.clock.now())
    const action = this.ctx.db.transaction(() => {
      this.repo.saveMandate(m)
      return this.addAction(m, {
        type: 'AMEND', status: 'COMPLETED', bilateral: false, partyRole: 'DEBTOR', resolved: true,
        details: { amendment: { debtorInformation: { accountId: next.id, accountNumber: next.bsb + next.accountNumber } } },
        cxEventNameCreation: 'Payment agreement amended', cxEventNameResolution: 'Payment agreement amended',
      })
    })()
    this.notify(m, 'INITIATOR', 'MAMN', action, 'CLIENT')
    return m
  }

  /**
   * The replacement account must exist (404), be ACTIVE and belong to the same holder as the current one (422).
   * Re-sending the current account (to change only the ultimate party name) skips the status check.
   */
  private requireAmendTarget(accountId: string, current: Account | undefined, m: Mandate, party: 'creditor' | 'debtor'): Account {
    const next = this.accounts.get(accountId)
    if (current && next.id === current.id) return next
    if (next.status !== 'ACTIVE' && next.status !== 'ACTIVE_IN_ARREARS') throw unprocessable(`INVALID_ACCOUNT_STATUS: Account ${next.id} must be ACTIVE to become the ${party} account of mandate ${m.id}`)
    if (current && (next.holderType !== current.holderType || next.holderId !== current.holderId)) {
      throw unprocessable(`PERMISSION_DENIED: Account ${next.id} does not belong to the holder of the ${party} account of mandate ${m.id}`)
    }
    return next
  }

  /** amendMandatePaymentTerms: a bilateral AMEND action awaiting the Payer (MAMP); frequency and type are immutable. */
  amendPaymentTerms(id: string, body: AmendMandatePaymentTermsRequestBody): MandateAction {
    const m = this.requireAsInitiator(id)
    this.requireStatus(m, ['ACTIVE', 'SUSPENDED'], 'amend')
    if (!body.paymentTerms && body.validityEndDate === undefined) throw badRequest('BAD_REQUEST: paymentTerms or validityEndDate is required')
    if (body.resolutionRequestedBy !== undefined && !ISO_DATETIME_RE.test(body.resolutionRequestedBy)) throw badRequest('BAD_REQUEST: resolutionRequestedBy must be a UTC date-time like 2023-09-10T10:00:00.000Z')
    if (this.repo.pendingAction(m.id)) throw unprocessable(`INVALID_STATE: Mandate ${m.id} already has a pending action awaiting resolution`)
    const proposal: AmendProposal = {}
    if (body.paymentTerms) {
      const terms = parseTerms(body.paymentTerms)
      if (terms.frequency !== m.paymentTerms.frequency || terms.type !== m.paymentTerms.type) throw unprocessable('INVALID_ARGUMENT: paymentTerms.frequency and paymentTerms.type cannot be amended')
      proposal.paymentTerms = terms
    }
    if (body.validityEndDate !== undefined) {
      if (body.validityEndDate < m.validityStartDate) throw unprocessable('INVALID_ARGUMENT: validityEndDate must not precede validityStartDate')
      proposal.validityEndDate = body.validityEndDate
    }
    const action = this.addAction(m, {
      type: 'AMEND', status: 'PENDING', bilateral: true, partyRole: 'PAYMENT_INITIATOR', expires: true, resolutionRequestedBy: body.resolutionRequestedBy, proposal,
      details: { amendment: compact({ paymentInformation: proposal.paymentTerms ? paymentInformation(proposal.paymentTerms as PaymentTerms) : undefined, validityEndDate: proposal.validityEndDate, resolutionRequestedBy: body.resolutionRequestedBy }) },
      cxEventNameCreation: 'Updated payment terms received',
    })
    this.notify(m, 'PAYER', 'MAMP', action, 'CLIENT')
    return action
  }

  // ---------------------------------------------------------------- resolution of bilateral actions

  /** resolveMandateByPayer: ACCEPT / REJECT the oldest pending action (CREATE -> ACTIVE / CANCELLED; AMEND -> terms applied / declined). */
  resolveByPayer(id: string, resolution: Resolution, opts: { actionOwner?: ActionOwner; reasonCode?: string } = {}): MandateAction {
    const m = this.requireAsPayer(id)
    const action = this.repo.pendingAction(m.id)
    if (!action) throw unprocessable(`INVALID_STATE: Mandate ${m.id} has no pending action to resolve`)
    return this.resolvePending(m, action, resolution === 'ACCEPT' ? 'COMPLETED' : 'DECLINED', opts.actionOwner ?? 'CLIENT', { reasonCode: opts.reasonCode })
  }

  /** resolveMandateByInitiator: recalls the oldest pending action (a recalled CREATE cancels the mandate). */
  recallByInitiator(id: string, opts: { actionOwner?: ActionOwner } = {}): MandateAction {
    const m = this.requireAsInitiator(id)
    const action = this.repo.pendingAction(m.id)
    if (!action) throw unprocessable(`INVALID_STATE: Mandate ${m.id} has no pending action to recall`)
    return this.resolvePending(m, action, 'RECALLED', opts.actionOwner ?? 'CLIENT')
  }

  /**
   * Applies the outcome of a pending bilateral action and sends the matching MMS trigger, unless `silent`
   * (a mock notification drives the change and sends only its own requested trigger).
   */
  private resolvePending(m: Mandate, action: MandateAction, outcome: Exclude<ActionStatus, 'PENDING'>, actionOwner: ActionOwner, opts: { reasonCode?: string; silent?: boolean } = {}): MandateAction {
    const { reasonCode } = opts
    const now = this.ctx.clock.now()
    const isCreate = action.type === 'CREATE'
    const names: Record<Exclude<ActionStatus, 'PENDING'>, string> = { COMPLETED: 'authorised', DECLINED: 'declined', RECALLED: 'recalled', TIMED_OUT: 'expired' }
    action.status = outcome
    action.resolutionTime = now.toISOString()
    if (reasonCode) action.resolutionReasonCode = reasonCode
    action.cxEventNameResolution = `${isCreate ? 'Payment agreement' : 'Updated payment terms'} ${names[outcome]}`
    this.ctx.db.transaction(() => {
      this.repo.saveAction(action)
      if (isCreate) {
        if (outcome === 'COMPLETED') this.setStatus(m, 'ACTIVE', 'ACTIVE', 'PAYER')
        else this.setStatus(m, 'CANCELLED', outcome === 'RECALLED' ? 'CANCELLED_BY_PAYMENT_INITIATOR' : outcome === 'TIMED_OUT' ? 'CANCELLED_AUTHORISATION_TIMED_OUT' : 'CANCELLED', outcome === 'RECALLED' ? 'INITIATOR' : outcome === 'TIMED_OUT' ? 'PLATFORM' : 'PAYER')
      } else if (outcome === 'COMPLETED' && action.proposal) {
        this.applyProposal(m, action.proposal)
      }
    })()
    if (outcome === 'COMPLETED') this.scheduleNext(m)
    if (opts.silent) return action
    const trigger: MandateTrigger = isCreate
      ? ({ COMPLETED: 'MCRC', DECLINED: 'MCRD', RECALLED: 'MCRR', TIMED_OUT: 'MCRX' } as const)[outcome]
      : ({ COMPLETED: 'MAMC', DECLINED: 'MAMD', RECALLED: 'MAMR', TIMED_OUT: 'MAMX' } as const)[outcome]
    if (outcome === 'RECALLED') this.notify(m, 'PAYER', trigger, action, actionOwner)
    else if (outcome === 'TIMED_OUT') this.notify(m, 'BOTH', trigger, action, actionOwner)
    else this.notify(m, 'INITIATOR', trigger, action, actionOwner)
    return action
  }

  private applyProposal(m: Mandate, p: AmendProposal): void {
    if (p.paymentTerms) m.paymentTerms = { ...m.paymentTerms, ...p.paymentTerms } as PaymentTerms
    if (p.validityEndDate !== undefined) m.validityEndDate = p.validityEndDate
    m.updatedAt = isoUtc(this.ctx.clock.now())
    this.repo.saveMandate(m)
  }

  // ---------------------------------------------------------------- status changes

  suspend(id: string, side: 'INITIATOR' | 'PAYER', body: SuspendMandateRequestBody = {}): Mandate {
    const m = this.requireAs(id, side)
    if (m.status !== 'ACTIVE') throw unprocessable(`Validation of the request for suspension mandate with id: ${m.id}: To suspend a mandate it must be in active status.`)
    return this.transition(m, 'SUSPENDED', { side, change: 'SUSPEND', reasonCode: body.reasonCode, reasonDescription: body.reasonDescription, actionOwner: 'CLIENT' })
  }

  release(id: string, side: 'INITIATOR' | 'PAYER'): Mandate {
    const m = this.requireAs(id, side)
    if (m.status !== 'SUSPENDED') throw unprocessable(`Validation of the request for releasing mandate with id: ${m.id} failed. To release a mandate it must be in suspended status.`)
    if (m.suspendedBy && m.suspendedBy !== side) {
      const who = m.suspendedBy === 'INITIATOR' ? 'Initiator' : m.suspendedBy === 'PAYER' ? 'Payer' : "debtor's institution"
      throw unprocessable(`INVALID_STATE: Mandate ${m.id} was suspended by the ${who} and can only be released by them.`)
    }
    return this.transition(m, 'ACTIVE', { side, change: 'RELEASE', actionOwner: 'CLIENT' })
  }

  cancel(id: string, side: 'INITIATOR' | 'PAYER', body: CancelMandateRequestBody = {}): Mandate {
    const m = this.requireAs(id, side)
    if (m.status === 'CANCELLED') throw unprocessable(`INVALID_STATE: Mandate ${m.id} is already cancelled`)
    if (m.status === 'CREATED' && side === 'INITIATOR') {
      throw unprocessable(`INVALID_STATE: Validation of the request for cancelling mandate with id: ${m.id} failed. A mandate in CREATED status cannot be cancelled by the Initiator; recall it instead.`)
    }
    return this.transition(m, 'CANCELLED', { side, change: 'CANCEL', reasonCode: body.reasonCode, reasonDescription: body.reasonDescription, actionOwner: 'CLIENT' })
  }

  /**
   * Generic status transition: records the STATUS_CHANGE action, resolves pending bilateral actions
   * (declined by the Payer / recalled by the Initiator / timed out by the platform) when the mandate is
   * cancelled, and sends MSCH to both parties. Preconditions are the callers' business.
   */
  transition(mandate: Mandate | string, to: MandateStatus, opts: { side: MandateSide; change: StatusChange; reasonCode?: string; reasonDescription?: string; actionOwner?: ActionOwner }): Mandate {
    const m = typeof mandate === 'string' ? this.get(mandate) : mandate
    if (m.status === to) return m
    const cx: CxMandateStatus = to === 'ACTIVE' ? 'ACTIVE'
      : to === 'SUSPENDED' ? (opts.side === 'INITIATOR' ? 'PAUSED_BY_PAYMENT_INITIATOR' : opts.side === 'PAYER' ? 'PAUSED_BY_CUSTOMER' : 'PAUSED_BY_PAYER_INSTITUTION')
      : to === 'CANCELLED' ? (opts.side === 'INITIATOR' ? 'CANCELLED_BY_PAYMENT_INITIATOR' : 'CANCELLED')
      : 'ACTION_REQUIRED'
    const actionOwner = opts.actionOwner ?? (opts.side === 'PLATFORM' ? 'PLATFORM' : 'CLIENT')
    const now = this.ctx.clock.now()
    const action = this.ctx.db.transaction(() => {
      if (to === 'CANCELLED') {
        for (const pending of this.repo.actionsForMandate(m.id).filter((a) => a.status === 'PENDING')) {
          pending.status = opts.side === 'INITIATOR' ? 'RECALLED' : opts.side === 'PAYER' ? 'DECLINED' : 'TIMED_OUT'
          pending.resolutionTime = now.toISOString()
          pending.cxEventNameResolution = `${pending.type === 'CREATE' ? 'Payment agreement' : 'Updated payment terms'} ${opts.side === 'INITIATOR' ? 'recalled' : opts.side === 'PAYER' ? 'declined' : 'expired'}`
          this.repo.saveAction(pending)
        }
      }
      this.setStatus(m, to, cx, opts.side)
      const verb = { SUSPEND: 'suspended', RELEASE: 'released', CANCEL: 'cancelled' }[opts.change]
      return this.addAction(m, {
        type: 'STATUS_CHANGE', status: 'COMPLETED', partyRole: opts.side === 'PAYER' ? 'DEBTOR' : 'PAYMENT_INITIATOR', resolved: true,
        details: { statusChange: compact({ change: opts.change, reasonCode: opts.reasonCode, reasonDescription: opts.reasonDescription }) },
        cxEventNameCreation: `Payment agreement ${verb}`, cxEventNameResolution: `Payment agreement ${verb}`,
      })
    })()
    // a payment that fell due while SUSPENDED stays scheduled and is initiated on the next tick
    if (to === 'ACTIVE' && !this.repo.scheduleForMandate(m.id)) this.scheduleNext(m)
    this.notify(m, 'BOTH', 'MSCH', action, actionOwner)
    return m
  }

  /** Persists a status change and publishes mandate.statusChanged (no webhook by itself). */
  private setStatus(m: Mandate, status: MandateStatus, cxStatus: CxMandateStatus, by: MandateSide): void {
    const previous = m.status
    m.status = status
    m.cxStatus = cxStatus
    m.suspendedBy = status === 'SUSPENDED' ? by : undefined
    m.updatedAt = isoUtc(this.ctx.clock.now())
    this.repo.saveMandate(m)
    if (status === 'CANCELLED') this.repo.deleteSchedule(m.id)
    this.ctx.events.emit('mandate.statusChanged', { mandate: m, previousStatus: previous, by })
  }

  private requireStatus(m: Mandate, allowed: MandateStatus[], verb: string): void {
    if (!allowed.includes(m.status)) throw unprocessable(`INVALID_STATE: Mandate ${m.id} is ${m.status}; to ${verb} a mandate it must be ${allowed.join(' or ')}`)
  }

  // ---------------------------------------------------------------- payments

  /**
   * makeAdhocPayment (the route owns idempotency): records the instruction and initiates it (initiate()).
   * Only malformed amounts are HTTP errors (400); every business refusal is a REJECTED instruction.
   */
  adhocPayment(body: MakeAdhocPaymentRequestBody, opts: { actionOwner?: ActionOwner } = {}): MakeAdhocPaymentResponseBody {
    const m = this.requireAsInitiator(body.mandateId)
    const actionOwner = opts.actionOwner ?? 'CLIENT'
    if (body.amount !== undefined) {
      if (!hasAtMostTwoDecimals(body.amount.amount)) throw badRequest('BAD_REQUEST: amount.amount must have at most 2 decimal places')
      if (body.amount.amount < 0) throw badRequest('BAD_REQUEST: amount.amount must not be negative')
    }
    const amount: Money | undefined = body.amount ? { amountCents: toCents(body.amount.amount), currency: body.amount.currency } : m.paymentTerms.amount
    const instruction = this.newInstruction(m, 'ADHOC', amount ?? { amountCents: 0, currency: 'AUD' }, body.endToEndId ?? NOT_PROVIDED, body.description)
    if (amount) this.initiate(m, instruction, actionOwner, parseTrajectory(body.description, m.description))
    else this.finish(m, instruction, { status: 'REJECTED', reasonCode: 'AM12' }, actionOwner)
    return {
      mandateId: m.id,
      instructionId: instruction.id,
      transactionStatus: instruction.status,
      transactionStatusDisplay: STATUS_DISPLAY[instruction.status],
      statusIsFinal: isFinalStatus(instruction.status),
      message: SUCCESS_MESSAGE.adhoc,
    }
  }

  /**
   * The Payer side receives a payment instruction (RAPAIN, utilities' generateReceiveAPaymentInstruction):
   * ACCP debits the local debtor account only (INTERBANK_TRANSFER_OUT with mandatePaymentDetails; the creditor
   * leg is the RAP mock's generateInboundNppTransactionV2) and answers MANDATE_PAYMENT_ACCEPTED; RJCT (or a
   * refused debit) answers MANDATE_PAYMENT_REJECTED with the reason.
   */
  receivePaymentInstruction(input: ReceivePaymentInput): { instruction: PaymentInstruction; transactionId?: string } {
    const m = this.get(input.mandateId)
    if (this.repo.instructionById(input.instructionId)) throw unprocessable(`DUPLICATE_INSTRUCTION: Payment instruction ${input.instructionId} already exists`)
    const actionOwner = input.actionOwner ?? 'PLATFORM'
    const instruction = this.newInstruction(m, 'INBOUND', { amountCents: input.amountCents, currency: input.currency ?? 'AUD' }, input.endToEndId ?? NOT_PROVIDED, input.description, input.instructionId)
    let outcome: PaymentOutcome
    if (input.status === 'RJCT') outcome = { status: 'REJECTED', reasonCode: input.reasonCode ?? 'AB01' }
    else if (!m.debtor.accountId) outcome = { status: 'REJECTED', reasonCode: 'AC02' }
    else outcome = this.debit(m, instruction, input.initiatingPartyName, actionOwner, { creditorLeg: false })
    this.finish(m, instruction, outcome, actionOwner)
    return { instruction, transactionId: outcome.transactionId }
  }

  private newInstruction(m: Mandate, origin: InstructionOrigin, amount: Money, endToEndId: string, description?: string, id?: string): PaymentInstruction {
    const now = this.ctx.clock.now()
    const i: PaymentInstruction = compact({
      id: id ?? this.instructionId(now),
      mandateId: m.id,
      origin,
      amountCents: amount.amountCents,
      currency: amount.currency,
      endToEndId,
      description,
      status: 'RECEIVED' as const,
      creationDateTime: isoUtc(now),
    })
    this.repo.insertInstruction(i)
    return i
  }

  /** `<BIC>I<YYYYMMDD>00<12-digit sequence>0` — PaymentInstructionSummary.instructionIdentification. */
  private instructionId(now: Date): string {
    return `${BIC}I${isoDate(now).replace(/-/g, '')}00${String(this.repo.nextInstructionSeq()).padStart(12, '0')}0`
  }

  private finish(m: Mandate, i: PaymentInstruction, outcome: PaymentOutcome, actionOwner: ActionOwner): void {
    i.status = outcome.status
    i.reasonCode = outcome.reasonCode
    i.transactionId = outcome.transactionId
    i.updatedAt = isoUtc(this.ctx.clock.now())
    this.repo.saveInstruction(i)
    if (isFinalStatus(i.status)) this.ctx.events.emit('mandate.paymentFinal', { mandate: m, instruction: i, actionOwner })
  }

  /**
   * Initiates a payment instruction (adhoc or scheduled): the consistency checks against the agreement
   * (REJECTED with a PaymentReasonCode), then either settlement or, when a staging trajectory is given
   * (`paymentstatus:<initial>[&<final>]`, parseTrajectory), its initial status. A non-final initial status
   * progresses asynchronously (scheduler.later, actionOwner PLATFORM) to the trajectory's final status,
   * ACCEPTED_AND_SETTLED (settlement) by default; MANDATE_PAYMENT is sent once, when the status is final.
   */
  private initiate(m: Mandate, i: PaymentInstruction, actionOwner: ActionOwner, trajectory?: Trajectory): void {
    const refused = this.checkAgreement(m, i)
    if (refused) return this.finish(m, i, refused, actionOwner)
    if (!trajectory) return this.finish(m, i, this.settle(m, i, actionOwner), actionOwner)
    if (isFinalStatus(trajectory.initial)) return this.finish(m, i, this.reach(m, i, trajectory.initial, actionOwner), actionOwner)
    this.finish(m, i, { status: trajectory.initial }, actionOwner)
    const hop = (): void => {
      const current = this.repo.instructionById(i.id)
      const mandate = this.repo.mandateById(m.id)
      if (!current || !mandate || isFinalStatus(current.status)) return
      this.finish(mandate, current, this.reach(mandate, current, trajectory.final ?? 'ACCEPTED_AND_SETTLED', 'PLATFORM'), 'PLATFORM')
    }
    if (this.paymentProgressDelayMs === undefined) this.ctx.scheduler.later(hop)
    else this.ctx.scheduler.later(hop, this.paymentProgressDelayMs)
  }

  /** Agreement checks (docs:payto-payment "Shaype confirms the request is consistent with the PayTo agreement"). */
  private checkAgreement(m: Mandate, i: PaymentInstruction): PaymentOutcome | undefined {
    const reject = (reasonCode: string): PaymentOutcome => ({ status: 'REJECTED', reasonCode })
    const today = isoDate(this.ctx.clock.now())
    if (m.status !== 'ACTIVE') return reject('AG01')
    if (i.origin === 'ADHOC' && m.paymentTerms.frequency !== 'ADHOC') return reject('AG03')
    if (today < m.validityStartDate) return reject('DT04')
    if (m.validityEndDate && today > m.validityEndDate) return reject('AG01')
    if (i.amountCents <= 0) return reject('AM01')
    if (i.currency !== 'AUD') return reject('AM03')
    if (m.paymentTerms.maximumAmount && i.amountCents > m.paymentTerms.maximumAmount.amountCents) return reject('AM21')
    return undefined
  }

  /** The outcome of a forced (trajectory) status: settlement for ACCEPTED_AND_SETTLED, AB01 for REJECTED, else the status itself. */
  private reach(m: Mandate, i: PaymentInstruction, status: InstructionStatus, actionOwner: ActionOwner): PaymentOutcome {
    if (status === 'ACCEPTED_AND_SETTLED') return this.settle(m, i, actionOwner)
    if (status === 'REJECTED') return { status, reasonCode: 'AB01' }
    return { status }
  }

  /**
   * Settlement: the debtor leg (INTERBANK_TRANSFER_OUT) and, when the creditor is local, the creditor leg
   * (INTERBANK_TRANSFER_IN), both carrying mandatePaymentDetails and originType MANDATE_PAYMENT. An external
   * debtor is the staging default ("will receive a RJCT PSR notification"): REJECTED AB01.
   */
  private settle(m: Mandate, i: PaymentInstruction, actionOwner: ActionOwner): PaymentOutcome {
    if (!m.debtor.accountId) return { status: 'REJECTED', reasonCode: 'AB01' }
    return this.debit(m, i, undefined, actionOwner)
  }

  /** Settles the instruction: the debtor leg and, unless `creditorLeg` is false, the leg into a local creditor account. */
  private debit(m: Mandate, i: PaymentInstruction, initiatingPartyName: string | undefined, actionOwner: ActionOwner, opts: { creditorLeg?: boolean } = {}): PaymentOutcome {
    const debtor = this.accounts.find(m.debtor.accountId!)
    if (!debtor) return { status: 'REJECTED', reasonCode: 'AC02' }
    const creditor = m.creditor.accountId ? this.accounts.find(m.creditor.accountId) : undefined
    const creditorName = initiatingPartyName ?? this.partyName(m.creditor, creditor) ?? 'Initiator'
    const debtorName = this.partyName(m.debtor, debtor) ?? 'Debtor'
    const mandatePayment = { mandateId: m.id, instructionId: i.id, initiatingPartyName: creditorName }
    const common = { description: i.description, reference: i.endToEndId, originType: 'MANDATE_PAYMENT' as const, originId: m.id, mandatePayment, actionOwner }
    const out: PostInput = compact({
      ...common,
      accountId: debtor.id,
      amountCents: -i.amountCents,
      type: 'INTERBANK_TRANSFER_OUT' as const,
      channel: 'CUSCAL_NPP_TRANSFER_OUT' as const,
      counterpart: compact({ accountId: creditor?.id, customerId: creditor ? this.primaryCustomer(creditor) : undefined, name: creditorName, basicAccountNumber: basicAccountNumber(m.creditor.accountNumber) }),
    })
    const into: PostInput | undefined = creditor && opts.creditorLeg !== false
      ? compact({
        ...common,
        accountId: creditor.id,
        amountCents: i.amountCents,
        type: 'INTERBANK_TRANSFER_IN' as const,
        channel: 'CUSCAL_NPP_TRANSFER_IN' as const,
        counterpart: compact({ accountId: debtor.id, customerId: this.primaryCustomer(debtor), name: debtorName, basicAccountNumber: basicAccountNumber(m.debtor.accountNumber) }),
        limits: ['MAX_BALANCE' as const],
      })
      : undefined
    const refusedOut = this.transactions.evaluate(out)
    if (refusedOut !== 'ACCEPTED') return { status: 'REJECTED', reasonCode: debtorReason(refusedOut) }
    if (into) {
      const refusedIn = this.transactions.evaluate(into)
      if (refusedIn !== 'ACCEPTED') return { status: 'REJECTED', reasonCode: refusedIn === 'REFUSED_ACCOUNT_BLOCKED' ? 'AC06' : refusedIn === 'REFUSED_ACCOUNT_CLOSED' ? 'AC07' : 'AC14' }
    }
    const transactionId = this.ctx.db.transaction(() => {
      const t = this.transactions.apply(out)
      return into ? this.transactions.apply(into).id : t.id
    })()
    return { status: 'ACCEPTED_AND_SETTLED', transactionId }
  }

  private partyName(p: PartyDetails, account: Account | undefined): string | undefined {
    if (p.ultimatePartyName) return p.ultimatePartyName
    if (p.partyName) return p.partyName
    if (!account) return undefined
    if (account.holderType !== 'CUSTOMER') return undefined
    const c = this.customers.find(account.holderId)
    return c ? [c.customerDetails.firstName, c.customerDetails.lastName].filter(Boolean).join(' ') : undefined
  }

  private primaryCustomer(a: Account): string {
    return this.accounts.holderCustomerIds(a)[0] ?? a.holderId
  }

  // ---------------------------------------------------------------- stubs (utilities: createStubForMandateSearchPaymentInstructions)

  /** Replaces the stubbed instructions of the mandate (MMS 4-letter statuses mapped to the API enum). @throws 404 for an unknown mandate */
  addStubInstructions(mandateId: string, summaries: PaymentInstructionSummary[]): PaymentInstruction[] {
    const m = this.get(mandateId)
    return this.ctx.db.transaction(() => {
      this.repo.deleteInstructions(m.id, 'STUB')
      return summaries.map((s) => {
        const existing = this.repo.instructionById(s.instructionIdentification)
        if (existing && existing.mandateId !== m.id) throw unprocessable(`DUPLICATE_INSTRUCTION: Payment instruction ${s.instructionIdentification} belongs to mandate ${existing.mandateId}`)
        const i: PaymentInstruction = compact({
          id: s.instructionIdentification,
          mandateId: m.id,
          origin: 'STUB' as const,
          amountCents: toCents(s.instructedAmount),
          currency: 'AUD',
          endToEndId: NOT_PROVIDED,
          status: MMS_STATUS[s.transactionStatus],
          reasonCode: s.transactionStatusReasonCode,
          creationDateTime: normaliseDateTime(s.creationDateTime),
        })
        if (existing) this.repo.saveInstruction(i)
        else this.repo.insertInstruction(i)
        return i
      })
    })()
  }

  // ---------------------------------------------------------------- scheduled payments

  /** setScheduledPaymentInitiationRequestAmount: the amount of the next scheduled PIR of a USAGE_BASED / VARIABLE mandate. */
  setScheduledAmount(mandateId: string, body: SetScheduledPaymentInitiationAmountRequestBody): ScheduledPayment {
    const m = this.requireAsInitiator(mandateId)
    if (m.paymentTerms.type !== 'USAGE_BASED' && m.paymentTerms.type !== 'VARIABLE') {
      throw unprocessable(`INVALID_ARGUMENT: Mandate ${m.id} has ${m.paymentTerms.type} payment terms; the amount can only be set for USAGE_BASED and VARIABLE mandates`)
    }
    const s = this.repo.scheduleById(body.notificationId)
    if (!s || s.mandateId !== m.id) throw unprocessable(`NOT_FOUND: Notification ${body.notificationId} does not identify a due payment of mandate ${m.id}`)
    const amount = parseMoney(body.amount, 'amount')
    if (m.paymentTerms.maximumAmount && amount.amountCents > m.paymentTerms.maximumAmount.amountCents) throw unprocessable('INVALID_AMOUNT: amount exceeds paymentTerms.maximumAmount')
    s.amountCents = amount.amountCents
    this.repo.saveSchedule(s)
    return s
  }

  /**
   * (Re)schedules the next payment of an ACTIVE non-ADHOC mandate the client initiates (local creditor): the
   * first due date on or after today (firstPayment.date or validityStartDate plus n periods, nthDueDate) and
   * after m.lastDueDate (a due date already initiated is never scheduled again, whoever re-schedules: MCRC,
   * MAMC, release, tick) that is within lastPayment.date / validityEndDate. Initiation happens at the due
   * date, at least DUE_PAYMENT_LEAD_MS ahead, so that the amount of a USAGE_BASED / VARIABLE mandate can be
   * set once MANDATE_DUE_PAYMENT has announced it (announceDue()).
   */
  scheduleNext(m: Mandate): ScheduledPayment | undefined {
    this.repo.deleteSchedule(m.id)
    if (m.status !== 'ACTIVE' || m.paymentTerms.frequency === 'ADHOC' || !m.creditor.accountId) return undefined
    const now = this.ctx.clock.now()
    const today = isoDate(now)
    const after = this.repo.mandateById(m.id)?.lastDueDate
    const anchor = m.paymentTerms.firstPayment?.date ?? m.validityStartDate
    let due = anchor
    for (let n = 1; (due < today || (after !== undefined && due <= after)) && n <= 100_000; n++) due = nthDueDate(anchor, m.paymentTerms.frequency, n)
    if (m.paymentTerms.lastPayment?.date && due > m.paymentTerms.lastPayment.date) return undefined
    if (m.validityEndDate && due > m.validityEndDate) return undefined
    const s: ScheduledPayment = {
      notificationId: uuid(),
      mandateId: m.id,
      dueDate: due,
      paymentDateTime: isoUtc(new Date(Math.max(new Date(`${due}T00:00:00.000Z`).getTime(), now.getTime() + DUE_PAYMENT_LEAD_MS))),
      announce: m.paymentTerms.type === 'USAGE_BASED' || m.paymentTerms.type === 'VARIABLE',
      createdAt: isoUtc(now),
    }
    this.repo.insertSchedule(s)
    this.announceDue()
    return s
  }

  /**
   * MANDATE_DUE_PAYMENT (webhook-matrix: USAGE_BASED / VARIABLE only, one lead time before the initiation)
   * for the schedules of ACTIVE mandates entering that window; a SUSPENDED mandate's announcement waits.
   */
  private announceDue(): void {
    const now = this.ctx.clock.now()
    for (const s of this.repo.schedulesToAnnounce(isoUtc(new Date(now.getTime() + DUE_PAYMENT_LEAD_MS)))) {
      const m = this.repo.mandateById(s.mandateId)
      if (!m || m.status !== 'ACTIVE') continue
      s.announcedAt = isoUtc(now)
      this.repo.saveSchedule(s)
      this.ctx.events.emit('mandate.paymentDue', { mandate: m, schedule: s })
    }
  }

  private scheduledAmount(m: Mandate, s: ScheduledPayment): Money | undefined {
    if (s.amountCents !== undefined) return { amountCents: s.amountCents, currency: 'AUD' }
    const t = m.paymentTerms
    if (t.type === 'USAGE_BASED' || t.type === 'VARIABLE') return undefined
    if (t.firstPayment?.date === s.dueDate && t.firstPayment.amount) return t.firstPayment.amount
    if (t.lastPayment?.date === s.dueDate && t.lastPayment.amount) return t.lastPayment.amount
    return t.amount
  }

  /** Time-driven work (scheduler tick): action expiry, validity expiry, due-payment announcements, due scheduled payments. */
  tick(): void {
    const now = this.ctx.clock.now()
    for (const a of this.repo.expiredPendingActions(now.toISOString())) {
      const m = this.repo.mandateById(a.mandateId)
      if (m) this.resolvePending(m, a, 'TIMED_OUT', 'PLATFORM')
    }
    for (const m of this.repo.expiredMandates(isoDate(now))) {
      this.transition(m, 'CANCELLED', { side: 'PLATFORM', change: 'CANCEL', reasonCode: 'CTEX', reasonDescription: 'Contract expired', actionOwner: 'PLATFORM' })
    }
    this.announceDue()
    for (const s of this.repo.dueSchedules(isoUtc(now))) {
      const m = this.repo.mandateById(s.mandateId)
      if (!m || m.status === 'CANCELLED') { this.repo.deleteSchedule(s.mandateId); continue }
      if (m.status !== 'ACTIVE') continue // SUSPENDED: deferred until released
      const amount = this.scheduledAmount(m, s)
      const instruction = this.newInstruction(m, 'SCHEDULED', amount ?? { amountCents: 0, currency: 'AUD' }, m.creditor.partyReference ?? NOT_PROVIDED, m.description)
      this.repo.setLastDueDate(m.id, s.dueDate)
      if (amount) this.initiate(m, instruction, 'PLATFORM', parseTrajectory(m.description))
      else this.finish(m, instruction, { status: 'REJECTED', reasonCode: 'AM12' }, 'PLATFORM')
      this.scheduleNext(m)
    }
  }

  // ---------------------------------------------------------------- notifications (also for the utilities mocks)

  /**
   * Sends one MANDATE notification with `trigger` to one side of the mandate and silently applies the state
   * the MMS would have reached (MCRC activates, MCRD/PCRD/MCRX/MCRR cancel a CREATED mandate, MAMC applies a
   * pending amendment, MAMD/MAMX/MAMR resolve it). An unknown mandate is created from `details.mandateDetails`
   * when given (an external Initiator's mandate reaching a local Payer), otherwise 404.
   */
  emitMandateNotification(side: 'INITIATOR' | 'PAYER', mandateId: string, trigger: MandateTrigger, details: NotificationDetails = {}): Mandate {
    let m = this.find(mandateId)
    if (!m) {
      if (!details.mandateDetails) throw notFound(`NOT_FOUND: Mandate ${mandateId} not found`)
      m = this.createFromDetails(normaliseMandateId(mandateId), details.mandateDetails)
    }
    const actionOwner = details.actionOwner ?? 'PLATFORM'
    let action: MandateAction | undefined
    // the state change is applied silently: the mock sends exactly one MANDATE, with its requested trigger (below)
    const resolve = (type: ActionType, outcome: Exclude<ActionStatus, 'PENDING'>): boolean => {
      const a = this.repo.pendingAction(m!.id, type)
      if (a) action = this.resolvePending(m!, a, outcome, actionOwner, { silent: true })
      return a !== undefined
    }
    const effect: Partial<Record<MandateTrigger, () => void>> = {
      MCRC: () => { if (!resolve('CREATE', 'COMPLETED') && m!.status === 'CREATED') { this.setStatus(m!, 'ACTIVE', 'ACTIVE', 'PAYER'); this.scheduleNext(m!) } },
      MCRD: () => { if (!resolve('CREATE', 'DECLINED') && m!.status === 'CREATED') this.setStatus(m!, 'CANCELLED', 'CANCELLED', 'PAYER') },
      PCRD: () => effect.MCRD!(), // docs:payto-staging-testing-suite sends the Payer's decline to the Initiator mock as PCRD
      MCRX: () => { if (!resolve('CREATE', 'TIMED_OUT') && m!.status === 'CREATED') this.setStatus(m!, 'CANCELLED', 'CANCELLED_AUTHORISATION_TIMED_OUT', 'PLATFORM') },
      MCRR: () => { if (!resolve('CREATE', 'RECALLED') && m!.status === 'CREATED') this.setStatus(m!, 'CANCELLED', 'CANCELLED_BY_PAYMENT_INITIATOR', 'INITIATOR') },
      MAMC: () => { resolve('AMEND', 'COMPLETED') },
      MAMD: () => { resolve('AMEND', 'DECLINED') },
      MAMX: () => { resolve('AMEND', 'TIMED_OUT') },
      MAMR: () => { resolve('AMEND', 'RECALLED') },
    }
    effect[trigger]?.()
    m = this.get(m.id)
    const actionId = details.actionId ? normaliseMandateId(details.actionId) : (action ?? this.repo.latestAction(m.id))?.id
    this.ctx.events.emit('mandate.notified', { mandate: m, side, trigger, actionId, description: details.description ?? TRIGGER_DESCRIPTION[trigger], actionOwner })
    return m
  }

  /** A mandate known only through an MMS notification (external Initiator): parties from the mock's account identifications. */
  private createFromDetails(id: string, d: MandateDetailsDto): Mandate {
    const party = (identification: string | undefined): PartyDetails => {
      if (!identification) return {}
      if (!BSB_ACCOUNT_RE.test(identification)) return { accountAliasIdentification: identification }
      const local = this.localAccountByNumber(identification)
      return local ? { accountId: local.id, accountNumber: identification } : { accountNumber: identification }
    }
    const p = d.paymentInformation
    const money = (s: string | undefined): Money | undefined => (s === undefined ? undefined : { amountCents: toCents(s), currency: 'AUD' })
    const frequency = (MMS_FREQUENCY[p.paymentFrequency] ?? p.paymentFrequency) as Frequency
    const type = (MMS_AMOUNT_TYPE[p.paymentAmountType ?? ''] ?? p.paymentAmountType ?? 'VARIABLE') as PaymentTerms['type']
    const now = this.ctx.clock.now()
    const m: Mandate = compact({
      id,
      status: 'CREATED' as const,
      cxStatus: 'ACTION_REQUIRED' as const,
      creditor: party(d.creditorInformation?.accountIdentification),
      debtor: party(d.debtorInformation.accountIdentification),
      description: d.description,
      // required by GetMandateSummaryDto; the notification DTO carries none
      purposeCode: 'OTHER' as const,
      validityStartDate: d.validityStartDate,
      validityEndDate: d.validityEndDate,
      paymentTerms: compact({
        frequency, type, amount: money(p.amount), maximumAmount: money(p.maximumAmount), countPerPeriod: p.countPerPeriod, pointInTime: p.pointInTime,
        firstPayment: p.firstPaymentAmount !== undefined || p.firstPaymentDate !== undefined ? compact({ amount: money(p.firstPaymentAmount), date: p.firstPaymentDate }) : undefined,
        lastPayment: p.lastPaymentAmount !== undefined || p.lastPaymentDate !== undefined ? compact({ amount: money(p.lastPaymentAmount), date: p.lastPaymentDate }) : undefined,
      }),
      registrationDateTime: isoUtc(now),
      createdAt: isoUtc(now),
    })
    this.ctx.db.transaction(() => {
      this.repo.insertMandate(m)
      this.addAction(m, { type: 'CREATE', status: 'PENDING', bilateral: true, partyRole: 'PAYMENT_INITIATOR', expires: true, details: { creation: this.creationDetails(m) }, cxEventNameCreation: 'Payment agreement received' })
    })()
    this.ctx.events.emit('mandate.created', { mandate: m })
    return m
  }

  /** Emits mandate.notified for the recipients of one side ('BOTH' = Initiator and Payer). */
  private notify(m: Mandate, side: 'INITIATOR' | 'PAYER' | 'BOTH', trigger: MandateTrigger, action: MandateAction | undefined, actionOwner: ActionOwner): void {
    for (const s of side === 'BOTH' ? (['INITIATOR', 'PAYER'] as const) : [side]) {
      if (this.customersFor(m, s).length === 0) continue // no local party on that side: nobody to notify
      this.ctx.events.emit('mandate.notified', { mandate: m, side: s, trigger, actionId: action?.id, description: TRIGGER_DESCRIPTION[trigger], actionOwner })
    }
  }

  /** Customer ids behind one side's local account (the creditor's holders for the Initiator, the debtor's for the Payer). */
  customersFor(m: Mandate, side: 'INITIATOR' | 'PAYER'): string[] {
    const accountId = side === 'INITIATOR' ? m.creditor.accountId : m.debtor.accountId
    const a = accountId ? this.accounts.find(accountId) : undefined
    return a ? this.accounts.holderCustomerIds(a) : []
  }

  // ---------------------------------------------------------------- actions

  private addAction(m: Mandate, a: {
    type: ActionType; status: ActionStatus; bilateral?: boolean; partyRole: PartyRole; expires?: boolean; resolved?: boolean
    details?: ActionDetails; proposal?: AmendProposal; resolutionRequestedBy?: string; cxEventNameCreation?: string; cxEventNameResolution?: string
  }): MandateAction {
    const now = this.ctx.clock.now()
    const action: MandateAction = compact({
      id: v1Uuid(),
      mandateId: m.id,
      type: a.type,
      status: a.status,
      bilateral: a.bilateral,
      partyRole: a.partyRole,
      creationTime: now.toISOString(),
      resolutionTime: a.resolved ? now.toISOString() : undefined,
      details: a.details,
      proposal: a.proposal,
      expiryTime: a.expires ? new Date(now.getTime() + ACTION_EXPIRY_MS).toISOString() : undefined,
      resolutionRequestedBy: a.resolutionRequestedBy,
      cxEventNameCreation: a.cxEventNameCreation,
      cxEventNameResolution: a.cxEventNameResolution,
    })
    this.repo.insertAction(action)
    return action
  }

  private creationDetails(m: Mandate, body?: CreateMandateRequestBody): NonNullable<ActionDetails['creation']> {
    const creditor = m.creditor.accountId ? this.accounts.find(m.creditor.accountId) : undefined
    const initiatorName = this.partyName(m.creditor, creditor) ?? 'Initiator'
    return compact({
      automaticExtensionIndicator: false,
      creditorInformation: partyInformation(m.creditor, initiatorName),
      debtorInformation: partyInformation(m.debtor, this.partyName(m.debtor, m.debtor.accountId ? this.accounts.find(m.debtor.accountId) : undefined) ?? 'Debtor'),
      description: m.description || undefined,
      establishmentScheme: 'AUTHORISED_PAYMENT_MANDATE' as const,
      // ^[ -~]{1,35}$: ids go in their 32-hex form
      initiationRequestIdentification: uuid().replace(/-/g, ''),
      mandatePurposeCode: m.purposeCode,
      mandateType: 'DIRECT_DEBIT' as const,
      paymentInformation: paymentInformation(m.paymentTerms),
      paymentInitiatorInformation: { partyIdentification: (m.creditor.accountId ?? m.id).replace(/-/g, ''), partyIdentificationTypeCode: 'BANK_PARTY_ID' as const, partyLegalName: initiatorName, partyName: initiatorName, partyServicerBic: BIC },
      resolutionRequestedBy: body?.resolutionRequestedBy,
      transferArrangement: m.transferArrangement,
      validityEndDate: m.validityEndDate,
      validityStartDate: m.validityStartDate,
    })
  }
}

// ---------------------------------------------------------------- helpers

/** A staging payment trajectory: the status makeAdhocPayment answers and, when that is not final, the one it reaches later. */
export interface Trajectory { initial: InstructionStatus; final?: InstructionStatus }

const TRAJECTORY_RE = /paymentstatus:([a-z_]+)(?:&([a-z]+))?/i

/**
 * docs:payto-staging-testing-suite drives payment outcomes by a `paymentstatus:` hint in the mandate
 * description: `paymentstatus:<mms>` (initial status, then settlement), `paymentstatus:<mms>&<mms>`
 * (initial, then final) or `paymentstatus:timeout_rjct` (REJECTED AB01 at once); MMS codes RECV, UNDV,
 * SENT, SAFD, ACCP, ACSP, ACSC, RJCT, any case. The first text carrying a valid hint wins (the payment
 * description is consulted before the mandate's); unknown codes are ignored.
 */
export function parseTrajectory(...texts: (string | undefined)[]): Trajectory | undefined {
  for (const text of texts) {
    const hit = text ? TRAJECTORY_RE.exec(text) : null
    if (!hit) continue
    const code = hit[1]!.toUpperCase()
    if (code === 'TIMEOUT_RJCT') return { initial: 'REJECTED' }
    const initial = MMS_STATUS[code as MmsInstructionStatus] as InstructionStatus | undefined
    if (!initial) continue
    const final = hit[2] ? (MMS_STATUS[hit[2].toUpperCase() as MmsInstructionStatus] as InstructionStatus | undefined) : undefined
    return final ? { initial, final } : { initial }
  }
  return undefined
}

const MMS_FREQUENCY: Record<string, Frequency> = { ADHO: 'ADHOC', DAIL: 'DAILY', FRTN: 'FORTNIGHTLY', INDA: 'INTRA_DAY', MIAN: 'SEMI_ANNUAL', MNTH: 'MONTHLY', QURT: 'QUARTERLY', WEEK: 'WEEKLY', YEAR: 'ANNUAL' }
const MMS_AMOUNT_TYPE: Record<string, PaymentTerms['type']> = { BALN: 'BALLOON', FIXE: 'FIXED', USGB: 'USAGE_BASED', VARI: 'VARIABLE' }

/** Ledger refusal of the debtor leg -> PaymentReasonCode. */
function debtorReason(outcome: LedgerOutcome): string {
  switch (outcome) {
    case 'REFUSED_NOT_ENOUGH_FUNDS': return 'AM04'
    case 'REFUSED_ACCOUNT_BLOCKED': return 'AC06'
    case 'REFUSED_ACCOUNT_CLOSED': return 'AC05'
    default: return 'AG07'
  }
}

function basicAccountNumber(bsbAndNumber: string | undefined): { accountNumber: string; branchNumber: string } | undefined {
  return bsbAndNumber && BSB_ACCOUNT_RE.test(bsbAndNumber) ? { branchNumber: bsbAndNumber.slice(0, 6), accountNumber: bsbAndNumber.slice(6) } : undefined
}

/** Request CurrencyAmount -> cents; 400 for more than two decimals or a non-positive amount, 422 for a non-AUD currency. */
export function validateAmount(a: CurrencyAmount, field: string): void {
  if (!hasAtMostTwoDecimals(a.amount)) throw badRequest(`BAD_REQUEST: ${field}.amount must have at most 2 decimal places`)
  if (a.amount <= 0) throw badRequest(`BAD_REQUEST: ${field}.amount must be greater than 0`)
  if (a.currency !== 'AUD') throw unprocessable(`INVALID_CURRENCY: ${field}.currency must be AUD`)
}

export function parseMoney(a: CurrencyAmount, field: string): Money {
  validateAmount(a, field)
  return { amountCents: toCents(a.amount), currency: a.currency }
}

export function parseTerms(t: CreatePaymentTermsDto): PaymentTerms {
  const money = (a: CurrencyAmount | undefined, field: string): Money | undefined => (a ? parseMoney(a, field) : undefined)
  const first = t.firstPayment
  const last = t.lastPayment
  if (first?.date && last?.date && last.date < first.date) throw unprocessable('INVALID_ARGUMENT: paymentTerms.lastPayment.date must not precede firstPayment.date')
  if (t.countPerPeriod !== undefined && !/^\d+$/.test(t.countPerPeriod)) throw badRequest('BAD_REQUEST: paymentTerms.countPerPeriod must be a whole number')
  if (t.pointInTime !== undefined && !/^\d{2}$/.test(t.pointInTime)) throw badRequest('BAD_REQUEST: paymentTerms.pointInTime must be two digits')
  const terms: PaymentTerms = compact({
    frequency: t.frequency,
    type: t.type,
    amount: money(t.amount, 'paymentTerms.amount'),
    maximumAmount: money(t.maximumAmount, 'paymentTerms.maximumAmount'),
    countPerPeriod: t.countPerPeriod,
    pointInTime: t.pointInTime,
    firstPayment: first ? compact({ amount: money(first.amount, 'paymentTerms.firstPayment.amount'), date: first.date }) : undefined,
    lastPayment: last ? compact({ amount: money(last.amount, 'paymentTerms.lastPayment.amount'), date: last.date }) : undefined,
  })
  const max = terms.maximumAmount?.amountCents
  for (const [field, m] of [['amount', terms.amount], ['firstPayment.amount', terms.firstPayment?.amount], ['lastPayment.amount', terms.lastPayment?.amount]] as const) {
    if (max !== undefined && m !== undefined && m.amountCents > max) throw unprocessable(`INVALID_ARGUMENT: paymentTerms.${field} must not exceed paymentTerms.maximumAmount`)
  }
  return terms
}

export function moneyJson(m: Money | undefined): CurrencyAmount | undefined {
  return m ? { amount: fromCents(m.amountCents), currency: m.currency as CurrencyAmount['currency'] } : undefined
}

export function termsToJson(t: PaymentTerms): S['GetPaymentTermsDto'] {
  return compact({
    amount: moneyJson(t.amount),
    countPerPeriod: t.countPerPeriod,
    firstPayment: t.firstPayment ? compact({ amount: moneyJson(t.firstPayment.amount), date: t.firstPayment.date }) : undefined,
    frequency: t.frequency,
    lastPayment: t.lastPayment ? compact({ amount: moneyJson(t.lastPayment.amount), date: t.lastPayment.date }) : undefined,
    maximumAmount: moneyJson(t.maximumAmount),
    pointInTime: t.pointInTime,
    type: t.type,
  })
}

/** GetMandateActionsDetails*PaymentInformationDto: MMS string amounts. */
function paymentInformation(t: PaymentTerms): PaymentInformation {
  const str = (m: Money | undefined) => (m ? { amount: fromCents(m.amountCents).toFixed(2), currency: m.currency } : undefined)
  return compact({
    amount: str(t.amount),
    countPerPeriod: t.countPerPeriod,
    firstPaymentAmount: str(t.firstPayment?.amount),
    firstPaymentDate: t.firstPayment?.date,
    lastPaymentAmount: str(t.lastPayment?.amount),
    lastPaymentDate: t.lastPayment?.date,
    maximumAmount: str(t.maximumAmount),
    paymentAmountType: t.type,
    paymentFrequency: t.frequency,
    pointInTime: t.pointInTime,
  })
}

/** GetMandateActionsDetailsCreation{Creditor,Debtor}InformationDto. */
function partyInformation(p: PartyDetails, name: string): PartyInformation {
  return compact({
    accountId: p.accountId,
    accountNumber: p.accountNumber,
    accountAliasIdentification: p.accountAliasIdentification,
    accountAliasTypeCode: p.accountAliasType,
    accountIdentificationTypeCode: p.accountNumber ? ('BASIC_BANK_ACCOUNT_NUMBER' as const) : ('ALIAS' as const),
    accountServicerBic: p.accountNumber?.startsWith(LOCAL_BSB) ? BIC : undefined,
    partyName: name,
    partyReference: p.partyReference,
    partyType: p.partyType,
    ultimatePartyName: p.ultimatePartyName ?? name,
  })
}

/** ISO date-time (any precision) -> isoUtc microsecond form. */
function normaliseDateTime(s: string): string {
  const t = new Date(s).getTime()
  if (!Number.isFinite(t)) throw badRequest(`BAD_REQUEST: ${s} is not a valid ISO-8601 UTC date-time`)
  return isoUtc(new Date(t))
}

const PERIOD_MONTHS: Partial<Record<Frequency, number>> = { MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12 }
const PERIOD_DAYS: Partial<Record<Frequency, number>> = { DAILY: 1, INTRA_DAY: 1, WEEKLY: 7, FORTNIGHTLY: 14, ADHOC: 1 }

/**
 * The n-th due date (n >= 0) counted from the anchor (UTC calendar arithmetic): anchor + n periods, the day
 * clamped once to the target month's length, so a schedule anchored on the 31st keeps month ends
 * (01-31, 02-28, 03-31) instead of drifting to the 28th.
 */
export function nthDueDate(anchor: string, frequency: Frequency, n: number): string {
  const [y, mo, d] = anchor.split('-').map(Number) as [number, number, number]
  const months = PERIOD_MONTHS[frequency]
  if (months) {
    const target = new Date(Date.UTC(y, mo - 1 + months * n, 1))
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
    target.setUTCDate(Math.min(d, last))
    return isoDate(target)
  }
  return isoDate(new Date(Date.UTC(y, mo - 1, d + (PERIOD_DAYS[frequency] ?? 1) * n)))
}

/** The due date one period after `date` (nthDueDate(date, frequency, 1)). */
export function stepDate(date: string, frequency: Frequency): string {
  return nthDueDate(date, frequency, 1)
}
