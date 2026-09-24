import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '../src/contract/generated/b2b-types.js'
import { startApp } from './helpers.js'
import { assertValidNotification } from './webhook-schema.js'
import type { BuiltServer } from '../src/server.js'
import { LOCAL_PRODUCT_ID } from '../src/domains/accounts/index.js'
import { BRANCH_IDENTIFIER_FORMAT_MESSAGE, LOCAL_SERVICER_BIC, type PayIdService } from '../src/domains/payid-npp/index.js'

type S = components['schemas']
type HayAccount = S['HayAccount']
type PayIdDetails = S['PayIdDetailsResponse']
type PayIdType = S['PayIdRegisterRequestBody']['payIdType']

const PAYID_OPS = ['getPayId', 'getPayIdAvailability', 'getPayIdDeregisterHistory', 'updatePayIdDetails', 'resolvePayId', 'updatePayIdStatus', 'getPayIdsForAccount', 'postPayIdRegister', 'verifyBranchIdentifier']
const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111'
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const UUID_RE = /^[0-9a-f-]{36}$/
const DAY_MS = 24 * 60 * 60 * 1000

let built: BuiltServer
let app: BuiltServer['app']
let svc: PayIdService
beforeAll(async () => { built = await startApp(); app = built.app; svc = built.ctx.services.payid })
afterAll(async () => { await built.app.close() })

