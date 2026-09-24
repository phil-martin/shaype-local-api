import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '../src/contract/generated/b2b-types.js'
import { startApp } from './helpers.js'
import { assertValidNotification } from './webhook-schema.js'
import type { BuiltServer } from '../src/server.js'
import { LOCAL_PRODUCT_ID } from '../src/domains/accounts/index.js'
import { TAGS_400_MESSAGE, toRestOutcome, type AuthoriseHoldInput, type CardContext, type TransactionsService } from '../src/domains/transactions/index.js'
import type { PayIdDep } from '../src/domains/transactions/deps.js'

type S = components['schemas']
type HayAccount = S['HayAccount']
type FinancialTransaction = S['FinancialTransaction']
type CreateBody = S['CreateTransactionRequestBody']
type TransferBody = S['TransferOutRequestBody']

const TRANSACTION_OPS = [
  'getTransactionById', 'getTagsForTransaction', 'modifyTagsForTransaction', 'searchTransactions',
  'createCreditTransactionV0', 'createDebitTransactionV0', 'createCreditTransactionV1', 'createDebitTransactionV1',
  'getAuthorisationHold', 'getPendingHolds', 'makeTransferV0', 'makeTransferV1',
]
const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111'
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const UUID_RE = /^[0-9a-f-]{36}$/
const AUD = (amount: number) => ({ currency: 'AUD', amount })
const DAY_MS = 24 * 60 * 60 * 1000

let built: BuiltServer
let app: BuiltServer['app']
let svc: TransactionsService
beforeAll(async () => { built = await startApp(); app = built.app; svc = built.ctx.services.transactions })
afterAll(async () => { await built.app.close() })

