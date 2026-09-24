import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '../src/contract/generated/b2b-types.js'
import { startApp } from './helpers.js'
import { assertValidNotification } from './webhook-schema.js'
import type { BuiltServer } from '../src/server.js'
import { LOCAL_PRODUCT_ID } from '../src/domains/accounts/index.js'
import { STAGING_BILLERS, toBpayOutcome, type BpayService } from '../src/domains/bpay/index.js'

type S = components['schemas']
type HayAccount = S['HayAccount']
type FinancialTransaction = S['FinancialTransaction']
type BillerResponse = S['BPayBillerResponse']
type PaymentBody = S['BPayPaymentRequestBody']
type PaymentResponse = S['BpayPaymentResponseBody']

const BPAY_OPS = ['retrieveBillers', 'createBPayBiller', 'makeBpayPayment', 'validateBpay', 'retrieveBpayBiller', 'updateBpayBiller']
const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111'
const UUID_RE = /^[0-9a-f-]{36}$/
const AUD = (amount: number) => ({ currency: 'AUD', amount })
const DAY_MS = 24 * 60 * 60 * 1000
/** docs:bpay webhook sample biller (fixture 93880: 12-digit CRN, $10–$4,000). */
const IINET = { billerCode: '93880', reference: '271682361223' }

let built: BuiltServer
let app: BuiltServer['app']
let svc: BpayService
beforeAll(async () => { built = await startApp(); app = built.app; svc = built.ctx.services.bpay })
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
      idempotencyKey: randomUUID(), email: `bpay${n}@example.com`, customerTier: 'STANDARD',
      phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: `7${String(n).padStart(8, '0')}` },
      address: { line1: '1 Test St', townOrCity: 'Sydney', administrativeRegion: 'NSW', postcode: '2000', countryCodeIso: 'AUS' },
      customerDetails: { firstName: 'Bill', lastName: `Payer${n}`, dateOfBirth: '1990-01-01' },
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
/** A funded LOW-risk account (credit posted, so ACTIVE). */
async function fundedAccount(amount: number, opts: { holder?: string } = {}): Promise<HayAccount> {
  const a = await newAccount(opts)
  // above the 100,000 daily top-up cap the fixture credits through the engine with MAX_BALANCE only
  if (amount > 100_000) built.ctx.services.transactions.post({ accountId: a.accountHayId!, amountCents: Math.round(amount * 100), type: 'GENERAL_CREDIT', channel: 'MANUAL_ADJUSTMENT', counterpart: { name: 'Payroll' }, limits: ['MAX_BALANCE'] })
  else await credit(a.accountHayId!, amount)
  await flush()
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
function expectError(res: { statusCode: number; json: () => any }, status: number, code: RegExp | string): void {
  expect(res.statusCode).toBe(status)
  const body = res.json()
  expect(body).toMatchObject({ status: String(status), details: expect.stringContaining('traceId') })
  expect(body.traceId).toMatch(UUID_RE)
  expect(body.message).toMatch(code)
}
function billerBody(overrides: Partial<S['BPayBillerAddRequestBody']> = {}): S['BPayBillerAddRequestBody'] {
  n++
  return { billerCode: IINET.billerCode, reference: IINET.reference, name: `Biller ${n}`, ...overrides }
}
async function createBiller(accountId: string, overrides: Partial<S['BPayBillerAddRequestBody']> = {}): Promise<BillerResponse> {
  const res = await app.inject({ method: 'POST', url: `/v1/accounts/${accountId}/bpay-billers`, payload: billerBody(overrides) })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as BillerResponse
}
async function listBillers(accountId: string, query = 'limit=100&offset=0') {
  return app.inject({ method: 'GET', url: `/v1/accounts/${accountId}/bpay-billers?${query}` })
}
async function patchBiller(billerId: string, payload: S['BPayBillerUpdateRequestBody']) {
  return app.inject({ method: 'PATCH', url: `/v1/bpay-billers/${billerId}`, payload })
}
async function getBiller(billerId: string) {
  return app.inject({ method: 'GET', url: `/v1/bpay-billers/${billerId}` })
}
async function validate(payload: object) {
  return app.inject({ method: 'POST', url: '/v1/bpay-billers/validate', payload })
}
function paymentBody(senderCustomerHayId: string, amount: number, overrides: Partial<PaymentBody> = {}): PaymentBody {
  return { amount, senderCustomerHayId, category: 'Utilities', description: 'test BPAY TRANSFER', name: 'TestGQL', ...IINET, ...overrides }
}
async function payRaw(accountId: string, payload: object) {
  return app.inject({ method: 'POST', url: `/v1/accounts/${accountId}/payments/bpay`, payload })
}
async function pay(accountId: string, senderCustomerHayId: string, amount: number, overrides: Partial<PaymentBody> = {}): Promise<PaymentResponse> {
  const res = await payRaw(accountId, paymentBody(senderCustomerHayId, amount, overrides))
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as PaymentResponse
}
/** A funded account with its holder: `{ id, holder, account }`. */
async function payer(funds = 1000): Promise<{ id: string; holder: string; account: HayAccount }> {
  const holder = await newCustomer()
  const account = await fundedAccount(funds, { holder })
  return { id: account.accountHayId!, holder, account }
}

// ---------------------------------------------------------------------------------------------------

describe('bpay domain: registration', () => {
  it('handles every BPAY API operation (none left on the stub)', async () => {
    const res = await app.inject({ method: 'GET', url: '/_admin/operations' })
    const { handled, stubbed } = res.json() as { handled: string[]; stubbed: string[] }
    for (const op of BPAY_OPS) {
      expect(handled, op).toContain(op)
      expect(stubbed, op).not.toContain(op)
    }
    expect(svc).toBeDefined()
  })
})

describe('validateBpay', () => {
  it('returns the directory details of a staging fixture biller with the reference echoed', async () => {
    const res = await validate(IINET)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ billerCode: '93880', shortName: 'APIBCD SERVICES AV12', longName: 'APIBCD SERVICES AV12', industryAnzsicCode: '94540', referenceNumber: IINET.reference })
    expect(res.headers['x-shaype-local-stub']).toBeUndefined()
  })

  it('accepts any 4-10 digit biller code (leading zeros kept) with a 2-20 digit reference, synthesising the details', async () => {
    const res = await validate({ billerCode: '0012345678', reference: '42' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ billerCode: '0012345678', shortName: 'BILLER 0012345678', longName: 'BILLER LONG NAME 0012345678', industryAnzsicCode: '9999', referenceNumber: '42' })
    expect((await validate({ billerCode: '1234', reference: '12345678901234567890' })).statusCode).toBe(200)
  })

  it('refuses the deactivated biller 000000, the inactive fixture 1016, a 3-digit and a non-numeric code (422 INVALID_BILLER_CODE)', async () => {
    expectError(await validate({ billerCode: '000000', reference: '1234' }), 422, /^INVALID_BILLER_CODE: Biller code 000000 is not an active BPAY biller/)
    expectError(await validate({ billerCode: '1016', reference: '4274145400' }), 422, /^INVALID_BILLER_CODE: .*not an active/)
    expectError(await validate({ billerCode: '123', reference: '1234' }), 422, /^INVALID_BILLER_CODE: Biller code 123 must be 4 to 10 digits/)
    expectError(await validate({ billerCode: '12a4', reference: '1234' }), 422, /^INVALID_BILLER_CODE/)
    expect(STAGING_BILLERS.find((b) => b.billerCode === '1016')?.active).toBe(false)
  })

  it('refuses a reference that fails the biller\'s length rule or is not all digits (422 INVALID_REFERENCE)', async () => {
    expectError(await validate({ billerCode: '7773', reference: '1234567' }), 422, /^INVALID_REFERENCE: Reference 1234567 must be 8 digits for biller 7773/)
    expect((await validate({ billerCode: '7773', reference: '74177361' })).statusCode).toBe(200)
    expectError(await validate({ billerCode: '93849', reference: '12345678' }), 422, /must be 7, 9, 10 digits/)
    expect((await validate({ billerCode: '93849', reference: '7231016' })).statusCode).toBe(200)
    expectError(await validate({ billerCode: '1234', reference: '12AB' }), 422, /^INVALID_REFERENCE: Reference 12AB must be 2 to 20 digits/)
  })

  it('applies the ICRNAMT fixture\'s 4-20 digit CRN lengths (600015), unlike the 2-20 of a synthesised biller', async () => {
    expectError(await validate({ billerCode: '600015', reference: '12' }), 422, /^INVALID_REFERENCE: Reference 12 must be 4 to 20 digits for biller 600015/)
    expectError(await validate({ billerCode: '600015', reference: '123' }), 422, /^INVALID_REFERENCE/)
    expect((await validate({ billerCode: '600015', reference: '1234' })).statusCode).toBe(200)
    expect((await validate({ billerCode: '600015', reference: '0808812345678260' })).statusCode).toBe(200)
    expect((await validate({ billerCode: '600015', reference: '12345678901234567890' })).statusCode).toBe(200)
    expect(STAGING_BILLERS.find((b) => b.billerCode === '600015')?.crnLengths).toEqual(Array.from({ length: 17 }, (_, i) => i + 4))
  })

  it('validates the body against the schema (400)', async () => {
    expect((await validate({ billerCode: '1234' })).statusCode).toBe(400)
    expect((await validate({ billerCode: '12', reference: '1234' })).statusCode).toBe(400)
    expect((await validate({ billerCode: '1234', reference: '1' })).statusCode).toBe(400)
    expect((await validate({ billerCode: '1234', reference: '123456789012345678901' })).statusCode).toBe(400)
  })
})