let n = 0
async function flush(): Promise<void> {
  await app.inject({ method: 'POST', url: '/_admin/flush' })
}
async function newCustomer(details: Partial<S['CustomerDetails']> = {}): Promise<string> {
  n++
  const res = await app.inject({
    method: 'POST', url: '/v0/customers/create',
    payload: {
      idempotencyKey: randomUUID(), email: `payid${n}@example.com`, customerTier: 'STANDARD',
      phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: `7${String(n).padStart(8, '0')}` },
      address: { line1: '1 Test St', townOrCity: 'Sydney', administrativeRegion: 'NSW', postcode: '2000', countryCodeIso: 'AUS' },
      customerDetails: { firstName: 'Pay', lastName: `Holder${n}`, dateOfBirth: '1990-01-01', ...details },
    },
  })
  expect(res.statusCode, res.body).toBe(200)
  await flush()
  return res.json().customerHayId as string
}
async function newAccount(holder?: string, opts: { risk?: 'LOW' | 'HIGH' } = {}): Promise<HayAccount> {
  const holderId = holder ?? (await newCustomer())
  const res = await app.inject({ method: 'POST', url: '/v1/accounts', payload: { idempotencyKey: randomUUID(), accountHolderId: holderId, accountHolderType: 'CUSTOMER', productId: LOCAL_PRODUCT_ID } })
  expect(res.statusCode, res.body).toBe(200)
  const a = res.json() as HayAccount
  if (opts.risk === 'LOW') {
    const r = await app.inject({ method: 'PATCH', url: `/v0/accounts/${a.accountHayId}/riskLevel`, payload: { level: 'LOW', reason: 'test' } })
    expect(r.statusCode, r.body).toBe(200)
  }
  await flush()
  return a
}
/** A fresh PayID value of the given type (unique per call). */
function value(type: PayIdType = 'EMAIL'): string {
  n++
  switch (type) {
    case 'EMAIL': return `alias${n}@example.com`
    case 'TELEPHONE': return `+61-4${String(n).padStart(8, '0')}`
    case 'INDIVIDUAL_AUSTRALIAN_BUSINESS': return `5${String(n).padStart(10, '0')}`
    case 'ORGANISATION': return `org ${n} plumbing mosman nsw`
  }
}
function registerBody(overrides: Partial<S['PayIdRegisterRequestBody']> = {}): S['PayIdRegisterRequestBody'] {
  return { ownerName: 'Pay Holder', payIdName: 'Main', payIdType: 'EMAIL', ...overrides }
}
async function register(accountId: string, payId: string, overrides: Partial<S['PayIdRegisterRequestBody']> = {}) {
  return app.inject({ method: 'POST', url: `/v1/accounts/${accountId}/payids/${encodeURIComponent(payId)}/register`, payload: registerBody(overrides) })
}
/** Registers a fresh PayID on a fresh (or given) account and returns both. */
async function registered(type: PayIdType = 'EMAIL', account?: HayAccount): Promise<{ account: HayAccount; payId: string }> {
  const a = account ?? (await newAccount())
  const payId = value(type)
  const res = await register(a.accountHayId!, payId, { payIdType: type })
  expect(res.statusCode, res.body).toBe(200)
  expect(res.json()).toEqual({ message: 'PayID registered successfully.' })
  return { account: a, payId }
}
async function getPayId(payId: string, type: PayIdType = 'EMAIL') {
  return app.inject({ method: 'GET', url: `/v0/payids/${encodeURIComponent(payId)}?payIdType=${type}` })
}
async function details(payId: string, type: PayIdType = 'EMAIL'): Promise<S['PayIdResponse']> {
  const res = await getPayId(payId, type)
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as S['PayIdResponse']
}
async function setStatus(payId: string, body: Partial<S['UpdatePayIdStatusRequestBody']> & { payIdStatus: S['UpdatePayIdStatusRequestBody']['payIdStatus'] }) {
  return app.inject({ method: 'PATCH', url: `/v0/payids/${encodeURIComponent(payId)}/status`, payload: { payIdType: 'EMAIL', ...body } })
}
async function mustSetStatus(payId: string, body: Partial<S['UpdatePayIdStatusRequestBody']> & { payIdStatus: S['UpdatePayIdStatusRequestBody']['payIdStatus'] }): Promise<void> {
  const res = await setStatus(payId, body)
  expect(res.statusCode, res.body).toBe(200)
  expect(res.json()).toEqual({ message: 'PayID status updated successfully.' })
}
async function updateDetails(payId: string, body: Partial<S['UpdatePayIdDetailsRequestBody']>) {
  return app.inject({ method: 'POST', url: `/v0/payids/${encodeURIComponent(payId)}/details`, payload: { payIdType: 'EMAIL', ...body } })
}
async function availability(payId: string, type?: PayIdType) {
  return app.inject({ method: 'GET', url: `/v0/payids/${encodeURIComponent(payId)}/availability${type ? `?payIdType=${type}` : ''}` })
}
async function resolve(payId: string, type?: PayIdType) {
  return app.inject({ method: 'GET', url: `/v0/payids/${encodeURIComponent(payId)}/resolve${type ? `?payIdType=${type}` : ''}` })
}
async function history(payId: string): Promise<S['PayIdDeregisterDetailsResponse'][]> {
  const res = await app.inject({ method: 'GET', url: `/v0/payids/${encodeURIComponent(payId)}/deregister-history` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
async function listForAccount(accountId: string): Promise<PayIdDetails[]> {
  const res = await app.inject({ method: 'GET', url: `/v1/accounts/${accountId}/payids` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
async function status(payId: string, type: PayIdType = 'EMAIL'): Promise<string> {
  return (await details(payId, type)).payIdDetails!.status!
}
async function notificationCount(): Promise<number> {
  await flush()
  const res = await app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })
  return (res.json() as unknown[]).length
}
async function setClock(body: { freeze?: string; advanceMs?: number; reset?: boolean }): Promise<void> {
  const res = await app.inject({ method: 'POST', url: '/_admin/clock', payload: body })
  expect(res.statusCode, res.body).toBe(200)
}
function expectError(res: { statusCode: number; json: () => any }, status: number, code: RegExp | string): void {
  expect(res.statusCode).toBe(status)
  const body = res.json()
  expect(body).toMatchObject({ status: String(status), details: expect.stringContaining('traceId') })
  expect(body.traceId).toMatch(UUID_RE)
  expect(body.message).toMatch(code)
}

describe('payid-npp domain: registration', () => {
  it('handles every PayID API operation and verifyBranchIdentifier (none left on the stub)', async () => {
    const res = await app.inject({ method: 'GET', url: '/_admin/operations' })
    const { handled, stubbed } = res.json() as { handled: string[]; stubbed: string[] }
    for (const op of PAYID_OPS) {
      expect(handled, op).toContain(op)
      expect(stubbed, op).not.toContain(op)
    }
  })

  it('publishes ctx.services.payid with the resolve() shape transactions expects', () => {
    expect(typeof svc.resolve).toBe('function')
    expect(svc.resolve('nobody@example.com')).toBeUndefined()
  })
})

describe('postPayIdRegister', () => {
  it('creates an ACTIVE registration linked to the account; getPayId returns account + PayID details', async () => {
    const account = await newAccount()
    const before = await notificationCount()
    const { payId } = await registered('EMAIL', account)
    const d = await details(payId)
    expect(d.accountDetails).toEqual({ accountNumber: account.accountNumber, branchNumber: '636220', ownerName: 'Pay Holder' })
    expect(d.payIdDetails).toEqual({
      payIdValue: payId, payIdType: 'EMAIL', payIdName: 'Main', status: 'ACTIVE',
      registrationDateTimeUtc: expect.stringMatching(ISO_MICROS), lastUpdatedDateTimeUtc: expect.stringMatching(ISO_MICROS),
    })
    expect(d.payIdDetails).not.toHaveProperty('reason')
    expect(d.payIdDetails).not.toHaveProperty('lastResolutionDateTimeUtc')
    expect(d.payIdDetails!.registrationDateTimeUtc).toBe(d.payIdDetails!.lastUpdatedDateTimeUtc)
    expect(await listForAccount(account.accountHayId!)).toEqual([d.payIdDetails])
    // No PayID webhook exists in the notification spec: nothing was emitted.
    expect(await notificationCount()).toBe(before)
  })

  it('accepts every payIdType with its documented format and lower-cases EMAIL values', async () => {
    const account = await newAccount()
    for (const type of ['TELEPHONE', 'INDIVIDUAL_AUSTRALIAN_BUSINESS', 'ORGANISATION'] as const) {
      const { payId } = await registered(type, account)
      expect((await details(payId, type)).payIdDetails).toMatchObject({ payIdValue: payId, payIdType: type, status: 'ACTIVE' })
    }
    const mixed = `Mixed.Case${n}@Example.COM`
    expect((await register(account.accountHayId!, mixed)).statusCode).toBe(200)
    expect((await details(mixed.toLowerCase())).payIdDetails!.payIdValue).toBe(mixed.toLowerCase())
    expect((await details(mixed)).payIdDetails!.payIdValue).toBe(mixed.toLowerCase())
    expect(await listForAccount(account.accountHayId!)).toHaveLength(4)
  })

  it('refuses malformed values per type with 422 INVALID_PAY_ID', async () => {
    const account = await newAccount()
    const cases: [string, PayIdType][] = [
      ['0423765879', 'TELEPHONE'], ['+61-0423765879', 'TELEPHONE'], ['+61423765879', 'TELEPHONE'],
      ['not-an-email', 'EMAIL'], ['two words@example.com', 'EMAIL'], ['@example.com', 'EMAIL'], ['a@b@example.com', 'EMAIL'],
      ['12345678', 'INDIVIDUAL_AUSTRALIAN_BUSINESS'], ['123456789012', 'INDIVIDUAL_AUSTRALIAN_BUSINESS'], ['ABN601428737', 'INDIVIDUAL_AUSTRALIAN_BUSINESS'],
      ['   ', 'ORGANISATION'],
      [`${'a'.repeat(245)}@example.com`, 'EMAIL'], ['o'.repeat(257), 'ORGANISATION'],
    ]
    for (const [payId, payIdType] of cases) expectError(await register(account.accountHayId!, payId, { payIdType }), 422, /^INVALID_PAY_ID/)
    expect(await listForAccount(account.accountHayId!)).toEqual([])
  })

  it('long values (over 100 and up to 256 characters) round-trip on every {payId} route', async () => {
    const account = await newAccount()
    for (const len of [122, 256]) {
      const suffix = `${++n}@example.com`
      const payId = `${'l'.repeat(len - suffix.length)}${suffix}`
      expect(payId).toHaveLength(len)
      const res = await register(account.accountHayId!, payId)
      expect(res.statusCode, res.body).toBe(200)
      expect((await details(payId)).payIdDetails).toMatchObject({ payIdValue: payId, status: 'ACTIVE' })
      expect((await availability(payId, 'EMAIL')).json()).toMatchObject({ availability: false })
      expect((await resolve(payId)).json()).toMatchObject({ payIdValue: payId })
      expect((await updateDetails(payId, { payIdName: 'Long' })).statusCode).toBe(200)
      await mustSetStatus(payId, { payIdStatus: 'DEREGISTERED', reason: 'CUST' })
      expect(await history(payId)).toEqual([expect.objectContaining({ payIdName: 'Long', reason: 'CUST' })])
    }
    const org = 'o'.repeat(256)
    expect((await register(account.accountHayId!, org, { payIdType: 'ORGANISATION' })).statusCode).toBe(200)
    expect((await details(org, 'ORGANISATION')).payIdDetails).toMatchObject({ payIdValue: org })
  })

  it('validates the request: missing / empty body fields and a non-uuid account are 400', async () => {
    const account = await newAccount()
    const url = `/v1/accounts/${account.accountHayId}/payids/${value()}/register`
    expectError(await app.inject({ method: 'POST', url, payload: { payIdName: 'x', payIdType: 'EMAIL' } }), 400, /^BAD_REQUEST/)
    expectError(await app.inject({ method: 'POST', url, payload: { ownerName: '', payIdName: 'x', payIdType: 'EMAIL' } }), 400, /^BAD_REQUEST/)
    expectError(await app.inject({ method: 'POST', url, payload: { ownerName: '  ', payIdName: 'x', payIdType: 'EMAIL' } }), 400, /^BAD_REQUEST/)
    expectError(await app.inject({ method: 'POST', url, payload: { ownerName: 'A', payIdName: 'x', payIdType: 'PHONE' } }), 400, /^BAD_REQUEST/)
    expectError(await app.inject({ method: 'POST', url: `/v1/accounts/not-a-uuid/payids/${value()}/register`, payload: registerBody() }), 400, /^BAD_REQUEST/)
    expectError(await register(UNKNOWN_ID, value()), 404, /^NOT_FOUND: Account/)
  })

  it('needs an open account (LOCKED -> ACCOUNT_BLOCKED, CLOSED -> ACCOUNT_CLOSED) and an ACTIVE holder (PERMISSION_DENIED)', async () => {
    const locked = await newAccount()
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${locked.accountHayId}/block`, payload: { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' } })).statusCode).toBe(200)
    expectError(await register(locked.accountHayId!, value()), 422, /^ACCOUNT_BLOCKED/)

    const closed = await newAccount()
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${closed.accountHayId}/close`, payload: {} })).statusCode).toBe(202)
    await flush()
    expectError(await register(closed.accountHayId!, value()), 422, /^ACCOUNT_CLOSED/)

    const customer = await newCustomer()
    const account = await newAccount(customer)
    expect((await app.inject({ method: 'POST', url: `/v0/customers/${customer}/block`, payload: { note: 'x' } })).statusCode).toBe(200)
    expectError(await register(account.accountHayId!, value()), 422, /^PERMISSION_DENIED: PayID cannot be created for customer/)
    expect((await app.inject({ method: 'POST', url: `/v0/customers/${customer}/unblock`, payload: { note: 'ok' } })).statusCode).toBe(200)
    expect((await register(account.accountHayId!, value())).statusCode).toBe(200)
  })

  it('one live registration per (value, type): held elsewhere -> PAYID_ALREADY_REGISTERED; same account ACTIVE -> no-op; other type is a different PayID', async () => {
    const { account, payId } = await registered('EMAIL')
    const other = await newAccount()
    expectError(await register(other.accountHayId!, payId), 422, /^PAYID_ALREADY_REGISTERED/)
    expectError(await register(other.accountHayId!, payId.toUpperCase()), 422, /^PAYID_ALREADY_REGISTERED/)

    const again = await register(account.accountHayId!, payId, { payIdName: 'Renamed', ownerName: 'Someone Else' })
    expect(again.statusCode).toBe(200)
    expect((await details(payId)).payIdDetails).toMatchObject({ payIdName: 'Main', status: 'ACTIVE' })
    expect(await listForAccount(account.accountHayId!)).toHaveLength(1)

    await mustSetStatus(payId, { payIdStatus: 'DISABLED' })
    expectError(await register(account.accountHayId!, payId), 422, /^PAYID_ALREADY_REGISTERED/)
    expectError(await register(other.accountHayId!, payId), 422, /^PAYID_ALREADY_REGISTERED/)

    const digits = `6${String(n).padStart(9, '0')}`
    expect((await register(account.accountHayId!, digits, { payIdType: 'INDIVIDUAL_AUSTRALIAN_BUSINESS' })).statusCode).toBe(200)
    expect((await register(other.accountHayId!, digits, { payIdType: 'ORGANISATION' })).statusCode).toBe(200)
    expect((await details(digits, 'INDIVIDUAL_AUSTRALIAN_BUSINESS')).accountDetails!.accountNumber).toBe(account.accountNumber)
    expect((await details(digits, 'ORGANISATION')).accountDetails!.accountNumber).toBe(other.accountNumber)
  })

  it('a DEREGISTERED value can be registered again on the same or another account as a new record', async () => {
    const { account, payId } = await registered('EMAIL')
    await mustSetStatus(payId, { payIdStatus: 'DEREGISTERED', reason: 'CUST' })
    const other = await newAccount()
    const res = await register(other.accountHayId!, payId, { ownerName: 'New Owner', payIdName: 'Moved' })
    expect(res.statusCode, res.body).toBe(200)
    const d = await details(payId)
    expect(d.accountDetails).toEqual({ accountNumber: other.accountNumber, branchNumber: '636220', ownerName: 'New Owner' })
    expect(d.payIdDetails).toMatchObject({ status: 'ACTIVE', payIdName: 'Moved' })
    expect(d.payIdDetails).not.toHaveProperty('reason')
    expect((await listForAccount(account.accountHayId!)).map((p) => p.status)).toEqual(['DEREGISTERED'])
    expect((await listForAccount(other.accountHayId!)).map((p) => p.status)).toEqual(['ACTIVE'])

    await mustSetStatus(payId, { payIdStatus: 'DEREGISTERED' })
    expect((await register(account.accountHayId!, payId)).statusCode).toBe(200)
    expect((await listForAccount(account.accountHayId!)).map((p) => p.status)).toEqual(['DEREGISTERED', 'ACTIVE'])
  })
})