let n = 0
async function flush(): Promise<void> {
  await app.inject({ method: 'POST', url: '/_admin/flush' })
}
async function advanceClock(ms: number): Promise<void> {
  await app.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: ms } })
}
async function newCustomer(): Promise<string> {
  n++
  const res = await app.inject({
    method: 'POST', url: '/v0/customers/create',
    payload: {
      idempotencyKey: randomUUID(), email: `txn${n}@example.com`, customerTier: 'STANDARD',
      phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: `6${String(n).padStart(8, '0')}` },
      address: { line1: '1 Test St', townOrCity: 'Sydney', administrativeRegion: 'NSW', postcode: '2000', countryCodeIso: 'AUS' },
      customerDetails: { firstName: 'Ledger', lastName: `Holder${n}`, dateOfBirth: '1990-01-01' },
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
function creditBody(accountHayId: string, amount: number, overrides: Partial<CreateBody> = {}): CreateBody {
  return { idempotencyKey: randomUUID(), accountHayId, amount, counterpartName: 'Payroll Pty Ltd', description: 'September pay', transactionChannel: 'MANUAL_ADJUSTMENT', ...overrides }
}
async function post(url: string, payload: object | string) {
  return app.inject({ method: 'POST', url, payload })
}
async function credit(accountHayId: string, amount: number, overrides: Partial<CreateBody> = {}): Promise<{ outcome: string; transactionId?: string }> {
  const res = await post('/v1/transactions/credit', creditBody(accountHayId, amount, overrides))
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
async function debit(accountHayId: string, amount: number, overrides: Partial<CreateBody> = {}): Promise<{ outcome: string; transactionId?: string }> {
  const res = await post('/v1/transactions/debit', creditBody(accountHayId, amount, { counterpartName: 'Fee collector', description: 'Monthly fee', transactionChannel: 'SERVICE_FEE', ...overrides }))
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
/** A funded LOW-risk account (credit posted, so ACTIVE). */
async function fundedAccount(amount: number, holder?: string): Promise<HayAccount> {
  const a = await newAccount({ holder })
  expect((await credit(a.accountHayId!, amount)).outcome).toBe('ACCEPTED')
  return getAccount(a.accountHayId!)
}
async function getTransaction(id: string): Promise<FinancialTransaction> {
  const res = await app.inject({ method: 'GET', url: `/v1/transactions/${id}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as FinancialTransaction
}
async function allPayloads(): Promise<any[]> {
  await flush()
  const res = await app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })
  return (res.json() as { payload: any }[]).map((r) => r.payload)
}
async function txEvents(accountId: string): Promise<any[]> {
  return (await allPayloads()).filter((p) => p.type === 'TRANSACTION' && p.transactionEvent?.accountHayId === accountId)
}
async function accountEvents(accountId: string): Promise<any[]> {
  return (await allPayloads()).filter((p) => p.type === 'ACCOUNT_STATUS_CHANGE' && p.accountStatusChangeEvent?.accountHayId === accountId)
}
function expectError(res: { statusCode: number; json: () => any }, status: number, code: RegExp | string): void {
  expect(res.statusCode).toBe(status)
  const body = res.json()
  expect(body).toMatchObject({ status: String(status), details: expect.stringContaining('traceId') })
  expect(body.traceId).toMatch(UUID_RE)
  expect(body.message).toMatch(code)
}
function balances(a: HayAccount): Record<string, number> {
  return { total: a.totalBalance!, available: a.availableBalance!, held: a.heldBalance!, status: a.status as unknown as number }
}
function card(overrides: Partial<CardContext> = {}): CardContext {
  return {
    cardHayId: randomUUID(), cardToken: '123456789', lastFour: '4321',
    cardUsage: { isMagneticStripePayment: false, isContactless: false, isCardPresent: true, isMobileWalletPayment: false, isAtmWithdrawal: false },
    merchant: { name: 'IGA (Mt Cotton)', merchantId: '000009493578577', merchantCategoryCode: 5411, cardAcceptorLocation: 'Mt Cotton QLD' },
    ...overrides,
  }
}
function holdInput(accountId: string, cents: number, overrides: Partial<AuthoriseHoldInput> = {}): AuthoriseHoldInput {
  return { accountId, card: card(), amountCents: cents, ...overrides }
}

// ---------------------------------------------------------------------------------------------------

describe('transactions domain: registration', () => {
  it('handles every Transactions API / Holds API operation plus getPendingHolds and makeTransferV0/V1 (none left on the stub)', async () => {
    const res = await app.inject({ method: 'GET', url: '/_admin/operations' })
    const { handled, stubbed } = res.json() as { handled: string[]; stubbed: string[] }
    for (const op of TRANSACTION_OPS) {
      expect(handled, op).toContain(op)
      expect(stubbed, op).not.toContain(op)
    }
  })
})

describe('createCreditTransactionV1 (POST /v1/transactions/credit)', () => {
  it('posts a GENERAL_CREDIT: balances move, APPROVED -> ACTIVE, the FinancialTransaction and the TRANSACTION webhook carry the documented fields', async () => {
    const holder = await newCustomer()
    const a = await newAccount({ holder })
    expect(a.status).toBe('APPROVED')
    const originId = randomUUID()
    const r = await credit(a.accountHayId!, 123.45, { category: 'SALARY', originType: 'HAAS_OPERATIONS', originId, originChannel: 'VENUE', reference: 'REF123' })
    expect(r.outcome).toBe('ACCEPTED')
    expect(r.transactionId).toMatch(UUID_RE)

    const after = await getAccount(a.accountHayId!)
    expect(after).toMatchObject({ status: 'ACTIVE', totalBalance: 123.45, availableBalance: 123.45, heldBalance: 0 })

    const t = await getTransaction(r.transactionId!)
    expect(t).toEqual({
      transactionHayId: r.transactionId, accountHayId: a.accountHayId, customerId: holder, productId: LOCAL_PRODUCT_ID,
      type: 'GENERAL_CREDIT', transactionChannel: 'MANUAL_ADJUSTMENT',
      currencyAmount: AUD(123.45), rollingAccountBalance: 123.45,
      transactionTimeUtc: expect.stringMatching(ISO_MICROS), clearingTimeUtc: expect.stringMatching(ISO_MICROS),
      description: 'September pay', category: 'SALARY', reference: 'REF123',
      counterpartName: 'Payroll Pty Ltd', counterpartDetails: { name: 'Payroll Pty Ltd' },
      originType: 'HAAS_OPERATIONS', originId, originChannel: 'VENUE',
      reportedFraudulent: false, tags: [],
    })
    expect(t.transactionTimeUtc).toBe(t.clearingTimeUtc)

    const status = await accountEvents(a.accountHayId!)
    expect(status.map((e) => e.accountStatusChangeEvent.accountStatus)).toEqual(['APPROVED', 'ACTIVE'])
    expect(status[1].actionOwner).toBe('PLATFORM')

    const events = await txEvents(a.accountHayId!)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      customerHayId: holder, idempotencyKey: expect.stringMatching(UUID_RE), type: 'TRANSACTION', actionOwner: 'CLIENT', productId: LOCAL_PRODUCT_ID,
      transactionEvent: {
        transactionHayId: r.transactionId, accountHayId: a.accountHayId,
        currencyAmount: AUD(123.45), updatedBalance: AUD(123.45), isPending: false,
        counterpartName: 'Payroll Pty Ltd', outcome: 'ACCEPTED', transactionTimeUtc: t.transactionTimeUtc,
        isAtmTransaction: false, transactionType: 'GENERAL_CREDIT',
        accountBalances: { totalBalance: AUD(123.45), heldBalance: AUD(0), lockedBalance: AUD(0), stacksBalance: AUD(0), availableBalance: AUD(123.45) },
        customerHayId: holder, counterpartDetails: { name: 'Payroll Pty Ltd' },
        originId, originType: 'HAAS_OPERATIONS', category: 'SALARY', description: 'September pay', reference: 'REF123',
      },
    })
    assertValidNotification(events[0])
  })

  it('replays the same idempotencyKey with an identical body (one posting) and refuses a different body', async () => {
    const a = await newAccount()
    const body = creditBody(a.accountHayId!, 10)
    const first = await post('/v1/transactions/credit', body)
    const again = await post('/v1/transactions/credit', body)
    expect(first.statusCode).toBe(200)
    expect(again.json()).toEqual(first.json())
    expect((await getAccount(a.accountHayId!)).totalBalance).toBe(10)
    expect(svc.listForAccount(a.accountHayId!)).toHaveLength(1)
    expectError(await post('/v1/transactions/credit', { ...body, amount: 11 }), 422, /^IDEMPOTENCY_KEY_REUSED/)
  })

  it('400 for a non-positive amount or more than two decimals; 404 for an unknown account; 400 for a missing field or bad enum', async () => {
    const a = await newAccount()
    expectError(await post('/v1/transactions/credit', creditBody(a.accountHayId!, 0)), 400, /^BAD_REQUEST: amount must be greater than 0/)
    expectError(await post('/v1/transactions/credit', creditBody(a.accountHayId!, -5)), 400, /^BAD_REQUEST: amount/)
    expectError(await post('/v1/transactions/credit', creditBody(a.accountHayId!, 1.005)), 400, /^BAD_REQUEST: amount must be a number with at most 2 decimal places/)
    expectError(await post('/v1/transactions/credit', creditBody(UNKNOWN_ID, 5)), 404, /^NOT_FOUND: Account/)
    expectError(await post('/v1/transactions/credit', { ...creditBody(a.accountHayId!, 5), description: undefined }), 400, /^BAD_REQUEST/)
    expectError(await post('/v1/transactions/credit', creditBody(a.accountHayId!, 5, { transactionChannel: 'VISA_ATM' as any })), 400, /^BAD_REQUEST/)
    expect((await getAccount(a.accountHayId!)).totalBalance).toBe(0)
  })

  it('REFUSED_MAX_BALANCE_EXCEEDED (v1) / REFUSED_LIMIT_BREACH (v0) when the credit would exceed MAX_BALANCE; nothing is posted and no webhook is emitted', async () => {
    const a = await newAccount()
    expect((await app.inject({ method: 'PATCH', url: `/v0/accounts/${a.accountHayId}/max-balance`, payload: { maxBalanceLimit: 100 } })).statusCode).toBe(200)
    expect(await credit(a.accountHayId!, 100.01)).toEqual({ outcome: 'REFUSED_MAX_BALANCE_EXCEEDED' })
    const v0 = await post('/v0/transactions/credit/create', creditBody(a.accountHayId!, 100.01))
    expect(v0.json()).toEqual({ outcome: 'REFUSED_LIMIT_BREACH' })
    expect(await txEvents(a.accountHayId!)).toEqual([])
    expect((await getAccount(a.accountHayId!)).status).toBe('APPROVED')
    expect(await credit(a.accountHayId!, 100)).toMatchObject({ outcome: 'ACCEPTED' })
    expect(await credit(a.accountHayId!, 0.01)).toEqual({ outcome: 'REFUSED_MAX_BALANCE_EXCEEDED' })
  })

  it('risk level HIGH (the default) refuses every credit with REFUSED_MAX_BALANCE_EXCEEDED and every debit with REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED', async () => {
    const a = await newAccount({ risk: 'HIGH' })
    expect(await credit(a.accountHayId!, 1)).toEqual({ outcome: 'REFUSED_MAX_BALANCE_EXCEEDED' })
    expect(await debit(a.accountHayId!, 1)).toEqual({ outcome: 'REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED' })
    expect((await post('/v0/transactions/debit/create', creditBody(a.accountHayId!, 1))).json()).toEqual({ outcome: 'REFUSED_LIMIT_BREACH' })
  })

  it('REFUSED_ACCOUNT_BLOCKED on a LOCKED account and REFUSED_ACCOUNT_CLOSED on a CLOSED one', async () => {
    const a = await newAccount()
    expect((await post(`/v0/accounts/${a.accountHayId}/block`, { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' })).statusCode).toBe(200)
    expect(await credit(a.accountHayId!, 1)).toEqual({ outcome: 'REFUSED_ACCOUNT_BLOCKED' })
    expect(await debit(a.accountHayId!, 1)).toEqual({ outcome: 'REFUSED_ACCOUNT_BLOCKED' })
    const closed = await newAccount()
    expect((await post(`/v0/accounts/${closed.accountHayId}/close`, { reason: 'CUSTOMER' })).statusCode).toBe(202)
    await flush()
    expect((await getAccount(closed.accountHayId!)).status).toBe('CLOSED')
    expect(await credit(closed.accountHayId!, 1)).toEqual({ outcome: 'REFUSED_ACCOUNT_CLOSED' })
    expect(await debit(closed.accountHayId!, 1)).toEqual({ outcome: 'REFUSED_ACCOUNT_CLOSED' })
  })
})

describe('createDebitTransactionV1 / V0 (POST /v1/transactions/debit, /v0/transactions/debit/create)', () => {
  it('posts a GENERAL_DEBIT with a negative currencyAmount; rollingAccountBalance is the total after; webhook GENERAL_DEBIT', async () => {
    const a = await fundedAccount(50)
    const r = await debit(a.accountHayId!, 20.5)
    expect(r.outcome).toBe('ACCEPTED')
    const t = await getTransaction(r.transactionId!)
    expect(t).toMatchObject({ type: 'GENERAL_DEBIT', transactionChannel: 'SERVICE_FEE', currencyAmount: AUD(-20.5), rollingAccountBalance: 29.5, counterpartName: 'Fee collector' })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 29.5, availableBalance: 29.5 })
    const events = await txEvents(a.accountHayId!)
    expect(events).toHaveLength(2)
    expect(events[1].transactionEvent).toMatchObject({ transactionType: 'GENERAL_DEBIT', currencyAmount: AUD(-20.5), updatedBalance: AUD(29.5), isPending: false, outcome: 'ACCEPTED' })
    assertValidNotification(events[1])
    const v0 = await post('/v0/transactions/debit/create', creditBody(a.accountHayId!, 9.5, { transactionChannel: 'ACCOUNT_ADJUSTMENT' }))
    expect(v0.json()).toMatchObject({ outcome: 'ACCEPTED' })
    expect((await getTransaction(v0.json().transactionId)).type).toBe('GENERAL_DEBIT')
    expect((await getAccount(a.accountHayId!)).totalBalance).toBe(20)
  })

  it('REFUSED_INSUFFICIENT_FUNDS when the debit exceeds the available balance (nothing posted); the overdraft limit is spendable', async () => {
    const a = await fundedAccount(10)
    expect(await debit(a.accountHayId!, 10.01)).toEqual({ outcome: 'REFUSED_INSUFFICIENT_FUNDS' })
    expect((await getAccount(a.accountHayId!)).totalBalance).toBe(10)
    expect(svc.listForAccount(a.accountHayId!)).toHaveLength(1)
    expect((await app.inject({ method: 'PATCH', url: `/v0/accounts/${a.accountHayId}/overdraft`, payload: { overdraftLimit: 100 } })).statusCode).toBe(200)
    expect(await debit(a.accountHayId!, 60)).toMatchObject({ outcome: 'ACCEPTED' })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 50, availableBalance: 50, overdraftBalance: 50, status: 'ACTIVE' })
    expect(await debit(a.accountHayId!, 50.01)).toEqual({ outcome: 'REFUSED_INSUFFICIENT_FUNDS' })
  })

  it('the daily transfers-out cap is a rolling 24 h window over posted debits: REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED (v1) / REFUSED_LIMIT_BREACH (v0), open again a day later', async () => {
    const a = await fundedAccount(300_000)
    expect(await debit(a.accountHayId!, 60_000)).toMatchObject({ outcome: 'ACCEPTED' })
    expect(await debit(a.accountHayId!, 40_000.01)).toEqual({ outcome: 'REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED' })
    expect((await post('/v0/transactions/debit/create', creditBody(a.accountHayId!, 40_000.01))).json()).toEqual({ outcome: 'REFUSED_LIMIT_BREACH' })
    expect(await debit(a.accountHayId!, 40_000)).toMatchObject({ outcome: 'ACCEPTED' })
    expect(await debit(a.accountHayId!, 0.01)).toEqual({ outcome: 'REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED' })
    await advanceClock(DAY_MS + 1000)
    expect(await debit(a.accountHayId!, 1)).toMatchObject({ outcome: 'ACCEPTED' })
  })

  it('TOTAL_SPEND_PER_YEAR has no REST value: REFUSED_LIMIT_BREACH on both versions', async () => {
    const a = await fundedAccount(1000)
    expect((await app.inject({ method: 'PUT', url: `/v1/accounts/${a.accountHayId}/limits/TOTAL_SPEND_PER_YEAR`, payload: { limitAmount: 100 } })).statusCode).toBe(200)
    expect(await debit(a.accountHayId!, 100)).toMatchObject({ outcome: 'ACCEPTED' })
    expect(await debit(a.accountHayId!, 0.01)).toEqual({ outcome: 'REFUSED_LIMIT_BREACH' })
    expect((await post('/v0/transactions/debit/create', creditBody(a.accountHayId!, 0.01))).json()).toEqual({ outcome: 'REFUSED_LIMIT_BREACH' })
  })
})

describe('makeTransferV1 / V0 (POST /v1/accounts/{accountId}/transfer)', () => {
  function transferBody(senderCustomerHayId: string, overrides: Partial<TransferBody> = {}): TransferBody {
    return { idempotencyKey: randomUUID(), senderCustomerHayId, amount: 25, description: 'Dinner', category: 'EATING_OUT', transferType: 'INTERNAL', ...overrides }
  }

  it('INTERNAL: posts both legs atomically (INTRABANK_TRANSFER_OUT / _IN), each customer gets its TRANSACTION webhook, transactionId is the sender posting', async () => {
    const senderCustomer = await newCustomer()
    const sender = await fundedAccount(100, senderCustomer)
    const recipientCustomer = await newCustomer()
    const recipient = await newAccount({ holder: recipientCustomer })
    const body = transferBody(senderCustomer, { internalTransfer: { recipientAccountHayId: recipient.accountHayId!, recipientName: 'Bob', senderName: 'Alice' } })
    const res = await post(`/v1/accounts/${sender.accountHayId}/transfer`, body)
    expect(res.statusCode, res.body).toBe(200)
    const r = res.json() as { outcome: string; transactionId: string }
    expect(r.outcome).toBe('ACCEPTED')

    expect(await getAccount(sender.accountHayId!)).toMatchObject({ totalBalance: 75, availableBalance: 75 })
    expect(await getAccount(recipient.accountHayId!)).toMatchObject({ totalBalance: 25, availableBalance: 25, status: 'ACTIVE' })

    const out = await getTransaction(r.transactionId)
    expect(out).toMatchObject({
      accountHayId: sender.accountHayId, customerId: senderCustomer, type: 'INTRABANK_TRANSFER_OUT', transactionChannel: 'HAAS_TRANSFER_INTERNAL_OUT',
      currencyAmount: AUD(-25), rollingAccountBalance: 75, description: 'Dinner', category: 'EATING_OUT', originType: 'CUSTOMER',
      counterpartName: 'Bob', counterpartDetails: { accountId: recipient.accountHayId, customerId: recipientCustomer, name: 'Bob' },
    })
    const [into] = svc.listForAccount(recipient.accountHayId!)
    expect(svc.toResponse(into!)).toMatchObject({
      type: 'INTRABANK_TRANSFER_IN', transactionChannel: 'HAAS_TRANSFER_INTERNAL_IN', currencyAmount: AUD(25), rollingAccountBalance: 25, description: 'Dinner',
      counterpartName: 'Alice', counterpartDetails: { accountId: sender.accountHayId, customerId: senderCustomer, name: 'Alice' },
    })

    const sent = (await txEvents(sender.accountHayId!)).at(-1)
    expect(sent).toMatchObject({ customerHayId: senderCustomer, actionOwner: 'CLIENT', transactionEvent: { transactionHayId: r.transactionId, transactionType: 'INTRABANK_TRANSFER_OUT', currencyAmount: AUD(-25), updatedBalance: AUD(75), counterpartName: 'Bob', counterpartDetails: { accountId: recipient.accountHayId, customerId: recipientCustomer, name: 'Bob' }, category: 'EATING_OUT', description: 'Dinner', isPending: false, outcome: 'ACCEPTED' } })
    const received = (await txEvents(recipient.accountHayId!)).at(-1)
    expect(received).toMatchObject({ customerHayId: recipientCustomer, actionOwner: 'CLIENT', transactionEvent: { transactionHayId: into!.id, transactionType: 'INTRABANK_TRANSFER_IN', currencyAmount: AUD(25), updatedBalance: AUD(25), counterpartName: 'Alice', accountBalances: { totalBalance: AUD(25), availableBalance: AUD(25) } } })
    assertValidNotification(sent)
    assertValidNotification(received)

    // idempotent replay
    const again = await post(`/v1/accounts/${sender.accountHayId}/transfer`, body)
    expect(again.json()).toEqual(r)
    expect((await getAccount(sender.accountHayId!)).totalBalance).toBe(75)
    expectError(await post(`/v1/accounts/${sender.accountHayId}/transfer`, { ...body, amount: 26 }), 422, /^IDEMPOTENCY_KEY_REUSED/)
  })

  it('ACCOUNT to the local BSB 636220 is converted to an internal transfer (the recipient leg names the sending customer when senderName is absent); another BSB posts INTERBANK_TRANSFER_OUT (NPP) with basicAccountNumber', async () => {
    const senderCustomer = await newCustomer()
    const sender = await fundedAccount(100, senderCustomer)
    const recipient = await newAccount()
    const local = await post(`/v1/accounts/${sender.accountHayId}/transfer`, transferBody(senderCustomer, { transferType: 'ACCOUNT', accountTransfer: { bsb: '636220', accountNumber: recipient.accountNumber!, recipientName: 'Bob' } }))
    expect(local.json()).toMatchObject({ outcome: 'ACCEPTED' })
    expect((await getTransaction(local.json().transactionId)).type).toBe('INTRABANK_TRANSFER_OUT')
    expect((await getAccount(recipient.accountHayId!)).totalBalance).toBe(25)
    const { firstName, lastName } = built.ctx.services.customers.get(senderCustomer).customerDetails
    const senderName = `${firstName} ${lastName}`
    const [into] = svc.listForAccount(recipient.accountHayId!)
    expect(svc.toResponse(into!)).toMatchObject({ type: 'INTRABANK_TRANSFER_IN', counterpartName: senderName, counterpartDetails: { accountId: sender.accountHayId, customerId: senderCustomer, name: senderName } })
    const received = (await txEvents(recipient.accountHayId!)).at(-1)
    expect(received.transactionEvent).toMatchObject({ transactionType: 'INTRABANK_TRANSFER_IN', counterpartName: senderName, counterpartDetails: { name: senderName } })
    assertValidNotification(received)

    const npp = await post(`/v0/accounts/${sender.accountHayId}/transfer`, transferBody(senderCustomer, { amount: 10, reference: 'INV-42', transferType: 'ACCOUNT', accountTransfer: { bsb: '062000', accountNumber: '12345678', recipientName: 'Andy', senderName: 'Alice' } }))
    expect(npp.json()).toMatchObject({ outcome: 'ACCEPTED' })
    const t = await getTransaction(npp.json().transactionId)
    expect(t).toMatchObject({ type: 'INTERBANK_TRANSFER_OUT', transactionChannel: 'CUSCAL_NPP_TRANSFER_OUT', currencyAmount: AUD(-10), reference: 'INV-42', rollingAccountBalance: 65, counterpartName: 'Andy', counterpartDetails: { name: 'Andy', basicAccountNumber: { accountNumber: '12345678', branchNumber: '062000' } } })
    expect(t.counterpartDetails).not.toHaveProperty('accountId')
    const ev = (await txEvents(sender.accountHayId!)).at(-1)
    expect(ev.transactionEvent).toMatchObject({ transactionType: 'INTERBANK_TRANSFER_OUT', currencyAmount: AUD(-10), updatedBalance: AUD(65), reference: 'INV-42', counterpartDetails: { name: 'Andy', basicAccountNumber: { accountNumber: '12345678', branchNumber: '062000' } } })
    assertValidNotification(ev)
    expect(await txEvents(sender.accountHayId!)).toHaveLength(3)

    expectError(await post(`/v1/accounts/${sender.accountHayId}/transfer`, transferBody(senderCustomer, { transferType: 'ACCOUNT', accountTransfer: { bsb: '636220', accountNumber: '99999999', recipientName: 'Nobody' } })), 422, /^INVALID_RECIPIENT/)
  })

  it('PAY_ID resolves through services.payid: REFUSED_INVALID_PAY_ID without a PayID service or for an unknown PayID, internal when it resolves locally, NPP otherwise', async () => {
    const senderCustomer = await newCustomer()
    const sender = await fundedAccount(100, senderCustomer)
    const recipient = await newAccount()
    const body = (payId: string) => transferBody(senderCustomer, { transferType: 'PAY_ID', payIdTransfer: { payId, recipientName: 'Bob' } })
    expect((await post(`/v1/accounts/${sender.accountHayId}/transfer`, body('bob@example.com'))).json()).toEqual({ outcome: 'REFUSED_INVALID_PAY_ID' })

    const services = built.ctx.services as unknown as { payid?: PayIdDep }
    services.payid = {
      resolve: (payId) => payId === 'bob@example.com' ? { accountNumber: recipient.accountNumber!, branchNumber: '636220', ownerName: 'Bob' }
        : payId === 'andy@other.bank' ? { accountNumber: '12345678', branchNumber: '062000', ownerName: 'Andy' } : undefined,
    }
    try {
      expect((await post(`/v1/accounts/${sender.accountHayId}/transfer`, body('nobody@example.com'))).json()).toEqual({ outcome: 'REFUSED_INVALID_PAY_ID' })
      const local = await post(`/v1/accounts/${sender.accountHayId}/transfer`, body('bob@example.com'))
      expect(local.json()).toMatchObject({ outcome: 'ACCEPTED' })
      expect((await getTransaction(local.json().transactionId)).type).toBe('INTRABANK_TRANSFER_OUT')
      expect((await getAccount(recipient.accountHayId!)).totalBalance).toBe(25)
      const npp = await post(`/v1/accounts/${sender.accountHayId}/transfer`, body('andy@other.bank'))
      expect(npp.json()).toMatchObject({ outcome: 'ACCEPTED' })
      expect(await getTransaction(npp.json().transactionId)).toMatchObject({ type: 'INTERBANK_TRANSFER_OUT', counterpartDetails: { name: 'Bob', basicAccountNumber: { accountNumber: '12345678', branchNumber: '062000' } } })
    } finally {
      delete services.payid
    }
  })

  it('recipient refusals: REFUSED_RECIPIENT_ACCOUNT_BLOCKED / _CLOSED and the recipient MAX_BALANCE (REFUSED_MAX_BALANCE_EXCEEDED on v1 and v0 alike)', async () => {
    const senderCustomer = await newCustomer()
    const sender = await fundedAccount(1000, senderCustomer)
    const to = (recipient: HayAccount, amount = 25) => transferBody(senderCustomer, { amount, internalTransfer: { recipientAccountHayId: recipient.accountHayId!, recipientName: 'Bob', senderName: 'Alice' } })

    const blocked = await newAccount()
    await post(`/v0/accounts/${blocked.accountHayId}/block`, { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' })
    expect((await post(`/v1/accounts/${sender.accountHayId}/transfer`, to(blocked))).json()).toEqual({ outcome: 'REFUSED_RECIPIENT_ACCOUNT_BLOCKED' })

    const closed = await newAccount()
    await post(`/v0/accounts/${closed.accountHayId}/close`, {})
    await flush()
    expect((await post(`/v1/accounts/${sender.accountHayId}/transfer`, to(closed))).json()).toEqual({ outcome: 'REFUSED_RECIPIENT_ACCOUNT_CLOSED' })

    const capped = await newAccount()
    await app.inject({ method: 'PATCH', url: `/v0/accounts/${capped.accountHayId}/max-balance`, payload: { maxBalanceLimit: 20 } })
    expect((await post(`/v1/accounts/${sender.accountHayId}/transfer`, to(capped))).json()).toEqual({ outcome: 'REFUSED_MAX_BALANCE_EXCEEDED' })
    expect((await post(`/v0/accounts/${sender.accountHayId}/transfer`, to(capped))).json()).toEqual({ outcome: 'REFUSED_MAX_BALANCE_EXCEEDED' })
    const highRisk = await newAccount({ risk: 'HIGH' })
    expect((await post(`/v1/accounts/${sender.accountHayId}/transfer`, to(highRisk))).json()).toEqual({ outcome: 'REFUSED_MAX_BALANCE_EXCEEDED' })
    expect((await getAccount(sender.accountHayId!)).totalBalance).toBe(1000)
  })

  it('sender refusals: REFUSED_ACCOUNT_BLOCKED, REFUSED_INSUFFICIENT_FUNDS, PAYMENT_TO_ACCOUNT_NUMBER (REFUSED_LIMIT_BREACH), daily transfers-out (detailed on v0 too), risk HIGH', async () => {
    const senderCustomer = await newCustomer()
    const sender = await fundedAccount(50, senderCustomer)
    const recipient = await newAccount()
    const to = (amount: number) => transferBody(senderCustomer, { amount, internalTransfer: { recipientAccountHayId: recipient.accountHayId!, recipientName: 'Bob', senderName: 'Alice' } })
    expect((await post(`/v1/accounts/${sender.accountHayId}/transfer`, to(50.01))).json()).toEqual({ outcome: 'REFUSED_INSUFFICIENT_FUNDS' })
    await app.inject({ method: 'PUT', url: `/v1/accounts/${sender.accountHayId}/limits/PAYMENT_TO_ACCOUNT_NUMBER`, payload: { limitAmount: 10 } })
    expect((await post(`/v1/accounts/${sender.accountHayId}/transfer`, to(10.01))).json()).toEqual({ outcome: 'REFUSED_LIMIT_BREACH' })
    expect((await post(`/v1/accounts/${sender.accountHayId}/transfer`, to(10))).json()).toMatchObject({ outcome: 'ACCEPTED' })
    await app.inject({ method: 'PATCH', url: `/v0/accounts/${sender.accountHayId}/riskLevel`, payload: { level: 'HIGH', reason: 'test' } })
    expect((await post(`/v1/accounts/${sender.accountHayId}/transfer`, to(1))).json()).toEqual({ outcome: 'REFUSED_LIMIT_BREACH' })
    await app.inject({ method: 'PATCH', url: `/v0/accounts/${sender.accountHayId}/riskLevel`, payload: { level: 'LOW', reason: 'test' } })
    await post(`/v0/accounts/${sender.accountHayId}/block`, { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' })
    expect((await post(`/v1/accounts/${sender.accountHayId}/transfer`, to(1))).json()).toEqual({ outcome: 'REFUSED_ACCOUNT_BLOCKED' })

    const big = await fundedAccount(300_000, senderCustomer)
    const bigTo = (amount: number) => transferBody(senderCustomer, { amount, transferType: 'ACCOUNT', accountTransfer: { bsb: '062000', accountNumber: '12345678', recipientName: 'Andy' } })
    expect((await post(`/v1/accounts/${big.accountHayId}/transfer`, bigTo(50_000))).json()).toMatchObject({ outcome: 'ACCEPTED' })
    expect((await post(`/v1/accounts/${big.accountHayId}/transfer`, bigTo(50_000))).json()).toMatchObject({ outcome: 'ACCEPTED' })
    expect((await post(`/v1/accounts/${big.accountHayId}/transfer`, bigTo(0.01))).json()).toEqual({ outcome: 'REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED' })
    expect((await post(`/v0/accounts/${big.accountHayId}/transfer`, bigTo(0.01))).json()).toEqual({ outcome: 'REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED' })
  })

  it('a CLOSED or LOCKED sender is refused before the recipient is resolved (REFUSED_ACCOUNT_CLOSED / _BLOCKED even for an unknown PayID); nothing moves, no webhook', async () => {
    const holder = await newCustomer()
    const closed = await newAccount({ holder })
    expect((await post(`/v0/accounts/${closed.accountHayId}/close`, { reason: 'CUSTOMER' })).statusCode).toBe(202)
    await flush()
    const recipient = await newAccount()
    const internal = transferBody(holder, { internalTransfer: { recipientAccountHayId: recipient.accountHayId!, recipientName: 'Bob', senderName: 'Alice' } })
    const res = await post(`/v1/accounts/${closed.accountHayId}/transfer`, internal)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ outcome: 'REFUSED_ACCOUNT_CLOSED' })
    expect((await post(`/v1/accounts/${closed.accountHayId}/transfer`, transferBody(holder, { transferType: 'PAY_ID', payIdTransfer: { payId: 'nobody@example.com', recipientName: 'Bob' } }))).json()).toEqual({ outcome: 'REFUSED_ACCOUNT_CLOSED' })

    const lockedHolder = await newCustomer()
    const locked = await fundedAccount(50, lockedHolder)
    await post(`/v0/accounts/${locked.accountHayId}/block`, { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' })
    const before = (await txEvents(locked.accountHayId!)).length
    expect((await post(`/v1/accounts/${locked.accountHayId}/transfer`, transferBody(lockedHolder, { transferType: 'PAY_ID', payIdTransfer: { payId: 'nobody@example.com', recipientName: 'Bob' } }))).json()).toEqual({ outcome: 'REFUSED_ACCOUNT_BLOCKED' })
    expect((await post(`/v0/accounts/${locked.accountHayId}/transfer`, transferBody(lockedHolder, { transferType: 'ACCOUNT', accountTransfer: { bsb: '062000', accountNumber: '12345678', recipientName: 'Andy' } }))).json()).toEqual({ outcome: 'REFUSED_ACCOUNT_BLOCKED' })
    expect(await getAccount(locked.accountHayId!)).toMatchObject({ status: 'LOCKED', totalBalance: 50, availableBalance: 50 })
    expect((await getAccount(recipient.accountHayId!)).totalBalance).toBe(0)
    expect((await txEvents(locked.accountHayId!)).length).toBe(before)
    expect(await txEvents(closed.accountHayId!)).toEqual([])
  })

  it('no FX: an INTERNAL transfer between accounts of different currencies, and any non-INTERNAL transfer from an FX child, are REFUSED_CAPABILITY_NOT_ENABLED before anything moves', async () => {
    const holder = await newCustomer()
    const parent = await fundedAccount(100, holder)
    const created = await post('/v1/accounts', { idempotencyKey: randomUUID(), accountHolderId: holder, accountHolderType: 'CUSTOMER', productId: LOCAL_PRODUCT_ID, currency: 'USD', parentAccountId: parent.accountHayId })
    expect(created.statusCode, created.body).toBe(200)
    const child = created.json() as HayAccount
    expect(child).toMatchObject({ currency: 'USD', parentAccountId: parent.accountHayId })
    // LOW risk so a refusal cannot be a limit
    expect((await app.inject({ method: 'PATCH', url: `/v0/accounts/${child.accountHayId}/riskLevel`, payload: { level: 'LOW', reason: 'test' } })).statusCode).toBe(200)

    const toChild = transferBody(holder, { internalTransfer: { recipientAccountHayId: child.accountHayId!, recipientName: 'Me', senderName: 'Me' } })
    expect((await post(`/v1/accounts/${parent.accountHayId}/transfer`, toChild)).json()).toEqual({ outcome: 'REFUSED_CAPABILITY_NOT_ENABLED' })
    expect((await post(`/v1/accounts/${parent.accountHayId}/transfer`, transferBody(holder, { transferType: 'ACCOUNT', accountTransfer: { bsb: '636220', accountNumber: child.accountNumber!, recipientName: 'Me' } }))).json()).toEqual({ outcome: 'REFUSED_CAPABILITY_NOT_ENABLED' })
    expect(await getAccount(parent.accountHayId!)).toMatchObject({ totalBalance: 100, availableBalance: 100 })
    expect(await getAccount(child.accountHayId!)).toMatchObject({ totalBalance: 0, status: 'APPROVED' })

    const fromChild = (overrides: Partial<TransferBody>) => post(`/v1/accounts/${child.accountHayId}/transfer`, transferBody(holder, { amount: 1, ...overrides }))
    expect((await fromChild({ transferType: 'ACCOUNT', accountTransfer: { bsb: '062000', accountNumber: '12345678', recipientName: 'Andy' } })).json()).toEqual({ outcome: 'REFUSED_CAPABILITY_NOT_ENABLED' })
    expect((await fromChild({ transferType: 'ACCOUNT', accountTransfer: { bsb: '636220', accountNumber: parent.accountNumber!, recipientName: 'Me' } })).json()).toEqual({ outcome: 'REFUSED_CAPABILITY_NOT_ENABLED' })
    // rails before PayID resolution: without a PayID service this would otherwise be REFUSED_INVALID_PAY_ID
    expect((await fromChild({ transferType: 'PAY_ID', payIdTransfer: { payId: 'andy@other.bank', recipientName: 'Andy' } })).json()).toEqual({ outcome: 'REFUSED_CAPABILITY_NOT_ENABLED' })
    expect((await fromChild({ internalTransfer: { recipientAccountHayId: parent.accountHayId!, recipientName: 'Me', senderName: 'Me' } })).json()).toEqual({ outcome: 'REFUSED_CAPABILITY_NOT_ENABLED' })
    expect(await txEvents(child.accountHayId!)).toEqual([])
    expect(svc.listForAccount(child.accountHayId!)).toEqual([])
  })

  it('FX children are not on domestic rails: NPP / DE credits, a direct debit and PayTo legs on a child are refused (REFUSED_CAPABILITY_NOT_ENABLED), never posted 1:1 across currencies', async () => {
    const holder = await newCustomer()
    const parent = await fundedAccount(100, holder)
    const created = await post('/v1/accounts', { idempotencyKey: randomUUID(), accountHolderId: holder, accountHolderType: 'CUSTOMER', productId: LOCAL_PRODUCT_ID, currency: 'USD', parentAccountId: parent.accountHayId })
    expect(created.statusCode, created.body).toBe(200)
    const child = created.json() as HayAccount
    expect((await app.inject({ method: 'PATCH', url: `/v0/accounts/${child.accountHayId}/riskLevel`, payload: { level: 'LOW', reason: 'test' } })).statusCode).toBe(200)
    expect((await credit(child.accountHayId!, 20)).outcome).toBe('ACCEPTED')
    const ok = (res: { statusCode: number; body: string }) => expect(res.statusCode, res.body).toBe(200)

    ok(await post('/v0/utils/generate-npp-inbound', {
      idempotencyKey: randomUUID(), amount: 50, description: 'npp', receiverBsb: child.bsb, receiverAccountNumber: child.accountNumber, receiverName: 'Me',
      senderBsb: '302227', senderAccountNumber: '112836327', senderName: 'Andy',
    }))
    ok(await post('/v0/utils/generate-inbound-npp-transaction-v2', {
      creditorInformation: { accountIdentification: `${child.bsb}${child.accountNumber}`, accountIdentificationTypeCode: 'BBAN' },
      debtorInformation: { accountIdentification: '63610079412687', accountIdentificationTypeCode: 'BBAN', partyName: 'Andy' },
      initgPtyIdOrgId: 'NPBOAU21XXX', paymentId: 'ANNCAU22XXX20230718000000000077240',
      paymentInformation: { endToEndIdentification: 'NET-1', instructedAmount: '5', originalMessageIdentification: 'ANNCAU22XXX20230718000000000077240', transactionIdentification: 'ANNCAU22XXXN20230718000000000077240' },
    }))
    ok(await post('/v0/utils/generate-de-inbound', {
      recordType: 'DIRECT', transactionType: 'CREDIT', amount: 25, description: 'de', recipientAccountNumber: child.accountNumber, recipientBsb: child.bsb, recipientName: 'Me',
      senderAccountNumber: '112836327', senderBsb: '302227', senderName: 'Darth',
    }))
    const dd = await post('/v1/direct-debits', {
      idempotencyKey: randomUUID(), transactionId: randomUUID(), amount: 10, description: 'dd', senderBsb: child.bsb!, senderAccountNumber: child.accountNumber!, senderName: 'Me',
      recipientBsb: '302227', recipientAccountNumber: '123456789', recipientName: 'Debtor',
    })
    ok(dd)
    expect(dd.json().outcome).toBe('REJECTED')

    // PayTo: the child as creditor (AC14) and as debtor (AC13); the parent pays / is paid nothing
    const mandate = async (creditorAccountId: string, debtorAccountId: string) => {
      const res = await post('/v1/payto/initiator/mandates', {
        idempotencyKey: randomUUID(), creditorDetails: { accountId: creditorAccountId, partyType: 'ORGANISATION', ultimatePartyName: 'ACME' },
        debtorDetails: { partyName: 'Me', partyType: 'PERSON', accountId: debtorAccountId }, description: 'Bills',
        paymentTerms: { frequency: 'ADHOC', type: 'VARIABLE', maximumAmount: AUD(900) }, purposeCode: 'UTILITY', validityStartDate: '2020-10-06',
      })
      ok(res)
      const id = res.json().mandateId as string
      ok(await app.inject({ method: 'PATCH', url: `/v1/payto/payer/mandates/${id}/resolve?resolution=ACCEPT` }))
      return id
    }
    const adhoc = async (mandateId: string) => {
      const res = await post('/v1/payto/payments/adhoc', { idempotencyKey: randomUUID(), mandateId, amount: AUD(10) })
      ok(res)
      return [res.json().transactionStatus, (await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${mandateId}/instructions/${res.json().instructionId}/status` })).json().transactionStatusReasonCode]
    }
    expect(await adhoc(await mandate(child.accountHayId!, parent.accountHayId!))).toEqual(['REJECTED', 'AC14'])
    expect(await adhoc(await mandate(parent.accountHayId!, child.accountHayId!))).toEqual(['REJECTED', 'AC13'])
    await flush()

    expect(await getAccount(child.accountHayId!)).toMatchObject({ currency: 'USD', totalBalance: 20 })
    expect(await getAccount(parent.accountHayId!)).toMatchObject({ totalBalance: 100 })
    const refused = (await txEvents(child.accountHayId!)).map((p) => p.transactionEvent).filter((e) => e.outcome !== 'ACCEPTED')
    expect(refused.map((e) => [e.transactionType, e.outcome, e.currencyAmount.amount])).toEqual([
      ['INTERBANK_TRANSFER_IN', 'REFUSED_CAPABILITY_NOT_ENABLED', 50],
      ['INTERBANK_TRANSFER_IN', 'REFUSED_CAPABILITY_NOT_ENABLED', 5],
      ['INTERBANK_TRANSFER_IN', 'REFUSED_CAPABILITY_NOT_ENABLED', 25],
    ])
  })

  it('400 when the transfer-type object is missing or malformed, 404 for unknown sender / customer / recipient, 422 PERMISSION_DENIED for a non-holder, 422 INVALID_RECIPIENT for a self transfer', async () => {
    const senderCustomer = await newCustomer()
    const sender = await fundedAccount(50, senderCustomer)
    const other = await newCustomer()
    const url = `/v1/accounts/${sender.accountHayId}/transfer`
    expectError(await post(url, transferBody(senderCustomer)), 400, /^BAD_REQUEST: internalTransfer is required/)
    expectError(await post(url, transferBody(senderCustomer, { transferType: 'ACCOUNT' })), 400, /^BAD_REQUEST: accountTransfer is required/)
    expectError(await post(url, transferBody(senderCustomer, { transferType: 'PAY_ID' })), 400, /^BAD_REQUEST: payIdTransfer is required/)
    expectError(await post(url, transferBody(senderCustomer, { transferType: 'ACCOUNT', accountTransfer: { bsb: '1234567', accountNumber: '12345678', recipientName: 'A' } })), 400, /^BAD_REQUEST: accountTransfer\/bsb/)
    expectError(await post(url, transferBody(senderCustomer, { amount: 1.005, internalTransfer: { recipientAccountHayId: sender.accountHayId!, recipientName: 'B', senderName: 'A' } })), 400, /^BAD_REQUEST: amount/)
    expectError(await post(url, transferBody(senderCustomer, { amount: 0, internalTransfer: { recipientAccountHayId: sender.accountHayId!, recipientName: 'B', senderName: 'A' } })), 400, /^BAD_REQUEST/)
    expectError(await post(`/v1/accounts/${UNKNOWN_ID}/transfer`, transferBody(senderCustomer, { internalTransfer: { recipientAccountHayId: sender.accountHayId!, recipientName: 'B', senderName: 'A' } })), 404, /^NOT_FOUND: Account/)
    expectError(await post(url, transferBody(UNKNOWN_ID, { internalTransfer: { recipientAccountHayId: sender.accountHayId!, recipientName: 'B', senderName: 'A' } })), 404, /^NOT_FOUND: Customer/)
    expectError(await post(url, transferBody(other, { internalTransfer: { recipientAccountHayId: sender.accountHayId!, recipientName: 'B', senderName: 'A' } })), 422, /^PERMISSION_DENIED/)
    expectError(await post(url, transferBody(senderCustomer, { internalTransfer: { recipientAccountHayId: UNKNOWN_ID, recipientName: 'B', senderName: 'A' } })), 404, /^NOT_FOUND: Account/)
    expectError(await post(url, transferBody(senderCustomer, { internalTransfer: { recipientAccountHayId: sender.accountHayId!, recipientName: 'B', senderName: 'A' } })), 422, /^INVALID_RECIPIENT/)
    expect((await getAccount(sender.accountHayId!)).totalBalance).toBe(50)
  })
})

