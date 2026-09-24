/**
 * PayID rules (spec §5.6, docs/map/payid-npp.md §3–§4): one live registration per (value, type), the
 * NPP status machine, availability / resolution views, de-register history, the NPP timers
 * (14-day PORTABLE revert, 90-day DEREGISTERED purge, 10-year inactivity disable) and the BSB
 * eligibility check. No PayID webhook exists in the notification spec, so nothing is emitted.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import type { AppContext } from '../../context.js'
import { compact } from '../../events/notify.js'
import { isoUtc } from '../../lib/clock.js'
import { badRequest, notFound, unprocessable } from '../../lib/errors.js'
import { uuid } from '../../lib/ids.js'
import type { Account } from '../accounts/index.js'
import type { PayId, PayIdReason, PayIdRepo, PayIdStatus, PayIdType } from './repo.js'

type S = components['schemas']
export type PayIdResponse = S['PayIdResponse']
export type PayIdDetailsResponse = S['PayIdDetailsResponse']
export type PayIdAccountDetails = S['PayIdAccountDetails']
export type PayIdResolveResponse = S['PayIdResolveResponse']
export type PayIdAvailabilityDetailsResponse = S['PayIdAvailabilityDetailsResponse']
export type PayIdDeregisterDetailsResponse = S['PayIdDeregisterDetailsResponse']
export type RegisterInput = S['PayIdRegisterRequestBody']
export type UpdateDetailsInput = S['UpdatePayIdDetailsRequestBody']
export type UpdateStatusInput = S['UpdatePayIdStatusRequestBody']

/** What transactions.transfer needs for a PAY_ID transfer (shape fixed by src/domains/transactions/deps.ts, extended with the account id). */
export interface ResolvedPayId {
  accountHayId: string
  accountNumber: string
  branchNumber: string
  ownerName: string
}

/** BIC11 reported as `servicer` for PayIDs registered locally. */
export const LOCAL_SERVICER_BIC = 'LOCLAU2SXXX'
/** The one BSB that is not NPP-enabled locally (spec §5.6 decision). */
export const NPP_INELIGIBLE_BSB = '999999'

const BSB_RE = /^\d{6}$/
const DAY_MS = 24 * 60 * 60 * 1000
export const PORTABLE_REVERT_DAYS = 14
export const DEREGISTERED_PURGE_DAYS = 90
export const INACTIVITY_DISABLE_YEARS = 10

/** updatePayIdStatus transitions (docs NPP state diagram + the critic's PORTABLE -> ACTIVE decision). DEREGISTERED is terminal. */
const TRANSITIONS: Record<PayIdStatus, readonly PayIdStatus[]> = {
  ACTIVE: ['DISABLED', 'PORTABLE', 'DEREGISTERED'],
  DISABLED: ['ACTIVE', 'DEREGISTERED'],
  PORTABLE: ['ACTIVE', 'DISABLED', 'DEREGISTERED'],
  DEREGISTERED: [],
}

/** Account statuses that accept a registration (open for resource creation, S7 gate). */
const OPEN_ACCOUNT = new Set(['APPROVED', 'ACTIVE', 'ACTIVE_IN_ARREARS', 'DORMANT'])

/** PayID reason on the account-closure cascade, whatever the closure reason (docs/map/00-status.md B.4 `[decision] reason: CUST`). */
const CLOSURE_REASON: PayIdReason = 'CUST'

declare module '../../context.js' {
  interface ServiceMap {
    payid: PayIdService
  }
}

export class PayIdService {
  constructor(private readonly ctx: AppContext, private readonly repo: PayIdRepo) {}

  private now(): string {
    return isoUtc(this.ctx.clock.now())
  }

  // ---------------------------------------------------------------- NPP

  /** verifyBranchIdentifier: every well-formed BSB is NPP-enabled except NPP_INELIGIBLE_BSB. */
  isNppEnabled(bsb: string): boolean {
    return BSB_RE.test(bsb) && bsb !== NPP_INELIGIBLE_BSB
  }

  // ---------------------------------------------------------------- reads

  find(value: string, type?: PayIdType): PayId | undefined {
    return this.repo.current(normalise(value, type), type)
  }

