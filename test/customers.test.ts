import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { components } from '../src/contract/generated/b2b-types.js'
import { startApp } from './helpers.js'
import { buildServer } from '../src/server.js'
import { assertValidNotification } from './webhook-schema.js'
import type { BuiltServer } from '../src/server.js'

type CreateBody = components['schemas']['CreateHayCustomerRequestBody']
type HayCustomer = components['schemas']['HayCustomer']

const CUSTOMER_OPS = [
  'getAllCustomers', 'createHayCustomer', 'searchCustomers', 'getHayCustomerById', 'updateCustomer', 'changeHayCustomerStatus',
  'blockCustomer', 'unblockCustomer', 'getAccountsForCustomerId', 'getCardsForCustomerId', 'createHayAccount',
]
const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111'
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

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
    email: `user${n}${emailTag ? `+${emailTag}` : ''}@example.com`,
    customerTier: 'STANDARD',
    phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: `4${String(n).padStart(8, '0')}` },
    address: { line1: '395 Bourke St', townOrCity: 'Melbourne', administrativeRegion: 'VIC', postcode: '3000', countryCodeIso: 'AUS' },
    customerDetails: { firstName: 'John', lastName: `Smith${n}`, dateOfBirth: '1996-02-25' },
    ...rest,
  }
}

