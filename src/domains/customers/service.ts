/**
 * Customer rules (spec §5.1): creation + uniqueness, asynchronous onboarding, status machine,
 * partial updates with change detection. Emits one domain event per state change.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import type { AppContext } from '../../context.js'
import { compact, type ActionOwner } from '../../events/notify.js'
import { isoUtc } from '../../lib/clock.js'
import { badRequest, notFound, unprocessable } from '../../lib/errors.js'
import { stableHash } from '../../lib/idempotency.js'
import { uuid } from '../../lib/ids.js'
import type { OnboardingFailedState, CustomerDetailsChanges } from './events.js'
import { normalizePhone, type BlockedBy, type Customer, type CustomerRepo, type CustomerStatus, type Page, type SearchFilters, type StatusReason, type TaxObligation } from './repo.js'

export type HayCustomer = components['schemas']['HayCustomer']
export type CreateCustomerInput = components['schemas']['CreateHayCustomerRequestBody']
export type UpdateCustomerInput = components['schemas']['UpdateCustomerRequestBody']

export interface StatusOptions {
  actionOwner: ActionOwner
  /** Stored when the target status is INACTIVE (closure reason). */
  statusReason?: StatusReason
  /** Stored when the target status is BLOCKED; defaults to the actionOwner. */
  blockedBy?: BlockedBy
}

declare module '../../context.js' {
  interface ServiceMap {
    customers: CustomersService
  }
}

export class CustomersService {
  constructor(private readonly ctx: AppContext, private readonly repo: CustomerRepo) {}

  find(id: string): Customer | undefined {
    return this.repo.byId(id)
  }

  /** @throws 404 NOT_FOUND */
  get(id: string): Customer {
    const c = this.repo.byId(id)
    if (!c) throw notFound(`NOT_FOUND: Customer ${id} not found`)
    return c
  }

  /** Alias of get(): the customer must exist. */
  require(id: string): Customer {
    return this.get(id)
  }

  /** @throws 404 when unknown; 422 `PERMISSION_DENIED: <subject> cannot be created for customer with id <id> as their status is currently <STATUS>` when not ACTIVE. */
  requireActive(id: string, subject = 'Account'): Customer {
    const c = this.get(id)
    if (c.status !== 'ACTIVE') throw unprocessable(`PERMISSION_DENIED: ${subject} cannot be created for customer with id ${id} as their status is currently ${c.status}`)
    return c
  }

  list(page: Page): Customer[] {
    return this.repo.list(page)
  }

  search(filters: SearchFilters, page: Page): Customer[] {
    return this.repo.search(filters, page)
  }

  /** HayCustomer response body: absent optionals are omitted, tax obligations and KYC flags are write-only. */
  toResponse(c: Customer): HayCustomer {
    const doc = c.identityDocument
    return compact({
      customerHayId: c.id,
      status: c.status,
      statusReason: c.statusReason,
      blockedBy: c.blockedBy,
      tier: c.tier,
      email: c.email,
      phoneNumber: { ...c.phoneNumber },
      address: { ...c.address },
      customerDetails: { ...c.customerDetails },
      customData: c.customData as HayCustomer['customData'],
      deviceId: c.deviceId,
      identityDocumentType: doc.type,
      identityDocumentNumber: doc.number,
      identityDocumentCardNumber: doc.cardNumber,
      identityDocumentExpiry: doc.expiry,
      identityDocumentIssuingCountry: doc.issuingCountry,
      identityDocumentRegion: doc.region,
      creationDateTimeUtc: c.createdAt,
      approvedDateTimeUtc: c.approvedAt,
      closedDateTimeUtc: c.closedAt,
      lastUpdatedDateTimeUtc: c.updatedAt,
    })
  }

