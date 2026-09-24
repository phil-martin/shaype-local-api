import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '../src/contract/generated/b2b-types.js'
import { startApp } from './helpers.js'
import { assertValidNotification } from './webhook-schema.js'
import type { BuiltServer } from '../src/server.js'
import { LOCAL_PRODUCT_ID } from '../src/domains/accounts/index.js'
import { LOCAL_BSB } from '../src/lib/ids.js'
import { addDays, nextBusinessDay, nextOccurrence, occurrence, type DirectEntryService, type CreateScheduleInput } from '../src/domains/direct-entry/index.js'

type S = components['schemas']
type HayAccount = S['HayAccount']
type FinancialTransaction = S['FinancialTransaction']
type CreateDd = S['CreateDirectDebitRequestBody']
type DdResponseV1 = S['DirectDebitResponseV1']
type DdResponse = S['DirectDebitResponse']
type DeDetailsV1 = S['DeTransactionDetailsV1']
type DeDetails = S['DeTransactionDetails']
type HayScheduledPayment = S['HayScheduledPayment']

const DIRECT_ENTRY_OPS = [
  'createDirectDebitV1', 'createDirectDebitV0', 'getDirectDebitV1', 'getDirectDebitV0', 'getDirectDebitsV1', 'getDirectDebitsV0',
  'getDirectEntryStatusV1', 'getScheduledPayments', 'getScheduledPaymentById', 'cancelScheduledPayment',
]
const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111'
const UUID_RE = /^[0-9a-f-]{36}$/
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const DAY_MS = 24 * 60 * 60 * 1000
const EXTERNAL_BSB = '062000'

let built: BuiltServer
let app: BuiltServer['app']
let svc: DirectEntryService
beforeAll(async () => { built = await startApp(); app = built.app; svc = built.ctx.services.directEntry })
afterAll(async () => { await built.app.close() })