async function create(overrides: Partial<CreateBody> & { emailTag?: string } = {}): Promise<HayCustomer> {
  const res = await app.inject({ method: 'POST', url: '/v0/customers/create', payload: customerBody(overrides) })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as HayCustomer
}
async function createActive(overrides: Partial<CreateBody> = {}): Promise<HayCustomer> {
  const c = await create(overrides)
  await flush()
  return get(c.customerHayId!)
}
async function get(id: string): Promise<HayCustomer> {
  const res = await app.inject({ method: 'GET', url: `/v0/customers/${id}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as HayCustomer
}
async function flush(): Promise<void> {
  await app.inject({ method: 'POST', url: '/_admin/flush' })
}
async function payloadsFor(customerHayId: string): Promise<any[]> {
  await flush()
  const res = await app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })
  return (res.json() as { payload: any }[]).map((r) => r.payload).filter((p) => p.customerHayId === customerHayId)
}

describe('customers domain: registration', () => {
  it('handles every Customers API operation (none left on the stub)', async () => {
    const res = await app.inject({ method: 'GET', url: '/_admin/operations' })
    const { handled, stubbed } = res.json() as { handled: string[]; stubbed: string[] }
    for (const op of CUSTOMER_OPS) {
      expect(handled, op).toContain(op)
      expect(stubbed, op).not.toContain(op)
    }
  })
})

describe('createHayCustomer', () => {
  it('creates a PENDING_APPROVAL customer shaped like the docs sample', async () => {
    const body = customerBody({ emailTag: 'pending', customerDetails: { firstName: 'John', middleName: 'Bryan', lastName: 'Smith', dateOfBirth: '1996-02-25' } })
    const res = await app.inject({ method: 'POST', url: '/v0/customers/create', payload: body })
    expect(res.statusCode, res.body).toBe(200)
    const c = res.json() as HayCustomer
    expect(c.customerHayId).toMatch(/^[0-9a-f-]{36}$/)
    expect(c.status).toBe('PENDING_APPROVAL')
    expect(c.tier).toBe('STANDARD')
    expect(c.deviceId).toBe('NOT_SPECIFIED')
    expect(c.email).toBe(body.email)
    expect(c.phoneNumber).toEqual({ countryCodePrefix: '61', numberAfterPrefix: body.phoneNumber.numberAfterPrefix })
    expect(c.address).toEqual(body.address)
    expect(c.customerDetails).toEqual({ firstName: 'John', middleName: 'Bryan', lastName: 'Smith', dateOfBirth: '1996-02-25', gender: 'OTHER' })
    expect(c.creationDateTimeUtc).toMatch(ISO_MICROS)
    for (const absent of ['statusReason', 'blockedBy', 'approvedDateTimeUtc', 'closedDateTimeUtc', 'lastUpdatedDateTimeUtc', 'customData', 'clientReference', 'identityDocumentType', 'taxObligations', 'idempotencyKey', 'skipKyc']) {
      expect(c, absent).not.toHaveProperty(absent)
    }
  })

  it('stores customData and identity document fields and returns them on read', async () => {
    const c = await create({
      emailTag: 'pending',
      customData: { external_id: '359916f3-10d2-437e-a0f0-ea83ac8fd9c2', nested: { flags: [1, 2] } } as any,
      identityDocumentType: 'DRIVING_LICENSE', identityDocumentNumber: 'DL123456', identityDocumentCardNumber: 'AB12345678',
      identityDocumentExpiry: '2030-06-15', identityDocumentIssuingCountry: 'AUS', identityDocumentRegion: 'VIC',
      taxObligations: [{ country: 'NZL', taxIdNumber: '123' }],
    })
    const read = await get(c.customerHayId!)
    expect(read.customData).toEqual({ external_id: '359916f3-10d2-437e-a0f0-ea83ac8fd9c2', nested: { flags: [1, 2] } })
    expect(read).toMatchObject({
      identityDocumentType: 'DRIVING_LICENSE', identityDocumentNumber: 'DL123456', identityDocumentCardNumber: 'AB12345678',
      identityDocumentExpiry: '2030-06-15', identityDocumentIssuingCountry: 'AUS', identityDocumentRegion: 'VIC',
    })
    expect(read).not.toHaveProperty('taxObligations')
    expect(built.ctx.services.customers.get(c.customerHayId!).taxObligations).toEqual([{ country: 'NZL', taxIdNumber: '123' }])
  })

  it('echoes an explicit customData: null (nullable field) on create and on read', async () => {
    const c = await create({ emailTag: 'pending', customData: null })
    expect(c).toHaveProperty('customData', null)
    expect(await get(c.customerHayId!)).toHaveProperty('customData', null)
  })

  it('stores externalCustomerId and the deprecated journeyId (as identityVerificationCaseId) without echoing them', async () => {
    // identityVerificationCaseId / journeyId must name an unlinked KYC case (scanCase.id from createCase)
    const newCaseId = async (): Promise<string> => (await app.inject({ method: 'POST', url: '/v1/kyc/identity-verification/cases' })).json().scanCase.id
    const journeyId = await newCaseId()
    const c = await create({ emailTag: 'pending', journeyId, externalCustomerId: 'ext-123' })
    for (const absent of ['externalCustomerId', 'journeyId', 'identityVerificationCaseId']) expect(c, absent).not.toHaveProperty(absent)
    expect(await get(c.customerHayId!)).not.toHaveProperty('externalCustomerId')
    expect(built.ctx.services.customers.get(c.customerHayId!)).toMatchObject({ externalCustomerId: 'ext-123', identityVerificationCaseId: journeyId })
    const caseId = await newCaseId()
    const both = await create({ emailTag: 'pending', journeyId: randomUUID(), identityVerificationCaseId: caseId })
    expect(built.ctx.services.customers.get(both.customerHayId!).identityVerificationCaseId).toBe(caseId)
  })

  it('rejects schema violations with 400 and the ErrorResponse envelope', async () => {
    const { email: _e, ...noEmail } = customerBody()
    const res = await app.inject({ method: 'POST', url: '/v0/customers/create', payload: noEmail })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ status: '400', message: expect.stringContaining('BAD_REQUEST') })
    const badTier = await app.inject({ method: 'POST', url: '/v0/customers/create', payload: customerBody({ customerTier: 'GOLD' as any }) })
    expect(badTier.statusCode).toBe(400)
  })

  it('refuses skipKyc together with onlySanctionsCheck', async () => {
    const res = await app.inject({ method: 'POST', url: '/v0/customers/create', payload: customerBody({ skipKyc: true, onlySanctionsCheck: true }) })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/skipKyc/)
  })

  it('replays the original response for the same idempotencyKey and refuses a different body', async () => {
    const body = customerBody({ emailTag: 'pending' })
    const a = await app.inject({ method: 'POST', url: '/v0/customers/create', payload: body })
    const b = await app.inject({ method: 'POST', url: '/v0/customers/create', payload: body })
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)
    expect(b.json()).toEqual(a.json())
    const c = await app.inject({ method: 'POST', url: '/v0/customers/create', payload: { ...body, email: `other${n}+pending@example.com` } })
    expect(c.statusCode).toBe(422)
    expect(c.json().message).toMatch(/^IDEMPOTENCY_KEY_REUSED/)
  })

  describe('uniqueness (422 DUPLICATE_CUSTOMER)', () => {
    async function expectDuplicate(overrides: Partial<CreateBody>): Promise<void> {
      const res = await app.inject({ method: 'POST', url: '/v0/customers/create', payload: customerBody(overrides) })
      expect(res.statusCode, res.body).toBe(422)
      expect(res.json().message).toMatch(/^DUPLICATE_CUSTOMER: /)
    }

    it('by email, case-insensitively', async () => {
      const c = await create({ emailTag: 'pending' })
      await expectDuplicate({ email: c.email!.toUpperCase() })
    })

    it('by phone number, ignoring the + prefix', async () => {
      const c = await create({ emailTag: 'pending' })
      await expectDuplicate({ phoneNumber: { countryCodePrefix: '61', numberAfterPrefix: c.phoneNumber!.numberAfterPrefix } })
      await expectDuplicate({ phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: c.phoneNumber!.numberAfterPrefix } })
    })

    it('by identity document type + number', async () => {
      await create({ emailTag: 'pending', identityDocumentType: 'PASSPORT', identityDocumentNumber: 'PA9999' })
      await expectDuplicate({ identityDocumentType: 'PASSPORT', identityDocumentNumber: 'PA9999' })
      // same number with another document type is a different document
      const ok = await app.inject({ method: 'POST', url: '/v0/customers/create', payload: customerBody({ emailTag: 'pending', identityDocumentType: 'DRIVING_LICENSE', identityDocumentNumber: 'PA9999' }) })
      expect(ok.statusCode).toBe(200)
    })

    it('by first name + last name + date of birth', async () => {
      await create({ emailTag: 'pending', customerDetails: { firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1815-12-10' } })
      await expectDuplicate({ customerDetails: { firstName: 'ada', lastName: 'LOVELACE', dateOfBirth: '1815-12-10' } })
      const ok = await app.inject({ method: 'POST', url: '/v0/customers/create', payload: customerBody({ emailTag: 'pending', customerDetails: { firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1815-12-11' } }) })
      expect(ok.statusCode).toBe(200)
    })

    it('ignores INACTIVE customers closed for CUSTOMER/OPERATIONAL reasons but not SUSPICIOUS/DECEASED', async () => {
      const gone = await createActive()
      built.ctx.services.customers.markInactive(gone.customerHayId!, 'CUSTOMER')
      const again = await app.inject({ method: 'POST', url: '/v0/customers/create', payload: customerBody({ email: gone.email!, emailTag: undefined }) })
      expect(again.statusCode, again.body).toBe(200)

      const suspicious = await createActive()
      built.ctx.services.customers.markInactive(suspicious.customerHayId!, 'SUSPICIOUS')
      await expectDuplicate({ email: suspicious.email! })

      const withdrawn = await create({ emailTag: 'pending' })
      const w = await app.inject({ method: 'PATCH', url: `/v0/customers/${withdrawn.customerHayId}/status`, payload: { newStatus: 'INACTIVE' } })
      expect(w.statusCode).toBe(200)
      const reonboard = await app.inject({ method: 'POST', url: '/v0/customers/create', payload: customerBody({ email: withdrawn.email! }) })
      expect(reonboard.statusCode, reonboard.body).toBe(200)
    })
  })
})

describe('onboarding (asynchronous outcome)', () => {
  it('activates by default: ACTIVE + approvedDateTimeUtc, ONBOARDING_PASSED then CUSTOMER_STATUS_UPDATED (PLATFORM)', async () => {
    const created = await create()
    expect(created.status).toBe('PENDING_APPROVAL')
    await flush()
    const c = await get(created.customerHayId!)
    expect(c.status).toBe('ACTIVE')
    expect(c.approvedDateTimeUtc).toMatch(ISO_MICROS)
    expect(c).not.toHaveProperty('closedDateTimeUtc')
    const events = await payloadsFor(c.customerHayId!)
    expect(events.map((e) => e.type)).toEqual(['ONBOARDING_PASSED', 'CUSTOMER_STATUS_UPDATED'])
    expect(events[0]).toEqual({ customerHayId: c.customerHayId, idempotencyKey: expect.any(String), type: 'ONBOARDING_PASSED', actionOwner: 'PLATFORM' })
    expect(events[1]).toEqual({ customerHayId: c.customerHayId, idempotencyKey: expect.any(String), type: 'CUSTOMER_STATUS_UPDATED', actionOwner: 'PLATFORM', customerStatusUpdatedEvent: { customerStatus: 'ACTIVE' } })
  })

  it('+referred -> REFERRED with ONBOARDING_FAILED at KYC_AML_SCAN', async () => {
    const created = await create({ emailTag: 'referred' })
    await flush()
    expect((await get(created.customerHayId!)).status).toBe('REFERRED')
    const events = await payloadsFor(created.customerHayId!)
    expect(events.map((e) => e.type)).toEqual(['ONBOARDING_FAILED', 'CUSTOMER_STATUS_UPDATED'])
    expect(events[0].onboardingFailedEvent).toEqual({ state: 'KYC_AML_SCAN', submissionFailure: false })
    expect(events[0].actionOwner).toBe('PLATFORM')
    expect(events[1].customerStatusUpdatedEvent).toEqual({ customerStatus: 'REFERRED' })
  })

  it('+rejected -> REJECTED with ONBOARDING_FAILED at DOCUMENT_SCAN', async () => {
    const created = await create({ emailTag: 'rejected' })
    await flush()
    expect((await get(created.customerHayId!)).status).toBe('REJECTED')
    const events = await payloadsFor(created.customerHayId!)
    expect(events.map((e) => e.type)).toEqual(['ONBOARDING_FAILED', 'CUSTOMER_STATUS_UPDATED'])
    expect(events[0].onboardingFailedEvent).toEqual({ state: 'DOCUMENT_SCAN', submissionFailure: false })
    expect(events[1].customerStatusUpdatedEvent).toEqual({ customerStatus: 'REJECTED' })
  })

  it('onlySanctionsCheck runs the platform outcome like full KYC: ACTIVE with ONBOARDING_PASSED', async () => {
    const created = await create({ onlySanctionsCheck: true })
    expect(created.status).toBe('PENDING_APPROVAL')
    await flush()
    const c = await get(created.customerHayId!)
    expect(c.status).toBe('ACTIVE')
    expect(c.approvedDateTimeUtc).toMatch(ISO_MICROS)
    expect((await payloadsFor(c.customerHayId!)).map((e) => e.type)).toEqual(['ONBOARDING_PASSED', 'CUSTOMER_STATUS_UPDATED'])
  })

  it('onlySanctionsCheck (Reduced KYC) fails +referred / +rejected at SANCTIONS_SCAN, the only stage it runs', async () => {
    for (const [emailTag, status] of [['referred', 'REFERRED'], ['rejected', 'REJECTED']] as const) {
      const created = await create({ emailTag, onlySanctionsCheck: true })
      await flush()
      expect((await get(created.customerHayId!)).status).toBe(status)
      const events = await payloadsFor(created.customerHayId!)
      expect(events.map((e) => e.type)).toEqual(['ONBOARDING_FAILED', 'CUSTOMER_STATUS_UPDATED'])
      expect(events[0].onboardingFailedEvent, emailTag).toEqual({ state: 'SANCTIONS_SCAN', submissionFailure: false })
    }
  })

  it('+pending and skipKyc leave the customer PENDING_APPROVAL for the client to activate', async () => {
    const pending = await create({ emailTag: 'pending' })
    const skip = await create({ skipKyc: true })
    await flush()
    expect((await get(pending.customerHayId!)).status).toBe('PENDING_APPROVAL')
    expect((await get(skip.customerHayId!)).status).toBe('PENDING_APPROVAL')
    expect(await payloadsFor(pending.customerHayId!)).toEqual([])
    expect(await payloadsFor(skip.customerHayId!)).toEqual([])
  })

  it('does not override a status the client set before the outcome arrived', async () => {
    // Deferred work is due on the next request, so the client change is made through the service to race it.
    const created = await create({ emailTag: 'referred' })
    expect(built.ctx.services.customers.changeStatus(created.customerHayId!, 'ACTIVE').status).toBe('ACTIVE')
    await flush()
    expect((await get(created.customerHayId!)).status).toBe('ACTIVE')
    expect((await payloadsFor(created.customerHayId!)).map((e) => e.type)).toEqual(['CUSTOMER_STATUS_UPDATED'])
  })
})

describe('getHayCustomerById', () => {
  it('returns 404 NOT_FOUND for an unknown id and 400 for a malformed one', async () => {
    const missing = await app.inject({ method: 'GET', url: `/v0/customers/${UNKNOWN_ID}` })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ status: '404', message: `NOT_FOUND: Customer ${UNKNOWN_ID} not found`, traceId: expect.any(String) })
    const bad = await app.inject({ method: 'GET', url: '/v0/customers/not-a-uuid' })
    expect(bad.statusCode).toBe(400)
  })
})

describe('changeHayCustomerStatus', () => {
  async function setStatus(id: string, newStatus: string) {
    return app.inject({ method: 'PATCH', url: `/v0/customers/${id}/status`, payload: { newStatus } })
  }

  it('PENDING_APPROVAL -> ACTIVE sets approvedDateTimeUtc and emits CUSTOMER_STATUS_UPDATED (CLIENT)', async () => {
    const c = await create({ emailTag: 'pending' })
    const res = await setStatus(c.customerHayId!, 'ACTIVE')
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as HayCustomer
    expect(body.status).toBe('ACTIVE')
    expect(body.approvedDateTimeUtc).toMatch(ISO_MICROS)
    expect(body.lastUpdatedDateTimeUtc).toMatch(ISO_MICROS)
    const events = await payloadsFor(c.customerHayId!)
    expect(events).toEqual([{ customerHayId: c.customerHayId, idempotencyKey: expect.any(String), type: 'CUSTOMER_STATUS_UPDATED', actionOwner: 'CLIENT', customerStatusUpdatedEvent: { customerStatus: 'ACTIVE' } }])
  })

  it('accepts every enum value; BLOCKED sets blockedBy CLIENT and leaving BLOCKED clears it', async () => {
    const c = await create({ emailTag: 'pending' })
    for (const s of ['REFERRED', 'REJECTED', 'PENDING_APPROVAL', 'ACTIVE'] as const) {
      const res = await setStatus(c.customerHayId!, s)
      expect(res.statusCode, `${s}: ${res.body}`).toBe(200)
      expect(res.json().status).toBe(s)
    }
    const blocked = await setStatus(c.customerHayId!, 'BLOCKED')
    expect(blocked.json()).toMatchObject({ status: 'BLOCKED', blockedBy: 'CLIENT' })
    const active = await setStatus(c.customerHayId!, 'ACTIVE')
    expect(active.json().status).toBe('ACTIVE')
    expect(active.json()).not.toHaveProperty('blockedBy')
    const events = await payloadsFor(c.customerHayId!)
    expect(events.map((e) => e.customerStatusUpdatedEvent.customerStatus)).toEqual(['REFERRED', 'REJECTED', 'PENDING_APPROVAL', 'ACTIVE', 'BLOCKED', 'ACTIVE'])
  })

  it('same status is a 200 no-op without a webhook', async () => {
    const c = await create({ emailTag: 'pending' })
    const res = await setStatus(c.customerHayId!, 'PENDING_APPROVAL')
    expect(res.statusCode).toBe(200)
    expect(res.json()).not.toHaveProperty('lastUpdatedDateTimeUtc')
    expect(await payloadsFor(c.customerHayId!)).toEqual([])
  })

  it('-> INACTIVE (withdrawn) sets closedDateTimeUtc and statusReason CUSTOMER; INACTIVE cannot be left (422 INVALID_STATE)', async () => {
    const c = await create({ emailTag: 'pending' })
    const closed = await setStatus(c.customerHayId!, 'INACTIVE')
    expect(closed.statusCode).toBe(200)
    expect(closed.json()).toMatchObject({ status: 'INACTIVE', statusReason: 'CUSTOMER', closedDateTimeUtc: expect.stringMatching(ISO_MICROS) })
    const again = await setStatus(c.customerHayId!, 'INACTIVE')
    expect(again.statusCode).toBe(200)
    const revive = await setStatus(c.customerHayId!, 'ACTIVE')
    expect(revive.statusCode).toBe(422)
    expect(revive.json().message).toMatch(/^INVALID_STATE: /)
    const events = await payloadsFor(c.customerHayId!)
    expect(events.map((e) => e.customerStatusUpdatedEvent.customerStatus)).toEqual(['INACTIVE'])
  })

  it('ACTIVE -> INACTIVE and BLOCKED -> INACTIVE (client withdrawal) set statusReason CUSTOMER + closedDateTimeUtc and clear blockedBy', async () => {
    const active = await createActive()
    const closed = await setStatus(active.customerHayId!, 'INACTIVE')
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json()).toMatchObject({ status: 'INACTIVE', statusReason: 'CUSTOMER', closedDateTimeUtc: expect.stringMatching(ISO_MICROS), approvedDateTimeUtc: active.approvedDateTimeUtc })
    const blocked = await createActive()
    await app.inject({ method: 'POST', url: `/v0/customers/${blocked.customerHayId}/block`, payload: { note: 'x' } })
    const closedBlocked = await setStatus(blocked.customerHayId!, 'INACTIVE')
    expect(closedBlocked.statusCode, closedBlocked.body).toBe(200)
    expect(closedBlocked.json()).toMatchObject({ status: 'INACTIVE', statusReason: 'CUSTOMER', closedDateTimeUtc: expect.stringMatching(ISO_MICROS) })
    expect(closedBlocked.json()).not.toHaveProperty('blockedBy')
    const events = (await payloadsFor(blocked.customerHayId!)).filter((e) => e.type === 'CUSTOMER_STATUS_UPDATED')
    expect(events.map((e) => e.customerStatusUpdatedEvent.customerStatus)).toEqual(['ACTIVE', 'BLOCKED', 'INACTIVE'])
    expect(events.at(-1).actionOwner).toBe('CLIENT')
  })

  it('validates the enum (400) and the id (404)', async () => {
    const c = await create({ emailTag: 'pending' })
    expect((await setStatus(c.customerHayId!, 'CLOSED')).statusCode).toBe(400)
    expect((await setStatus(UNKNOWN_ID, 'ACTIVE')).statusCode).toBe(404)
  })
})

describe('blockCustomer / unblockCustomer', () => {
  it('blocks an ACTIVE customer (blockedBy CLIENT), returns GenericMessage and emits CUSTOMER_STATUS_UPDATED BLOCKED', async () => {
    const c = await createActive()
    const res = await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/block`, payload: { note: 'suspected fraud' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: expect.stringMatching(/block/i) })
    const read = await get(c.customerHayId!)
    expect(read).toMatchObject({ status: 'BLOCKED', blockedBy: 'CLIENT' })
    const events = await payloadsFor(c.customerHayId!)
    expect(events.at(-1)).toEqual({ customerHayId: c.customerHayId, idempotencyKey: expect.any(String), type: 'CUSTOMER_STATUS_UPDATED', actionOwner: 'CLIENT', customerStatusUpdatedEvent: { customerStatus: 'BLOCKED' } })
    expect(built.ctx.services.customers.get(c.customerHayId!).blockNote).toBe('suspected fraud')
  })

  it('blocking an already BLOCKED customer is a 200 no-op without a second webhook', async () => {
    const c = await createActive()
    await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/block`, payload: { note: 'first' } })
    const before = (await payloadsFor(c.customerHayId!)).length
    const res = await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/block`, payload: { note: 'second' } })
    expect(res.statusCode).toBe(200)
    expect((await payloadsFor(c.customerHayId!)).length).toBe(before)
  })

  it('refuses to block an INACTIVE customer (422) and validates note (400) and id (404)', async () => {
    const c = await createActive()
    built.ctx.services.customers.markInactive(c.customerHayId!, 'CUSTOMER')
    const res = await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/block`, payload: { note: 'x' } })
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/^INVALID_STATE: /)
    expect((await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/block`, payload: { note: '' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/block`, payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/v0/customers/${UNKNOWN_ID}/block`, payload: { note: 'x' } })).statusCode).toBe(404)
  })

  it('unblocks to ACTIVE, clears blockedBy and emits CUSTOMER_STATUS_UPDATED ACTIVE', async () => {
    const c = await createActive()
    await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/block`, payload: { note: 'x' } })
    const res = await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/unblock`, payload: { note: 'resolved' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: expect.stringMatching(/unblock/i) })
    const read = await get(c.customerHayId!)
    expect(read.status).toBe('ACTIVE')
    expect(read).not.toHaveProperty('blockedBy')
    const events = (await payloadsFor(c.customerHayId!)).filter((e) => e.type === 'CUSTOMER_STATUS_UPDATED')
    expect(events.map((e) => e.customerStatusUpdatedEvent.customerStatus)).toEqual(['ACTIVE', 'BLOCKED', 'ACTIVE'])
    expect(events.at(-1).actionOwner).toBe('CLIENT')
  })

  it('unblocking a customer that is not BLOCKED is 422; unknown id 404', async () => {
    const c = await createActive()
    const res = await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/unblock`, payload: { note: 'x' } })
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/^INVALID_STATE: /)
    expect((await app.inject({ method: 'POST', url: `/v0/customers/${UNKNOWN_ID}/unblock`, payload: { note: 'x' } })).statusCode).toBe(404)
  })

  it('a PLATFORM block (via the service) is reported with blockedBy PLATFORM and emits actionOwner PLATFORM', async () => {
    const c = await createActive()
    built.ctx.services.customers.setStatus(c.customerHayId!, 'BLOCKED', { actionOwner: 'PLATFORM' })
    expect(await get(c.customerHayId!)).toMatchObject({ status: 'BLOCKED', blockedBy: 'PLATFORM' })
    const events = await payloadsFor(c.customerHayId!)
    expect(events.at(-1)).toMatchObject({ actionOwner: 'PLATFORM', customerStatusUpdatedEvent: { customerStatus: 'BLOCKED' } })
  })

  it('a client may unblock a PLATFORM-blocked customer (-> ACTIVE, actionOwner CLIENT)', async () => {
    const c = await createActive()
    built.ctx.services.customers.setStatus(c.customerHayId!, 'BLOCKED', { actionOwner: 'PLATFORM' })
    const res = await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/unblock`, payload: { note: 'cleared' } })
    expect(res.statusCode, res.body).toBe(200)
    const read = await get(c.customerHayId!)
    expect(read.status).toBe('ACTIVE')
    expect(read).not.toHaveProperty('blockedBy')
    expect((await payloadsFor(c.customerHayId!)).at(-1)).toMatchObject({ actionOwner: 'CLIENT', customerStatusUpdatedEvent: { customerStatus: 'ACTIVE' } })
  })

  it('blocks from PENDING_APPROVAL, REFERRED and REJECTED as well; unblock always lands on ACTIVE', async () => {
    for (const from of ['PENDING_APPROVAL', 'REFERRED', 'REJECTED'] as const) {
      const c = await create({ emailTag: 'pending' })
      if (from !== 'PENDING_APPROVAL') expect((await app.inject({ method: 'PATCH', url: `/v0/customers/${c.customerHayId}/status`, payload: { newStatus: from } })).statusCode).toBe(200)
      const block = await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/block`, payload: { note: `from ${from}` } })
      expect(block.statusCode, `${from}: ${block.body}`).toBe(200)
      expect(await get(c.customerHayId!)).toMatchObject({ status: 'BLOCKED', blockedBy: 'CLIENT' })
      const unblock = await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/unblock`, payload: { note: 'x' } })
      expect(unblock.statusCode, `${from}: ${unblock.body}`).toBe(200)
      const read = await get(c.customerHayId!)
      expect(read.status).toBe('ACTIVE')
      expect(read.approvedDateTimeUtc).toMatch(ISO_MICROS)
      expect(read).not.toHaveProperty('blockedBy')
      const statuses = (await payloadsFor(c.customerHayId!)).map((e) => e.customerStatusUpdatedEvent.customerStatus)
      expect(statuses, from).toEqual([...(from === 'PENDING_APPROVAL' ? [] : [from]), 'BLOCKED', 'ACTIVE'])
    }
  })

  it('a block placed before the platform onboarding outcome arrives supersedes it: no ONBOARDING_* webhook, unblock lands on ACTIVE (asyncDelayMs > 0)', async () => {
    const other = await startApp({ asyncDelayMs: 5_000 })
    try {
      const res = await other.app.inject({ method: 'POST', url: '/v0/customers/create', payload: customerBody({ emailTag: 'rejected' }) })
      expect(res.statusCode, res.body).toBe(200)
      const id = (res.json() as HayCustomer).customerHayId!
      expect((await other.app.inject({ method: 'POST', url: `/v0/customers/${id}/block`, payload: { note: 'x' } })).statusCode).toBe(200)
      expect((await other.app.inject({ method: 'GET', url: `/v0/customers/${id}` })).json()).toMatchObject({ status: 'BLOCKED', blockedBy: 'CLIENT' })
      expect((await other.app.inject({ method: 'POST', url: `/v0/customers/${id}/unblock`, payload: { note: 'x' } })).statusCode).toBe(200)
      // make the deferred outcome due on the virtual clock (runs it through tick) and settle
      await other.app.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: 6_000 } })
      await other.app.inject({ method: 'POST', url: '/_admin/flush' })
      expect((await other.app.inject({ method: 'GET', url: `/v0/customers/${id}` })).json()).toMatchObject({ status: 'ACTIVE', approvedDateTimeUtc: expect.stringMatching(ISO_MICROS) })
      const rows = (await other.app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })).json() as { payload: any }[]
      expect(rows.map((r) => r.payload.type)).toEqual(['CUSTOMER_STATUS_UPDATED', 'CUSTOMER_STATUS_UPDATED'])
      expect(rows.map((r) => r.payload.customerStatusUpdatedEvent.customerStatus)).toEqual(['BLOCKED', 'ACTIVE'])
    } finally {
      await other.app.close()
    }
  })
})

