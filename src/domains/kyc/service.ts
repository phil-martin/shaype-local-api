/**
 * KYC rules (spec §5.10): identity-verification cases and the manual approval of failed onboarding
 * stages on a REFERRED customer. The failed stages come from the customers domain's platform outcome
 * (customer.onboardingFailed, recorded here by events.ts); approving the last outstanding one activates
 * the customer through customers.setStatus so CUSTOMER_STATUS_UPDATED fires, preceded by ONBOARDING_PASSED.
 */
import { createHmac } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { components } from '../../contract/generated/b2b-types.js'
import type { AppContext } from '../../context.js'
import { compact } from '../../events/notify.js'
import { isoUtc } from '../../lib/clock.js'
import { badRequest, unprocessable } from '../../lib/errors.js'
import { uuid } from '../../lib/ids.js'
import type { Customer, CustomerStatus } from '../customers/index.js'
import type { CaseOutcome, ConsentObtained, KycCase, KycRepo, OnboardingStage, OnboardingStageRecord } from './repo.js'

export type UserConsentInput = components['schemas']['UserConsentRequestBody']
export type CreateCaseResponse = components['schemas']['CreateCaseExternalResponse']
export type ExternalCase = components['schemas']['ExternalCase']

/** The stages with an approval endpoint (DUPLICATE_CHECK has none). */
export type ApprovableStage = 'DOCUMENT_SCAN' | 'SANCTIONS_SCAN' | 'KYC_AML_SCAN'

export const ONBOARDING_STAGES: readonly OnboardingStage[] = ['DOCUMENT_SCAN', 'SANCTIONS_SCAN', 'KYC_AML_SCAN', 'DUPLICATE_CHECK']
export const APPROVABLE_STAGES: readonly ApprovableStage[] = ['DOCUMENT_SCAN', 'SANCTIONS_SCAN', 'KYC_AML_SCAN']
const CONSENT_VALUES: readonly ConsentObtained[] = ['yes', 'no', 'na']

/** Platform verdict on the linked case for each onboarding outcome (docs/map/kyc.md §3): WARNING = manual review. */
const CASE_OUTCOME_FOR_STATUS: Partial<Record<CustomerStatus, CaseOutcome>> = { ACTIVE: 'PASSED', REFERRED: 'WARNING', REJECTED: 'REJECTED' }

export interface ApprovalResult {
  customer: Customer
  stage: OnboardingStageRecord
  /** True when this approval cleared the last outstanding stage and activated the customer. */
  activated: boolean
  /** Failed stages still awaiting approval after this call. */
  outstanding: OnboardingStage[]
}

declare module '../../context.js' {
  interface ServiceMap {
    kyc: KycService
  }
}

export class KycService {
  constructor(private readonly ctx: AppContext, private readonly repo: KycRepo) {}

  /**
   * createCase: a NOT_EXECUTED case with the end-user hand-off credentials. The body is optional (docs
   * sample sends none): absent -> userLocationCountry AUS. Consent values are validated here (400) because
   * the route cannot attach a schema to an optional body.
   */
  createCase(input: UserConsentInput | undefined | null): KycCase {
    const consent = validateConsent(input)
    const now = this.ctx.clock.now()
    const id = uuid()
    const mobileToken = mintToken(id, now, this.ctx.config.clientSecret)
    const c: KycCase = compact({
      id,
      outcome: 'NOT_EXECUTED',
      createdAt: now.toISOString(),
      consentObtained: consent.consentObtained,
      consentObtainedAt: consent.consentObtainedAt,
      userIp: consent.userIp,
      userLocationCountry: consent.userLocationCountry,
      userLocationState: consent.userLocationState,
      mobileToken,
      webLink: `http://${this.ctx.config.host}:${this.ctx.config.port}/_kyc/web/v4/app/${id}?authorizationToken=${mobileToken}&locale=en-US`,
    })
    this.repo.insertCase(c)
    this.ctx.events.emit('kyc.caseCreated', { case: structuredClone(c) })
    return c
  }

  findCase(id: string): KycCase | undefined {
    return this.repo.caseById(id)
  }

  /** The case createHayCustomer linked to the customer (identityVerificationCaseId / journeyId), if any. */
  caseForCustomer(customerId: string): KycCase | undefined {
    return this.repo.casesForCustomer(customerId)[0]
  }

  /** Links an unlinked case to a customer; false when the case is unknown or already linked (a case belongs to one customer). */
  linkCase(caseId: string, customerId: string): boolean {
    return this.repo.linkCase(caseId, customerId)
  }

  /**
   * Platform onboarding outcome for the linked case: the first PENDING_APPROVAL exit decided by the
   * platform sets the vendor verdict (PASSED / WARNING / REJECTED) once; manual approvals never rewrite it.
   */
  reflectOnboardingOutcome(customer: Customer, previousStatus: CustomerStatus, actionOwner: 'CLIENT' | 'PLATFORM'): void {
    if (actionOwner !== 'PLATFORM' || previousStatus !== 'PENDING_APPROVAL') return
    const outcome = CASE_OUTCOME_FOR_STATUS[customer.status]
    if (!outcome) return
    for (const c of this.repo.casesForCustomer(customer.id)) this.repo.setOutcome(c.id, outcome)
  }

