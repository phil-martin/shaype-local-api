import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '../src/contract/generated/b2b-types.js'
import { startApp } from './helpers.js'
import { assertValidNotification } from './webhook-schema.js'
import type { BuiltServer } from '../src/server.js'

type CreateBody = components['schemas']['CreateHayCustomerRequestBody']
type HayCustomer = components['schemas']['HayCustomer']
type CreateCaseResponse = components['schemas']['CreateCaseExternalResponse']

const KYC_OPS = ['createCase', 'approveAmlKycCheck', 'approveDocumentCheck', 'approveSanctionCheck']
const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const CASES_URL = '/v1/kyc/identity-verification/cases'
const APPROVAL: Record<'aml' | 'document' | 'sanction', string> = { aml: 'amlKycCheck', document: 'documentCheck', sanction: 'sanctionCheck' }

let built: BuiltServer
let app: BuiltServer['app']
beforeAll(async () => { built = await startApp(); app = built.app })
afterAll(async () => { await built.app.close() })

let n = 0
function customerBody(overrides: Partial<CreateBody> & { emailTag?: string } = {}): CreateBody {
  n++
  const { emailTag, ...rest } = overrides
  return {
    idempotencyKey: randomUUID(),
    email: `kyc${n}${emailTag ? `+${emailTag}` : ''}@example.com`,
    customerTier: 'STANDARD',
    phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: `4${String(n).padStart(8, '0')}` },
    address: { line1: '395 Bourke St', townOrCity: 'Melbourne', administrativeRegion: 'VIC', postcode: '3000', countryCodeIso: 'AUS' },
    customerDetails: { firstName: 'Kay', lastName: `Cee${n}`, dateOfBirth: '1990-01-01' },
    ...rest,
  }
}
async function flush(): Promise<void> {
  await app.inject({ method: 'POST', url: '/_admin/flush' })
}
async function createCustomer(overrides: Partial<CreateBody> & { emailTag?: string } = {}): Promise<HayCustomer> {
  const res = await app.inject({ method: 'POST', url: '/v0/customers/create', payload: customerBody(overrides) })
  expect(res.statusCode, res.body).toBe(200)
  await flush()
  return getCustomer((res.json() as HayCustomer).customerHayId!)
}
async function getCustomer(id: string): Promise<HayCustomer> {
  const res = await app.inject({ method: 'GET', url: `/v0/customers/${id}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as HayCustomer
}
async function referred(): Promise<HayCustomer> {
  const c = await createCustomer({ emailTag: 'referred' })
  expect(c.status).toBe('REFERRED')
  return c
}
async function approve(customerId: string, check: keyof typeof APPROVAL, payload: unknown = {}) {
  return app.inject({ method: 'POST', url: `/v1/kyc/${customerId}/onboarding/${APPROVAL[check]}/approval`, payload: payload as Record<string, unknown> })
}
async function payloadsFor(customerHayId: string): Promise<any[]> {
  await flush()
  const res = await app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })
  const payloads = (res.json() as { payload: any }[]).map((r) => r.payload).filter((p) => p.customerHayId === customerHayId)
  for (const p of payloads) assertValidNotification(p)
  return payloads
}
async function createCase(payload?: unknown): Promise<CreateCaseResponse> {
  const res = await app.inject({ method: 'POST', url: CASES_URL, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as CreateCaseResponse
}

describe('kyc domain: registration', () => {
  it('handles every KYC API operation (none left on the stub)', async () => {
    const res = await app.inject({ method: 'GET', url: '/_admin/operations' })
    const { handled, stubbed } = res.json() as { handled: string[]; stubbed: string[] }
    for (const op of KYC_OPS) {
      expect(handled, op).toContain(op)
      expect(stubbed, op).not.toContain(op)
    }
  })
})

describe('createCase', () => {
  it('creates a NOT_EXECUTED case shaped like the docs sample, with the hand-off link and token', async () => {
    const body = { consentObtained: 'yes', consentObtainedAt: '2026-09-24T01:02:03Z', userIp: '203.0.113.7', userLocationCountry: 'AUS', userLocationState: 'VIC' }
    const res = await app.inject({ method: 'POST', url: CASES_URL, payload: body })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers).not.toHaveProperty('x-shaype-local-stub')
    const c = res.json() as CreateCaseResponse
    expect(c.scanCase!.id).toMatch(UUID)
    expect(c.scanCase!.outcome).toBe('NOT_EXECUTED')
    expect(c.scanCase!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(c.scanCase).not.toHaveProperty('customerId')
    expect(c.mobileToken!.split('.')).toHaveLength(3)
    expect(c.mobileToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(JSON.parse(Buffer.from(c.mobileToken!.split('.')[0]!, 'base64url').toString())).toEqual({ alg: 'HS512', zip: 'GZIP' })
    const link = new URL(c.webLink!)
    expect(link.host).toBe('127.0.0.1:8080')
    expect(link.searchParams.get('authorizationToken')).toBe(c.mobileToken)
    expect(link.searchParams.get('locale')).toBe('en-US')
    expect(link.pathname).toContain(c.scanCase!.id)

    const stored = built.ctx.services.kyc.findCase(c.scanCase!.id!)!
    expect(stored).toMatchObject({ id: c.scanCase!.id, outcome: 'NOT_EXECUTED', consentObtained: 'yes', consentObtainedAt: body.consentObtainedAt, userIp: body.userIp, userLocationCountry: 'AUS', userLocationState: 'VIC', mobileToken: c.mobileToken, webLink: c.webLink })
    expect(stored).not.toHaveProperty('customerId')
  })

  it('webLink names localhost when the server binds a wildcard address (0.0.0.0 / ::)', async () => {
    for (const host of ['0.0.0.0', '::']) {
      const wildcard = await startApp({ host, port: 9090 })
      try {
        const res = await wildcard.app.inject({ method: 'POST', url: CASES_URL, payload: { userLocationCountry: 'AUS' } })
        expect(res.statusCode, res.body).toBe(200)
        expect(new URL((res.json() as CreateCaseResponse).webLink!).host, host).toBe('localhost:9090')
      } finally {
        await wildcard.app.close()
      }
    }
  })

  it('is not idempotent: every call creates a distinct case', async () => {
    const a = await createCase({ userLocationCountry: 'AUS' })
    const b = await createCase({ userLocationCountry: 'AUS' })
    expect(a.scanCase!.id).not.toBe(b.scanCase!.id)
    expect(a.mobileToken).not.toBe(b.mobileToken)
  })

  it('accepts an absent or empty body (userLocationCountry defaults to AUS) and explicit nulls', async () => {
    const absent = await createCase()
    expect(built.ctx.services.kyc.findCase(absent.scanCase!.id!)!.userLocationCountry).toBe('AUS')
    const empty = await createCase({})
    expect(built.ctx.services.kyc.findCase(empty.scanCase!.id!)!.userLocationCountry).toBe('AUS')
    const nulls = await createCase({ userLocationCountry: 'NZL', consentObtained: null, consentObtainedAt: null, userIp: null, userLocationState: null })
    const stored = built.ctx.services.kyc.findCase(nulls.scanCase!.id!)!
    expect(stored.userLocationCountry).toBe('NZL')
    for (const absentField of ['consentObtained', 'consentObtainedAt', 'userIp', 'userLocationState']) expect(stored, absentField).not.toHaveProperty(absentField)
  })

  it('rejects a malformed consent body with 400 ErrorResponse', async () => {
    const cases: unknown[] = [
      { userLocationCountry: 42 },
      { userLocationCountry: 'AUS', consentObtained: 'maybe' },
      { userLocationCountry: 'AUS', consentObtained: 'YES' },
      { userLocationCountry: 'AUS', consentObtainedAt: 'yesterday' },
      { userLocationCountry: 'AUS', userIp: 7 },
      { userLocationCountry: 'AUS', userLocationState: {} },
      [],
    ]
    for (const payload of cases) {
      const res = await app.inject({ method: 'POST', url: CASES_URL, payload: payload as Record<string, unknown> })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      expect(res.json()).toMatchObject({ status: '400', message: expect.stringMatching(/^BAD_REQUEST: /), traceId: expect.any(String) })
    }
    const valid = await createCase({ userLocationCountry: 'AUS', consentObtained: 'na' })
    expect(built.ctx.services.kyc.findCase(valid.scanCase!.id!)!.consentObtained).toBe('na')
  })

  it('emits no webhook', async () => {
    const before = ((await app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })).json() as unknown[]).length
    await createCase({ userLocationCountry: 'AUS' })
    await flush()
    const after = ((await app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })).json() as unknown[]).length
    expect(after).toBe(before)
  })
})

describe('case <-> customer link', () => {
  it('links the case to the customer created with identityVerificationCaseId and follows the platform outcome (PASSED)', async () => {
    const c = await createCase({ userLocationCountry: 'AUS' })
    const customer = await createCustomer({ identityVerificationCaseId: c.scanCase!.id })
    expect(customer.status).toBe('ACTIVE')
    const stored = built.ctx.services.kyc.findCase(c.scanCase!.id!)!
    expect(stored.customerId).toBe(customer.customerHayId)
    expect(stored.outcome).toBe('PASSED')
    expect(built.ctx.services.kyc.caseForCustomer(customer.customerHayId!)?.id).toBe(c.scanCase!.id)
  })

  it('also links through the deprecated journeyId; WARNING for a referral, REJECTED for a rejection', async () => {
    const warn = await createCase({ userLocationCountry: 'AUS' })
    const ref = await createCustomer({ emailTag: 'referred', journeyId: warn.scanCase!.id })
    expect(ref.status).toBe('REFERRED')
    expect(built.ctx.services.kyc.findCase(warn.scanCase!.id!)).toMatchObject({ customerId: ref.customerHayId, outcome: 'WARNING' })

    const rej = await createCase({ userLocationCountry: 'AUS' })
    const rejected = await createCustomer({ emailTag: 'rejected', identityVerificationCaseId: rej.scanCase!.id })
    expect(rejected.status).toBe('REJECTED')
    expect(built.ctx.services.kyc.findCase(rej.scanCase!.id!)).toMatchObject({ customerId: rejected.customerHayId, outcome: 'REJECTED' })
  })

  it('keeps the vendor verdict: WARNING stays after a manual approval activates the customer', async () => {
    const c = await createCase({ userLocationCountry: 'AUS' })
    const ref = await createCustomer({ emailTag: 'referred', identityVerificationCaseId: c.scanCase!.id })
    expect((await approve(ref.customerHayId!, 'aml')).statusCode).toBe(200)
    expect(built.ctx.services.kyc.findCase(c.scanCase!.id!)!.outcome).toBe('WARNING')
  })

  it('a client-driven activation is not a verification outcome: the case stays NOT_EXECUTED', async () => {
    const c = await createCase({ userLocationCountry: 'AUS' })
    const pending = await createCustomer({ emailTag: 'pending', identityVerificationCaseId: c.scanCase!.id })
    await app.inject({ method: 'PATCH', url: `/v0/customers/${pending.customerHayId}/status`, payload: { newStatus: 'ACTIVE' } })
    expect(built.ctx.services.kyc.findCase(c.scanCase!.id!)).toMatchObject({ customerId: pending.customerHayId, outcome: 'NOT_EXECUTED' })
  })

  it('ignores an unknown case id and never re-links a case already linked to another customer', async () => {
    const orphan = await createCustomer({ emailTag: 'pending', identityVerificationCaseId: UNKNOWN_ID })
    expect(built.ctx.services.kyc.caseForCustomer(orphan.customerHayId!)).toBeUndefined()

    const c = await createCase({ userLocationCountry: 'AUS' })
    const first = await createCustomer({ emailTag: 'pending', identityVerificationCaseId: c.scanCase!.id })
    const second = await createCustomer({ emailTag: 'pending', identityVerificationCaseId: c.scanCase!.id })
    expect(built.ctx.services.kyc.findCase(c.scanCase!.id!)!.customerId).toBe(first.customerHayId)
    expect(built.ctx.services.kyc.caseForCustomer(second.customerHayId!)).toBeUndefined()
  })
})

describe('approve*Check on a REFERRED customer', () => {
  it('records the failed stage the platform reported (+referred -> KYC_AML_SCAN)', async () => {
    const c = await referred()
    expect(built.ctx.services.kyc.stages(c.customerHayId!)).toEqual([expect.objectContaining({ stage: 'KYC_AML_SCAN', result: 'FAILED', submissionFailure: false })])
    expect(built.ctx.services.kyc.outstanding(c.customerHayId!)).toEqual(['KYC_AML_SCAN'])
  })

  it('approving the last failed check activates: ConfirmationResponse, ACTIVE + approvedDateTimeUtc, ONBOARDING_PASSED then CUSTOMER_STATUS_UPDATED (CLIENT)', async () => {
    const c = await referred()
    const res = await approve(c.customerHayId!, 'aml', { comments: 'Manually reviewed, all good' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: expect.any(String) })
    expect(res.json().message.length).toBeGreaterThan(0)

    const read = await getCustomer(c.customerHayId!)
    expect(read.status).toBe('ACTIVE')
    expect(read.approvedDateTimeUtc).toMatch(ISO_MICROS)
    expect(read.lastUpdatedDateTimeUtc).toMatch(ISO_MICROS)
    expect(read).not.toHaveProperty('blockedBy')

    const events = await payloadsFor(c.customerHayId!)
    expect(events.map((e) => e.type)).toEqual(['ONBOARDING_FAILED', 'CUSTOMER_STATUS_UPDATED', 'ONBOARDING_PASSED', 'CUSTOMER_STATUS_UPDATED'])
    expect(events[2]).toEqual({ customerHayId: c.customerHayId, idempotencyKey: expect.stringMatching(UUID), type: 'ONBOARDING_PASSED', actionOwner: 'CLIENT' })
    expect(events[3]).toEqual({ customerHayId: c.customerHayId, idempotencyKey: expect.stringMatching(UUID), type: 'CUSTOMER_STATUS_UPDATED', actionOwner: 'CLIENT', customerStatusUpdatedEvent: { customerStatus: 'ACTIVE' } })
    expect(events[2].idempotencyKey).not.toBe(events[3].idempotencyKey)

    const stage = built.ctx.services.kyc.stages(c.customerHayId!).find((s) => s.stage === 'KYC_AML_SCAN')!
    expect(stage).toMatchObject({ result: 'APPROVED', comments: 'Manually reviewed, all good', approvedAt: expect.stringMatching(ISO_MICROS) })
    expect(built.ctx.services.kyc.outstanding(c.customerHayId!)).toEqual([])
  })

  it('approving a check that did not fail records it, leaves the customer REFERRED and sends nothing', async () => {
    const c = await referred()
    const before = (await payloadsFor(c.customerHayId!)).length
    for (const check of ['sanction', 'document'] as const) {
      const res = await approve(c.customerHayId!, check, { comments: `${check} ok` })
      expect(res.statusCode, res.body).toBe(200)
      expect((await getCustomer(c.customerHayId!)).status).toBe('REFERRED')
    }
    expect((await payloadsFor(c.customerHayId!)).length).toBe(before)
    expect(built.ctx.services.kyc.stages(c.customerHayId!).map((s) => [s.stage, s.result])).toEqual([['KYC_AML_SCAN', 'FAILED'], ['SANCTIONS_SCAN', 'APPROVED'], ['DOCUMENT_SCAN', 'APPROVED']])
    // the outstanding one still clears the referral
    expect((await approve(c.customerHayId!, 'aml')).statusCode).toBe(200)
    expect((await getCustomer(c.customerHayId!)).status).toBe('ACTIVE')
  })

  it('repeating an approval while still REFERRED is a 200 no-op that keeps the first comment', async () => {
    const c = await referred()
    expect((await approve(c.customerHayId!, 'sanction', { comments: 'first' })).statusCode).toBe(200)
    expect((await approve(c.customerHayId!, 'sanction', { comments: 'second' })).statusCode).toBe(200)
    expect(built.ctx.services.kyc.stages(c.customerHayId!).find((s) => s.stage === 'SANCTIONS_SCAN')).toMatchObject({ result: 'APPROVED', comments: 'first' })
    expect((await getCustomer(c.customerHayId!)).status).toBe('REFERRED')
  })

  it('re-failing an approved stage reopens it in place: record order kept, approval comment and time cleared', async () => {
    const c = await referred()
    expect((await approve(c.customerHayId!, 'sanction', { comments: 'first look' })).statusCode).toBe(200)
    built.ctx.services.kyc.recordFailure(c.customerHayId!, 'SANCTIONS_SCAN', true)
    const stages = built.ctx.services.kyc.stages(c.customerHayId!)
    expect(stages.map((s) => [s.stage, s.result])).toEqual([['KYC_AML_SCAN', 'FAILED'], ['SANCTIONS_SCAN', 'FAILED']])
    expect(stages[1]).toEqual({ customerId: c.customerHayId, stage: 'SANCTIONS_SCAN', result: 'FAILED', submissionFailure: true, failedAt: expect.stringMatching(ISO_MICROS) })
    expect(built.ctx.services.kyc.outstanding(c.customerHayId!)).toEqual(['KYC_AML_SCAN', 'SANCTIONS_SCAN'])
    // approving again keeps the failure time and record position
    expect((await approve(c.customerHayId!, 'sanction', { comments: 'second look' })).statusCode).toBe(200)
    const reapproved = built.ctx.services.kyc.stages(c.customerHayId!)[1]!
    expect(reapproved).toMatchObject({ stage: 'SANCTIONS_SCAN', result: 'APPROVED', submissionFailure: true, comments: 'second look', failedAt: stages[1]!.failedAt })
    expect(reapproved.approvedAt).toMatch(ISO_MICROS)
  })

  it('every failed check must be approved before activation (multiple failed stages)', async () => {
    const c = await referred()
    built.ctx.services.kyc.recordFailure(c.customerHayId!, 'SANCTIONS_SCAN', true)
    expect(built.ctx.services.kyc.outstanding(c.customerHayId!)).toEqual(['KYC_AML_SCAN', 'SANCTIONS_SCAN'])
    expect((await approve(c.customerHayId!, 'aml')).statusCode).toBe(200)
    expect((await getCustomer(c.customerHayId!)).status).toBe('REFERRED')
    expect(built.ctx.services.kyc.outstanding(c.customerHayId!)).toEqual(['SANCTIONS_SCAN'])
    const before = (await payloadsFor(c.customerHayId!)).map((e) => e.type)
    expect(before).toEqual(['ONBOARDING_FAILED', 'CUSTOMER_STATUS_UPDATED'])
    expect((await approve(c.customerHayId!, 'sanction')).statusCode).toBe(200)
    expect((await getCustomer(c.customerHayId!)).status).toBe('ACTIVE')
    expect((await payloadsFor(c.customerHayId!)).map((e) => e.type)).toEqual([...before, 'ONBOARDING_PASSED', 'CUSTOMER_STATUS_UPDATED'])
  })

  it('a DUPLICATE_CHECK failure has no approval endpoint and keeps the customer REFERRED', async () => {
    const c = await referred()
    built.ctx.services.kyc.recordFailure(c.customerHayId!, 'DUPLICATE_CHECK')
    for (const check of ['aml', 'document', 'sanction'] as const) expect((await approve(c.customerHayId!, check)).statusCode).toBe(200)
    expect((await getCustomer(c.customerHayId!)).status).toBe('REFERRED')
    expect(built.ctx.services.kyc.outstanding(c.customerHayId!)).toEqual(['DUPLICATE_CHECK'])
  })

  it('a customer the client referred (no failed stage on record) is activated by any approval', async () => {
    const c = await createCustomer({ emailTag: 'pending' })
    await app.inject({ method: 'PATCH', url: `/v0/customers/${c.customerHayId}/status`, payload: { newStatus: 'REFERRED' } })
    expect(built.ctx.services.kyc.stages(c.customerHayId!)).toEqual([])
    const res = await approve(c.customerHayId!, 'document')
    expect(res.statusCode, res.body).toBe(200)
    expect((await getCustomer(c.customerHayId!)).status).toBe('ACTIVE')
    const events = await payloadsFor(c.customerHayId!)
    expect(events.map((e) => e.type)).toEqual(['CUSTOMER_STATUS_UPDATED', 'ONBOARDING_PASSED', 'CUSTOMER_STATUS_UPDATED'])
    expect(events[1].actionOwner).toBe('CLIENT')
    expect(events[2].customerStatusUpdatedEvent).toEqual({ customerStatus: 'ACTIVE' })
  })

  it('reduced KYC (onlySanctionsCheck) referrals clear through the stage the platform reported', async () => {
    const c = await createCustomer({ emailTag: 'referred', onlySanctionsCheck: true })
    expect(c.status).toBe('REFERRED')
    expect((await approve(c.customerHayId!, 'aml')).statusCode).toBe(200)
    expect((await getCustomer(c.customerHayId!)).status).toBe('ACTIVE')
  })

  it('each endpoint approves its own stage', async () => {
    const stageOf = { aml: 'KYC_AML_SCAN', document: 'DOCUMENT_SCAN', sanction: 'SANCTIONS_SCAN' } as const
    for (const check of ['aml', 'document', 'sanction'] as const) {
      const c = await createCustomer({ emailTag: 'pending' })
      await app.inject({ method: 'PATCH', url: `/v0/customers/${c.customerHayId}/status`, payload: { newStatus: 'REFERRED' } })
      built.ctx.services.kyc.recordFailure(c.customerHayId!, stageOf[check])
      const others = (['aml', 'document', 'sanction'] as const).filter((o) => o !== check)
      for (const other of others) {
        expect((await approve(c.customerHayId!, other)).statusCode).toBe(200)
        expect((await getCustomer(c.customerHayId!)).status, `${other} must not clear ${stageOf[check]}`).toBe('REFERRED')
      }
      expect((await approve(c.customerHayId!, check)).statusCode).toBe(200)
      expect((await getCustomer(c.customerHayId!)).status).toBe('ACTIVE')
    }
  })
})

describe('approve*Check refusals', () => {
  it('422 INVALID_STATE for every non-REFERRED status, on each endpoint', async () => {
    const active = await createCustomer()
    const pending = await createCustomer({ emailTag: 'pending' })
    const skipKyc = await createCustomer({ skipKyc: true })
    const rejected = await createCustomer({ emailTag: 'rejected' })
    const blocked = await createCustomer()
    await app.inject({ method: 'POST', url: `/v0/customers/${blocked.customerHayId}/block`, payload: { note: 'x' } })
    const inactive = await createCustomer()
    await app.inject({ method: 'PATCH', url: `/v0/customers/${inactive.customerHayId}/status`, payload: { newStatus: 'INACTIVE' } })
    const expected: [HayCustomer, string][] = [[active, 'ACTIVE'], [pending, 'PENDING_APPROVAL'], [skipKyc, 'PENDING_APPROVAL'], [rejected, 'REJECTED'], [blocked, 'BLOCKED'], [inactive, 'INACTIVE']]
    for (const [customer, status] of expected) {
      expect((await getCustomer(customer.customerHayId!)).status).toBe(status)
      const before = (await payloadsFor(customer.customerHayId!)).length
      for (const check of ['aml', 'document', 'sanction'] as const) {
        const res = await approve(customer.customerHayId!, check)
        expect(res.statusCode, `${status} ${check}: ${res.body}`).toBe(422)
        expect(res.json()).toMatchObject({ status: '422', message: expect.stringMatching(new RegExp(`^INVALID_STATE: .*${status}`)), traceId: expect.any(String) })
      }
      expect((await payloadsFor(customer.customerHayId!)).length).toBe(before)
      expect((await getCustomer(customer.customerHayId!)).status).toBe(status)
    }
  })

  it('a REFERRED customer that was activated cannot be approved again (422 INVALID_STATE)', async () => {
    const c = await referred()
    expect((await approve(c.customerHayId!, 'aml')).statusCode).toBe(200)
    const again = await approve(c.customerHayId!, 'aml')
    expect(again.statusCode).toBe(422)
    expect(again.json().message).toMatch(/^INVALID_STATE: /)
    expect((await payloadsFor(c.customerHayId!)).map((e) => e.type)).toEqual(['ONBOARDING_FAILED', 'CUSTOMER_STATUS_UPDATED', 'ONBOARDING_PASSED', 'CUSTOMER_STATUS_UPDATED'])
  })

  it('404 NOT_FOUND for an unknown customer, 400 for a malformed id or body', async () => {
    for (const check of ['aml', 'document', 'sanction'] as const) {
      const missing = await approve(UNKNOWN_ID, check)
      expect(missing.statusCode, check).toBe(404)
      expect(missing.json()).toMatchObject({ status: '404', message: `NOT_FOUND: Customer ${UNKNOWN_ID} not found` })
      expect((await app.inject({ method: 'POST', url: `/v1/kyc/not-a-uuid/onboarding/${APPROVAL[check]}/approval`, payload: {} })).statusCode).toBe(400)
    }
    const c = await referred()
    const badComments = await approve(c.customerHayId!, 'aml', { comments: { note: 'objects cannot be coerced to string' } })
    expect(badComments.statusCode).toBe(400)
    expect(badComments.json()).toMatchObject({ status: '400', message: expect.stringMatching(/^BAD_REQUEST: /) })
    const noBody = await app.inject({ method: 'POST', url: `/v1/kyc/${c.customerHayId}/onboarding/amlKycCheck/approval` })
    expect(noBody.statusCode).toBe(400)
    expect((await getCustomer(c.customerHayId!)).status).toBe('REFERRED')
  })

  it('service guards: recordFailure and approve validate the stage name and the customer', async () => {
    const c = await referred()
    expect(() => built.ctx.services.kyc.recordFailure(c.customerHayId!, 'NOPE' as any)).toThrow(/stage/)
    expect(() => built.ctx.services.kyc.recordFailure(UNKNOWN_ID, 'DOCUMENT_SCAN')).toThrow(/NOT_FOUND/)
    expect(() => built.ctx.services.kyc.approve(c.customerHayId!, 'DUPLICATE_CHECK' as any)).toThrow(/stage/)
  })
})

describe('reset', () => {
  it('/_admin/reset clears cases and stage records', async () => {
    const created = await createCase({ userLocationCountry: 'AUS' })
    const c = await referred()
    expect(built.ctx.services.kyc.stages(c.customerHayId!)).toHaveLength(1)
    await app.inject({ method: 'POST', url: '/_admin/reset' })
    expect(built.ctx.services.kyc.findCase(created.scanCase!.id!)).toBeUndefined()
    expect(built.ctx.services.kyc.stages(c.customerHayId!)).toEqual([])
  })
})