describe('updatePayIdStatus (NPP state model)', () => {
  const allowed: [string, string][] = [
    ['ACTIVE', 'DISABLED'], ['DISABLED', 'ACTIVE'], ['ACTIVE', 'PORTABLE'], ['PORTABLE', 'ACTIVE'], ['PORTABLE', 'DISABLED'],
    ['ACTIVE', 'DEREGISTERED'], ['DISABLED', 'DEREGISTERED'], ['PORTABLE', 'DEREGISTERED'],
  ]
  /** Drives a fresh ACTIVE PayID into `from` through allowed transitions. */
  async function payIdIn(from: string): Promise<string> {
    const { payId } = await registered('EMAIL')
    if (from === 'DISABLED' || from === 'PORTABLE') await mustSetStatus(payId, { payIdStatus: from })
    if (from === 'DEREGISTERED') await mustSetStatus(payId, { payIdStatus: 'DEREGISTERED' })
    expect(await status(payId)).toBe(from)
    return payId
  }

  for (const [from, to] of allowed) {
    it(`${from} -> ${to} via updatePayIdStatus, storing the reason and bumping lastUpdatedDateTimeUtc`, async () => {
      const payId = await payIdIn(from)
      const before = (await details(payId)).payIdDetails!
      await setClock({ advanceMs: 1000 })
      await mustSetStatus(payId, { payIdStatus: to as S['UpdatePayIdStatusRequestBody']['payIdStatus'], reason: 'CUST' })
      const after = (await details(payId)).payIdDetails!
      expect(after).toMatchObject({ status: to, reason: 'CUST', registrationDateTimeUtc: before.registrationDateTimeUtc })
      expect(after.lastUpdatedDateTimeUtc! > before.lastUpdatedDateTimeUtc!).toBe(true)
      await setClock({ reset: true })
    })
  }

  it('rejects DISABLED -> PORTABLE (not in the state model) with 422 INVALID_STATUS_TRANSITION', async () => {
    const payId = await payIdIn('DISABLED')
    expectError(await setStatus(payId, { payIdStatus: 'PORTABLE' }), 422, /^INVALID_STATUS_TRANSITION/)
    expect(await status(payId)).toBe('DISABLED')
  })

  it('a DEREGISTERED PayID cannot have its status updated (422 INVALID_STATE) — it must be registered again', async () => {
    const payId = await payIdIn('DEREGISTERED')
    for (const payIdStatus of ['ACTIVE', 'DISABLED', 'PORTABLE'] as const) expectError(await setStatus(payId, { payIdStatus }), 422, /^INVALID_STATE/)
    expect(await status(payId)).toBe('DEREGISTERED')
  })

  it('same status is an idempotent no-op (200, nothing changes); DEREGISTERED -> DEREGISTERED is refused', async () => {
    const payId = await payIdIn('DISABLED')
    const before = (await details(payId)).payIdDetails
    await setClock({ advanceMs: 1000 })
    await mustSetStatus(payId, { payIdStatus: 'DISABLED', reason: 'FROD' })
    expect((await details(payId)).payIdDetails).toEqual(before)
    await setClock({ reset: true })
    const gone = await payIdIn('DEREGISTERED')
    expectError(await setStatus(gone, { payIdStatus: 'DEREGISTERED' }), 422, /^INVALID_STATE/)
  })

  it('reason: any code with any status; null or omitted clears it', async () => {
    const { payId } = await registered('EMAIL')
    await mustSetStatus(payId, { payIdStatus: 'DISABLED', reason: 'LEGL' })
    expect((await details(payId)).payIdDetails!.reason).toBe('LEGL')
    await mustSetStatus(payId, { payIdStatus: 'ACTIVE', reason: null })
    expect((await details(payId)).payIdDetails).not.toHaveProperty('reason')
    await mustSetStatus(payId, { payIdStatus: 'PORTABLE', reason: 'DECD' })
    expect((await details(payId)).payIdDetails!.reason).toBe('DECD')
    await mustSetStatus(payId, { payIdStatus: 'DISABLED' })
    expect((await details(payId)).payIdDetails).not.toHaveProperty('reason')
  })

  it('unknown PayID -> 404; missing payIdType / bad enum -> 400; the type is part of the identity', async () => {
    expectError(await setStatus(value(), { payIdStatus: 'DISABLED' }), 404, /^NOT_FOUND: PayID/)
    const { payId } = await registered('EMAIL')
    expectError(await app.inject({ method: 'PATCH', url: `/v0/payids/${payId}/status`, payload: { payIdStatus: 'DISABLED' } }), 400, /^BAD_REQUEST/)
    expectError(await setStatus(payId, { payIdStatus: 'FROZEN' as never }), 400, /^BAD_REQUEST/)
    expectError(await setStatus(payId, { payIdStatus: 'DISABLED', payIdType: 'ORGANISATION' }), 404, /^NOT_FOUND/)
    expect(await status(payId)).toBe('ACTIVE')
  })
})