describe('holds (services.transactions.holds, GET /v1/holds/{holdId}, GET /v0/accounts/{accountId}/holds)', () => {
  it('authorise: held +a, available -a, total unchanged; webhook CARD_TRANSACTION pending with transactionHayId == holdHayId; the hold reads through both endpoints', async () => {
    const holder = await newCustomer()
    const a = await fundedAccount(11.13, holder)
    const c = card()
    const r = svc.holds.authorise(holdInput(a.accountHayId!, 840, { card: c, description: 'IGA purchase' }))
    expect(r.outcome).toBe('ACCEPTED')
    const hold = r.hold!
    expect(hold).toMatchObject({ state: 'AUTHORISED', type: 'CARD_PRESENT_PAYMENT', channel: 'VISA_CARD_PRESENT', amount: 840, currency: 'AUD', cardId: c.cardHayId, customerId: holder, category: '5411' })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 11.13, heldBalance: 8.4, availableBalance: 2.73 })

    const events = await txEvents(a.accountHayId!)
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({
      customerHayId: holder, idempotencyKey: expect.stringMatching(UUID_RE), type: 'TRANSACTION', actionOwner: 'PLATFORM', productId: LOCAL_PRODUCT_ID,
      transactionEvent: {
        transactionHayId: hold.id, holdHayId: hold.id, accountHayId: a.accountHayId,
        currencyAmount: AUD(-8.4), updatedBalance: AUD(2.73), isPending: true, outcome: 'ACCEPTED',
        transactionTimeUtc: hold.authorisedAt, isAtmTransaction: false, transactionType: 'CARD_TRANSACTION',
        cardUsageDetails: { isMagneticStripePayment: false, isContactless: false, isCardPresent: true, isMobileWalletPayment: false, isAtmWithdrawal: false },
        accountBalances: { totalBalance: AUD(11.13), heldBalance: AUD(8.4), lockedBalance: AUD(0), stacksBalance: AUD(0), availableBalance: AUD(2.73) },
        cardHayId: c.cardHayId, customerHayId: holder, counterpartName: 'IGA (Mt Cotton)', category: '5411', merchantId: '000009493578577', description: 'IGA purchase',
      },
    })
    assertValidNotification(events[1])

    const byId = await app.inject({ method: 'GET', url: `/v1/holds/${hold.id}` })
    expect(byId.statusCode, byId.body).toBe(200)
    expect(byId.json()).toEqual({
      holdHayId: hold.id, accountHayId: a.accountHayId, cardId: c.cardHayId, customerId: holder, currencyAmount: AUD(-8.4), description: 'IGA purchase', category: '5411',
      merchantDetails: c.merchant, transactionChannel: 'VISA_CARD_PRESENT', transactionTimeUtc: hold.authorisedAt, type: 'CARD_PRESENT_PAYMENT',
    })
    const pending = await app.inject({ method: 'GET', url: `/v0/accounts/${a.accountHayId}/holds` })
    expect(pending.json()).toEqual([byId.json()])
    expectError(await app.inject({ method: 'GET', url: `/v1/holds/${UNKNOWN_ID}` }), 404, /^NOT_FOUND: Hold/)
    expectError(await app.inject({ method: 'GET', url: `/v0/accounts/${UNKNOWN_ID}/holds` }), 404, /^NOT_FOUND: Account/)
    expectError(await app.inject({ method: 'GET', url: `/v1/transactions/${hold.id}` }), 404, /^NOT_FOUND: Transaction/)
  })

  it('settle: the hold is released and a new CARD_PRESENT_PAYMENT transaction with relatedHoldHayId is posted (total -h, held -h, available unchanged); webhook CARD_TRANSACTION_SETTLED with a new id', async () => {
    const a = await fundedAccount(11.13)
    const hold = svc.holds.authorise(holdInput(a.accountHayId!, 840)).hold!
    const r = svc.holds.settle(hold.id)
    expect(r.outcome).toBe('ACCEPTED')
    expect(r.hold!.state).toBe('SETTLED')
    const t = r.transaction!
    expect(t.id).not.toBe(hold.id)
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 2.73, heldBalance: 0, availableBalance: 2.73 })
    expect(await getTransaction(t.id)).toMatchObject({
      type: 'CARD_PRESENT_PAYMENT', transactionChannel: 'VISA_CARD_PRESENT', currencyAmount: AUD(-8.4), rollingAccountBalance: 2.73, relatedHoldHayId: hold.id,
      cardId: hold.cardId, transactionTimeUtc: hold.authorisedAt, counterpartName: 'IGA (Mt Cotton)', counterpartDetails: { name: 'IGA (Mt Cotton)', merchantDetails: card().merchant }, category: '5411',
    })
    const ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev.transactionEvent).toMatchObject({
      transactionHayId: t.id, holdHayId: hold.id, currencyAmount: AUD(-8.4), updatedBalance: AUD(2.73), isPending: false, outcome: 'ACCEPTED', transactionType: 'CARD_TRANSACTION_SETTLED',
      transactionTimeUtc: hold.authorisedAt, cardHayId: hold.cardId, counterpartName: 'IGA (Mt Cotton)', merchantId: '000009493578577',
      accountBalances: { totalBalance: AUD(2.73), heldBalance: AUD(0), availableBalance: AUD(2.73) },
    })
    expect(ev.transactionEvent).not.toHaveProperty('counterpartDetails')
    assertValidNotification(ev)
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${a.accountHayId}/holds` })).json()).toEqual([])
    expect((await app.inject({ method: 'GET', url: `/v1/holds/${hold.id}` })).statusCode).toBe(200)
    expect(() => svc.holds.settle(hold.id)).toThrow(/INVALID_STATE: Hold .* is SETTLED/)
    expect(() => svc.holds.increase(hold.id, 100)).toThrow(/INVALID_STATE/)
    expect(() => svc.holds.reverse(hold.id)).toThrow(/INVALID_STATE/)
    expect(() => svc.holds.get(UNKNOWN_ID)).toThrow(/NOT_FOUND: Hold/)
    // settlement of a smaller amount releases the whole hold
    const b = await fundedAccount(20)
    const h2 = svc.holds.authorise(holdInput(b.accountHayId!, 1000)).hold!
    svc.holds.settle(h2.id, 700)
    expect(await getAccount(b.accountHayId!)).toMatchObject({ totalBalance: 13, heldBalance: 0, availableBalance: 13 })
  })

  it('settle: a settlement of 0 is a 400; a settlement larger than the hold funds-checks the excess (REFUSED_NOT_ENOUGH_FUNDS, hold left open, refused CARD_TRANSACTION_SETTLED webhook) and clears once the excess fits', async () => {
    const holder = await newCustomer()
    const a = await fundedAccount(10, holder)
    const hold = svc.holds.authorise(holdInput(a.accountHayId!, 1000)).hold!
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 10, heldBalance: 10, availableBalance: 0 })
    expect(() => svc.holds.settle(hold.id, 0)).toThrow(/^BAD_REQUEST: settlement amount must be greater than 0/)
    expect(() => svc.holds.settle(hold.id, -1)).toThrow(/^BAD_REQUEST/)

    const refused = svc.holds.settle(hold.id, 2500)
    expect(refused).toMatchObject({ outcome: 'REFUSED_NOT_ENOUGH_FUNDS', hold: { id: hold.id, state: 'AUTHORISED', amount: 1000 } })
    expect(refused.transaction).toBeUndefined()
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 10, heldBalance: 10, availableBalance: 0, status: 'ACTIVE' })
    expect(svc.listForAccount(a.accountHayId!)).toHaveLength(1)
    const ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev).toMatchObject({ customerHayId: holder, actionOwner: 'PLATFORM', transactionEvent: { transactionHayId: hold.id, holdHayId: hold.id, transactionType: 'CARD_TRANSACTION_SETTLED', outcome: 'REFUSED_NOT_ENOUGH_FUNDS', currencyAmount: AUD(-25), updatedBalance: AUD(0), isPending: false, cardHayId: hold.cardId, counterpartName: 'IGA (Mt Cotton)', accountBalances: { totalBalance: AUD(10), heldBalance: AUD(10), availableBalance: AUD(0) } } })
    assertValidNotification(ev)

    expect((await credit(a.accountHayId!, 20)).outcome).toBe('ACCEPTED')
    const settled = svc.holds.settle(hold.id, 2500)
    expect(settled).toMatchObject({ outcome: 'ACCEPTED', hold: { state: 'SETTLED' }, transaction: { amount: -2500, relatedHoldId: hold.id } })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 5, heldBalance: 0, availableBalance: 5 })
    const settledEv = (await txEvents(a.accountHayId!)).at(-1)
    expect(settledEv.transactionEvent).toMatchObject({ transactionHayId: settled.transaction!.id, holdHayId: hold.id, transactionType: 'CARD_TRANSACTION_SETTLED', outcome: 'ACCEPTED', currencyAmount: AUD(-25), updatedBalance: AUD(5) })
    assertValidNotification(settledEv)
  })

  it('increase refused for funds: the hold keeps its amount, the webhook carries the hold id and the refused increment; the account status gate precedes a caller refusal', async () => {
    const holder = await newCustomer()
    const a = await fundedAccount(10, holder)
    const hold = svc.holds.authorise(holdInput(a.accountHayId!, 800)).hold!
    expect(svc.holds.increase(hold.id, 201)).toMatchObject({ outcome: 'REFUSED_NOT_ENOUGH_FUNDS', hold: { id: hold.id, amount: 800, state: 'AUTHORISED' } })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 10, heldBalance: 8, availableBalance: 2 })
    expect(svc.holds.get(hold.id).amount).toBe(800)
    const ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev).toMatchObject({ customerHayId: holder, transactionEvent: { transactionHayId: hold.id, holdHayId: hold.id, transactionType: 'CARD_TRANSACTION', outcome: 'REFUSED_NOT_ENOUGH_FUNDS', currencyAmount: AUD(-2.01), updatedBalance: AUD(2), isPending: false, cardHayId: hold.cardId, accountBalances: { heldBalance: AUD(8), availableBalance: AUD(2) } } })
    assertValidNotification(ev)
    expect(svc.holds.increase(hold.id, 200).outcome).toBe('ACCEPTED')
    expect(await getAccount(a.accountHayId!)).toMatchObject({ heldBalance: 10, availableBalance: 0 })

    await post(`/v0/accounts/${a.accountHayId}/block`, { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' })
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 1, { refusal: { outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome: 'CONTACTLESS_DISABLED' } }))).toEqual({ outcome: 'REFUSED_ACCOUNT_BLOCKED' })
    const blockedEv = (await txEvents(a.accountHayId!)).at(-1)
    expect(blockedEv.transactionEvent).toMatchObject({ outcome: 'REFUSED_ACCOUNT_BLOCKED', transactionType: 'CARD_TRANSACTION' })
    expect(blockedEv.transactionEvent).not.toHaveProperty('cardPreferenceOutcome')
    assertValidNotification(blockedEv)
  })

  it('authorise on a CLOSED account: REFUSED_ACCOUNT_CLOSED, nothing held, webhook CARD_TRANSACTION with the refused outcome', async () => {
    const holder = await newCustomer()
    const a = await newAccount({ holder })
    expect((await post(`/v0/accounts/${a.accountHayId}/close`, { reason: 'CUSTOMER' })).statusCode).toBe(202)
    await flush()
    expect((await getAccount(a.accountHayId!)).status).toBe('CLOSED')
    const c = card()
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 100, { card: c }))).toEqual({ outcome: 'REFUSED_ACCOUNT_CLOSED' })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ status: 'CLOSED', totalBalance: 0, heldBalance: 0, availableBalance: 0 })
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${a.accountHayId}/holds` })).json()).toEqual([])
    const ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev).toMatchObject({ customerHayId: holder, actionOwner: 'PLATFORM', transactionEvent: { accountHayId: a.accountHayId, transactionType: 'CARD_TRANSACTION', outcome: 'REFUSED_ACCOUNT_CLOSED', currencyAmount: AUD(-1), updatedBalance: AUD(0), isPending: false, isAtmTransaction: false, cardHayId: c.cardHayId, counterpartName: 'IGA (Mt Cotton)' } })
    expect(ev.transactionEvent).not.toHaveProperty('holdHayId')
    assertValidNotification(ev)
  })

  it('daily card usage windows each authorised portion from its own time: an increment made late in the day still counts after the original authorisation has aged out; a decrease releases the newest portion first', async () => {
    const a = await fundedAccount(1000)
    await app.inject({ method: 'PUT', url: `/v1/accounts/${a.accountHayId}/limits/CARD_PAYMENTS_DAILY`, payload: { limitAmount: 50 } })
    const hold = svc.holds.authorise(holdInput(a.accountHayId!, 3000)).hold!
    expect(hold.portions).toEqual([{ amount: 3000, at: hold.authorisedAt }])
    await advanceClock(23 * 60 * 60 * 1000)
    const increased = svc.holds.increase(hold.id, 2000).hold!
    expect(increased.portions).toEqual([{ amount: 3000, at: hold.authorisedAt }, { amount: 2000, at: expect.stringMatching(ISO_MICROS) }])
    expect(increased.portions[1]!.at > hold.authorisedAt).toBe(true)
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 1))).toEqual({ outcome: 'REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED' })
    await advanceClock(2 * 60 * 60 * 1000) // the 30.00 is now 25 h old, the 20.00 increment 2 h old
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 3001))).toEqual({ outcome: 'REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED' })
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 3000)).outcome).toBe('ACCEPTED')
    // a decrease releases the newest portion first
    const decreased = svc.holds.decrease(hold.id, 2500).hold!
    expect(decreased).toMatchObject({ amount: 2500, portions: [{ amount: 2500, at: hold.authorisedAt }] })
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 2000)).outcome).toBe('ACCEPTED') // usage: 30.00 (fresh) + 20.00
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 1))).toEqual({ outcome: 'REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED' })
  })

  it('increase keeps the hold id and reports the cumulative amount; decrease releases the delta as CARD_TRANSACTION_REFUND pending; a full decrease is a reversal', async () => {
    const a = await fundedAccount(232.64)
    const hold = svc.holds.authorise(holdInput(a.accountHayId!, 900)).hold!
    expect(svc.holds.increase(hold.id, 1000).hold).toMatchObject({ amount: 1900, state: 'AUTHORISED' })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 232.64, heldBalance: 19, availableBalance: 213.64 })
    let ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev.transactionEvent).toMatchObject({ transactionHayId: hold.id, holdHayId: hold.id, currencyAmount: AUD(-19), isPending: true, transactionType: 'CARD_TRANSACTION', updatedBalance: AUD(213.64), accountBalances: { heldBalance: AUD(19) } })
    assertValidNotification(ev)

    expect(svc.holds.decrease(hold.id, 50).hold).toMatchObject({ amount: 1850 })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ heldBalance: 18.5, availableBalance: 214.14 })
    ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev.transactionEvent).toMatchObject({ transactionHayId: hold.id, holdHayId: hold.id, currencyAmount: AUD(0.5), isPending: true, transactionType: 'CARD_TRANSACTION_REFUND', updatedBalance: AUD(214.14) })
    assertValidNotification(ev)
    expect((await app.inject({ method: 'GET', url: `/v1/holds/${hold.id}` })).json().currencyAmount).toEqual(AUD(-18.5))
    expect(() => svc.holds.decrease(hold.id, 1851)).toThrow(/INVALID_AMOUNT/)

    expect(svc.holds.decrease(hold.id, 1850).hold).toMatchObject({ amount: 1850, state: 'REVERSED' })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 232.64, heldBalance: 0, availableBalance: 232.64 })
    ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev.transactionEvent).toMatchObject({ transactionHayId: hold.id, currencyAmount: AUD(18.5), isPending: true, transactionType: 'CARD_TRANSACTION_REFUND', updatedBalance: AUD(232.64) })
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${a.accountHayId}/holds` })).json()).toEqual([])
    expect(svc.listForAccount(a.accountHayId!)).toHaveLength(1) // only the funding credit was posted

    const b = await fundedAccount(10)
    const h = svc.holds.authorise(holdInput(b.accountHayId!, 400)).hold!
    expect(svc.holds.reverse(h.id).hold!.state).toBe('REVERSED')
    expect(await getAccount(b.accountHayId!)).toMatchObject({ heldBalance: 0, availableBalance: 10 })
    const h2 = svc.holds.authorise(holdInput(b.accountHayId!, 400)).hold!
    expect(svc.holds.cancel(h2.id).hold!.state).toBe('CANCELLED')
    expect((await txEvents(b.accountHayId!)).at(-1).transactionEvent).toMatchObject({ transactionType: 'CARD_TRANSACTION_REFUND', currencyAmount: AUD(4), isPending: true })
  })

  it('refused authorisations hold nothing and emit CARD_TRANSACTION with the refused outcome: funds, single / daily card limits (open holds count), rules, caller refusals, account status', async () => {
    const holder = await newCustomer()
    const a = await fundedAccount(100, holder)
    const c = card()
    const refused = svc.holds.authorise(holdInput(a.accountHayId!, 10_001, { card: c }))
    expect(refused).toEqual({ outcome: 'REFUSED_NOT_ENOUGH_FUNDS' })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ heldBalance: 0, availableBalance: 100 })
    let ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev).toMatchObject({ customerHayId: holder, actionOwner: 'PLATFORM', transactionEvent: { accountHayId: a.accountHayId, currencyAmount: AUD(-100.01), updatedBalance: AUD(100), isPending: false, outcome: 'REFUSED_NOT_ENOUGH_FUNDS', transactionType: 'CARD_TRANSACTION', cardHayId: c.cardHayId, counterpartName: 'IGA (Mt Cotton)', merchantId: '000009493578577', isAtmTransaction: false } })
    expect(ev.transactionEvent.transactionHayId).toMatch(UUID_RE)
    expect(ev.transactionEvent).not.toHaveProperty('holdHayId')
    assertValidNotification(ev)

    await app.inject({ method: 'PUT', url: `/v1/accounts/${a.accountHayId}/limits/SINGLE_CARD_TRANSACTION`, payload: { limitAmount: 30 } })
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 3001))).toEqual({ outcome: 'REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED' })
    expect((await txEvents(a.accountHayId!)).at(-1).transactionEvent.outcome).toBe('REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED')
    await app.inject({ method: 'PUT', url: `/v1/accounts/${a.accountHayId}/limits/CARD_PAYMENTS_DAILY`, payload: { limitAmount: 50 } })
    const first = svc.holds.authorise(holdInput(a.accountHayId!, 3000)).hold!
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 2001))).toEqual({ outcome: 'REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED' })
    expect(svc.holds.increase(first.id, 2001)).toMatchObject({ outcome: 'REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED' })
    ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev.transactionEvent).toMatchObject({ transactionHayId: first.id, holdHayId: first.id, outcome: 'REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED', currencyAmount: AUD(-20.01), isPending: false })
    assertValidNotification(ev)
    expect(svc.holds.increase(first.id, 2000).outcome).toBe('ACCEPTED')
    svc.holds.settle(first.id)
    // the settled spend still counts for the day
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 1))).toEqual({ outcome: 'REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED' })
    await advanceClock(DAY_MS + 1000)
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 1)).outcome).toBe('ACCEPTED')

    const rule = await post(`/v1/accounts/${a.accountHayId}/rules`, { name: 'no IGA', ruleType: 'MERCHANT_NAME_BLOCK', ruleDetails: { blockedMerchantName: 'IGA', merchantNameMatchingOperator: 'STARTS_WITH' } })
    expect(rule.statusCode, rule.body).toBe(200)
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 100))).toEqual({ outcome: 'REFUSED_RULES' })
    ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev.transactionEvent).toMatchObject({ outcome: 'REFUSED_RULES', ruleDetails: { ruleId: rule.json().id } })
    assertValidNotification(ev)
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 100, { card: card({ merchant: { name: 'Coles', merchantId: '1' } }) })).outcome).toBe('ACCEPTED')

    expect(svc.holds.authorise(holdInput(a.accountHayId!, 100, { refusal: { outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome: 'CONTACTLESS_DISABLED' } }))).toEqual({ outcome: 'REFUSED_CARD_PREFERENCE' })
    ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev.transactionEvent).toMatchObject({ outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome: 'CONTACTLESS_DISABLED' })
    assertValidNotification(ev)
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 100, { refusal: { outcome: 'INTERNAL_ERROR', cardProcessorResponse: 'EXPIRED_CARD' } }))).toEqual({ outcome: 'INTERNAL_ERROR' })
    expect((await txEvents(a.accountHayId!)).at(-1).transactionEvent).toMatchObject({ outcome: 'INTERNAL_ERROR', cardProcessorResponse: 'EXPIRED_CARD' })

    const open = svc.holds.authorise(holdInput(a.accountHayId!, 100, { card: card({ merchant: { name: 'Coles' } }) })).hold!
    await post(`/v0/accounts/${a.accountHayId}/block`, { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' })
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 100, { card: card({ merchant: { name: 'Coles' } }) }))).toEqual({ outcome: 'REFUSED_ACCOUNT_BLOCKED' })
    expect(svc.holds.increase(open.id, 100)).toMatchObject({ outcome: 'REFUSED_ACCOUNT_BLOCKED', hold: { amount: 100 } })
    ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev.transactionEvent).toMatchObject({ transactionHayId: open.id, holdHayId: open.id, outcome: 'REFUSED_ACCOUNT_BLOCKED', currencyAmount: AUD(-1), isPending: false })
    assertValidNotification(ev)
    // a settlement of an already authorised hold still clears on a blocked account (funds were reserved)
    const beforeSettle = await getAccount(a.accountHayId!)
    expect(svc.holds.settle(open.id).transaction).toMatchObject({ amount: -100, relatedHoldId: open.id })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ status: 'LOCKED', heldBalance: Math.round((beforeSettle.heldBalance! - 1) * 100) / 100, totalBalance: Math.round((beforeSettle.totalBalance! - 1) * 100) / 100, availableBalance: beforeSettle.availableBalance })
    expect(() => svc.holds.authorise(holdInput(UNKNOWN_ID, 100))).toThrow(/NOT_FOUND: Account/)
    expect(() => svc.holds.authorise(holdInput(a.accountHayId!, 0))).toThrow(/BAD_REQUEST/)
  })

  it('derives type / channel from the card usage (ATM, contactless, wallet, international) and checks the ATM daily limit', async () => {
    const a = await fundedAccount(10_000)
    const atm = svc.holds.authorise(holdInput(a.accountHayId!, 100, { card: card({ cardUsage: { isAtmWithdrawal: true, isCardPresent: true } }) })).hold!
    expect(atm).toMatchObject({ type: 'ATM_WITHDRAWAL', channel: 'VISA_ATM', limitKinds: ['SINGLE_CARD_TRANSACTION', 'ATM_WITHDRAWAL_PER_DAY', 'CARD_PAYMENTS_DAILY'] })
    expect((await txEvents(a.accountHayId!)).at(-1).transactionEvent.isAtmTransaction).toBe(true)
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 500_000, { card: card({ cardUsage: { isAtmWithdrawal: true } }) }))).toEqual({ outcome: 'REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED' })
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 100, { card: card({ cardUsage: { isContactless: true, isCardPresent: true } }) })).hold).toMatchObject({ type: 'CARD_PRESENT_PAYMENT', channel: 'VISA_CONTACTLESS' })
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 100, { card: card({ cardUsage: { isMobileWalletPayment: true, isCardPresent: false } }) })).hold).toMatchObject({ type: 'CARD_NOT_PRESENT_PAYMENT', channel: 'APPLE_PAY_CARD_NOT_PRESENT' })
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 100, { card: card({ cardUsage: undefined }) })).hold).toMatchObject({ type: 'CARD_NOT_PRESENT_PAYMENT', channel: 'VISA_CARD_NOT_PRESENT' })
    const fx = svc.holds.authorise(holdInput(a.accountHayId!, 150, { originalAmount: { amountCents: 100, currency: 'USD' }, countryOfExpenditure: 'UNITED_STATES_OF_AMERICA' })).hold!
    expect(fx).toMatchObject({ channel: 'VISA_CARD_PRESENT_INTERNATIONAL', originalAmount: 100, originalCurrency: 'USD' })
    expect((await app.inject({ method: 'GET', url: `/v1/holds/${fx.id}` })).json()).toMatchObject({ currencyAmount: AUD(-1.5), originalCurrencyAmount: { currency: 'USD', amount: -1 } })
    const settled = svc.holds.settle(fx.id).transaction!
    expect(await getTransaction(settled.id)).toMatchObject({ transactionChannel: 'VISA_CARD_PRESENT_INTERNATIONAL', originalCurrencyAmount: { currency: 'USD', amount: -1 }, countryOfExpenditure: 'UNITED_STATES_OF_AMERICA' })
    const ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev.transactionEvent).toMatchObject({ originalCurrencyAmount: { currency: 'USD', amount: -1 } })
    assertValidNotification(ev)
  })

  it('a refused FX authorisation carries originalCurrencyAmount negative like currencyAmount', async () => {
    const a = await fundedAccount(100)
    const usd = { originalAmount: { amountCents: 100, currency: 'USD' } }
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 150, { ...usd, refusal: { outcome: 'REFUSED_RULES', cardPreferenceOutcome: 'OK', cardProcessorResponse: 'RESTRICTED_CARD' } })).outcome).toBe('REFUSED_RULES')
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 50_000, usd)).outcome).toBe('REFUSED_NOT_ENOUGH_FUNDS')
    const events = (await txEvents(a.accountHayId!)).slice(-2).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.outcome, e.currencyAmount.amount, e.originalCurrencyAmount])).toEqual([
      ['REFUSED_RULES', -1.5, { currency: 'USD', amount: -1 }], ['REFUSED_NOT_ENOUGH_FUNDS', -500, { currency: 'USD', amount: -1 }],
    ])
  })

  it('an FX hold keeps its original-currency amount in step with increases and decreases (at the authorisation rate)', async () => {
    const a = await fundedAccount(10_000)
    const fx = svc.holds.authorise(holdInput(a.accountHayId!, 150, { originalAmount: { amountCents: 100, currency: 'USD' } })).hold!
    expect(svc.holds.increase(fx.id, 15).hold).toMatchObject({ amount: 165, originalAmount: 110 })
    expect((await txEvents(a.accountHayId!)).at(-1).transactionEvent).toMatchObject({ currencyAmount: AUD(-1.65), originalCurrencyAmount: { currency: 'USD', amount: -1.1 } })
    expect(svc.holds.decrease(fx.id, 30).hold).toMatchObject({ amount: 135, originalAmount: 90 })
    expect((await app.inject({ method: 'GET', url: `/v1/holds/${fx.id}` })).json()).toMatchObject({ currencyAmount: AUD(-1.35), originalCurrencyAmount: { currency: 'USD', amount: -0.9 } })
    const settled = svc.holds.settle(fx.id).transaction!
    expect(await getTransaction(settled.id)).toMatchObject({ currencyAmount: AUD(-1.35), originalCurrencyAmount: { currency: 'USD', amount: -0.9 } })
  })
})

describe('services.transactions.post (the engine other domains call)', () => {
  it('posts any ledger type with the default limit set and webhook type; refusals post nothing and notify only when asked', async () => {
    const holder = await newCustomer()
    const a = await newAccount({ holder })
    const r = svc.post({ accountId: a.accountHayId!, amountCents: 20_000, type: 'INTERBANK_TRANSFER_IN', channel: 'CUSCAL_NPP_TRANSFER_IN', counterpart: { name: 'Andy', basicAccountNumber: { accountNumber: '12345678', branchNumber: '062000' } }, description: 'withdrawal', category: 'BANK_TRANSFER', reference: 'NPP-1', externalIdentifiers: [{ source: 'npp', type: 'trace-lifecycle', value: '123456789012' }] })
    expect(r.outcome).toBe('ACCEPTED')
    expect(r.transaction).toMatchObject({ limitKinds: ['MAX_BALANCE', 'BANK_TRANSFER_TOP_UP_PER_DAY'], webhookType: 'INTERBANK_TRANSFER_IN', customerId: holder })
    expect(await getTransaction(r.transaction!.id)).toMatchObject({ type: 'INTERBANK_TRANSFER_IN', externalIdentifiers: [{ source: 'npp', type: 'trace-lifecycle', value: '123456789012' }], counterpartDetails: { name: 'Andy', basicAccountNumber: { accountNumber: '12345678', branchNumber: '062000' } } })
    const ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev).toMatchObject({ actionOwner: 'PLATFORM', transactionEvent: { transactionType: 'INTERBANK_TRANSFER_IN', currencyAmount: AUD(200), counterpartName: 'Andy', category: 'BANK_TRANSFER', description: 'withdrawal', reference: 'NPP-1', externalIdentifiers: [{ source: 'npp', identifierType: 'trace-lifecycle', value: '123456789012' }] } })
    assertValidNotification(ev)

    const bpay = svc.post({ accountId: a.accountHayId!, amountCents: -2000, type: 'BPAY_TRANSFER_OUT', channel: 'CUSCAL_BPAY_TRANSFER_OUT', counterpart: { name: 'Energy Co', bpayDetails: { billerCode: '123456', billerReference: '987654321', billerName: 'Energy Co' } }, actionOwner: 'CLIENT' })
    expect(bpay.transaction).toMatchObject({ limitKinds: ['BPAY_DAILY_LIMIT', 'TOTAL_SPEND_PER_YEAR'], webhookType: 'BPAY_TRANSFER_OUT' })
    const bpayEv = (await txEvents(a.accountHayId!)).at(-1)
    expect(bpayEv).toMatchObject({ actionOwner: 'CLIENT', transactionEvent: { transactionType: 'BPAY_TRANSFER_OUT', currencyAmount: AUD(-20), counterpartDetails: { name: 'Energy Co', bpayDetails: { billerCode: '123456', billerReference: '987654321', billerName: 'Energy Co' } } } })
    expect((await getTransaction(bpay.transaction!.id)).counterpartDetails).toEqual({ name: 'Energy Co' })
    assertValidNotification(bpayEv)

    const before = (await txEvents(a.accountHayId!)).length
    expect(svc.post({ accountId: a.accountHayId!, amountCents: -100_000, type: 'DIRECT_DEBIT_TRANSFER', channel: 'CUSCAL_DE_DEBIT_IN' })).toEqual({ outcome: 'REFUSED_NOT_ENOUGH_FUNDS' })
    expect((await txEvents(a.accountHayId!)).length).toBe(before)
    expect(svc.post({ accountId: a.accountHayId!, amountCents: -100_000, type: 'DIRECT_DEBIT_TRANSFER', channel: 'CUSCAL_DE_DEBIT_IN', counterpart: { name: 'Gym' }, notifyRefusal: true })).toEqual({ outcome: 'REFUSED_NOT_ENOUGH_FUNDS' })
    const refusedEv = (await txEvents(a.accountHayId!)).at(-1)
    expect(refusedEv.transactionEvent).toMatchObject({ transactionType: 'DIRECT_DEBIT_TRANSFER', outcome: 'REFUSED_NOT_ENOUGH_FUNDS', currencyAmount: AUD(-1000), isPending: false, counterpartName: 'Gym', updatedBalance: AUD(180) })
    assertValidNotification(refusedEv)
    expect(svc.post({ accountId: a.accountHayId!, amountCents: -100, type: 'DIRECT_DEBIT_TRANSFER', channel: 'CUSCAL_DE_DEBIT_IN', limits: ['DIRECT_DEBIT_PER_DAY'] }).transaction).toMatchObject({ limitKinds: ['DIRECT_DEBIT_PER_DAY'] })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 179, availableBalance: 179 })
    expect(() => svc.post({ accountId: UNKNOWN_ID, amountCents: 1, type: 'GENERAL_CREDIT', channel: 'MANUAL_ADJUSTMENT' })).toThrow(/NOT_FOUND: Account/)
    expect(() => svc.post({ accountId: a.accountHayId!, amountCents: 1, type: 'GENERAL_CREDIT', channel: 'MANUAL_ADJUSTMENT', transactionTimeUtc: 'yesterday' })).toThrow(/^BAD_REQUEST: transactionTimeUtc must be a valid date-time/)
  })

  it('a refusal by a limit with no webhook value (PAYMENT_TO_ACCOUNT_NUMBER, every limit on a HIGH-risk account) answers REFUSED_LIMIT_BREACH and emits no webhook even with notifyRefusal', async () => {
    const a = await fundedAccount(100)
    await app.inject({ method: 'PUT', url: `/v1/accounts/${a.accountHayId}/limits/PAYMENT_TO_ACCOUNT_NUMBER`, payload: { limitAmount: 10 } })
    const before = (await txEvents(a.accountHayId!)).length
    const out = (cents: number) => svc.post({ accountId: a.accountHayId!, amountCents: -cents, type: 'INTERBANK_TRANSFER_OUT', channel: 'CUSCAL_NPP_TRANSFER_OUT', counterpart: { name: 'Andy', basicAccountNumber: { accountNumber: '12345678', branchNumber: '062000' } }, notifyRefusal: true, actionOwner: 'CLIENT' })
    expect(out(2000)).toEqual({ outcome: 'REFUSED_LIMIT_BREACH' })
    expect(svc.holds.authorise(holdInput(a.accountHayId!, 2000, { limits: ['PAYMENT_TO_ACCOUNT_NUMBER'] }))).toEqual({ outcome: 'REFUSED_LIMIT_BREACH' })
    expect((await txEvents(a.accountHayId!)).length).toBe(before)
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 100, availableBalance: 100, heldBalance: 0 })
    expect(svc.listForAccount(a.accountHayId!)).toHaveLength(1)
    // a limit with a webhook value still notifies
    expect(out(1000).outcome).toBe('ACCEPTED')
    await app.inject({ method: 'PUT', url: `/v1/accounts/${a.accountHayId}/limits/TOTAL_SPEND_PER_YEAR`, payload: { limitAmount: 10 } })
    expect(out(1)).toEqual({ outcome: 'REFUSED_ANNUAL_SPENDING_LIMIT_BREACHED' })
    const ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev).toMatchObject({ actionOwner: 'CLIENT', transactionEvent: { transactionType: 'INTERBANK_TRANSFER_OUT', outcome: 'REFUSED_ANNUAL_SPENDING_LIMIT_BREACHED', currencyAmount: AUD(-0.01), updatedBalance: AUD(90), isPending: false, counterpartName: 'Andy' } })
    assertValidNotification(ev)

    const high = await newAccount({ risk: 'HIGH' })
    expect(svc.post({ accountId: high.accountHayId!, amountCents: -100, type: 'INTERBANK_TRANSFER_OUT', channel: 'CUSCAL_NPP_TRANSFER_OUT', notifyRefusal: true })).toEqual({ outcome: 'REFUSED_LIMIT_BREACH' })
    expect(svc.post({ accountId: high.accountHayId!, amountCents: -100, type: 'INTRABANK_TRANSFER_OUT', channel: 'HAAS_TRANSFER_INTERNAL_OUT', notifyRefusal: true })).toEqual({ outcome: 'REFUSED_LIMIT_BREACH' })
    expect(await txEvents(high.accountHayId!)).toEqual([])
  })

  it('ATM stand-in and card refund postings: CARD_TRANSACTION isPending false / isAtmTransaction true, and CARD_TRANSACTION_REFUND isPending false with a positive amount', async () => {
    const holder = await newCustomer()
    const a = await fundedAccount(100, holder)
    const cardHayId = randomUUID()
    const atm = svc.post({ accountId: a.accountHayId!, amountCents: -2000, type: 'ATM_WITHDRAWAL', channel: 'VISA_ATM', cardId: cardHayId, cardUsage: { isAtmWithdrawal: true, isCardPresent: true }, counterpart: { name: 'ATM George St', merchantDetails: { name: 'ATM George St', merchantId: '000000000000001', merchantCategoryCode: 6011 } }, description: 'Cash withdrawal' })
    expect(atm.outcome).toBe('ACCEPTED')
    expect(atm.transaction).toMatchObject({ webhookType: 'CARD_TRANSACTION', limitKinds: ['SINGLE_CARD_TRANSACTION', 'ATM_WITHDRAWAL_PER_DAY', 'CARD_PAYMENTS_DAILY'], customerId: holder })
    expect(await getTransaction(atm.transaction!.id)).toMatchObject({ type: 'ATM_WITHDRAWAL', transactionChannel: 'VISA_ATM', currencyAmount: AUD(-20), rollingAccountBalance: 80, cardId: cardHayId, counterpartName: 'ATM George St', counterpartDetails: { name: 'ATM George St', merchantDetails: { merchantId: '000000000000001' } } })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 80, availableBalance: 80, heldBalance: 0 })
    let ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev).toMatchObject({ customerHayId: holder, actionOwner: 'PLATFORM', transactionEvent: { transactionHayId: atm.transaction!.id, transactionType: 'CARD_TRANSACTION', isPending: false, isAtmTransaction: true, outcome: 'ACCEPTED', currencyAmount: AUD(-20), updatedBalance: AUD(80), cardHayId, counterpartName: 'ATM George St', merchantId: '000000000000001', cardUsageDetails: { isAtmWithdrawal: true, isCardPresent: true }, description: 'Cash withdrawal' } })
    expect(ev.transactionEvent).not.toHaveProperty('holdHayId')
    expect(ev.transactionEvent).not.toHaveProperty('counterpartDetails')
    assertValidNotification(ev)

    const refund = svc.post({ accountId: a.accountHayId!, amountCents: 599, type: 'CARD_PAYMENT_REVERSAL', channel: 'VISA_CARD_PRESENT', cardId: cardHayId, cardUsage: { isCardPresent: true }, counterpart: { name: 'IGA (Mt Cotton)', merchantDetails: card().merchant }, description: 'Refund' })
    expect(refund.outcome).toBe('ACCEPTED')
    expect(refund.transaction).toMatchObject({ webhookType: 'CARD_TRANSACTION_REFUND', limitKinds: ['MAX_BALANCE'] })
    expect(await getTransaction(refund.transaction!.id)).toMatchObject({ type: 'CARD_PAYMENT_REVERSAL', currencyAmount: AUD(5.99), rollingAccountBalance: 85.99 })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 85.99, availableBalance: 85.99 })
    ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev.transactionEvent).toMatchObject({ transactionHayId: refund.transaction!.id, transactionType: 'CARD_TRANSACTION_REFUND', isPending: false, isAtmTransaction: false, outcome: 'ACCEPTED', currencyAmount: AUD(5.99), updatedBalance: AUD(85.99), cardHayId, counterpartName: 'IGA (Mt Cotton)', merchantId: '000009493578577' })
    expect(ev.transactionEvent).not.toHaveProperty('holdHayId')
    assertValidNotification(ev)
  })

  it('BANK_TRANSFER_TOP_UP_PER_DAY is a rolling 24 h cap on INTERBANK_TRANSFER_IN: REFUSED_DAILY_TOP_UP_LIMIT_BREACHED (REFUSED_LIMIT_BREACH on REST), open again a day later', async () => {
    const holder = await newCustomer()
    const a = await newAccount({ holder })
    expect((await app.inject({ method: 'PUT', url: `/v1/accounts/${a.accountHayId}/limits/BANK_TRANSFER_TOP_UP_PER_DAY`, payload: { limitAmount: 100 } })).statusCode).toBe(200)
    const topUp = (cents: number, notifyRefusal = false) => svc.post({ accountId: a.accountHayId!, amountCents: cents, type: 'INTERBANK_TRANSFER_IN', channel: 'CUSCAL_NPP_TRANSFER_IN', counterpart: { name: 'Andy', basicAccountNumber: { accountNumber: '12345678', branchNumber: '062000' } }, notifyRefusal })
    expect(topUp(10_000).outcome).toBe('ACCEPTED')
    expect(topUp(1)).toEqual({ outcome: 'REFUSED_DAILY_TOP_UP_LIMIT_BREACHED' })
    expect(toRestOutcome('REFUSED_DAILY_TOP_UP_LIMIT_BREACHED')).toBe('REFUSED_LIMIT_BREACH')
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 100, availableBalance: 100, status: 'ACTIVE' })
    expect(await txEvents(a.accountHayId!)).toHaveLength(1)
    expect(topUp(1, true)).toEqual({ outcome: 'REFUSED_DAILY_TOP_UP_LIMIT_BREACHED' })
    const ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev).toMatchObject({ customerHayId: holder, actionOwner: 'PLATFORM', transactionEvent: { transactionType: 'INTERBANK_TRANSFER_IN', outcome: 'REFUSED_DAILY_TOP_UP_LIMIT_BREACHED', currencyAmount: AUD(0.01), updatedBalance: AUD(100), isPending: false, counterpartName: 'Andy', counterpartDetails: { name: 'Andy', basicAccountNumber: { accountNumber: '12345678', branchNumber: '062000' } } } })
    assertValidNotification(ev)
    expect(svc.listForAccount(a.accountHayId!)).toHaveLength(1)
    await advanceClock(DAY_MS + 1000)
    expect(topUp(1).outcome).toBe('ACCEPTED')
    expect((await getAccount(a.accountHayId!)).totalBalance).toBe(100.01)
  })
})

describe('createCreditTransactionV0 (POST /v0/transactions/credit/create) and refused-outcome replay', () => {
  it('v0 credit ACCEPTED: posts a GENERAL_CREDIT exactly like v1 (transactionId, balances, webhook GENERAL_CREDIT)', async () => {
    const holder = await newCustomer()
    const a = await newAccount({ holder })
    const res = await post('/v0/transactions/credit/create', creditBody(a.accountHayId!, 42.5, { reference: 'V0' }))
    expect(res.statusCode, res.body).toBe(200)
    const r = res.json() as { outcome: string; transactionId: string }
    expect(r).toEqual({ outcome: 'ACCEPTED', transactionId: expect.stringMatching(UUID_RE) })
    expect(await getTransaction(r.transactionId)).toMatchObject({ type: 'GENERAL_CREDIT', transactionChannel: 'MANUAL_ADJUSTMENT', currencyAmount: AUD(42.5), rollingAccountBalance: 42.5, reference: 'V0', counterpartName: 'Payroll Pty Ltd', customerId: holder })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ status: 'ACTIVE', totalBalance: 42.5, availableBalance: 42.5 })
    const ev = (await txEvents(a.accountHayId!)).at(-1)
    expect(ev).toMatchObject({ customerHayId: holder, actionOwner: 'CLIENT', transactionEvent: { transactionHayId: r.transactionId, transactionType: 'GENERAL_CREDIT', outcome: 'ACCEPTED', currencyAmount: AUD(42.5), updatedBalance: AUD(42.5), isPending: false, reference: 'V0' } })
    assertValidNotification(ev)
  })

  it('a refused TransactionOutcome replays under its idempotencyKey without re-evaluating (still refused after funds arrive, nothing posted); a different body is 422', async () => {
    const a = await fundedAccount(10)
    const body = creditBody(a.accountHayId!, 20, { counterpartName: 'Fee collector', transactionChannel: 'SERVICE_FEE' })
    const first = await post('/v1/transactions/debit', body)
    expect(first.json()).toEqual({ outcome: 'REFUSED_INSUFFICIENT_FUNDS' })
    expect((await post('/v1/transactions/debit', body)).json()).toEqual({ outcome: 'REFUSED_INSUFFICIENT_FUNDS' })
    expect((await credit(a.accountHayId!, 100)).outcome).toBe('ACCEPTED')
    expect((await post('/v1/transactions/debit', body)).json()).toEqual({ outcome: 'REFUSED_INSUFFICIENT_FUNDS' })
    expect(await getAccount(a.accountHayId!)).toMatchObject({ totalBalance: 110, availableBalance: 110 })
    expect(svc.listForAccount(a.accountHayId!)).toHaveLength(2)
    expectError(await post('/v1/transactions/debit', { ...body, amount: 5 }), 422, /^IDEMPOTENCY_KEY_REUSED/)
    expect((await txEvents(a.accountHayId!)).map((e) => e.transactionEvent.transactionType)).toEqual(['GENERAL_CREDIT', 'GENERAL_CREDIT'])
  })
})

describe('searchTransactions (POST /v0/transactions/search)', () => {
  it('requires the date range and paging, filters AND-ed, sorts newest first by clearing time (or transaction time), pages, and includes tags', async () => {
    const a = await newAccount()
    const originId = randomUUID()
    const ids: string[] = []
    ids.push((await credit(a.accountHayId!, 1, { originType: 'CUSTOMER', originChannel: 'POS_DEBIT' })).transactionId!)
    await advanceClock(1000)
    ids.push((await credit(a.accountHayId!, 2, { originType: 'OPERATIONS', originId })).transactionId!)
    await advanceClock(1000)
    ids.push((await debit(a.accountHayId!, 1, { originType: 'OPERATIONS' })).transactionId!)
    const txs = await Promise.all(ids.map(getTransaction))
    const from = txs[0]!.clearingTimeUtc!
    const to = txs[2]!.clearingTimeUtc!
    const search = (body: Record<string, unknown>, query = 'limit=100&offset=0') => post(`/v0/transactions/search?${query}`, { accountId: a.accountHayId, fromDateTimeUtc: from, toDateTimeUtc: to, ...body })

    let res = await search({})
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().map((t: FinancialTransaction) => t.transactionHayId)).toEqual([ids[2], ids[1], ids[0]])
    expect(res.json()[0].tags).toEqual([])
    expect((await search({ originType: 'OPERATIONS' })).json().map((t: FinancialTransaction) => t.transactionHayId)).toEqual([ids[2], ids[1]])
    expect((await search({ originType: 'OPERATIONS', originId })).json().map((t: FinancialTransaction) => t.transactionHayId)).toEqual([ids[1]])
    expect((await search({ originChannel: 'POS_DEBIT' })).json().map((t: FinancialTransaction) => t.transactionHayId)).toEqual([ids[0]])
    expect((await search({ originChannel: 'ATM_CASH' })).json()).toEqual([])
    expect((await search({ accountId: UNKNOWN_ID })).json()).toEqual([])
    // no accountId: every account's postings in the window
    const otherAccount = await newAccount()
    const otherId = (await credit(otherAccount.accountHayId!, 1, { originId })).transactionId!
    const all = await post('/v0/transactions/search?limit=1000&offset=0', { fromDateTimeUtc: from, toDateTimeUtc: (await getTransaction(otherId)).clearingTimeUtc, originId })
    expect(all.json().map((t: FinancialTransaction) => t.transactionHayId)).toEqual([otherId, ids[1]])
    // bounds are inclusive on both ends
    expect((await search({ toDateTimeUtc: txs[1]!.clearingTimeUtc })).json().map((t: FinancialTransaction) => t.transactionHayId)).toEqual([ids[1], ids[0]])
    expect((await search({ fromDateTimeUtc: txs[1]!.clearingTimeUtc })).json().map((t: FinancialTransaction) => t.transactionHayId)).toEqual([ids[2], ids[1]])
    expect((await search({ fromDateTimeUtc: new Date(new Date(from).getTime() + 1).toISOString(), toDateTimeUtc: new Date(new Date(to).getTime() - 1).toISOString() })).json().map((t: FinancialTransaction) => t.transactionHayId)).toEqual([ids[1]])
    // paging
    expect((await search({}, 'limit=2&offset=0')).json().map((t: FinancialTransaction) => t.transactionHayId)).toEqual([ids[2], ids[1]])
    expect((await search({}, 'limit=2&offset=2')).json().map((t: FinancialTransaction) => t.transactionHayId)).toEqual([ids[0]])
    expect((await search({}, 'limit=2&offset=5')).json()).toEqual([])
    // sortBy TRANSACTION_TIME uses the transaction time (a backdated posting)
    const backdated = svc.post({ accountId: a.accountHayId!, amountCents: 100, type: 'GENERAL_CREDIT', channel: 'MANUAL_ADJUSTMENT', transactionTimeUtc: new Date(new Date(from).getTime() + 500).toISOString() }).transaction!
    expect((await search({}, 'limit=10&offset=0&sortBy=TRANSACTION_TIME')).json().map((t: FinancialTransaction) => t.transactionHayId)).toEqual([ids[2], ids[1], backdated.id, ids[0]])
    expect((await search({}, 'limit=10&offset=0&sortBy=CLEARING_TIME')).json().map((t: FinancialTransaction) => t.transactionHayId)).toEqual([ids[2], ids[1], ids[0]])
    // tags ride along
    await post(`/v1/transactions/${ids[0]}/tags`, { operation: 'ADD', tags: [{ category: 'expense-type', value: 'groceries' }] })
    expect((await search({ originChannel: 'POS_DEBIT' })).json()[0].tags).toEqual([{ id: expect.stringMatching(UUID_RE), category: 'expense-type', value: 'groceries' }])
    // microseconds survive: a client-supplied transaction time keeps its digits and the inclusive `to` bound honours them
    const micro = `${new Date(new Date(from).getTime() + 700).toISOString().slice(0, -1)}900Z`
    const precise = svc.post({ accountId: a.accountHayId!, amountCents: 1, type: 'GENERAL_CREDIT', channel: 'MANUAL_ADJUSTMENT', transactionTimeUtc: micro }).transaction!
    expect((await getTransaction(precise.id)).transactionTimeUtc).toBe(micro)
    const byTime = (toDateTimeUtc: string) => search({ toDateTimeUtc }, 'limit=10&offset=0&sortBy=TRANSACTION_TIME').then((r) => r.json().map((t: FinancialTransaction) => t.transactionHayId))
    expect(await byTime(micro)).toEqual([precise.id, backdated.id, ids[0]])
    expect(await byTime(micro.replace('900Z', '899Z'))).toEqual([backdated.id, ids[0]])
    expect(await byTime(micro.replace('900Z', '900001Z'))).toEqual([precise.id, backdated.id, ids[0]]) // beyond microseconds is truncated

    // validation
    expectError(await search({}, 'limit=0&offset=0'), 400, /^BAD_REQUEST: limit/)
    expectError(await search({}, 'limit=1001&offset=0'), 400, /^BAD_REQUEST: limit/)
    expectError(await search({}, 'limit=10&offset=-1'), 400, /^BAD_REQUEST: offset/)
    expectError(await search({}, 'offset=0'), 400, /^BAD_REQUEST/)
    expectError(await search({}, 'limit=10&offset=0&sortBy=AMOUNT'), 400, /^BAD_REQUEST/)
    expectError(await search({ fromDateTimeUtc: undefined }), 400, /^BAD_REQUEST/)
    expectError(await search({ fromDateTimeUtc: 'yesterday' }), 400, /^BAD_REQUEST/)
    expectError(await search({ fromDateTimeUtc: to, toDateTimeUtc: from }), 400, /^BAD_REQUEST: fromDateTimeUtc must not be after/)
    expectError(await search({ originType: 'MANDATE_PAYMENT' }), 400, /^BAD_REQUEST/)
  })
})

describe('tags (GET/POST /v1/transactions/{transactionHayId}/tags)', () => {
  it('ADD is idempotent by (category, value) or by id, REMOVE of an absent tag is a no-op, the list is ordered by creation and rides on the transaction', async () => {
    const a = await newAccount()
    const id = (await credit(a.accountHayId!, 1)).transactionId!
    const other = (await credit(a.accountHayId!, 1)).transactionId!
    const url = `/v1/transactions/${id}/tags`
    expect((await app.inject({ method: 'GET', url })).json()).toEqual({ tags: [] })

    let res = await post(url, { operation: 'ADD', tags: [{ category: 'expense-type', value: 'groceries' }, { category: 'project', value: 'alpha' }] })
    expect(res.statusCode, res.body).toBe(200)
    const tags = res.json().tags as { id: string; category: string; value: string }[]
    expect(tags).toEqual([{ id: expect.stringMatching(UUID_RE), category: 'expense-type', value: 'groceries' }, { id: expect.stringMatching(UUID_RE), category: 'project', value: 'alpha' }])
    res = await post(url, { operation: 'ADD', tags: [{ category: 'expense-type', value: 'groceries' }, { id: tags[1]!.id }, { category: 'Expense-Type', value: 'groceries' }] })
    expect(res.json().tags).toEqual([...tags, { id: expect.stringMatching(UUID_RE), category: 'Expense-Type', value: 'groceries' }])
    expect((await app.inject({ method: 'GET', url })).json().tags).toHaveLength(3)
    expect((await getTransaction(id)).tags).toHaveLength(3)

    // an id from another transaction references that tag's pair
    res = await post(`/v1/transactions/${other}/tags`, { operation: 'ADD', tags: [{ id: tags[0]!.id }] })
    expect(res.json().tags).toEqual([{ id: expect.stringMatching(UUID_RE), category: 'expense-type', value: 'groceries' }])
    expect(res.json().tags[0].id).not.toBe(tags[0]!.id)
    // an id sent with its own pair is fine; with a different pair it is a 400; a REMOVE by an id that belongs to another transaction is a no-op
    expect((await post(`/v1/transactions/${other}/tags`, { operation: 'ADD', tags: [{ id: tags[0]!.id, category: 'expense-type', value: 'groceries' }] })).json().tags).toHaveLength(1)
    expectError(await post(`/v1/transactions/${other}/tags`, { operation: 'ADD', tags: [{ id: tags[0]!.id, category: 'project', value: 'groceries' }] }), 400, TAGS_400_MESSAGE)
    expectError(await post(`/v1/transactions/${other}/tags`, { operation: 'ADD', tags: [{ id: tags[0]!.id, value: 'beer' }] }), 400, TAGS_400_MESSAGE)
    expect((await post(`/v1/transactions/${other}/tags`, { operation: 'REMOVE', tags: [{ id: tags[0]!.id }] })).json().tags).toHaveLength(1)
    expect((await getTransaction(id)).tags).toHaveLength(3)

    res = await post(url, { operation: 'REMOVE', tags: [{ category: 'project', value: 'alpha' }, { category: 'nope', value: 'absent' }, { id: UNKNOWN_ID }] })
    expect(res.statusCode).toBe(400) // unknown id fails validation before anything is removed
    res = await post(url, { operation: 'REMOVE', tags: [{ category: 'project', value: 'alpha' }, { category: 'nope', value: 'absent' }] })
    expect(res.json().tags.map((t: { value: string }) => t.value)).toEqual(['groceries', 'groceries'])
    res = await post(url, { operation: 'REMOVE', tags: [{ id: tags[0]!.id }, { id: tags[0]!.id }] })
    expect(res.json().tags).toEqual([{ id: expect.stringMatching(UUID_RE), category: 'Expense-Type', value: 'groceries' }])
    expect((await getTransaction(other)).tags).toHaveLength(1)
  })

  it('400 with the spec message when the list is empty, the operation is missing or a tag has neither id nor a valid pair; 404 for an unknown transaction', async () => {
    const a = await newAccount()
    const id = (await credit(a.accountHayId!, 1)).transactionId!
    const url = `/v1/transactions/${id}/tags`
    const message = 'BAD_REQUEST: Invalid request - tag validation failed, list is empty, or operation is missing'
    expectError(await post(url, { operation: 'ADD', tags: [] }), 400, message)
    expectError(await post(url, { tags: [{ category: 'a', value: 'b' }] }), 400, message)
    expectError(await post(url, { operation: 'UPSERT', tags: [{ category: 'a', value: 'b' }] }), 400, message)
    expectError(await post(url, { operation: 'ADD' }), 400, message)
    expectError(await post(url, { operation: 'ADD', tags: [{ category: 'a' }] }), 400, message)
    expectError(await post(url, { operation: 'ADD', tags: [{ id: null, category: 'a', value: ' b' }] }), 400, message)
    expectError(await post(url, { operation: 'ADD', tags: [{ category: 'x'.repeat(65), value: 'b' }] }), 400, message)
    expectError(await post(url, { operation: 'ADD', tags: Array.from({ length: 101 }, (_, i) => ({ category: 'c', value: `v${i}` })) }), 400, message)
    expectError(await post(url, { operation: 'ADD', tags: [{ id: UNKNOWN_ID }] }), 400, message)
    expectError(await post(`/v1/transactions/${UNKNOWN_ID}/tags`, { operation: 'ADD', tags: [{ category: 'a', value: 'b' }] }), 404, /^NOT_FOUND: Transaction/)
    expectError(await app.inject({ method: 'GET', url: `/v1/transactions/${UNKNOWN_ID}/tags` }), 404, /^NOT_FOUND: Transaction/)
    expectError(await app.inject({ method: 'GET', url: `/v1/transactions/${UNKNOWN_ID}` }), 404, /^NOT_FOUND: Transaction/)
    expect((await app.inject({ method: 'GET', url })).json()).toEqual({ tags: [] })
  })
})

describe('webhook payloads', () => {
  it('every TRANSACTION notification emitted in this run validates against wh:NotificationDto', async () => {
    const payloads = (await allPayloads()).filter((p) => p.type === 'TRANSACTION')
    expect(payloads.length).toBeGreaterThan(20)
    for (const p of payloads) assertValidNotification(p)
    for (const p of payloads) {
      expect(p).not.toHaveProperty('cardHayId')
      expect(p.transactionEvent.customerHayId).toBe(p.customerHayId)
      expect(p.transactionEvent.transactionTimeUtc).toMatch(ISO_MICROS)
    }
  })
})