  /** @throws 404 NOT_FOUND when no registration (live or deregistered) exists for the value */
  get(value: string, type?: PayIdType): PayId {
    const p = this.find(value, type)
    if (!p) throw notFound(`NOT_FOUND: PayID ${value} not found`)
    return p
  }

  /** getPayId: account details + PayID details of the registration the value denotes (a DEREGISTERED one keeps its historical link). */
  details(value: string, type: PayIdType): PayIdResponse {
    const p = this.get(value, type)
    return { accountDetails: this.accountDetails(p), payIdDetails: this.toDetails(p) }
  }

  /** getPayIdsForAccount: every registration ever linked to the account, all statuses, registration order. */
  listForAccount(accountId: string): PayIdDetailsResponse[] {
    this.ctx.services.accounts.get(accountId)
    return this.repo.byAccount(accountId).map((p) => this.toDetails(p))
  }

  /**
   * getPayIdAvailability: true when nothing live holds the value (never registered, DEREGISTERED, or
   * PORTABLE — portability exists so that another account can register it); false while ACTIVE or
   * DISABLED. The other fields describe the registration the value denotes, when there is one.
   */
  availability(value: string, type?: PayIdType): PayIdAvailabilityDetailsResponse {
    const p = this.find(value, type)
    if (!p) return { availability: true }
    const held = p.status === 'ACTIVE' || p.status === 'DISABLED'
    return compact({
      availability: !held,
      registrationDateTimeUtc: p.registeredAt,
      lastUpdatedDateTimeUtc: p.updatedAt,
      lastResolutionDateTimeUtc: p.lastResolvedAt,
      reason: p.reason,
      servicer: p.status === 'DEREGISTERED' ? undefined : LOCAL_SERVICER_BIC,
    })
  }

  /**
   * resolvePayId: the linked account for an ACTIVE or PORTABLE registration; records the resolution.
   * @throws 404 unknown value; 422 INVALID_STATE when DISABLED or DEREGISTERED
   */
  resolveOrThrow(value: string, type?: PayIdType): PayIdResolveResponse {
    const p = this.get(value, type)
    if (!canReceive(p)) throw unprocessable(`INVALID_STATE: PayID ${value} is ${p.status} and cannot be resolved`)
    this.touchResolved(p)
    return { accountDetails: this.accountDetails(p), payIdName: p.payIdName, payIdType: p.type, payIdValue: p.value }
  }

  /** transactions.transfer (PAY_ID): the linked account when the PayID can receive payments, else undefined (-> REFUSED_INVALID_PAY_ID). */
  resolve(value: string, type?: PayIdType): ResolvedPayId | undefined {
    const p = this.find(value, type)
    if (!p || !canReceive(p)) return undefined
    const account = this.ctx.services.accounts.find(p.accountId)
    if (!account) return undefined
    this.touchResolved(p)
    return { accountHayId: account.id, accountNumber: account.accountNumber, branchNumber: account.bsb, ownerName: p.ownerName }
  }

  /** getPayIdDeregisterHistory: one entry per past deregistration of the value, every type, oldest first ([] when none). */
  deregisterHistory(value: string): PayIdDeregisterDetailsResponse[] {
    return this.repo.deregistrations(value.trim()).map((d) => compact({
      registrationDateTimeUtc: d.registeredAt,
      lastUpdatedDateTimeUtc: d.deregisteredAt,
      payIdName: d.payIdName,
      reason: d.reason,
    }))
  }

  // ---------------------------------------------------------------- writes