describe('getPayId / getPayIdsForAccount', () => {
  it('getPayId needs payIdType (400 without) and answers 404 for an unknown PayID', async () => {
    const { payId } = await registered('EMAIL')
    expectError(await app.inject({ method: 'GET', url: `/v0/payids/${payId}` }), 400, /^BAD_REQUEST/)
    expectError(await getPayId(payId, 'TELEPHONE'), 404, /^NOT_FOUND: PayID/)
    expectError(await getPayId(value()), 404, /^NOT_FOUND: PayID/)
  })

  it('getPayIdsForAccount lists every registration of the account in order, all statuses; unknown account -> 404', async () => {
    const account = await newAccount()
    const a = (await registered('EMAIL', account)).payId
    const b = (await registered('TELEPHONE', account)).payId
    const c = (await registered('EMAIL', account)).payId
    await mustSetStatus(b, { payIdStatus: 'DEREGISTERED', payIdType: 'TELEPHONE', reason: 'CUST' })
    await mustSetStatus(c, { payIdStatus: 'PORTABLE' })
    const list = await listForAccount(account.accountHayId!)
    expect(list.map((p) => [p.payIdValue, p.status, p.reason])).toEqual([[a, 'ACTIVE', undefined], [b, 'DEREGISTERED', 'CUST'], [c, 'PORTABLE', undefined]])
    expect(list[1]).not.toHaveProperty('accountDetails')
    expect(await listForAccount((await newAccount()).accountHayId!)).toEqual([])
    expectError(await app.inject({ method: 'GET', url: `/v1/accounts/${UNKNOWN_ID}/payids` }), 404, /^NOT_FOUND: Account/)
    expectError(await app.inject({ method: 'GET', url: '/v1/accounts/nope/payids' }), 400, /^BAD_REQUEST/)
  })
})

