import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { components } from '../src/contract/generated/b2b-types.js'
import { startApp } from './helpers.js'
import { assertValidNotification } from './webhook-schema.js'
import type { BuiltServer } from '../src/server.js'
import { LIMIT_TYPES, LOCAL_PRODUCT, LOCAL_PRODUCT_ID, type AccountsService } from '../src/domains/accounts/index.js'
import { FX_CURRENCIES } from '../src/domains/accounts/products.js'

type S = components['schemas']
type HayAccount = S['HayAccount']
type CreateBody = S['CreateAccountRequestBody']

const ACCOUNT_OPS = [
  'createAccount', 'getHayAccount', 'searchAccounts', 'blockAccount', 'unblockAccount', 'closeAccount', 'updateCopOptOut',
  'updateMaxBalanceLimit', 'updateOverdraftLimit', 'getAccountRiskLevel', 'changeAccountRiskLevel', 'getCardsForAccountId',
  'getAccountLimits', 'setAccountLimit', 'deleteAccountLimit', 'getAccountRules', 'addAccountRule', 'getAccountRuleById', 'disableRule',
  'createAccountCustomData', 'deleteAccountCustomData', 'getAllProducts', 'getAllMerchantCategoryCodes',
]
const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111'
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const UUID_RE = /^[0-9a-f-]{36}$/

let built: BuiltServer
let app: BuiltServer['app']
let svc: AccountsService
beforeAll(async () => { built = await startApp(); app = built.app; svc = built.ctx.services.accounts })
afterAll(async () => { await built.app.close() })

const services = () => built.ctx.services as unknown as Record<string, unknown>

let n = 0
async function flush(): Promise<void> {
  await app.inject({ method: 'POST', url: '/_admin/flush' })
}
async function newCustomer(): Promise<string> {
  n++
  const res = await app.inject({
    method: 'POST', url: '/v0/customers/create',
    payload: {
      idempotencyKey: randomUUID(), email: `acct${n}@example.com`, customerTier: 'STANDARD',
      phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: `5${String(n).padStart(8, '0')}` },
      address: { line1: '1 Test St', townOrCity: 'Sydney', administrativeRegion: 'NSW', postcode: '2000', countryCodeIso: 'AUS' },
      customerDetails: { firstName: 'Acc', lastName: `Holder${n}`, dateOfBirth: '1990-01-01' },
    },
  })
  expect(res.statusCode, res.body).toBe(200)
  await flush()
  return res.json().customerHayId as string
}
function createBody(holderId: string, overrides: Partial<CreateBody> = {}): CreateBody {
  return { idempotencyKey: randomUUID(), accountHolderId: holderId, accountHolderType: 'CUSTOMER', productId: LOCAL_PRODUCT_ID, ...overrides }
}
async function newAccount(holderId?: string, overrides: Partial<CreateBody> = {}): Promise<HayAccount> {
  const res = await app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(holderId ?? (await newCustomer()), overrides) })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as HayAccount
}
/** An account with risk level LOW (limits open) so money can move. */
async function newLowRiskAccount(holderId?: string): Promise<HayAccount> {
  const a = await newAccount(holderId)
  const r = await app.inject({ method: 'PATCH', url: `/v0/accounts/${a.accountHayId}/riskLevel`, payload: { level: 'LOW', reason: 'test' } })
  expect(r.statusCode, r.body).toBe(200)
  return a
}
async function getAccount(id: string, expand?: string): Promise<HayAccount> {
  const res = await app.inject({ method: 'GET', url: `/v0/accounts/${id}${expand ? `?expand=${expand}` : ''}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as HayAccount
}
async function customerStatus(id: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: `/v0/customers/${id}` })
  return res.json().status as string
}
async function allPayloads(): Promise<any[]> {
  await flush()
  const res = await app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })
  return (res.json() as { payload: any }[]).map((r) => r.payload)
}
async function accountEvents(accountId: string): Promise<any[]> {
  return (await allPayloads()).filter((p) => p.type === 'ACCOUNT_STATUS_CHANGE' && p.accountStatusChangeEvent?.accountHayId === accountId)
}
async function customerEvents(customerId: string, type: string): Promise<any[]> {
  return (await allPayloads()).filter((p) => p.type === type && p.customerHayId === customerId)
}
function expectError(res: { statusCode: number; json: () => any }, status: number, code: RegExp | string): void {
  expect(res.statusCode).toBe(status)
  const body = res.json()
  expect(body).toMatchObject({ status: String(status), details: expect.stringContaining('traceId') })
  expect(body.traceId).toMatch(UUID_RE)
  expect(body.message).toMatch(code)
}

describe('accounts domain: registration', () => {
  it('handles every Accounts API operation in scope plus getAllProducts (none left on the stub)', async () => {
    const res = await app.inject({ method: 'GET', url: '/_admin/operations' })
    const { handled, stubbed } = res.json() as { handled: string[]; stubbed: string[] }
    for (const op of ACCOUNT_OPS) {
      expect(handled, op).toContain(op)
      expect(stubbed, op).not.toContain(op)
    }
  })
})

describe('getAllProducts', () => {
  it('lists the seeded local product', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/products' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([{ id: LOCAL_PRODUCT_ID, name: 'Local Everyday Account', description: expect.any(String), countryIsoCode: 'AUS' }])
  })
})

describe('getAllMerchantCategoryCodes (GET /v0/mccs)', () => {
  it('lists seeded ISO 18245 reference data: unique four-digit codes in ascending order, each with a description, usable in MERCHANT_CODE_BLOCK rules', async () => {
    const res = await app.inject({ method: 'GET', url: '/v0/mccs' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-shaype-local-stub']).toBeUndefined()
    const mccs = res.json() as { code: number; description: string }[]
    expect(mccs.length).toBeGreaterThan(50)
    for (const m of mccs) {
      expect(Number.isInteger(m.code) && m.code >= 1000 && m.code <= 9999, String(m.code)).toBe(true)
      expect(m.description.length).toBeGreaterThan(3)
    }
    expect(mccs.map((m) => m.code)).toEqual([...new Set(mccs.map((m) => m.code))].sort((a, b) => a - b))
    expect(mccs).toContainEqual({ code: 5411, description: 'Grocery Stores, Supermarkets' })
    expect(mccs).toContainEqual({ code: 5812, description: 'Eating Places, Restaurants' })
  })
})

describe('createAccount (POST /v1/accounts)', () => {
  it('creates an APPROVED AUD account shaped like the docs sample and emits ACCOUNT_STATUS_CHANGE {APPROVED} (PLATFORM)', async () => {
    const holder = await newCustomer()
    const a = await newAccount(holder)
    expect(a.accountHayId).toMatch(UUID_RE)
    expect(a).toMatchObject({
      accountHolderId: holder, accountHolderType: 'CUSTOMER', productId: LOCAL_PRODUCT_ID, bsb: '636220', currency: 'AUD', status: 'APPROVED',
      totalBalance: 0, heldBalance: 0, availableBalance: 0, lockedBalance: 0, stacksBalance: 0, technicalOverdraftBalance: 0, overdraftBalance: 0, overdraftLimit: 0,
    })
    expect(a.accountNumber).toMatch(/^[1-9][0-9]{7}$/)
    expect(a.creationDateTimeUtc).toMatch(ISO_MICROS)
    for (const absent of ['customData', 'blockedBy', 'parentAccountId', 'closedDateTimeUtc']) expect(a, absent).not.toHaveProperty(absent)
    // home-currency equivalent is the identity on an AUD account (00-balance §1.3)
    expect(a.homeCurrencyBalanceEquivalent).toEqual({ currency: 'AUD', totalBalance: 0, availableBalance: 0, heldBalance: 0 })
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${a.accountHayId}/riskLevel` })).json()).toEqual({ accountId: a.accountHayId, riskLevel: 'HIGH' })

    const events = await accountEvents(a.accountHayId!)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      customerHayId: holder, idempotencyKey: expect.stringMatching(UUID_RE), type: 'ACCOUNT_STATUS_CHANGE', actionOwner: 'PLATFORM', productId: LOCAL_PRODUCT_ID,
      accountStatusChangeEvent: { accountHayId: a.accountHayId, accountStatus: 'APPROVED' },
    })
    assertValidNotification(events[0])
  })

  it('assigns sequential unique 8-digit account numbers and honours a client-supplied one (422 DUPLICATE_ACCOUNT_NUMBER on reuse)', async () => {
    const holder = await newCustomer()
    const a = await newAccount(holder)
    const b = await newAccount(holder)
    expect(Number(b.accountNumber)).toBe(Number(a.accountNumber) + 1)
    const chosen = `9${String(n).padStart(7, '0')}`
    const c = await newAccount(holder, { accountNumber: chosen })
    expect(c.accountNumber).toBe(chosen)
    expectError(await app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(holder, { accountNumber: chosen }) }), 422, /^DUPLICATE_ACCOUNT_NUMBER: /)
    expectError(await app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(holder, { accountNumber: '0123' }) }), 400, /^BAD_REQUEST/)
  })

  it('replays the same idempotencyKey with an identical body and refuses a different body', async () => {
    const holder = await newCustomer()
    const body = createBody(holder)
    const first = await app.inject({ method: 'POST', url: '/v1/accounts', payload: body })
    const again = await app.inject({ method: 'POST', url: '/v1/accounts', payload: body })
    expect(first.statusCode).toBe(200)
    expect(again.json()).toEqual(first.json())
    expect(svc.listForHolder(holder)).toHaveLength(1)
    expectError(await app.inject({ method: 'POST', url: '/v1/accounts', payload: { ...body, accountNumber: '87654321' } }), 422, /^IDEMPOTENCY_KEY_REUSED/)
  })

  it('422 PRODUCT_NOT_FOUND for an unknown product; 404 for an unknown holder; 422 PERMISSION_DENIED when the customer is not ACTIVE', async () => {
    const holder = await newCustomer()
    expectError(await app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(holder, { productId: UNKNOWN_ID }) }), 422, /^PRODUCT_NOT_FOUND: /)
    expectError(await app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(UNKNOWN_ID) }), 404, /^NOT_FOUND: Customer/)
    await app.inject({ method: 'POST', url: `/v0/customers/${holder}/block`, payload: { note: 'x' } })
    const res = await app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(holder) })
    expectError(res, 422, `PERMISSION_DENIED: Account cannot be created for customer with id ${holder} as their status is currently BLOCKED`)
    expect(svc.listForHolder(holder)).toHaveLength(0)
  })

  it('stores customData but only returns it through getHayAccount?expand=customData', async () => {
    const a = await newAccount(undefined, { customData: { key: 'value', nested: { n: 1 } } as any })
    expect(a).not.toHaveProperty('customData')
    expect(await getAccount(a.accountHayId!)).not.toHaveProperty('customData')
    expect((await getAccount(a.accountHayId!, 'customData')).customData).toEqual({ key: 'value', nested: { n: 1 } })
    const plain = await newAccount()
    expect((await getAccount(plain.accountHayId!, 'customData')).customData).toBeNull()
  })

  it('non-AUD accounts need a parent of the same holder; one child per currency; children list under the holder', async () => {
    const holder = await newCustomer()
    expectError(await app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(holder, { currency: 'USD' }) }), 422, /^INVALID_ARGUMENT: parentAccountId is mandatory/)
    const parent = await newAccount(holder)
    const child = await newAccount(holder, { currency: 'USD', parentAccountId: parent.accountHayId })
    expect(child).toMatchObject({ currency: 'USD', parentAccountId: parent.accountHayId, accountHolderId: holder, status: 'APPROVED' })
    expect(child).not.toHaveProperty('homeCurrencyBalanceEquivalent') // no FX rates locally
    expectError(await app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(holder, { currency: 'USD', parentAccountId: parent.accountHayId }) }), 422, /^DUPLICATE_CHILD_CURRENCY/)
    expectError(await app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(holder, { currency: 'AUD', parentAccountId: parent.accountHayId }) }), 422, /home currency/)
    expectError(await app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(holder, { currency: 'EUR', parentAccountId: child.accountHayId }) }), 422, /itself a child/)
    const other = await newCustomer()
    expectError(await app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(other, { currency: 'EUR', parentAccountId: parent.accountHayId }) }), 422, /different account holder/)
    expectError(await app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(holder, { currency: 'EUR', parentAccountId: UNKNOWN_ID }) }), 404, /^NOT_FOUND: Account/)
    const list = await app.inject({ method: 'GET', url: `/v0/customers/${holder}/accounts` })
    expect(list.json().map((x: HayAccount) => x.accountHayId)).toEqual([parent.accountHayId, child.accountHayId])
  })

  it('validates fx.childAccounts with the documented INVALID_ARGUMENT messages and provisions CUSTOM children asynchronously (home currency skipped)', async () => {
    const holder = await newCustomer()
    const post = (fx: any) => app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(holder, { fx }) })
    expectError(await post({ childAccounts: { initMode: 'CUSTOM' } }), 422, 'INVALID_ARGUMENT: fx.childAccounts.currencies is mandatory when initMode is CUSTOM')
    expectError(await post({ childAccounts: { initMode: 'ALL', currencies: ['USD'] } }), 422, 'INVALID_ARGUMENT: fx.childAccounts.currencies must not be provided when initMode is ALL')
    expectError(await post({ childAccounts: { initMode: 'NONE', currencies: ['USD'] } }), 422, 'INVALID_ARGUMENT: fx.childAccounts.currencies must not be provided when initMode is NONE')
    expect((await post({ childAccounts: { initMode: 'CUSTOM', currencies: [] } })).statusCode).toBe(400)
    expect((await post({ childAccounts: {} })).statusCode).toBe(400)
    const parent = (await post({ childAccounts: { initMode: 'CUSTOM', currencies: ['USD', 'GBP', 'AUD', 'USD'] }, compliance: { countryOfCitizenship: 'AUS', customerRisk: 'LOW' } })).json() as HayAccount
    expect(parent.status).toBe('APPROVED')
    await flush()
    const children = svc.children(parent.accountHayId!)
    expect(children.map((c) => c.currency).sort()).toEqual(['GBP', 'USD'])
    expect(children.every((c) => c.parentAccountId === parent.accountHayId && c.holderId === holder)).toBe(true)
    const none = await newAccount(holder, { fx: { childAccounts: { initMode: 'NONE' } } })
    await flush()
    expect(svc.children(none.accountHayId!)).toHaveLength(0)
  })

  it('fx.childAccounts initMode ALL provisions one APPROVED child per FX currency (30 for an AUD wallet)', async () => {
    const holder = await newCustomer()
    const parent = await newAccount(holder, { fx: { childAccounts: { initMode: 'ALL' } } })
    await flush()
    const children = svc.children(parent.accountHayId!)
    expect(children).toHaveLength(30)
    expect(children.map((c) => c.currency).sort()).toEqual([...FX_CURRENCIES].sort())
    expect(children.every((c) => c.status === 'APPROVED' && c.parentAccountId === parent.accountHayId && c.holderId === holder)).toBe(true)
    expect(new Set(children.map((c) => c.accountNumber)).size).toBe(30)
    expect((await app.inject({ method: 'GET', url: `/v0/customers/${holder}/accounts` })).json()).toHaveLength(31)
  })

  it('refuses a child account under a LOCKED parent (422 ACCOUNT_BLOCKED) so a blocked wallet cannot be partly reopened', async () => {
    const holder = await newCustomer()
    const parent = await newAccount(holder)
    await app.inject({ method: 'POST', url: `/v0/accounts/${parent.accountHayId}/block`, payload: { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' } })
    const body = createBody(holder, { currency: 'USD', parentAccountId: parent.accountHayId })
    expectError(await app.inject({ method: 'POST', url: '/v1/accounts', payload: body }), 422, `ACCOUNT_BLOCKED: parent account ${parent.accountHayId} is LOCKED`)
    expect(svc.children(parent.accountHayId!)).toHaveLength(0)
    await app.inject({ method: 'POST', url: `/v0/accounts/${parent.accountHayId}/unblock`, payload: { note: 'x' } })
    expect((await app.inject({ method: 'POST', url: '/v1/accounts', payload: { ...body, idempotencyKey: randomUUID() } })).statusCode).toBe(200)
  })

  it('GROUP holders: 404 while the groups domain is not loaded; otherwise requireAllMembersActive gates creation and every member is notified', async () => {
    const groupId = randomUUID()
    expectError(await app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(groupId, { accountHolderType: 'GROUP' }) }), 404, /^NOT_FOUND: Group/)
    const m1 = await newCustomer()
    const m2 = await newCustomer()
    const requireAllMembersActive = vi.fn((id: string) => { if (id !== groupId) throw Object.assign(new Error('x'), { status: 404 }) })
    services().groups = { requireAllMembersActive, memberIds: (id: string) => (id === groupId ? [m1, m2] : []), groupIdsForCustomer: () => [] }
    try {
      const res = await app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(groupId, { accountHolderType: 'GROUP' }) })
      expect(res.statusCode, res.body).toBe(200)
      const a = res.json() as HayAccount
      expect(a).toMatchObject({ accountHolderType: 'GROUP', accountHolderId: groupId })
      expect(requireAllMembersActive).toHaveBeenCalledWith(groupId)
      const events = await accountEvents(a.accountHayId!)
      expect(events.map((e) => e.customerHayId).sort()).toEqual([m1, m2].sort())
      expect(svc.listForHolder(groupId).map((x) => x.accountHayId)).toEqual([a.accountHayId])
    } finally {
      delete services().groups
    }
  })

  it('uses config.defaultRiskLevel for new accounts', async () => {
    const other = await startApp({ defaultRiskLevel: 'LOW' })
    try {
      const c = await other.app.inject({
        method: 'POST', url: '/v0/customers/create',
        payload: {
          idempotencyKey: randomUUID(), email: 'low@example.com', customerTier: 'STANDARD',
          phoneNumber: { countryCodePrefix: '61', numberAfterPrefix: '400000000' },
          address: { line1: '1', townOrCity: 'S', administrativeRegion: 'NSW', postcode: '2000', countryCodeIso: 'AUS' },
          customerDetails: { firstName: 'Low', lastName: 'Risk', dateOfBirth: '1990-01-01' },
        },
      })
      await other.app.inject({ method: 'POST', url: '/_admin/flush' })
      const a = await other.app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(c.json().customerHayId) })
      expect(a.statusCode, a.body).toBe(200)
      expect(other.ctx.services.accounts.riskLevel(a.json().accountHayId)).toBe('LOW')
    } finally {
      await other.app.close()
    }
  })
})