  /** Records a stage the platform failed (customer.onboardingFailed). Re-failing an approved stage reopens it. */
  recordFailure(customerId: string, stage: OnboardingStage, submissionFailure = false): OnboardingStageRecord {
    if (!ONBOARDING_STAGES.includes(stage)) throw new TypeError(`Unknown onboarding stage ${String(stage)}`)
    this.ctx.services.customers.get(customerId)
    const record: OnboardingStageRecord = { customerId, stage, result: 'FAILED', submissionFailure, failedAt: isoUtc(this.ctx.clock.now()) }
    this.repo.saveStage(record)
    return record
  }

  stages(customerId: string): OnboardingStageRecord[] {
    return this.repo.stagesFor(customerId)
  }

  /** Failed stages not yet approved, record order. */
  outstanding(customerId: string): OnboardingStage[] {
    return this.repo.stagesFor(customerId).filter((s) => s.result === 'FAILED').map((s) => s.stage)
  }

  /**
   * approveAmlKycCheck / approveDocumentCheck / approveSanctionCheck. Customer must exist (404) and be
   * REFERRED (422 INVALID_STATE). Marks the stage APPROVED with the comment (an already approved stage is
   * a no-op keeping the first comment); when no failed stage remains the customer becomes ACTIVE with
   * ONBOARDING_PASSED then CUSTOMER_STATUS_UPDATED, both actionOwner CLIENT.
   */
  approve(customerId: string, stage: ApprovableStage, comments?: string): ApprovalResult {
    if (!APPROVABLE_STAGES.includes(stage)) throw new TypeError(`Onboarding stage ${String(stage)} has no approval endpoint`)
    return this.ctx.db.transaction((): ApprovalResult => {
      const customers = this.ctx.services.customers
      let customer = customers.get(customerId)
      if (customer.status !== 'REFERRED') throw unprocessable(`INVALID_STATE: Customer ${customerId} is not REFERRED (status is ${customer.status}); onboarding checks can only be approved for a REFERRED customer`)
      let record = this.repo.stage(customerId, stage)
      if (record?.result !== 'APPROVED') {
        record = compact({ ...(record ?? { customerId, stage, submissionFailure: false }), result: 'APPROVED' as const, comments, approvedAt: isoUtc(this.ctx.clock.now()) })
        this.repo.saveStage(record)
      }
      const outstanding = this.outstanding(customerId)
      this.ctx.events.emit('kyc.stageApproved', { customer: structuredClone(customer), stage, comments, outstanding })
      const activated = outstanding.length === 0
      if (activated) {
        this.ctx.events.emit('kyc.onboardingCompleted', { customer: structuredClone(customer), actionOwner: 'CLIENT' })
        customer = customers.setStatus(customerId, 'ACTIVE', { actionOwner: 'CLIENT' })
      }
      return { customer, stage: record, activated, outstanding }
    })()
  }

  /** ExternalCase response body (scanCase): customerId only once linked. */
  toCaseResponse(c: KycCase): ExternalCase {
    return compact({ id: c.id, customerId: c.customerId, outcome: c.outcome, timestamp: c.createdAt })
  }

  toCreateCaseResponse(c: KycCase): CreateCaseResponse {
    return { scanCase: this.toCaseResponse(c), webLink: c.webLink, mobileToken: c.mobileToken }
  }
}

interface Consent {
  consentObtained?: ConsentObtained
  consentObtainedAt?: string
  userIp?: string
  userLocationCountry: string
  userLocationState?: string
}

/** Handler-side validation of the optional UserConsentRequestBody: schema types, the prose-only consent enum, RFC 3339 consentObtainedAt. */
export function validateConsent(input: unknown): Consent {
  if (input === undefined || input === null) return { userLocationCountry: 'AUS' }
  if (typeof input !== 'object' || Array.isArray(input)) throw badRequest('BAD_REQUEST: body must be object')
  const b = input as Record<string, unknown>
  const optionalString = (field: string): string | undefined => {
    const v = b[field]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string') throw badRequest(`BAD_REQUEST: body/${field} must be string,null`)
    return v
  }
  if (b.userLocationCountry !== undefined && typeof b.userLocationCountry !== 'string') throw badRequest('BAD_REQUEST: body/userLocationCountry must be string')
  const consentObtained = optionalString('consentObtained')
  if (consentObtained !== undefined && !CONSENT_VALUES.includes(consentObtained as ConsentObtained)) throw badRequest(`BAD_REQUEST: body/consentObtained must be one of 'yes', 'no', 'na'`)
  const consentObtainedAt = optionalString('consentObtainedAt')
  if (consentObtainedAt !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(consentObtainedAt) || Number.isNaN(Date.parse(consentObtainedAt)))) {
    throw badRequest('BAD_REQUEST: body/consentObtainedAt must match format "date-time"')
  }
  return compact({
    consentObtained: consentObtained as ConsentObtained | undefined,
    consentObtainedAt,
    userIp: optionalString('userIp'),
    userLocationCountry: (b.userLocationCountry as string | undefined) ?? 'AUS',
    userLocationState: optionalString('userLocationState'),
  })
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url')

/**
 * Mobile SDK token in the shape the docs sample shows (JWS, header {"alg":"HS512","zip":"GZIP"}, gzip-compressed
 * payload, HMAC-SHA512 over header.payload with the local client secret). Opaque to callers: nothing verifies it.
 */
export function mintToken(caseId: string, now: Date, secret: string): string {
  const iat = Math.floor(now.getTime() / 1000)
  const header = b64u(JSON.stringify({ alg: 'HS512', zip: 'GZIP' }))
  const payload = b64u(gzipSync(Buffer.from(JSON.stringify({ sub: caseId, iat, exp: iat + 3600, iss: 'shaype-local' }))))
  const signature = b64u(createHmac('sha512', secret).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${signature}`
}