describe('getPayIdAvailability', () => {
  it('unknown value -> available with no other fields (with or without payIdType)', async () => {
    const payId = value()
    expect((await availability(payId)).json()).toEqual({ availability: true })
    expect((await availability(payId, 'EMAIL')).json()).toEqual({ availability: true })
    expect((await availability(payId, 'ORGANISATION')).json()).toEqual({ availability: true })
  })

  it('ACTIVE and DISABLED are held (false, servicer = local BIC11); PORTABLE and DEREGISTERED are available', async () => {
    const { payId } = await registered('EMAIL')
    const d = (await details(payId)).payIdDetails!
    expect((await availability(payId, 'EMAIL')).json()).toEqual({ availability: false, servicer: LOCAL_SERVICER_BIC, registrationDateTimeUtc: d.registrationDateTimeUtc, lastUpdatedDateTimeUtc: d.lastUpdatedDateTimeUtc })
    expect((await availability(payId)).json()).toMatchObject({ availability: false })
    expect((await availability(payId, 'TELEPHONE')).json()).toEqual({ availability: true })

    await mustSetStatus(payId, { payIdStatus: 'DISABLED', reason: 'FROD' })
    expect((await availability(payId)).json()).toMatchObject({ availability: false, reason: 'FROD', servicer: LOCAL_SERVICER_BIC })

    await mustSetStatus(payId, { payIdStatus: 'ACTIVE' })
    await mustSetStatus(payId, { payIdStatus: 'PORTABLE' })
    expect((await availability(payId)).json()).toMatchObject({ availability: true, servicer: LOCAL_SERVICER_BIC })

    expect((await resolve(payId)).statusCode).toBe(200)
    await mustSetStatus(payId, { payIdStatus: 'DEREGISTERED', reason: 'CUST' })
    const gone = (await availability(payId)).json()
    expect(gone).toEqual({ availability: true, reason: 'CUST', registrationDateTimeUtc: d.registrationDateTimeUtc, lastUpdatedDateTimeUtc: expect.stringMatching(ISO_MICROS), lastResolutionDateTimeUtc: expect.stringMatching(ISO_MICROS) })
  })
})

describe('resolvePayId', () => {
  it('resolves an ACTIVE PayID to its account (no status in the body) and records lastResolutionDateTimeUtc', async () => {
    const { account, payId } = await registered('EMAIL')
    const res = await resolve(payId, 'EMAIL')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ accountDetails: { accountNumber: account.accountNumber, branchNumber: '636220', ownerName: 'Pay Holder' }, payIdName: 'Main', payIdType: 'EMAIL', payIdValue: payId })
    const d = (await details(payId)).payIdDetails!
    expect(d.lastResolutionDateTimeUtc).toMatch(ISO_MICROS)
    expect((await resolve(payId)).statusCode).toBe(200) // type optional
    expect((await resolve(payId.toUpperCase())).statusCode).toBe(200) // case-insensitive
  })

  it('PORTABLE still resolves; DISABLED and DEREGISTERED are 422 INVALID_STATE; unknown is 404', async () => {
    const { payId } = await registered('EMAIL')
    await mustSetStatus(payId, { payIdStatus: 'PORTABLE' })
    expect((await resolve(payId)).statusCode).toBe(200)
    await mustSetStatus(payId, { payIdStatus: 'DISABLED' })
    expectError(await resolve(payId), 422, /^INVALID_STATE: PayID .* is DISABLED/)
    await mustSetStatus(payId, { payIdStatus: 'DEREGISTERED' })
    expectError(await resolve(payId), 422, /^INVALID_STATE: PayID .* is DEREGISTERED/)
    expectError(await resolve(value()), 404, /^NOT_FOUND: PayID/)
    expectError(await resolve(payId, 'TELEPHONE'), 404, /^NOT_FOUND: PayID/)
  })

  it('without payIdType the live registration wins over a deregistered one of another type', async () => {
    const digits = `7${String(++n).padStart(9, '0')}`
    const a = await newAccount()
    const b = await newAccount()
    expect((await register(a.accountHayId!, digits, { payIdType: 'INDIVIDUAL_AUSTRALIAN_BUSINESS', payIdName: 'ABN' })).statusCode).toBe(200)
    expect((await register(b.accountHayId!, digits, { payIdType: 'ORGANISATION', payIdName: 'ORG' })).statusCode).toBe(200)
    await mustSetStatus(digits, { payIdStatus: 'DEREGISTERED', payIdType: 'INDIVIDUAL_AUSTRALIAN_BUSINESS' })
    expect((await resolve(digits)).json()).toMatchObject({ payIdType: 'ORGANISATION', payIdName: 'ORG', accountDetails: { accountNumber: b.accountNumber } })
    expect((await availability(digits)).json()).toMatchObject({ availability: false })
    expect((await availability(digits, 'INDIVIDUAL_AUSTRALIAN_BUSINESS')).json()).toMatchObject({ availability: true })
  })
})