describe('createHayAccount (deprecated v0, served by the customers domain through ctx.services.accounts)', () => {
  it('creates a personal account on the default product and lists it under the customer', async () => {
    const holder = await newCustomer()
    const res = await app.inject({ method: 'POST', url: `/v0/customers/${holder}/account`, payload: { idempotencyKey: randomUUID(), customData: { via: 'v0' } } })
    expect(res.statusCode, res.body).toBe(200)
    const a = res.json() as HayAccount
    expect(a).toMatchObject({ accountHolderId: holder, accountHolderType: 'CUSTOMER', productId: LOCAL_PRODUCT_ID, currency: 'AUD', status: 'APPROVED', bsb: '636220' })
    expect((await getAccount(a.accountHayId!, 'customData')).customData).toEqual({ via: 'v0' })
    const list = await app.inject({ method: 'GET', url: `/v0/customers/${holder}/accounts` })
    expect(list.json()).toEqual([await getAccount(a.accountHayId!)])
    expect((await accountEvents(a.accountHayId!))[0]).toMatchObject({ actionOwner: 'PLATFORM', accountStatusChangeEvent: { accountStatus: 'APPROVED' } })
  })
})

describe('getHayAccount / searchAccounts', () => {
  it('404 NOT_FOUND for an unknown account, 400 for a malformed id', async () => {
    expectError(await app.inject({ method: 'GET', url: `/v0/accounts/${UNKNOWN_ID}` }), 404, `NOT_FOUND: Account ${UNKNOWN_ID} not found`)
    expect((await app.inject({ method: 'GET', url: '/v0/accounts/nope' })).statusCode).toBe(400)
  })

  it('searches by exact account number (every status), empty array when nothing matches', async () => {
    const a = await newAccount()
    const hit = await app.inject({ method: 'POST', url: '/v1/accounts/search', payload: { accountNumber: a.accountNumber } })
    expect(hit.statusCode).toBe(200)
    expect(hit.json()).toEqual([await getAccount(a.accountHayId!)])
    expect((await app.inject({ method: 'POST', url: '/v1/accounts/search', payload: { accountNumber: '55555' } })).json()).toEqual([])
    expect((await app.inject({ method: 'POST', url: '/v1/accounts/search', payload: { accountNumber: 'abc' } })).statusCode).toBe(400)
  })

  it('search still returns an account once it is CLOSED', async () => {
    const a = await newAccount()
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${a.accountHayId}/close` })).statusCode).toBe(202)
    await flush()
    const hit = await app.inject({ method: 'POST', url: '/v1/accounts/search', payload: { accountNumber: a.accountNumber } })
    expect(hit.statusCode).toBe(200)
    expect(hit.json()).toEqual([expect.objectContaining({ accountHayId: a.accountHayId, status: 'CLOSED', closedDateTimeUtc: expect.stringMatching(ISO_MICROS) })])
  })
})

describe('custom data', () => {
  it('createAccountCustomData replaces the whole object and deleteAccountCustomData clears it', async () => {
    const a = await newAccount(undefined, { customData: { a: 1 } as any })
    const id = a.accountHayId!
    const set = await app.inject({ method: 'POST', url: `/v1/accounts/${id}/custom-data`, payload: { customData: { b: 2 } } })
    expect(set.statusCode).toBe(200)
    expect(set.json()).toEqual({ message: expect.any(String) })
    expect((await getAccount(id, 'customData')).customData).toEqual({ b: 2 })
    const del = await app.inject({ method: 'DELETE', url: `/v1/accounts/${id}/custom-data` })
    expect(del.statusCode).toBe(200)
    expect((await getAccount(id, 'customData')).customData).toBeNull()
    expect((await app.inject({ method: 'DELETE', url: `/v1/accounts/${id}/custom-data` })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/v1/accounts/${id}/custom-data`, payload: {} })).statusCode).toBe(400)
    expectError(await app.inject({ method: 'POST', url: `/v1/accounts/${UNKNOWN_ID}/custom-data`, payload: { customData: {} } }), 404, /^NOT_FOUND/)
  })
})