  /**
   * createHayCustomer: PENDING_APPROVAL, uniqueness enforced (422 DUPLICATE_CUSTOMER), onboarding
   * outcome scheduled unless the client runs its own KYC (skipKyc) or the email carries the +pending tag.
   */
  create(input: CreateCustomerInput): Customer {
    if (input.skipKyc && input.onlySanctionsCheck) throw badRequest('BAD_REQUEST: skipKyc and onlySanctionsCheck cannot both be true')
    const now = isoUtc(this.ctx.clock.now())
    const c: Customer = compact({
      id: uuid(),
      status: 'PENDING_APPROVAL',
      tier: input.customerTier,
      email: input.email,
      phoneNumber: normalizePhone(input.phoneNumber),
      address: { ...input.address },
      customerDetails: { ...input.customerDetails, gender: input.customerDetails.gender ?? 'OTHER' },
      customData: input.customData as Record<string, unknown> | null | undefined, // explicit null is kept and echoed (nullable field)
      externalCustomerId: input.externalCustomerId,
      deviceId: 'NOT_SPECIFIED',
      identityDocument: {
        type: input.identityDocumentType,
        number: input.identityDocumentNumber,
        cardNumber: input.identityDocumentCardNumber,
        expiry: input.identityDocumentExpiry ?? undefined,
        issuingCountry: input.identityDocumentIssuingCountry,
        region: input.identityDocumentRegion,
      },
      identityVerificationCaseId: input.identityVerificationCaseId ?? input.journeyId ?? undefined,
      skipKyc: input.skipKyc === true,
      onlySanctionsCheck: input.onlySanctionsCheck === true,
      taxObligations: taxList(input.taxObligations),
      createdAt: now,
    })
    this.assertUnique(c)
    this.repo.insert(c)
    this.ctx.events.emit('customer.created', { customer: structuredClone(c) })
    if (!c.skipKyc && !emailTags(c.email).has('pending')) {
      this.ctx.scheduler.later(() => this.completeOnboarding(c.id))
    }
    return c
  }

  /**
   * Platform onboarding outcome (spec §5.1 test steering): +referred -> REFERRED (ONBOARDING_FAILED
   * KYC_AML_SCAN), +rejected -> REJECTED (ONBOARDING_FAILED DOCUMENT_SCAN), otherwise ACTIVE
   * (ONBOARDING_PASSED). Reduced KYC (onlySanctionsCheck) runs Sanctions Screening only
   * [docs:flexible-kyc-checks], so both failures name SANCTIONS_SCAN there. Skipped when the client
   * already moved the customer out of PENDING_APPROVAL.
   */
  completeOnboarding(id: string): void {
    const c = this.repo.byId(id)
    if (!c || c.status !== 'PENDING_APPROVAL') return
    const tags = emailTags(c.email)
    if (tags.has('referred')) {
      this.failOnboarding(c, 'REFERRED', c.onlySanctionsCheck ? 'SANCTIONS_SCAN' : 'KYC_AML_SCAN')
    } else if (tags.has('rejected')) {
      this.failOnboarding(c, 'REJECTED', c.onlySanctionsCheck ? 'SANCTIONS_SCAN' : 'DOCUMENT_SCAN')
    } else {
      this.ctx.events.emit('customer.onboardingPassed', { customer: structuredClone(c) })
      this.transition(c, 'ACTIVE', { actionOwner: 'PLATFORM' })
    }
  }

  private failOnboarding(c: Customer, to: 'REFERRED' | 'REJECTED', state: OnboardingFailedState): void {
    this.ctx.events.emit('customer.onboardingFailed', { customer: structuredClone(c), state, submissionFailure: false })
    this.transition(c, to, { actionOwner: 'PLATFORM' })
  }

  /**
   * updateCustomer: only supplied fields change; address / phoneNumber / documentData replace as a whole;
   * taxObligations replaces the list ([] clears it). No effective change -> no save, no event.
   */
  update(id: string, input: UpdateCustomerInput): Customer {
    const before = this.get(id)
    if (before.status === 'INACTIVE') throw unprocessable(`INVALID_STATE: Customer ${id} is INACTIVE and cannot be updated`)
    const next = structuredClone(before)
    if (input.address !== undefined) next.address = { ...input.address }
    if (input.phoneNumber !== undefined) next.phoneNumber = normalizePhone(input.phoneNumber)
    if (input.email !== undefined) next.email = input.email
    const d = next.customerDetails
    if (input.firstName !== undefined) d.firstName = input.firstName
    if (input.lastName !== undefined) d.lastName = input.lastName
    if (input.middleName !== undefined) d.middleName = input.middleName
    if (input.preferredName !== undefined) d.preferredName = input.preferredName
    if (input.title !== undefined) d.title = input.title
    if (input.gender !== undefined) d.gender = input.gender
    if (input.dateOfBirth !== undefined) d.dateOfBirth = input.dateOfBirth
    if (input.documentData !== undefined) {
      const doc = input.documentData
      next.identityDocument = compact({
        type: doc.identityDocumentType,
        number: doc.identityDocumentNumber,
        issuingCountry: doc.identityDocumentIssuingCountry,
        cardNumber: doc.identityDocumentCardNumber,
        expiry: doc.identityDocumentExpiry,
        region: doc.identityDocumentRegion,
      })
    }
    if (input.taxObligations !== undefined) next.taxObligations = taxList(input.taxObligations)
    if (same(before, next)) return before

    const changes: CustomerDetailsChanges = {
      phoneNumberChanged: !same(before.phoneNumber, next.phoneNumber),
      customerNameChanged: before.customerDetails.firstName !== d.firstName || before.customerDetails.lastName !== d.lastName || (before.customerDetails.middleName ?? '') !== (d.middleName ?? ''),
      emailAddressChanged: before.email !== next.email,
      addressChanged: !same(before.address, next.address),
    }
    this.assertUnique(next, before.id)
    next.updatedAt = isoUtc(this.ctx.clock.now())
    this.repo.save(next)
    this.ctx.events.emit('customer.detailsChanged', { customer: structuredClone(next), previous: before, changes, skipPayIdUpdate: input.skipPayIdUpdate === true })
    return next
  }