describe('updatePayIdDetails', () => {
  it('updates ownerName and/or payIdName; omitted or null fields are unchanged; unchanged body does not bump lastUpdatedDateTimeUtc', async () => {
    const { payId } = await registered('EMAIL')
    const before = (await details(payId)).payIdDetails!
    await setClock({ advanceMs: 1000 })
    const res = await updateDetails(payId, { ownerName: 'Payton Holder' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'PayID details updated successfully.' })
    let d = await details(payId)
    expect(d.accountDetails!.ownerName).toBe('Payton Holder')
    expect(d.payIdDetails!.payIdName).toBe('Main')
    expect(d.payIdDetails!.lastUpdatedDateTimeUtc! > before.lastUpdatedDateTimeUtc!).toBe(true)
    const stamp = d.payIdDetails!.lastUpdatedDateTimeUtc

    await setClock({ advanceMs: 1000 })
    expect((await updateDetails(payId, { payIdName: 'Salary', ownerName: null })).statusCode).toBe(200)
    d = await details(payId)
    expect(d.accountDetails!.ownerName).toBe('Payton Holder')
    expect(d.payIdDetails!.payIdName).toBe('Salary')
    expect(d.payIdDetails!.lastUpdatedDateTimeUtc! > stamp!).toBe(true)

    await setClock({ advanceMs: 1000 })
    expect((await updateDetails(payId, { payIdName: 'Salary', ownerName: 'Payton Holder' })).statusCode).toBe(200)
    expect((await details(payId)).payIdDetails!.lastUpdatedDateTimeUtc).toBe(d.payIdDetails!.lastUpdatedDateTimeUtc)
    expect((await updateDetails(payId, {})).statusCode).toBe(200)
    await setClock({ reset: true })
  })

  it('allowed while DISABLED or PORTABLE, refused once DEREGISTERED (422 INVALID_STATE); unknown 404; empty string 400; missing payIdType 400', async () => {
    const { payId } = await registered('EMAIL')
    await mustSetStatus(payId, { payIdStatus: 'DISABLED' })
    expect((await updateDetails(payId, { payIdName: 'While disabled' })).statusCode).toBe(200)
    await mustSetStatus(payId, { payIdStatus: 'ACTIVE' })
    await mustSetStatus(payId, { payIdStatus: 'PORTABLE' })
    expect((await updateDetails(payId, { payIdName: 'While portable' })).statusCode).toBe(200)
    expectError(await updateDetails(payId, { ownerName: '' }), 400, /^BAD_REQUEST: ownerName/)
    expectError(await updateDetails(payId, { payIdName: ' ' }), 400, /^BAD_REQUEST: payIdName/)
    expectError(await app.inject({ method: 'POST', url: `/v0/payids/${payId}/details`, payload: { ownerName: 'x' } }), 400, /^BAD_REQUEST/)
    expect((await details(payId)).payIdDetails!.payIdName).toBe('While portable')
    await mustSetStatus(payId, { payIdStatus: 'DEREGISTERED' })
    expectError(await updateDetails(payId, { payIdName: 'Too late' }), 422, /^INVALID_STATE/)
    expectError(await updateDetails(value(), { payIdName: 'x' }), 404, /^NOT_FOUND: PayID/)
  })
})

describe('getPayIdDeregisterHistory', () => {
  it('is empty for a value never deregistered and lists every deregistration of the value across accounts and types, oldest first', async () => {
    const { account, payId } = await registered('EMAIL')
    expect(await history(payId)).toEqual([])
    expect(await history(value())).toEqual([])
    const reg1 = (await details(payId)).payIdDetails!.registrationDateTimeUtc
    await setClock({ advanceMs: 1000 })
    await mustSetStatus(payId, { payIdStatus: 'DEREGISTERED', reason: 'CUST' })
    const other = await newAccount()
    expect((await register(other.accountHayId!, payId, { payIdName: 'Second' })).statusCode).toBe(200)
    const reg2 = (await details(payId)).payIdDetails!.registrationDateTimeUtc
    await setClock({ advanceMs: 1000 })
    await mustSetStatus(payId, { payIdStatus: 'DISABLED' })
    await mustSetStatus(payId, { payIdStatus: 'DEREGISTERED', reason: 'FROD' })
    await setClock({ reset: true })
    const h = await history(payId)
    expect(h).toEqual([
      { payIdName: 'Main', reason: 'CUST', registrationDateTimeUtc: reg1, lastUpdatedDateTimeUtc: expect.stringMatching(ISO_MICROS) },
      { payIdName: 'Second', reason: 'FROD', registrationDateTimeUtc: reg2, lastUpdatedDateTimeUtc: expect.stringMatching(ISO_MICROS) },
    ])
    expect(h[0]!.lastUpdatedDateTimeUtc! < h[1]!.lastUpdatedDateTimeUtc!).toBe(true)
    expect(await history(payId.toUpperCase())).toHaveLength(2)
    // a deregistration without a reason has no reason field
    expect((await register(account.accountHayId!, payId)).statusCode).toBe(200)
    await mustSetStatus(payId, { payIdStatus: 'DEREGISTERED' })
    expect((await history(payId))[2]).not.toHaveProperty('reason')
  })
})