describe('risk level and CoP opt-out', () => {
  it('changeAccountRiskLevel toggles HIGH <-> LOW with the documented message and validates the body', async () => {
    const a = await newAccount()
    const id = a.accountHayId!
    const res = await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/riskLevel`, payload: { level: 'LOW', reason: 'KYC complete' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ message: 'Risk level changed successfully.' })
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${id}/riskLevel` })).json()).toEqual({ accountId: id, riskLevel: 'LOW' })
    expect((await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/riskLevel`, payload: { level: 'LOW', reason: 'again' } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/riskLevel`, payload: { level: 'HIGH', reason: 'x' } })).statusCode).toBe(200)
    expect(svc.riskLevel(id)).toBe('HIGH')
    expect((await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/riskLevel`, payload: { level: 'LOW' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/riskLevel`, payload: { level: 'MEDIUM', reason: 'x' } })).statusCode).toBe(400)
    expectError(await app.inject({ method: 'GET', url: `/v0/accounts/${UNKNOWN_ID}/riskLevel` }), 404, /^NOT_FOUND/)
    expect((await accountEvents(id)).map((e) => e.accountStatusChangeEvent.accountStatus)).toEqual(['APPROVED']) // no webhook for risk level
  })

  it('updateCopOptOut stores the flag without exposing it on HayAccount', async () => {
    const a = await newAccount()
    const id = a.accountHayId!
    const res = await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/cop-opt-out`, payload: { optOut: true } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ message: expect.any(String) })
    expect(svc.get(id).copOptOut).toBe(true)
    expect(await getAccount(id)).not.toHaveProperty('optOut')
    await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/cop-opt-out`, payload: { optOut: false } })
    expect(svc.get(id).copOptOut).toBe(false)
    expect((await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/cop-opt-out`, payload: {} })).statusCode).toBe(400)
  })
})

describe('limits', () => {
  it('getAccountLimits lists the 16 spec types in order with product limits; effective limit is 0 while risk HIGH and the product limit once LOW', async () => {
    const a = await newAccount()
    const id = a.accountHayId!
    const high = (await app.inject({ method: 'GET', url: `/v1/accounts/${id}/limits` })).json() as S['ExternalLimitAmounts'][]
    expect(high.map((l) => l.type)).toEqual([...LIMIT_TYPES])
    for (const l of high) {
      expect(l, l.type!).toEqual({ type: l.type, productLimit: LOCAL_PRODUCT.limits[l.type!] / 100, effectiveLimit: 0 })
    }
    expect(high.find((l) => l.type === 'MAX_BALANCE')!.productLimit).toBe(1_000_000)
    expect(high.find((l) => l.type === 'SINGLE_CARD_TRANSACTION')!.productLimit).toBe(20_000)
    await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/riskLevel`, payload: { level: 'LOW', reason: 'x' } })
    const low = (await app.inject({ method: 'GET', url: `/v1/accounts/${id}/limits` })).json() as S['ExternalLimitAmounts'][]
    for (const l of low) expect(l.effectiveLimit, l.type!).toBe(l.productLimit)
    expectError(await app.inject({ method: 'GET', url: `/v1/accounts/${UNKNOWN_ID}/limits` }), 404, /^NOT_FOUND/)
  })

  it('setAccountLimit overrides a settable type (capped by the product), deleteAccountLimit restores the product limit', async () => {
    const a = await newLowRiskAccount()
    const id = a.accountHayId!
    const set = await app.inject({ method: 'PUT', url: `/v1/accounts/${id}/limits/CARD_PAYMENTS_DAILY`, payload: { limitAmount: 1234.56 } })
    expect(set.statusCode, set.body).toBe(200)
    expect(set.json()).toEqual({ accountId: id, limitType: 'CARD_PAYMENTS_DAILY', limitAmount: 1234.56 })
    const row = () => app.inject({ method: 'GET', url: `/v1/accounts/${id}/limits` }).then((r) => (r.json() as S['ExternalLimitAmounts'][]).find((l) => l.type === 'CARD_PAYMENTS_DAILY')!)
    expect(await row()).toEqual({ type: 'CARD_PAYMENTS_DAILY', productLimit: 50_000, accountLimit: 1234.56, effectiveLimit: 1234.56 })
    expectError(await app.inject({ method: 'PUT', url: `/v1/accounts/${id}/limits/CARD_PAYMENTS_DAILY`, payload: { limitAmount: 50_000.01 } }), 422, /^LIMIT_EXCEEDS_PRODUCT_LIMIT: /)
    expect((await app.inject({ method: 'PUT', url: `/v1/accounts/${id}/limits/CARD_PAYMENTS_DAILY`, payload: { limitAmount: 0 } })).statusCode).toBe(400)
    expectError(await app.inject({ method: 'PUT', url: `/v1/accounts/${id}/limits/CARD_PAYMENTS_DAILY`, payload: { limitAmount: 12.345 } }), 400, 'BAD_REQUEST: limitAmount must have at most 2 decimal places')
    expect(await row()).toMatchObject({ accountLimit: 1234.56 }) // not rounded and stored
    expect((await app.inject({ method: 'PUT', url: `/v1/accounts/${id}/limits/MIN_BALANCE`, payload: { limitAmount: 5 } })).statusCode).toBe(400) // not in the settable enum
    // the override survives a HIGH/LOW round trip (effective reads 0 while HIGH)
    await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/riskLevel`, payload: { level: 'HIGH', reason: 'x' } })
    expect(await row()).toMatchObject({ accountLimit: 1234.56, effectiveLimit: 0 })
    await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/riskLevel`, payload: { level: 'LOW', reason: 'x' } })
    const del = await app.inject({ method: 'DELETE', url: `/v1/accounts/${id}/limits/CARD_PAYMENTS_DAILY` })
    expect(del.json()).toEqual({ success: true })
    expect(await row()).toEqual({ type: 'CARD_PAYMENTS_DAILY', productLimit: 50_000, effectiveLimit: 50_000 })
    expect((await app.inject({ method: 'DELETE', url: `/v1/accounts/${id}/limits/CARD_PAYMENTS_DAILY` })).json()).toEqual({ success: true })
    expect((await app.inject({ method: 'DELETE', url: `/v1/accounts/${id}/limits/MIN_BALANCE` })).json()).toEqual({ success: false })
    expect((await app.inject({ method: 'DELETE', url: `/v1/accounts/${id}/limits/NOPE` })).statusCode).toBe(400)
    expectError(await app.inject({ method: 'PUT', url: `/v1/accounts/${UNKNOWN_ID}/limits/MAX_BALANCE`, payload: { limitAmount: 1 } }), 404, /^NOT_FOUND/)
  })

  it('updateMaxBalanceLimit writes the same MAX_BALANCE slot as setAccountLimit', async () => {
    const a = await newLowRiskAccount()
    const id = a.accountHayId!
    const res = await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/max-balance`, payload: { maxBalanceLimit: 500 } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ message: expect.any(String) })
    const limits = (await app.inject({ method: 'GET', url: `/v1/accounts/${id}/limits` })).json() as S['ExternalLimitAmounts'][]
    expect(limits.find((l) => l.type === 'MAX_BALANCE')).toEqual({ type: 'MAX_BALANCE', productLimit: 1_000_000, accountLimit: 500, effectiveLimit: 500 })
    expectError(await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/max-balance`, payload: { maxBalanceLimit: 1_000_000.5 } }), 422, /^LIMIT_EXCEEDS_PRODUCT_LIMIT/)
    expect((await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/max-balance`, payload: { maxBalanceLimit: 0 } })).statusCode).toBe(400)
    expectError(await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/max-balance`, payload: { maxBalanceLimit: 1.005 } }), 400, 'BAD_REQUEST: maxBalanceLimit must have at most 2 decimal places')
    expect(svc.checkLimit(id, 'MAX_BALANCE', 50_001)).toBe('REFUSED_MAX_BALANCE_EXCEEDED')
    expect(svc.checkLimit(id, 'MAX_BALANCE', 50_000)).toBeNull()
  })

  it('checkLimit: per-transaction, balance, rolling daily / yearly windows through the registered usage provider, everything 0 while risk HIGH', async () => {
    const a = await newLowRiskAccount()
    const id = a.accountHayId!
    expect(svc.checkLimit(id, 'SINGLE_CARD_TRANSACTION', 2_000_000)).toBeNull()
    expect(svc.checkLimit(id, 'SINGLE_CARD_TRANSACTION', 2_000_001)).toBe('REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED')
    expect(svc.checkLimit(id, 'PAYMENT_TO_ACCOUNT_NUMBER', 5_000_001)).toBe('REFUSED_LIMIT_BREACH')
    expect(svc.checkLimit(id, 'CARD_TOP_UP_PER_DAY', 1)).toBeNull() // not currently used
    expect(svc.checkLimit(id, 'MIN_BALANCE', 1)).toBeNull() // floor: the funds check owns it

    const usage = vi.fn((_id: string, type: string) => (type === 'ATM_WITHDRAWAL_PER_DAY' ? 400_000 : type === 'TOTAL_SPEND_PER_YEAR' ? 999_999_999 : 0))
    svc.setUsageProvider(usage)
    try {
      await app.inject({ method: 'POST', url: '/_admin/clock', payload: { freeze: '2026-03-01T12:00:00.000Z' } })
      expect(svc.checkLimit(id, 'ATM_WITHDRAWAL_PER_DAY', 100_000)).toBeNull()
      expect(svc.checkLimit(id, 'ATM_WITHDRAWAL_PER_DAY', 100_001)).toBe('REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED')
      expect(usage).toHaveBeenLastCalledWith(id, 'ATM_WITHDRAWAL_PER_DAY', '2026-02-28T12:00:00.000000Z')
      expect(svc.checkLimit(id, 'TOTAL_SPEND_PER_YEAR', 1)).toBeNull()
      expect(svc.checkLimit(id, 'TOTAL_SPEND_PER_YEAR', 2)).toBe('REFUSED_ANNUAL_SPENDING_LIMIT_BREACHED')
      expect(usage).toHaveBeenLastCalledWith(id, 'TOTAL_SPEND_PER_YEAR', '2025-03-01T12:00:00.000000Z')
      expect(svc.checkLimit(id, 'TRANSFERS_OUT_PER_DAY', 10_000_000)).toBeNull()
      expect(svc.checkLimit(id, 'TRANSFERS_OUT_PER_DAY', 10_000_001)).toBe('REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED')
      expect(svc.checkLimit(id, 'BPAY_DAILY_LIMIT', 5_000_001)).toBe('REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED')
      expect(svc.checkLimit(id, 'DIRECT_DEBIT_PER_DAY', 5_000_001)).toBe('REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED')
      expect(svc.checkLimit(id, 'TOP_UP_PER_DAY', 10_000_001)).toBe('REFUSED_DAILY_TOP_UP_LIMIT_BREACHED')
      expect(svc.checkLimit(id, 'CARD_PAYMENTS_DAILY', 5_000_001)).toBe('REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED')
    } finally {
      svc.setUsageProvider(() => 0)
      await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
    }
    await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/riskLevel`, payload: { level: 'HIGH', reason: 'x' } })
    expect(svc.checkLimit(id, 'MAX_BALANCE', 1)).toBe('REFUSED_MAX_BALANCE_EXCEEDED')
    expect(svc.checkLimit(id, 'TRANSFERS_OUT_PER_DAY', 1)).toBe('REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED')
    expect(svc.checkLimit(id, 'SINGLE_CARD_TRANSACTION', 1)).toBe('REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED')
    expect(svc.checkLimit(id, 'MAX_BALANCE', 0)).toBeNull()
  })

  it('getAccountLimits loads the account overrides once, not once per limit type', async () => {
    const a = await newLowRiskAccount()
    const repo = (svc as unknown as { repo: { limitOverrides: (id: string) => unknown } }).repo
    const spy = vi.spyOn(repo, 'limitOverrides')
    try {
      expect((await app.inject({ method: 'GET', url: `/v1/accounts/${a.accountHayId}/limits` })).statusCode).toBe(200)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('balances and ledger-driven status (ctx.services.accounts.adjust)', () => {
  it('reproduces the docs hold / settlement / credit samples and flips APPROVED -> ACTIVE on the first posting (PLATFORM webhook)', async () => {
    const a = await newLowRiskAccount()
    const id = a.accountHayId!
    svc.adjust(id, { ledgerDelta: 1113 })
    expect(svc.balances(id).json).toEqual({ totalBalance: 11.13, availableBalance: 11.13, heldBalance: 0, lockedBalance: 0, stacksBalance: 0, overdraftBalance: 0, overdraftLimit: 0, technicalOverdraftBalance: 0 })
    expect(await getAccount(id)).toMatchObject({ status: 'ACTIVE', homeCurrencyBalanceEquivalent: { currency: 'AUD', totalBalance: 11.13, availableBalance: 11.13, heldBalance: 0 } })
    const events = await accountEvents(id)
    expect(events.map((e) => [e.accountStatusChangeEvent.accountStatus, e.actionOwner])).toEqual([['APPROVED', 'PLATFORM'], ['ACTIVE', 'PLATFORM']])
    events.forEach((e) => assertValidNotification(e))
    // authorisation hold 8.40: total unchanged, held +8.40, available -8.40
    svc.adjust(id, { heldDelta: 840 })
    expect(svc.balances(id).json).toMatchObject({ totalBalance: 11.13, heldBalance: 8.4, availableBalance: 2.73 })
    expect(svc.balances(id).cents).toMatchObject({ totalBalance: 1113, heldBalance: 840, availableBalance: 273 })
    expect((await getAccount(id)).homeCurrencyBalanceEquivalent).toEqual({ currency: 'AUD', totalBalance: 11.13, availableBalance: 2.73, heldBalance: 8.4 })
    // settlement 8.40: releases the hold and posts the debit
    svc.adjust(id, { heldDelta: -840, ledgerDelta: -840 })
    expect(svc.balances(id).json).toMatchObject({ totalBalance: 2.73, heldBalance: 0, availableBalance: 2.73 })
    // refund / credit +5.99
    svc.adjust(id, { ledgerDelta: 599 })
    expect(svc.balances(id).json).toMatchObject({ totalBalance: 8.72, availableBalance: 8.72 })
    // stacks and locked reduce available but not total
    svc.adjust(id, { stacksDelta: 300, lockedDelta: 100 })
    expect(await getAccount(id)).toMatchObject({ totalBalance: 8.72, availableBalance: 4.72, stacksBalance: 3, lockedBalance: 1, status: 'ACTIVE' })
    expect(() => svc.adjust(id, { heldDelta: -1 })).toThrow(/negative/)
    expect(() => svc.adjust(UNKNOWN_ID, { ledgerDelta: 1 })).toThrow(expect.objectContaining({ status: 404 }))
    expect((await accountEvents(id))).toHaveLength(2) // no further status events
  })

  it('a stack movement also activates an APPROVED account; a hold alone does not', async () => {
    const held = await newLowRiskAccount()
    svc.adjust(held.accountHayId!, { heldDelta: 100 })
    expect(svc.get(held.accountHayId!).status).toBe('APPROVED')
    const stacked = await newLowRiskAccount()
    svc.adjust(stacked.accountHayId!, { stacksDelta: 0 })
    expect(svc.get(stacked.accountHayId!).status).toBe('APPROVED')
    svc.adjust(stacked.accountHayId!, { ledgerDelta: 500, stacksDelta: 500 })
    expect(svc.get(stacked.accountHayId!).status).toBe('ACTIVE')
  })

  it('overdraft: total includes the unused limit, drawn amount is overdraftBalance, beyond the limit is technical overdraft and ACTIVE_IN_ARREARS', async () => {
    const a = await newLowRiskAccount()
    const id = a.accountHayId!
    const od = await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/overdraft`, payload: { overdraftLimit: 50 } })
    expect(od.statusCode).toBe(200)
    expect(od.json()).toEqual({ message: expect.any(String) })
    expect(await getAccount(id)).toMatchObject({ overdraftLimit: 50, totalBalance: 50, availableBalance: 50, overdraftBalance: 0, technicalOverdraftBalance: 0, status: 'APPROVED' })
    svc.adjust(id, { ledgerDelta: 10_000 })
    expect(await getAccount(id)).toMatchObject({ totalBalance: 150, availableBalance: 150, status: 'ACTIVE' })
    svc.adjust(id, { ledgerDelta: -13_000 }) // ledger -30
    expect(await getAccount(id)).toMatchObject({ totalBalance: 20, availableBalance: 20, overdraftBalance: 30, technicalOverdraftBalance: 0, status: 'ACTIVE' })
    expect(svc.checkFunds(id, 2000)).toBeNull()
    expect(svc.checkFunds(id, 2001)).toBe('REFUSED_INSUFFICIENT_FUNDS')
    svc.adjust(id, { ledgerDelta: -3_000 }) // ledger -60: 10 beyond the limit
    expect(await getAccount(id)).toMatchObject({ totalBalance: -10, availableBalance: -10, overdraftBalance: 50, technicalOverdraftBalance: 10, status: 'ACTIVE_IN_ARREARS' })
    svc.adjust(id, { ledgerDelta: 1_000 }) // ledger -50: covered again
    expect(await getAccount(id)).toMatchObject({ totalBalance: 0, overdraftBalance: 50, technicalOverdraftBalance: 0, status: 'ACTIVE' })
    // lowering the limit below the drawn amount flips to arrears immediately (CLIENT), raising it back recovers
    await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/overdraft`, payload: { overdraftLimit: 40 } })
    expect(await getAccount(id)).toMatchObject({ overdraftLimit: 40, overdraftBalance: 40, technicalOverdraftBalance: 10, status: 'ACTIVE_IN_ARREARS' })
    await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/overdraft`, payload: { overdraftLimit: 60 } })
    expect(await getAccount(id)).toMatchObject({ overdraftLimit: 60, technicalOverdraftBalance: 0, status: 'ACTIVE' })
    const statuses = (await accountEvents(id)).map((e) => [e.accountStatusChangeEvent.accountStatus, e.actionOwner])
    expect(statuses).toEqual([['APPROVED', 'PLATFORM'], ['ACTIVE', 'PLATFORM'], ['ACTIVE_IN_ARREARS', 'PLATFORM'], ['ACTIVE', 'PLATFORM'], ['ACTIVE_IN_ARREARS', 'CLIENT'], ['ACTIVE', 'CLIENT']])
    expectError(await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/overdraft`, payload: { overdraftLimit: 10_000.01 } }), 422, /^LIMIT_EXCEEDS_PRODUCT_LIMIT: overdraft/)
    expect((await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/overdraft`, payload: { overdraftLimit: -1 } })).statusCode).toBe(400)
    expectError(await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/overdraft`, payload: { overdraftLimit: 0.005 } }), 400, 'BAD_REQUEST: overdraftLimit must have at most 2 decimal places')
    expect((await getAccount(id)).overdraftLimit).toBe(60) // unchanged, not rounded to 0.01
    expect((await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/overdraft`, payload: { overdraftLimit: 0 } })).statusCode).toBe(200) // removes the overdraft
    expect(await getAccount(id)).toMatchObject({ overdraftLimit: 0, technicalOverdraftBalance: 50, status: 'ACTIVE_IN_ARREARS' })
  })

  it('requireOpenForMovement returns the account when open and the refusal outcome when LOCKED / CLOSED', async () => {
    const a = await newLowRiskAccount()
    const id = a.accountHayId!
    expect(svc.requireOpenForMovement(id)).toMatchObject({ id, status: 'APPROVED' })
    await app.inject({ method: 'POST', url: `/v0/accounts/${id}/block`, payload: { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' } })
    expect(svc.requireOpenForMovement(id)).toBe('REFUSED_ACCOUNT_BLOCKED')
    await app.inject({ method: 'POST', url: `/v0/accounts/${id}/unblock`, payload: { note: 'x' } })
    expect(svc.requireOpenForMovement(id)).toMatchObject({ id, status: 'ACTIVE' })
    svc.setStatus(id, 'DORMANT', { actionOwner: 'PLATFORM' })
    expect(svc.requireOpenForMovement(id)).toMatchObject({ status: 'DORMANT' })
    svc.adjust(id, { ledgerDelta: 100 })
    expect(svc.get(id).status).toBe('ACTIVE')
    svc.adjust(id, { ledgerDelta: -100 })
    await app.inject({ method: 'POST', url: `/v0/accounts/${id}/close` })
    await flush()
    expect(svc.requireOpenForMovement(id)).toBe('REFUSED_ACCOUNT_CLOSED')
    expect(() => svc.requireOpenForMovement(UNKNOWN_ID)).toThrow(expect.objectContaining({ status: 404 }))
  })

  it('setStatus refuses PENDING_APPROVAL (accounts created through this API are always APPROVED)', async () => {
    const a = await newAccount()
    expect(() => svc.setStatus(a.accountHayId!, 'PENDING_APPROVAL', { actionOwner: 'PLATFORM' })).toThrow(/^INVALID_STATE: .*PENDING_APPROVAL/)
    expect(svc.get(a.accountHayId!).status).toBe('APPROVED')
    expect(await accountEvents(a.accountHayId!)).toHaveLength(1)
  })
})

describe('rules', () => {
  it('addAccountRule validates the type-specific details, echoes them as `rule` and computes expiresAtUtc', async () => {
    const holder = await newCustomer()
    const a = await newAccount(holder)
    const id = a.accountHayId!
    await app.inject({ method: 'POST', url: '/_admin/clock', payload: { freeze: '2026-05-01T00:00:00.000Z' } })
    try {
      const res = await app.inject({ method: 'POST', url: `/v1/accounts/${id}/rules`, payload: { name: 'No gambling', ruleType: 'MERCHANT_CODE_BLOCK', expiresIn: 3600, ruleDetails: { blockedMerchantCategoryCodes: [7995, 7800] } } })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({
        id: expect.stringMatching(UUID_RE), name: 'No gambling', ruleType: 'MERCHANT_CODE_BLOCK', rule: { blockedMerchantCategoryCodes: [7995, 7800] },
        ownerId: holder, disabled: false, expiresAtUtc: '2026-05-01T01:00:00.000000Z',
      })
      const forever = await app.inject({ method: 'POST', url: `/v1/accounts/${id}/rules`, payload: { name: 'ids', ruleType: 'MERCHANT_ID_BLOCK', ruleDetails: { blockedMerchantIds: ['MERCH01', 'abc'] } } })
      expect(forever.statusCode).toBe(200)
      expect(forever.json()).not.toHaveProperty('expiresAtUtc')
      expect(forever.json().rule).toEqual({ blockedMerchantIds: ['MERCH01', 'abc'] })
      const post = (payload: any) => app.inject({ method: 'POST', url: `/v1/accounts/${id}/rules`, payload })
      expectError(await post({ name: 'x', ruleType: 'MERCHANT_CODE_BLOCK', ruleDetails: {} }), 422, /^INVALID_RULE: blockedMerchantCategoryCodes/)
      expectError(await post({ name: 'x', ruleType: 'MERCHANT_CODE_BLOCK', ruleDetails: { blockedMerchantCategoryCodes: [12345] } }), 422, /^INVALID_RULE: merchant category code/)
      expectError(await post({ name: 'x', ruleType: 'MERCHANT_ID_BLOCK', ruleDetails: { blockedMerchantCategoryCodes: [1] } }), 422, /^INVALID_RULE: blockedMerchantIds/)
      expectError(await post({ name: 'x', ruleType: 'MERCHANT_ID_BLOCK', ruleDetails: { blockedMerchantIds: ['TOO-LONG-ID-0123'] } }), 422, /^INVALID_RULE: merchant id/)
      expectError(await post({ name: 'x', ruleType: 'MERCHANT_NAME_BLOCK', ruleDetails: { merchantNameMatchingOperator: 'EXACT' } }), 422, /^INVALID_RULE: blockedMerchantName/)
      expectError(await post({ name: 'x', ruleType: 'MERCHANT_NAME_BLOCK', ruleDetails: { blockedMerchantName: 'Casino' } }), 422, /^INVALID_RULE: merchantNameMatchingOperator/)
      expect((await post({ name: 'x', ruleType: 'MERCHANT_NAME_BLOCK' })).statusCode).toBe(400)
      expect((await post({ name: '', ruleType: 'MERCHANT_NAME_BLOCK', ruleDetails: {} })).statusCode).toBe(400)
      expect((await post({ name: 'x', ruleType: 'MERCHANT_CODE_BLOCK', expiresIn: 0, ruleDetails: { blockedMerchantCategoryCodes: [1] } })).statusCode).toBe(400)
      // schema-valid int64 that overflows the Date range must not surface as a 500
      expectError(await post({ name: 'x', ruleType: 'MERCHANT_CODE_BLOCK', expiresIn: 9007199254740991, ruleDetails: { blockedMerchantCategoryCodes: [1] } }), 422, /^INVALID_RULE: expiresIn is too large/)
      expect((await app.inject({ method: 'GET', url: `/v1/accounts/${id}/rules` })).json()).toHaveLength(2)
      expectError(await app.inject({ method: 'POST', url: `/v1/accounts/${UNKNOWN_ID}/rules`, payload: { name: 'x', ruleType: 'MERCHANT_CODE_BLOCK', ruleDetails: { blockedMerchantCategoryCodes: [1] } } }), 404, /^NOT_FOUND/)
    } finally {
      await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
    }
  })

  it('lists, reads, disables (soft) and expires rules; evaluateRules picks the first enabled match', async () => {
    const a = await newAccount()
    const id = a.accountHayId!
    const add = async (payload: any) => (await app.inject({ method: 'POST', url: `/v1/accounts/${id}/rules`, payload })).json() as S['ExternalTransactionRuleResponse']
    await app.inject({ method: 'POST', url: '/_admin/clock', payload: { freeze: '2026-05-01T00:00:00.000Z' } })
    try {
      const mcc = await add({ name: 'mcc', ruleType: 'MERCHANT_CODE_BLOCK', expiresIn: 60, ruleDetails: { blockedMerchantCategoryCodes: [7995] } })
      const mid = await add({ name: 'mid', ruleType: 'MERCHANT_ID_BLOCK', ruleDetails: { blockedMerchantIds: ['MERCH01'] } })
      const starts = await add({ name: 'starts', ruleType: 'MERCHANT_NAME_BLOCK', ruleDetails: { blockedMerchantName: 'Crown', merchantNameMatchingOperator: 'STARTS_WITH' } })
      const ends = await add({ name: 'ends', ruleType: 'MERCHANT_NAME_BLOCK', ruleDetails: { blockedMerchantName: 'Casino', merchantNameMatchingOperator: 'ENDS_WITH' } })
      const exact = await add({ name: 'exact', ruleType: 'MERCHANT_NAME_BLOCK', ruleDetails: { blockedMerchantName: 'Lucky Slots', merchantNameMatchingOperator: 'EXACT' } })
      const contains = await add({ name: 'contains', ruleType: 'MERCHANT_NAME_BLOCK', ruleDetails: { blockedMerchantName: 'bet', merchantNameMatchingOperator: 'CONTAINS' } })

      const list = await app.inject({ method: 'GET', url: `/v1/accounts/${id}/rules` })
      expect(list.json().map((r: any) => r.id)).toEqual([mcc.id, mid.id, starts.id, ends.id, exact.id, contains.id])
      const one = await app.inject({ method: 'GET', url: `/v1/accounts/${id}/rules/${mcc.id}` })
      expect(one.json()).toEqual(mcc)
      const otherAccount = await newAccount()
      expectError(await app.inject({ method: 'GET', url: `/v1/accounts/${otherAccount.accountHayId}/rules/${mcc.id}` }), 404, /^NOT_FOUND: Rule/)
      expectError(await app.inject({ method: 'GET', url: `/v1/accounts/${id}/rules/${UNKNOWN_ID}` }), 404, /^NOT_FOUND: Rule/)
      expectError(await app.inject({ method: 'DELETE', url: `/v1/accounts/${id}/rules/${UNKNOWN_ID}` }), 404, /^NOT_FOUND: Rule/)

      expect(svc.evaluateRules(id, { mcc: 7995 })).toEqual({ ruleId: mcc.id })
      expect(svc.evaluateRules(id, { mcc: 5411 })).toBeNull()
      expect(svc.evaluateRules(id, { merchantId: 'merch01' })).toEqual({ ruleId: mid.id })
      expect(svc.evaluateRules(id, { merchantName: 'CROWN Melbourne' })).toEqual({ ruleId: starts.id })
      expect(svc.evaluateRules(id, { merchantName: 'The Star casino' })).toEqual({ ruleId: ends.id })
      expect(svc.evaluateRules(id, { merchantName: 'lucky slots' })).toEqual({ ruleId: exact.id })
      expect(svc.evaluateRules(id, { merchantName: 'Lucky Slots Pty' })).toBeNull()
      expect(svc.evaluateRules(id, { merchantName: 'SportsBet Online' })).toEqual({ ruleId: contains.id })
      expect(svc.evaluateRules(id, { mcc: 7995, merchantName: 'Crown Casino' })).toEqual({ ruleId: mcc.id }) // first match wins
      expect(svc.evaluateRules(id, {})).toBeNull()

      const dis = await app.inject({ method: 'DELETE', url: `/v1/accounts/${id}/rules/${mid.id}` })
      expect(dis.json()).toEqual({ success: true })
      expect((await app.inject({ method: 'GET', url: `/v1/accounts/${id}/rules/${mid.id}` })).json().disabled).toBe(true)
      expect((await app.inject({ method: 'DELETE', url: `/v1/accounts/${id}/rules/${mid.id}` })).json()).toEqual({ success: true })
      expect(svc.evaluateRules(id, { merchantId: 'MERCH01' })).toBeNull()
      expect((await app.inject({ method: 'GET', url: `/v1/accounts/${id}/rules` })).json()).toHaveLength(6)

      await app.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: 60_000 } })
      expect((await app.inject({ method: 'GET', url: `/v1/accounts/${id}/rules/${mcc.id}` })).json()).toMatchObject({ disabled: true, expiresAtUtc: '2026-05-01T00:01:00.000000Z' })
      expect(svc.evaluateRules(id, { mcc: 7995, merchantName: 'Crown Casino' })).toEqual({ ruleId: starts.id })
    } finally {
      await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
    }
  })
})

