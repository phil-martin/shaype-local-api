import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { components } from '../src/contract/generated/b2b-types.js'
import { LOCAL_PRODUCT_ID } from '../src/domains/accounts/index.js'
import type { BuiltServer } from '../src/server.js'
import { startApp } from './helpers.js'
import { assertValidNotification } from './webhook-schema.js'

type S = components['schemas']
type HayAccount = S['HayAccount']
type HayCard = S['HayCard']

const UTILITY_OPS = [
  'changeCardExpiryDate', 'createStubForMandateSearchPaymentInstructions', 'generateAtmTransaction', 'generateAuthHold', 'generateCardTransaction',
  'generateHoldAndUpdateHoldTransactions', 'generateInboundDeTransaction', 'generateInboundNppTransaction', 'generateInboundNppTransactionV2',
  'generateMandateNotificationForInitiator', 'generateMandateNotificationForPayer', 'generateReceiveAPaymentInstruction', 'generateRefundTransaction',
]
const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MERCHANT = { merchantName: 'IGA (Mt Cotton)', merchantId: '000009493578577', merchantCategoryCode: '5411' }
const EXTERNAL_BSB = '302227'

/**
 * Field sets of the verbatim docs samples (docs/map/webhooks.md §5): the transactionEvent keys that carry a
 * value there. Every one of them must be present in what the generator emits.
 */
const SAMPLE_KEYS = {
  hold: ['transactionHayId', 'holdHayId', 'accountHayId', 'currencyAmount', 'updatedBalance', 'isPending', 'outcome', 'transactionTimeUtc', 'transactionType', 'cardUsageDetails', 'isAtmTransaction', 'accountBalances', 'cardHayId', 'customerHayId', 'counterpartName', 'merchantId'],
  refund: ['transactionHayId', 'accountHayId', 'currencyAmount', 'updatedBalance', 'isPending', 'counterpartName', 'outcome', 'transactionTimeUtc', 'isAtmTransaction', 'transactionType', 'cardUsageDetails', 'accountBalances', 'cardHayId', 'customerHayId', 'merchantId'],
  interbankIn: ['transactionHayId', 'accountHayId', 'currencyAmount', 'updatedBalance', 'isPending', 'counterpartName', 'outcome', 'transactionTimeUtc', 'isAtmTransaction', 'transactionType', 'accountBalances', 'counterpartDetails', 'category', 'description'],
  nppReturn: ['transactionHayId', 'accountHayId', 'currencyAmount', 'updatedBalance', 'isPending', 'outcome', 'transactionTimeUtc', 'transactionType', 'isAtmTransaction', 'accountBalances', 'counterpartDetails', 'counterpartName', 'category', 'description', 'returnReason'],
  directDebit: ['transactionHayId', 'accountHayId', 'currencyAmount', 'updatedBalance', 'isPending', 'counterpartName', 'outcome', 'transactionTimeUtc', 'isAtmTransaction', 'transactionType', 'accountBalances', 'customerHayId', 'counterpartDetails', 'category', 'description'],
} as const
/** Every key the full (null-listing) docs samples show, plus the spec-only reference / originalCurrencyAmount / externalIdentifiers. */
const EVENT_KEYS = new Set([
  'transactionHayId', 'holdHayId', 'accountHayId', 'currencyAmount', 'originalCurrencyAmount', 'updatedBalance', 'isPending', 'outcome', 'transactionTimeUtc',
  'cardPreferenceOutcome', 'cardProcessorResponse', 'transactionType', 'cardUsageDetails', 'isAtmTransaction', 'accountBalances', 'cardHayId', 'customerHayId',
  'ruleDetails', 'counterpartDetails', 'originId', 'originType', 'counterpartName', 'merchantName', 'category', 'merchantId', 'description', 'reference',
  'mandatePaymentDetails', 'returnReason', 'relatedHoldHayId', 'externalIdentifiers',
])

let built: BuiltServer
let app: BuiltServer['app']
beforeAll(async () => { built = await startApp(); app = built.app })
afterAll(async () => { await built.app.close() })
beforeEach(async () => {
  await flush()
  await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
})

let n = 0
let instructionSeq = 900_000_000_000

async function flush(): Promise<void> {
  const res = await app.inject({ method: 'POST', url: '/_admin/flush' })
  expect(res.statusCode, res.body).toBe(200)
}
async function clock(body: { set?: string; freeze?: string; advanceMs?: number; reset?: boolean }): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/_admin/clock', payload: body })
  expect(res.statusCode, res.body).toBe(200)
  return res.json().now as string
}
/** Freezes the app clock at its current instant; returns a function that lets it tick again from where it stands. */
async function freezeClock(): Promise<() => Promise<void>> {
  const now = (await app.inject({ method: 'GET', url: '/_admin/clock' })).json().now as string
  await clock({ freeze: now })
  return async () => {
    const at = (await app.inject({ method: 'GET', url: '/_admin/clock' })).json().now as string
    await clock({ set: at })
  }
}
async function post(url: string, payload?: unknown) {
  return app.inject({ method: 'POST', url, ...(payload === undefined ? {} : { payload: payload as object }) })
}
async function get(url: string) {
  return app.inject({ method: 'GET', url })
}
function expectError(res: { statusCode: number; json: () => any; body: string }, status: number, code: RegExp): void {
  expect(res.statusCode, res.body).toBe(status)
  const body = res.json()
  expect(body).toMatchObject({ status: String(status), details: expect.stringContaining('traceId') })
  expect(body.traceId).toMatch(UUID_RE)
  expect(body.message).toMatch(code)
}