describe('porting (PORTABLE registrations)', () => {
  it('registering a PORTABLE value on another account ports it: old registration DEREGISTERED (PART) with history, new one ACTIVE', async () => {
    const { account, payId } = await registered('EMAIL')
    await mustSetStatus(payId, { payIdStatus: 'PORTABLE', reason: 'CUST' })
    const other = await newAccount()
    const res = await register(other.accountHayId!, payId, { ownerName: 'New Owner', payIdName: 'Ported' })
    expect(res.statusCode, res.body).toBe(200)
    expect((await details(payId)).accountDetails).toEqual({ accountNumber: other.accountNumber, branchNumber: '636220', ownerName: 'New Owner' })
    expect((await details(payId)).payIdDetails).toMatchObject({ status: 'ACTIVE', payIdName: 'Ported' })
    expect(await listForAccount(account.accountHayId!)).toEqual([expect.objectContaining({ payIdValue: payId, status: 'DEREGISTERED', reason: 'PART' })])
    expect(await history(payId)).toEqual([expect.objectContaining({ payIdName: 'Main', reason: 'PART' })])
    expect((await availability(payId)).json()).toMatchObject({ availability: false })
  })

  it('registering a PORTABLE value on the same account returns it to ACTIVE with the new names', async () => {
    const { account, payId } = await registered('EMAIL')
    await mustSetStatus(payId, { payIdStatus: 'PORTABLE', reason: 'CUST' })
    expect((await register(account.accountHayId!, payId, { payIdName: 'Kept', ownerName: 'Pay Holder' })).statusCode).toBe(200)
    const d = (await details(payId)).payIdDetails!
    expect(d).toMatchObject({ status: 'ACTIVE', payIdName: 'Kept' })
    expect(d).not.toHaveProperty('reason')
    expect(await listForAccount(account.accountHayId!)).toHaveLength(1)
    expect(await history(payId)).toEqual([])
  })
})

describe('NPP timers on the virtual clock', () => {
  afterAll(async () => { await setClock({ reset: true }) })

  it('PORTABLE reverts to ACTIVE after 14 days without a registration elsewhere', async () => {
    await setClock({ freeze: '2026-01-01T00:00:00.000Z' })
    const { payId } = await registered('EMAIL')
    await mustSetStatus(payId, { payIdStatus: 'PORTABLE', reason: 'CUST' })
    await setClock({ advanceMs: 13 * DAY_MS })
    expect(await status(payId)).toBe('PORTABLE')
    await setClock({ advanceMs: 1 * DAY_MS })
    const d = (await details(payId)).payIdDetails!
    expect(d).toMatchObject({ status: 'ACTIVE', lastUpdatedDateTimeUtc: '2026-01-15T00:00:00.000000Z' })
    expect(d).not.toHaveProperty('reason')
    // an explicit PORTABLE -> ACTIVE stops the timer; a second PORTABLE restarts it from its own date
    await mustSetStatus(payId, { payIdStatus: 'PORTABLE' })
    await setClock({ advanceMs: 5 * DAY_MS })
    await mustSetStatus(payId, { payIdStatus: 'ACTIVE' })
    await mustSetStatus(payId, { payIdStatus: 'PORTABLE' })
    await setClock({ advanceMs: 10 * DAY_MS })
    expect(await status(payId)).toBe('PORTABLE')
    await setClock({ advanceMs: 4 * DAY_MS })
    expect(await status(payId)).toBe('ACTIVE')
  })

  it('a DEREGISTERED record is purged after 90 days (history kept, list and getPayId forget it)', async () => {
    await setClock({ freeze: '2026-02-01T00:00:00.000Z' })
    const { account, payId } = await registered('EMAIL')
    await mustSetStatus(payId, { payIdStatus: 'DEREGISTERED', reason: 'CUST' })
    await setClock({ advanceMs: 89 * DAY_MS })
    expect(await status(payId)).toBe('DEREGISTERED')
    await setClock({ advanceMs: 1 * DAY_MS })
    expectError(await getPayId(payId), 404, /^NOT_FOUND/)
    expect(await listForAccount(account.accountHayId!)).toEqual([])
    expect(await history(payId)).toEqual([expect.objectContaining({ payIdName: 'Main', reason: 'CUST' })])
    expect((await availability(payId)).json()).toEqual({ availability: true })
    expect((await register(account.accountHayId!, payId)).statusCode).toBe(200)
  })

  it('an ACTIVE PayID with no activity for 10 years is DISABLED (reason PART); a resolution counts as activity', async () => {
    await setClock({ freeze: '2026-03-01T00:00:00.000Z' })
    const { payId: idle } = await registered('EMAIL')
    const { payId: used } = await registered('EMAIL')
    await setClock({ advanceMs: 9 * 365 * DAY_MS })
    expect((await resolve(used)).statusCode).toBe(200)
    await setClock({ advanceMs: 365 * DAY_MS })
    expect((await details(idle)).payIdDetails).toMatchObject({ status: 'DISABLED', reason: 'PART' })
    expect(await status(used)).toBe('ACTIVE')
    await mustSetStatus(idle, { payIdStatus: 'ACTIVE' })
    expect(await status(idle)).toBe('ACTIVE')
  })
})