describe('blockAccount / unblockAccount', () => {
  it('blocks the account (LOCKED, blockedBy CLIENT) and, by default, its customer; idempotent; ACCOUNT_STATUS_CHANGE renders BLOCKED', async () => {
    const holder = await newCustomer()
    const a = await newAccount(holder)
    const id = a.accountHayId!
    const res = await app.inject({ method: 'POST', url: `/v0/accounts/${id}/block`, payload: { note: 'suspicious activity' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ failedAccounts: [], message: 'Account blocked successfully.' })
    expect(await getAccount(id)).toMatchObject({ status: 'LOCKED', blockedBy: 'CLIENT' })
    expect(svc.get(id).blockNote).toBe('suspicious activity')
    expect(await customerStatus(holder)).toBe('BLOCKED')
    const again = await app.inject({ method: 'POST', url: `/v0/accounts/${id}/block`, payload: { note: 'retry', accountBlockStyle: 'ACCOUNT_AND_CUSTOMER' } })
    expect(again.statusCode).toBe(200)
    expect(again.json().failedAccounts).toEqual([])
    const events = await accountEvents(id)
    expect(events.map((e) => [e.accountStatusChangeEvent.accountStatus, e.actionOwner])).toEqual([['APPROVED', 'PLATFORM'], ['BLOCKED', 'CLIENT']])
    events.forEach((e) => assertValidNotification(e))
    expect((await customerEvents(holder, 'CUSTOMER_STATUS_UPDATED')).map((e) => e.customerStatusUpdatedEvent.customerStatus)).toEqual(['ACTIVE', 'BLOCKED'])
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${id}/block`, payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${id}/block`, payload: { note: '' } })).statusCode).toBe(400)
    expectError(await app.inject({ method: 'POST', url: `/v0/accounts/${UNKNOWN_ID}/block`, payload: { note: 'x' } }), 404, /^NOT_FOUND/)
  })

  it('ACCOUNT_ONLY leaves the customer ACTIVE; child accounts are blocked and unblocked with the parent', async () => {
    const holder = await newCustomer()
    const parent = await newAccount(holder)
    const child = await newAccount(holder, { currency: 'USD', parentAccountId: parent.accountHayId })
    const res = await app.inject({ method: 'POST', url: `/v0/accounts/${parent.accountHayId}/block`, payload: { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' } })
    expect(res.statusCode).toBe(200)
    expect(await customerStatus(holder)).toBe('ACTIVE')
    expect((await getAccount(parent.accountHayId!)).status).toBe('LOCKED')
    expect((await getAccount(child.accountHayId!)).status).toBe('LOCKED')
    expect((await accountEvents(child.accountHayId!)).at(-1)).toMatchObject({ accountStatusChangeEvent: { accountStatus: 'BLOCKED' }, actionOwner: 'CLIENT' })
    const un = await app.inject({ method: 'POST', url: `/v0/accounts/${parent.accountHayId}/unblock`, payload: { note: 'cleared' } })
    expect(un.statusCode).toBe(200)
    expect(un.json()).toEqual({ message: expect.any(String) })
    expect(await getAccount(parent.accountHayId!)).toMatchObject({ status: 'ACTIVE' })
    expect(await getAccount(parent.accountHayId!)).not.toHaveProperty('blockedBy')
    expect((await getAccount(child.accountHayId!)).status).toBe('ACTIVE')
    expect((await accountEvents(child.accountHayId!)).map((e) => e.accountStatusChangeEvent.accountStatus)).toEqual(['APPROVED', 'BLOCKED', 'ACTIVE'])
  })

  it('unblock -> ACTIVE and reverses the customer block made by the same blockAccount call; independently blocked customers stay BLOCKED', async () => {
    const holder = await newCustomer()
    const a = await newAccount(holder)
    const id = a.accountHayId!
    await app.inject({ method: 'POST', url: `/v0/accounts/${id}/block`, payload: { note: 'x' } })
    expect(await customerStatus(holder)).toBe('BLOCKED')
    const un = await app.inject({ method: 'POST', url: `/v0/accounts/${id}/unblock`, payload: { note: 'ok' } })
    expect(un.statusCode).toBe(200)
    expect((await getAccount(id)).status).toBe('ACTIVE')
    expect(await customerStatus(holder)).toBe('ACTIVE')
    expect((await customerEvents(holder, 'CUSTOMER_STATUS_UPDATED')).map((e) => e.customerStatusUpdatedEvent.customerStatus)).toEqual(['ACTIVE', 'BLOCKED', 'ACTIVE'])
    expectError(await app.inject({ method: 'POST', url: `/v0/accounts/${id}/unblock`, payload: { note: 'again' } }), 422, /^INVALID_STATE: Account .* is not LOCKED \(status is ACTIVE\)/)
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${id}/unblock`, payload: {} })).statusCode).toBe(400)
    expectError(await app.inject({ method: 'POST', url: `/v0/accounts/${UNKNOWN_ID}/unblock`, payload: { note: 'x' } }), 404, /^NOT_FOUND/)

    // customer blocked first through blockCustomer: blockAccount is a no-op on it, unblockAccount leaves it BLOCKED
    await app.inject({ method: 'POST', url: `/v0/customers/${holder}/block`, payload: { note: 'kyc' } })
    await app.inject({ method: 'POST', url: `/v0/accounts/${id}/block`, payload: { note: 'x' } })
    await app.inject({ method: 'POST', url: `/v0/accounts/${id}/unblock`, payload: { note: 'x' } })
    expect((await getAccount(id)).status).toBe('ACTIVE')
    expect(await customerStatus(holder)).toBe('BLOCKED')
  })

  it('a customer unblocked directly is no longer held by the LOCKED account: a later blockCustomer survives unblockAccount', async () => {
    const holder = await newCustomer()
    const id = (await newAccount(holder)).accountHayId!
    await app.inject({ method: 'POST', url: `/v0/accounts/${id}/block`, payload: { note: 'x' } })
    expect(await customerStatus(holder)).toBe('BLOCKED')
    expect((await app.inject({ method: 'POST', url: `/v0/customers/${holder}/unblock`, payload: { note: 'ok' } })).statusCode).toBe(200)
    expect((await getAccount(id)).status).toBe('LOCKED')
    expect(svc.get(id).blockedCustomerIds ?? []).toEqual([])
    expect((await app.inject({ method: 'POST', url: `/v0/customers/${holder}/block`, payload: { note: 'kyc' } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${id}/unblock`, payload: { note: 'ok' } })).statusCode).toBe(200)
    expect((await getAccount(id)).status).toBe('ACTIVE')
    expect(await customerStatus(holder)).toBe('BLOCKED')
    expect((await customerEvents(holder, 'CUSTOMER_STATUS_UPDATED')).map((e) => e.customerStatusUpdatedEvent.customerStatus)).toEqual(['ACTIVE', 'BLOCKED', 'ACTIVE', 'BLOCKED'])
  })

  it('unblock lands on ACTIVE_IN_ARREARS when the account is technically overdrawn', async () => {
    const a = await newLowRiskAccount()
    const id = a.accountHayId!
    svc.adjust(id, { ledgerDelta: 100 })
    svc.adjust(id, { ledgerDelta: -600 })
    expect((await getAccount(id)).status).toBe('ACTIVE_IN_ARREARS')
    await app.inject({ method: 'POST', url: `/v0/accounts/${id}/block`, payload: { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' } })
    expect(svc.requireOpenForMovement(id)).toBe('REFUSED_ACCOUNT_BLOCKED')
    await app.inject({ method: 'POST', url: `/v0/accounts/${id}/unblock`, payload: { note: 'x' } })
    expect((await getAccount(id)).status).toBe('ACTIVE_IN_ARREARS')
    svc.adjust(id, { ledgerDelta: 500 })
    expect((await getAccount(id)).status).toBe('ACTIVE')
    expect((await accountEvents(id)).map((e) => e.accountStatusChangeEvent.accountStatus)).toEqual(['APPROVED', 'ACTIVE', 'ACTIVE_IN_ARREARS', 'BLOCKED', 'ACTIVE_IN_ARREARS', 'ACTIVE'])
  })

  it('a default-style block on an already LOCKED (ACCOUNT_ONLY) account still blocks the customer, and unblock releases it', async () => {
    const holder = await newCustomer()
    const a = await newAccount(holder)
    const id = a.accountHayId!
    await app.inject({ method: 'POST', url: `/v0/accounts/${id}/block`, payload: { note: 'account only', accountBlockStyle: 'ACCOUNT_ONLY' } })
    expect(await customerStatus(holder)).toBe('ACTIVE')
    const widen = await app.inject({ method: 'POST', url: `/v0/accounts/${id}/block`, payload: { note: 'and the customer' } })
    expect(widen.statusCode, widen.body).toBe(200)
    expect(widen.json()).toEqual({ failedAccounts: [], message: 'Account blocked successfully.' })
    expect(await customerStatus(holder)).toBe('BLOCKED')
    expect(svc.get(id).blockedCustomerIds).toEqual([holder])
    expect((await accountEvents(id)).map((e) => e.accountStatusChangeEvent.accountStatus)).toEqual(['APPROVED', 'BLOCKED']) // the account itself did not transition again
    await app.inject({ method: 'POST', url: `/v0/accounts/${id}/unblock`, payload: { note: 'ok' } })
    expect(await customerStatus(holder)).toBe('ACTIVE')
    expect((await customerEvents(holder, 'CUSTOMER_STATUS_UPDATED')).map((e) => e.customerStatusUpdatedEvent.customerStatus)).toEqual(['ACTIVE', 'BLOCKED', 'ACTIVE'])
  })

  it('a customer blocked through two of its accounts is released only when the last of them is unblocked', async () => {
    const holder = await newCustomer()
    const a = (await newAccount(holder)).accountHayId!
    const b = (await newAccount(holder)).accountHayId!
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${a}/block`, payload: { note: 'a' } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${b}/block`, payload: { note: 'b' } })).statusCode).toBe(200)
    expect(svc.get(a).blockedCustomerIds).toEqual([holder])
    expect(svc.get(b).blockedCustomerIds).toEqual([holder])
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${a}/unblock`, payload: { note: 'a' } })).statusCode).toBe(200)
    expect((await getAccount(a)).status).toBe('ACTIVE')
    expect((await getAccount(b)).status).toBe('LOCKED')
    expect(await customerStatus(holder)).toBe('BLOCKED') // b still holds the customer
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${b}/unblock`, payload: { note: 'b' } })).statusCode).toBe(200)
    expect(await customerStatus(holder)).toBe('ACTIVE')
    expect((await customerEvents(holder, 'CUSTOMER_STATUS_UPDATED')).map((e) => e.customerStatusUpdatedEvent.customerStatus)).toEqual(['ACTIVE', 'BLOCKED', 'ACTIVE'])
  })

  it('a GROUP-held account blocks every member customer and unblock releases them all (CUSTOMER_STATUS_UPDATED per member)', async () => {
    const groupId = randomUUID()
    const m1 = await newCustomer()
    const m2 = await newCustomer()
    services().groups = { requireAllMembersActive: () => {}, memberIds: (id: string) => (id === groupId ? [m1, m2] : []), groupIdsForCustomer: () => [] }
    try {
      const a = await newAccount(groupId, { accountHolderType: 'GROUP' })
      const id = a.accountHayId!
      const res = await app.inject({ method: 'POST', url: `/v0/accounts/${id}/block`, payload: { note: 'group freeze' } })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({ failedAccounts: [], message: 'Account blocked successfully.' })
      expect(await getAccount(id)).toMatchObject({ status: 'LOCKED', blockedBy: 'CLIENT' })
      expect(await customerStatus(m1)).toBe('BLOCKED')
      expect(await customerStatus(m2)).toBe('BLOCKED')
      expect(svc.get(id).blockedCustomerIds).toEqual([m1, m2])
      const blocked = (await accountEvents(id)).filter((e) => e.accountStatusChangeEvent.accountStatus === 'BLOCKED')
      expect(blocked.map((e) => e.customerHayId).sort()).toEqual([m1, m2].sort())
      for (const m of [m1, m2]) {
        const events = await customerEvents(m, 'CUSTOMER_STATUS_UPDATED')
        expect(events.map((e) => [e.customerStatusUpdatedEvent.customerStatus, e.actionOwner])).toEqual([['ACTIVE', 'PLATFORM'], ['BLOCKED', 'CLIENT']])
      }
      expect((await app.inject({ method: 'POST', url: `/v0/accounts/${id}/unblock`, payload: { note: 'thawed' } })).statusCode).toBe(200)
      expect((await getAccount(id)).status).toBe('ACTIVE')
      expect(await customerStatus(m1)).toBe('ACTIVE')
      expect(await customerStatus(m2)).toBe('ACTIVE')
      for (const m of [m1, m2]) {
        expect((await customerEvents(m, 'CUSTOMER_STATUS_UPDATED')).map((e) => e.customerStatusUpdatedEvent.customerStatus)).toEqual(['ACTIVE', 'BLOCKED', 'ACTIVE'])
      }
    } finally {
      delete services().groups
    }
  })

  it('a platform-driven block() records blockedBy PLATFORM on the account and the customer; a client unblock releases both', async () => {
    const holder = await newCustomer()
    const a = await newAccount(holder)
    const id = a.accountHayId!
    svc.block(id, { note: 'platform freeze', actionOwner: 'PLATFORM' })
    expect(await getAccount(id)).toMatchObject({ status: 'LOCKED', blockedBy: 'PLATFORM' })
    expect(built.ctx.services.customers.get(holder)).toMatchObject({ status: 'BLOCKED', blockedBy: 'PLATFORM' })
    expect((await accountEvents(id)).at(-1)).toMatchObject({ accountStatusChangeEvent: { accountStatus: 'BLOCKED' }, actionOwner: 'PLATFORM' })
    expect((await customerEvents(holder, 'CUSTOMER_STATUS_UPDATED')).at(-1)).toMatchObject({ customerStatusUpdatedEvent: { customerStatus: 'BLOCKED' }, actionOwner: 'PLATFORM' })
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${id}/unblock`, payload: { note: 'cleared' } })).statusCode).toBe(200)
    expect((await getAccount(id)).status).toBe('ACTIVE')
    expect(await customerStatus(holder)).toBe('ACTIVE')
  })

  it('blocking is a partial success when the customer cannot be blocked, a no-op success on a CLOSED account, and never touches cards', async () => {
    const holder = await newCustomer()
    const a = await newAccount(holder)
    const id = a.accountHayId!
    const cards = { listForAccount: vi.fn(() => []), cancelAllForAccount: vi.fn() }
    services().cards = cards
    try {
      await app.inject({ method: 'PATCH', url: `/v0/customers/${holder}/status`, payload: { newStatus: 'INACTIVE' } })
      const res = await app.inject({ method: 'POST', url: `/v0/accounts/${id}/block`, payload: { note: 'x' } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ failedAccounts: [], message: expect.stringContaining(holder) })
      expect((await getAccount(id)).status).toBe('LOCKED')
      expect(cards.cancelAllForAccount).not.toHaveBeenCalled()
    } finally {
      delete services().cards
    }
    const closed = await newAccount()
    await app.inject({ method: 'POST', url: `/v0/accounts/${closed.accountHayId}/close` })
    await flush()
    const res = await app.inject({ method: 'POST', url: `/v0/accounts/${closed.accountHayId}/block`, payload: { note: 'x' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().failedAccounts).toEqual([])
    expect((await getAccount(closed.accountHayId!)).status).toBe('CLOSED')
    expect((await accountEvents(closed.accountHayId!)).map((e) => e.accountStatusChangeEvent.accountStatus)).toEqual(['APPROVED', 'CLOSED'])
    expectError(await app.inject({ method: 'POST', url: `/v0/accounts/${closed.accountHayId}/unblock`, payload: { note: 'x' } }), 422, /^INVALID_STATE/)
  })
})

describe('closeAccount', () => {
  it('202 SUCCESS, then the asynchronous cascade: CLOSED + closedDateTimeUtc, cards cancelled, last-account customer INACTIVE with the reason', async () => {
    const holder = await newCustomer()
    const a = await newAccount(holder)
    const id = a.accountHayId!
    const cards = { listForAccount: vi.fn(() => []), cancelAllForAccount: vi.fn() }
    services().cards = cards
    try {
      const res = await app.inject({ method: 'POST', url: `/v0/accounts/${id}/close`, payload: { reason: 'CUSTOMER' } })
      expect(res.statusCode, res.body).toBe(202)
      expect(res.json()).toEqual({ result: 'SUCCESS', description: expect.any(String), errors: [] })
      await flush()
      const closed = await getAccount(id)
      expect(closed.status).toBe('CLOSED')
      expect(closed.closedDateTimeUtc).toMatch(ISO_MICROS)
      expect(cards.cancelAllForAccount).toHaveBeenCalledWith(id, 'CUSTOMER')
      expect(await customerStatus(holder)).toBe('INACTIVE')
      expect(built.ctx.services.customers.get(holder)).toMatchObject({ status: 'INACTIVE', statusReason: 'CUSTOMER' })
      const events = await accountEvents(id)
      expect(events.map((e) => [e.accountStatusChangeEvent.accountStatus, e.actionOwner])).toEqual([['APPROVED', 'PLATFORM'], ['CLOSED', 'CLIENT']])
      events.forEach((e) => assertValidNotification(e))
      // idempotent: closing again is a SUCCESS no-op, nothing re-runs
      const again = await app.inject({ method: 'POST', url: `/v0/accounts/${id}/close` })
      expect(again.statusCode).toBe(202)
      expect(again.json().result).toBe('SUCCESS')
      await flush()
      expect(cards.cancelAllForAccount).toHaveBeenCalledTimes(1)
      expect(await accountEvents(id)).toHaveLength(2)
    } finally {
      delete services().cards
    }
  })

  it('an accepted closure refuses money movements until its asynchronous cascade has run, so the cascade always closes the account', async () => {
    const slow = await startApp({ asyncDelayMs: 60_000, defaultRiskLevel: 'LOW' })
    try {
      const sapp = slow.app
      const c = await sapp.inject({ method: 'POST', url: '/v0/customers/create', payload: {
        idempotencyKey: randomUUID(), email: 'closing@example.com', customerTier: 'STANDARD', phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: '499999999' },
        address: { line1: '1 Test St', townOrCity: 'Sydney', administrativeRegion: 'NSW', postcode: '2000', countryCodeIso: 'AUS' },
        customerDetails: { firstName: 'Closing', lastName: 'Holder', dateOfBirth: '1990-01-01' },
      } })
      const holder = c.json().customerHayId as string
      await sapp.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: 61_000 } })
      const acc = await sapp.inject({ method: 'POST', url: '/v1/accounts', payload: { idempotencyKey: randomUUID(), accountHolderId: holder, accountHolderType: 'CUSTOMER', productId: LOCAL_PRODUCT_ID } })
      expect(acc.statusCode, acc.body).toBe(200)
      const id = acc.json().accountHayId as string
      expect((await sapp.inject({ method: 'POST', url: `/v0/accounts/${id}/close`, payload: { reason: 'CUSTOMER' } })).statusCode).toBe(202)
      expect((await sapp.inject({ method: 'GET', url: `/v0/accounts/${id}` })).json().status).toBe('APPROVED')
      const credit = await sapp.inject({ method: 'POST', url: '/v1/transactions/credit', payload: { idempotencyKey: randomUUID(), accountHayId: id, amount: 5, counterpartName: 'x', description: 'late', transactionChannel: 'MANUAL_ADJUSTMENT' } })
      expect(credit.json()).toEqual({ outcome: 'REFUSED_ACCOUNT_CLOSED' })
      await sapp.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: 61_000 } })
      expect((await sapp.inject({ method: 'GET', url: `/v0/accounts/${id}` })).json()).toMatchObject({ status: 'CLOSED', totalBalance: 0 })
    } finally {
      await slow.app.close()
    }
  })

  it('an unused overdraft limit does not block closure, and a CLOSED account reports nothing spendable (limit 0)', async () => {
    const a = await newLowRiskAccount()
    const id = a.accountHayId!
    expect((await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/overdraft`, payload: { overdraftLimit: 100 } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${id}/close`, payload: { reason: 'CUSTOMER' } })).statusCode).toBe(202)
    await flush()
    expect(await getAccount(id)).toMatchObject({
      status: 'CLOSED', totalBalance: 0, availableBalance: 0, overdraftLimit: 0, overdraftBalance: 0,
      homeCurrencyBalanceEquivalent: { totalBalance: 0, availableBalance: 0, heldBalance: 0 },
    })
  })

  it('closes a LOCKED account (LOCKED -> CLOSED, CLIENT) and the customer that block put in BLOCKED ends INACTIVE with the reason', async () => {
    const holder = await newCustomer()
    const a = await newAccount(holder)
    const id = a.accountHayId!
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${id}/block`, payload: { note: 'fraud' } })).statusCode).toBe(200)
    expect(await customerStatus(holder)).toBe('BLOCKED')
    const res = await app.inject({ method: 'POST', url: `/v0/accounts/${id}/close`, payload: { reason: 'SUSPICIOUS' } })
    expect(res.statusCode, res.body).toBe(202)
    await flush()
    const closed = await getAccount(id)
    expect(closed).toMatchObject({ status: 'CLOSED', closedDateTimeUtc: expect.stringMatching(ISO_MICROS) })
    expect(closed).not.toHaveProperty('blockedBy')
    expect(built.ctx.services.customers.get(holder)).toMatchObject({ status: 'INACTIVE', statusReason: 'SUSPICIOUS' })
    expect((await accountEvents(id)).map((e) => [e.accountStatusChangeEvent.accountStatus, e.actionOwner])).toEqual([['APPROVED', 'PLATFORM'], ['BLOCKED', 'CLIENT'], ['CLOSED', 'CLIENT']])
    expectError(await app.inject({ method: 'POST', url: `/v0/accounts/${id}/unblock`, payload: { note: 'x' } }), 422, /^INVALID_STATE/)
  })

  it('keeps the customer ACTIVE while another account stays open; a GROUP account counts through groups.groupIdsForCustomer', async () => {
    const holder = await newCustomer()
    const first = await newAccount(holder)
    const second = await newAccount(holder)
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${first.accountHayId}/close`, payload: { reason: 'OPERATIONAL' } })).statusCode).toBe(202)
    await flush()
    expect(await customerStatus(holder)).toBe('ACTIVE')
    const groupId = randomUUID()
    services().groups = { requireAllMembersActive: () => {}, memberIds: () => [holder], groupIdsForCustomer: (c: string) => (c === holder ? [groupId] : []) }
    try {
      const group = await newAccount(groupId, { accountHolderType: 'GROUP' })
      expect((await app.inject({ method: 'POST', url: `/v0/accounts/${second.accountHayId}/close` })).statusCode).toBe(202)
      await flush()
      expect(await customerStatus(holder)).toBe('ACTIVE') // the group account is still open
      expect((await app.inject({ method: 'POST', url: `/v0/accounts/${group.accountHayId}/close`, payload: { reason: 'DECEASED' } })).statusCode).toBe(202)
      await flush()
      expect(built.ctx.services.customers.get(holder)).toMatchObject({ status: 'INACTIVE', statusReason: 'DECEASED' })
    } finally {
      delete services().groups
    }
  })

  it('422 CloseAccountResponse listing every failing check with the documented messages', async () => {
    const a = await newLowRiskAccount()
    const id = a.accountHayId!
    svc.adjust(id, { ledgerDelta: 1778, heldDelta: 1778 })
    const res = await app.inject({ method: 'POST', url: `/v0/accounts/${id}/close`, payload: { reason: 'CUSTOMER' } })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({
      result: 'FAILURE', description: 'Account closure failed. Check errors for more details.',
      errors: [{ type: 'ACCOUNT_BALANCE_TOTAL', errorMessage: 'Account has 17.78 total balance.' }, { type: 'ACCOUNT_BALANCE_HELD', errorMessage: 'Account has 17.78 held balance.' }],
    })
    expect((await getAccount(id)).status).toBe('ACTIVE')
    svc.adjust(id, { heldDelta: -1778, ledgerDelta: -1778, stacksDelta: 100, lockedDelta: 200 })
    const more = await app.inject({ method: 'POST', url: `/v0/accounts/${id}/close` })
    expect(more.json().errors.map((e: any) => e.type)).toEqual(['ACCOUNT_BALANCE_STACKS', 'ACCOUNT_BALANCE_LOCKED'])
    svc.adjust(id, { stacksDelta: -100, lockedDelta: -200 })
    await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/overdraft`, payload: { overdraftLimit: 10 } })
    svc.adjust(id, { ledgerDelta: -1500 })
    const od = await app.inject({ method: 'POST', url: `/v0/accounts/${id}/close` })
    expect(od.json().errors).toEqual([
      { type: 'ACCOUNT_BALANCE_TOTAL', errorMessage: 'Account has -15.00 total balance.' },
      { type: 'ACCOUNT_BALANCE_OVERDRAFT', errorMessage: 'Account has 10.00 overdraft balance.' },
      { type: 'ACCOUNT_BALANCE_TECHNICAL_OVERDRAFT', errorMessage: 'Account has 5.00 technical overdraft balance.' },
    ])
    svc.adjust(id, { ledgerDelta: 1500 })
    // an unused overdraft limit does not block closure
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${id}/close` })).statusCode).toBe(202)
  })

  it('registered closure checkers (in-flight direct debits) and open child accounts block closure', async () => {
    const holder = await newCustomer()
    const parent = await newAccount(holder)
    const child = await newAccount(holder, { currency: 'USD', parentAccountId: parent.accountHayId })
    const checker = vi.fn((acc: { id: string }) => (acc.id === parent.accountHayId ? [{ type: 'INFLIGHT_OUTBOUND_DIRECT_DEBITS' as const, errorMessage: 'Account has 1 inflight outbound direct entries: [x]' }] : []))
    svc.addClosureChecker(checker)
    const res = await app.inject({ method: 'POST', url: `/v0/accounts/${parent.accountHayId}/close` })
    expect(res.statusCode).toBe(422)
    expect(res.json().errors).toEqual([
      { type: 'INFLIGHT_OUTBOUND_DIRECT_DEBITS', errorMessage: 'Account has 1 inflight outbound direct entries: [x]' },
      { type: 'CHILD_ACCOUNT_STATUS', errorMessage: `Account has 1 child accounts not closed: [${child.accountHayId}]` },
    ])
    checker.mockImplementation(() => [])
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${child.accountHayId}/close` })).statusCode).toBe(202)
    await flush()
    expect(await customerStatus(holder)).toBe('ACTIVE') // parent still open
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${parent.accountHayId}/close` })).statusCode).toBe(202)
    await flush()
    expect((await getAccount(parent.accountHayId!)).status).toBe('CLOSED')
    expect(await customerStatus(holder)).toBe('INACTIVE')
  })

  it('validates the optional body and refuses every mutating operation on a CLOSED account', async () => {
    const a = await newAccount()
    const id = a.accountHayId!
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${id}/close`, payload: { reason: 'BORED' } })).statusCode).toBe(400)
    expectError(await app.inject({ method: 'POST', url: `/v0/accounts/${UNKNOWN_ID}/close` }), 404, /^NOT_FOUND/)
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${id}/close`, payload: { reason: null } })).statusCode).toBe(202)
    await flush()
    expect((await getAccount(id)).status).toBe('CLOSED')
    expect(built.ctx.services.customers.get(a.accountHolderId!)).toMatchObject({ status: 'INACTIVE' })
    expect(built.ctx.services.customers.get(a.accountHolderId!)).not.toHaveProperty('statusReason')
    const closedCode = /^ACCOUNT_CLOSED: /
    expectError(await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/riskLevel`, payload: { level: 'LOW', reason: 'x' } }), 422, closedCode)
    expectError(await app.inject({ method: 'PUT', url: `/v1/accounts/${id}/limits/MAX_BALANCE`, payload: { limitAmount: 1 } }), 422, closedCode)
    expectError(await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/max-balance`, payload: { maxBalanceLimit: 1 } }), 422, closedCode)
    expectError(await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/overdraft`, payload: { overdraftLimit: 1 } }), 422, closedCode)
    expectError(await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/cop-opt-out`, payload: { optOut: true } }), 422, closedCode)
    expectError(await app.inject({ method: 'POST', url: `/v1/accounts/${id}/rules`, payload: { name: 'x', ruleType: 'MERCHANT_CODE_BLOCK', ruleDetails: { blockedMerchantCategoryCodes: [1] } } }), 422, closedCode)
    expectError(await app.inject({ method: 'POST', url: `/v1/accounts/${id}/custom-data`, payload: { customData: { a: 1 } } }), 422, closedCode)
    expect(() => svc.setStatus(id, 'ACTIVE', { actionOwner: 'PLATFORM' })).toThrow(/^INVALID_STATE/)
    // reads still work
    expect((await app.inject({ method: 'GET', url: `/v1/accounts/${id}/limits` })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/v1/accounts/${id}/rules` })).statusCode).toBe(200)
    expect((await app.inject({ method: 'DELETE', url: `/v1/accounts/${id}/custom-data` })).statusCode).toBe(200)
  })
})