  /**
   * postPayIdRegister. Account must exist (404) and be open (422 ACCOUNT_BLOCKED / ACCOUNT_CLOSED) on an
   * NPP-enabled BSB (422 NPP_NOT_ENABLED); every owning customer ACTIVE (422 PERMISSION_DENIED); the value
   * must match its type's format (422 INVALID_PAY_ID; EMAIL is lower-cased). A value held elsewhere
   * (ACTIVE / DISABLED on another account, or DISABLED on this one) -> 422 PAYID_ALREADY_REGISTERED; already
   * ACTIVE on this account -> no-op; PORTABLE on this account -> back to ACTIVE; PORTABLE on another account
   * -> ported (old registration DEREGISTERED, reason PART, history entry). DEREGISTERED values re-register
   * freely. Returns the live registration.
   */
  register(accountId: string, rawValue: string, input: RegisterInput): PayId {
    const account = this.ctx.services.accounts.get(accountId)
    if (account.status === 'LOCKED') throw unprocessable(`ACCOUNT_BLOCKED: Account ${accountId} is LOCKED`)
    if (account.status === 'CLOSED') throw unprocessable(`ACCOUNT_CLOSED: Account ${accountId} is CLOSED`)
    if (!OPEN_ACCOUNT.has(account.status)) throw unprocessable(`INVALID_STATE: Account ${accountId} is ${account.status}`)
    if (!this.isNppEnabled(account.bsb)) throw unprocessable(`NPP_NOT_ENABLED: Account ${accountId} is held at BSB ${account.bsb}, which is not enabled for NPP`)
    this.requireHoldersActive(account)
    const type = input.payIdType
    const value = validateValue(rawValue, type)
    const ownerName = requireText(input.ownerName, 'ownerName')
    const payIdName = requireText(input.payIdName, 'payIdName')
    const now = this.now()

    const live = this.repo.live(value, type)
    if (live) {
      if (live.accountId === accountId) {
        if (live.status === 'ACTIVE') return live
        if (live.status === 'PORTABLE') {
          live.status = 'ACTIVE'
          delete live.reason
          delete live.portableSince
          live.ownerName = ownerName
          live.payIdName = payIdName
          live.updatedAt = now
          this.repo.save(live)
          this.changed(live, 'PORTABLE')
          return live
        }
        throw unprocessable(`PAYID_ALREADY_REGISTERED: PayID ${value} (${type}) is already registered to account ${accountId} with status ${live.status}`)
      }
      if (live.status !== 'PORTABLE') throw unprocessable(`PAYID_ALREADY_REGISTERED: PayID ${value} (${type}) is already registered to another account`)
      // Port: the other account's registration ends (NPP participant initiated) and this account takes the value.
      return this.ctx.db.transaction(() => {
        this.deregister(live, 'PART', now)
        return this.createRegistration(accountId, value, type, ownerName, payIdName, now)
      })()
    }
    return this.createRegistration(accountId, value, type, ownerName, payIdName, now)
  }

  /**
   * updatePayIdDetails: ownerName / payIdName of the live registration; omitted or null fields are left
   * unchanged, an empty string is a 400. Allowed in every status but DEREGISTERED (422 INVALID_STATE).
   * @throws 404 unknown value
   */
  updateDetails(rawValue: string, input: UpdateDetailsInput): PayId {
    const p = this.requireLive(rawValue, input.payIdType)
    const ownerName = optionalText(input.ownerName, 'ownerName')
    const payIdName = optionalText(input.payIdName, 'payIdName')
    if ((ownerName === undefined || ownerName === p.ownerName) && (payIdName === undefined || payIdName === p.payIdName)) return p
    if (ownerName !== undefined) p.ownerName = ownerName
    if (payIdName !== undefined) p.payIdName = payIdName
    p.updatedAt = this.now()
    this.repo.save(p)
    return p
  }

  /**
   * updatePayIdStatus per the NPP state model: ACTIVE -> DISABLED | PORTABLE | DEREGISTERED,
   * DISABLED -> ACTIVE | DEREGISTERED, PORTABLE -> ACTIVE | DISABLED | DEREGISTERED. Same status -> no-op.
   * Any other move -> 422 INVALID_STATUS_TRANSITION; a DEREGISTERED PayID -> 422 INVALID_STATE (it must be
   * registered again). `reason` (any code with any status) replaces the stored reason; null / omitted clears it.
   * @throws 404 unknown value
   */
  updateStatus(rawValue: string, input: UpdateStatusInput): PayId {
    const p = this.requireLive(rawValue, input.payIdType)
    const to = input.payIdStatus
    if (p.status === to) return p
    if (!TRANSITIONS[p.status].includes(to)) throw unprocessable(`INVALID_STATUS_TRANSITION: PayID ${p.value} cannot move from ${p.status} to ${to}`)
    const now = this.now()
    if (to === 'DEREGISTERED') {
      this.ctx.db.transaction(() => this.deregister(p, input.reason ?? undefined, now))()
      return p
    }
    const from = p.status
    p.status = to
    if (input.reason) p.reason = input.reason
    else delete p.reason
    if (to === 'PORTABLE') p.portableSince = now
    else delete p.portableSince
    p.updatedAt = now
    this.repo.save(p)
    this.changed(p, from)
    return p
  }