describe('cross-domain', () => {
  it('updateCustomer name change propagates ownerName to the live PayIDs of the customer\'s accounts unless skipPayIdUpdate', async () => {
    const customer = await newCustomer({ firstName: 'Alice', lastName: 'Smith' })
    const a = await newAccount(customer)
    const b = await newAccount(customer)
    const p1 = (await registered('EMAIL', a)).payId
    const p2 = (await registered('TELEPHONE', b)).payId
    const p3 = (await registered('EMAIL', b)).payId
    await mustSetStatus(p3, { payIdStatus: 'DEREGISTERED' })
    const { payId: foreign } = await registered('EMAIL')

    const notifications = await notificationCount()
    let res = await app.inject({ method: 'PATCH', url: `/v0/customers/${customer}`, payload: { lastName: 'Jones', skipPayIdUpdate: true } })
    expect(res.statusCode, res.body).toBe(200)
    expect((await details(p1)).accountDetails!.ownerName).toBe('Pay Holder')

    res = await app.inject({ method: 'PATCH', url: `/v0/customers/${customer}`, payload: { firstName: 'Alicia' } })
    expect(res.statusCode, res.body).toBe(200)
    expect((await details(p1)).accountDetails!.ownerName).toBe('Alicia Jones')
    expect((await details(p2, 'TELEPHONE')).accountDetails!.ownerName).toBe('Alicia Jones')
    expect((await details(p3)).accountDetails!.ownerName).toBe('Pay Holder') // deregistered: untouched
    expect((await details(foreign)).accountDetails!.ownerName).toBe('Pay Holder')

    res = await app.inject({ method: 'PATCH', url: `/v0/customers/${customer}`, payload: { email: `renamed${n}@example.com` } })
    expect(res.statusCode, res.body).toBe(200)
    expect((await details(p1)).accountDetails!.ownerName).toBe('Alicia Jones')

    // the customer webhooks are unaffected and valid; no PayID notification exists
    await flush()
    const all = (await app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })).json() as { payload: any }[]
    const mine = all.map((r) => r.payload).filter((p) => p.customerHayId === customer && p.type === 'CUSTOMER_DETAILS_CHANGE')
    expect(mine).toHaveLength(3)
    for (const p of mine) assertValidNotification(p)
    expect(mine.map((p) => p.customerDetailsChangeEvent.customerNameChanged)).toEqual([true, true, false])
    expect(await notificationCount()).toBe(notifications + 3)
  })

  it('closing an account deregisters its PayIDs with reason CUST whatever the closure reason (00-status B.4 decision) and records history', async () => {
    const account = await newAccount()
    const p1 = (await registered('EMAIL', account)).payId
    const p2 = (await registered('TELEPHONE', account)).payId
    await mustSetStatus(p2, { payIdStatus: 'DISABLED', payIdType: 'TELEPHONE', reason: 'FROD' })
    const res = await app.inject({ method: 'POST', url: `/v0/accounts/${account.accountHayId}/close`, payload: { reason: 'DECEASED' } })
    expect(res.statusCode, res.body).toBe(202)
    await flush()
    expect((await listForAccount(account.accountHayId!)).map((p) => [p.status, p.reason])).toEqual([['DEREGISTERED', 'CUST'], ['DEREGISTERED', 'CUST']])
    expect(await history(p1)).toEqual([expect.objectContaining({ reason: 'CUST' })])
    expect((await availability(p1)).json()).toMatchObject({ availability: true })
    expectError(await resolve(p1), 422, /^INVALID_STATE/)

    const plain = await newAccount()
    const p3 = (await registered('EMAIL', plain)).payId
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${plain.accountHayId}/close`, payload: {} })).statusCode).toBe(202)
    await flush()
    expect((await listForAccount(plain.accountHayId!))[0]).toMatchObject({ payIdValue: p3, status: 'DEREGISTERED', reason: 'CUST' })
  })

  it('PAY_ID transfers resolve through services.payid: internal transfer to a local PayID, REFUSED_INVALID_PAY_ID once DISABLED or DEREGISTERED', async () => {
    const senderCustomer = await newCustomer()
    const sender = await newAccount(senderCustomer, { risk: 'LOW' })
    const credit = await app.inject({ method: 'POST', url: '/v1/transactions/credit', payload: { idempotencyKey: randomUUID(), accountHayId: sender.accountHayId, amount: 100, counterpartName: 'Payroll', description: 'Pay', transactionChannel: 'MANUAL_ADJUSTMENT' } })
    expect(credit.json(), credit.body).toMatchObject({ outcome: 'ACCEPTED' })
    const { account: recipient, payId } = await registered('EMAIL', await newAccount(undefined, { risk: 'LOW' }))
    const transfer = (target: string) => app.inject({ method: 'POST', url: `/v1/accounts/${sender.accountHayId}/transfer`, payload: { idempotencyKey: randomUUID(), senderCustomerHayId: senderCustomer, amount: 25, description: 'Rent', transferType: 'PAY_ID', payIdTransfer: { payId: target, recipientName: 'Pay Holder' } } })

    const ok = await transfer(payId)
    expect(ok.json(), ok.body).toMatchObject({ outcome: 'ACCEPTED' })
    const t = (await app.inject({ method: 'GET', url: `/v1/transactions/${ok.json().transactionId}` })).json()
    expect(t).toMatchObject({ type: 'INTRABANK_TRANSFER_OUT', counterpartDetails: { accountId: recipient.accountHayId } })
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${recipient.accountHayId}` })).json().totalBalance).toBe(25)
    expect((await details(payId)).payIdDetails!.lastResolutionDateTimeUtc).toMatch(ISO_MICROS)

    expect((await transfer(value())).json()).toEqual({ outcome: 'REFUSED_INVALID_PAY_ID' })
    await mustSetStatus(payId, { payIdStatus: 'DISABLED' })
    expect((await transfer(payId)).json()).toEqual({ outcome: 'REFUSED_INVALID_PAY_ID' })
    await mustSetStatus(payId, { payIdStatus: 'ACTIVE' })
    await mustSetStatus(payId, { payIdStatus: 'PORTABLE' })
    expect((await transfer(payId)).json()).toMatchObject({ outcome: 'ACCEPTED' })
    await mustSetStatus(payId, { payIdStatus: 'DEREGISTERED' })
    expect((await transfer(payId)).json()).toEqual({ outcome: 'REFUSED_INVALID_PAY_ID' })
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${sender.accountHayId}` })).json().totalBalance).toBe(50)
  })
})

describe('verifyBranchIdentifier', () => {
  it('every well-formed BSB is NPP-enabled except 999999', async () => {
    for (const bsb of ['636220', '062000', '636383', '000000', '123456']) {
      const res = await app.inject({ method: 'GET', url: `/v1/npp/eligibility/branch-identifiers/${bsb}` })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({ enabled: true })
    }
    const res = await app.inject({ method: 'GET', url: '/v1/npp/eligibility/branch-identifiers/999999' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: false })
  })

  it('a malformed branchIdentifier is the documented 422 with its exact message', async () => {
    for (const bad of ['12345', '1234567', 'abcdef', '63622O', '636-22']) {
      const res = await app.inject({ method: 'GET', url: `/v1/npp/eligibility/branch-identifiers/${encodeURIComponent(bad)}` })
      expect(res.statusCode, `${bad}: ${res.body}`).toBe(422)
      expect(res.json()).toEqual({ message: BRANCH_IDENTIFIER_FORMAT_MESSAGE, details: 'Please refer to the API documentation or contact Shaype for more info with the traceId.', status: '422', traceId: expect.stringMatching(UUID_RE) })
      expect(res.json().message).toBe('branchIdentifier format is not correct.')
    }
  })
})
