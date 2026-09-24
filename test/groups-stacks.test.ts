import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { components } from '../src/contract/generated/b2b-types.js'
import { startApp } from './helpers.js'
import { assertValidNotification } from './webhook-schema.js'
import type { BuiltServer } from '../src/server.js'
import type { GroupsService, StacksService } from '../src/domains/groups-stacks/index.js'

type S = components['schemas']
type HayAccount = S['HayAccount']
type HayGroup = S['HayGroup']
type HayJointAccount = S['HayJointAccount']
type HayStack = S['HayStack']
type HayStackTransaction = S['HayStackTransaction']

const GROUP_OPS = ['createHayGroup', 'getHayJointAccountByGroupHayId', 'updateGroup', 'createHayAccountForGroup', 'addCustomersToGroup', 'removeCustomerFromGroup']
const STACK_OPS = ['getAllStacks', 'createStack', 'getAllStackTransactions', 'stackToStackTransfer', 'updateStack', 'closeStack', 'getTransactionsForStack', 'accountToStackTransfer', 'stackToAccountTransfer']
const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111'
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const UUID_RE = /^[0-9a-f-]{36}$/
const ACTIVE_MSG = (id: string) => `PERMISSION_DENIED: Account cannot be created for group with id ${id}, all members of the group should have an ACTIVE status`

let built: BuiltServer
let app: BuiltServer['app']
let groups: GroupsService
let stacks: StacksService
beforeAll(async () => {
  built = await startApp()
  app = built.app
  groups = built.ctx.services.groups
  stacks = built.ctx.services.stacks
})
afterAll(async () => { await built.app.close() })

const services = () => built.ctx.services as unknown as Record<string, unknown>