describe('deferred work with asyncDelayMs > 0 (child provisioning and the closure cascade fire on the virtual clock)', () => {
  let other: BuiltServer
  let osvc: AccountsService
  let m = 0
  beforeAll(async () => { other = await startApp({ asyncDelayMs: 60_000 }); osvc = other.ctx.services.accounts })
  afterAll(async () => { await other.app.close() })

  /** Fires every deferred job scheduled so far (they are due 60 s ahead on the virtual clock). */
  async function runDeferred(): Promise<void> {
    const res = await other.app.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: 60_000 } })
    expect(res.statusCode).toBe(200)
  }
  async function deferredCustomer(): Promise<string> {
    m++
    const res = await other.app.inject({
      method: 'POST', url: '/v0/customers/create',
      payload: {
        idempotencyKey: randomUUID(), email: `deferred${m}@example.com`, customerTier: 'STANDARD',
        phoneNumber: { countryCodePrefix: '61', numberAfterPrefix: `4${String(m).padStart(8, '0')}` },
        address: { line1: '1 Test St', townOrCity: 'Sydney', administrativeRegion: 'NSW', postcode: '2000', countryCodeIso: 'AUS' },
        customerDetails: { firstName: 'Def', lastName: `Erred${m}`, dateOfBirth: '1990-01-01' },
      },
    })
    expect(res.statusCode, res.body).toBe(200)
    await runDeferred()
    return res.json().customerHayId as string
  }
  async function deferredAccount(holder: string, overrides: Partial<CreateBody> = {}): Promise<HayAccount> {
    const res = await other.app.inject({ method: 'POST', url: '/v1/accounts', payload: createBody(holder, overrides) })
    expect(res.statusCode, res.body).toBe(200)
    return res.json() as HayAccount
  }
  async function deferredAccountEvents(accountId: string): Promise<any[]> {
    await other.app.inject({ method: 'POST', url: '/_admin/notifications/flush' })
    const res = await other.app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })
    return (res.json() as { payload: any }[]).map((r) => r.payload).filter((p) => p.type === 'ACCOUNT_STATUS_CHANGE' && p.accountStatusChangeEvent?.accountHayId === accountId)
  }
  const status = async (id: string) => (await other.app.inject({ method: 'GET', url: `/v0/accounts/${id}` })).json().status as string

  it('provisions the requested children even when the holder is BLOCKED by the time the job fires (the parent was already authorised)', async () => {
    const holder = await deferredCustomer()
    const parent = await deferredAccount(holder, { fx: { childAccounts: { initMode: 'CUSTOM', currencies: ['USD'] } } })
    expect((await other.app.inject({ method: 'POST', url: `/v0/customers/${holder}/block`, payload: { note: 'kyc' } })).statusCode).toBe(200)
    expect(osvc.children(parent.accountHayId!)).toHaveLength(0)
    await runDeferred()
    expect(osvc.children(parent.accountHayId!).map((c) => [c.currency, c.status])).toEqual([['USD', 'APPROVED']])
  })

  it('a child provisioned after its parent was blocked is created LOCKED with the parent block (APPROVED then BLOCKED, PLATFORM) and follows the unblock', async () => {
    const holder = await deferredCustomer()
    const parent = await deferredAccount(holder, { fx: { childAccounts: { initMode: 'CUSTOM', currencies: ['USD', 'GBP'] } } })
    expect((await other.app.inject({ method: 'POST', url: `/v0/accounts/${parent.accountHayId}/block`, payload: { note: 'freeze', accountBlockStyle: 'ACCOUNT_ONLY' } })).statusCode).toBe(200)
    await runDeferred()
    const children = osvc.children(parent.accountHayId!)
    expect(children.map((c) => c.currency).sort()).toEqual(['GBP', 'USD'])
    for (const c of children) {
      expect(c).toMatchObject({ status: 'LOCKED', blockedBy: 'CLIENT', blockNote: 'freeze' })
      expect((await deferredAccountEvents(c.id)).map((e) => [e.accountStatusChangeEvent.accountStatus, e.actionOwner])).toEqual([['APPROVED', 'PLATFORM'], ['BLOCKED', 'PLATFORM']])
    }
    expect(await status(parent.accountHayId!)).toBe('LOCKED')
    expect((await other.app.inject({ method: 'POST', url: `/v0/accounts/${parent.accountHayId}/unblock`, payload: { note: 'thaw' } })).statusCode).toBe(200)
    expect(osvc.children(parent.accountHayId!).map((c) => c.status)).toEqual(['ACTIVE', 'ACTIVE'])
  })

  it('the closure cascade leaves the account open when balances moved after the 202 (no CLOSED event, customer untouched); a later close succeeds', async () => {
    const holder = await deferredCustomer()
    const a = await deferredAccount(holder)
    const id = a.accountHayId!
    expect((await other.app.inject({ method: 'POST', url: `/v0/accounts/${id}/close`, payload: { reason: 'CUSTOMER' } })).statusCode).toBe(202)
    osvc.adjust(id, { ledgerDelta: 100 }) // a credit lands before the cascade runs
    await runDeferred()
    expect(await status(id)).toBe('ACTIVE')
    expect((await deferredAccountEvents(id)).map((e) => e.accountStatusChangeEvent.accountStatus)).toEqual(['APPROVED', 'ACTIVE'])
    expect(other.ctx.services.customers.get(holder).status).toBe('ACTIVE')
    osvc.adjust(id, { ledgerDelta: -100 })
    expect((await other.app.inject({ method: 'POST', url: `/v0/accounts/${id}/close`, payload: { reason: 'CUSTOMER' } })).statusCode).toBe(202)
    await runDeferred()
    expect(await status(id)).toBe('CLOSED')
    expect(other.ctx.services.customers.get(holder)).toMatchObject({ status: 'INACTIVE', statusReason: 'CUSTOMER' })
  })
})