describe('updateCustomer', () => {
  it('updates supplied fields only, replaces address/phone as a whole and reports the four change flags', async () => {
    const c = await createActive({ customerDetails: { firstName: 'Jane', middleName: 'Q', lastName: 'Doe', dateOfBirth: '1990-01-01', title: 'Ms' } })
    const res = await app.inject({
      method: 'PATCH', url: `/v0/customers/${c.customerHayId}`,
      payload: { firstName: 'Janet', email: `janet${n}@example.com`, phoneNumber: { countryCodePrefix: '+64', numberAfterPrefix: '211234567' }, address: { line1: '1 Queen St', countryCodeIso: 'NZL' } },
    })
    expect(res.statusCode, res.body).toBe(200)
    const u = res.json() as HayCustomer
    expect(u.customerDetails).toEqual({ firstName: 'Janet', middleName: 'Q', lastName: 'Doe', dateOfBirth: '1990-01-01', title: 'Ms', gender: 'OTHER' })
    expect(u.email).toBe(`janet${n}@example.com`)
    expect(u.phoneNumber).toEqual({ countryCodePrefix: '64', numberAfterPrefix: '211234567' })
    expect(u.address).toEqual({ line1: '1 Queen St', countryCodeIso: 'NZL' })
    expect(u.lastUpdatedDateTimeUtc).toMatch(ISO_MICROS)
    expect(u.status).toBe('ACTIVE')
    const events = await payloadsFor(c.customerHayId!)
    expect(events.at(-1)).toEqual({
      customerHayId: c.customerHayId, idempotencyKey: expect.any(String), type: 'CUSTOMER_DETAILS_CHANGE', actionOwner: 'CLIENT',
      customerDetailsChangeEvent: { phoneNumberChanged: true, customerNameChanged: true, emailAddressChanged: true, addressChanged: true },
    })
  })

  it('flags only what changed: an email-only change reports emailAddressChanged alone', async () => {
    const c = await createActive()
    const res = await app.inject({ method: 'PATCH', url: `/v0/customers/${c.customerHayId}`, payload: { email: `renamed${n}@example.com` } })
    expect(res.statusCode).toBe(200)
    const events = await payloadsFor(c.customerHayId!)
    expect(events.at(-1).customerDetailsChangeEvent).toEqual({ phoneNumberChanged: false, customerNameChanged: false, emailAddressChanged: true, addressChanged: false })
  })

  it('a change outside the four flags (gender) and a same-value phone (with +) publish the domain event but no CUSTOMER_DETAILS_CHANGE webhook', async () => {
    const c = await createActive()
    const before = (await payloadsFor(c.customerHayId!)).length
    const seen: any[] = []
    const off = built.ctx.events.on('customer.detailsChanged', (e) => seen.push(e))
    const res = await app.inject({ method: 'PATCH', url: `/v0/customers/${c.customerHayId}`, payload: { gender: 'FEMALE', phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: c.phoneNumber!.numberAfterPrefix } } })
    off()
    expect(res.statusCode).toBe(200)
    expect(res.json().customerDetails.gender).toBe('FEMALE')
    expect(res.json().lastUpdatedDateTimeUtc).toMatch(ISO_MICROS)
    expect(seen).toHaveLength(1)
    expect(seen[0].changes).toEqual({ phoneNumberChanged: false, customerNameChanged: false, emailAddressChanged: false, addressChanged: false })
    expect((await payloadsFor(c.customerHayId!)).length).toBe(before)
  })

  it('taxObligations: [] is a no-op on a customer without any and clears an existing list', async () => {
    const none = await createActive()
    const noop = await app.inject({ method: 'PATCH', url: `/v0/customers/${none.customerHayId}`, payload: { taxObligations: [] } })
    expect(noop.statusCode).toBe(200)
    expect(noop.json()).toEqual(none)
    const some = await createActive({ taxObligations: [{ country: 'NZL', taxIdNumber: '1' }] })
    const cleared = await app.inject({ method: 'PATCH', url: `/v0/customers/${some.customerHayId}`, payload: { taxObligations: [] } })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().lastUpdatedDateTimeUtc).toMatch(ISO_MICROS)
    expect(built.ctx.services.customers.get(some.customerHayId!).taxObligations).toBeUndefined()
  })

  it('a no-op PATCH returns 200 without a webhook', async () => {
    const c = await createActive()
    const before = (await payloadsFor(c.customerHayId!)).length
    const res = await app.inject({ method: 'PATCH', url: `/v0/customers/${c.customerHayId}`, payload: { email: c.email } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(c)
    expect((await payloadsFor(c.customerHayId!)).length).toBe(before)
  })

  it('replaces documentData as a whole (unspecified fields become absent) and taxObligations as a list', async () => {
    const c = await createActive({ identityDocumentType: 'DRIVING_LICENSE', identityDocumentNumber: 'X1', identityDocumentCardNumber: 'CARD001', identityDocumentIssuingCountry: 'AUS', identityDocumentRegion: 'VIC', taxObligations: [{ country: 'NZL', taxIdNumber: '1' }] })
    const res = await app.inject({ method: 'PATCH', url: `/v0/customers/${c.customerHayId}`, payload: { documentData: { identityDocumentType: 'PASSPORT', identityDocumentNumber: 'P2', identityDocumentIssuingCountry: 'NZL' }, taxObligations: [] } })
    expect(res.statusCode, res.body).toBe(200)
    const u = res.json() as HayCustomer
    expect(u).toMatchObject({ identityDocumentType: 'PASSPORT', identityDocumentNumber: 'P2', identityDocumentIssuingCountry: 'NZL' })
    expect(u).not.toHaveProperty('identityDocumentCardNumber')
    expect(u).not.toHaveProperty('identityDocumentRegion')
    expect(built.ctx.services.customers.get(c.customerHayId!).taxObligations).toBeUndefined()
    const invalid = await app.inject({ method: 'PATCH', url: `/v0/customers/${c.customerHayId}`, payload: { documentData: { identityDocumentType: 'PASSPORT' } } })
    expect(invalid.statusCode).toBe(400)
  })

  it('re-runs every uniqueness rule (email, phone, name + DOB, identity document) against other live customers', async () => {
    const a = await createActive({ identityDocumentType: 'PASSPORT', identityDocumentNumber: 'UPD-A1', customerDetails: { firstName: 'Grace', lastName: 'Hopper', dateOfBirth: '1906-12-09' } })
    const b = await createActive()
    const expectDuplicate = async (payload: Record<string, unknown>) => {
      const res = await app.inject({ method: 'PATCH', url: `/v0/customers/${b.customerHayId}`, payload })
      expect(res.statusCode, res.body).toBe(422)
      expect(res.json().message).toMatch(/^DUPLICATE_CUSTOMER: /)
    }
    await expectDuplicate({ email: a.email!.toUpperCase() })
    await expectDuplicate({ phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: a.phoneNumber!.numberAfterPrefix } })
    await expectDuplicate({ firstName: 'grace', lastName: 'HOPPER', dateOfBirth: '1906-12-09' })
    await expectDuplicate({ documentData: { identityDocumentType: 'PASSPORT', identityDocumentNumber: 'UPD-A1', identityDocumentIssuingCountry: 'AUS' } })
    expect(await get(b.customerHayId!)).toEqual(b)
    const self = await app.inject({ method: 'PATCH', url: `/v0/customers/${b.customerHayId}`, payload: { email: b.email!.toUpperCase() } })
    expect(self.statusCode).toBe(200)
  })

  it('refuses updates on INACTIVE customers (422) and unknown ids (404)', async () => {
    const c = await createActive()
    built.ctx.services.customers.markInactive(c.customerHayId!, 'OPERATIONAL')
    const res = await app.inject({ method: 'PATCH', url: `/v0/customers/${c.customerHayId}`, payload: { firstName: 'X' } })
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/^INVALID_STATE: /)
    expect((await app.inject({ method: 'PATCH', url: `/v0/customers/${UNKNOWN_ID}`, payload: { firstName: 'X' } })).statusCode).toBe(404)
  })

  it('publishes customer.detailsChanged with skipPayIdUpdate for the PayID domain', async () => {
    const c = await createActive()
    const seen: any[] = []
    const off = built.ctx.events.on('customer.detailsChanged', (e) => seen.push(e))
    await app.inject({ method: 'PATCH', url: `/v0/customers/${c.customerHayId}`, payload: { lastName: 'Renamed', skipPayIdUpdate: true } })
    await app.inject({ method: 'PATCH', url: `/v0/customers/${c.customerHayId}`, payload: { lastName: 'Renamed2' } })
    off()
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ skipPayIdUpdate: true, changes: { customerNameChanged: true }, customer: { customerDetails: { lastName: 'Renamed' } } })
    expect(seen[1]).toMatchObject({ skipPayIdUpdate: false, previous: { customerDetails: { lastName: 'Renamed' } }, customer: { customerDetails: { lastName: 'Renamed2' } } })
  })
})