describe('createBPayBiller / retrieveBpayBiller', () => {
  it('a CLOSED account takes no new or changed billers (422 ACCOUNT_CLOSED, the shared resource gate)', async () => {
    const a = await newAccount()
    const saved = await createBiller(a.accountHayId!, { name: 'Internet' })
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${a.accountHayId}/close` })).statusCode).toBe(202)
    await flush()
    expectError(await app.inject({ method: 'POST', url: `/v1/accounts/${a.accountHayId}/bpay-billers`, payload: billerBody({ name: 'Other', reference: '271682361231' }) }), 422, /^ACCOUNT_CLOSED: /)
    expectError(await patchBiller(saved.hayId!, { name: 'renamed' }), 422, /^ACCOUNT_CLOSED: /)
    expect((await listBillers(a.accountHayId!)).json().map((b: BillerResponse) => b.name)).toEqual(['Internet'])
  })

  it('saves a biller against the account with the directory details and a logo image', async () => {
    const a = await newAccount()
    const created = await createBiller(a.accountHayId!, { name: 'Internet' })
    expect(created).toEqual({
      hayId: expect.stringMatching(UUID_RE),
      accountHayId: a.accountHayId,
      name: 'Internet',
      image: 'https://billers.local/93880.png',
      billerDetails: { billerCode: '93880', shortName: 'APIBCD SERVICES AV12', longName: 'APIBCD SERVICES AV12', industryAnzsicCode: '94540', referenceNumber: IINET.reference },
    })
    expect(created).not.toHaveProperty('status')
    const got = await getBiller(created.hayId!)
    expect(got.statusCode).toBe(200)
    expect(got.json()).toEqual(created)
  })

  it('refuses a duplicate biller code + reference pair on the account with 409 Conflict', async () => {
    const a = await newAccount()
    await createBiller(a.accountHayId!)
    const dup = await app.inject({ method: 'POST', url: `/v1/accounts/${a.accountHayId}/bpay-billers`, payload: billerBody() })
    expectError(dup, 409, /^DUPLICATE_BILLER: Biller code 93880 with reference 271682361223 is already saved/)
    // the same biller code with another reference, and the same pair on another account, are fine
    expect((await createBiller(a.accountHayId!, { reference: '781133471230' })).billerDetails?.referenceNumber).toBe('781133471230')
    const other = await newAccount()
    expect((await createBiller(other.accountHayId!)).accountHayId).toBe(other.accountHayId)
  })

  it('refuses a duplicate nickname on the account (case-insensitive) with 409 Conflict', async () => {
    const a = await newAccount()
    await createBiller(a.accountHayId!, { name: 'Power' })
    expectError(await app.inject({ method: 'POST', url: `/v1/accounts/${a.accountHayId}/bpay-billers`, payload: billerBody({ name: 'power', reference: '781133471230' }) }), 409, /^DUPLICATE_BILLER_NAME: A biller named power is already saved/)
  })

  it('refuses a blank nickname (400) and stores a padded one trimmed, so DUPLICATE_BILLER_NAME ignores surrounding whitespace', async () => {
    const a = await newAccount()
    const post = (payload: object) => app.inject({ method: 'POST', url: `/v1/accounts/${a.accountHayId}/bpay-billers`, payload })
    expectError(await post(billerBody({ name: '' })), 400, /^BAD_REQUEST: name must not be blank/)
    expectError(await post(billerBody({ name: '   ' })), 400, /^BAD_REQUEST: name must not be blank/)
    const padded = await createBiller(a.accountHayId!, { name: '  Power  ' })
    expect(padded.name).toBe('Power')
    expect((await getBiller(padded.hayId!)).json().name).toBe('Power')
    expectError(await post(billerBody({ name: ' power', reference: '781133471230' })), 409, /^DUPLICATE_BILLER_NAME: A biller named power is already saved/)
    expect((await listBillers(a.accountHayId!)).json()).toEqual([padded])
  })

  it('validates the biller code and reference against the directory (422) and the body against the schema (400)', async () => {
    const a = await newAccount()
    const post = (payload: object) => app.inject({ method: 'POST', url: `/v1/accounts/${a.accountHayId}/bpay-billers`, payload })
    expectError(await post(billerBody({ billerCode: '000000' })), 422, /^INVALID_BILLER_CODE/)
    expectError(await post(billerBody({ billerCode: '7773', reference: '1234' })), 422, /^INVALID_REFERENCE/)
    expectError(await post(billerBody({ reference: '1' })), 422, /^INVALID_REFERENCE: Reference 1 must be 2 to 20 digits/) // no schema bound on this body
    expect((await post({ billerCode: '12', reference: '1234', name: 'x' })).statusCode).toBe(400)
    expect((await post({ billerCode: '1234', reference: '1234' })).statusCode).toBe(400)
  })

  it('answers 404 for an unknown account or biller id and 400 for a malformed id', async () => {
    expectError(await app.inject({ method: 'POST', url: `/v1/accounts/${UNKNOWN_ID}/bpay-billers`, payload: billerBody() }), 404, /^NOT_FOUND: Account/)
    expectError(await getBiller(UNKNOWN_ID), 404, /^NOT_FOUND: Biller/)
    expect((await getBiller('not-a-uuid')).statusCode).toBe(400)
  })
})

describe('retrieveBillers', () => {
  it('lists the account\'s billers as a paged array in creation order (contract deviation: array, not one object)', async () => {
    const a = await newAccount()
    const first = await createBiller(a.accountHayId!, { name: 'One' })
    const second = await createBiller(a.accountHayId!, { name: 'Two', reference: '781133471230' })
    const third = await createBiller(a.accountHayId!, { name: 'Three', billerCode: '7773', reference: '74177361' })
    const res = await listBillers(a.accountHayId!)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.json()).toEqual([first, second, third])
    expect((await listBillers(a.accountHayId!, 'limit=1&offset=1')).json()).toEqual([second])
    expect((await listBillers(a.accountHayId!, 'limit=10&offset=3')).json()).toEqual([])
    expect((await listBillers((await newAccount()).accountHayId!)).json()).toEqual([])
  })

  it('requires limit 1..1000 and offset >= 0 (400) and an existing account (404)', async () => {
    const a = await newAccount()
    expect((await listBillers(a.accountHayId!, 'limit=0&offset=0')).statusCode).toBe(400)
    expect((await listBillers(a.accountHayId!, 'limit=1001&offset=0')).statusCode).toBe(400)
    expect((await listBillers(a.accountHayId!, 'limit=10&offset=-1')).statusCode).toBe(400)
    expect((await listBillers(a.accountHayId!, 'offset=0')).statusCode).toBe(400)
    expect((await listBillers(a.accountHayId!, 'limit=10')).statusCode).toBe(400)
    expectError(await listBillers(UNKNOWN_ID), 404, /^NOT_FOUND: Account/)
  })
})

describe('updateBpayBiller', () => {
  it('partially updates name, image and reference and answers 204 with no body', async () => {
    const a = await newAccount()
    const b = await createBiller(a.accountHayId!, { name: 'Old' })
    const res = await patchBiller(b.hayId!, { name: 'New', image: 'https://example.com/logo.png' })
    expect(res.statusCode, res.body).toBe(204)
    expect(res.body).toBe('')
    expect((await getBiller(b.hayId!)).json()).toEqual({ ...b, name: 'New', image: 'https://example.com/logo.png' })
    expect((await patchBiller(b.hayId!, { reference: '781133471230' })).statusCode).toBe(204)
    expect((await getBiller(b.hayId!)).json().billerDetails.referenceNumber).toBe('781133471230')
    expect((await patchBiller(b.hayId!, {})).statusCode).toBe(204)
    expect((await patchBiller(b.hayId!, { status: 'ACTIVE' })).statusCode).toBe(204)
    expect((await listBillers(a.accountHayId!)).json()).toHaveLength(1)
  })

  it('re-applies the CRN rules and the uniqueness rules on update (422, not 409)', async () => {
    const a = await newAccount()
    const one = await createBiller(a.accountHayId!, { name: 'One' })
    const two = await createBiller(a.accountHayId!, { name: 'Two', reference: '781133471230' })
    expectError(await patchBiller(two.hayId!, { reference: IINET.reference }), 422, /^DUPLICATE_BILLER: /)
    expectError(await patchBiller(two.hayId!, { name: 'ONE' }), 422, /^DUPLICATE_BILLER_NAME: /)
    expectError(await patchBiller(two.hayId!, { reference: '1234' }), 422, /^INVALID_REFERENCE: /)
    expect((await patchBiller(one.hayId!, { name: 'One', reference: IINET.reference })).statusCode).toBe(204) // its own values
    expect((await patchBiller(two.hayId!, { reference: '1' })).statusCode).toBe(400) // schema minLength 2
    expect((await patchBiller(two.hayId!, { name: '' })).statusCode).toBe(400)
    expectError(await patchBiller(two.hayId!, { name: '   ' }), 400, /^BAD_REQUEST: name must not be blank/)
    expect((await patchBiller(two.hayId!, { name: '  Renamed ' })).statusCode).toBe(204)
    expect((await getBiller(two.hayId!)).json().name).toBe('Renamed')
    expectError(await patchBiller(one.hayId!, { name: 'renamed ' }), 422, /^DUPLICATE_BILLER_NAME: /)
  })

  it('DISMISSED hides the biller from the list, is terminal, and frees its name and reference', async () => {
    const a = await newAccount()
    const b = await createBiller(a.accountHayId!, { name: 'Gone' })
    expect((await patchBiller(b.hayId!, { status: 'DISMISSED' })).statusCode).toBe(204)
    expect((await listBillers(a.accountHayId!)).json()).toEqual([])
    expect((await getBiller(b.hayId!)).statusCode).toBe(200) // still retrievable by id
    expectError(await patchBiller(b.hayId!, { status: 'ACTIVE' }), 422, /^INVALID_STATE: Biller .* is DISMISSED/)
    expectError(await patchBiller(b.hayId!, { name: 'x' }), 422, /^INVALID_STATE/)
    expectError(await patchBiller(b.hayId!, { status: 'DISMISSED' }), 422, /^INVALID_STATE/)
    const again = await createBiller(a.accountHayId!, { name: 'Gone' })
    expect(again.hayId).not.toBe(b.hayId)
    expect((await listBillers(a.accountHayId!)).json()).toEqual([again])
  })

  it('refuses a status outside ACTIVE / DISMISSED (400) and answers 404 for an unknown biller', async () => {
    const a = await newAccount()
    const b = await createBiller(a.accountHayId!)
    expectError(await patchBiller(b.hayId!, { status: 'PAUSED' }), 400, /^BAD_REQUEST: status must be ACTIVE or DISMISSED/)
    expectError(await patchBiller(UNKNOWN_ID, { name: 'x' }), 404, /^NOT_FOUND: Biller/)
  })
})

describe('makeBpayPayment: accepted', () => {
  it('posts BPAY_TRANSFER_OUT immediately, debits the balance and answers ACCEPTED with the transactionId', async () => {
    const p = await payer(1000)
    const r = await pay(p.id, p.holder, 20)
    expect(r).toEqual({ outcome: 'ACCEPTED', transactionId: expect.stringMatching(UUID_RE) })
    expect(await getAccount(p.id)).toMatchObject({ totalBalance: 980, availableBalance: 980, heldBalance: 0, status: 'ACTIVE' })
    const t = await getTransaction(r.transactionId!)
    expect(t).toMatchObject({
      transactionHayId: r.transactionId, accountHayId: p.id, customerId: p.holder, productId: LOCAL_PRODUCT_ID,
      type: 'BPAY_TRANSFER_OUT', transactionChannel: 'CUSCAL_BPAY_TRANSFER_OUT', currencyAmount: AUD(-20), rollingAccountBalance: 980,
      description: 'test BPAY TRANSFER', category: 'Utilities', reference: IINET.reference, counterpartName: 'TestGQL', counterpartDetails: { name: 'TestGQL' }, originType: 'CUSTOMER',
    })
    expect(t).not.toHaveProperty('relatedHoldHayId')
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${p.id}/holds` })).json()).toEqual([])
  })

  it('emits the TRANSACTION / BPAY_TRANSFER_OUT webhook with counterpartDetails.bpayDetails (docs:bpay sample shape)', async () => {
    const p = await payer(151107.66)
    const r = await pay(p.id, p.holder, 20, { description: 'test BPAY TRANSFER BA AU PAYEE', category: 'Category' })
    const events = await txEvents(p.id)
    const ev = events.at(-1)
    expect(events.filter((e) => e.transactionEvent.transactionType === 'BPAY_TRANSFER_OUT')).toHaveLength(1)
    expect(ev).toEqual({
      customerHayId: p.holder,
      idempotencyKey: expect.stringMatching(UUID_RE),
      type: 'TRANSACTION',
      actionOwner: 'CLIENT',
      productId: LOCAL_PRODUCT_ID,
      transactionEvent: {
        transactionHayId: r.transactionId,
        accountHayId: p.id,
        currencyAmount: AUD(-20),
        updatedBalance: AUD(151087.66),
        isPending: false,
        counterpartName: 'TestGQL',
        outcome: 'ACCEPTED',
        transactionTimeUtc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
        isAtmTransaction: false,
        transactionType: 'BPAY_TRANSFER_OUT',
        accountBalances: { totalBalance: AUD(151087.66), heldBalance: AUD(0), lockedBalance: AUD(0), stacksBalance: AUD(0), availableBalance: AUD(151087.66) },
        customerHayId: p.holder,
        counterpartDetails: {
          name: 'TestGQL',
          bpayDetails: { billerCode: '93880', billerReference: '271682361223', billerName: 'APIBCD SERVICES AV12', billerImage: 'https://billers.local/93880.png' },
        },
        originType: 'CUSTOMER',
        category: 'Category',
        description: 'test BPAY TRANSFER BA AU PAYEE',
        reference: '271682361223',
      },
    })
    assertValidNotification(ev)
  })

  it('names the counterpart after the biller when the request carries no nickname and needs no saved biller', async () => {
    const p = await payer(100)
    const r = await pay(p.id, p.holder, 30, { name: undefined, description: undefined, billerCode: '55555', reference: '123456' })
    expect(r.outcome).toBe('ACCEPTED')
    const t = await getTransaction(r.transactionId!)
    expect(t).toMatchObject({ counterpartName: 'BILLER LONG NAME 55555', category: 'Utilities', reference: '123456' })
    expect(t).not.toHaveProperty('description')
    const ev = (await txEvents(p.id)).at(-1)
    expect(ev.transactionEvent).toMatchObject({ counterpartName: 'BILLER LONG NAME 55555', counterpartDetails: { name: 'BILLER LONG NAME 55555', bpayDetails: { billerCode: '55555', billerReference: '123456', billerName: 'BILLER LONG NAME 55555', billerImage: 'https://billers.local/55555.png' } } })
    expect(ev.transactionEvent).not.toHaveProperty('description')
    assertValidNotification(ev)
    expect((await listBillers(p.id)).json()).toEqual([]) // no auto-save
  })

  it('treats a blank nickname as absent (biller name) and trims a padded one, on the transaction and the webhook', async () => {
    const p = await payer(100)
    const blank = await pay(p.id, p.holder, 10, { name: '' })
    expect(blank.outcome).toBe('ACCEPTED')
    expect(await getTransaction(blank.transactionId!)).toMatchObject({ counterpartName: 'APIBCD SERVICES AV12', counterpartDetails: { name: 'APIBCD SERVICES AV12' } })
    const spaces = await pay(p.id, p.holder, 10, { name: '   ' })
    expect((await getTransaction(spaces.transactionId!)).counterpartName).toBe('APIBCD SERVICES AV12')
    const padded = await pay(p.id, p.holder, 10, { name: '  Nick  ' })
    expect((await getTransaction(padded.transactionId!)).counterpartName).toBe('Nick')
    const events = (await txEvents(p.id)).filter((e) => e.transactionEvent.transactionType === 'BPAY_TRANSFER_OUT')
    expect(events.map((e) => [e.transactionEvent.counterpartName, e.transactionEvent.counterpartDetails.name])).toEqual([
      ['APIBCD SERVICES AV12', 'APIBCD SERVICES AV12'], ['APIBCD SERVICES AV12', 'APIBCD SERVICES AV12'], ['Nick', 'Nick'],
    ])
    for (const ev of events) assertValidNotification(ev)
  })

  it('accepts the ICRNAMT fixture (600015) at its exact amount', async () => {
    const p = await payer(500)
    expect((await pay(p.id, p.holder, 104, { billerCode: '600015', reference: '0808812345678260' })).outcome).toBe('ACCEPTED')
    expect((await getAccount(p.id)).status).toBe('ACTIVE')
  })

  it('replays the response under idempotencyKey (same body), refuses a different body (422) and posts twice without a key', async () => {
    const p = await payer(1000)
    const idempotencyKey = randomUUID()
    const first = await pay(p.id, p.holder, 10, { idempotencyKey })
    const replay = await pay(p.id, p.holder, 10, { idempotencyKey })
    expect(replay).toEqual(first)
    expectError(await payRaw(p.id, paymentBody(p.holder, 11, { idempotencyKey })), 422, /^IDEMPOTENCY_KEY_REUSED/)
    expect((await getAccount(p.id)).totalBalance).toBe(990)
    // the accountId is part of the request: the same key on another account is a different request
    const other = await payer(1000)
    expectError(await payRaw(other.id, paymentBody(other.holder, 10, { idempotencyKey })), 422, /^IDEMPOTENCY_KEY_REUSED/)
    await pay(p.id, p.holder, 10)
    await pay(p.id, p.holder, 10)
    expect((await getAccount(p.id)).totalBalance).toBe(970)
    expect((await txEvents(p.id)).filter((e) => e.transactionEvent.transactionType === 'BPAY_TRANSFER_OUT')).toHaveLength(3)
  })
})