async function newCustomer(): Promise<string> {
  n++
  const res = await post('/v0/customers/create', {
    idempotencyKey: randomUUID(), email: `util${n}@example.com`, customerTier: 'STANDARD',
    phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: `5${String(n).padStart(8, '0')}` },
    address: { line1: '1 Test St', townOrCity: 'Sydney', administrativeRegion: 'NSW', postcode: '2000', countryCodeIso: 'AUS' },
    customerDetails: { firstName: 'Util', lastName: `Holder${n}`, dateOfBirth: '1990-01-01' },
  })
  expect(res.statusCode, res.body).toBe(200)
  await flush()
  return res.json().customerHayId as string
}
async function account(id: string): Promise<HayAccount> {
  const res = await get(`/v0/accounts/${id}`)
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as HayAccount
}
async function newAccount(opts: { customer?: string; fund?: number } = {}): Promise<{ customer: string; account: HayAccount }> {
  const customer = opts.customer ?? (await newCustomer())
  const res = await post('/v1/accounts', { idempotencyKey: randomUUID(), accountHolderId: customer, accountHolderType: 'CUSTOMER', productId: LOCAL_PRODUCT_ID })
  expect(res.statusCode, res.body).toBe(200)
  const id = res.json().accountHayId as string
  const risk = await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/riskLevel`, payload: { level: 'LOW', reason: 'test' } })
  expect(risk.statusCode, risk.body).toBe(200)
  if (opts.fund) {
    const c = await post('/v1/transactions/credit', { idempotencyKey: randomUUID(), accountHayId: id, amount: opts.fund, counterpartName: 'Payroll', description: 'pay', transactionChannel: 'MANUAL_ADJUSTMENT' })
    expect(c.json().outcome, c.body).toBe('ACCEPTED')
  }
  await flush()
  return { customer, account: await account(id) }
}
/** A funded LOW-risk account with an ACTIVE virtual card (cleared notifications). */
async function setup(fund = 100): Promise<{ customer: string; account: HayAccount; card: HayCard }> {
  const { customer, account: a } = await newAccount({ fund })
  const res = await post('/v0/cards/create', {
    idempotencyKey: randomUUID(), accountId: a.accountHayId, customerHayId: customer, firstName: 'Mary', lastName: 'Smith', email: 'mary@example.com',
    phoneNumber: { countryCodePrefix: '61', numberAfterPrefix: '412345678' }, cardType: 'VIRTUAL', pin: '1234',
    deliveryAddress: { line1: '9 Fifth Ave', townOrCity: 'Adelaide', administrativeRegion: 'SA', postcode: '5012', countryCodeIso: 'AUS' },
  })
  expect(res.statusCode, res.body).toBe(200)
  const card = res.json() as HayCard
  expect(card.cardStatus).toBe('ACTIVE')
  await flush()
  await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
  return { customer, account: a, card }
}
async function balances(accountId: string): Promise<{ total: number; held: number; available: number }> {
  const a = await account(accountId)
  return { total: a.totalBalance!, held: a.heldBalance!, available: a.availableBalance! }
}
async function payloads(): Promise<any[]> {
  const res = await get('/_admin/notifications?limit=1000')
  const ps = (res.json() as { payload: any }[]).map((r) => r.payload)
  for (const p of ps) assertValidNotification(p)
  return ps
}
/** TRANSACTION envelopes of one account, emission order. */
async function txs(accountId: string): Promise<any[]> {
  await flush()
  return (await payloads()).filter((p) => p.type === 'TRANSACTION' && p.transactionEvent.accountHayId === accountId)
}
function expectFields(event: Record<string, unknown>, sample: keyof typeof SAMPLE_KEYS): void {
  for (const k of SAMPLE_KEYS[sample]) expect(event, `${sample} sample field ${k}`).toHaveProperty(k)
  for (const k of Object.keys(event)) expect(EVENT_KEYS.has(k), `unexpected transactionEvent field ${k}`).toBe(true)
}
function expectSnapshot(e: any, b: { total: number; held: number; available: number }): void {
  expect(e.accountBalances).toEqual({
    totalBalance: { currency: 'AUD', amount: b.total },
    heldBalance: { currency: 'AUD', amount: b.held },
    lockedBalance: { currency: 'AUD', amount: 0 },
    stacksBalance: { currency: 'AUD', amount: 0 },
    availableBalance: { currency: 'AUD', amount: b.available },
  })
  expect(e.updatedBalance).toEqual({ currency: 'AUD', amount: b.available })
}
async function setPreferences(cardId: string, prefs: Record<string, boolean>): Promise<void> {
  const res = await app.inject({ method: 'PATCH', url: `/v0/cards/${cardId}/payment-preferences`, payload: prefs })
  expect(res.statusCode, res.body).toBe(200)
}
async function setLimit(accountId: string, type: string, limitAmount: number): Promise<void> {
  const res = await app.inject({ method: 'PUT', url: `/v1/accounts/${accountId}/limits/${type}`, payload: { limitAmount } })
  expect(res.statusCode, res.body).toBe(200)
}
async function blockAccount(accountId: string): Promise<void> {
  const res = await post(`/v0/accounts/${accountId}/block`, { note: 'test', accountBlockStyle: 'ACCOUNT_ONLY' })
  expect(res.statusCode, res.body).toBe(200)
}
async function closeAccount(accountId: string): Promise<void> {
  const res = await post(`/v0/accounts/${accountId}/close`, { reason: 'CUSTOMER' })
  expect(res.statusCode, res.body).toBe(202)
  await flush()
  expect((await account(accountId)).status).toBe('CLOSED')
}
async function pendingHolds(accountId: string): Promise<any[]> {
  const res = await get(`/v0/accounts/${accountId}/holds`)
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
function nextInstructionId(): string {
  return `ANNCAU22XXXI2023071800${String(instructionSeq++).padStart(12, '0')}0`
}
const hex = (id: string): string => id.replace(/-/g, '')

describe('utilities: registration', () => {
  it('GET /_admin/operations lists all 13 Utilities API operations as handled, none stubbed', async () => {
    const res = await get('/_admin/operations')
    const { handled, stubbed } = res.json() as { handled: string[]; stubbed: string[] }
    for (const op of UTILITY_OPS) {
      expect(handled, op).toContain(op)
      expect(stubbed, op).not.toContain(op)
    }
  })
})

describe('generateAuthHold (POST /v0/utils/generate-auth-hold)', () => {
  it('holds the amount (held +a, available -a, total unchanged) and emits one pending CARD_TRANSACTION with transactionHayId == holdHayId', async () => {
    const { customer, account: a, card } = await setup(11.13)
    const res = await post('/v0/utils/generate-auth-hold', { amount: -8.4, cardToken: card.cardToken, merchantDetails: MERCHANT })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Mock card Hold generated.' })
    expect(await balances(a.accountHayId!)).toEqual({ total: 11.13, held: 8.4, available: 2.73 })

    const events = await txs(a.accountHayId!)
    expect(events).toHaveLength(1)
    const [p] = events
    expect(p).toMatchObject({ type: 'TRANSACTION', customerHayId: customer, actionOwner: 'PLATFORM', productId: LOCAL_PRODUCT_ID })
    const e = p.transactionEvent
    expectFields(e, 'hold')
    expect(e).toMatchObject({
      transactionType: 'CARD_TRANSACTION', isPending: true, outcome: 'ACCEPTED', isAtmTransaction: false,
      currencyAmount: { currency: 'AUD', amount: -8.4 }, cardHayId: card.cardHayId, customerHayId: customer,
      counterpartName: 'IGA (Mt Cotton)', merchantId: '000009493578577', category: '5411',
      cardUsageDetails: { isCardPresent: true, isContactless: false, isMagneticStripePayment: false, isMobileWalletPayment: false, isAtmWithdrawal: false },
    })
    expect(e.transactionHayId).toBe(e.holdHayId)
    expectSnapshot(e, { total: 11.13, held: 8.4, available: 2.73 })

    const holds = await pendingHolds(a.accountHayId!)
    expect(holds).toHaveLength(1)
    expect(holds[0]).toMatchObject({ holdHayId: e.holdHayId, cardId: card.cardHayId, transactionChannel: 'VISA_CARD_PRESENT', type: 'CARD_PRESENT_PAYMENT', currencyAmount: { amount: -8.4, currency: 'AUD' } })
  })

  it('resolves the card by cardId as well as by cardToken; an unknown card is 404', async () => {
    const { account: a, card } = await setup()
    expect((await post('/v0/utils/generate-auth-hold', { amount: -1, cardToken: card.cardHayId })).statusCode).toBe(200)
    expect(await balances(a.accountHayId!)).toEqual({ total: 100, held: 1, available: 99 })
    expectError(await post('/v0/utils/generate-auth-hold', { amount: -1, cardToken: '999999999' }), 404, /^NOT_FOUND: Card 999999999 not found/)
    expectError(await post('/v0/utils/generate-auth-hold', { amount: -1, cardToken: UNKNOWN_ID }), 404, /^NOT_FOUND: Card/)
  })

  it('validates the body: amount must be negative with <= 2 dp, PIN_BLOCKED is not a spec declineReason (400)', async () => {
    const { card } = await setup()
    expectError(await post('/v0/utils/generate-auth-hold', { amount: 0, cardToken: card.cardToken }), 400, /^BAD_REQUEST/)
    expectError(await post('/v0/utils/generate-auth-hold', { amount: 5, cardToken: card.cardToken }), 400, /^BAD_REQUEST/)
    expectError(await post('/v0/utils/generate-auth-hold', { amount: -1.234, cardToken: card.cardToken }), 400, /^BAD_REQUEST: amount/)
    expectError(await post('/v0/utils/generate-auth-hold', { amount: -1, cardToken: card.cardToken, declineReason: 'PIN_BLOCKED' }), 400, /^BAD_REQUEST/)
    expectError(await post('/v0/utils/generate-auth-hold', { amount: -1, cardToken: card.cardToken, cardUsage: 'ATM' }), 400, /^BAD_REQUEST/)
    expectError(await post('/v0/utils/generate-auth-hold', { amount: -1, cardToken: card.cardToken, merchantDetails: { merchantCategoryCode: '54' } }), 400, /^BAD_REQUEST/)
  })

  it('declineReason forces the processor decline (C17): 200, REFUSED_RULES + mapped cardProcessorResponse, nothing held', async () => {
    const { account: a, card } = await setup()
    const mapping: Record<string, string> = {
      CARD_EXPIRED: 'EXPIRED_CARD', WRONG_CVV: 'CVV_FAIL', CVV_BLOCKED: 'CVV2_FAILURE', INCORRECT_PIN: 'INCORRECT_PIN',
      ALLOWED_PIN_RETRIES_EXCEEDED: 'ALLOWED_PIN_RETRIES_EXCEEDED', INVALID_MERCHANT: 'INVALID_MERCHANT', CARD_IS_NOT_ACTIVE: 'CARD_IS_NOT_ACTIVE', RESTRICTED_CARD: 'RESTRICTED_CARD',
    }
    for (const declineReason of Object.keys(mapping)) {
      const res = await post('/v0/utils/generate-auth-hold', { amount: -3, cardToken: card.cardToken, declineReason, merchantDetails: MERCHANT })
      expect(res.statusCode, res.body).toBe(200)
    }
    expect(await balances(a.accountHayId!)).toEqual({ total: 100, held: 0, available: 100 })
    expect(await pendingHolds(a.accountHayId!)).toEqual([])
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => e.cardProcessorResponse)).toEqual(Object.values(mapping))
    for (const e of events) {
      expect(e).toMatchObject({ transactionType: 'CARD_TRANSACTION', isPending: false, outcome: 'REFUSED_RULES', cardPreferenceOutcome: 'OK', currencyAmount: { currency: 'AUD', amount: -3 }, cardHayId: card.cardHayId })
      expect(e.holdHayId).toBeUndefined()
      expectSnapshot(e, { total: 100, held: 0, available: 100 })
    }
  })

  it('declineReason side effects on the card: WRONG_CVV / INCORRECT_PIN spend a try, CVV_BLOCKED / ALLOWED_PIN_RETRIES_EXCEEDED block', async () => {
    const { card } = await setup()
    const hold = (declineReason: string) => post('/v0/utils/generate-auth-hold', { amount: -1, cardToken: card.cardToken, declineReason })
    await hold('WRONG_CVV')
    expect((await get(`/v0/cards/${card.cardHayId}/cvv/status`)).json()).toEqual({ cvvRemainingTries: 2 })
    await hold('CVV_BLOCKED')
    expect((await get(`/v0/cards/${card.cardHayId}/cvv/status`)).json()).toEqual({ cvvRemainingTries: 0 })
    await hold('INCORRECT_PIN')
    expect((await get(`/v0/cards/${card.cardHayId}/pin/status`)).json()).toEqual({ enabled: true })
    await hold('ALLOWED_PIN_RETRIES_EXCEEDED')
    expect((await get(`/v0/cards/${card.cardHayId}/pin/status`)).json()).toEqual({ enabled: false })
    // a chip payment now meets the blocked PIN at the card checks
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    await post('/v0/utils/generate-auth-hold', { amount: -1, cardToken: card.cardToken })
    const [p] = await txs(card.accountHayId!)
    expect(p.transactionEvent).toMatchObject({ outcome: 'REFUSED_RULES', cardProcessorResponse: 'ALLOWED_PIN_RETRIES_EXCEEDED' })
  })

  it('declineReason leaves the card alone when the account gate refuses first (the processor decline is never sent)', async () => {
    const { account: a, card } = await setup()
    await blockAccount(a.accountHayId!)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    for (const declineReason of ['WRONG_CVV', 'CVV_BLOCKED', 'INCORRECT_PIN', 'ALLOWED_PIN_RETRIES_EXCEEDED']) {
      expect((await post('/v0/utils/generate-auth-hold', { amount: -1, cardToken: card.cardToken, declineReason })).statusCode).toBe(200)
    }
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.outcome, e.cardProcessorResponse])).toEqual(Array(4).fill(['REFUSED_ACCOUNT_BLOCKED', undefined]))
    expect((await get(`/v0/cards/${card.cardHayId}/cvv/status`)).json()).toEqual({ cvvRemainingTries: 3 })
    expect((await get(`/v0/cards/${card.cardHayId}/pin/status`)).json()).toEqual({ enabled: true })
    expect(built.ctx.services.cards.get(card.cardHayId!).pinRemainingTries).toBe(3)
  })

  it('runs the card checks: cardUsage CONTACTLESS with the default preferences is REFUSED_CARD_PREFERENCE / CONTACTLESS_DISABLED', async () => {
    const { account: a, card } = await setup()
    expect((await post('/v0/utils/generate-auth-hold', { amount: -2, cardToken: card.cardToken, cardUsage: 'CONTACTLESS' })).statusCode).toBe(200)
    const [p] = await txs(a.accountHayId!)
    expect(p.transactionEvent).toMatchObject({ outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome: 'CONTACTLESS_DISABLED', isPending: false, cardUsageDetails: { isContactless: true, isCardPresent: true } })
    await setPreferences(card.cardHayId!, { contactlessEnabled: true, magneticStripeEnabled: true })
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    await post('/v0/utils/generate-auth-hold', { amount: -2, cardToken: card.cardToken, cardUsage: 'CONTACTLESS' })
    await post('/v0/utils/generate-auth-hold', { amount: -3, cardToken: card.cardToken, cardUsage: 'MAGNETIC_STRIPE' })
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.outcome, e.isPending])).toEqual([['ACCEPTED', true], ['ACCEPTED', true]])
    expect(events[1].cardUsageDetails).toMatchObject({ isMagneticStripePayment: true, isCardPresent: true })
    expect(await balances(a.accountHayId!)).toEqual({ total: 100, held: 5, available: 95 })
  })

  it('platform refusals: not enough funds, a blocked account and a blocked card each emit the refused CARD_TRANSACTION, nothing held', async () => {
    const { account: a, card } = await setup(5)
    await post('/v0/utils/generate-auth-hold', { amount: -8.4, cardToken: card.cardToken })
    const [funds] = await txs(a.accountHayId!)
    expect(funds.transactionEvent).toMatchObject({ outcome: 'REFUSED_NOT_ENOUGH_FUNDS', isPending: false, currencyAmount: { amount: -8.4 } })

    const blockedCard = await setup()
    expect((await post(`/v0/cards/${blockedCard.card.cardHayId}/block`, { note: 'lost' })).statusCode).toBe(200)
    await post('/v0/utils/generate-auth-hold', { amount: -1, cardToken: blockedCard.card.cardToken })
    const [b] = await txs(blockedCard.account.accountHayId!)
    expect(b.transactionEvent).toMatchObject({ outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome: 'CARD_BLOCKED', cardProcessorResponse: 'REFUSED_CARD_BLOCKED' })

    const locked = await setup()
    await blockAccount(locked.account.accountHayId!)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    expect((await post('/v0/utils/generate-auth-hold', { amount: -1, cardToken: locked.card.cardToken })).statusCode).toBe(200)
    const [l] = await txs(locked.account.accountHayId!)
    expect(l.transactionEvent).toMatchObject({ outcome: 'REFUSED_ACCOUNT_BLOCKED', isPending: false })
    expect(await balances(locked.account.accountHayId!)).toEqual({ total: 100, held: 0, available: 100 })
  })

  it('a card whose account is CLOSED: 200 and the refused TRANSACTION webhook with REFUSED_ACCOUNT_CLOSED (spec §5.2), for every card mock', async () => {
    const { account: a, card } = await setup(0)
    await closeAccount(a.accountHayId!)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    for (const url of ['/v0/utils/generate-auth-hold', '/v0/utils/generate-card-transaction', '/v0/utils/generate-refund-transaction', '/v0/utils/generate-atm-transaction']) {
      const res = await post(url, { amount: -1, cardToken: card.cardToken })
      expect(res.statusCode, `${url} ${res.body}`).toBe(200)
    }
    expect((await post('/v0/utils/generate-update-auth-hold', { amount: -1, updateHoldAmount: -1, cardToken: card.cardToken })).statusCode).toBe(200)
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.transactionType, e.outcome, e.isPending, e.currencyAmount.amount, e.isAtmTransaction])).toEqual([
      ['CARD_TRANSACTION', 'REFUSED_ACCOUNT_CLOSED', false, -1, false],
      ['CARD_TRANSACTION', 'REFUSED_ACCOUNT_CLOSED', false, -1, false],
      ['CARD_TRANSACTION_REFUND', 'REFUSED_ACCOUNT_CLOSED', false, 1, false],
      ['CARD_TRANSACTION', 'REFUSED_ACCOUNT_CLOSED', false, -1, true],
      ['CARD_TRANSACTION', 'REFUSED_ACCOUNT_CLOSED', false, -1, false],
    ])
    for (const e of events) expect(e.cardHayId).toBe(card.cardHayId)
    expect(await balances(a.accountHayId!)).toEqual({ total: 0, held: 0, available: 0 })
  })

  it('a CLOSED account of a customer who stays ACTIVE (another account open) is refused the same way', async () => {
    const { customer, account: a, card } = await setup(0)
    await newAccount({ customer })
    await closeAccount(a.accountHayId!)
    expect((await get(`/v0/customers/${customer}`)).json().status).toBe('ACTIVE')
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    expect((await post('/v0/utils/generate-auth-hold', { amount: -5, cardToken: card.cardToken })).statusCode).toBe(200)
    const [p] = await txs(a.accountHayId!)
    expect(p).toMatchObject({ customerHayId: customer, transactionEvent: { transactionType: 'CARD_TRANSACTION', outcome: 'REFUSED_ACCOUNT_CLOSED', isPending: false, currencyAmount: { amount: -5 } } })
  })

  it('a non-AUD currency carries originalCurrencyAmount and the _INTERNATIONAL channel (1:1, no FX rates locally)', async () => {
    const { account: a, card } = await setup()
    await post('/v0/utils/generate-auth-hold', { amount: -12.5, cardToken: card.cardToken, currency: 'USD' })
    const [p] = await txs(a.accountHayId!)
    expect(p.transactionEvent).toMatchObject({ currencyAmount: { currency: 'AUD', amount: -12.5 }, originalCurrencyAmount: { currency: 'USD', amount: -12.5 } })
    const [h] = await pendingHolds(a.accountHayId!)
    expect(h.transactionChannel).toBe('VISA_CARD_PRESENT_INTERNATIONAL')
    // AUD (explicit or null) is the account currency: no original amount
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    await post('/v0/utils/generate-auth-hold', { amount: -1, cardToken: card.cardToken, currency: null })
    const [q] = await txs(a.accountHayId!)
    expect(q.transactionEvent.originalCurrencyAmount).toBeUndefined()
  })

  it('a declined or refused non-AUD authorisation carries originalCurrencyAmount negative, like currencyAmount', async () => {
    const { account: a, card } = await setup(10)
    await post('/v0/utils/generate-auth-hold', { amount: -5, cardToken: card.cardToken, currency: 'USD', declineReason: 'RESTRICTED_CARD' })
    await post('/v0/utils/generate-auth-hold', { amount: -50, cardToken: card.cardToken, currency: 'EUR' })
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.outcome, e.currencyAmount, e.originalCurrencyAmount])).toEqual([
      ['REFUSED_RULES', { currency: 'AUD', amount: -5 }, { currency: 'USD', amount: -5 }],
      ['REFUSED_NOT_ENOUGH_FUNDS', { currency: 'AUD', amount: -50 }, { currency: 'EUR', amount: -50 }],
    ])
  })
})

describe('generateCardTransaction (POST /v0/utils/generate-card-transaction)', () => {
  it('a refused increment of a non-AUD hold carries originalCurrencyAmount (the increment at the hold\'s rate), like its hold and settlement', async () => {
    const { account: a, card } = await setup(30)
    const res = await post('/v0/utils/generate-update-auth-hold', { amount: -20, currency: 'USD', updateHoldAmount: -20, cardToken: card.cardToken, merchantDetails: MERCHANT })
    expect(res.statusCode, res.body).toBe(200)
    await flush()
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.transactionType, e.outcome, e.currencyAmount, e.originalCurrencyAmount])).toEqual([
      ['CARD_TRANSACTION', 'ACCEPTED', { currency: 'AUD', amount: -20 }, { currency: 'USD', amount: -20 }],
      ['CARD_TRANSACTION', 'REFUSED_NOT_ENOUGH_FUNDS', { currency: 'AUD', amount: -20 }, { currency: 'USD', amount: -20 }],
      ['CARD_TRANSACTION_SETTLED', 'ACCEPTED', { currency: 'AUD', amount: -20 }, { currency: 'USD', amount: -20 }],
    ])
  })

  it('hold, then settlement (asyncDelayMs when settlementDelayInSeconds is omitted): two TRANSACTION webhooks tied by holdHayId', async () => {
    const { customer, account: a, card } = await setup(11.13)
    const res = await post('/v0/utils/generate-card-transaction', { amount: -8.4, cardToken: card.cardToken, merchantDetails: MERCHANT })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Mock card Hold and Settlement generated.' })
    await flush()
    expect(await balances(a.accountHayId!)).toEqual({ total: 2.73, held: 0, available: 2.73 })

    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.transactionType, e.isPending])).toEqual([['CARD_TRANSACTION', true], ['CARD_TRANSACTION_SETTLED', false]])
    const [hold, settled] = events
    expectFields(hold, 'hold')
    expectFields(settled, 'hold')
    expectSnapshot(hold, { total: 11.13, held: 8.4, available: 2.73 })
    expectSnapshot(settled, { total: 2.73, held: 0, available: 2.73 })
    expect(settled.transactionHayId).not.toBe(hold.transactionHayId)
    expect(settled.holdHayId).toBe(hold.holdHayId)
    expect(settled).toMatchObject({ outcome: 'ACCEPTED', currencyAmount: { currency: 'AUD', amount: -8.4 }, counterpartName: 'IGA (Mt Cotton)', merchantId: '000009493578577', customerHayId: customer, cardHayId: card.cardHayId })

    const t = await get(`/v1/transactions/${settled.transactionHayId}`)
    expect(t.statusCode, t.body).toBe(200)
    expect(t.json()).toMatchObject({ relatedHoldHayId: hold.holdHayId, type: 'CARD_PRESENT_PAYMENT', transactionChannel: 'VISA_CARD_PRESENT', cardId: card.cardHayId, currencyAmount: { amount: -8.4 } })
    expect(await pendingHolds(a.accountHayId!)).toEqual([])
    expect((await get(`/v1/holds/${hold.holdHayId}`)).statusCode).toBe(200)
  })

  it('settles settlementDelayInSeconds later on the virtual clock', async () => {
    const { account: a, card } = await setup()
    const unfreeze = await freezeClock()
    try {
      expect((await post('/v0/utils/generate-card-transaction', { amount: -20, cardToken: card.cardToken, settlementDelayInSeconds: 30 })).statusCode).toBe(200)
      expect(await balances(a.accountHayId!)).toEqual({ total: 100, held: 20, available: 80 })
      await clock({ advanceMs: 29_000 })
      expect(await balances(a.accountHayId!)).toEqual({ total: 100, held: 20, available: 80 })
      expect((await payloads()).filter((p) => p.type === 'TRANSACTION')).toHaveLength(1)
      await clock({ advanceMs: 1_000 })
      expect(await balances(a.accountHayId!)).toEqual({ total: 80, held: 0, available: 80 })
      const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent.transactionType)
      expect(events).toEqual(['CARD_TRANSACTION', 'CARD_TRANSACTION_SETTLED'])
    } finally {
      await unfreeze()
    }
  })

  it('/_admin/flush with a settlement still minutes away answers at once and leaves it pending', async () => {
    const { account: a, card } = await setup()
    const unfreeze = await freezeClock()
    try {
      await post('/v0/utils/generate-card-transaction', { amount: -6, cardToken: card.cardToken, settlementDelayInSeconds: 120 })
      const res = await post('/_admin/flush')
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({ status: 'idle', deferred: 1 })
      expect(await balances(a.accountHayId!)).toEqual({ total: 100, held: 6, available: 94 })
      await clock({ advanceMs: 120_000 })
      expect(await balances(a.accountHayId!)).toEqual({ total: 94, held: 0, available: 94 })
    } finally {
      await unfreeze()
    }
  })

  it('a declined authorisation is never settled; the delay must be 5..300 seconds', async () => {
    const { account: a, card } = await setup()
    await post('/v0/utils/generate-card-transaction', { amount: -2, cardToken: card.cardToken, declineReason: 'RESTRICTED_CARD' })
    await flush()
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ transactionType: 'CARD_TRANSACTION', isPending: false, outcome: 'REFUSED_RULES', cardProcessorResponse: 'RESTRICTED_CARD' })
    expect(await balances(a.accountHayId!)).toEqual({ total: 100, held: 0, available: 100 })
    expectError(await post('/v0/utils/generate-card-transaction', { amount: -2, cardToken: card.cardToken, settlementDelayInSeconds: 4 }), 400, /^BAD_REQUEST/)
    expectError(await post('/v0/utils/generate-card-transaction', { amount: -2, cardToken: card.cardToken, settlementDelayInSeconds: 301 }), 400, /^BAD_REQUEST/)
  })

  it('counts toward the card limits: SINGLE_CARD_TRANSACTION refuses with its outcome', async () => {
    const { account: a, card } = await setup()
    await setLimit(a.accountHayId!, 'SINGLE_CARD_TRANSACTION', 10)
    await post('/v0/utils/generate-card-transaction', { amount: -10.01, cardToken: card.cardToken })
    await flush()
    const [p] = await txs(a.accountHayId!)
    expect(p.transactionEvent).toMatchObject({ outcome: 'REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED', isPending: false })
  })
})

describe('generateHoldAndUpdateHoldTransactions (POST /v0/utils/generate-update-auth-hold)', () => {
  it('increase (negative updateHoldAmount): hold, CARD_TRANSACTION with the cumulative amount (same id), settlement of the updated hold', async () => {
    const { account: a, card } = await setup(232.64)
    const unfreeze = await freezeClock()
    try {
      const res = await post('/v0/utils/generate-update-auth-hold', { amount: -9, updateHoldAmount: -10, cardToken: card.cardToken, merchantDetails: MERCHANT, updateHoldDelayInSeconds: 10, settlementDelayInSeconds: 20 })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({ message: 'Mock card Hold and Hold Update generated.' })
      expect(await balances(a.accountHayId!)).toEqual({ total: 232.64, held: 9, available: 223.64 })
      await clock({ advanceMs: 10_000 })
      expect(await balances(a.accountHayId!)).toEqual({ total: 232.64, held: 19, available: 213.64 })
      await clock({ advanceMs: 19_000 })
      expect(await balances(a.accountHayId!)).toEqual({ total: 232.64, held: 19, available: 213.64 })
      await clock({ advanceMs: 1_000 })
      expect(await balances(a.accountHayId!)).toEqual({ total: 213.64, held: 0, available: 213.64 })
    } finally {
      await unfreeze()
    }
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.transactionType, e.isPending, e.currencyAmount.amount])).toEqual([
      ['CARD_TRANSACTION', true, -9], ['CARD_TRANSACTION', true, -19], ['CARD_TRANSACTION_SETTLED', false, -19],
    ])
    for (const e of events) expectFields(e, 'hold')
    expect(events[1].transactionHayId).toBe(events[0].transactionHayId)
    expect(events[2].holdHayId).toBe(events[0].holdHayId)
    expect(events[2].transactionHayId).not.toBe(events[0].transactionHayId)
    expectSnapshot(events[1], { total: 232.64, held: 19, available: 213.64 })
  })

  it('decrease (positive updateHoldAmount): CARD_TRANSACTION_REFUND pending with the released amount, then the reduced settlement', async () => {
    const { account: a, card } = await setup(10.87)
    await post('/v0/utils/generate-update-auth-hold', { amount: -5, updateHoldAmount: 0.5, cardToken: card.cardToken, merchantDetails: MERCHANT })
    await flush()
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.transactionType, e.isPending, e.currencyAmount.amount])).toEqual([
      ['CARD_TRANSACTION', true, -5], ['CARD_TRANSACTION_REFUND', true, 0.5], ['CARD_TRANSACTION_SETTLED', false, -4.5],
    ])
    for (const e of events) expectFields(e, 'hold')
    expect(events[1].transactionHayId).toBe(events[0].holdHayId)
    expectSnapshot(events[1], { total: 10.87, held: 4.5, available: 6.37 })
    expect(await balances(a.accountHayId!)).toEqual({ total: 6.37, held: 0, available: 6.37 })
  })

  it('a decrease by the whole amount is a full reversal: no settlement follows', async () => {
    const { account: a, card } = await setup()
    await post('/v0/utils/generate-update-auth-hold', { amount: -5, updateHoldAmount: 5, cardToken: card.cardToken })
    await flush()
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.transactionType, e.isPending, e.currencyAmount.amount])).toEqual([['CARD_TRANSACTION', true, -5], ['CARD_TRANSACTION_REFUND', true, 5]])
    expect(await balances(a.accountHayId!)).toEqual({ total: 100, held: 0, available: 100 })
    expect(await pendingHolds(a.accountHayId!)).toEqual([])
  })

  it('an increase the account cannot fund is refused (hold unchanged) and the original hold still settles', async () => {
    const { account: a, card } = await setup(10)
    await post('/v0/utils/generate-update-auth-hold', { amount: -8, updateHoldAmount: -5, cardToken: card.cardToken })
    await flush()
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.transactionType, e.isPending, e.outcome, e.currencyAmount.amount])).toEqual([
      ['CARD_TRANSACTION', true, 'ACCEPTED', -8], ['CARD_TRANSACTION', false, 'REFUSED_NOT_ENOUGH_FUNDS', -5], ['CARD_TRANSACTION_SETTLED', false, 'ACCEPTED', -8],
    ])
    expect(events[1].holdHayId).toBe(events[0].holdHayId)
    expect(await balances(a.accountHayId!)).toEqual({ total: 2, held: 0, available: 2 })
  })

  it('an increase re-runs the card checks: a card blocked meanwhile refuses the increment', async () => {
    const { account: a, card } = await setup()
    const unfreeze = await freezeClock()
    try {
      await post('/v0/utils/generate-update-auth-hold', { amount: -4, updateHoldAmount: -1, cardToken: card.cardToken, updateHoldDelayInSeconds: 5, settlementDelayInSeconds: 5 })
      expect((await post(`/v0/cards/${card.cardHayId}/block`, { note: 'lost' })).statusCode).toBe(200)
      await clock({ advanceMs: 10_000 })
    } finally {
      await unfreeze()
    }
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.transactionType, e.outcome, e.currencyAmount.amount])).toEqual([
      ['CARD_TRANSACTION', 'ACCEPTED', -4], ['CARD_TRANSACTION', 'REFUSED_CARD_PREFERENCE', -1], ['CARD_TRANSACTION_SETTLED', 'ACCEPTED', -4],
    ])
    expect(await balances(a.accountHayId!)).toEqual({ total: 96, held: 0, available: 96 })
  })

  it('a non-AUD hold keeps originalCurrencyAmount in step with the update (1:1) through to the settlement', async () => {
    const { account: a, card } = await setup()
    await post('/v0/utils/generate-update-auth-hold', { amount: -5, updateHoldAmount: -3, cardToken: card.cardToken, currency: 'USD' })
    await flush()
    const up = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(up.map((e) => [e.transactionType, e.currencyAmount.amount, e.originalCurrencyAmount])).toEqual([
      ['CARD_TRANSACTION', -5, { currency: 'USD', amount: -5 }], ['CARD_TRANSACTION', -8, { currency: 'USD', amount: -8 }], ['CARD_TRANSACTION_SETTLED', -8, { currency: 'USD', amount: -8 }],
    ])
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    await post('/v0/utils/generate-update-auth-hold', { amount: -5, updateHoldAmount: 2, cardToken: card.cardToken, currency: 'USD' })
    await flush()
    const down = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(down.map((e) => [e.transactionType, e.currencyAmount.amount, e.originalCurrencyAmount?.amount])).toEqual([
      ['CARD_TRANSACTION', -5, -5], ['CARD_TRANSACTION_REFUND', 2, undefined], ['CARD_TRANSACTION_SETTLED', -3, -3],
    ])
    const settled = (await get(`/v1/transactions/${down[2].transactionHayId}`)).json()
    expect(settled).toMatchObject({ transactionChannel: 'VISA_CARD_PRESENT_INTERNATIONAL', currencyAmount: { amount: -3, currency: 'AUD' }, originalCurrencyAmount: { amount: -3, currency: 'USD' } })
    expect(await balances(a.accountHayId!)).toEqual({ total: 89, held: 0, available: 89 })
  })

  it('validates updateHoldAmount (non-zero, a decrease no larger than the hold) and the delays', async () => {
    const { card } = await setup()
    expectError(await post('/v0/utils/generate-update-auth-hold', { amount: -5, updateHoldAmount: 0, cardToken: card.cardToken }), 400, /^BAD_REQUEST: updateHoldAmount/)
    expectError(await post('/v0/utils/generate-update-auth-hold', { amount: -5, updateHoldAmount: 5.01, cardToken: card.cardToken }), 400, /^BAD_REQUEST: updateHoldAmount/)
    expectError(await post('/v0/utils/generate-update-auth-hold', { amount: -5, updateHoldAmount: 1.001, cardToken: card.cardToken }), 400, /^BAD_REQUEST: updateHoldAmount/)
    expectError(await post('/v0/utils/generate-update-auth-hold', { amount: -5, cardToken: card.cardToken }), 400, /^BAD_REQUEST/)
    expectError(await post('/v0/utils/generate-update-auth-hold', { amount: -5, updateHoldAmount: -1, cardToken: card.cardToken, updateHoldDelayInSeconds: 301 }), 400, /^BAD_REQUEST/)
    expect(await pendingHolds(card.accountHayId!)).toEqual([])
  })
})

describe('generateRefundTransaction (POST /v0/utils/generate-refund-transaction)', () => {
  it('credits abs(amount) as a settled CARD_TRANSACTION_REFUND with its own id and no hold link', async () => {
    const { customer, account: a, card } = await setup(3300)
    const res = await post('/v0/utils/generate-refund-transaction', { amount: -5.99, cardToken: card.cardToken, merchantDetails: { merchantName: "IGA (Piedimonte's Fitzroy North)", merchantId: '000009391315129' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Mock refund card transaction generated.' })
    expect(await balances(a.accountHayId!)).toEqual({ total: 3305.99, held: 0, available: 3305.99 })
    const [p] = await txs(a.accountHayId!)
    expect(p).toMatchObject({ customerHayId: customer, actionOwner: 'PLATFORM' })
    const e = p.transactionEvent
    expectFields(e, 'refund')
    expect(e).toMatchObject({
      transactionType: 'CARD_TRANSACTION_REFUND', isPending: false, outcome: 'ACCEPTED', isAtmTransaction: false, currencyAmount: { currency: 'AUD', amount: 5.99 },
      counterpartName: "IGA (Piedimonte's Fitzroy North)", merchantId: '000009391315129', cardHayId: card.cardHayId,
      cardUsageDetails: { isCardPresent: false, isMobileWalletPayment: false, isAtmWithdrawal: false },
    })
    expect(e.holdHayId).toBeUndefined()
    expectSnapshot(e, { total: 3305.99, held: 0, available: 3305.99 })
    const t = (await get(`/v1/transactions/${e.transactionHayId}`)).json()
    expect(t).toMatchObject({ type: 'CARD_PAYMENT_REVERSAL', transactionChannel: 'VISA_REFUND_DOMESTIC', currencyAmount: { amount: 5.99 }, cardId: card.cardHayId })
    expect(t.relatedHoldHayId).toBeUndefined()
  })

  it('a refund is a credit, not a spend: a frozen card still gets it; MAX_BALANCE refuses it; amount >= 0 is 400', async () => {
    const { account: a, card } = await setup(10)
    await setPreferences(card.cardHayId!, { cardEnabled: false })
    await post('/v0/utils/generate-refund-transaction', { amount: -1, cardToken: card.cardToken })
    await setLimit(a.accountHayId!, 'MAX_BALANCE', 11)
    await post('/v0/utils/generate-refund-transaction', { amount: -1, cardToken: card.cardToken })
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.outcome, e.currencyAmount.amount])).toEqual([['ACCEPTED', 1], ['REFUSED_MAX_BALANCE_EXCEEDED', 1]])
    expect(await balances(a.accountHayId!)).toEqual({ total: 11, held: 0, available: 11 })
    expectError(await post('/v0/utils/generate-refund-transaction', { amount: 1, cardToken: card.cardToken }), 400, /^BAD_REQUEST/)
  })
})

describe('generateAtmTransaction (POST /v0/utils/generate-atm-transaction)', () => {
  it('the default preferences refuse cash (REFUSED_CARD_PREFERENCE / CASH_WITHDRAWAL_DISABLED); enabled, one settled CARD_TRANSACTION with isAtmTransaction', async () => {
    const { customer, account: a, card } = await setup()
    expect((await post('/v0/utils/generate-atm-transaction', { amount: -40, cardToken: card.cardToken })).statusCode).toBe(200)
    const [refused] = await txs(a.accountHayId!)
    expect(refused.transactionEvent).toMatchObject({ transactionType: 'CARD_TRANSACTION', isPending: false, isAtmTransaction: true, outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome: 'CASH_WITHDRAWAL_DISABLED', cardUsageDetails: { isAtmWithdrawal: true } })
    expect(await balances(a.accountHayId!)).toEqual({ total: 100, held: 0, available: 100 })

    await setPreferences(card.cardHayId!, { cashWithdrawalEnabled: true })
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    const res = await post('/v0/utils/generate-atm-transaction', { amount: -40, cardToken: card.cardToken, merchantDetails: { merchantName: 'ATM Sydney CBD', merchantId: 'ATM0001', merchantCategoryCode: '6011' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Mock ATM card transaction generated.' })
    expect(await balances(a.accountHayId!)).toEqual({ total: 60, held: 0, available: 60 })
    const events = await txs(a.accountHayId!)
    expect(events).toHaveLength(1)
    const e = events[0].transactionEvent
    expect(events[0]).toMatchObject({ customerHayId: customer, actionOwner: 'PLATFORM' })
    expectFields(e, 'refund')
    expect(e).toMatchObject({
      transactionType: 'CARD_TRANSACTION', isPending: false, isAtmTransaction: true, outcome: 'ACCEPTED', currencyAmount: { currency: 'AUD', amount: -40 },
      cardUsageDetails: { isAtmWithdrawal: true, isCardPresent: true }, counterpartName: 'ATM Sydney CBD', merchantId: 'ATM0001', cardHayId: card.cardHayId,
    })
    expect(e.holdHayId).toBeUndefined()
    expectSnapshot(e, { total: 60, held: 0, available: 60 })
    expect((await get(`/v1/transactions/${e.transactionHayId}`)).json()).toMatchObject({ type: 'ATM_WITHDRAWAL', transactionChannel: 'VISA_ATM', currencyAmount: { amount: -40 } })
    expect(await pendingHolds(a.accountHayId!)).toEqual([])
  })

  it('non-AUD card mocks: hold + settlement, refund and ATM carry originalCurrencyAmount (signed like currencyAmount) and the _INTERNATIONAL channel', async () => {
    const { account: a, card } = await setup()
    await setPreferences(card.cardHayId!, { cashWithdrawalEnabled: true })
    await post('/v0/utils/generate-card-transaction', { amount: -7, cardToken: card.cardToken, currency: 'USD' })
    await flush()
    await post('/v0/utils/generate-refund-transaction', { amount: -2, cardToken: card.cardToken, currency: 'NZD' })
    await post('/v0/utils/generate-atm-transaction', { amount: -20, cardToken: card.cardToken, currency: 'GBP' })
    await setPreferences(card.cardHayId!, { cashWithdrawalEnabled: false })
    await post('/v0/utils/generate-atm-transaction', { amount: -3, cardToken: card.cardToken, currency: 'GBP' })
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.transactionType, e.outcome, e.currencyAmount.amount, e.originalCurrencyAmount])).toEqual([
      ['CARD_TRANSACTION', 'ACCEPTED', -7, { currency: 'USD', amount: -7 }],
      ['CARD_TRANSACTION_SETTLED', 'ACCEPTED', -7, { currency: 'USD', amount: -7 }],
      ['CARD_TRANSACTION_REFUND', 'ACCEPTED', 2, { currency: 'NZD', amount: 2 }],
      ['CARD_TRANSACTION', 'ACCEPTED', -20, { currency: 'GBP', amount: -20 }],
      ['CARD_TRANSACTION', 'REFUSED_CARD_PREFERENCE', -3, { currency: 'GBP', amount: -3 }],
    ])
    const channels = await Promise.all([events[1], events[2], events[3]].map(async (e) => (await get(`/v1/transactions/${e.transactionHayId}`)).json().transactionChannel))
    expect(channels).toEqual(['VISA_CARD_PRESENT_INTERNATIONAL', 'VISA_REFUND_INTERNATIONAL', 'VISA_ATM_INTERNATIONAL'])
    expect(await balances(a.accountHayId!)).toEqual({ total: 75, held: 0, available: 75 })
  })

  it('checks the ATM limit, account rules and funds, each refusal with its outcome', async () => {
    const { account: a, card } = await setup()
    await setPreferences(card.cardHayId!, { cashWithdrawalEnabled: true })
    await setLimit(a.accountHayId!, 'ATM_WITHDRAWAL_PER_DAY', 50)
    await post('/v0/utils/generate-atm-transaction', { amount: -30, cardToken: card.cardToken })
    await post('/v0/utils/generate-atm-transaction', { amount: -30, cardToken: card.cardToken })
    const rule = await post(`/v1/accounts/${a.accountHayId}/rules`, { name: 'no casino', ruleType: 'MERCHANT_NAME_BLOCK', ruleDetails: { blockedMerchantName: 'Casino', merchantNameMatchingOperator: 'STARTS_WITH' } })
    expect(rule.statusCode, rule.body).toBe(200)
    await post('/v0/utils/generate-atm-transaction', { amount: -1, cardToken: card.cardToken, merchantDetails: { merchantName: 'Casino ATM' } })
    await post('/v0/utils/generate-atm-transaction', { amount: -80, cardToken: card.cardToken })
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => e.outcome)).toEqual(['ACCEPTED', 'REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED', 'REFUSED_RULES', 'REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED'])
    expect(events[2].ruleDetails).toEqual({ ruleId: rule.json().id })
    await setLimit(a.accountHayId!, 'ATM_WITHDRAWAL_PER_DAY', 5000)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    await post('/v0/utils/generate-atm-transaction', { amount: -80, cardToken: card.cardToken })
    const [funds] = await txs(a.accountHayId!)
    expect(funds.transactionEvent).toMatchObject({ outcome: 'REFUSED_NOT_ENOUGH_FUNDS', isAtmTransaction: true })
    expect(await balances(a.accountHayId!)).toEqual({ total: 70, held: 0, available: 70 })
  })
})

describe('generateInboundNppTransaction (POST /v0/utils/generate-npp-inbound)', () => {
  function nppBody(a: HayAccount, overrides: Record<string, unknown> = {}) {
    return {
      idempotencyKey: randomUUID(), amount: 200, description: 'withdrawal', reference: 'INV-42',
      receiverBsb: a.bsb, receiverAccountNumber: a.accountNumber, receiverName: 'Local Customer',
      senderBsb: EXTERNAL_BSB, senderAccountNumber: '112836327', senderName: 'Andy', ...overrides,
    }
  }

  it('credits the receiver and emits INTERBANK_TRANSFER_IN with the sender as counterpart', async () => {
    const { customer, account: a } = await newAccount({ fund: 10 })
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    const res = await post('/v0/utils/generate-npp-inbound', nppBody(a))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Inbound NPP transaction generated.' })
    expect(await balances(a.accountHayId!)).toEqual({ total: 210, held: 0, available: 210 })
    const [p] = await txs(a.accountHayId!)
    expect(p).toMatchObject({ customerHayId: customer, actionOwner: 'PLATFORM' })
    const e = p.transactionEvent
    expectFields(e, 'interbankIn')
    expect(e).toMatchObject({
      transactionType: 'INTERBANK_TRANSFER_IN', isPending: false, outcome: 'ACCEPTED', currencyAmount: { currency: 'AUD', amount: 200 }, counterpartName: 'Andy',
      counterpartDetails: { name: 'Andy', basicAccountNumber: { accountNumber: '112836327', branchNumber: EXTERNAL_BSB } }, category: 'BANK_TRANSFER', description: 'withdrawal', reference: 'INV-42',
    })
    expectSnapshot(e, { total: 210, held: 0, available: 210 })
    expect((await get(`/v1/transactions/${e.transactionHayId}`)).json()).toMatchObject({ type: 'INTERBANK_TRANSFER_IN', transactionChannel: 'CUSCAL_NPP_TRANSFER_IN', reference: 'INV-42' })
  })

  it('idempotencyKey: a replay posts nothing twice; the same key with another body is 422', async () => {
    const { account: a } = await newAccount()
    const body = nppBody(a, { amount: 5 })
    expect((await post('/v0/utils/generate-npp-inbound', body)).statusCode).toBe(200)
    const replay = await post('/v0/utils/generate-npp-inbound', body)
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toEqual({ message: 'Inbound NPP transaction generated.' })
    expect(await balances(a.accountHayId!)).toEqual({ total: 5, held: 0, available: 5 })
    expect(await txs(a.accountHayId!)).toHaveLength(1)
    expectError(await post('/v0/utils/generate-npp-inbound', { ...body, amount: 6 }), 422, /^IDEMPOTENCY_KEY_REUSED/)
  })

  it('an unknown or non-local receiver is 404; the unanchored spec patterns are full-matched (400)', async () => {
    const { account: a } = await newAccount()
    expectError(await post('/v0/utils/generate-npp-inbound', nppBody(a, { receiverAccountNumber: '99999999' })), 404, /^NOT_FOUND: /)
    expectError(await post('/v0/utils/generate-npp-inbound', nppBody(a, { receiverBsb: '062000' })), 404, /^NOT_FOUND: /)
    expectError(await post('/v0/utils/generate-npp-inbound', nppBody(a, { receiverAccountNumber: `${a.accountNumber}9` })), 400, /^BAD_REQUEST: receiverAccountNumber/)
    expectError(await post('/v0/utils/generate-npp-inbound', nppBody(a, { senderBsb: '3022271' })), 400, /^BAD_REQUEST: senderBsb/)
    expectError(await post('/v0/utils/generate-npp-inbound', nppBody(a, { amount: 0 })), 400, /^BAD_REQUEST/)
    expectError(await post('/v0/utils/generate-npp-inbound', nppBody(a, { amount: 1.005 })), 400, /^BAD_REQUEST: amount/)
  })

  it('a CLOSED receiver refuses the credit (spec §5.2): 200 with the refused INTERBANK_TRANSFER_IN, REFUSED_ACCOUNT_CLOSED', async () => {
    const { account: a } = await newAccount()
    await closeAccount(a.accountHayId!)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    expect((await post('/v0/utils/generate-npp-inbound', nppBody(a, { amount: 7 }))).statusCode).toBe(200)
    const [p] = await txs(a.accountHayId!)
    expect(p.transactionEvent).toMatchObject({ transactionType: 'INTERBANK_TRANSFER_IN', outcome: 'REFUSED_ACCOUNT_CLOSED', isPending: false, currencyAmount: { amount: 7 }, counterpartName: 'Andy' })
    expect(await balances(a.accountHayId!)).toEqual({ total: 0, held: 0, available: 0 })
  })

  it('a LOCKED receiver or a breached limit refuses the credit: 200 with the refused TRANSACTION webhook, balances unchanged', async () => {
    const { account: a } = await newAccount()
    await setLimit(a.accountHayId!, 'MAX_BALANCE', 100)
    await post('/v0/utils/generate-npp-inbound', nppBody(a, { amount: 100.01 }))
    await blockAccount(a.accountHayId!)
    expect((await post('/v0/utils/generate-npp-inbound', nppBody(a, { amount: 1 }))).statusCode).toBe(200)
    const events = (await txs(a.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.transactionType, e.outcome, e.isPending])).toEqual([
      ['INTERBANK_TRANSFER_IN', 'REFUSED_MAX_BALANCE_EXCEEDED', false], ['INTERBANK_TRANSFER_IN', 'REFUSED_ACCOUNT_BLOCKED', false],
    ])
    expect(await balances(a.accountHayId!)).toEqual({ total: 0, held: 0, available: 0 })
  })
})

describe('generateInboundNppTransactionV2 (POST /v0/utils/generate-inbound-npp-transaction-v2)', () => {
  function rapBody(creditor: HayAccount, overrides: Record<string, unknown> = {}) {
    return {
      creditorInformation: { accountIdentification: `${creditor.bsb}${creditor.accountNumber}`, accountIdentificationTypeCode: 'BBAN', ultimatePartyName: 'JOE BLOGGS' },
      debtorInformation: { accountIdentification: '63610079412687', accountIdentificationTypeCode: 'BBAN', partyName: 'JOHN MAXIMILLIAN DOE' },
      initgPtyIdOrgId: 'NPBOAU21XXX',
      paymentId: 'ANNCAU22XXX20230718000000000077240',
      paymentInformation: {
        categoryPurposeCode: 'SALA', endToEndIdentification: 'NET-1724', instructedAmount: '2', originalMessageIdentification: 'ANNCAU22XXX20230718000000000077240',
        remittanceInformationUnstructured: 'This is a payment for invoice number 123456.', transactionIdentification: 'ANNCAU22XXXN20230718000000000077240',
      },
      ...overrides,
    }
  }

  it('Receive A Payment: credits the creditor account (INTERBANK_TRANSFER_IN, debtor as counterpart)', async () => {
    const { customer, account: a } = await newAccount()
    const res = await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(a))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Receive A Payment generated.' })
    expect(await balances(a.accountHayId!)).toEqual({ total: 2, held: 0, available: 2 })
    const [p] = await txs(a.accountHayId!)
    expect(p).toMatchObject({ customerHayId: customer, actionOwner: 'PLATFORM' })
    expectFields(p.transactionEvent, 'interbankIn')
    expect(p.transactionEvent).toMatchObject({
      transactionType: 'INTERBANK_TRANSFER_IN', currencyAmount: { amount: 2 }, counterpartName: 'JOHN MAXIMILLIAN DOE', category: 'BANK_TRANSFER',
      counterpartDetails: { name: 'JOHN MAXIMILLIAN DOE', basicAccountNumber: { branchNumber: '636100', accountNumber: '79412687' } },
      description: 'This is a payment for invoice number 123456.', reference: 'NET-1724',
    })
    expect(p.transactionEvent.mandatePaymentDetails).toBeUndefined()
  })

  it('a mandate payment (PayTo creditor leg) carries mandatePaymentDetails and originType MANDATE_PAYMENT; no MANDATE_PAYMENT webhook', async () => {
    const { account: creditor } = await newAccount()
    const { account: debtor } = await newAccount({ fund: 50 })
    const mandateId = await createMandate(creditor, debtor, true)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    const instructionId = nextInstructionId()
    const res = await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(creditor, {
      mandateInformation: { initiatingPartyName: 'ACME Utilities', instructionIdentification: instructionId, mandateIdentification: hex(mandateId) },
    }))
    expect(res.statusCode, res.body).toBe(200)
    const [p] = await txs(creditor.accountHayId!)
    expect(p.transactionEvent).toMatchObject({
      transactionType: 'INTERBANK_TRANSFER_IN', currencyAmount: { amount: 2 }, originType: 'MANDATE_PAYMENT', originId: mandateId,
      mandatePaymentDetails: { mandateId, instructionId, initiatingPartyName: 'ACME Utilities' },
    })
    expect((await payloads()).filter((q) => q.type === 'MANDATE_PAYMENT')).toEqual([])
    // unknown mandate: 404; a mandate payment must name its instruction
    expectError(await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(creditor, { mandateInformation: { initiatingPartyName: 'X', instructionIdentification: instructionId, mandateIdentification: '1212c23a255c11ee9a8e5d3239591cd9' } })), 404, /^NOT_FOUND: Mandate/)
    expectError(await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(creditor, { mandateInformation: { mandateIdentification: hex(mandateId) } })), 400, /^BAD_REQUEST: mandateInformation/)
  })

  it('a mandate payment must credit the mandate creditor account of an ACTIVE mandate (422 otherwise, nothing credited)', async () => {
    const { account: creditor } = await newAccount()
    const { account: other } = await newAccount()
    const { account: debtor } = await newAccount()
    const created = await createMandate(creditor, debtor)
    const active = await createMandate(creditor, debtor, true)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    const mi = (mandateId: string) => ({ mandateInformation: { initiatingPartyName: 'ACME Utilities', instructionIdentification: nextInstructionId(), mandateIdentification: hex(mandateId) } })
    expectError(await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(other, mi(active))), 422, /^INVALID_ARGUMENT: .*not the creditor account of mandate/)
    expectError(await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(creditor, mi(created))), 422, /^INVALID_STATE: .*CREATED/)
    expect(await balances(creditor.accountHayId!)).toEqual({ total: 0, held: 0, available: 0 })
    expect(await balances(other.accountHayId!)).toEqual({ total: 0, held: 0, available: 0 })
    expect(await payloads()).toEqual([])
    expect((await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(creditor, mi(active)))).statusCode).toBe(200)
    expect(await balances(creditor.accountHayId!)).toEqual({ total: 2, held: 0, available: 2 })
  })

  it('a mandate payment for an instruction the platform settled with both local legs is a no-op; for a REJECTED one 422 (never credited twice / from nowhere)', async () => {
    const { account: creditor } = await newAccount()
    const { account: debtor } = await newAccount({ fund: 100 })
    const mandateId = await createMandate(creditor, debtor, true)
    const adhoc = async (amount: number) => {
      const res = await post('/v1/payto/payments/adhoc', { idempotencyKey: randomUUID(), mandateId, amount: { currency: 'AUD', amount } })
      expect(res.statusCode, res.body).toBe(200)
      return res.json() as { instructionId: string; transactionStatus: string }
    }
    const rap = (instructionId: string, amount: string) => {
      const body = rapBody(creditor, { mandateInformation: { initiatingPartyName: 'ACME Utilities', instructionIdentification: instructionId, mandateIdentification: hex(mandateId) } })
      body.paymentInformation.instructedAmount = amount
      return post('/v0/utils/generate-inbound-npp-transaction-v2', body)
    }
    const settled = await adhoc(10)
    expect(settled.transactionStatus).toBe('ACCEPTED_AND_SETTLED')
    await payByRapain(mandateId, settled.instructionId, '10')
    await flush()
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    expect((await rap(settled.instructionId, '10')).statusCode).toBe(200)
    expect(await balances(creditor.accountHayId!)).toEqual({ total: 10, held: 0, available: 10 })
    expect(await balances(debtor.accountHayId!)).toEqual({ total: 90, held: 0, available: 90 })
    expect(await txs(creditor.accountHayId!)).toEqual([])

    const rejected = await adhoc(500)
    expect(rejected.transactionStatus).toBe('REJECTED')
    expectError(await rap(rejected.instructionId, '500'), 422, /^INVALID_STATE: Payment instruction .* is REJECTED/)
    expect(await balances(creditor.accountHayId!)).toEqual({ total: 10, held: 0, available: 10 })
    expect(await txs(creditor.accountHayId!)).toEqual([])
  })

  it('a mandate payment after a RAPAIN (debtor leg only) posts the creditor leg once; an unknown instruction id is an external payment', async () => {
    const { account: creditor } = await newAccount()
    const { account: debtor } = await newAccount({ fund: 50 })
    const mandateId = await createMandate(creditor, debtor, true)
    const instructionId = nextInstructionId()
    await payByRapain(mandateId, instructionId, '2')
    const mi = (id: string) => ({ mandateInformation: { initiatingPartyName: 'ACME Utilities', instructionIdentification: id, mandateIdentification: hex(mandateId) } })
    expect((await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(creditor, mi(instructionId)))).statusCode).toBe(200)
    expect((await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(creditor, mi(instructionId)))).statusCode).toBe(200)
    expect(await balances(creditor.accountHayId!)).toEqual({ total: 2, held: 0, available: 2 })
    expect((await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(creditor, mi(nextInstructionId())))).statusCode).toBe(200)
    expect(await balances(creditor.accountHayId!)).toEqual({ total: 4, held: 0, available: 4 })
  })

  it('a payment return (returnReasonCode) credits back the matched outbound NPP payment as INTERBANK_TRANSFER_OUT with returnReason', async () => {
    const { customer, account: a } = await newAccount({ fund: 480 })
    const transfer = await post(`/v1/accounts/${a.accountHayId}/transfer`, {
      idempotencyKey: randomUUID(), senderCustomerHayId: customer, amount: 212.38, description: 'Romar', transferType: 'ACCOUNT',
      accountTransfer: { bsb: '111985', accountNumber: '123441287', recipientName: 'Romar Viduya' },
    })
    expect(transfer.json().outcome, transfer.body).toBe('ACCEPTED')
    const originalId = transfer.json().transactionId as string
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    const res = await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(a, {
      debtorInformation: { accountIdentification: '111985123441287', accountIdentificationTypeCode: 'BBAN', partyName: 'Romar Viduya' },
      paymentInformation: { endToEndIdentification: 'NET-1', instructedAmount: '212.38', originalMessageIdentification: 'ANNCAU22XXX20230718000000000077240', remittanceInformationUnstructured: 'Romar', transactionIdentification: 'ANNCAU22XXXN20230718000000000077240' },
      paymentReturnInformation: { returnReasonCode: 'MD06', returnAmount: '212.38' },
    }))
    expect(res.statusCode, res.body).toBe(200)
    expect(await balances(a.accountHayId!)).toEqual({ total: 480, held: 0, available: 480 })
    const [p] = await txs(a.accountHayId!)
    expectFields(p.transactionEvent, 'nppReturn')
    expect(p.transactionEvent).toMatchObject({
      transactionType: 'INTERBANK_TRANSFER_OUT', isPending: false, outcome: 'ACCEPTED', currencyAmount: { amount: 212.38 }, originType: 'TRANSACTION', originId: originalId,
      returnReason: { code: 'CUSTOMER_REQUEST', message: 'Return of funds requested by end customer' }, counterpartName: 'Romar Viduya', category: 'BANK_TRANSFER', description: 'Romar',
    })
    expect((await get(`/v1/transactions/${p.transactionEvent.transactionHayId}`)).json()).toMatchObject({ type: 'INTERBANK_TRANSFER_OUT', transactionChannel: 'NPP_RETURN_IN', originId: originalId })
    // the payment is returned once: nothing left to return
    expectError(await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(a, { paymentReturnInformation: { returnReasonCode: 'AC04', returnAmount: '212.38' } })), 404, /^NOT_FOUND: /)
  })

  it('a return names its payment by originalTransactionIdentification (the I / N letter ignored) over the amount match; without it, the most recent of that amount', async () => {
    const { account: creditor } = await newAccount()
    const { account: debtor } = await newAccount({ fund: 50 })
    const mandateId = await createMandate(creditor, debtor, true)
    const older = nextInstructionId()
    const newer = nextInstructionId()
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    await payByRapain(mandateId, older, '10')
    await payByRapain(mandateId, newer, '10')
    const [first, second] = (await txs(debtor.accountHayId!)).map((p) => p.transactionEvent)
    expect([first.mandatePaymentDetails.instructionId, second.mandatePaymentDetails.instructionId]).toEqual([older, newer])
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    const ret = (extra: Record<string, unknown>) => post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(debtor, { paymentReturnInformation: { returnReasonCode: 'AC04', returnAmount: '10', ...extra } }))
    expect((await ret({ originalTransactionIdentification: nppId(older) })).statusCode).toBe(200)
    expect((await ret({})).statusCode).toBe(200)
    expectError(await ret({}), 404, /^NOT_FOUND: /)
    const returns = (await txs(debtor.accountHayId!)).map((p) => p.transactionEvent)
    expect(returns.map((e) => [e.transactionType, e.outcome, e.currencyAmount.amount, e.originType, e.originId, e.mandatePaymentDetails.instructionId, e.returnReason.code])).toEqual([
      ['INTERBANK_TRANSFER_OUT', 'ACCEPTED', 10, 'TRANSACTION', first.transactionHayId, older, 'ACCOUNT_CLOSED'],
      ['INTERBANK_TRANSFER_OUT', 'ACCEPTED', 10, 'TRANSACTION', second.transactionHayId, newer, 'ACCOUNT_CLOSED'],
    ])
    expect(await balances(debtor.accountHayId!)).toEqual({ total: 50, held: 0, available: 50 })
  })

  it('a return of a PayTo payment settled between two local accounts (both legs on-us) is 422: nothing is refunded while the local creditor keeps the funds', async () => {
    const { account: creditor } = await newAccount()
    const { account: debtor } = await newAccount({ fund: 100 })
    const mandateId = await createMandate(creditor, debtor, true)
    const paid = await post('/v1/payto/payments/adhoc', { idempotencyKey: randomUUID(), mandateId, amount: { currency: 'AUD', amount: 10 } })
    expect(paid.json().transactionStatus, paid.body).toBe('ACCEPTED_AND_SETTLED')
    await flush()
    const ret = await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(debtor, { paymentReturnInformation: { returnReasonCode: 'CUST', returnAmount: '10', originalTransactionIdentification: nppId(paid.json().instructionId) } }))
    expectError(ret, 422, /^INVALID_ARGUMENT: .*settled between two local accounts/)
    expect(await balances(debtor.accountHayId!)).toEqual({ total: 90, held: 0, available: 90 })
    expect(await balances(creditor.accountHayId!)).toEqual({ total: 10, held: 0, available: 10 })
  })

  it('a partial return credits the returned amount and closes the payment; a return larger than the payment is 422', async () => {
    const { account: creditor } = await newAccount()
    const { account: debtor } = await newAccount({ fund: 50 })
    const mandateId = await createMandate(creditor, debtor, true)
    const instructionId = nextInstructionId()
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    await payByRapain(mandateId, instructionId, '10')
    const [paid] = await txs(debtor.accountHayId!)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    const ret = (returnAmount: string, returnReasonCode = 'FOCR') => post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(debtor, { paymentReturnInformation: { returnReasonCode, returnAmount, originalTransactionIdentification: nppId(instructionId) } }))
    expectError(await ret('10.01'), 422, /^INVALID_AMOUNT: .*exceeds the original payment of 10/)
    expect((await ret('4', 'ZZZZ')).statusCode).toBe(200)
    const [p] = await txs(debtor.accountHayId!)
    expect(p.transactionEvent).toMatchObject({
      transactionType: 'INTERBANK_TRANSFER_OUT', outcome: 'ACCEPTED', currencyAmount: { amount: 4 }, originId: paid.transactionEvent.transactionHayId,
      returnReason: { code: 'OTHER', message: 'Payment returned with reason code ZZZZ' },
    })
    expect(await balances(debtor.accountHayId!)).toEqual({ total: 44, held: 0, available: 44 })
    // each payment is returned once: the rest of it cannot follow
    expectError(await ret('6'), 404, /^NOT_FOUND: /)
    expect(await balances(debtor.accountHayId!)).toEqual({ total: 44, held: 0, available: 44 })
  })

  it('a refused return (LOCKED account) still carries returnReason, originType / originId and mandatePaymentDetails', async () => {
    const { account: creditor } = await newAccount()
    const { account: debtor } = await newAccount({ fund: 50 })
    const mandateId = await createMandate(creditor, debtor, true)
    const instructionId = nextInstructionId()
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    await payByRapain(mandateId, instructionId, '10')
    const [paid] = await txs(debtor.accountHayId!)
    await blockAccount(debtor.accountHayId!)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    const res = await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(debtor, { paymentReturnInformation: { returnReasonCode: 'MD06', returnAmount: '10', originalTransactionIdentification: nppId(instructionId) } }))
    expect(res.statusCode, res.body).toBe(200)
    const [p] = await txs(debtor.accountHayId!)
    expect(p.transactionEvent).toMatchObject({
      transactionType: 'INTERBANK_TRANSFER_OUT', outcome: 'REFUSED_ACCOUNT_BLOCKED', isPending: false, currencyAmount: { amount: 10 },
      returnReason: { code: 'CUSTOMER_REQUEST', message: 'Return of funds requested by end customer' }, originType: 'TRANSACTION', originId: paid.transactionEvent.transactionHayId,
      mandatePaymentDetails: { mandateId, instructionId, initiatingPartyName: 'ACME Utilities' },
    })
    expect(await balances(debtor.accountHayId!)).toEqual({ total: 40, held: 0, available: 40 })
  })

  it('an unknown / non-local creditor is 404; a non-positive instructedAmount 400', async () => {
    const { account: a } = await newAccount()
    expectError(await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(a, { creditorInformation: { accountIdentification: '63610027487941', accountIdentificationTypeCode: 'BBAN' } })), 404, /^NOT_FOUND: /)
    const zero = rapBody(a)
    zero.paymentInformation.instructedAmount = '0'
    expectError(await post('/v0/utils/generate-inbound-npp-transaction-v2', zero), 400, /^BAD_REQUEST: paymentInformation.instructedAmount/)
    // a CLOSED creditor refuses the credit: 200 + the refused INTERBANK_TRANSFER_IN (spec §5.2)
    await closeAccount(a.accountHayId!)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    expect((await post('/v0/utils/generate-inbound-npp-transaction-v2', rapBody(a))).statusCode).toBe(200)
    const [p] = await txs(a.accountHayId!)
    expect(p.transactionEvent).toMatchObject({ transactionType: 'INTERBANK_TRANSFER_IN', outcome: 'REFUSED_ACCOUNT_CLOSED', currencyAmount: { amount: 2 } })
  })
})

describe('generateInboundDeTransaction (POST /v0/utils/generate-de-inbound)', () => {
  function deBody(a: HayAccount, overrides: Record<string, unknown> = {}) {
    return {
      recordType: 'DIRECT', transactionType: 'CREDIT', amount: 11.98, description: 'Invoice 123456',
      recipientAccountNumber: a.accountNumber, recipientBsb: a.bsb, recipientName: 'Han Solo',
      senderAccountNumber: '112836327', senderBsb: EXTERNAL_BSB, senderName: 'Darth Vader', ...overrides,
    }
  }

  it('DIRECT / CREDIT credits the recipient: INTERBANK_TRANSFER_IN (CUSCAL_DE_CREDIT_IN)', async () => {
    const { customer, account: a } = await newAccount()
    const res = await post('/v0/utils/generate-de-inbound', deBody(a))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Inbound Direct Entry request generated.' })
    expect(await balances(a.accountHayId!)).toEqual({ total: 11.98, held: 0, available: 11.98 })
    const [p] = await txs(a.accountHayId!)
    expect(p).toMatchObject({ customerHayId: customer, actionOwner: 'PLATFORM' })
    expectFields(p.transactionEvent, 'interbankIn')
    expect(p.transactionEvent).toMatchObject({
      transactionType: 'INTERBANK_TRANSFER_IN', currencyAmount: { amount: 11.98 }, counterpartName: 'Darth Vader', category: 'BANK_TRANSFER', description: 'Invoice 123456',
      counterpartDetails: { name: 'Darth Vader', basicAccountNumber: { accountNumber: '112836327', branchNumber: EXTERNAL_BSB } },
    })
    expect((await get(`/v1/transactions/${p.transactionEvent.transactionHayId}`)).json()).toMatchObject({ transactionChannel: 'CUSCAL_DE_CREDIT_IN' })
  })

  it('DIRECT / DEBIT pulls from the recipient: DIRECT_DEBIT_TRANSFER, negative, originType DIRECT_DEBIT, DIRECT_DEBIT_PER_DAY and funds checked', async () => {
    const { customer, account: a } = await newAccount({ fund: 100 })
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    expect((await post('/v0/utils/generate-de-inbound', deBody(a, { transactionType: 'DEBIT', amount: 45.71, description: 'Thanks for lunch' }))).statusCode).toBe(200)
    expect(await balances(a.accountHayId!)).toEqual({ total: 54.29, held: 0, available: 54.29 })
    await setLimit(a.accountHayId!, 'DIRECT_DEBIT_PER_DAY', 50)
    await post('/v0/utils/generate-de-inbound', deBody(a, { transactionType: 'DEBIT', amount: 5 }))
    await setLimit(a.accountHayId!, 'DIRECT_DEBIT_PER_DAY', 500)
    await post('/v0/utils/generate-de-inbound', deBody(a, { transactionType: 'DEBIT', amount: 60 }))
    const events = await txs(a.accountHayId!)
    const e = events[0].transactionEvent
    expect(events[0]).toMatchObject({ customerHayId: customer })
    expectFields(e, 'directDebit')
    expect(e).toMatchObject({ transactionType: 'DIRECT_DEBIT_TRANSFER', currencyAmount: { amount: -45.71 }, originType: 'DIRECT_DEBIT', counterpartName: 'Darth Vader', category: 'BANK_TRANSFER', description: 'Thanks for lunch' })
    expectSnapshot(e, { total: 54.29, held: 0, available: 54.29 })
    expect(events.slice(1).map((p) => [p.transactionEvent.transactionType, p.transactionEvent.outcome])).toEqual([
      ['DIRECT_DEBIT_TRANSFER', 'REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED'], ['DIRECT_DEBIT_TRANSFER', 'REFUSED_NOT_ENOUGH_FUNDS'],
    ])
    expect(await balances(a.accountHayId!)).toEqual({ total: 54.29, held: 0, available: 54.29 })
    expect((await get(`/v1/transactions/${e.transactionHayId}`)).json()).toMatchObject({ type: 'DIRECT_DEBIT_TRANSFER', transactionChannel: 'CUSCAL_DE_DEBIT_IN' })
  })

  it('RETURN / DEBIT returns the matching in-flight outbound direct debit: DIRECT_ENTRY RETURNED only', async () => {
    const { customer, account: a } = await newAccount()
    built.ctx.services.directEntry.progressDelayMs = 60_000
    try {
      const transactionId = randomUUID()
      const dd = await post('/v1/direct-debits', {
        idempotencyKey: randomUUID(), transactionId, amount: 11.98, description: 'Gym', senderBsb: a.bsb, senderAccountNumber: a.accountNumber, senderName: 'Local',
        recipientBsb: EXTERNAL_BSB, recipientAccountNumber: '112836327', recipientName: 'External',
      })
      expect(dd.json().outcome, dd.body).toBe('ACCEPTED')
      await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
      const body = {
        recordType: 'RETURN', returnReason: 'ACCOUNT_CLOSED', transactionType: 'DEBIT', amount: 11.98,
        recipientAccountNumber: '112836327', recipientBsb: EXTERNAL_BSB, senderAccountNumber: a.accountNumber, senderBsb: a.bsb,
      }
      const res = await post('/v0/utils/generate-de-inbound', body)
      expect(res.statusCode, res.body).toBe(200)
      expect((await get(`/v1/direct-debits/${transactionId}`)).json().outcome).toBe('RETURNED')
      const ps = await payloads()
      expect(ps.map((p) => p.type)).toEqual(['DIRECT_ENTRY'])
      expect(ps[0]).toMatchObject({ customerHayId: customer, directEntryEvent: { transactionId, type: 'DEBIT', direction: 'OUTBOUND', status: 'RETURNED' } })
      expect(await balances(a.accountHayId!)).toEqual({ total: 0, held: 0, available: 0 })
      // nothing left to return
      expectError(await post('/v0/utils/generate-de-inbound', body), 404, /^NOT_FOUND: /)
    } finally {
      built.ctx.services.directEntry.progressDelayMs = undefined
      await clock({ advanceMs: 180_000 })
    }
  })

  it('REFUSAL / DEBIT (spec §5.5, W7): the matching in-flight outbound direct debit becomes INCOMPLETE: DIRECT_ENTRY INCOMPLETE only', async () => {
    const { customer, account: a } = await newAccount()
    built.ctx.services.directEntry.progressDelayMs = 60_000
    try {
      const transactionId = randomUUID()
      const dd = await post('/v1/direct-debits', {
        idempotencyKey: randomUUID(), transactionId, amount: 11.98, description: 'Gym', senderBsb: a.bsb, senderAccountNumber: a.accountNumber, senderName: 'Local',
        recipientBsb: EXTERNAL_BSB, recipientAccountNumber: '112836327', recipientName: 'External',
      })
      expect(dd.json().outcome, dd.body).toBe('ACCEPTED')
      await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
      // the docs sample's orientation: the local account is the recipient, the external party the sender
      const body = deBody(a, { recordType: 'REFUSAL', refusalReason: 'RETURN_RECEIVED_OUT_OF_TIME', transactionType: 'DEBIT' })
      const res = await post('/v0/utils/generate-de-inbound', body)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({ message: 'Inbound Direct Entry request generated.' })
      const got = (await get(`/v1/direct-debits/${transactionId}`)).json()
      expect(got).toMatchObject({ outcome: 'INCOMPLETE', details: expect.stringContaining('RETURN_RECEIVED_OUT_OF_TIME') })
      const ps = await payloads()
      expect(ps.map((p) => p.type)).toEqual(['DIRECT_ENTRY'])
      expect(ps[0]).toMatchObject({ customerHayId: customer, actionOwner: 'PLATFORM', directEntryEvent: { transactionId, type: 'DEBIT', direction: 'OUTBOUND', status: 'INCOMPLETE' } })
      expect(await balances(a.accountHayId!)).toEqual({ total: 0, held: 0, available: 0 })
      // nothing left to refuse; only direct debits can be refused
      expectError(await post('/v0/utils/generate-de-inbound', body), 404, /^NOT_FOUND: /)
      expectError(await post('/v0/utils/generate-de-inbound', { ...body, transactionType: 'CREDIT' }), 422, /^INVALID_ARGUMENT: /)
    } finally {
      built.ctx.services.directEntry.progressDelayMs = undefined
      await clock({ advanceMs: 180_000 })
    }
    // the later hops were no-ops: the refusal is terminal
    expect((await payloads()).filter((p) => p.type === 'DIRECT_ENTRY')).toHaveLength(1)
  })

  it('RETURN needs returnReason, REFUSAL needs refusalReason (400)', async () => {
    const { account: a } = await newAccount({ fund: 20 })
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    expectError(await post('/v0/utils/generate-de-inbound', deBody(a, { recordType: 'RETURN', transactionType: 'DEBIT' })), 400, /^BAD_REQUEST: returnReason/)
    expectError(await post('/v0/utils/generate-de-inbound', deBody(a, { recordType: 'REFUSAL', transactionType: 'DEBIT' })), 400, /^BAD_REQUEST: refusalReason/)
    expect(await payloads()).toEqual([])
    expect(await balances(a.accountHayId!)).toEqual({ total: 20, held: 0, available: 20 })
  })

  it('an optional idempotencyKey replays; an unknown recipient is 404, a CLOSED one is refused (200 + REFUSED_ACCOUNT_CLOSED); patterns are full-matched', async () => {
    const { account: a } = await newAccount()
    const body = deBody(a, { idempotencyKey: randomUUID(), amount: 3 })
    await post('/v0/utils/generate-de-inbound', body)
    expect((await post('/v0/utils/generate-de-inbound', body)).statusCode).toBe(200)
    expect(await balances(a.accountHayId!)).toEqual({ total: 3, held: 0, available: 3 })
    expectError(await post('/v0/utils/generate-de-inbound', deBody(a, { recipientAccountNumber: '98765432' })), 404, /^NOT_FOUND: /)
    expectError(await post('/v0/utils/generate-de-inbound', deBody(a, { recipientBsb: '35022223' })), 400, /^BAD_REQUEST: recipientBsb/)
    expectError(await post('/v0/utils/generate-de-inbound', deBody(a, { amount: 1.999 })), 400, /^BAD_REQUEST: amount/)
    const { account: empty } = await newAccount()
    await closeAccount(empty.accountHayId!)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    expect((await post('/v0/utils/generate-de-inbound', deBody(empty))).statusCode).toBe(200)
    expect((await post('/v0/utils/generate-de-inbound', deBody(empty, { transactionType: 'DEBIT', amount: 2 }))).statusCode).toBe(200)
    const events = (await txs(empty.accountHayId!)).map((p) => p.transactionEvent)
    expect(events.map((e) => [e.transactionType, e.outcome, e.currencyAmount.amount])).toEqual([
      ['INTERBANK_TRANSFER_IN', 'REFUSED_ACCOUNT_CLOSED', 11.98], ['DIRECT_DEBIT_TRANSFER', 'REFUSED_ACCOUNT_CLOSED', -2],
    ])
  })
})

async function createMandate(creditor: HayAccount, debtor: HayAccount, activate = false): Promise<string> {
  const res = await post('/v1/payto/initiator/mandates', {
    idempotencyKey: randomUUID(),
    creditorDetails: { accountId: creditor.accountHayId, partyReference: 'NET-1724', partyType: 'ORGANISATION', ultimatePartyName: 'ACME Utilities' },
    debtorDetails: { partyName: 'JOHN MAXIMILLIAN DOE', partyType: 'PERSON', accountId: debtor.accountHayId },
    description: 'Electricity', paymentTerms: { frequency: 'ADHOC', type: 'VARIABLE', maximumAmount: { currency: 'AUD', amount: 900 } },
    purposeCode: 'UTILITY', validityStartDate: '2020-10-06',
  })
  expect(res.statusCode, res.body).toBe(200)
  const id = res.json().mandateId as string
  if (activate) {
    const r = await app.inject({ method: 'PATCH', url: `/v1/payto/payer/mandates/${id}/resolve?resolution=ACCEPT` })
    expect(r.statusCode, r.body).toBe(200)
  }
  await flush()
  return id
}
/** An accepted RAPAIN: the debtor's outbound NPP mandate payment (INTERBANK_TRANSFER_OUT with mandatePaymentDetails). */
async function payByRapain(mandateId: string, instructionId: string, amount: string): Promise<void> {
  const res = await post('/v0/utils/generate-receive-a-payment-instruction', {
    creditorInformation: { accountIdentification: '63610027487941', partyName: 'JOE BLOGGS' },
    debtorInformation: { accountIdentification: '63610079412687', partyName: 'JOHN MAXIMILLIAN DOE' },
    mandateInformation: { initiatingPartyName: 'ACME Utilities', mandateIdentification: hex(mandateId) },
    paymentInformation: { instructedAmount: amount, instructionIdentification: instructionId, remittanceInformationUnstructured: 'Electricity' },
    transactionStatusInformation: { transactionStatus: 'ACCP' },
  })
  expect(res.statusCode, res.body).toBe(200)
}
/** The NPP transaction id of a PayTo instruction id: the same 35 characters with the I letter swapped for N. */
const nppId = (instructionId: string): string => `${instructionId.slice(0, 11)}N${instructionId.slice(12)}`
async function mandateStatus(id: string): Promise<string> {
  const res = await get(`/v1/payto/mandates/${id}`)
  expect(res.statusCode, res.body).toBe(200)
  return res.json().status as string
}
function notificationBody(mandateId: string, trigger: string, debtorAccount = '63663672104323') {
  return {
    trigger,
    actionDetails: { actionId: '34927ba11a6811ee84e91d8ebf04eef2' },
    mandateDetails: {
      mandateId, creditorInformation: { accountIdentification: '63663630855474' }, debtorInformation: { accountIdentification: debtorAccount },
      // the docs sample's dates, with the end moved out of the past (an expired mandate is cancelled on the next tick)
      paymentInformation: { amount: '1.00', countPerPeriod: '1', firstPaymentAmount: '2.00', firstPaymentDate: '2023-06-15', lastPaymentAmount: '3.00', lastPaymentDate: '2099-06-15', maximumAmount: '4.00', paymentAmountType: 'VARI', paymentFrequency: 'DAIL', pointInTime: '10' },
      validityStartDate: '2023-06-15', validityEndDate: '2099-06-15',
    },
  }
}

describe('generateMandateNotificationForInitiator / ForPayer', () => {
  it('Initiator MCRC: one MANDATE webhook with the trigger to the creditor side; the MMS state is applied (CREATED -> ACTIVE)', async () => {
    const { customer: creditorCustomer, account: creditor } = await newAccount()
    const { account: debtor } = await newAccount()
    const mandateId = await createMandate(creditor, debtor)
    expect(await mandateStatus(mandateId)).toBe('CREATED')
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    const res = await post('/v0/utils/generate-mandate-notification-initiator', notificationBody(hex(mandateId), 'MCRC'))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Mandate Notification for Initiator generated.' })
    expect(await mandateStatus(mandateId)).toBe('ACTIVE')
    const ps = await payloads()
    expect(ps.map((p) => p.type)).toEqual(['MANDATE'])
    expect(ps[0]).toMatchObject({ customerHayId: creditorCustomer, actionOwner: 'PLATFORM', mandateEventDto: { mandateId, actionId: '34927ba1-1a68-11ee-84e9-1d8ebf04eef2', trigger: 'MCRC', description: 'Mandate create confirmed' } })
  })

  it('Initiator accepts the docs trigger PCRD (payer declined: CREATED -> CANCELLED); recall triggers are refused (C14); unknown mandate 404', async () => {
    const { account: creditor } = await newAccount()
    const { account: debtor } = await newAccount()
    const mandateId = await createMandate(creditor, debtor)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    expect((await post('/v0/utils/generate-mandate-notification-initiator', notificationBody(hex(mandateId), 'PCRD'))).statusCode).toBe(200)
    expect(await mandateStatus(mandateId)).toBe('CANCELLED')
    const ps = await payloads()
    expect(ps.map((p) => [p.type, p.mandateEventDto.trigger])).toEqual([['MANDATE', 'PCRD']])
    expectError(await post('/v0/utils/generate-mandate-notification-initiator', notificationBody(hex(mandateId), 'MCRR')), 400, /^BAD_REQUEST/)
    expectError(await post('/v0/utils/generate-mandate-notification-payer', notificationBody(hex(mandateId), 'MAMR')), 400, /^BAD_REQUEST: trigger MAMR/)
    expectError(await post('/v0/utils/generate-mandate-notification-payer', notificationBody(hex(mandateId), 'MCRC')), 400, /^BAD_REQUEST/)
    expectError(await post('/v0/utils/generate-mandate-notification-initiator', notificationBody('1212c423262b11ee844d95ee6a0c000c', 'MSCH')), 404, /^NOT_FOUND: Mandate/)
  })

  it('Initiator MCRX cancels a CREATED mandate (authorisation timed out); MAMC applies the pending amendment; one MANDATE each, to the creditor', async () => {
    const { customer: creditorCustomer, account: creditor } = await newAccount()
    const { account: debtor } = await newAccount()
    const created = await createMandate(creditor, debtor)
    const active = await createMandate(creditor, debtor, true)
    const proposal = await app.inject({ method: 'PATCH', url: `/v1/payto/initiator/mandates/${active}/payment_terms`, payload: { paymentTerms: { frequency: 'ADHOC', type: 'VARIABLE', maximumAmount: { currency: 'AUD', amount: 150 } } } })
    expect(proposal.statusCode, proposal.body).toBe(200)
    expect((await get(`/v1/payto/mandates/${active}`)).json().paymentTerms.maximumAmount).toEqual({ currency: 'AUD', amount: 900 })
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })

    expect((await post('/v0/utils/generate-mandate-notification-initiator', notificationBody(hex(created), 'MCRX'))).statusCode).toBe(200)
    expect((await get(`/v1/payto/mandates/${created}`)).json()).toMatchObject({ status: 'CANCELLED' })
    expect((await post('/v0/utils/generate-mandate-notification-initiator', notificationBody(hex(active), 'MAMC'))).statusCode).toBe(200)
    const after = (await get(`/v1/payto/mandates/${active}`)).json()
    expect(after).toMatchObject({ status: 'ACTIVE', paymentTerms: { maximumAmount: { currency: 'AUD', amount: 150 } } })
    const pending = await get(`/v1/payto/initiator/mandates/${active}/actions?pendingOnly=true`)
    expect(pending.json().actions).toEqual([])
    const ps = await payloads()
    expect(ps.map((p) => [p.type, p.customerHayId, p.mandateEventDto.mandateId, p.mandateEventDto.trigger])).toEqual([
      ['MANDATE', creditorCustomer, created, 'MCRX'], ['MANDATE', creditorCustomer, active, 'MAMC'],
    ])
  })

  it('Payer MSCH on a known mandate goes to the debtor side', async () => {
    const { account: creditor } = await newAccount()
    const { customer: debtorCustomer, account: debtor } = await newAccount()
    const mandateId = await createMandate(creditor, debtor, true)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    const res = await post('/v0/utils/generate-mandate-notification-payer', notificationBody(hex(mandateId), 'MSCH'))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Mandate Notification for Payer generated.' })
    const ps = await payloads()
    expect(ps.map((p) => [p.type, p.customerHayId, p.mandateEventDto.trigger])).toEqual([['MANDATE', debtorCustomer, 'MSCH']])
  })

  it("Payer MCRT for a mandate the platform does not know yet (an external Initiator's) registers it from mandateDetails when the debtor is local", async () => {
    const { customer: debtorCustomer, account: debtor } = await newAccount()
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    const mandateId = '1212c423-262b-11ee-844d-95ee6a0c0001'
    const res = await post('/v0/utils/generate-mandate-notification-payer', notificationBody(hex(mandateId), 'MCRT', `${debtor.bsb}${debtor.accountNumber}`))
    expect(res.statusCode, res.body).toBe(200)
    expect(await mandateStatus(mandateId)).toBe('CREATED')
    const ps = await payloads()
    expect(ps.map((p) => [p.type, p.customerHayId, p.mandateEventDto.trigger, p.mandateEventDto.mandateId])).toEqual([['MANDATE', debtorCustomer, 'MCRT', mandateId]])
    // neither side local: nothing to register, nobody to notify
    expectError(await post('/v0/utils/generate-mandate-notification-payer', notificationBody('1212c423262b11ee844d95ee6a0c0002', 'MCRT')), 404, /^NOT_FOUND: Mandate/)
  })

  it('validityStartDate is full-matched as a date (400)', async () => {
    const body = notificationBody('1212c423262b11ee844d95ee6a0c0003', 'MCRC')
    body.mandateDetails.validityStartDate = 'x2023-06-15'
    expectError(await post('/v0/utils/generate-mandate-notification-initiator', body), 400, /^BAD_REQUEST/)
  })
})

describe('generateReceiveAPaymentInstruction (POST /v0/utils/generate-receive-a-payment-instruction)', () => {
  function rapainBody(mandateId: string, instructionId: string, overrides: { status?: string; amount?: string } = {}) {
    return {
      creditorInformation: { accountIdentification: '63610027487941', partyName: 'JOE BLOGGS' },
      debtorInformation: { accountIdentification: '63610079412687', partyName: 'JOHN MAXIMILLIAN DOE' },
      mandateInformation: { initiatingPartyName: 'ACME Utilities', mandateIdentification: hex(mandateId) },
      paymentInformation: { instructedAmount: overrides.amount ?? '2', instructionIdentification: instructionId, remittanceInformationUnstructured: 'Electricity' },
      transactionStatusInformation: { transactionStatus: overrides.status ?? 'ACCP' },
    }
  }

  it('ACCP debits the debtor (INTERBANK_TRANSFER_OUT with mandatePaymentDetails) and sends MANDATE_PAYMENT_ACCEPTED', async () => {
    const { account: creditor } = await newAccount()
    const { customer: debtorCustomer, account: debtor } = await newAccount({ fund: 50 })
    const mandateId = await createMandate(creditor, debtor, true)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    const instructionId = nextInstructionId()
    const res = await post('/v0/utils/generate-receive-a-payment-instruction', rapainBody(mandateId, instructionId))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Receive A Payment Instruction generated.' })
    expect(await balances(debtor.accountHayId!)).toEqual({ total: 48, held: 0, available: 48 })
    expect(await balances(creditor.accountHayId!)).toEqual({ total: 0, held: 0, available: 0 })
    const [t] = await txs(debtor.accountHayId!)
    expect(t).toMatchObject({ customerHayId: debtorCustomer })
    expect(t.transactionEvent).toMatchObject({
      transactionType: 'INTERBANK_TRANSFER_OUT', currencyAmount: { amount: -2 }, originType: 'MANDATE_PAYMENT',
      mandatePaymentDetails: { mandateId, instructionId, initiatingPartyName: 'ACME Utilities' },
    })
    const mp = (await payloads()).filter((p) => p.type === 'MANDATE_PAYMENT')
    expect(mp).toHaveLength(1)
    expect(mp[0].mandatePaymentEventDto).toMatchObject({ instructionId, mandateId, paymentStatus: 'MANDATE_PAYMENT_ACCEPTED', isFinal: true, transactionHayId: t.transactionEvent.transactionHayId, originType: 'MANDATE_PAYMENT' })
  })

  it('RJCT moves nothing: MANDATE_PAYMENT_REJECTED with AB01, no transactionHayId; insufficient funds rejects with AM04', async () => {
    const { account: creditor } = await newAccount()
    const { account: debtor } = await newAccount({ fund: 1 })
    const mandateId = await createMandate(creditor, debtor, true)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    expect((await post('/v0/utils/generate-receive-a-payment-instruction', rapainBody(mandateId, nextInstructionId(), { status: 'RJCT' }))).statusCode).toBe(200)
    expect((await post('/v0/utils/generate-receive-a-payment-instruction', rapainBody(mandateId, nextInstructionId(), { amount: '5' }))).statusCode).toBe(200)
    expect(await balances(debtor.accountHayId!)).toEqual({ total: 1, held: 0, available: 1 })
    const ps = await payloads()
    expect(ps.filter((p) => p.type === 'TRANSACTION')).toEqual([])
    const mp = ps.filter((p) => p.type === 'MANDATE_PAYMENT').map((p) => p.mandatePaymentEventDto)
    expect(mp.map((e) => [e.paymentStatus, e.reasonCode])).toEqual([['MANDATE_PAYMENT_REJECTED', 'AB01'], ['MANDATE_PAYMENT_REJECTED', 'AM04']])
    for (const e of mp) expect(e.transactionHayId).toBeUndefined()
  })

  it('ACCP on a mandate that is not ACTIVE (CREATED, CANCELLED) debits nothing: MANDATE_PAYMENT_REJECTED AG01', async () => {
    const { account: creditor } = await newAccount()
    const { account: debtor } = await newAccount({ fund: 50 })
    const created = await createMandate(creditor, debtor)
    const cancelled = await createMandate(creditor, debtor, true)
    const cancel = await app.inject({ method: 'PATCH', url: `/v1/payto/initiator/mandates/${cancelled}/cancel`, payload: { reasonCode: 'MD17' } })
    expect(cancel.statusCode, cancel.body).toBe(200)
    await flush()
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    for (const mandateId of [created, cancelled]) {
      expect((await post('/v0/utils/generate-receive-a-payment-instruction', rapainBody(mandateId, nextInstructionId()))).statusCode).toBe(200)
    }
    expect(await balances(debtor.accountHayId!)).toEqual({ total: 50, held: 0, available: 50 })
    const ps = await payloads()
    expect(ps.filter((p) => p.type === 'TRANSACTION')).toEqual([])
    expect(ps.filter((p) => p.type === 'MANDATE_PAYMENT').map((p) => [p.mandatePaymentEventDto.paymentStatus, p.mandatePaymentEventDto.reasonCode])).toEqual([
      ['MANDATE_PAYMENT_REJECTED', 'AG01'], ['MANDATE_PAYMENT_REJECTED', 'AG01'],
    ])
  })

  it('an unknown mandate is 404; a non-positive amount 400', async () => {
    expectError(await post('/v0/utils/generate-receive-a-payment-instruction', rapainBody('1212c23a-255c-11ee-9a8e-5d3239591cd9', nextInstructionId())), 404, /^NOT_FOUND: Mandate/)
    const { account: creditor } = await newAccount()
    const { account: debtor } = await newAccount()
    const mandateId = await createMandate(creditor, debtor, true)
    expectError(await post('/v0/utils/generate-receive-a-payment-instruction', rapainBody(mandateId, nextInstructionId(), { amount: '0.00' })), 400, /^BAD_REQUEST: paymentInformation.instructedAmount/)
  })
})

describe('createStubForMandateSearchPaymentInstructions (POST /v0/utils/create-stub-search-payment-instructions)', () => {
  it('200 with no body; searchPaymentsInstructions then reports the stubbed instructions', async () => {
    const { account: creditor } = await newAccount()
    const { account: debtor } = await newAccount()
    const mandateId = await createMandate(creditor, debtor, true)
    await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    const instructionId = nextInstructionId()
    const res = await post('/v0/utils/create-stub-search-payment-instructions', {
      mandateIdentification: hex(mandateId),
      paymentInstructionSummaries: [{ creationDateTime: '2023-11-29T12:33:59.833Z', instructedAmount: 1.28, instructionIdentification: instructionId, transactionStatus: 'RECV', transactionStatusReasonCode: 'AB01' }],
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.body).toBe('')
    const search = await get(`/v1/payto/initiator/mandates/${mandateId}/search`)
    expect(search.statusCode, search.body).toBe(200)
    expect(search.json().paymentInstructions).toContainEqual(expect.objectContaining({ id: instructionId, amount: 1.28, transactionStatus: 'RECEIVED', transactionStatusReasonCode: 'AB01', creationDateTime: expect.stringMatching(/^2023-11-29T12:33:59\.833/) }))
    expect(await payloads()).toEqual([])
  })

  it('an unknown mandate is 404; an empty summary list 400', async () => {
    const summary = { creationDateTime: '2023-11-29T12:33:59.833Z', instructedAmount: 1.28, instructionIdentification: nextInstructionId(), transactionStatus: 'RECV' }
    expectError(await post('/v0/utils/create-stub-search-payment-instructions', { mandateIdentification: '121204288eb311ee8d7cc9dd305f4280', paymentInstructionSummaries: [summary] }), 404, /^NOT_FOUND: Mandate/)
    expectError(await post('/v0/utils/create-stub-search-payment-instructions', { mandateIdentification: '121204288eb311ee8d7cc9dd305f4280', paymentInstructionSummaries: [] }), 400, /^BAD_REQUEST/)
  })
})

describe('changeCardExpiryDate (PATCH /v0/utils/cards/{cardId}/expiry-date)', () => {
  it('moves the expiry date to the end of the given month', async () => {
    const { card } = await setup()
    const res = await app.inject({ method: 'PATCH', url: `/v0/utils/cards/${card.cardHayId}/expiry-date`, payload: { expiryDate: '2031-02-10' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Card expiry date changed successfully.' })
    const c = (await get(`/v0/cards/${card.cardHayId}`)).json()
    expect(c).toMatchObject({ expiryDate: '2031-02-28', cardStatus: 'ACTIVE' })
    expect(await payloads()).toEqual([])
  })

  it('a past date expires the card at once (CARD_STATUS_CHANGE EXPIRED, PLATFORM) and later card mocks decline with EXPIRED_CARD', async () => {
    const { customer, account: a, card } = await setup()
    const res = await app.inject({ method: 'PATCH', url: `/v0/utils/cards/${card.cardHayId}/expiry-date`, payload: { expiryDate: '2020-01-15' } })
    expect(res.statusCode, res.body).toBe(200)
    expect((await get(`/v0/cards/${card.cardHayId}`)).json()).toMatchObject({ expiryDate: '2020-01-31', cardStatus: 'EXPIRED' })
    const ps = (await payloads()).filter((p) => p.type === 'CARD_STATUS_CHANGE')
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ customerHayId: customer, actionOwner: 'PLATFORM', cardStatusChangeEvent: { cardHayId: card.cardHayId, cardStatus: 'EXPIRED' } })
    await post('/v0/utils/generate-auth-hold', { amount: -1, cardToken: card.cardToken })
    const [t] = await txs(a.accountHayId!)
    expect(t.transactionEvent).toMatchObject({ outcome: 'REFUSED_RULES', cardProcessorResponse: 'EXPIRED_CARD', isPending: false })
  })

  it('an unknown card is 404; a malformed date 400', async () => {
    expectError(await app.inject({ method: 'PATCH', url: `/v0/utils/cards/${UNKNOWN_ID}/expiry-date`, payload: { expiryDate: '2030-01-01' } }), 404, /^NOT_FOUND: Card/)
    const { card } = await setup()
    expectError(await app.inject({ method: 'PATCH', url: `/v0/utils/cards/${card.cardHayId}/expiry-date`, payload: { expiryDate: '2030-13-01' } }), 400, /^BAD_REQUEST/)
    expectError(await app.inject({ method: 'PATCH', url: `/v0/utils/cards/not-a-uuid/expiry-date`, payload: { expiryDate: '2030-01-01' } }), 400, /^BAD_REQUEST/)
  })
})