  /** Account-closure cascade: every live registration on the account is deregistered with reason CUST (docs:account-closure; 00-status B.4). */
  deregisterAllForAccount(accountId: string): void {
    const now = this.now()
    const live = this.repo.byAccount(accountId).filter((p) => p.status !== 'DEREGISTERED')
    if (!live.length) return
    this.ctx.db.transaction(() => {
      for (const p of live) this.deregister(p, CLOSURE_REASON, now)
    })()
  }

  /** updateCustomer name change (unless skipPayIdUpdate): ownerName on every live PayID of the customer's own accounts. */
  propagateOwnerName(customerHayId: string, ownerName: string): number {
    if (!ownerName) return 0
    const accountIds = this.ctx.services.accounts.listEntitiesForHolder(customerHayId, 'CUSTOMER').map((a) => a.id)
    const now = this.now()
    let changed = 0
    for (const p of this.repo.liveByAccounts(accountIds)) {
      if (p.ownerName === ownerName) continue
      p.ownerName = ownerName
      p.updatedAt = now
      this.repo.save(p)
      changed++
    }
    return changed
  }

  // ---------------------------------------------------------------- timers

  /**
   * NPP timers on the virtual clock: PORTABLE reverts to ACTIVE after 14 days without a registration
   * elsewhere; a DEREGISTERED record is purged 90 days after deregistration (its history entry stays);
   * an ACTIVE PayID with no activity for 10 years is DISABLED (reason PART).
   */
  tick(): void {
    const nowMs = this.ctx.clock.now().getTime()
    const now = isoUtc(new Date(nowMs))
    const cutoff = (ms: number) => isoUtc(new Date(nowMs - ms))
    for (const p of this.repo.portableSince(cutoff(PORTABLE_REVERT_DAYS * DAY_MS))) {
      p.status = 'ACTIVE'
      delete p.reason
      delete p.portableSince
      p.updatedAt = now
      this.repo.save(p)
      this.changed(p, 'PORTABLE')
    }
    for (const p of this.repo.deregisteredSince(cutoff(DEREGISTERED_PURGE_DAYS * DAY_MS))) this.repo.delete(p.id)
    for (const p of this.repo.inactiveSince(cutoff(INACTIVITY_DISABLE_YEARS * 365 * DAY_MS))) {
      p.status = 'DISABLED'
      p.reason = 'PART'
      p.updatedAt = now
      this.repo.save(p)
      this.changed(p, 'ACTIVE')
    }
  }

  // ---------------------------------------------------------------- views

  toDetails(p: PayId): PayIdDetailsResponse {
    return compact({
      payIdValue: p.value,
      payIdType: p.type,
      payIdName: p.payIdName,
      status: p.status,
      reason: p.reason,
      registrationDateTimeUtc: p.registeredAt,
      lastUpdatedDateTimeUtc: p.updatedAt,
      lastResolutionDateTimeUtc: p.lastResolvedAt,
    })
  }

  private accountDetails(p: PayId): PayIdAccountDetails {
    const account = this.ctx.services.accounts.find(p.accountId)
    return compact({ accountNumber: account?.accountNumber, branchNumber: account?.bsb, ownerName: p.ownerName })
  }

  // ---------------------------------------------------------------- internals

  /** The live registration for (value, type): 404 when the value was never registered, 422 INVALID_STATE when only a DEREGISTERED one exists. */
  private requireLive(rawValue: string, type: PayIdType): PayId {
    const p = this.get(rawValue, type)
    if (p.status === 'DEREGISTERED') throw unprocessable(`INVALID_STATE: PayID ${p.value} is DEREGISTERED and must be registered again before it can be updated`)
    return p
  }