let n = 0
async function flush(): Promise<void> {
  const res = await app.inject({ method: 'POST', url: '/_admin/flush' })
  expect(res.statusCode, res.body).toBe(200)
}
async function advanceClock(ms: number): Promise<void> {
  await app.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: ms } })
}
async function setClock(at: string): Promise<void> {
  await app.inject({ method: 'POST', url: '/_admin/clock', payload: { set: at } })
}
async function resetClock(): Promise<void> {
  await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
}
async function today(): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/_admin/clock' })
  return (res.json().now as string).slice(0, 10)
}
async function newCustomer(): Promise<string> {
  n++
  const res = await app.inject({
    method: 'POST', url: '/v0/customers/create',
    payload: {
      idempotencyKey: randomUUID(), email: `de${n}@example.com`, customerTier: 'STANDARD',
      phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: `7${String(n).padStart(8, '0')}` },
      address: { line1: '1 Test St', townOrCity: 'Sydney', administrativeRegion: 'NSW', postcode: '2000', countryCodeIso: 'AUS' },
      customerDetails: { firstName: 'Direct', lastName: `Entry${n}`, dateOfBirth: '1990-01-01' },
    },
  })
  expect(res.statusCode, res.body).toBe(200)
  await flush()
  return res.json().customerHayId as string
}
/** An account with risk level LOW (limits open) unless `risk: 'HIGH'`. */
async function newAccount(opts: { holder?: string; risk?: 'LOW' | 'HIGH' } = {}): Promise<HayAccount> {
  const holder = opts.holder ?? (await newCustomer())
  const res = await app.inject({ method: 'POST', url: '/v1/accounts', payload: { idempotencyKey: randomUUID(), accountHolderId: holder, accountHolderType: 'CUSTOMER', productId: LOCAL_PRODUCT_ID } })
  expect(res.statusCode, res.body).toBe(200)
  const a = res.json() as HayAccount
  if (opts.risk !== 'HIGH') {
    const r = await app.inject({ method: 'PATCH', url: `/v0/accounts/${a.accountHayId}/riskLevel`, payload: { level: 'LOW', reason: 'test' } })
    expect(r.statusCode, r.body).toBe(200)
  }
  await flush()
  return a
}
async function getAccount(id: string): Promise<HayAccount> {
  const res = await app.inject({ method: 'GET', url: `/v0/accounts/${id}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as HayAccount
}
async function credit(accountHayId: string, amount: number): Promise<void> {
  const res = await app.inject({ method: 'POST', url: '/v1/transactions/credit', payload: { idempotencyKey: randomUUID(), accountHayId, amount, counterpartName: 'Payroll', description: 'pay', transactionChannel: 'MANUAL_ADJUSTMENT' } })
  expect(res.statusCode, res.body).toBe(200)
  expect(res.json().outcome).toBe('ACCEPTED')
}
async function fundedAccount(amount: number, holder?: string): Promise<HayAccount> {
  const a = await newAccount({ holder })
  await credit(a.accountHayId!, amount)
  return getAccount(a.accountHayId!)
}
async function setLimit(accountId: string, type: string, amount: number): Promise<void> {
  const res = await app.inject({ method: 'PUT', url: `/v1/accounts/${accountId}/limits/${type}`, payload: { limitAmount: amount } })
  expect(res.statusCode, res.body).toBe(200)
}
async function blockAccount(accountId: string): Promise<void> {
  const res = await app.inject({ method: 'POST', url: `/v0/accounts/${accountId}/block`, payload: { note: 'test', accountBlockStyle: 'ACCOUNT_ONLY' } })
  expect(res.statusCode, res.body).toBe(200)
}
function ddBody(sender: HayAccount, overrides: Partial<CreateDd> = {}): CreateDd {
  return {
    idempotencyKey: randomUUID(),
    transactionId: randomUUID(),
    amount: 250.5,
    description: 'Gym membership',
    senderBsb: sender.bsb!,
    senderAccountNumber: sender.accountNumber!,
    senderName: 'Local Sender',
    recipientBsb: EXTERNAL_BSB,
    recipientAccountNumber: '123456789',
    recipientName: 'External Debtor Pty Ltd',
    ...overrides,
  }
}
async function createDd(body: CreateDd, version: 'v1' | 'v0' = 'v1') {
  return app.inject({ method: 'POST', url: `/${version}/direct-debits`, payload: body })
}
async function acceptedDd(sender: HayAccount, overrides: Partial<CreateDd> = {}): Promise<CreateDd> {
  const body = ddBody(sender, overrides)
  const res = await createDd(body)
  expect(res.statusCode, res.body).toBe(200)
  expect(res.json().outcome).toBe('ACCEPTED')
  return body
}
async function getDd(id: string, version: 'v1' | 'v0' = 'v1'): Promise<DdResponseV1 | DdResponse> {
  const res = await app.inject({ method: 'GET', url: `/${version}/direct-debits/${id}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
async function deStatus(id: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: `/v1/direct-entry/${id}/status` })
  expect(res.statusCode, res.body).toBe(200)
  expect(res.json().transactionId).toBe(id)
  return res.json().status as string
}
async function listDd(query: Record<string, string | number>, version: 'v1' | 'v0' = 'v1') {
  const qs = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
  return app.inject({ method: 'GET', url: `/${version}/direct-debits?${qs}` })
}
async function getTransaction(id: string): Promise<FinancialTransaction> {
  const res = await app.inject({ method: 'GET', url: `/v1/transactions/${id}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as FinancialTransaction
}
async function allPayloads(): Promise<any[]> {
  const res = await app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })
  return (res.json() as { payload: any }[]).map((r) => r.payload)
}
async function deEvents(transactionId: string): Promise<any[]> {
  return (await allPayloads()).filter((p) => p.type === 'DIRECT_ENTRY' && p.directEntryEvent?.transactionId === transactionId)
}
async function txEvents(accountId: string): Promise<any[]> {
  return (await allPayloads()).filter((p) => p.type === 'TRANSACTION' && p.transactionEvent?.accountHayId === accountId)
}
async function scheduleEvents(hayId: string): Promise<any[]> {
  return (await allPayloads()).filter((p) => p.type === 'SCHEDULED_PAYMENT' && p.scheduledPaymentEvent?.hayId === hayId)
}
function expectError(res: { statusCode: number; json: () => any }, status: number, code: RegExp | string): void {
  expect(res.statusCode).toBe(status)
  const body = res.json()
  expect(body).toMatchObject({ status: String(status), details: expect.stringContaining('traceId') })
  expect(body.traceId).toMatch(UUID_RE)
  expect(body.message).toMatch(code)
}
async function createSchedule(input: CreateScheduleInput, expectedStatus = 201): Promise<HayScheduledPayment> {
  const res = await app.inject({ method: 'POST', url: '/_admin/scheduled-payments', payload: input })
  expect(res.statusCode, res.body).toBe(expectedStatus)
  return res.json() as HayScheduledPayment
}
async function getSchedule(accountId: string, hayId: string): Promise<HayScheduledPayment> {
  const res = await app.inject({ method: 'GET', url: `/v0/accounts/${accountId}/scheduledPayments/${hayId}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as HayScheduledPayment
}
function externalRecipient(): CreateScheduleInput['recipient'] {
  return { recipientType: 'ACCOUNT', recipientName: 'Landlord', recipientAccountNumber: { branchNumber: EXTERNAL_BSB, accountNumber: '87654321' } }
}
function scheduleInput(account: HayAccount, overrides: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return { accountId: account.accountHayId!, amount: 100, description: 'Rent', reference: 'RENT-1', startDate: '2026-01-01', recipient: externalRecipient(), ...overrides }
}

// ---------------------------------------------------------------------------------------------------

describe('direct-entry domain: registration', () => {
  it('handles every Direct Debits / Direct Entry / Scheduled Payments operation (none left on the stub)', async () => {
    const res = await app.inject({ method: 'GET', url: '/_admin/operations' })
    const { handled, stubbed } = res.json() as { handled: string[]; stubbed: string[] }
    for (const op of DIRECT_ENTRY_OPS) {
      expect(handled, op).toContain(op)
      expect(stubbed, op).not.toContain(op)
    }
  })
})

describe('createDirectDebitV1: lifecycle', () => {
  it('RECEIVED -> ACCEPTED synchronously, SUBMITTED -> COMPLETE through the scheduler, crediting the sender with DIRECT_DEBIT_TRANSFER', async () => {
    const sender = await newAccount()
    const body = ddBody(sender)
    const res = await createDd(body)
    expect(res.statusCode, res.body).toBe(200)
    const created = res.json() as DdResponseV1
    const processingDate = nextBusinessDay(await today())
    expect(created).toEqual({
      transactionId: body.transactionId,
      outcome: 'ACCEPTED',
      transactionDetails: {
        amount: 250.5, description: 'Gym membership', outcome: 'ACCEPTED', processingDate,
        recipientAccountNumber: '123456789', recipientBsb: EXTERNAL_BSB, recipientName: 'External Debtor Pty Ltd',
        senderAccountNumber: sender.accountNumber, senderBsb: LOCAL_BSB, senderName: 'Local Sender',
        transactionHayId: body.transactionId, type: 'DEBIT',
      },
    })

    await flush()
    expect(await deStatus(body.transactionId)).toBe('COMPLETE')
    const final = (await getDd(body.transactionId)) as DdResponseV1
    expect(final.outcome).toBe('COMPLETE')
    expect(final.transactionDetails?.outcome).toBe('COMPLETE')
    expect(final).not.toHaveProperty('details')

    const account = await getAccount(sender.accountHayId!)
    expect(account.totalBalance).toBe(250.5)
    expect(account.availableBalance).toBe(250.5)
    expect(account.status).toBe('ACTIVE')

    const events = await deEvents(body.transactionId)
    expect(events.map((e) => e.directEntryEvent.status)).toEqual(['RECEIVED', 'ACCEPTED', 'SUBMITTED', 'COMPLETE'])
    expect(events.map((e) => e.actionOwner)).toEqual(['CLIENT', 'CLIENT', 'PLATFORM', 'PLATFORM'])
    for (const e of events) {
      assertValidNotification(e)
      expect(e).toEqual({
        customerHayId: sender.accountHolderId, idempotencyKey: expect.stringMatching(UUID_RE), type: 'DIRECT_ENTRY', actionOwner: e.actionOwner,
        directEntryEvent: { transactionId: body.transactionId, type: 'DEBIT', direction: 'OUTBOUND', status: e.directEntryEvent.status },
      })
    }

    const tx = (await txEvents(sender.accountHayId!)).filter((p) => p.transactionEvent.transactionType === 'DIRECT_DEBIT_TRANSFER')
    expect(tx).toHaveLength(1)
    assertValidNotification(tx[0])
    expect(tx[0]).toMatchObject({
      customerHayId: sender.accountHolderId, actionOwner: 'PLATFORM', productId: LOCAL_PRODUCT_ID,
      transactionEvent: {
        accountHayId: sender.accountHayId, currencyAmount: { currency: 'AUD', amount: 250.5 }, updatedBalance: { currency: 'AUD', amount: 250.5 },
        isPending: false, outcome: 'ACCEPTED', transactionType: 'DIRECT_DEBIT_TRANSFER', originType: 'DIRECT_DEBIT', originId: body.transactionId,
        counterpartName: 'External Debtor Pty Ltd', counterpartDetails: { name: 'External Debtor Pty Ltd', basicAccountNumber: { accountNumber: '123456789', branchNumber: EXTERNAL_BSB } },
        category: 'BANK_TRANSFER', description: 'Gym membership',
      },
    })
    const posted = await getTransaction(tx[0].transactionEvent.transactionHayId)
    expect(posted).toMatchObject({ type: 'DIRECT_DEBIT_TRANSFER', transactionChannel: 'CUSCAL_DE_DEBIT_OUT', originType: 'DIRECT_DEBIT', originId: body.transactionId, currencyAmount: { amount: 250.5 } })
    expect(posted.transactionTimeUtc).toMatch(ISO_MICROS)
  })

  it('one id across create, the DIRECT_ENTRY and TRANSACTION webhooks and every lookup (00-open-questions I3)', async () => {
    const sender = await newAccount()
    const debtor = await fundedAccount(100)
    const body = await acceptedDd(sender, { amount: 40, recipientBsb: LOCAL_BSB, recipientAccountNumber: debtor.accountNumber!, recipientName: 'Local Debtor' })
    await flush()
    const credit = (await txEvents(sender.accountHayId!)).find((p) => p.transactionEvent.transactionType === 'DIRECT_DEBIT_TRANSFER')
    const webhookId = credit.transactionEvent.transactionHayId as string
    expect(webhookId).toBe(body.transactionId)
    // "the transactionId present in our transactionEvent notification webhooks can be used when making requests against this endpoint"
    expect(await deStatus(webhookId)).toBe('COMPLETE')
    expect(await getDd(webhookId)).toMatchObject({ transactionId: body.transactionId, outcome: 'COMPLETE' })
    expect(await getTransaction(body.transactionId)).toMatchObject({ transactionHayId: body.transactionId, type: 'DIRECT_DEBIT_TRANSFER', accountHayId: sender.accountHayId, currencyAmount: { amount: 40 } })
    // the local debtor's debit leg is a transaction of its own
    const debit = (await txEvents(debtor.accountHayId!)).find((p) => p.transactionEvent.transactionType === 'DIRECT_DEBIT_TRANSFER')
    expect(debit.transactionEvent.transactionHayId).not.toBe(body.transactionId)
    expect(debit.transactionEvent.originId).toBe(body.transactionId)

    // a transactionId that is already a ledger transaction id cannot name a new instruction
    expectError(await createDd(ddBody(sender, { transactionId: debit.transactionEvent.transactionHayId })), 422, /^DUPLICATE_TRANSACTION_ID: /)
  })

  it('exposes each status in turn when the hops are delayed; in-flight instructions block account closure', async () => {
    const sender = await newAccount()
    svc.progressDelayMs = DAY_MS
    try {
      const body = await acceptedDd(sender)
      const id = body.transactionId
      expect(await deStatus(id)).toBe('ACCEPTED')
      expect(((await getDd(id, 'v0')) as DdResponse).outcome).toBe('ACCEPTED')

      const close = await app.inject({ method: 'POST', url: `/v0/accounts/${sender.accountHayId}/close` })
      expect(close.statusCode).toBe(422)
      expect(close.json().errors).toEqual([{ type: 'INFLIGHT_OUTBOUND_DIRECT_DEBITS', errorMessage: `Account has 1 inflight outbound direct entries: [${id}]` }])

      await advanceClock(DAY_MS)
      expect(await deStatus(id)).toBe('SUBMITTED')
      expect(((await getDd(id)) as DdResponseV1).outcome).toBe('SUBMITTED')
      expect(((await getDd(id, 'v0')) as DdResponse).outcome).toBe('SUBMITTED')
      expect((await deEvents(id)).map((e) => e.directEntryEvent.status)).toEqual(['RECEIVED', 'ACCEPTED', 'SUBMITTED'])
      expect((await app.inject({ method: 'POST', url: `/v0/accounts/${sender.accountHayId}/close` })).statusCode).toBe(422)

      await advanceClock(DAY_MS)
      expect(await deStatus(id)).toBe('COMPLETE')
      // v0 has no COMPLETE: it renders as SUBMITTED
      expect((await getDd(id, 'v0')) as DdResponse).toMatchObject({ outcome: 'SUBMITTED', transactionDetails: { outcome: 'SUBMITTED' } })
    } finally {
      svc.progressDelayMs = undefined
      await resetClock()
    }
    await flush()
    expect((await getAccount(sender.accountHayId!)).totalBalance).toBe(250.5)
  })

  it('replays the same idempotencyKey + body without new webhooks; a different body is 422; a reused transactionId is 422 DUPLICATE_TRANSACTION_ID', async () => {
    const sender = await newAccount()
    const body = ddBody(sender)
    const first = await createDd(body)
    expect(first.statusCode).toBe(200)
    await flush()
    const before = (await deEvents(body.transactionId)).length
    const replay = await createDd(body)
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toEqual(first.json())
    await flush()
    expect((await deEvents(body.transactionId)).length).toBe(before)

    expectError(await createDd({ ...body, amount: 99 }), 422, /^IDEMPOTENCY_KEY_REUSED: /)
    expectError(await createDd({ ...body, idempotencyKey: randomUUID() }), 422, /^DUPLICATE_TRANSACTION_ID: /)
  })

  it('validates what the schema cannot: amount > 0 with <= 2 dp, anchored BSB and account-number patterns (400)', async () => {
    const sender = await newAccount()
    expectError(await createDd(ddBody(sender, { amount: 0 })), 400, /amount/)
    expectError(await createDd(ddBody(sender, { amount: -5 })), 400, /amount/)
    expectError(await createDd(ddBody(sender, { amount: 10.005 })), 400, /amount/)
    expectError(await createDd(ddBody(sender, { senderBsb: '12345' })), 400, /BAD_REQUEST/)
    expectError(await createDd(ddBody(sender, { senderBsb: '1234567' })), 400, /senderBsb/)
    expectError(await createDd(ddBody(sender, { recipientAccountNumber: '1234567890' })), 400, /recipientAccountNumber/)
    expectError(await createDd(ddBody(sender, { description: 'x'.repeat(19) })), 400, /BAD_REQUEST/)
    expectError(await createDd(ddBody(sender, { transactionId: 'not-a-uuid' })), 400, /BAD_REQUEST/)
  })

  it('is REJECTED (200) when the sender BSB + account number is not a local account, with no webhook to address', async () => {
    const sender = await newAccount()
    for (const overrides of [{ senderAccountNumber: '99999999' }, { senderBsb: EXTERNAL_BSB }]) {
      const body = ddBody(sender, overrides)
      const res = await createDd(body)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({ transactionId: body.transactionId, outcome: 'REJECTED', details: expect.stringContaining('Sender account not found'), transactionDetails: { outcome: 'REJECTED' } })
      await flush()
      expect(await deStatus(body.transactionId)).toBe('REJECTED')
      expect(await deEvents(body.transactionId)).toEqual([])
    }
  })

  it('is REJECTED with RECEIVED + REJECTED webhooks when the sender account is blocked or the recipient BSB is 999999', async () => {
    const holder = await newCustomer()
    const blocked = await newAccount({ holder })
    await blockAccount(blocked.accountHayId!)
    const b1 = ddBody(blocked)
    const r1 = await createDd(b1)
    expect(r1.statusCode).toBe(200)
    expect(r1.json()).toMatchObject({ outcome: 'REJECTED', details: 'REFUSED_ACCOUNT_BLOCKED' })

    const open = await newAccount({ holder })
    const b2 = ddBody(open, { recipientBsb: '999999' })
    const r2 = await createDd(b2)
    expect(r2.json()).toMatchObject({ outcome: 'REJECTED', details: 'Invalid recipient BSB 999999' })

    await flush()
    for (const id of [b1.transactionId, b2.transactionId]) {
      const events = await deEvents(id)
      expect(events.map((e) => [e.directEntryEvent.status, e.actionOwner])).toEqual([['RECEIVED', 'CLIENT'], ['REJECTED', 'CLIENT']])
      events.forEach((e) => assertValidNotification(e))
      expect(await deStatus(id)).toBe('REJECTED')
    }
    expect((await getAccount(open.accountHayId!)).totalBalance).toBe(0)
  })

  it('ends INCOMPLETE when the credit is refused at completion (risk HIGH -> MAX_BALANCE 0; blocked after acceptance)', async () => {
    const high = await newAccount({ risk: 'HIGH' })
    const b1 = await acceptedDd(high)
    await flush()
    expect(await deStatus(b1.transactionId)).toBe('INCOMPLETE')
    expect((await getDd(b1.transactionId)) as DdResponseV1).toMatchObject({ outcome: 'INCOMPLETE', details: 'REFUSED_MAX_BALANCE_EXCEEDED' })
    expect(((await getDd(b1.transactionId, 'v0')) as DdResponse).outcome).toBe('RETURNED')
    expect((await getAccount(high.accountHayId!)).totalBalance).toBe(0)
    const events = await deEvents(b1.transactionId)
    expect(events.map((e) => e.directEntryEvent.status)).toEqual(['RECEIVED', 'ACCEPTED', 'SUBMITTED', 'INCOMPLETE'])
    events.forEach((e) => assertValidNotification(e))
    expect((await txEvents(high.accountHayId!)).filter((p) => p.transactionEvent.transactionType === 'DIRECT_DEBIT_TRANSFER')).toEqual([])

    const sender = await newAccount()
    svc.progressDelayMs = DAY_MS
    try {
      const b2 = await acceptedDd(sender)
      await blockAccount(sender.accountHayId!)
      await advanceClock(DAY_MS)
      expect(await deStatus(b2.transactionId)).toBe('SUBMITTED')
      await advanceClock(DAY_MS)
      expect((await getDd(b2.transactionId)) as DdResponseV1).toMatchObject({ outcome: 'INCOMPLETE', details: 'REFUSED_ACCOUNT_BLOCKED' })
    } finally {
      svc.progressDelayMs = undefined
      await resetClock()
    }
  })

  it('is RETURNED by the recipient institution (returnOutbound matches sender BSB + account + amount) and the later hops become no-ops', async () => {
    const sender = await newAccount()
    svc.progressDelayMs = DAY_MS
    try {
      const body = await acceptedDd(sender, { amount: 77 })
      await advanceClock(DAY_MS)
      expect(await deStatus(body.transactionId)).toBe('SUBMITTED')
      expect(svc.returnOutbound({ senderBsb: LOCAL_BSB, senderAccountNumber: sender.accountNumber!, amountCents: 7600 })).toBeUndefined()
      const returned = svc.returnOutbound({ senderBsb: LOCAL_BSB, senderAccountNumber: sender.accountNumber!, amountCents: 7700, returnReason: 'ACCOUNT_CLOSED' })
      expect(returned).toMatchObject({ id: body.transactionId, status: 'RETURNED', returnReason: 'ACCOUNT_CLOSED' })
      expect(await deStatus(body.transactionId)).toBe('RETURNED')
      await advanceClock(DAY_MS)
      expect(await deStatus(body.transactionId)).toBe('RETURNED')
      expect((await deEvents(body.transactionId)).map((e) => e.directEntryEvent.status)).toEqual(['RECEIVED', 'ACCEPTED', 'SUBMITTED', 'RETURNED'])
      expect((await getAccount(sender.accountHayId!)).totalBalance).toBe(0)
      expect((await app.inject({ method: 'POST', url: `/v0/accounts/${sender.accountHayId}/close` })).statusCode).toBe(202)

      // an ACCEPTED instruction can be returned too (the platform batch may already have gone out)
      const other = await newAccount()
      const early = await acceptedDd(other, { amount: 12 })
      expect(svc.returnOutbound({ senderBsb: LOCAL_BSB, senderAccountNumber: other.accountNumber!, amountCents: 1200 })?.status).toBe('RETURNED')
      await advanceClock(2 * DAY_MS)
      expect(await deStatus(early.transactionId)).toBe('RETURNED')
    } finally {
      svc.progressDelayMs = undefined
      await resetClock()
    }
  })

  it('returnOutbound prefers the most recent SUBMITTED instruction over a newer ACCEPTED one of the same amount', async () => {
    const sender = await newAccount()
    svc.progressDelayMs = DAY_MS
    try {
      const older = await acceptedDd(sender, { amount: 33 })
      await advanceClock(DAY_MS)
      expect(await deStatus(older.transactionId)).toBe('SUBMITTED')
      const newer = await acceptedDd(sender, { amount: 33 })
      expect(await deStatus(newer.transactionId)).toBe('ACCEPTED')
      const match = { senderBsb: LOCAL_BSB, senderAccountNumber: sender.accountNumber!, amountCents: 3300 }
      expect(svc.returnOutbound(match)?.id).toBe(older.transactionId)
      expect(await deStatus(newer.transactionId)).toBe('ACCEPTED')
      expect(svc.returnOutbound(match)?.id).toBe(newer.transactionId) // no SUBMITTED left: the ACCEPTED one
      expect(svc.returnOutbound(match)).toBeUndefined()
      await advanceClock(2 * DAY_MS) // drain the pending hops (no-ops now)
      expect(await deStatus(newer.transactionId)).toBe('RETURNED')
    } finally {
      svc.progressDelayMs = undefined
      await resetClock()
    }
  })

  it('debits a local recipient in the same transaction; its DIRECT_DEBIT_PER_DAY limit or funds refusal returns the instruction', async () => {
    const sender = await newAccount()
    const debtor = await fundedAccount(1000)
    const ok = await acceptedDd(sender, { amount: 300, recipientBsb: LOCAL_BSB, recipientAccountNumber: debtor.accountNumber!, recipientName: 'Local Debtor' })
    await flush()
    expect(await deStatus(ok.transactionId)).toBe('COMPLETE')
    expect((await getAccount(sender.accountHayId!)).totalBalance).toBe(300)
    expect((await getAccount(debtor.accountHayId!)).totalBalance).toBe(700)
    const debtorTx = (await txEvents(debtor.accountHayId!)).filter((p) => p.transactionEvent.transactionType === 'DIRECT_DEBIT_TRANSFER')
    expect(debtorTx).toHaveLength(1)
    assertValidNotification(debtorTx[0])
    expect(debtorTx[0].transactionEvent).toMatchObject({ currencyAmount: { amount: -300 }, originType: 'DIRECT_DEBIT', originId: ok.transactionId, counterpartDetails: { name: 'Local Sender', basicAccountNumber: { accountNumber: sender.accountNumber, branchNumber: LOCAL_BSB } } })
    expect(await getTransaction(debtorTx[0].transactionEvent.transactionHayId)).toMatchObject({ type: 'DIRECT_DEBIT_TRANSFER', transactionChannel: 'CUSCAL_DE_DEBIT_IN', currencyAmount: { amount: -300 } })

    await setLimit(debtor.accountHayId!, 'DIRECT_DEBIT_PER_DAY', 350)
    const limited = await acceptedDd(sender, { amount: 100, recipientBsb: LOCAL_BSB, recipientAccountNumber: debtor.accountNumber!, recipientName: 'Local Debtor' })
    await flush()
    expect((await getDd(limited.transactionId)) as DdResponseV1).toMatchObject({ outcome: 'RETURNED', details: 'REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED' })
    expect((await deEvents(limited.transactionId)).map((e) => e.directEntryEvent.status)).toEqual(['RECEIVED', 'ACCEPTED', 'SUBMITTED', 'RETURNED'])
    expect((await getAccount(sender.accountHayId!)).totalBalance).toBe(300)
    expect((await getAccount(debtor.accountHayId!)).totalBalance).toBe(700)

    await setLimit(debtor.accountHayId!, 'DIRECT_DEBIT_PER_DAY', 50_000)
    const broke = await acceptedDd(sender, { amount: 800, recipientBsb: LOCAL_BSB, recipientAccountNumber: debtor.accountNumber!, recipientName: 'Local Debtor' })
    await flush()
    expect((await getDd(broke.transactionId)) as DdResponseV1).toMatchObject({ outcome: 'RETURNED', details: 'REFUSED_NOT_ENOUGH_FUNDS' })
    expect((await getAccount(debtor.accountHayId!)).totalBalance).toBe(700)
  })

  it('does not apply the sender DIRECT_DEBIT_PER_DAY limit to an outbound instruction (the money comes in)', async () => {
    const sender = await newAccount()
    await setLimit(sender.accountHayId!, 'DIRECT_DEBIT_PER_DAY', 1)
    const body = await acceptedDd(sender, { amount: 5000 })
    await flush()
    expect(await deStatus(body.transactionId)).toBe('COMPLETE')
    expect((await getAccount(sender.accountHayId!)).totalBalance).toBe(5000)
  })

  it('answers 404 for unknown ids and 400 for malformed ones on every read', async () => {
    for (const url of [`/v1/direct-debits/${UNKNOWN_ID}`, `/v0/direct-debits/${UNKNOWN_ID}`, `/v1/direct-entry/${UNKNOWN_ID}/status`]) {
      expectError(await app.inject({ method: 'GET', url }), 404, /^NOT_FOUND: /)
    }
    expect((await app.inject({ method: 'GET', url: '/v1/direct-entry/nope/status' })).statusCode).toBe(400)
  })
})

describe('getDirectDebitsV1 / V0: listing', () => {
  it('filters on whole creation days, status and senderAccountNumber, pages in creation order', async () => {
    const a = await newAccount()
    const b = await newAccount()
    const day = await today()
    const first = await acceptedDd(a, { amount: 1 })
    const second = await acceptedDd(b, { amount: 2 })
    const rejected = ddBody(a, { amount: 3, senderAccountNumber: '99999999' })
    expect((await createDd(rejected)).json().outcome).toBe('REJECTED')
    await flush()

    const all = await listDd({ fromUtc: day, toUtc: day, offset: 0, limit: 1000 })
    expect(all.statusCode, all.body).toBe(200)
    const ids = (all.json() as DeDetailsV1[]).map((d) => d.transactionHayId)
    expect(ids.indexOf(first.transactionId)).toBeLessThan(ids.indexOf(second.transactionId))
    expect(ids.indexOf(second.transactionId)).toBeLessThan(ids.indexOf(rejected.transactionId))

    const mine = (await listDd({ fromUtc: day, toUtc: day, offset: 0, limit: 1000, senderAccountNumber: a.accountNumber! })).json() as DeDetailsV1[]
    expect(mine.map((d) => d.transactionHayId)).toEqual([first.transactionId])
    expect(mine[0]).toMatchObject({ outcome: 'COMPLETE', amount: 1, senderBsb: LOCAL_BSB, type: 'DEBIT' })

    const complete = (await listDd({ fromUtc: day, toUtc: day, offset: 0, limit: 1000, status: 'COMPLETE' })).json() as DeDetailsV1[]
    expect(complete.map((d) => d.transactionHayId)).toEqual(expect.arrayContaining([first.transactionId, second.transactionId]))
    expect(complete.every((d) => d.outcome === 'COMPLETE')).toBe(true)
    const rejectedOnly = (await listDd({ fromUtc: day, toUtc: day, offset: 0, limit: 1000, status: 'REJECTED', senderAccountNumber: '99999999' })).json() as DeDetailsV1[]
    expect(rejectedOnly.map((d) => d.transactionHayId)).toContain(rejected.transactionId)

    const paged = (await listDd({ fromUtc: day, toUtc: day, offset: ids.indexOf(second.transactionId), limit: 1 })).json() as DeDetailsV1[]
    expect(paged.map((d) => d.transactionHayId)).toEqual([second.transactionId])

    expect((await listDd({ fromUtc: addDays(day, -2), toUtc: addDays(day, -1), offset: 0, limit: 10, senderAccountNumber: a.accountNumber! })).json()).toEqual([])
    expect((await listDd({ fromUtc: addDays(day, 1), toUtc: addDays(day, 1), offset: 0, limit: 10, senderAccountNumber: a.accountNumber! })).json()).toEqual([])
    const wide = (await listDd({ fromUtc: addDays(day, -1), toUtc: addDays(day, 1), offset: 0, limit: 1000, senderAccountNumber: b.accountNumber! })).json() as DeDetailsV1[]
    expect(wide.map((d) => d.transactionHayId)).toEqual([second.transactionId])
    // an open-ended range: the last representable day is still an inclusive bound
    for (const version of ['v1', 'v0'] as const) {
      const open = (await listDd({ fromUtc: '1970-01-01', toUtc: '9999-12-31', offset: 0, limit: 1000, ...(version === 'v1' ? { senderAccountNumber: b.accountNumber! } : {}) }, version)).json() as DeDetailsV1[]
      expect(open.map((d) => d.transactionHayId), version).toContain(second.transactionId)
    }
  })

  it('rejects an inverted range, a limit outside 1..1000, a negative offset, a bad date and an out-of-enum status (400)', async () => {
    const day = await today()
    expectError(await listDd({ fromUtc: addDays(day, 1), toUtc: day, offset: 0, limit: 10 }), 400, /fromUtc/)
    expectError(await listDd({ fromUtc: day, toUtc: day, offset: 0, limit: 0 }), 400, /limit/)
    expectError(await listDd({ fromUtc: day, toUtc: day, offset: 0, limit: 1001 }), 400, /limit/)
    expectError(await listDd({ fromUtc: day, toUtc: day, offset: -1, limit: 10 }), 400, /offset/)
    expect((await listDd({ fromUtc: 'yesterday', toUtc: day, offset: 0, limit: 10 })).statusCode).toBe(400)
    expect((await listDd({ fromUtc: day, offset: 0, limit: 10 })).statusCode).toBe(400)
    expect((await listDd({ fromUtc: day, toUtc: day, offset: 0, limit: 10, status: 'REJECTED' }, 'v0')).statusCode).toBe(400)
    expect((await listDd({ fromUtc: day, toUtc: day, offset: 0, limit: 10, status: 'PENDING' })).statusCode).toBe(400)
  })

  it('v0 renders the v1 rows through the 4-value enum; a v0 filter matches every status that renders to it', async () => {
    const a = await newAccount()
    const high = await newAccount({ risk: 'HIGH' })
    const day = await today()
    const complete = await acceptedDd(a, { amount: 4 })
    const incomplete = await acceptedDd(high, { amount: 5 })
    const rejected = ddBody(a, { amount: 6, senderAccountNumber: '99999999' })
    await createDd(rejected)
    await flush()

    const submitted = (await listDd({ fromUtc: day, toUtc: day, offset: 0, limit: 1000, status: 'SUBMITTED' }, 'v0')).json() as DeDetails[]
    expect(submitted.map((d) => d.transactionHayId)).toContain(complete.transactionId)
    expect(submitted.find((d) => d.transactionHayId === complete.transactionId)).toMatchObject({ outcome: 'SUBMITTED', amount: 4 })
    expect(submitted.map((d) => d.transactionHayId)).not.toContain(incomplete.transactionId)
    const returned = (await listDd({ fromUtc: day, toUtc: day, offset: 0, limit: 1000, status: 'RETURNED' }, 'v0')).json() as DeDetails[]
    expect(returned.find((d) => d.transactionHayId === incomplete.transactionId)).toMatchObject({ outcome: 'RETURNED' })
    const unfiltered = (await listDd({ fromUtc: day, toUtc: day, offset: 0, limit: 1000 }, 'v0')).json() as DeDetails[]
    expect(unfiltered.find((d) => d.transactionHayId === rejected.transactionId)).toMatchObject({ outcome: 'REJECTED' })
    for (const d of unfiltered) expect(['ACCEPTED', 'REJECTED', 'SUBMITTED', 'RETURNED']).toContain(d.outcome)
  })
})

describe('createDirectDebitV0 (deprecated)', () => {
  it('serves the v1 flow with the v0 body, and answers rejections and request-level 422s with the declared DirectDebitResponse body', async () => {
    const sender = await newAccount()
    const body = ddBody(sender)
    const res = await createDd(body, 'v0')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ transactionId: body.transactionId, outcome: 'ACCEPTED', transactionDetails: expect.objectContaining({ outcome: 'ACCEPTED', transactionHayId: body.transactionId }) })
    await flush()
    expect(await deStatus(body.transactionId)).toBe('COMPLETE')
    expect((await getDd(body.transactionId, 'v0')) as DdResponse).toMatchObject({ outcome: 'SUBMITTED' })
    expect((await deEvents(body.transactionId)).map((e) => e.directEntryEvent.status)).toEqual(['RECEIVED', 'ACCEPTED', 'SUBMITTED', 'COMPLETE'])

    const rejected = ddBody(sender, { senderAccountNumber: '99999999' })
    const rej = await createDd(rejected, 'v0')
    expect(rej.statusCode, rej.body).toBe(422)
    expect(rej.json()).toEqual({ transactionId: rejected.transactionId, outcome: 'REJECTED', details: expect.stringContaining('Sender account not found'), transactionDetails: expect.objectContaining({ outcome: 'REJECTED' }) })
    expect(rej.json()).not.toHaveProperty('traceId')
    const replay = await createDd(rejected, 'v0')
    expect(replay.statusCode).toBe(422)
    expect(replay.json()).toEqual(rej.json())

    const dup = await createDd({ ...body, idempotencyKey: randomUUID() }, 'v0')
    expect(dup.statusCode).toBe(422)
    expect(dup.json()).toEqual({ transactionId: body.transactionId, outcome: 'REJECTED', details: expect.stringMatching(/^DUPLICATE_TRANSACTION_ID: /) })
    const reused = await createDd({ ...body, amount: 1 }, 'v0')
    expect(reused.statusCode).toBe(422)
    expect(reused.json()).toMatchObject({ outcome: 'REJECTED', details: expect.stringMatching(/^IDEMPOTENCY_KEY_REUSED: /) })
    expectError(await createDd(ddBody(sender, { amount: 0 }), 'v0'), 400, /amount/)
  })
})

describe('scheduled payments', () => {
  it('POST /_admin/scheduled-payments seeds an ACTIVE schedule (SCHEDULED_PAYMENT webhook) that the reads expose; a due ONE_TIME payment posts on the next tick', async () => {
    const account = await fundedAccount(500)
    const day = await today()
    const input = scheduleInput(account, { startDate: day })
    const created = await createSchedule(input)
    expect(created).toEqual({
      hayId: expect.stringMatching(UUID_RE), accountId: account.accountHayId, customerHayId: account.accountHolderId,
      amount: { currency: 'AUD', amount: 100 }, creationDateTimeUtc: expect.stringMatching(ISO_MICROS), description: 'Rent', reference: 'RENT-1',
      type: 'ONE_TIME', startDate: day, numberOfPayments: 1, numberOfProcessedPayments: 0, shouldCancelOnFailure: false,
      recipient: externalRecipient(), status: 'ACTIVE', previousVersions: [],
    })
    const events = await scheduleEvents(created.hayId!)
    expect(events).toHaveLength(1)
    assertValidNotification(events[0])
    expect(events[0]).toEqual({ customerHayId: account.accountHolderId, idempotencyKey: expect.stringMatching(UUID_RE), type: 'SCHEDULED_PAYMENT', actionOwner: 'CLIENT', scheduledPaymentEvent: { hayId: created.hayId } })

    // any request ticks the scheduler: the occurrence due today has run
    const list = await app.inject({ method: 'GET', url: `/v0/accounts/${account.accountHayId}/scheduledPayments` })
    expect(list.statusCode, list.body).toBe(200)
    const listed = (list.json() as HayScheduledPayment[]).find((s) => s.hayId === created.hayId)!
    expect(listed).toMatchObject({ status: 'COMPLETED', numberOfProcessedPayments: 1, lastProcessedDateTimeUtc: expect.stringMatching(ISO_MICROS) })
    expect(await getSchedule(account.accountHayId!, created.hayId!)).toEqual(listed)
    expect((await getAccount(account.accountHayId!)).totalBalance).toBe(400)

    const tx = (await txEvents(account.accountHayId!)).filter((p) => p.transactionEvent.originId === created.hayId)
    expect(tx).toHaveLength(1)
    assertValidNotification(tx[0])
    expect(tx[0]).toMatchObject({ actionOwner: 'PLATFORM', transactionEvent: { transactionType: 'INTERBANK_TRANSFER_OUT', currencyAmount: { amount: -100 }, outcome: 'ACCEPTED', isPending: false, originType: 'SCHEDULED_PAYMENT', originId: created.hayId, description: 'Rent', reference: 'RENT-1', counterpartDetails: { name: 'Landlord', basicAccountNumber: { branchNumber: EXTERNAL_BSB, accountNumber: '87654321' } } } })
    expect(await getTransaction(tx[0].transactionEvent.transactionHayId)).toMatchObject({ type: 'INTERBANK_TRANSFER_OUT', transactionChannel: 'CUSCAL_NPP_TRANSFER_OUT', originType: 'SCHEDULED_PAYMENT', originId: created.hayId })
    expect(await scheduleEvents(created.hayId!)).toHaveLength(1) // completion has no webhook
  })

  it('runs a RECURRING schedule on each occurrence date until numberOfPayments is reached (COMPLETED)', async () => {
    const account = await fundedAccount(1000)
    const start = addDays(await today(), 1)
    const s = await createSchedule(scheduleInput(account, { frequency: 'WEEKLY', startDate: start, numberOfPayments: 2, amount: 10 }))
    expect(s).toMatchObject({ type: 'RECURRING', frequency: 'WEEKLY', numberOfPayments: 2, status: 'ACTIVE' })
    expect(s).not.toHaveProperty('nextRunDate')
    expect((await getSchedule(account.accountHayId!, s.hayId!)).numberOfProcessedPayments).toBe(0)
    await advanceClock(DAY_MS)
    expect(await getSchedule(account.accountHayId!, s.hayId!)).toMatchObject({ status: 'ACTIVE', numberOfProcessedPayments: 1 })
    await advanceClock(6 * DAY_MS)
    expect((await getSchedule(account.accountHayId!, s.hayId!)).numberOfProcessedPayments).toBe(1)
    await advanceClock(DAY_MS)
    expect(await getSchedule(account.accountHayId!, s.hayId!)).toMatchObject({ status: 'COMPLETED', numberOfProcessedPayments: 2 })
    await advanceClock(7 * DAY_MS)
    expect((await getSchedule(account.accountHayId!, s.hayId!)).numberOfProcessedPayments).toBe(2)
    expect((await getAccount(account.accountHayId!)).totalBalance).toBe(980)
    await resetClock()
  })

  it('anchors MONTHLY occurrences on startDate, rolls an invalid day forward, and ends at endDate; catches up missed periods', async () => {
    await setClock('2027-01-31T10:00:00Z')
    try {
      const account = await fundedAccount(1000)
      // "next available date where invalid date is encountered in schedule i.e. 30th February": 1 March
      expect(occurrence('2027-01-31', 'MONTHLY', 1)).toBe('2027-03-01')
      expect(occurrence('2027-01-30', 'MONTHLY', 1)).toBe('2027-03-01')
      expect(occurrence('2028-01-30', 'MONTHLY', 1)).toBe('2028-03-01') // leap year: 29 Feb exists, 30 Feb does not
      expect(occurrence('2028-01-29', 'MONTHLY', 1)).toBe('2028-02-29')
      expect(occurrence('2027-01-31', 'MONTHLY', 2)).toBe('2027-03-31')
      expect(occurrence('2027-01-31', 'MONTHLY', 3)).toBe('2027-05-01')
      expect(occurrence('2026-11-30', 'QUARTERLY', 1)).toBe('2027-03-01')
      expect(occurrence('2026-11-30', 'QUARTERLY', 2)).toBe('2027-05-30')
      expect(occurrence('2027-12-31', 'MONTHLY', 2)).toBe('2028-03-01') // year rollover, then 31 Feb
      expect(nextOccurrence('2027-01-31', 'QUARTERLY', '2027-01-31')).toBe('2027-05-01')
      const s = await createSchedule(scheduleInput(account, { frequency: 'MONTHLY', startDate: '2027-01-31', endDate: '2027-03-15', amount: 10 }))
      expect(await getSchedule(account.accountHayId!, s.hayId!)).toMatchObject({ status: 'ACTIVE', numberOfProcessedPayments: 1 })
      await setClock('2027-02-28T10:00:00Z')
      expect((await getSchedule(account.accountHayId!, s.hayId!)).numberOfProcessedPayments).toBe(1)
      await setClock('2027-04-10T10:00:00Z') // 1 March ran late; 31 March is after endDate
      expect(await getSchedule(account.accountHayId!, s.hayId!)).toMatchObject({ status: 'COMPLETED', numberOfProcessedPayments: 2 })

      const weekly = await createSchedule(scheduleInput(account, { frequency: 'WEEKLY', startDate: '2027-04-01', numberOfPayments: 5, amount: 1 }))
      expect(await getSchedule(account.accountHayId!, weekly.hayId!)).toMatchObject({ status: 'ACTIVE', numberOfProcessedPayments: 2 }) // 1 and 8 April caught up in order
      expect((await getAccount(account.accountHayId!)).totalBalance).toBe(978)
    } finally {
      await resetClock()
    }
  })

  it('pays a local recipient with both intrabank legs and a BPAY biller with BPAY_TRANSFER_OUT', async () => {
    const payer = await fundedAccount(500)
    const payee = await newAccount()
    const day = await today()
    const internal = await createSchedule(scheduleInput(payer, { startDate: day, amount: 120, recipient: { recipientType: 'ACCOUNT', recipientName: 'Mate', recipientAccountNumber: { branchNumber: LOCAL_BSB, accountNumber: payee.accountNumber! } } }))
    await flush()
    expect(await getSchedule(payer.accountHayId!, internal.hayId!)).toMatchObject({ status: 'COMPLETED', numberOfProcessedPayments: 1 })
    expect((await getAccount(payer.accountHayId!)).totalBalance).toBe(380)
    expect((await getAccount(payee.accountHayId!)).totalBalance).toBe(120)
    const out = (await txEvents(payer.accountHayId!)).filter((p) => p.transactionEvent.originId === internal.hayId)
    const into = (await txEvents(payee.accountHayId!)).filter((p) => p.transactionEvent.originId === internal.hayId)
    expect(out).toHaveLength(1)
    expect(into).toHaveLength(1)
    assertValidNotification(into[0])
    expect(out[0].transactionEvent).toMatchObject({ transactionType: 'INTRABANK_TRANSFER_OUT', currencyAmount: { amount: -120 }, originType: 'SCHEDULED_PAYMENT', counterpartDetails: { accountId: payee.accountHayId, customerId: payee.accountHolderId, name: 'Mate' } })
    expect(into[0].transactionEvent).toMatchObject({ transactionType: 'INTRABANK_TRANSFER_IN', currencyAmount: { amount: 120 }, originType: 'SCHEDULED_PAYMENT', originId: internal.hayId, counterpartDetails: { accountId: payer.accountHayId, customerId: payer.accountHolderId, name: expect.stringMatching(/^Direct Entry\d+$/) } })

    const bpay = await createSchedule(scheduleInput(payer, { startDate: day, amount: 80, recipient: { recipientType: 'BPAY', recipientName: 'Power co', bpayDetails: { billerCode: '2005', billerReference: '12345678', billerName: 'Power Co' } } }))
    await flush()
    expect(await getSchedule(payer.accountHayId!, bpay.hayId!)).toMatchObject({ status: 'COMPLETED', recipient: { recipientType: 'BPAY', bpayDetails: { billerCode: '2005', billerReference: '12345678', billerName: 'Power Co' } } })
    expect((await getAccount(payer.accountHayId!)).totalBalance).toBe(300)
    const paid = (await txEvents(payer.accountHayId!)).filter((p) => p.transactionEvent.originId === bpay.hayId)
    expect(paid).toHaveLength(1)
    assertValidNotification(paid[0])
    // posted through bpay.post: the directory's biller name, the CRN as the transaction reference
    expect(paid[0].transactionEvent).toMatchObject({ transactionType: 'BPAY_TRANSFER_OUT', currencyAmount: { amount: -80 }, reference: '12345678', originType: 'SCHEDULED_PAYMENT', originId: bpay.hayId, counterpartName: 'Power co', counterpartDetails: { name: 'Power co', bpayDetails: { billerCode: '2005', billerReference: '12345678', billerName: 'BILLER LONG NAME 2005' } } })
    expect(await getTransaction(paid[0].transactionEvent.transactionHayId)).toMatchObject({ type: 'BPAY_TRANSFER_OUT', transactionChannel: 'CUSCAL_BPAY_TRANSFER_OUT', originType: 'SCHEDULED_PAYMENT', reference: '12345678' })
  })

  it('BPAY occurrences go through bpay.post: directory refusals end a shouldCancelOnFailure schedule as REJECTED with the refused TRANSACTION webhook', async () => {
    const payer = await fundedAccount(500)
    const day = await today()
    const bpayTo = (billerCode: string, billerReference: string, extra: Partial<CreateScheduleInput> = {}) =>
      createSchedule(scheduleInput(payer, { startDate: day, frequency: 'WEEKLY', shouldCancelOnFailure: true, amount: 25, recipient: { recipientType: 'BPAY', bpayDetails: { billerCode, billerReference } }, ...extra }))
    const cases: [string, string, string][] = [
      ['000000', '12345678', 'REFUSED_BPAY_INVALID_BILLER_CODE'], // deactivated biller
      ['1016', '1234567890', 'REFUSED_BPAY_INVALID_BILLER_CODE'], // inactive Staging fixture
      ['123', '12345678', 'REFUSED_BPAY_INVALID_BILLER_CODE'], // not a 4-10 digit biller code
      ['7773', '1234', 'REFUSED_BPAY_INVALID_REFERENCE'], // fixture 7773 takes 8-digit CRNs
      ['7773', '12345678', 'REFUSED_BPAY_INVALID_PAYMENT'], // ... and at least $20 (amount 10 below)
    ]
    for (const [billerCode, crn, outcome] of cases) {
      const s = await bpayTo(billerCode, crn, outcome === 'REFUSED_BPAY_INVALID_PAYMENT' ? { amount: 10 } : {})
      await flush()
      expect(await getSchedule(payer.accountHayId!, s.hayId!), billerCode).toMatchObject({ status: 'REJECTED', numberOfProcessedPayments: 0 })
      const refused = (await txEvents(payer.accountHayId!)).filter((p) => p.transactionEvent.originId === s.hayId)
      expect(refused, billerCode).toHaveLength(1)
      assertValidNotification(refused[0])
      expect(refused[0]).toMatchObject({ actionOwner: 'PLATFORM', transactionEvent: { outcome, transactionType: 'BPAY_TRANSFER_OUT', isPending: false, currencyAmount: { amount: outcome === 'REFUSED_BPAY_INVALID_PAYMENT' ? -10 : -25 }, reference: crn, originType: 'SCHEDULED_PAYMENT', originId: s.hayId, counterpartDetails: { bpayDetails: { billerCode, billerReference: crn } } } })
    }
    expect((await getAccount(payer.accountHayId!)).totalBalance).toBe(500)

    // the ledger's refusals use the webhook vocabulary: not enough funds -> FAILED, the BPAY daily limit -> FAILED
    const broke = await newAccount()
    const poor = await createSchedule(scheduleInput(broke, { startDate: day, frequency: 'WEEKLY', shouldCancelOnFailure: true, recipient: { recipientType: 'BPAY', bpayDetails: { billerCode: '2005', billerReference: '12345678' } } }))
    await flush()
    expect((await getSchedule(broke.accountHayId!, poor.hayId!)).status).toBe('FAILED')
    const noFunds = (await txEvents(broke.accountHayId!)).filter((p) => p.transactionEvent.originId === poor.hayId)
    expect(noFunds.map((p) => p.transactionEvent.outcome)).toEqual(['REFUSED_NOT_ENOUGH_FUNDS'])
    // no recipientName: the counterpart is the directory's biller name
    expect(noFunds[0].transactionEvent).toMatchObject({ counterpartName: 'BILLER LONG NAME 2005', counterpartDetails: { name: 'BILLER LONG NAME 2005', bpayDetails: { billerName: 'BILLER LONG NAME 2005' } } })
    await setLimit(payer.accountHayId!, 'BPAY_DAILY_LIMIT', 30)
    const capped = await bpayTo('2005', '12345678', { amount: 40 })
    await flush()
    expect((await getSchedule(payer.accountHayId!, capped.hayId!)).status).toBe('FAILED')
    expect((await txEvents(payer.accountHayId!)).filter((p) => p.transactionEvent.originId === capped.hayId).map((p) => p.transactionEvent.outcome)).toEqual(['REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED'])
  })

  it('a refused occurrence emits the refused TRANSACTION webhook and ends the schedule (FAILED / REJECTED) or is skipped', async () => {
    const day = await today()
    const broke = await newAccount()
    const cancelling = await createSchedule(scheduleInput(broke, { startDate: day, frequency: 'WEEKLY', shouldCancelOnFailure: true }))
    await flush()
    expect(await getSchedule(broke.accountHayId!, cancelling.hayId!)).toMatchObject({ status: 'FAILED', numberOfProcessedPayments: 0 })
    const refused = (await txEvents(broke.accountHayId!)).filter((p) => p.transactionEvent.originId === cancelling.hayId)
    expect(refused).toHaveLength(1)
    assertValidNotification(refused[0])
    expect(refused[0].transactionEvent).toMatchObject({ outcome: 'REFUSED_NOT_ENOUGH_FUNDS', transactionType: 'INTERBANK_TRANSFER_OUT', isPending: false, currencyAmount: { amount: -100 }, originType: 'SCHEDULED_PAYMENT' })

    const oneTime = await createSchedule(scheduleInput(broke, { startDate: day }))
    await flush()
    expect((await getSchedule(broke.accountHayId!, oneTime.hayId!)).status).toBe('FAILED')

    const lenient = await createSchedule(scheduleInput(broke, { startDate: day, frequency: 'WEEKLY', numberOfPayments: 2, shouldCancelOnFailure: false }))
    await flush()
    expect(await getSchedule(broke.accountHayId!, lenient.hayId!)).toMatchObject({ status: 'ACTIVE', numberOfProcessedPayments: 0 })
    await credit(broke.accountHayId!, 1000)
    await flush()
    expect((await getSchedule(broke.accountHayId!, lenient.hayId!)).numberOfProcessedPayments).toBe(0) // the failed occurrence is not retried
    await advanceClock(7 * DAY_MS)
    expect(await getSchedule(broke.accountHayId!, lenient.hayId!)).toMatchObject({ status: 'ACTIVE', numberOfProcessedPayments: 1 })
    await resetClock()

    const closedPayee = await newAccount()
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${closedPayee.accountHayId}/close` })).statusCode).toBe(202)
    await flush()
    const toClosed = await createSchedule(scheduleInput(broke, { startDate: day, recipient: { recipientType: 'ACCOUNT', recipientName: 'Gone', recipientAccountNumber: { branchNumber: LOCAL_BSB, accountNumber: closedPayee.accountNumber! } } }))
    await flush()
    expect((await getSchedule(broke.accountHayId!, toClosed.hayId!)).status).toBe('REJECTED')
    const rejected = (await txEvents(broke.accountHayId!)).filter((p) => p.transactionEvent.originId === toClosed.hayId)
    expect(rejected[0]?.transactionEvent).toMatchObject({ outcome: 'REFUSED_RECIPIENT_ACCOUNT_CLOSED', transactionType: 'INTRABANK_TRANSFER_OUT' })
  })

  it('cancelScheduledPayment: ACTIVE -> CANCELLED (no further occurrences, no webhook), idempotent on CANCELLED, 422 on other terminal statuses, 404 on unknown or foreign ids', async () => {
    const account = await fundedAccount(500)
    const start = addDays(await today(), 1)
    const s = await createSchedule(scheduleInput(account, { startDate: start }))
    const cancel = await app.inject({ method: 'POST', url: `/v0/accounts/${account.accountHayId}/scheduledPayments/${s.hayId}/cancel` })
    expect(cancel.statusCode, cancel.body).toBe(200)
    expect(cancel.json()).toEqual({ message: 'Cancel Scheduled Payment successful.' })
    expect((await getSchedule(account.accountHayId!, s.hayId!)).status).toBe('CANCELLED')
    await advanceClock(2 * DAY_MS)
    expect(await getSchedule(account.accountHayId!, s.hayId!)).toMatchObject({ status: 'CANCELLED', numberOfProcessedPayments: 0 })
    await resetClock()
    expect((await getAccount(account.accountHayId!)).totalBalance).toBe(500)
    expect((await allPayloads()).filter((p) => p.type === 'SCHEDULED_PAYMENT' && p.scheduledPaymentEvent?.hayId === s.hayId)).toHaveLength(1)
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${account.accountHayId}/scheduledPayments/${s.hayId}/cancel` })).statusCode).toBe(200)

    const done = await createSchedule(scheduleInput(account, { startDate: await today() }))
    await flush()
    expect((await getSchedule(account.accountHayId!, done.hayId!)).status).toBe('COMPLETED')
    expectError(await app.inject({ method: 'POST', url: `/v0/accounts/${account.accountHayId}/scheduledPayments/${done.hayId}/cancel` }), 422, /^INVALID_STATUS_TRANSITION: /)

    const other = await newAccount()
    expectError(await app.inject({ method: 'POST', url: `/v0/accounts/${other.accountHayId}/scheduledPayments/${s.hayId}/cancel` }), 404, /^NOT_FOUND: /)
    expectError(await app.inject({ method: 'GET', url: `/v0/accounts/${other.accountHayId}/scheduledPayments/${s.hayId}` }), 404, /^NOT_FOUND: /)
    expectError(await app.inject({ method: 'GET', url: `/v0/accounts/${account.accountHayId}/scheduledPayments/${UNKNOWN_ID}` }), 404, /^NOT_FOUND: /)
    expectError(await app.inject({ method: 'GET', url: `/v0/accounts/${UNKNOWN_ID}/scheduledPayments` }), 404, /^NOT_FOUND: /)
    expectError(await app.inject({ method: 'POST', url: `/v0/accounts/${UNKNOWN_ID}/scheduledPayments/${s.hayId}/cancel` }), 404, /^NOT_FOUND: /)
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${account.accountHayId}/scheduledPayments/nope` })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${other.accountHayId}/scheduledPayments` })).json()).toEqual([])
  })

  it('updates an ACTIVE schedule in place with `replaces`, archiving the old definition as REPLACED', async () => {
    const account = await fundedAccount(500)
    const start = addDays(await today(), 3)
    const s = await createSchedule(scheduleInput(account, { startDate: start, amount: 50 }))
    const updated = await createSchedule(scheduleInput(account, { startDate: start, amount: 75, replaces: s.hayId! }), 200)
    expect(updated).toMatchObject({ hayId: s.hayId, amount: { amount: 75 }, status: 'ACTIVE', creationDateTimeUtc: s.creationDateTimeUtc })
    expect(updated.previousVersions).toEqual([{ ...s, previousVersions: undefined, status: 'REPLACED' }].map((v) => { const { previousVersions: _p, ...rest } = v; return rest }))
    expect(await scheduleEvents(s.hayId!)).toHaveLength(1)
    expect(await getSchedule(account.accountHayId!, s.hayId!)).toEqual(updated)

    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${account.accountHayId}/scheduledPayments/${s.hayId}/cancel` })).statusCode).toBe(200)
    expectError(await app.inject({ method: 'POST', url: '/_admin/scheduled-payments', payload: scheduleInput(account, { startDate: start, replaces: s.hayId! }) }), 422, /^INVALID_STATUS_TRANSITION: /)
    expectError(await app.inject({ method: 'POST', url: '/_admin/scheduled-payments', payload: scheduleInput(account, { startDate: start, replaces: UNKNOWN_ID }) }), 404, /^NOT_FOUND: /)
  })

  it('`replaces` keeps the processed counters and resumes after the last payment: paid occurrences are never replayed', async () => {
    await setClock('2027-03-10T10:00:00Z')
    try {
      const account = await fundedAccount(1000)
      const s = await createSchedule(scheduleInput(account, { frequency: 'MONTHLY', startDate: '2027-01-05', amount: 10 }))
      const paid = await getSchedule(account.accountHayId!, s.hayId!)
      expect(paid).toMatchObject({ status: 'ACTIVE', numberOfProcessedPayments: 3 }) // 5 Jan, 5 Feb, 5 Mar caught up
      expect((await getAccount(account.accountHayId!)).totalBalance).toBe(970)

      const updated = await createSchedule(scheduleInput(account, { frequency: 'MONTHLY', startDate: '2027-01-05', amount: 11, replaces: s.hayId! }), 200)
      expect(updated).toMatchObject({ status: 'ACTIVE', numberOfProcessedPayments: 3, lastProcessedDateTimeUtc: paid.lastProcessedDateTimeUtc, amount: { amount: 11 } })
      expect(updated.previousVersions).toEqual([expect.objectContaining({ status: 'REPLACED', numberOfProcessedPayments: 3, amount: { currency: 'AUD', amount: 10 } })])
      expect(await getSchedule(account.accountHayId!, s.hayId!)).toMatchObject({ numberOfProcessedPayments: 3 })
      expect((await getAccount(account.accountHayId!)).totalBalance).toBe(970)
      await setClock('2027-04-04T10:00:00Z')
      expect(await getSchedule(account.accountHayId!, s.hayId!)).toMatchObject({ numberOfProcessedPayments: 3 })
      expect((await getAccount(account.accountHayId!)).totalBalance).toBe(970)
      await setClock('2027-04-05T10:00:00Z')
      expect(await getSchedule(account.accountHayId!, s.hayId!)).toMatchObject({ status: 'ACTIVE', numberOfProcessedPayments: 4 })
      expect((await getAccount(account.accountHayId!)).totalBalance).toBe(959)

      // switching to WEEKLY (4 Jan + 7k: ..., 5 Apr, 12 Apr) on the day of a payment: 12 Apr is next, not 5 Apr again
      const weekly = await createSchedule(scheduleInput(account, { frequency: 'WEEKLY', startDate: '2027-01-04', amount: 1, replaces: s.hayId! }), 200)
      expect(weekly).toMatchObject({ numberOfProcessedPayments: 4, frequency: 'WEEKLY' })
      await setClock('2027-04-11T10:00:00Z')
      expect((await getSchedule(account.accountHayId!, s.hayId!)).numberOfProcessedPayments).toBe(4)
      await setClock('2027-04-12T10:00:00Z')
      expect((await getSchedule(account.accountHayId!, s.hayId!)).numberOfProcessedPayments).toBe(5)
      expect((await getAccount(account.accountHayId!)).totalBalance).toBe(958)

      // nothing paid yet: resumes at the first occurrence on or after today, never replaying past dates
      const later = await createSchedule(scheduleInput(account, { frequency: 'MONTHLY', startDate: '2027-06-01', amount: 5 }))
      await createSchedule(scheduleInput(account, { frequency: 'MONTHLY', startDate: '2027-01-12', amount: 5, replaces: later.hayId! }), 200)
      expect(await getSchedule(account.accountHayId!, later.hayId!)).toMatchObject({ numberOfProcessedPayments: 1 }) // 12 Apr (today) only
      expect((await getAccount(account.accountHayId!)).totalBalance).toBe(953)

      // a definition with nothing left to run is refused
      const bad = async (input: CreateScheduleInput) => expectError(await app.inject({ method: 'POST', url: '/_admin/scheduled-payments', payload: input }), 422, /^INVALID_SCHEDULE: /)
      await bad(scheduleInput(account, { frequency: 'WEEKLY', startDate: '2027-01-04', numberOfPayments: 5, replaces: s.hayId! }))
      await bad(scheduleInput(account, { frequency: 'WEEKLY', startDate: '2027-01-04', endDate: '2027-04-18', replaces: s.hayId! })) // next would be 19 Apr
      await bad(scheduleInput(account, { startDate: '2027-04-12', replaces: later.hayId! })) // ONE_TIME: already paid once
      expect(await getSchedule(account.accountHayId!, s.hayId!)).toMatchObject({ status: 'ACTIVE', numberOfProcessedPayments: 5, frequency: 'WEEKLY' })
    } finally {
      await resetClock()
    }
  })

  it('validates the seeding body', async () => {
    const account = await newAccount()
    const stranger = await newCustomer()
    const bad = async (input: object, status: number, code: RegExp) => expectError(await app.inject({ method: 'POST', url: '/_admin/scheduled-payments', payload: input }), status, code)
    await bad({ ...scheduleInput(account), recipient: undefined }, 400, /BAD_REQUEST/)
    await bad(scheduleInput(account, { recipient: { recipientType: 'ACCOUNT' } }), 400, /recipientAccountNumber/)
    await bad(scheduleInput(account, { recipient: { recipientType: 'BPAY', bpayDetails: { billerCode: '12' } } }), 400, /bpayDetails/)
    await bad(scheduleInput(account, { recipient: { recipientType: 'ACCOUNT', recipientAccountNumber: { branchNumber: LOCAL_BSB, accountNumber: '99999999' } } }), 400, /no local account/)
    await bad(scheduleInput(account, { recipient: { recipientType: 'ACCOUNT', recipientAccountNumber: { branchNumber: LOCAL_BSB, accountNumber: account.accountNumber! } } }), 400, /paying account/)
    await bad(scheduleInput(account, { type: 'RECURRING' }), 400, /frequency/)
    await bad(scheduleInput(account, { frequency: 'DAILY' as never }), 400, /frequency/)
    await bad(scheduleInput(account, { endDate: '2026-02-01' }), 400, /ONE_TIME/)
    await bad(scheduleInput(account, { frequency: 'WEEKLY', endDate: '2025-12-31' }), 400, /endDate/)
    await bad(scheduleInput(account, { frequency: 'WEEKLY', numberOfPayments: 0 }), 400, /numberOfPayments/)
    await bad(scheduleInput(account, { startDate: '2026-02-30' }), 400, /startDate/)
    await bad(scheduleInput(account, { amount: 0 }), 400, /amount/)
    await bad(scheduleInput(account, { amount: 1.005 }), 400, /amount/)
    await bad(scheduleInput(account, { currency: 'USD' }), 400, /currency/)
    await bad(scheduleInput(account, { customerHayId: stranger }), 422, /^PERMISSION_DENIED: /)
    await bad(scheduleInput(account, { accountId: UNKNOWN_ID }), 404, /^NOT_FOUND: /)
    await bad(scheduleInput(account, { accountId: 'nope' }), 400, /accountId/)
  })

  it('closing an account cancels its ACTIVE schedules (platform); in-flight instructions still block closure', async () => {
    const account = await newAccount()
    const s = await createSchedule(scheduleInput(account, { startDate: addDays(await today(), 30), frequency: 'MONTHLY' }))
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${account.accountHayId}/close` })).statusCode).toBe(202)
    await flush()
    expect((await getAccount(account.accountHayId!)).status).toBe('CLOSED')
    expect((await getSchedule(account.accountHayId!, s.hayId!)).status).toBe('CANCELLED')

    // a closed account takes no new schedule (closure would never cancel it: S7's resource gate)
    const before = (await allPayloads()).length
    expectError(await app.inject({ method: 'POST', url: '/_admin/scheduled-payments', payload: scheduleInput(account, { startDate: await today() }) }), 422, /^ACCOUNT_CLOSED: /)
    await flush()
    expect((await allPayloads()).length).toBe(before)
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${account.accountHayId}/scheduledPayments` })).json()).toHaveLength(1)
  })
})