describe('getAllCustomers and searchCustomers (paging)', () => {
  const ids: string[] = []
  const lastName = `Pager${Date.now()}`
  beforeAll(async () => {
    await app.inject({ method: 'POST', url: '/_admin/reset' })
    for (let i = 0; i < 5; i++) ids.push((await create({ emailTag: 'pending', customerDetails: { firstName: `P${i}`, lastName, dateOfBirth: '2000-01-01' } })).customerHayId!)
  })

  it('lists in creation order with offset/limit', async () => {
    const all = await app.inject({ method: 'GET', url: '/v0/customers?offset=0&limit=1000' })
    expect(all.statusCode).toBe(200)
    expect((all.json() as HayCustomer[]).map((c) => c.customerHayId)).toEqual(ids)
    const page = await app.inject({ method: 'GET', url: '/v0/customers?offset=2&limit=2' })
    expect((page.json() as HayCustomer[]).map((c) => c.customerHayId)).toEqual(ids.slice(2, 4))
    const beyond = await app.inject({ method: 'GET', url: '/v0/customers?offset=50&limit=10' })
    expect(beyond.json()).toEqual([])
  })

  it('requires offset and limit and bounds limit to 1..1000 (400)', async () => {
    expect((await app.inject({ method: 'GET', url: '/v0/customers' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v0/customers?offset=0' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v0/customers?offset=0&limit=0' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v0/customers?offset=0&limit=1001' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v0/customers?offset=-1&limit=10' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v0/customers?offset=0&limit=abc' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/v0/customers/search?offset=0&limit=5000', payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/v0/customers/search', payload: {} })).statusCode).toBe(400)
  })

  it('search with an empty body returns everything, paged', async () => {
    const res = await app.inject({ method: 'POST', url: '/v0/customers/search?offset=1&limit=2', payload: {} })
    expect(res.statusCode).toBe(200)
    expect((res.json() as HayCustomer[]).map((c) => c.customerHayId)).toEqual(ids.slice(1, 3))
  })

  it('ANDs filters with exact, case-insensitive matching', async () => {
    const target = await get(ids[1]!)
    const search = async (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v0/customers/search?offset=0&limit=100', payload: body })
    expect((await search({ lastName: lastName.toLowerCase() })).json()).toHaveLength(5)
    expect((await search({ lastName, firstName: 'p1' })).json()).toHaveLength(1)
    expect((await search({ lastName, firstName: 'P1', email: 'nobody@example.com' })).json()).toHaveLength(0)
    expect((await search({ email: target.email!.toUpperCase() })).json()).toHaveLength(1)
    expect((await search({ firstName: 'P' })).json()).toHaveLength(0)
    expect((await search({ dateOfBirth: '2000-01-01', status: 'PENDING_APPROVAL' })).json()).toHaveLength(5)
    expect((await search({ status: 'ACTIVE', lastName })).json()).toHaveLength(0)
    expect((await search({ phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: target.phoneNumber!.numberAfterPrefix } })).json()).toHaveLength(1)
    expect((await search({ phoneNumber: { countryCodePrefix: '61', numberAfterPrefix: target.phoneNumber!.numberAfterPrefix } })).json()).toHaveLength(1)
    const byIds = await search({ customerIds: [ids[0], ids[4], UNKNOWN_ID] })
    expect((byIds.json() as HayCustomer[]).map((c) => c.customerHayId)).toEqual([ids[0], ids[4]])
    expect((await search({ customerIds: [] })).statusCode).toBe(400)
    expect((await search({ status: 'NOPE' })).statusCode).toBe(400)
  })
})

describe('delegated sub-resources', () => {
  const services = () => built.ctx.services as unknown as Record<string, unknown>

  it('getAccountsForCustomerId / getCardsForCustomerId return [] when the other domains are not loaded, 404 for unknown customers', async () => {
    const c = await createActive()
    delete services().accounts
    delete services().cards
    const accounts = await app.inject({ method: 'GET', url: `/v0/customers/${c.customerHayId}/accounts` })
    expect(accounts.statusCode).toBe(200)
    expect(accounts.json()).toEqual([])
    const cards = await app.inject({ method: 'GET', url: `/v0/customers/${c.customerHayId}/cards` })
    expect(cards.statusCode).toBe(200)
    expect(cards.json()).toEqual([])
    expect((await app.inject({ method: 'GET', url: `/v0/customers/${UNKNOWN_ID}/accounts` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/v0/customers/${UNKNOWN_ID}/cards` })).statusCode).toBe(404)
  })

  it('delegates to accounts.listForHolder and cards.listForCustomer when registered', async () => {
    const c = await createActive()
    const account = { accountHayId: randomUUID(), accountHolderId: c.customerHayId, accountHolderType: 'CUSTOMER', status: 'APPROVED', totalBalance: 0, customData: null }
    const card = { cardHayId: randomUUID(), customerHayId: c.customerHayId, cardStatus: 'ACTIVE', cardType: 'VIRTUAL' }
    const listForHolder = vi.fn(() => [account])
    const listForCustomer = vi.fn(() => [card])
    services().accounts = { listForHolder }
    services().cards = { listForCustomer }
    try {
      const accounts = await app.inject({ method: 'GET', url: `/v0/customers/${c.customerHayId}/accounts` })
      expect(accounts.json()).toEqual([account])
      expect(listForHolder).toHaveBeenCalledWith(c.customerHayId)
      const cards = await app.inject({ method: 'GET', url: `/v0/customers/${c.customerHayId}/cards` })
      expect(cards.json()).toEqual([card])
      expect(listForCustomer).toHaveBeenCalledWith(c.customerHayId)
    } finally {
      delete services().accounts
      delete services().cards
    }
  })

  describe('createHayAccount (deprecated v0)', () => {
    it('404 for unknown customers, 422 PERMISSION_DENIED with the documented message when not ACTIVE', async () => {
      const key = randomUUID()
      expect((await app.inject({ method: 'POST', url: `/v0/customers/${UNKNOWN_ID}/account`, payload: { idempotencyKey: key } })).statusCode).toBe(404)
      const c = await createActive()
      await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/block`, payload: { note: 'x' } })
      const res = await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/account`, payload: { idempotencyKey: key } })
      expect(res.statusCode).toBe(422)
      expect(res.json()).toEqual({
        message: `PERMISSION_DENIED: Account cannot be created for customer with id ${c.customerHayId} as their status is currently BLOCKED`,
        details: 'Please refer to the API documentation or contact Shaype for more info with the traceId.',
        status: '422',
        traceId: expect.any(String),
      })
      const pending = await create({ emailTag: 'pending' })
      const p = await app.inject({ method: 'POST', url: `/v0/customers/${pending.customerHayId}/account`, payload: { idempotencyKey: key } })
      expect(p.json().message).toContain('status is currently PENDING_APPROVAL')
      expect((await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/account`, payload: {} })).statusCode).toBe(400)
    })

    it('422 NOT_AVAILABLE for an ACTIVE customer while the accounts domain is not loaded', async () => {
      const c = await createActive()
      delete services().accounts
      const res = await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/account`, payload: { idempotencyKey: randomUUID() } })
      expect(res.statusCode).toBe(422)
      expect(res.json().message).toMatch(/^NOT_AVAILABLE: /)
    })

    it('delegates to accounts.create with the documented call shape and is idempotent by key', async () => {
      const c = await createActive()
      const account = { accountHayId: randomUUID(), accountHolderId: c.customerHayId, accountHolderType: 'CUSTOMER', status: 'APPROVED', customData: { a: 1 } }
      const createFn = vi.fn(() => account)
      services().accounts = { create: createFn, listForHolder: () => [] }
      try {
        const body = { idempotencyKey: randomUUID(), customData: { a: 1 } }
        const first = await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/account`, payload: body })
        expect(first.statusCode, first.body).toBe(200)
        expect(first.json()).toEqual(account)
        expect(createFn).toHaveBeenCalledTimes(1)
        expect(createFn).toHaveBeenCalledWith({ accountHolderType: 'CUSTOMER', accountHolderId: c.customerHayId, customData: { a: 1 } }, { actionOwner: 'CLIENT' })
        const replay = await app.inject({ method: 'POST', url: `/v0/customers/${c.customerHayId}/account`, payload: body })
        expect(replay.statusCode).toBe(200)
        expect(replay.json()).toEqual(account)
        expect(createFn).toHaveBeenCalledTimes(1)
        const other = await createActive()
        const reuse = await app.inject({ method: 'POST', url: `/v0/customers/${other.customerHayId}/account`, payload: body })
        expect(reuse.statusCode).toBe(422)
        expect(reuse.json().message).toMatch(/^IDEMPOTENCY_KEY_REUSED/)
      } finally {
        delete services().accounts
      }
    })
  })
})