  /**
   * Generic status change. Same status -> no-op (no event). Leaving INACTIVE -> 422 INVALID_STATE.
   * Sets approvedDateTimeUtc on the first ACTIVE, closedDateTimeUtc + statusReason on INACTIVE,
   * blockedBy on BLOCKED (cleared otherwise). Emits customer.statusChanged.
   */
  setStatus(id: string, status: CustomerStatus, opts: StatusOptions): Customer {
    return this.transition(this.get(id), status, opts)
  }

  /** changeHayCustomerStatus: any enum value; INACTIVE is treated as a client withdrawal (statusReason CUSTOMER). */
  changeStatus(id: string, status: CustomerStatus): Customer {
    return this.setStatus(id, status, { actionOwner: 'CLIENT', statusReason: status === 'INACTIVE' ? 'CUSTOMER' : undefined })
  }

  /** blockCustomer: -> BLOCKED. Already BLOCKED -> no-op. INACTIVE -> 422. */
  block(id: string, opts: { note?: string; actionOwner?: ActionOwner; blockedBy?: BlockedBy } = {}): Customer {
    const c = this.get(id)
    if (c.status === 'BLOCKED') return c
    if (opts.note !== undefined) c.blockNote = opts.note
    return this.transition(c, 'BLOCKED', { actionOwner: opts.actionOwner ?? 'CLIENT', blockedBy: opts.blockedBy })
  }

  /** unblockCustomer: BLOCKED -> ACTIVE (never the pre-block status). Not BLOCKED -> 422 INVALID_STATE. */
  unblock(id: string, opts: { actionOwner?: ActionOwner } = {}): Customer {
    const c = this.get(id)
    if (c.status !== 'BLOCKED') throw unprocessable(`INVALID_STATE: Customer ${id} is not BLOCKED (status is ${c.status})`)
    return this.transition(c, 'ACTIVE', { actionOwner: opts.actionOwner ?? 'CLIENT' })
  }

  /** Account-closure / group-removal cascade: -> INACTIVE with the closure reason (no-op when already INACTIVE). */
  markInactive(id: string, reason?: StatusReason): Customer {
    const c = this.get(id)
    if (c.status === 'INACTIVE') return c
    return this.transition(c, 'INACTIVE', { actionOwner: 'PLATFORM', statusReason: reason })
  }

  private transition(c: Customer, to: CustomerStatus, opts: StatusOptions): Customer {
    if (c.status === to) return c
    if (c.status === 'INACTIVE') throw unprocessable(`INVALID_STATE: Customer ${c.id} is INACTIVE and cannot move to ${to}`)
    const from = c.status
    const now = isoUtc(this.ctx.clock.now())
    c.status = to
    c.updatedAt = now
    if (to === 'BLOCKED') c.blockedBy = opts.blockedBy ?? opts.actionOwner
    else delete c.blockedBy
    if (to === 'ACTIVE' && !c.approvedAt) c.approvedAt = now
    if (to === 'INACTIVE') {
      c.closedAt = now
      if (opts.statusReason) c.statusReason = opts.statusReason
      else delete c.statusReason
    } else {
      delete c.statusReason
    }
    this.repo.save(c)
    this.ctx.events.emit('customer.statusChanged', { customer: structuredClone(c), previousStatus: from, actionOwner: opts.actionOwner })
    return c
  }

  private assertUnique(c: Customer, excludeId?: string): void {
    const dup = this.repo.findDuplicate(c, excludeId)
    if (dup) throw unprocessable(`DUPLICATE_CUSTOMER: A customer with the same ${dup.rule} already exists (customerHayId ${dup.id})`)
  }
}

/** `+tag` parts of the email local part, lower-cased (test steering for the onboarding outcome). */
export function emailTags(email: string): Set<string> {
  const local = email.split('@')[0] ?? ''
  return new Set(local.split('+').slice(1).map((t) => t.toLowerCase()))
}

function same(a: unknown, b: unknown): boolean {
  return stableHash(compact(a)) === stableHash(compact(b))
}

/** Tax obligations are stored in one form only: a non-empty list or absent. */
function taxList(list: TaxObligation[] | undefined): TaxObligation[] | undefined {
  return list && list.length ? list.map((t) => ({ ...t })) : undefined
}