let n = 0
async function flush(): Promise<void> {
  await app.inject({ method: 'POST', url: '/_admin/flush' })
}
async function post(url: string, payload?: object) {
  return app.inject({ method: 'POST', url, payload })
}
/** An onboarded (ACTIVE) customer; `tag` steers the onboarding outcome (+pending stays PENDING_APPROVAL). */
async function newCustomer(tag = ''): Promise<string> {
  n++
  const res = await post('/v0/customers/create', {
    idempotencyKey: randomUUID(), email: `grp${n}${tag}@example.com`, customerTier: 'STANDARD',
    phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: `6${String(n).padStart(8, '0')}` },
    address: { line1: '1 Test St', townOrCity: 'Sydney', administrativeRegion: 'NSW', postcode: '2000', countryCodeIso: 'AUS' },
    customerDetails: { firstName: 'Grp', lastName: `Member${n}`, dateOfBirth: '1990-01-01' },
  })
  expect(res.statusCode, res.body).toBe(200)
  await flush()
  return res.json().customerHayId as string
}
async function customer(id: string): Promise<S['HayCustomer']> {
  const res = await app.inject({ method: 'GET', url: `/v0/customers/${id}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
async function newGroup(members: string[], overrides: Partial<S['CreateHayGroupRequestBody']> = {}): Promise<HayGroup> {
  const res = await post('/v0/groups/create', { idempotencyKey: randomUUID(), customerHayIds: members, ...overrides })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
async function getGroup(id: string): Promise<HayJointAccount> {
  const res = await app.inject({ method: 'GET', url: `/v0/groups/${id}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
async function newGroupAccount(groupId: string): Promise<HayAccount> {
  const res = await post(`/v0/groups/${groupId}/account`, { idempotencyKey: randomUUID() })
  expect(res.statusCode, res.body).toBe(200)
  return (res.json() as HayJointAccount).hayAccount!
}
/** A personal account with risk level LOW so money can move. */
async function newAccount(holder?: string, opts: { lowRisk?: boolean } = {}): Promise<HayAccount> {
  const holderId = holder ?? (await newCustomer())
  const res = await post('/v1/accounts', { idempotencyKey: randomUUID(), accountHolderId: holderId, accountHolderType: 'CUSTOMER', productId: 'a1b2c3d4-0000-4000-8000-000000000001' })
  expect(res.statusCode, res.body).toBe(200)
  const a = res.json() as HayAccount
  if (opts.lowRisk !== false) await setLowRisk(a.accountHayId!)
  return a
}
async function setLowRisk(accountId: string): Promise<void> {
  const r = await app.inject({ method: 'PATCH', url: `/v0/accounts/${accountId}/riskLevel`, payload: { level: 'LOW', reason: 'test' } })
  expect(r.statusCode, r.body).toBe(200)
}
/** Puts cents on the ledger (and optionally in the stacks column) without a posting: the account stays APPROVED. */
function seedLedger(accountId: string, ledgerCents: number, stacksCents = 0): void {
  built.ctx.db.prepare('UPDATE accounts SET ledger = ?, stacks = ? WHERE id = ?').run(ledgerCents, stacksCents, accountId)
}
async function getAccount(id: string): Promise<HayAccount> {
  const res = await app.inject({ method: 'GET', url: `/v0/accounts/${id}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
async function credit(accountHayId: string, amount: number): Promise<{ outcome: string; transactionId?: string }> {
  const res = await post('/v1/transactions/credit', { idempotencyKey: randomUUID(), accountHayId, amount, counterpartName: 'Payroll', description: 'pay', transactionChannel: 'MANUAL_ADJUSTMENT' })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
async function debit(accountHayId: string, amount: number): Promise<{ outcome: string; transactionId?: string }> {
  const res = await post('/v1/transactions/debit', { idempotencyKey: randomUUID(), accountHayId, amount, counterpartName: 'Fees', description: 'fee', transactionChannel: 'SERVICE_FEE' })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
/** A funded LOW-risk personal account (credit `funds`) with one open stack; returns ids. */
async function fundedWithStack(funds = 100, stackName = 'Holiday'): Promise<{ holder: string; accountId: string; stackId: string }> {
  const holder = await newCustomer()
  const a = await newAccount(holder)
  const accountId = a.accountHayId!
  if (funds > 0) expect((await credit(accountId, funds)).outcome).toBe('ACCEPTED')
  const stackId = await createStack(accountId, stackName)
  return { holder, accountId, stackId }
}
async function createStack(accountId: string, name: string, extra: Partial<S['CreateHayStackRequestBody']> = {}): Promise<string> {
  const res = await post(`/v0/accounts/${accountId}/stacks`, { name, ...extra })
  expect(res.statusCode, res.body).toBe(200)
  expect(res.json()).toBe(true)
  const s = (await listStacks(accountId)).find((x) => x.name === name)
  expect(s, `stack ${name} listed`).toBeDefined()
  return s!.stackHayId!
}
async function listStacks(accountId: string, includeClosed = false): Promise<HayStack[]> {
  const res = await app.inject({ method: 'GET', url: `/v0/accounts/${accountId}/stacks${includeClosed ? '?includeClosed=true' : ''}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
async function stack(accountId: string, stackId: string): Promise<HayStack> {
  const s = (await listStacks(accountId, true)).find((x) => x.stackHayId === stackId)
  expect(s).toBeDefined()
  return s!
}
async function transferIn(accountId: string, stackId: string, body: object) {
  return post(`/v0/accounts/${accountId}/stacks/${stackId}/transfer-in`, body)
}
async function transferOut(accountId: string, stackId: string, body: object) {
  return post(`/v0/accounts/${accountId}/stacks/${stackId}/transfer-out`, body)
}
async function stackTransactions(accountId: string, query = 'offset=0&limit=100', stackId?: string): Promise<HayStackTransaction[]> {
  const url = stackId ? `/v0/accounts/${accountId}/stacks/${stackId}/transactions?${query}` : `/v0/accounts/${accountId}/stacks/transactions?${query}`
  const res = await app.inject({ method: 'GET', url })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
async function allPayloads(): Promise<any[]> {
  await flush()
  const res = await app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })
  return (res.json() as { payload: any }[]).map((r) => r.payload)
}
async function accountEvents(accountId: string): Promise<any[]> {
  return (await allPayloads()).filter((p) => p.type === 'ACCOUNT_STATUS_CHANGE' && p.accountStatusChangeEvent?.accountHayId === accountId)
}
function expectError(res: { statusCode: number; json: () => any; body: string }, status: number, code: RegExp | string): void {
  expect(res.statusCode, res.body).toBe(status)
  const body = res.json()
  expect(body).toMatchObject({ status: String(status), details: expect.stringContaining('traceId') })
  expect(body.traceId).toMatch(UUID_RE)
  expect(body.message).toMatch(code)
}

// ====================================================================== registration

describe('groups-stacks domain: registration', () => {
  it('handles every Groups API and Stacks API operation (none left on the stub)', async () => {
    const res = await app.inject({ method: 'GET', url: '/_admin/operations' })
    const { handled, stubbed } = res.json() as { handled: string[]; stubbed: string[] }
    for (const op of [...GROUP_OPS, ...STACK_OPS]) {
      expect(handled, op).toContain(op)
      expect(stubbed, op).not.toContain(op)
    }
  })

  it('publishes ctx.services.groups with the shape the accounts domain depends on', () => {
    for (const m of ['get', 'require', 'members', 'memberIds', 'isMember', 'requireAllMembersActive', 'groupIdsForCustomer']) expect(typeof (groups as any)[m], m).toBe('function')
    expect(groups.memberIds(UNKNOWN_ID)).toEqual([])
    expect(groups.groupIdsForCustomer(UNKNOWN_ID)).toEqual([])
    expect(() => groups.requireAllMembersActive(UNKNOWN_ID)).toThrow(/NOT_FOUND: Group/)
  })
})

// ====================================================================== groups

describe('createHayGroup (POST /v0/groups/create)', () => {
  it('creates a PERSONAL group by default with a generated name and the members in request order', async () => {
    const [m1, m2] = [await newCustomer(), await newCustomer()]
    const g = await newGroup([m1, m2])
    expect(g.groupHayId).toMatch(UUID_RE)
    expect(g).toEqual({ groupHayId: g.groupHayId, groupName: expect.stringMatching(/^local-client Group \d+$/), groupType: 'PERSONAL', customerHayIds: [m1, m2] })
    expect(groups.members(g.groupHayId!)).toEqual([m1, m2])
    expect(groups.isMember(g.groupHayId!, m1)).toBe(true)
    expect(groups.isMember(g.groupHayId!, UNKNOWN_ID)).toBe(false)
    expect(groups.groupIdsForCustomer(m1)).toEqual([g.groupHayId])
  })

  it('stores BUSINESS groups with their name and business identifiers', async () => {
    const m = await newCustomer()
    const businessIdentifiers = { businessNumber: '51824753556', companyNumber: '123456789' }
    const g = await newGroup([m], { groupName: 'Acme Pty Ltd', groupType: 'BUSINESS', businessIdentifiers })
    expect(g).toEqual({ groupHayId: g.groupHayId, groupName: 'Acme Pty Ltd', groupType: 'BUSINESS', customerHayIds: [m], businessIdentifiers })
  })

  it('collapses duplicate member ids and accepts members that are not yet ACTIVE (only account creation needs ACTIVE)', async () => {
    const m = await newCustomer()
    const pending = await newCustomer('+pending')
    expect((await customer(pending)).status).toBe('PENDING_APPROVAL')
    const g = await newGroup([m, m, pending])
    expect(g.customerHayIds).toEqual([m, pending])
  })

  it('replays the same idempotencyKey + body and refuses the key with a different body (422 IDEMPOTENCY_KEY_REUSED)', async () => {
    const m = await newCustomer()
    const body = { idempotencyKey: randomUUID(), customerHayIds: [m], groupName: 'Twice' }
    const first = await post('/v0/groups/create', body)
    const again = await post('/v0/groups/create', body)
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual(first.json())
    expectError(await post('/v0/groups/create', { ...body, groupName: 'Other' }), 422, /^IDEMPOTENCY_KEY_REUSED/)
  })

  it('refuses an empty member list (422), an unknown member (404), an INACTIVE member (422 PERMISSION_DENIED) and a bad enum (400)', async () => {
    const m = await newCustomer()
    expectError(await post('/v0/groups/create', { idempotencyKey: randomUUID(), customerHayIds: [] }), 422, /^INVALID_ARGUMENT: customerHayIds/)
    expectError(await post('/v0/groups/create', { idempotencyKey: randomUUID(), customerHayIds: [m, UNKNOWN_ID] }), 404, new RegExp(`^NOT_FOUND: Customer ${UNKNOWN_ID}`))
    const closed = await newCustomer()
    expect((await app.inject({ method: 'PATCH', url: `/v0/customers/${closed}/status`, payload: { newStatus: 'INACTIVE' } })).statusCode).toBe(200)
    expectError(await post('/v0/groups/create', { idempotencyKey: randomUUID(), customerHayIds: [closed] }), 422, /^PERMISSION_DENIED: Customer .* INACTIVE/)
    expectError(await post('/v0/groups/create', { idempotencyKey: randomUUID(), customerHayIds: [m], groupType: 'FAMILY' }), 400, /^BAD_REQUEST/)
    expectError(await post('/v0/groups/create', { idempotencyKey: randomUUID(), customerHayIds: [m], businessIdentifiers: { businessNumber: '123' } }), 400, /^BAD_REQUEST/)
  })
})

describe('getHayJointAccountByGroupHayId (GET /v0/groups/{groupHayId})', () => {
  it('returns the group under the HayJointAccount names (name, not groupName) and omits hayAccount while none exists', async () => {
    const m = await newCustomer()
    const g = await newGroup([m], { groupName: 'Joint', groupType: 'BUSINESS', businessIdentifiers: { registeredBodyNumber: '987654321' } })
    const j = await getGroup(g.groupHayId!)
    expect(j).toEqual({ groupHayId: g.groupHayId, name: 'Joint', groupType: 'BUSINESS', customerHayIds: [m], businessIdentifiers: { registeredBodyNumber: '987654321' } })
    expect(j).not.toHaveProperty('hayAccount')
    expect(j).not.toHaveProperty('groupName')
  })

  it('404 for an unknown group and 400 for a malformed id', async () => {
    expectError(await app.inject({ method: 'GET', url: `/v0/groups/${UNKNOWN_ID}` }), 404, new RegExp(`^NOT_FOUND: Group ${UNKNOWN_ID} not found`))
    expectError(await app.inject({ method: 'GET', url: '/v0/groups/not-a-uuid' }), 400, /^BAD_REQUEST/)
  })
})

describe('updateGroup (PATCH /v0/groups/{groupHayId})', () => {
  it('updates only the supplied fields; businessIdentifiers are replaced as a whole', async () => {
    const m = await newCustomer()
    const g = await newGroup([m], { groupName: 'Before', businessIdentifiers: { businessNumber: '51824753556', companyNumber: '123456789' } })
    const r1 = await app.inject({ method: 'PATCH', url: `/v0/groups/${g.groupHayId}`, payload: { groupName: 'After' } })
    expect(r1.statusCode, r1.body).toBe(200)
    expect(r1.json()).toEqual({ ...g, groupName: 'After' })
    const r2 = await app.inject({ method: 'PATCH', url: `/v0/groups/${g.groupHayId}`, payload: { groupType: 'BUSINESS', businessIdentifiers: { registeredSchemeNumber: '111222333' } } })
    expect(r2.json()).toEqual({ groupHayId: g.groupHayId, groupName: 'After', groupType: 'BUSINESS', customerHayIds: [m], businessIdentifiers: { registeredSchemeNumber: '111222333' } })
    const r3 = await app.inject({ method: 'PATCH', url: `/v0/groups/${g.groupHayId}`, payload: {} })
    expect(r3.json()).toEqual(r2.json())
    expect((await getGroup(g.groupHayId!)).name).toBe('After')
  })

  it('validates groupName length (400) and answers 404 for an unknown group', async () => {
    const g = await newGroup([await newCustomer()])
    expectError(await app.inject({ method: 'PATCH', url: `/v0/groups/${g.groupHayId}`, payload: { groupName: '' } }), 400, /^BAD_REQUEST/)
    expectError(await app.inject({ method: 'PATCH', url: `/v0/groups/${g.groupHayId}`, payload: { groupName: 'x'.repeat(101) } }), 400, /^BAD_REQUEST/)
    expectError(await app.inject({ method: 'PATCH', url: `/v0/groups/${UNKNOWN_ID}`, payload: { groupName: 'x' } }), 404, /^NOT_FOUND: Group/)
  })
})

describe('createHayAccountForGroup (POST /v0/groups/{groupHayId}/account)', () => {
  it('creates an APPROVED GROUP-held AUD account and notifies every member with ACCOUNT_STATUS_CHANGE {APPROVED} (PLATFORM)', async () => {
    const [m1, m2] = [await newCustomer(), await newCustomer()]
    const g = await newGroup([m1, m2], { groupName: 'Us' })
    const res = await post(`/v0/groups/${g.groupHayId}/account`, { idempotencyKey: randomUUID(), customData: { purpose: 'rent' } })
    expect(res.statusCode, res.body).toBe(200)
    const j = res.json() as HayJointAccount
    expect(j).toMatchObject({ groupHayId: g.groupHayId, name: 'Us', groupType: 'PERSONAL', customerHayIds: [m1, m2] })
    expect(j.hayAccount).toMatchObject({ accountHolderType: 'GROUP', accountHolderId: g.groupHayId, status: 'APPROVED', currency: 'AUD', bsb: '636220', totalBalance: 0, stacksBalance: 0 })
    expect(j.hayAccount!.creationDateTimeUtc).toMatch(ISO_MICROS)
    // customData is stored (visible through expand) but not echoed on the joint account body (spec §5.2)
    expect(j.hayAccount).not.toHaveProperty('customData')
    const expanded = await app.inject({ method: 'GET', url: `/v0/accounts/${j.hayAccount!.accountHayId}?expand=customData` })
    expect(expanded.json().customData).toEqual({ purpose: 'rent' })
    expect((await getGroup(g.groupHayId!)).hayAccount!.accountHayId).toBe(j.hayAccount!.accountHayId)

    const events = await accountEvents(j.hayAccount!.accountHayId!)
    expect(events.map((e) => e.customerHayId).sort()).toEqual([m1, m2].sort())
    for (const e of events) {
      expect(e).toMatchObject({ type: 'ACCOUNT_STATUS_CHANGE', actionOwner: 'PLATFORM', accountStatusChangeEvent: { accountHayId: j.hayAccount!.accountHayId, accountStatus: 'APPROVED' } })
      assertValidNotification(e)
    }
  })

  it("422 with the spec's verbatim message when any member is not ACTIVE; 404 for an unknown group", async () => {
    const [m, pending] = [await newCustomer(), await newCustomer('+pending')]
    const g = await newGroup([m, pending])
    expectError(await post(`/v0/groups/${g.groupHayId}/account`, { idempotencyKey: randomUUID() }), 422, ACTIVE_MSG(g.groupHayId!))
    expect((await getGroup(g.groupHayId!))).not.toHaveProperty('hayAccount')
    // the v1 create path runs the same gate through ctx.services.groups
    expectError(await post('/v1/accounts', { idempotencyKey: randomUUID(), accountHolderId: g.groupHayId, accountHolderType: 'GROUP', productId: 'a1b2c3d4-0000-4000-8000-000000000001' }), 422, ACTIVE_MSG(g.groupHayId!))
    // a BLOCKED member blocks creation too
    const blocked = await newCustomer()
    expect((await post(`/v0/customers/${blocked}/block`, { note: 'x' })).statusCode).toBe(200)
    const g2 = await newGroup([m, blocked])
    expectError(await post(`/v0/groups/${g2.groupHayId}/account`, { idempotencyKey: randomUUID() }), 422, ACTIVE_MSG(g2.groupHayId!))
    expectError(await post(`/v0/groups/${UNKNOWN_ID}/account`, { idempotencyKey: randomUUID() }), 404, /^NOT_FOUND: Group/)
  })

  it('replays by idempotencyKey; a second key creates a second account and GET keeps returning the first-created one', async () => {
    const g = await newGroup([await newCustomer()])
    const body = { idempotencyKey: randomUUID() }
    const first = (await post(`/v0/groups/${g.groupHayId}/account`, body)).json() as HayJointAccount
    const replay = (await post(`/v0/groups/${g.groupHayId}/account`, body)).json() as HayJointAccount
    expect(replay.hayAccount!.accountHayId).toBe(first.hayAccount!.accountHayId)
    expectError(await post(`/v0/groups/${g.groupHayId}/account`, { ...body, customData: { a: 1 } }), 422, /^IDEMPOTENCY_KEY_REUSED/)
    const second = (await post(`/v0/groups/${g.groupHayId}/account`, { idempotencyKey: randomUUID() })).json() as HayJointAccount
    expect(second.hayAccount!.accountHayId).not.toBe(first.hayAccount!.accountHayId)
    expect((await getGroup(g.groupHayId!)).hayAccount!.accountHayId).toBe(first.hayAccount!.accountHayId)
    expect(groups.accounts(g.groupHayId!).map((a) => a.id)).toEqual([first.hayAccount!.accountHayId, second.hayAccount!.accountHayId])
  })

  it('v1 createAccount with a GROUP holder works through the published service and lists under the group', async () => {
    const [m1, m2] = [await newCustomer(), await newCustomer()]
    const g = await newGroup([m1, m2])
    const res = await post('/v1/accounts', { idempotencyKey: randomUUID(), accountHolderId: g.groupHayId, accountHolderType: 'GROUP', productId: 'a1b2c3d4-0000-4000-8000-000000000001' })
    expect(res.statusCode, res.body).toBe(200)
    const a = res.json() as HayAccount
    expect((await getGroup(g.groupHayId!)).hayAccount!.accountHayId).toBe(a.accountHayId)
    expect((await accountEvents(a.accountHayId!)).map((e) => e.customerHayId).sort()).toEqual([m1, m2].sort())
  })
})

describe('addCustomersToGroup (POST /v0/groups/{groupHayId}/addCustomers)', () => {
  it('appends new members (existing ones and duplicates ignored) and returns the joint account', async () => {
    const [m1, m2, m3] = [await newCustomer(), await newCustomer(), await newCustomer()]
    const g = await newGroup([m1])
    const a = await newGroupAccount(g.groupHayId!)
    const res = await post(`/v0/groups/${g.groupHayId}/addCustomers`, { customerHayIds: [m2, m1, m3, m2] })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ groupHayId: g.groupHayId, customerHayIds: [m1, m2, m3], hayAccount: { accountHayId: a.accountHayId } })
    expect(groups.groupIdsForCustomer(m3)).toEqual([g.groupHayId])
    // the new member now owns the account: it is notified of its status changes and may move its money
    expect(built.ctx.services.accounts.holderCustomerIds(built.ctx.services.accounts.get(a.accountHayId!))).toEqual([m1, m2, m3])
    const empty = await post(`/v0/groups/${g.groupHayId}/addCustomers`, { customerHayIds: [] })
    expect(empty.statusCode).toBe(200)
    expect(empty.json().customerHayIds).toEqual([m1, m2, m3])
  })

  it('404 for an unknown customer or group; 422 for a REJECTED / INACTIVE customer (nothing added)', async () => {
    const m = await newCustomer()
    const g = await newGroup([m])
    expectError(await post(`/v0/groups/${g.groupHayId}/addCustomers`, { customerHayIds: [UNKNOWN_ID] }), 404, /^NOT_FOUND: Customer/)
    const rejected = await newCustomer('+rejected')
    expect((await customer(rejected)).status).toBe('REJECTED')
    const other = await newCustomer()
    expectError(await post(`/v0/groups/${g.groupHayId}/addCustomers`, { customerHayIds: [other, rejected] }), 422, /^PERMISSION_DENIED: Customer .* REJECTED/)
    expect(groups.members(g.groupHayId!)).toEqual([m])
    expectError(await post(`/v0/groups/${UNKNOWN_ID}/addCustomers`, { customerHayIds: [m] }), 404, /^NOT_FOUND: Group/)
  })
})

describe('removeCustomerFromGroup (POST /v0/groups/{groupHayId}/removeCustomer)', () => {
  it('removes the member and returns the joint account; a customer with an open personal account stays ACTIVE', async () => {
    const [m1, m2] = [await newCustomer(), await newCustomer()]
    await newAccount(m2, { lowRisk: false })
    const g = await newGroup([m1, m2])
    const a = await newGroupAccount(g.groupHayId!)
    const res = await post(`/v0/groups/${g.groupHayId}/removeCustomer`, { customerId: m2 })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ groupHayId: g.groupHayId, customerHayIds: [m1], hayAccount: { accountHayId: a.accountHayId } })
    expect(groups.groupIdsForCustomer(m2)).toEqual([])
    expect((await customer(m2)).status).toBe('ACTIVE')
  })

  it('cascades the customer to INACTIVE (PLATFORM, no webhook by default) when only CLOSED accounts remain linked', async () => {
    const [m1, m2] = [await newCustomer(), await newCustomer()]
    const personal = await newAccount(m2, { lowRisk: false })
    const g = await newGroup([m1, m2])
    await newGroupAccount(g.groupHayId!) // the open group account keeps m2 ACTIVE while it is a member
    expect((await post(`/v0/accounts/${personal.accountHayId}/close`)).statusCode).toBe(202)
    await flush()
    expect((await getAccount(personal.accountHayId!)).status).toBe('CLOSED')
    expect((await customer(m2)).status).toBe('ACTIVE')
    const before = (await allPayloads()).length
    expect((await post(`/v0/groups/${g.groupHayId}/removeCustomer`, { customerId: m2 })).statusCode).toBe(200)
    expect(await customer(m2)).toMatchObject({ status: 'INACTIVE' })
    expect((await customer(m2)).closedDateTimeUtc).toMatch(ISO_MICROS)
    expect((await customer(m1)).status).toBe('ACTIVE')
    expect((await allPayloads()).length).toBe(before) // config.emitCustomerInactive is off
  })

  it('a customer with no linked account at all keeps its status; a member of another group with an open account stays ACTIVE', async () => {
    const [m1, m2, m3] = [await newCustomer(), await newCustomer(), await newCustomer()]
    const g = await newGroup([m1, m2])
    expect((await post(`/v0/groups/${g.groupHayId}/removeCustomer`, { customerId: m2 })).statusCode).toBe(200)
    expect((await customer(m2)).status).toBe('ACTIVE')
    const other = await newGroup([m3, m1])
    await newGroupAccount(other.groupHayId!)
    const g2 = await newGroup([m3, m1])
    expect((await post(`/v0/groups/${g2.groupHayId}/removeCustomer`, { customerId: m1 })).statusCode).toBe(200)
    expect((await customer(m1)).status).toBe('ACTIVE')
  })

  it('cancels the cards the customer holds on the group accounts through the cards service when it offers the cascade', async () => {
    const [m1, m2] = [await newCustomer(), await newCustomer()]
    const g = await newGroup([m1, m2])
    const a1 = await newGroupAccount(g.groupHayId!)
    const a2 = (await post(`/v0/groups/${g.groupHayId}/account`, { idempotencyKey: randomUUID() })).json().hayAccount as HayAccount
    const cancelForCustomerOnAccount = vi.fn()
    const previous = services().cards
    services().cards = { ...(previous as object | undefined), cancelForCustomerOnAccount }
    try {
      expect((await post(`/v0/groups/${g.groupHayId}/removeCustomer`, { customerId: m2 })).statusCode).toBe(200)
    } finally {
      if (previous === undefined) delete services().cards
      else services().cards = previous
    }
    expect(cancelForCustomerOnAccount.mock.calls).toEqual([[m2, a1.accountHayId, expect.any(String)], [m2, a2.accountHayId, expect.any(String)]])
  })

  it('emits CUSTOMER_STATUS_UPDATED {INACTIVE} (PLATFORM) for the cascade when config.emitCustomerInactive is on', async () => {
    const other = await startApp({ emitCustomerInactive: true })
    try {
      const mk = async (i: number) => {
        const res = await other.app.inject({
          method: 'POST', url: '/v0/customers/create',
          payload: {
            idempotencyKey: randomUUID(), email: `rm${i}@example.com`, customerTier: 'STANDARD',
            phoneNumber: { countryCodePrefix: '61', numberAfterPrefix: `41000000${i}` },
            address: { line1: '1', townOrCity: 'S', administrativeRegion: 'NSW', postcode: '2000', countryCodeIso: 'AUS' },
            customerDetails: { firstName: 'R', lastName: `M${i}`, dateOfBirth: '1990-01-01' },
          },
        })
        expect(res.statusCode, res.body).toBe(200)
        await other.app.inject({ method: 'POST', url: '/_admin/flush' })
        return res.json().customerHayId as string
      }
      const [m1, m2] = [await mk(1), await mk(2)]
      const acct = await other.app.inject({ method: 'POST', url: '/v1/accounts', payload: { idempotencyKey: randomUUID(), accountHolderId: m2, accountHolderType: 'CUSTOMER', productId: 'a1b2c3d4-0000-4000-8000-000000000001' } })
      expect(acct.statusCode, acct.body).toBe(200)
      const g = (await other.app.inject({ method: 'POST', url: '/v0/groups/create', payload: { idempotencyKey: randomUUID(), customerHayIds: [m1, m2] } })).json() as HayGroup
      expect((await other.app.inject({ method: 'POST', url: `/v0/groups/${g.groupHayId}/account`, payload: { idempotencyKey: randomUUID() } })).statusCode).toBe(200)
      expect((await other.app.inject({ method: 'POST', url: `/v0/accounts/${acct.json().accountHayId}/close` })).statusCode).toBe(202)
      await other.app.inject({ method: 'POST', url: '/_admin/flush' })
      const rm = await other.app.inject({ method: 'POST', url: `/v0/groups/${g.groupHayId}/removeCustomer`, payload: { customerId: m2 } })
      expect(rm.statusCode, rm.body).toBe(200)
      await other.app.inject({ method: 'POST', url: '/_admin/flush' })
      const payloads = ((await other.app.inject({ method: 'GET', url: '/_admin/notifications?type=CUSTOMER_STATUS_UPDATED' })).json() as { payload: any }[]).map((r) => r.payload)
      const inactive = payloads.filter((p) => p.customerHayId === m2 && p.customerStatusUpdatedEvent.customerStatus === 'INACTIVE')
      expect(inactive).toHaveLength(1)
      expect(inactive[0]).toMatchObject({ type: 'CUSTOMER_STATUS_UPDATED', actionOwner: 'PLATFORM' })
      assertValidNotification(inactive[0])
    } finally {
      await other.app.close()
    }
  })

  it('refuses a non-member (422 NOT_A_MEMBER), the final member (422 LAST_GROUP_MEMBER) and unknown ids (404)', async () => {
    const [m1, m2] = [await newCustomer(), await newCustomer()]
    const g = await newGroup([m1])
    expectError(await post(`/v0/groups/${g.groupHayId}/removeCustomer`, { customerId: m2 }), 422, /^NOT_A_MEMBER: Customer/)
    expectError(await post(`/v0/groups/${g.groupHayId}/removeCustomer`, { customerId: m1 }), 422, /^LAST_GROUP_MEMBER: Customer/)
    expect(groups.members(g.groupHayId!)).toEqual([m1])
    expectError(await post(`/v0/groups/${g.groupHayId}/removeCustomer`, { customerId: UNKNOWN_ID }), 404, /^NOT_FOUND: Customer/)
    expectError(await post(`/v0/groups/${UNKNOWN_ID}/removeCustomer`, { customerId: m1 }), 404, /^NOT_FOUND: Group/)
  })
})

describe('group accounts and the accounts domain', () => {
  it('closing the group account deactivates members without another open account and blocks every member on blockAccount', async () => {
    const [m1, m2] = [await newCustomer(), await newCustomer()]
    await newAccount(m1, { lowRisk: false })
    const g = await newGroup([m1, m2])
    const a = await newGroupAccount(g.groupHayId!)
    expect((await post(`/v0/accounts/${a.accountHayId}/block`, { note: 'freeze' })).statusCode).toBe(200)
    expect((await customer(m1)).status).toBe('BLOCKED')
    expect((await customer(m2)).status).toBe('BLOCKED')
    expect((await post(`/v0/accounts/${a.accountHayId}/unblock`, { note: 'thaw' })).statusCode).toBe(200)
    expect((await customer(m2)).status).toBe('ACTIVE')
    expect((await post(`/v0/accounts/${a.accountHayId}/close`, { reason: 'CUSTOMER' })).statusCode).toBe(202)
    await flush()
    expect((await getAccount(a.accountHayId!)).status).toBe('CLOSED')
    expect((await customer(m1)).status).toBe('ACTIVE') // still holds an open personal account
    expect(await customer(m2)).toMatchObject({ status: 'INACTIVE', statusReason: 'CUSTOMER' })
  })
})

// ====================================================================== stacks

describe('createStack / getAllStacks', () => {
  it('createStack answers the bare true of the spec; the stack is OPEN with balance 0 and found through getAllStacks', async () => {
    const a = await newAccount()
    expect(await listStacks(a.accountHayId!)).toEqual([])
    const res = await post(`/v0/accounts/${a.accountHayId}/stacks`, { name: 'Holiday', imageUrl: 'https://img/holiday.png', targetAmount: 1500.5 })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.body).toBe('true')
    const list = await listStacks(a.accountHayId!)
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({ stackHayId: expect.stringMatching(UUID_RE), accountHayId: a.accountHayId, name: 'Holiday', imageUrl: 'https://img/holiday.png', targetAmount: 1500.5, balance: 0, status: 'OPEN', createdAtUtc: expect.stringMatching(ISO_MICROS) })
    expect(list[0]).not.toHaveProperty('closedAtUtc')
    // optional fields are omitted when absent; creation order is kept
    await createStack(a.accountHayId!, 'Car')
    const [, car] = await listStacks(a.accountHayId!)
    expect(car).not.toHaveProperty('imageUrl')
    expect(car).not.toHaveProperty('targetAmount')
    expect(car!.name).toBe('Car')
  })

  it('validates the name (400 length, 422 emoji, 422 STACK_NAME_ALREADY_IN_USE among open stacks; a closed stack frees its name)', async () => {
    const a = await newAccount()
    const id = a.accountHayId!
    expectError(await post(`/v0/accounts/${id}/stacks`, { name: '' }), 400, /^BAD_REQUEST/)
    expectError(await post(`/v0/accounts/${id}/stacks`, { name: 'x'.repeat(21) }), 400, /^BAD_REQUEST/)
    expectError(await post(`/v0/accounts/${id}/stacks`, {}), 400, /^BAD_REQUEST/)
    expectError(await post(`/v0/accounts/${id}/stacks`, { name: 'Fun 🎉' }), 422, /^INVALID_ARGUMENT: Stack names cannot contain emojis/)
    const stackId = await createStack(id, 'Rainy day')
    expectError(await post(`/v0/accounts/${id}/stacks`, { name: 'Rainy day' }), 422, /^STACK_NAME_ALREADY_IN_USE/)
    expect((await post(`/v0/accounts/${id}/stacks/${stackId}/close`)).statusCode).toBe(200)
    expect((await post(`/v0/accounts/${id}/stacks`, { name: 'Rainy day' })).statusCode).toBe(200)
    expect((await listStacks(id)).map((s) => s.name)).toEqual(['Rainy day'])
    expect((await listStacks(id, true)).map((s) => s.status)).toEqual(['CLOSED', 'OPEN'])
  })

  it('validates targetAmount: negative 400 (schema), > 2 dp 400, above the MAX_BALANCE limit 422', async () => {
    const a = await newAccount()
    const id = a.accountHayId!
    expectError(await post(`/v0/accounts/${id}/stacks`, { name: 'A', targetAmount: -1 }), 400, /^BAD_REQUEST/)
    expectError(await post(`/v0/accounts/${id}/stacks`, { name: 'A', targetAmount: 10.005 }), 400, /^BAD_REQUEST: targetAmount/)
    expect((await post(`/v0/accounts/${id}/stacks`, { name: 'Zero', targetAmount: 0 })).statusCode).toBe(200)
    expect((await post(`/v0/accounts/${id}/stacks`, { name: 'Max', targetAmount: 1_000_000 })).statusCode).toBe(200)
    expectError(await post(`/v0/accounts/${id}/stacks`, { name: 'Over', targetAmount: 1_000_000.01 }), 422, /^INVALID_ARGUMENT: targetAmount .* MAX_BALANCE/)
    expect((await app.inject({ method: 'PUT', url: `/v1/accounts/${id}/limits/MAX_BALANCE`, payload: { limitAmount: 500 } })).statusCode).toBe(200)
    expectError(await post(`/v0/accounts/${id}/stacks`, { name: 'Over2', targetAmount: 500.01 }), 422, /^INVALID_ARGUMENT: targetAmount 500.01 exceeds the account's MAX_BALANCE limit 500/)
  })

  it('needs an existing, non-CLOSED account (404 / 422 ACCOUNT_CLOSED); a LOCKED account may still create stacks', async () => {
    expectError(await post(`/v0/accounts/${UNKNOWN_ID}/stacks`, { name: 'A' }), 404, /^NOT_FOUND: Account/)
    expectError(await app.inject({ method: 'GET', url: `/v0/accounts/${UNKNOWN_ID}/stacks` }), 404, /^NOT_FOUND: Account/)
    const a = await newAccount()
    const id = a.accountHayId!
    expect((await post(`/v0/accounts/${id}/block`, { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' })).statusCode).toBe(200)
    expect((await post(`/v0/accounts/${id}/stacks`, { name: 'While locked' })).statusCode).toBe(200)
    expect((await post(`/v0/accounts/${id}/unblock`, { note: 'x' })).statusCode).toBe(200)
    expect((await post(`/v0/accounts/${id}/close`)).statusCode).toBe(202)
    await flush()
    expectError(await post(`/v0/accounts/${id}/stacks`, { name: 'After close' }), 422, /^ACCOUNT_CLOSED/)
  })
})

describe('updateStack (PUT /v0/accounts/{accountId}/stacks/{stackId})', () => {
  it('updates the supplied fields and returns the Stack projection (hayId, not stackHayId)', async () => {
    const { accountId, stackId } = await fundedWithStack(0, 'Old')
    const res = await app.inject({ method: 'PUT', url: `/v0/accounts/${accountId}/stacks/${stackId}`, payload: { name: 'New', targetAmount: 25 } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ stack: { hayId: stackId, accountHayId: accountId, name: 'New', targetAmount: 25, balance: 0, status: 'OPEN', createdAtUtc: expect.stringMatching(ISO_MICROS) } })
    expect(res.json()).not.toHaveProperty('error')
    const r2 = await app.inject({ method: 'PUT', url: `/v0/accounts/${accountId}/stacks/${stackId}`, payload: { imageUrl: 'https://img/new.png' } })
    expect(r2.json().stack).toMatchObject({ name: 'New', targetAmount: 25, imageUrl: 'https://img/new.png' })
    expect((await stack(accountId, stackId))).toMatchObject({ stackHayId: stackId, name: 'New', imageUrl: 'https://img/new.png', targetAmount: 25 })
    // renaming to its own name is fine
    expect((await app.inject({ method: 'PUT', url: `/v0/accounts/${accountId}/stacks/${stackId}`, payload: { name: 'New' } })).statusCode).toBe(200)
  })

  it('reports a name clash inside the 200 body (error STACK_NAME_ALREADY_IN_USE, no stack) and leaves the stack unchanged', async () => {
    const { accountId, stackId } = await fundedWithStack(0, 'One')
    await createStack(accountId, 'Two')
    const res = await app.inject({ method: 'PUT', url: `/v0/accounts/${accountId}/stacks/${stackId}`, payload: { name: 'Two', targetAmount: 9 } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ error: 'STACK_NAME_ALREADY_IN_USE' })
    expect(await stack(accountId, stackId)).toMatchObject({ name: 'One' })
    expect(await stack(accountId, stackId)).not.toHaveProperty('targetAmount')
  })

  it('400 for schema violations, 404 for an unknown stack or one on another account, 422 STACK_CLOSED once closed, 422 for emoji names', async () => {
    const { accountId, stackId } = await fundedWithStack(0)
    const other = await newAccount()
    expectError(await app.inject({ method: 'PUT', url: `/v0/accounts/${accountId}/stacks/${stackId}`, payload: { name: 'x'.repeat(21) } }), 400, /^BAD_REQUEST/)
    expectError(await app.inject({ method: 'PUT', url: `/v0/accounts/${accountId}/stacks/${stackId}`, payload: { name: '🚀' } }), 422, /^INVALID_ARGUMENT: Stack names/)
    expectError(await app.inject({ method: 'PUT', url: `/v0/accounts/${accountId}/stacks/${UNKNOWN_ID}`, payload: { name: 'x' } }), 404, new RegExp(`^NOT_FOUND: Stack ${UNKNOWN_ID}`))
    expectError(await app.inject({ method: 'PUT', url: `/v0/accounts/${other.accountHayId}/stacks/${stackId}`, payload: { name: 'x' } }), 404, /^NOT_FOUND: Stack/)
    expect((await post(`/v0/accounts/${accountId}/stacks/${stackId}/close`)).statusCode).toBe(200)
    expectError(await app.inject({ method: 'PUT', url: `/v0/accounts/${accountId}/stacks/${stackId}`, payload: { name: 'x' } }), 422, /^STACK_CLOSED/)
  })
})

describe('accountToStackTransfer (transfer-in)', () => {
  it('moves available funds into the stack (total unchanged), records a +amount STANDARD transaction and activates an APPROVED account', async () => {
    const { holder, accountId, stackId } = await fundedWithStack(100)
    // a general credit already made the account ACTIVE; use a fresh APPROVED account funded directly on the ledger
    const approved = await newAccount(holder)
    const s2 = await createStack(approved.accountHayId!, 'Goal')
    seedLedger(approved.accountHayId!, 5000)
    expect(await getAccount(approved.accountHayId!)).toMatchObject({ status: 'APPROVED', totalBalance: 50 })

    const res = await transferIn(approved.accountHayId!, s2, { amount: 12.34, customerId: holder, description: 'first' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ outcome: 'ACCEPTED', transactionId: expect.stringMatching(UUID_RE) })
    expect(await getAccount(approved.accountHayId!)).toMatchObject({ status: 'ACTIVE', totalBalance: 50, availableBalance: 37.66, stacksBalance: 12.34, heldBalance: 0 })
    expect(await stack(approved.accountHayId!, s2)).toMatchObject({ balance: 12.34, status: 'OPEN' })
    const active = (await accountEvents(approved.accountHayId!)).filter((e) => e.accountStatusChangeEvent.accountStatus === 'ACTIVE')
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ customerHayId: holder, actionOwner: 'PLATFORM' })
    assertValidNotification(active[0])

    const [t] = await stackTransactions(approved.accountHayId!)
    expect(t).toEqual({
      hayId: res.json().transactionId, accountHayId: approved.accountHayId, stackHayId: s2, amount: 12.34, customerId: holder, notes: 'first', originType: 'CUSTOMER', type: 'STANDARD',
      transactionTimeUtc: expect.stringMatching(ISO_MICROS), stack: expect.objectContaining({ stackHayId: s2, balance: 12.34 }),
    })
    // the earlier ACTIVE account: plain move, no second ACTIVE event
    expect((await transferIn(accountId, stackId, { amount: 40, customerId: holder })).json().outcome).toBe('ACCEPTED')
    expect(await getAccount(accountId)).toMatchObject({ totalBalance: 100, availableBalance: 60, stacksBalance: 40 })
    expect((await accountEvents(accountId)).filter((e) => e.accountStatusChangeEvent.accountStatus === 'ACTIVE')).toHaveLength(1)
  })

  it('refuses with REFUSED_INSUFFICIENT_FUNDS (200, no transactionId, nothing recorded) when the amount exceeds availableBalance', async () => {
    const { holder, accountId, stackId } = await fundedWithStack(50)
    const res = await transferIn(accountId, stackId, { amount: 50.01, customerId: holder })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ outcome: 'REFUSED_INSUFFICIENT_FUNDS' })
    expect(await stackTransactions(accountId)).toEqual([])
    expect(await getAccount(accountId)).toMatchObject({ availableBalance: 50, stacksBalance: 0 })
    expect((await transferIn(accountId, stackId, { amount: 50, customerId: holder })).json().outcome).toBe('ACCEPTED')
    expect((await transferIn(accountId, stackId, { amount: 0.01, customerId: holder })).json()).toEqual({ outcome: 'REFUSED_INSUFFICIENT_FUNDS' })
  })

  it('stacked money is never spendable, still counts toward MAX_BALANCE, and stack moves ignore limits', async () => {
    const { holder, accountId, stackId } = await fundedWithStack(80)
    expect((await app.inject({ method: 'PUT', url: `/v1/accounts/${accountId}/limits/MAX_BALANCE`, payload: { limitAmount: 100 } })).statusCode).toBe(200)
    expect((await transferIn(accountId, stackId, { amount: 50, customerId: holder })).json().outcome).toBe('ACCEPTED')
    expect(await getAccount(accountId)).toMatchObject({ totalBalance: 80, availableBalance: 30, stacksBalance: 50 })
    expect((await debit(accountId, 30.01)).outcome).toBe('REFUSED_INSUFFICIENT_FUNDS')
    expect((await debit(accountId, 30)).outcome).toBe('ACCEPTED')
    expect((await credit(accountId, 50.01)).outcome).toBe('REFUSED_MAX_BALANCE_EXCEEDED') // ledger 50 (all in the stack) + 50.01 > 100
    expect((await credit(accountId, 50)).outcome).toBe('ACCEPTED')
    // a HIGH-risk account (every limit 0) may still move its own money into a stack
    const holder2 = await newCustomer()
    const high = await newAccount(holder2, { lowRisk: false })
    built.ctx.services.accounts.adjust(high.accountHayId!, { ledgerDelta: 1000 })
    const s = await createStack(high.accountHayId!, 'Safe')
    expect((await transferIn(high.accountHayId!, s, { amount: 10, customerId: holder2 })).json().outcome).toBe('ACCEPTED')
    // overdraft funds can be stacked (availableBalance includes the unused limit)
    const od = await newAccount(holder2)
    expect((await app.inject({ method: 'PATCH', url: `/v0/accounts/${od.accountHayId}/overdraft`, payload: { overdraftLimit: 20 } })).statusCode).toBe(200)
    const s3 = await createStack(od.accountHayId!, 'Borrowed')
    expect((await transferIn(od.accountHayId!, s3, { amount: 15, customerId: holder2 })).json().outcome).toBe('ACCEPTED')
    expect(await getAccount(od.accountHayId!)).toMatchObject({ totalBalance: 20, availableBalance: 5, stacksBalance: 15, overdraftBalance: 0 })
  })

  it('validates the request: amount 400 (0, negative, 3 dp, missing), customer 404 / 422 PERMISSION_DENIED, account 422 ACCOUNT_BLOCKED / ACCOUNT_CLOSED, stack 404 / 422 STACK_CLOSED', async () => {
    const { holder, accountId, stackId } = await fundedWithStack(100)
    for (const amount of [0, -5, 1.005]) expectError(await transferIn(accountId, stackId, { amount, customerId: holder }), 400, /^BAD_REQUEST: amount/)
    expectError(await transferIn(accountId, stackId, { customerId: holder }), 400, /^BAD_REQUEST/)
    expectError(await transferIn(accountId, stackId, { amount: 1, customerId: holder, description: 'x'.repeat(21) }), 400, /^BAD_REQUEST/)
    expectError(await transferIn(accountId, stackId, { amount: 1, customerId: UNKNOWN_ID }), 404, /^NOT_FOUND: Customer/)
    const stranger = await newCustomer()
    expectError(await transferIn(accountId, stackId, { amount: 1, customerId: stranger }), 422, new RegExp(`^PERMISSION_DENIED: Customer ${stranger} does not hold account ${accountId}`))
    expectError(await transferIn(accountId, UNKNOWN_ID, { amount: 1, customerId: holder }), 404, /^NOT_FOUND: Stack/)
    expectError(await transferIn(UNKNOWN_ID, stackId, { amount: 1, customerId: holder }), 404, /^NOT_FOUND: Stack/)
    expect((await post(`/v0/accounts/${accountId}/block`, { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' })).statusCode).toBe(200)
    expectError(await transferIn(accountId, stackId, { amount: 1, customerId: holder }), 422, new RegExp(`^ACCOUNT_BLOCKED: Account ${accountId} is LOCKED`))
    expect((await post(`/v0/accounts/${accountId}/unblock`, { note: 'x' })).statusCode).toBe(200)
    expect((await post(`/v0/accounts/${accountId}/stacks/${stackId}/close`)).statusCode).toBe(200)
    expectError(await transferIn(accountId, stackId, { amount: 1, customerId: holder }), 422, /^STACK_CLOSED/)
    expect((await debit(accountId, 100)).outcome).toBe('ACCEPTED')
    expect((await post(`/v0/accounts/${accountId}/close`)).statusCode).toBe(202)
    await flush()
    const s2 = UNKNOWN_ID
    expectError(await transferIn(accountId, s2, { amount: 1, customerId: holder }), 404, /^NOT_FOUND: Stack/)
    expect(await stackTransactions(accountId)).toEqual([])
  })

  it('any member may move money on a group account', async () => {
    const [m1, m2] = [await newCustomer(), await newCustomer()]
    const g = await newGroup([m1, m2])
    const a = await newGroupAccount(g.groupHayId!)
    await setLowRisk(a.accountHayId!)
    expect((await credit(a.accountHayId!, 30)).outcome).toBe('ACCEPTED')
    const s = await createStack(a.accountHayId!, 'Shared')
    expect((await transferIn(a.accountHayId!, s, { amount: 10, customerId: m2 })).json().outcome).toBe('ACCEPTED')
    expect((await transferOut(a.accountHayId!, s, { amount: 4, customerId: m1 })).json().outcome).toBe('ACCEPTED')
    expect((await getGroup(g.groupHayId!)).hayAccount).toMatchObject({ totalBalance: 30, availableBalance: 24, stacksBalance: 6 })
    const outsider = await newCustomer()
    expectError(await transferIn(a.accountHayId!, s, { amount: 1, customerId: outsider }), 422, /^PERMISSION_DENIED/)
  })
})

describe('stackToAccountTransfer (transfer-out)', () => {
  it('returns stack funds to the account (available +a, stacks −a) with a −amount record; refuses beyond the stack balance', async () => {
    const { holder, accountId, stackId } = await fundedWithStack(100)
    expect((await transferIn(accountId, stackId, { amount: 60, customerId: holder })).json().outcome).toBe('ACCEPTED')
    const res = await transferOut(accountId, stackId, { amount: 25.5, customerId: holder, description: 'back' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ outcome: 'ACCEPTED', transactionId: expect.stringMatching(UUID_RE) })
    expect(await getAccount(accountId)).toMatchObject({ totalBalance: 100, availableBalance: 65.5, stacksBalance: 34.5 })
    expect(await stack(accountId, stackId)).toMatchObject({ balance: 34.5 })
    const [latest] = await stackTransactions(accountId, 'offset=0&limit=1')
    expect(latest).toMatchObject({ hayId: res.json().transactionId, amount: -25.5, notes: 'back', customerId: holder, originType: 'CUSTOMER', type: 'STANDARD' })
    expect((await transferOut(accountId, stackId, { amount: 34.51, customerId: holder })).json()).toEqual({ outcome: 'REFUSED_INSUFFICIENT_FUNDS' })
    expect((await transferOut(accountId, stackId, { amount: 34.5, customerId: holder })).json().outcome).toBe('ACCEPTED')
    expect(await getAccount(accountId)).toMatchObject({ availableBalance: 100, stacksBalance: 0 })
    expect(await stackTransactions(accountId)).toHaveLength(3)
    expectError(await transferOut(accountId, stackId, { amount: 0, customerId: holder }), 400, /^BAD_REQUEST: amount/)
    const stranger = await newCustomer()
    expectError(await transferOut(accountId, stackId, { amount: 1, customerId: stranger }), 422, /^PERMISSION_DENIED/)
    expect((await post(`/v0/accounts/${accountId}/block`, { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' })).statusCode).toBe(200)
    expectError(await transferOut(accountId, stackId, { amount: 1, customerId: holder }), 422, /^ACCOUNT_BLOCKED/)
  })
})

describe('stackToStackTransfer (POST /v0/accounts/{accountId}/stacks/transactions)', () => {
  it('moves funds between two stacks with a withdrawal and a deposit cross-linked by counterpartTransactionId; account balances unchanged', async () => {
    const { holder, accountId, stackId: from } = await fundedWithStack(100, 'From')
    const to = await createStack(accountId, 'To')
    expect((await transferIn(accountId, from, { amount: 70, customerId: holder })).json().outcome).toBe('ACCEPTED')
    const before = await getAccount(accountId)
    const res = await post(`/v0/accounts/${accountId}/stacks/transactions`, { amount: 45.25, customerId: holder, withdrawalStackId: from, depositStackId: to, description: 'rebalance' })
    expect(res.statusCode, res.body).toBe(200)
    const out = res.json() as S['StackToStackTransactionOutcome']
    expect(out).toEqual({ outcome: 'ACCEPTED', withdrawalTransactionId: expect.stringMatching(UUID_RE), depositTransactionId: expect.stringMatching(UUID_RE) })
    expect(out.withdrawalTransactionId).not.toBe(out.depositTransactionId)
    expect(await getAccount(accountId)).toMatchObject({ totalBalance: before.totalBalance, availableBalance: before.availableBalance, stacksBalance: 70 })
    expect(await stack(accountId, from)).toMatchObject({ balance: 24.75 })
    expect(await stack(accountId, to)).toMatchObject({ balance: 45.25 })

    const [w] = await stackTransactions(accountId, 'offset=0&limit=10', from)
    const [d] = await stackTransactions(accountId, 'offset=0&limit=10', to)
    expect(w).toMatchObject({ hayId: out.withdrawalTransactionId, stackHayId: from, amount: -45.25, counterpartTransactionId: out.depositTransactionId, notes: 'rebalance', customerId: holder, originType: 'CUSTOMER', type: 'STANDARD' })
    expect(d).toMatchObject({ hayId: out.depositTransactionId, stackHayId: to, amount: 45.25, counterpartTransactionId: out.withdrawalTransactionId, notes: 'rebalance' })
    expect(w!.transactionTimeUtc).toBe(d!.transactionTimeUtc)
    expect(await stackTransactions(accountId)).toHaveLength(3)
  })

  it('refuses beyond the source balance (200 REFUSED_INSUFFICIENT_FUNDS) and validates stacks (404, 422 STACK_CLOSED, 422 same stack, 400 amount)', async () => {
    const { holder, accountId, stackId: from } = await fundedWithStack(20, 'A')
    const to = await createStack(accountId, 'B')
    const body = (over: object) => ({ amount: 5, customerId: holder, withdrawalStackId: from, depositStackId: to, ...over })
    expect((await post(`/v0/accounts/${accountId}/stacks/transactions`, body({}))).json()).toEqual({ outcome: 'REFUSED_INSUFFICIENT_FUNDS' })
    expect((await transferIn(accountId, from, { amount: 5, customerId: holder })).json().outcome).toBe('ACCEPTED')
    expect((await post(`/v0/accounts/${accountId}/stacks/transactions`, body({ amount: 5.01 }))).json()).toEqual({ outcome: 'REFUSED_INSUFFICIENT_FUNDS' })
    expectError(await post(`/v0/accounts/${accountId}/stacks/transactions`, body({ amount: 0 })), 400, /^BAD_REQUEST/)
    expectError(await post(`/v0/accounts/${accountId}/stacks/transactions`, body({ amount: 1.999 })), 400, /^BAD_REQUEST: amount/)
    expectError(await post(`/v0/accounts/${accountId}/stacks/transactions`, body({ depositStackId: from })), 422, /^INVALID_ARGUMENT: withdrawalStackId and depositStackId/)
    expectError(await post(`/v0/accounts/${accountId}/stacks/transactions`, body({ depositStackId: UNKNOWN_ID })), 404, /^NOT_FOUND: Stack/)
    const other = await newAccount(holder)
    const foreign = await createStack(other.accountHayId!, 'Foreign')
    expectError(await post(`/v0/accounts/${accountId}/stacks/transactions`, body({ depositStackId: foreign })), 404, /^NOT_FOUND: Stack/)
    expectError(await post(`/v0/accounts/${accountId}/stacks/transactions`, body({ customerId: UNKNOWN_ID })), 404, /^NOT_FOUND: Customer/)
    expect((await post(`/v0/accounts/${accountId}/stacks/${to}/close`)).statusCode).toBe(200)
    expectError(await post(`/v0/accounts/${accountId}/stacks/transactions`, body({})), 422, /^STACK_CLOSED/)
    expect(await stack(accountId, from)).toMatchObject({ balance: 5 })
  })

  it('counts as the first transactional action of an APPROVED account', async () => {
    const holder = await newCustomer()
    const a = await newAccount(holder)
    const id = a.accountHayId!
    const s1 = await createStack(id, 'S1')
    const s2 = await createStack(id, 'S2')
    // seed the stack directly (no ledger posting) so the account is still APPROVED
    seedLedger(id, 1000, 1000)
    built.ctx.db.prepare('UPDATE stacks SET balance = ? WHERE id = ?').run(1000, s1)
    expect(await getAccount(id)).toMatchObject({ status: 'APPROVED', totalBalance: 10, stacksBalance: 10, availableBalance: 0 })
    const res = await post(`/v0/accounts/${id}/stacks/transactions`, { amount: 3, customerId: holder, withdrawalStackId: s1, depositStackId: s2 })
    expect(res.json().outcome).toBe('ACCEPTED')
    expect((await getAccount(id)).status).toBe('ACTIVE')
  })
})

describe('closeStack (POST /v0/accounts/{accountId}/stacks/{stackId}/close)', () => {
  it('closes the stack, sweeps its balance back to the account as an OPERATIONS withdrawal, hides it from getAllStacks and is a no-op afterwards', async () => {
    const { holder, accountId, stackId } = await fundedWithStack(100)
    expect((await transferIn(accountId, stackId, { amount: 33.33, customerId: holder })).json().outcome).toBe('ACCEPTED')
    const res = await post(`/v0/accounts/${accountId}/stacks/${stackId}/close`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toBe(true)
    expect(await getAccount(accountId)).toMatchObject({ totalBalance: 100, availableBalance: 100, stacksBalance: 0 })
    expect(await listStacks(accountId)).toEqual([])
    const closed = await stack(accountId, stackId)
    expect(closed).toMatchObject({ status: 'CLOSED', balance: 0, closedAtUtc: expect.stringMatching(ISO_MICROS) })
    const txs = await stackTransactions(accountId)
    expect(txs).toHaveLength(2)
    expect(txs[0]).toMatchObject({ stackHayId: stackId, amount: -33.33, originType: 'OPERATIONS', customerId: holder, type: 'STANDARD', stack: { status: 'CLOSED', balance: 0 } })
    expect(txs[1]).toMatchObject({ amount: 33.33, originType: 'CUSTOMER' })
    // history stays visible through the by-stack list; a repeat close confirms without a new record
    expect(await stackTransactions(accountId, 'offset=0&limit=10', stackId)).toHaveLength(2)
    expect((await post(`/v0/accounts/${accountId}/stacks/${stackId}/close`)).json()).toBe(true)
    expect(await stackTransactions(accountId)).toHaveLength(2)
    expect(await stack(accountId, stackId)).toEqual(closed)
    expectError(await transferOut(accountId, stackId, { amount: 1, customerId: holder }), 422, /^STACK_CLOSED/)
  })

  it('an empty stack closes on a LOCKED account, a funded one needs the account open (422 ACCOUNT_BLOCKED); a group sweep carries no customerId; 404 for unknown stacks', async () => {
    const { holder, accountId, stackId } = await fundedWithStack(50, 'Funded')
    const empty = await createStack(accountId, 'Empty')
    expect((await transferIn(accountId, stackId, { amount: 10, customerId: holder })).json().outcome).toBe('ACCEPTED')
    expect((await post(`/v0/accounts/${accountId}/block`, { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' })).statusCode).toBe(200)
    expect((await post(`/v0/accounts/${accountId}/stacks/${empty}/close`)).json()).toBe(true)
    expectError(await post(`/v0/accounts/${accountId}/stacks/${stackId}/close`), 422, /^ACCOUNT_BLOCKED/)
    expect(await stack(accountId, stackId)).toMatchObject({ status: 'OPEN', balance: 10 })
    expectError(await post(`/v0/accounts/${accountId}/stacks/${UNKNOWN_ID}/close`), 404, /^NOT_FOUND: Stack/)

    const [m1, m2] = [await newCustomer(), await newCustomer()]
    const g = await newGroup([m1, m2])
    const ga = await newGroupAccount(g.groupHayId!)
    await setLowRisk(ga.accountHayId!)
    expect((await credit(ga.accountHayId!, 20)).outcome).toBe('ACCEPTED')
    const gs = await createStack(ga.accountHayId!, 'Shared')
    expect((await transferIn(ga.accountHayId!, gs, { amount: 8, customerId: m1 })).json().outcome).toBe('ACCEPTED')
    expect((await post(`/v0/accounts/${ga.accountHayId}/stacks/${gs}/close`)).json()).toBe(true)
    const [sweep] = await stackTransactions(ga.accountHayId!)
    expect(sweep).toMatchObject({ amount: -8, originType: 'OPERATIONS' })
    expect(sweep).not.toHaveProperty('customerId')
  })
})

describe('stack transaction lists', () => {
  it('lists newest first with paging, filters by type (ROUND_UP records come from the platform hook) and embeds the stack', async () => {
    const { holder, accountId, stackId } = await fundedWithStack(100, 'Main')
    const other = await createStack(accountId, 'Other')
    for (const amount of [1, 2, 3]) expect((await transferIn(accountId, stackId, { amount, customerId: holder })).json().outcome).toBe('ACCEPTED')
    expect((await transferIn(accountId, other, { amount: 4, customerId: holder })).json().outcome).toBe('ACCEPTED')
    const ru = stacks.roundUp(accountId, stackId, 55, { originId: UNKNOWN_ID })
    expect(ru.outcome).toBe('ACCEPTED')

    const all = await stackTransactions(accountId)
    expect(all.map((t) => t.amount)).toEqual([0.55, 4, 3, 2, 1])
    expect(all[0]).toMatchObject({ hayId: ru.transactionId, type: 'ROUND_UP', originType: 'TRANSACTION', originId: UNKNOWN_ID, stackHayId: stackId, stack: { name: 'Main', balance: 6.55 } })
    expect(all[0]).not.toHaveProperty('customerId')
    expect((await stackTransactions(accountId, 'offset=1&limit=2')).map((t) => t.amount)).toEqual([4, 3])
    expect((await stackTransactions(accountId, 'offset=4&limit=2')).map((t) => t.amount)).toEqual([1])
    expect((await stackTransactions(accountId, 'offset=0&limit=10&type=ROUND_UP')).map((t) => t.amount)).toEqual([0.55])
    expect((await stackTransactions(accountId, 'offset=0&limit=10&type=STANDARD')).map((t) => t.amount)).toEqual([4, 3, 2, 1])
    expect((await stackTransactions(accountId, 'offset=0&limit=10', stackId)).map((t) => t.amount)).toEqual([0.55, 3, 2, 1])
    expect((await stackTransactions(accountId, 'offset=0&limit=10&type=STANDARD', other)).map((t) => t.amount)).toEqual([4])
    expect((await stackTransactions(accountId, 'offset=0&limit=10&type=ROUND_UP', other))).toEqual([])
    expect(await getAccount(accountId)).toMatchObject({ availableBalance: 89.45, stacksBalance: 10.55 })
  })

  it('validates paging (offset and limit required, limit 1..1000, offset >= 0, type enum) and ids (404)', async () => {
    const { accountId, stackId } = await fundedWithStack(0)
    for (const q of ['', 'offset=0', 'limit=10', 'offset=0&limit=0', 'offset=0&limit=1001', 'offset=-1&limit=10', 'offset=0&limit=10&type=OTHER', 'offset=x&limit=10']) {
      expectError(await app.inject({ method: 'GET', url: `/v0/accounts/${accountId}/stacks/transactions?${q}` }), 400, /^BAD_REQUEST/)
      expectError(await app.inject({ method: 'GET', url: `/v0/accounts/${accountId}/stacks/${stackId}/transactions?${q}` }), 400, /^BAD_REQUEST/)
    }
    expect(await stackTransactions(accountId, 'offset=0&limit=1000')).toEqual([])
    expectError(await app.inject({ method: 'GET', url: `/v0/accounts/${UNKNOWN_ID}/stacks/transactions?offset=0&limit=10` }), 404, /^NOT_FOUND: Account/)
    expectError(await app.inject({ method: 'GET', url: `/v0/accounts/${accountId}/stacks/${UNKNOWN_ID}/transactions?offset=0&limit=10` }), 404, /^NOT_FOUND: Stack/)
    const other = await newAccount()
    expectError(await app.inject({ method: 'GET', url: `/v0/accounts/${other.accountHayId}/stacks/${stackId}/transactions?offset=0&limit=10` }), 404, /^NOT_FOUND: Stack/)
  })
})

describe('stacks and account closure', () => {
  it('closeAccount is refused with ACCOUNT_BALANCE_STACKS while a stack holds funds; once empty, closure closes the remaining open stacks', async () => {
    const { holder, accountId, stackId } = await fundedWithStack(40)
    const spare = await createStack(accountId, 'Spare')
    expect((await transferIn(accountId, stackId, { amount: 40, customerId: holder })).json().outcome).toBe('ACCEPTED')
    const refused = await post(`/v0/accounts/${accountId}/close`)
    expect(refused.statusCode).toBe(422)
    expect(refused.json()).toMatchObject({ result: 'FAILURE', errors: [{ type: 'ACCOUNT_BALANCE_TOTAL', errorMessage: 'Account has 40.00 total balance.' }, { type: 'ACCOUNT_BALANCE_STACKS', errorMessage: 'Account has 40.00 stacks balance.' }] })
    expect((await post(`/v0/accounts/${accountId}/stacks/${stackId}/close`)).json()).toBe(true)
    expect((await debit(accountId, 40)).outcome).toBe('ACCEPTED')
    expect((await post(`/v0/accounts/${accountId}/close`)).statusCode).toBe(202)
    await flush()
    expect((await getAccount(accountId)).status).toBe('CLOSED')
    expect(await listStacks(accountId)).toEqual([])
    expect(await stack(accountId, spare)).toMatchObject({ status: 'CLOSED', balance: 0, closedAtUtc: expect.stringMatching(ISO_MICROS) })
    expectError(await post(`/v0/accounts/${accountId}/stacks/${stackId}/transfer-in`, { amount: 1, customerId: holder }), 422, /^ACCOUNT_CLOSED/)
    expectError(await post(`/v0/accounts/${accountId}/stacks`, { name: 'Late' }), 422, /^ACCOUNT_CLOSED/)
  })
})

describe('webhooks emitted around this domain', () => {
  it('every notification recorded in this file validates against wh:NotificationDto and none is a group or stack event', async () => {
    const payloads = await allPayloads()
    expect(payloads.length).toBeGreaterThan(10)
    for (const p of payloads) assertValidNotification(p)
    expect(new Set(payloads.map((p) => p.type))).toEqual(new Set(['ACCOUNT_STATUS_CHANGE', 'CUSTOMER_STATUS_UPDATED', 'ONBOARDING_PASSED', 'ONBOARDING_FAILED', 'TRANSACTION']))
  })
})