describe('ctx.services.customers (API for other domains)', () => {
  it('get/require throw notFound, requireActive throws the PERMISSION_DENIED 422 for the given subject', async () => {
    const svc = built.ctx.services.customers
    expect(() => svc.get(UNKNOWN_ID)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => svc.require(UNKNOWN_ID)).toThrow(expect.objectContaining({ status: 404 }))
    expect(svc.find(UNKNOWN_ID)).toBeUndefined()
    const pending = await create({ emailTag: 'pending' })
    expect(() => svc.requireActive(pending.customerHayId!)).toThrow(expect.objectContaining({ status: 422, message: `PERMISSION_DENIED: Account cannot be created for customer with id ${pending.customerHayId} as their status is currently PENDING_APPROVAL` }))
    expect(() => svc.requireActive(pending.customerHayId!, 'Card')).toThrow(/^PERMISSION_DENIED: Card cannot be created/)
    const active = await createActive()
    expect(svc.requireActive(active.customerHayId!).id).toBe(active.customerHayId)
    expect(svc.toResponse(svc.get(active.customerHayId!))).toEqual(await get(active.customerHayId!))
  })

  it('markInactive (account-closure cascade) stores the closure reason, sets closedDateTimeUtc and publishes customer.statusChanged; the INACTIVE webhook is off by default', async () => {
    const svc = built.ctx.services.customers
    const c = await createActive()
    const seen: any[] = []
    const off = built.ctx.events.on('customer.statusChanged', (e) => seen.push(e))
    const closed = svc.markInactive(c.customerHayId!, 'DECEASED')
    svc.markInactive(c.customerHayId!, 'DECEASED')
    off()
    expect(closed).toMatchObject({ status: 'INACTIVE', statusReason: 'DECEASED', closedAt: expect.stringMatching(ISO_MICROS) })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ previousStatus: 'ACTIVE', actionOwner: 'PLATFORM', customer: { status: 'INACTIVE' } })
    const events = await payloadsFor(c.customerHayId!)
    expect(events.map((e) => e.type)).toEqual(['ONBOARDING_PASSED', 'CUSTOMER_STATUS_UPDATED'])
    expect(events.at(-1).customerStatusUpdatedEvent).toEqual({ customerStatus: 'ACTIVE' })
    expect((await get(c.customerHayId!))).toMatchObject({ status: 'INACTIVE', statusReason: 'DECEASED' })
  })

  it('emits CUSTOMER_STATUS_UPDATED INACTIVE (PLATFORM) for the closure cascade when emitCustomerInactive is on', async () => {
    const other = await startApp({ emitCustomerInactive: true })
    try {
      const res = await other.app.inject({ method: 'POST', url: '/v0/customers/create', payload: customerBody() })
      expect(res.statusCode, res.body).toBe(200)
      const id = (res.json() as HayCustomer).customerHayId!
      await other.app.inject({ method: 'POST', url: '/_admin/flush' })
      other.ctx.services.customers.markInactive(id, 'DECEASED')
      await other.app.inject({ method: 'POST', url: '/_admin/flush' })
      const rows = (await other.app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })).json() as { payload: any }[]
      const last = rows.at(-1)!.payload
      expect(last).toEqual({ customerHayId: id, idempotencyKey: expect.any(String), type: 'CUSTOMER_STATUS_UPDATED', actionOwner: 'PLATFORM', customerStatusUpdatedEvent: { customerStatus: 'INACTIVE' } })
      assertValidNotification(last, 'v0')
    } finally {
      await other.app.close()
    }
  })

  it('setStatus is a no-op for the same status and refuses to leave INACTIVE', async () => {
    const svc = built.ctx.services.customers
    const c = await createActive()
    const seen: unknown[] = []
    const off = built.ctx.events.on('customer.statusChanged', (e) => seen.push(e))
    expect(svc.toResponse(svc.setStatus(c.customerHayId!, 'ACTIVE', { actionOwner: 'PLATFORM' }))).toEqual(c)
    off()
    expect(seen).toEqual([])
    svc.markInactive(c.customerHayId!)
    expect(() => svc.setStatus(c.customerHayId!, 'ACTIVE', { actionOwner: 'PLATFORM' })).toThrow(expect.objectContaining({ status: 422 }))
    expect(svc.list({ offset: 0, limit: 1000 }).some((x) => x.id === c.customerHayId)).toBe(true)
    expect(svc.search({ customerIds: [c.customerHayId!] }, { offset: 0, limit: 10 })).toHaveLength(1)
  })
})