  private requireHoldersActive(account: Account): void {
    const customers = this.ctx.services.customers
    for (const id of this.ctx.services.accounts.holderCustomerIds(account)) {
      if (customers.find(id)) customers.requireActive(id, 'PayID')
    }
  }

  private createRegistration(accountId: string, value: string, type: PayIdType, ownerName: string, payIdName: string, now: string): PayId {
    const p: PayId = { id: uuid(), value, type, accountId, status: 'ACTIVE', ownerName, payIdName, registeredAt: now, updatedAt: now }
    this.repo.insert(p)
    this.ctx.events.emit('payid.registered', { payId: structuredClone(p) })
    return p
  }

  private changed(p: PayId, previousStatus: PayIdStatus): void {
    this.ctx.events.emit('payid.statusChanged', { payId: structuredClone(p), previousStatus })
  }

  /** -> DEREGISTERED (link kept as history) plus a de-register history entry. Caller wraps in a transaction. */
  private deregister(p: PayId, reason: PayIdReason | undefined, now: string): void {
    const from = p.status
    p.status = 'DEREGISTERED'
    if (reason) p.reason = reason
    else delete p.reason
    delete p.portableSince
    p.deregisteredAt = now
    p.updatedAt = now
    this.repo.save(p)
    this.repo.insertDeregistration({ id: uuid(), payIdId: p.id, value: p.value, type: p.type, accountId: p.accountId, payIdName: p.payIdName, reason, registeredAt: p.registeredAt, deregisteredAt: now })
    this.changed(p, from)
  }

  private touchResolved(p: PayId): void {
    p.lastResolvedAt = this.now()
    this.repo.save(p)
  }
}

/** ACTIVE and PORTABLE PayIDs receive payments; DISABLED and DEREGISTERED do not (docs:payid). */
function canReceive(p: PayId): boolean {
  return p.status === 'ACTIVE' || p.status === 'PORTABLE'
}

const TELEPHONE_RE = /^\+\d{1,3}-[1-9]\d*$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/
const AUBN_RE = /^\d{9,11}$/
const MAX_LEN = 256

/** Storage form of a value: trimmed, EMAIL lower-cased (the NPP addressing service is case-insensitive). */
export function normalise(value: string, type?: PayIdType): string {
  const v = value.trim()
  return type === 'EMAIL' || (type === undefined && v.includes('@')) ? v.toLowerCase() : v
}

/**
 * Per-type format (docs:payid PayID Types): TELEPHONE `+<cc 1-3 digits>-<1-9><digits>`; EMAIL <= 256 chars,
 * one `@` with characters either side, no whitespace (lower-cased); INDIVIDUAL_AUSTRALIAN_BUSINESS 9-11
 * digits; ORGANISATION free text <= 256 chars. -> 422 INVALID_PAY_ID
 */
export function validateValue(raw: string, type: PayIdType): string {
  const value = normalise(raw, type)
  const invalid = (why: string) => unprocessable(`INVALID_PAY_ID: ${raw} is not a valid ${type} PayID (${why})`)
  if (!value) throw invalid('empty')
  if (value.length > MAX_LEN) throw invalid(`longer than ${MAX_LEN} characters`)
  switch (type) {
    case 'TELEPHONE':
      if (!TELEPHONE_RE.test(value)) throw invalid('expected +<country code>-<number>, e.g. +61-423765879')
      break
    case 'EMAIL':
      if (!EMAIL_RE.test(value)) throw invalid('expected an email address without whitespace, e.g. test@email.com')
      break
    case 'INDIVIDUAL_AUSTRALIAN_BUSINESS':
      if (!AUBN_RE.test(value)) throw invalid('expected a 9-11 digit ABN / ACN / ARBN / ARSN')
      break
    case 'ORGANISATION':
      break
  }
  return value
}

function requireText(v: string, field: string): string {
  const t = v.trim()
  if (!t) throw badRequest(`BAD_REQUEST: ${field} must not be empty`)
  return t
}

function optionalText(v: string | null | undefined, field: string): string | undefined {
  if (v === undefined || v === null) return undefined
  return requireText(v, field)
}