describe('makeBpayPayment: refusals (HTTP 200, no transaction, no webhook)', () => {
  async function expectRefused(p: { id: string; holder: string }, amount: number, outcome: string, overrides: Partial<PaymentBody> = {}): Promise<void> {
    const before = await getAccount(p.id)
    const events = (await txEvents(p.id)).length
    const r = await pay(p.id, p.holder, amount, overrides)
    expect(r).toEqual({ outcome })
    expect(r).not.toHaveProperty('transactionId')
    expect(await getAccount(p.id)).toMatchObject({ totalBalance: before.totalBalance, availableBalance: before.availableBalance })
    expect((await txEvents(p.id)).length).toBe(events)
  }

  it('REFUSED_INSUFFICIENT_FUNDS when the amount exceeds the available balance (REST enum, not the webhook\'s)', async () => {
    const p = await payer(50)
    await expectRefused(p, 50.01, 'REFUSED_INSUFFICIENT_FUNDS')
    expect((await pay(p.id, p.holder, 50)).outcome).toBe('ACCEPTED')
    expect(toBpayOutcome('REFUSED_NOT_ENOUGH_FUNDS')).toBe('REFUSED_INSUFFICIENT_FUNDS')
  })

  it('REFUSED_DAILY_BPAY_LIMIT_BREACHED over the rolling 24h BPAY_DAILY_LIMIT (docs: $100 limit, $101 payment)', async () => {
    const p = await payer(10_000)
    expect((await app.inject({ method: 'PUT', url: `/v1/accounts/${p.id}/limits/BPAY_DAILY_LIMIT`, payload: { limitAmount: 100 } })).statusCode).toBe(200)
    await expectRefused(p, 101, 'REFUSED_DAILY_BPAY_LIMIT_BREACHED')
    expect((await pay(p.id, p.holder, 60)).outcome).toBe('ACCEPTED')
    await expectRefused(p, 40.01, 'REFUSED_DAILY_BPAY_LIMIT_BREACHED')
    expect((await pay(p.id, p.holder, 40)).outcome).toBe('ACCEPTED')
    await advanceClock(DAY_MS + 1000)
    expect((await pay(p.id, p.holder, 100)).outcome).toBe('ACCEPTED')
    expect(toBpayOutcome('REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED')).toBe('REFUSED_DAILY_BPAY_LIMIT_BREACHED')
  })

  it('risk level HIGH zeroes the limit: every payment is REFUSED_DAILY_BPAY_LIMIT_BREACHED', async () => {
    const holder = await newCustomer()
    const a = await newAccount({ holder, risk: 'HIGH' })
    await expectRefused({ id: a.accountHayId!, holder }, 10, 'REFUSED_DAILY_BPAY_LIMIT_BREACHED')
  })

  it('a TOTAL_SPEND_PER_YEAR breach answers the surface\'s only limit value, REFUSED_DAILY_BPAY_LIMIT_BREACHED', async () => {
    const p = await payer(10_000)
    expect((await app.inject({ method: 'PUT', url: `/v1/accounts/${p.id}/limits/TOTAL_SPEND_PER_YEAR`, payload: { limitAmount: 50 } })).statusCode).toBe(200)
    await expectRefused(p, 60, 'REFUSED_DAILY_BPAY_LIMIT_BREACHED')
    expect(toBpayOutcome('REFUSED_ANNUAL_SPENDING_LIMIT_BREACHED')).toBe('REFUSED_DAILY_BPAY_LIMIT_BREACHED')
    expect(toBpayOutcome('REFUSED_LIMIT_BREACH')).toBe('REFUSED_DAILY_BPAY_LIMIT_BREACHED')
    expect(toBpayOutcome('REFUSED_RULES')).toBe('INTERNAL_ERROR')
    expect(toBpayOutcome('REFUSED_ACCOUNT_BLOCKED')).toBe('REFUSED_ACCOUNT_BLOCKED')
  })

  it('REFUSED_ACCOUNT_BLOCKED on a LOCKED account, REFUSED_ACCOUNT_CLOSED on a CLOSED account', async () => {
    const p = await payer(100)
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${p.id}/block`, payload: { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' } })).statusCode).toBe(200)
    await expectRefused(p, 10, 'REFUSED_ACCOUNT_BLOCKED')
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${p.id}/unblock`, payload: { note: 'x' } })).statusCode).toBe(200)
    expect((await pay(p.id, p.holder, 100)).outcome).toBe('ACCEPTED')
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${p.id}/close` })).statusCode).toBe(202)
    await flush()
    expect((await getAccount(p.id)).status).toBe('CLOSED')
    await expectRefused(p, 10, 'REFUSED_ACCOUNT_CLOSED')
  })

  it('REFUSED_BPAY_INVALID_BILLER_CODE / _REFERENCE / _PAYMENT for an inactive or malformed biller code, a bad CRN and an amount outside the biller\'s bounds', async () => {
    const p = await payer(100_000)
    await expectRefused(p, 10, 'REFUSED_BPAY_INVALID_BILLER_CODE', { billerCode: '000000', reference: '1234' })
    await expectRefused(p, 10, 'REFUSED_BPAY_INVALID_BILLER_CODE', { billerCode: '1016', reference: '4274145400' })
    await expectRefused(p, 10, 'REFUSED_BPAY_INVALID_BILLER_CODE', { billerCode: '123', reference: '1234' })
    await expectRefused(p, 10, 'REFUSED_BPAY_INVALID_REFERENCE', { billerCode: '7773', reference: '1234' })
    await expectRefused(p, 10, 'REFUSED_BPAY_INVALID_REFERENCE', { billerCode: '4321', reference: '12AB' })
    await expectRefused(p, 9.99, 'REFUSED_BPAY_INVALID_PAYMENT') // 93880: $10 minimum
    await expectRefused(p, 4000.01, 'REFUSED_BPAY_INVALID_PAYMENT') // 93880: $4,000 maximum
    await expectRefused(p, 100, 'REFUSED_BPAY_INVALID_PAYMENT', { billerCode: '600015', reference: '0808812345678260' }) // exact $104.00 only
    await expectRefused(p, 104, 'REFUSED_BPAY_INVALID_REFERENCE', { billerCode: '600015', reference: '123' }) // 600015: 4-20 digit CRNs
    expect((await pay(p.id, p.holder, 4000)).outcome).toBe('ACCEPTED')
  })

  it('REFUSED_CAPABILITY_NOT_ENABLED for an FX child account', async () => {
    const p = await payer(100)
    const child = await app.inject({ method: 'POST', url: '/v1/accounts', payload: { idempotencyKey: randomUUID(), accountHolderId: p.holder, accountHolderType: 'CUSTOMER', productId: LOCAL_PRODUCT_ID, currency: 'USD', parentAccountId: p.id } })
    expect(child.statusCode, child.body).toBe(200)
    const childId = child.json().accountHayId as string
    await app.inject({ method: 'PATCH', url: `/v0/accounts/${childId}/riskLevel`, payload: { level: 'LOW', reason: 'test' } })
    await expectRefused({ id: childId, holder: p.holder }, 10, 'REFUSED_CAPABILITY_NOT_ENABLED')
  })
})

describe('makeBpayPayment: request validation', () => {
  it('answers 404 for an unknown account or sender customer and 422 PERMISSION_DENIED when the customer does not hold the account', async () => {
    const p = await payer(100)
    expectError(await payRaw(UNKNOWN_ID, paymentBody(p.holder, 10)), 404, /^NOT_FOUND: Account/)
    expectError(await payRaw(p.id, paymentBody(UNKNOWN_ID, 10)), 404, /^NOT_FOUND: Customer/)
    const stranger = await newCustomer()
    expectError(await payRaw(p.id, paymentBody(stranger, 10)), 422, /^PERMISSION_DENIED: Customer .* does not hold account/)
    expect((await getAccount(p.id)).totalBalance).toBe(100)
  })

  it('validates the body: amount > 0 with at most 2 decimals, required fields, lengths (400)', async () => {
    const p = await payer(100)
    expect((await payRaw(p.id, paymentBody(p.holder, 0))).statusCode).toBe(400)
    expect((await payRaw(p.id, paymentBody(p.holder, -5))).statusCode).toBe(400)
    expectError(await payRaw(p.id, paymentBody(p.holder, 1.005)), 400, /^BAD_REQUEST: amount must be a number with at most 2 decimal places/)
    expect((await payRaw(p.id, { ...paymentBody(p.holder, 10), category: undefined })).statusCode).toBe(400)
    expect((await payRaw(p.id, { ...paymentBody(p.holder, 10), senderCustomerHayId: undefined })).statusCode).toBe(400)
    expect((await payRaw(p.id, paymentBody(p.holder, 10, { reference: '1' }))).statusCode).toBe(400)
    expect((await payRaw(p.id, paymentBody(p.holder, 10, { billerCode: '12' }))).statusCode).toBe(400)
    expect((await payRaw(p.id, paymentBody(p.holder, 10, { description: '' }))).statusCode).toBe(400)
    expect((await payRaw(p.id, paymentBody(p.holder, 10, { idempotencyKey: 'not-a-uuid' }))).statusCode).toBe(400)
    expect((await getAccount(p.id)).totalBalance).toBe(100)
  })
})

describe('ctx.services.bpay.post (scheduled payments / mocks)', () => {
  it('posts a BPAY payment without a request body, with PLATFORM as the default actionOwner and the given origin', async () => {
    const p = await payer(100)
    const r = svc.post({ accountId: p.id, amountCents: 2500, billerCode: '7773', reference: '74177361', category: 'Bills', originType: 'SCHEDULED_PAYMENT', originId: UNKNOWN_ID })
    expect(r.outcome).toBe('ACCEPTED')
    expect(r.transaction).toMatchObject({ type: 'BPAY_TRANSFER_OUT', amount: -2500, originType: 'SCHEDULED_PAYMENT', originId: UNKNOWN_ID, reference: '74177361' })
    expect(r.biller?.billerCode).toBe('7773')
    const ev = (await txEvents(p.id)).at(-1)
    expect(ev).toMatchObject({ actionOwner: 'PLATFORM', transactionEvent: { transactionType: 'BPAY_TRANSFER_OUT', originType: 'SCHEDULED_PAYMENT', originId: UNKNOWN_ID, counterpartName: 'APIBCD SERVICES AV1' } })
    assertValidNotification(ev)
    expect(svc.post({ accountId: p.id, amountCents: 10_000, billerCode: '7773', reference: '74177361' })).toEqual({ outcome: 'REFUSED_INSUFFICIENT_FUNDS', biller: expect.objectContaining({ billerCode: '7773' }) })
    expect(svc.post({ accountId: p.id, amountCents: 1000, billerCode: '7773', reference: '74177361' })).toEqual({ outcome: 'REFUSED_BPAY_INVALID_PAYMENT' }) // $20 minimum
    expect(() => svc.post({ accountId: UNKNOWN_ID, amountCents: 1000, billerCode: '7773', reference: '74177361' })).toThrow(/NOT_FOUND/)
    expect(svc.validate('7773', '74177361', 1000)).toMatchObject({ ok: false, failure: 'AMOUNT' })
    expect(svc.biller('000000')?.active).toBe(false)
    expect(svc.biller('12')).toBeUndefined()
  })

  it('rejects a negative, zero or fractional amountCents (400) before touching the ledger', async () => {
    const p = await payer(100)
    const events = (await txEvents(p.id)).length
    for (const amountCents of [-1, -2500, 0, 25.5, Number.NaN]) {
      expect(() => svc.post({ accountId: p.id, amountCents, billerCode: '55555', reference: '123456' }), String(amountCents)).toThrow(/^BAD_REQUEST: amountCents must be a positive integer/)
    }
    expect(await getAccount(p.id)).toMatchObject({ totalBalance: 100, availableBalance: 100 })
    expect((await txEvents(p.id)).length).toBe(events)
  })
})