describe('webhook contract', () => {
  it('every notification emitted by this domain validates against wh:NotificationDto', async () => {
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    const passed = await createActive()
    await create({ emailTag: 'referred' })
    await create({ emailTag: 'rejected' })
    await app.inject({ method: 'PATCH', url: `/v0/customers/${passed.customerHayId}`, payload: { firstName: 'Changed' } })
    await app.inject({ method: 'POST', url: `/v0/customers/${passed.customerHayId}/block`, payload: { note: 'x' } })
    await app.inject({ method: 'POST', url: `/v0/customers/${passed.customerHayId}/unblock`, payload: { note: 'x' } })
    built.ctx.services.customers.markInactive(passed.customerHayId!, 'CUSTOMER')
    await flush()
    const res = await app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })
    const rows = res.json() as { version: string; type: string; payload: unknown }[]
    expect([...new Set(rows.map((r) => r.type))].sort()).toEqual(['CUSTOMER_DETAILS_CHANGE', 'CUSTOMER_STATUS_UPDATED', 'ONBOARDING_FAILED', 'ONBOARDING_PASSED'])
    expect(rows).toHaveLength(9) // the closure-cascade INACTIVE webhook is behind emitCustomerInactive (off)
    for (const r of rows) {
      expect(r.version).toBe('v0')
      assertValidNotification(r.payload, 'v0')
    }
    // the validator itself rejects a malformed envelope
    expect(() => assertValidNotification({ customerHayId: 'nope', idempotencyKey: randomUUID(), type: 'CUSTOMER_STATUS_UPDATED', customerStatusUpdatedEvent: { customerStatus: 'CLOSED' } })).toThrow(/does not match/)
  })
})

describe('dependency shapes (deps.ts)', () => {
  it('refuses to start when a registered accounts/cards service lacks a method customers calls', async () => {
    const bad = await buildServer({ logLevel: 'silent', auth: false })
    const services = bad.ctx.services as unknown as Record<string, unknown>
    services.accounts = { create: () => ({}) }
    services.cards = {}
    await expect(bad.app.ready()).rejects.toThrow(/accounts\.listForHolder[\s\S]*cards\.listForCustomer/)
    await bad.app.close()
  })
})