describe('getCardsForAccountId', () => {
  it('delegates to ctx.services.cards.listForAccount and answers [] while cards are not loaded; 404 for an unknown account', async () => {
    const a = await newAccount()
    const id = a.accountHayId!
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${id}/cards` })).json()).toEqual([])
    expectError(await app.inject({ method: 'GET', url: `/v0/accounts/${UNKNOWN_ID}/cards` }), 404, /^NOT_FOUND: Account/)
    const card = { cardHayId: randomUUID(), accountHayId: id, customerHayId: a.accountHolderId, cardStatus: 'ACTIVE', cardType: 'VIRTUAL', cardToken: '123456789', lastFourDigits: '4242' }
    const listForAccount = vi.fn(() => [card])
    services().cards = { listForAccount, cancelAllForAccount: vi.fn() }
    try {
      const res = await app.inject({ method: 'GET', url: `/v0/accounts/${id}/cards` })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([card])
      expect(listForAccount).toHaveBeenCalledWith(id)
    } finally {
      delete services().cards
    }
  })
})

describe('dependency shapes (deps.ts) and webhook validity', () => {
  it('refuses to start when a registered cards/groups service lacks a method accounts calls', async () => {
    const bad = await (await import('../src/server.js')).buildServer({ logLevel: 'silent', auth: false })
    const s = bad.ctx.services as unknown as Record<string, unknown>
    s.cards = { listForAccount: () => [], listForCustomer: () => [] }
    s.groups = { memberIds: () => [] }
    await expect(bad.app.ready()).rejects.toThrow(/cards\.cancelAllForAccount[\s\S]*groups\.requireAllMembersActive/)
    await bad.app.close()
  })

  it('every notification emitted in this file validates against wh:NotificationDto', async () => {
    const payloads = await allPayloads()
    expect(payloads.filter((p) => p.type === 'ACCOUNT_STATUS_CHANGE').length).toBeGreaterThan(20)
    for (const p of payloads) assertValidNotification(p)
    for (const p of payloads.filter((p) => p.type === 'ACCOUNT_STATUS_CHANGE')) {
      expect(p.productId).toBe(LOCAL_PRODUCT_ID)
      expect(['ACTIVE', 'BLOCKED', 'APPROVED', 'CLOSED', 'ACTIVE_IN_ARREARS', 'DORMANT']).toContain(p.accountStatusChangeEvent.accountStatus)
      expect(p.accountStatusChangeEvent.accountStatus).not.toBe('LOCKED')
    }
  })
})
