import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '../src/contract/generated/b2b-types.js'
import { startApp } from './helpers.js'
import { assertValidNotification } from './webhook-schema.js'
import type { BuiltServer } from '../src/server.js'
import { DEFAULT_PREFERENCES, addMonthsClamped, defaultNameOnCard, expiryDateFrom, type CardsService } from '../src/domains/cards/index.js'
import { LOCAL_PRODUCT_ID } from '../src/domains/accounts/index.js'
import type { CardUsageDetails } from '../src/domains/transactions/index.js'

type S = components['schemas']
type HayCard = S['HayCard']
type CreateBody = S['CreateHayCardRequestBody']

const CARD_OPS = [
  'createHayCard', 'getCard', 'activateCard', 'blockCard', 'cancelCard', 'convertCard', 'getCardCvvStatus', 'unblockCardCvv',
  'getDigitalWalletDetails', 'getOemProvisioningData', 'getPaymentPreferences', 'updatePaymentPreferences', 'changeCardPin',
  'getCardPinStatus', 'unblockCardPin', 'reissueHayCard', 'renewCard', 'rewards', 'unblockCard',
]
const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111'
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const UUID_RE = /^[0-9a-f-]{36}$/
const ADDRESS = { line1: '9 Fifth Ave', line2: 'Woodville Gardens', townOrCity: 'Adelaide', administrativeRegion: 'SA', postcode: '5012', countryCodeIso: 'AUS' }
const PHONE = { countryCodePrefix: '61', numberAfterPrefix: '412345678' }
const USAGE = {
  chip: { isMagneticStripePayment: false, isContactless: false, isCardPresent: true, isMobileWalletPayment: false, isAtmWithdrawal: false },
  contactless: { isMagneticStripePayment: false, isContactless: true, isCardPresent: true, isMobileWalletPayment: false, isAtmWithdrawal: false },
  magstripe: { isMagneticStripePayment: true, isContactless: false, isCardPresent: true, isMobileWalletPayment: false, isAtmWithdrawal: false },
  cnp: { isMagneticStripePayment: false, isContactless: false, isCardPresent: false, isMobileWalletPayment: false, isAtmWithdrawal: false },
  wallet: { isMagneticStripePayment: false, isContactless: true, isCardPresent: true, isMobileWalletPayment: true, isAtmWithdrawal: false },
  atm: { isMagneticStripePayment: false, isContactless: false, isCardPresent: true, isMobileWalletPayment: false, isAtmWithdrawal: true },
} satisfies Record<string, CardUsageDetails>
const MERCHANT = { name: 'IGA (Mt Cotton)', merchantId: '000009493578577', merchantCategoryCode: 5411, cardAcceptorLocation: 'Mt Cotton QLD' }

let built: BuiltServer
let app: BuiltServer['app']
let svc: CardsService
beforeAll(async () => { built = await startApp(); app = built.app; svc = built.ctx.services.cards })
afterAll(async () => { await built.app.close() })

let n = 0
async function flush(): Promise<void> {
  await app.inject({ method: 'POST', url: '/_admin/flush' })
}
async function setClock(body: { set?: string; freeze?: string; advanceMs?: number; reset?: boolean }): Promise<void> {
  const res = await app.inject({ method: 'POST', url: '/_admin/clock', payload: body })
  expect(res.statusCode, res.body).toBe(200)
  await flush()
}
async function newCustomer(emailTag = ''): Promise<string> {
  n++
  const res = await app.inject({
    method: 'POST', url: '/v0/customers/create',
    payload: {
      idempotencyKey: randomUUID(), email: `card${n}${emailTag}@example.com`, customerTier: 'STANDARD',
      phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: `4${String(n).padStart(8, '0')}` },
      address: { line1: '1 Test St', townOrCity: 'Sydney', administrativeRegion: 'NSW', postcode: '2000', countryCodeIso: 'AUS' },
      customerDetails: { firstName: 'Card', lastName: `Holder${n}`, dateOfBirth: '1990-01-01' },
    },
  })
  expect(res.statusCode, res.body).toBe(200)
  await flush()
  return res.json().customerHayId as string
}
async function newAccount(holderId: string, opts: { lowRisk?: boolean } = {}): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/accounts', payload: { idempotencyKey: randomUUID(), accountHolderId: holderId, accountHolderType: 'CUSTOMER', productId: LOCAL_PRODUCT_ID } })
  expect(res.statusCode, res.body).toBe(200)
  const id = res.json().accountHayId as string
  if (opts.lowRisk) {
    const r = await app.inject({ method: 'PATCH', url: `/v0/accounts/${id}/riskLevel`, payload: { level: 'LOW', reason: 'test' } })
    expect(r.statusCode, r.body).toBe(200)
  }
  return id
}
async function credit(accountHayId: string, amount: number): Promise<void> {
  const res = await app.inject({ method: 'POST', url: '/v1/transactions/credit', payload: { idempotencyKey: randomUUID(), accountHayId, amount, counterpartName: 'Payroll', description: 'pay', transactionChannel: 'MANUAL_ADJUSTMENT' } })
  expect(res.statusCode, res.body).toBe(200)
  expect(res.json().outcome).toBe('ACCEPTED')
}
function createBody(accountId: string, customerHayId: string, overrides: Partial<CreateBody> = {}): CreateBody {
  return { idempotencyKey: randomUUID(), accountId, customerHayId, firstName: 'Mary', lastName: 'Smith', email: 'mary@example.com', phoneNumber: PHONE, deliveryAddress: ADDRESS, pin: '1234', ...overrides }
}
/** Customer + account + card in one go. */
async function setup(overrides: Partial<CreateBody> = {}, opts: { lowRisk?: boolean } = {}): Promise<{ customer: string; account: string; card: HayCard }> {
  const customer = await newCustomer()
  const account = await newAccount(customer, opts)
  return { customer, account, card: await newCard(account, customer, overrides) }
}
async function newCard(accountId: string, customerHayId: string, overrides: Partial<CreateBody> = {}): Promise<HayCard> {
  const res = await app.inject({ method: 'POST', url: '/v0/cards/create', payload: createBody(accountId, customerHayId, overrides) })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as HayCard
}
async function getCard(id: string): Promise<HayCard> {
  const res = await app.inject({ method: 'GET', url: `/v0/cards/${id}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as HayCard
}
async function act(id: string, action: string, payload?: object): Promise<{ statusCode: number; json: () => any; body: string }> {
  return app.inject({ method: 'POST', url: `/v0/cards/${id}/${action}`, ...(payload === undefined ? {} : { payload }) })
}
async function status(id: string): Promise<string> {
  return (await getCard(id)).cardStatus!
}
async function allPayloads(): Promise<any[]> {
  await flush()
  const res = await app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })
  const payloads = (res.json() as { payload: any }[]).map((r) => r.payload)
  for (const p of payloads) assertValidNotification(p)
  return payloads
}
async function cardEvents(cardId: string): Promise<any[]> {
  return (await allPayloads()).filter((p) => p.type === 'CARD_STATUS_CHANGE' && p.cardHayId === cardId)
}
async function statuses(cardId: string): Promise<string[]> {
  return (await cardEvents(cardId)).map((p) => p.cardStatusChangeEvent.cardStatus)
}
/** YYYY-MM-DD of the last day of next month on the app clock. */
function endOfNextMonth(): string {
  const now = built.ctx.clock.now()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0)).toISOString().slice(0, 10)
}
function expectError(res: { statusCode: number; json: () => any }, status: number, code: RegExp | string): void {
  expect(res.statusCode).toBe(status)
  const body = res.json()
  expect(body).toMatchObject({ status: String(status), details: expect.stringContaining('traceId') })
  expect(body.traceId).toMatch(UUID_RE)
  expect(body.message).toMatch(code)
}

describe('cards domain: registration', () => {
  it('handles every Cards API operation (none left on the stub)', async () => {
    const res = await app.inject({ method: 'GET', url: '/_admin/operations' })
    const { handled, stubbed } = res.json() as { handled: string[]; stubbed: string[] }
    for (const op of CARD_OPS) {
      expect(handled, op).toContain(op)
      expect(stubbed, op).not.toContain(op)
    }
  })
})

describe('createHayCard (POST /v0/cards/create)', () => {
  it('issues a PHYSICAL card AWAITING_ACTIVATION with a 9-digit token, last four digits, a month-end expiry 4 years out and default names, and emits CARD_STATUS_CHANGE (CLIENT)', async () => {
    const { customer, account, card } = await setup()
    expect(card.cardHayId).toMatch(UUID_RE)
    expect(card).toMatchObject({ accountHayId: account, customerHayId: customer, cardStatus: 'AWAITING_ACTIVATION', cardType: 'PHYSICAL', deliveryMethod: 'STANDARD', nameOnCard: 'Mary Smith' })
    expect(card.cardToken).toMatch(/^\d{9}$/)
    expect(card.lastFourDigits).toMatch(/^\d{4}$/)
    expect(card.issuedDateTimeUtc).toMatch(ISO_MICROS)
    const issued = new Date(card.issuedDateTimeUtc!)
    expect(card.expiryDate).toBe(expiryDateFrom(issued))
    expect(card.expiryDate!.slice(0, 4)).toBe(String(issued.getUTCFullYear() + 4))
    // month end: the day after is the first of a month
    const next = new Date(new Date(card.expiryDate!).getTime() + 86_400_000)
    expect(next.getUTCDate()).toBe(1)
    for (const absent of ['blockedBy', 'voidDateTimeUtc', 'renewedIntoCardId', 'nameOnCardLine2']) expect(card, absent).not.toHaveProperty(absent)
    // the PAN itself never leaves the service
    expect(JSON.stringify(card)).not.toContain(svc.get(card.cardHayId!).pan)
    expect(await getCard(card.cardHayId!)).toEqual(card)

    const events = await cardEvents(card.cardHayId!)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      idempotencyKey: expect.stringMatching(UUID_RE), customerHayId: customer, type: 'CARD_STATUS_CHANGE', actionOwner: 'CLIENT', cardHayId: card.cardHayId, productId: expect.stringMatching(UUID_RE),
      cardStatusChangeEvent: { cardHayId: card.cardHayId, accountHayId: account, cardStatus: 'AWAITING_ACTIVATION', cardLastFourDigits: card.lastFourDigits },
    })
  })

  it('a VIRTUAL card is issued ACTIVE; explicit names, title, sub-design and delivery method are honoured', async () => {
    const { card } = await setup({ cardType: 'VIRTUAL', nameOnCard: 'M SMITH', nameOnCardLine2: 'Trading NAME', deliveryMethod: 'COURIER', cardSubDesign: 'SUB_DESIGN_7', title: 'Ms' })
    expect(card).toMatchObject({ cardStatus: 'ACTIVE', cardType: 'VIRTUAL', nameOnCard: 'M SMITH', nameOnCardLine2: 'Trading NAME', deliveryMethod: 'COURIER' })
    expect(await statuses(card.cardHayId!)).toEqual(['ACTIVE'])
    expect(svc.get(card.cardHayId!)).toMatchObject({ cardSubDesign: 'SUB_DESIGN_7', title: 'Ms', deliveryAddress: ADDRESS, phoneNumber: PHONE, email: 'mary@example.com' })
  })

  it('default nameOnCard: "first last" under 23 characters, else initial + last name', async () => {
    expect(defaultNameOnCard('Mary', 'Smith')).toBe('Mary Smith')
    expect(defaultNameOnCard('Bartholomew', 'Featherstonehaugh')).toBe('B Featherstonehaugh')
    expect(defaultNameOnCard('Alexandria', 'Hamilton-Bro')).toBe('A Hamilton-Bro') // 23 characters combined is not "smaller than 23"
    const { card } = await setup({ firstName: 'Bartholomew', lastName: 'Featherstonehaugh' })
    expect(card.nameOnCard).toBe('B Featherstonehaugh')
  })

  it('cardToken and PAN are unique per card; the PIN is stored hashed and verifiable', async () => {
    const customer = await newCustomer()
    const account = await newAccount(customer)
    const a = await newCard(account, customer, { pin: '4321' })
    const b = await newCard(account, customer, { pin: '987654321012' })
    expect(a.cardToken).not.toBe(b.cardToken)
    expect(svc.get(a.cardHayId!).pan).not.toBe(svc.get(b.cardHayId!).pan)
    expect(svc.get(a.cardHayId!).pinHash).not.toBe('4321')
    expect(svc.verifyPin(a.cardHayId!, '4321')).toBe(true)
    expect(svc.verifyPin(a.cardHayId!, '1234')).toBe(false)
    expect(svc.verifyPin(b.cardHayId!, '987654321012')).toBe(true)
    expect(svc.byToken(a.cardToken!)?.id).toBe(a.cardHayId)
    expect(svc.byToken('000000000')).toBeUndefined()
  })

  it('replays the same idempotencyKey + body and refuses the key with a different body', async () => {
    const customer = await newCustomer()
    const account = await newAccount(customer)
    const body = createBody(account, customer)
    const a = await app.inject({ method: 'POST', url: '/v0/cards/create', payload: body })
    const b = await app.inject({ method: 'POST', url: '/v0/cards/create', payload: body })
    expect(a.statusCode).toBe(200)
    expect(b.json()).toEqual(a.json())
    expect((await app.inject({ method: 'GET', url: `/v0/customers/${customer}/cards` })).json()).toHaveLength(1)
    expectError(await app.inject({ method: 'POST', url: '/v0/cards/create', payload: { ...body, pin: '9999' } }), 422, /^IDEMPOTENCY_KEY_REUSED/)
  })

  it('400 on schema violations and a bad pin; 404 unknown customer / account', async () => {
    const customer = await newCustomer()
    const account = await newAccount(customer)
    expectError(await app.inject({ method: 'POST', url: '/v0/cards/create', payload: { ...createBody(account, customer), cardType: 'PLASTIC' } }), 400, /^BAD_REQUEST/)
    expectError(await app.inject({ method: 'POST', url: '/v0/cards/create', payload: { ...createBody(account, customer), deliveryAddress: { line1: 'x' } } }), 400, /^BAD_REQUEST/)
    expectError(await app.inject({ method: 'POST', url: '/v0/cards/create', payload: { ...createBody(account, customer), nameOnCard: 'x'.repeat(24) } }), 400, /^BAD_REQUEST/)
    expectError(await app.inject({ method: 'POST', url: '/v0/cards/create', payload: createBody(account, customer, { pin: '12' }) }), 400, /^BAD_REQUEST: pin/)
    expectError(await app.inject({ method: 'POST', url: '/v0/cards/create', payload: createBody(account, customer, { pin: '12ab' }) }), 400, /^BAD_REQUEST: pin/)
    expectError(await app.inject({ method: 'POST', url: '/v0/cards/create', payload: createBody(account, UNKNOWN_ID) }), 404, /^NOT_FOUND: Customer/)
    expectError(await app.inject({ method: 'POST', url: '/v0/cards/create', payload: createBody(UNKNOWN_ID, customer) }), 404, /^NOT_FOUND: Account/)
  })

  it('422 when the customer is not ACTIVE, the account is LOCKED / CLOSED, or the customer does not hold the account', async () => {
    const referred = await newCustomer('+referred')
    const active = await newCustomer()
    const account = await newAccount(active)
    expectError(await app.inject({ method: 'POST', url: '/v0/cards/create', payload: createBody(account, referred) }), 422, /^PERMISSION_DENIED: Card cannot be created for customer with id .* as their status is currently REFERRED/)

    const other = await newCustomer()
    expectError(await app.inject({ method: 'POST', url: '/v0/cards/create', payload: createBody(account, other) }), 422, /^PERMISSION_DENIED: Customer .* does not hold account/)

    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${account}/block`, payload: { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' } })).statusCode).toBe(200)
    expectError(await app.inject({ method: 'POST', url: '/v0/cards/create', payload: createBody(account, active) }), 422, /^ACCOUNT_BLOCKED/)
    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${account}/unblock`, payload: { note: 'x' } })).statusCode).toBe(200)

    expect((await app.inject({ method: 'POST', url: `/v0/accounts/${account}/close`, payload: { reason: 'CUSTOMER' } })).statusCode).toBe(202)
    await flush()
    expectError(await app.inject({ method: 'POST', url: '/v0/cards/create', payload: createBody(account, active) }), 422, /^(ACCOUNT_CLOSED|PERMISSION_DENIED)/)
  })

  it('lists through getCardsForAccountId and getCardsForCustomerId (every status, creation order)', async () => {
    const customer = await newCustomer()
    const account = await newAccount(customer)
    const a = await newCard(account, customer)
    const b = await newCard(account, customer, { cardType: 'VIRTUAL' })
    expect((await act(a.cardHayId!, 'cancel')).statusCode).toBe(200)
    const byAccount = (await app.inject({ method: 'GET', url: `/v0/accounts/${account}/cards` })).json() as HayCard[]
    expect(byAccount.map((c) => [c.cardHayId, c.cardStatus])).toEqual([[a.cardHayId, 'INACTIVE'], [b.cardHayId, 'ACTIVE']])
    const byCustomer = (await app.inject({ method: 'GET', url: `/v0/customers/${customer}/cards` })).json() as HayCard[]
    expect(byCustomer).toEqual(byAccount)
  })
})

describe('getCard', () => {
  it('404 for an unknown card, 400 for a malformed id', async () => {
    expectError(await app.inject({ method: 'GET', url: `/v0/cards/${UNKNOWN_ID}` }), 404, /^NOT_FOUND: Card/)
    expectError(await app.inject({ method: 'GET', url: '/v0/cards/not-a-uuid' }), 400, /^BAD_REQUEST/)
  })
})

describe('activateCard', () => {
  it('AWAITING_ACTIVATION -> ACTIVE with CARD_STATUS_CHANGE {ACTIVE}; anything else is 422 INVALID_CARD_STATUS', async () => {
    const { card } = await setup()
    const res = await act(card.cardHayId!, 'activate')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ message: expect.any(String) })
    expect(await status(card.cardHayId!)).toBe('ACTIVE')
    expect(await statuses(card.cardHayId!)).toEqual(['AWAITING_ACTIVATION', 'ACTIVE'])
    expectError(await act(card.cardHayId!, 'activate'), 422, /^INVALID_CARD_STATUS: Card .* cannot be activated from status ACTIVE/)
    expectError(await act(UNKNOWN_ID, 'activate'), 404, /^NOT_FOUND: Card/)
  })
})

describe('blockCard / unblockCard', () => {
  it('ACTIVE -> BLOCKED (blockedBy CLIENT, note optional) -> ACTIVE on unblock (blockedBy cleared); repeated block is a silent no-op', async () => {
    const { card } = await setup({ cardType: 'VIRTUAL' })
    const id = card.cardHayId!
    expect((await act(id, 'block')).statusCode).toBe(200) // no body at all
    expect(await getCard(id)).toMatchObject({ cardStatus: 'BLOCKED', blockedBy: 'CLIENT' })
    expect((await act(id, 'block', { note: 'investigation' })).statusCode).toBe(200)
    expect(svc.get(id).blockNote).toBeUndefined() // the no-op does not record the note
    expect(await statuses(id)).toEqual(['ACTIVE', 'BLOCKED'])

    expectError(await act(id, 'unblock', {}), 400, /^BAD_REQUEST/) // note is required
    expect((await act(id, 'unblock', { note: 'cleared' })).statusCode).toBe(200)
    const after = await getCard(id)
    expect(after.cardStatus).toBe('ACTIVE')
    expect(after).not.toHaveProperty('blockedBy')
    expect(await statuses(id)).toEqual(['ACTIVE', 'BLOCKED', 'ACTIVE'])
    expectError(await act(id, 'unblock', { note: 'again' }), 422, /^INVALID_CARD_STATUS: Card .* cannot be unblocked from status ACTIVE/)
  })

  it('a card blocked while AWAITING_ACTIVATION returns to AWAITING_ACTIVATION on unblock; a PLATFORM block is cleared by the client', async () => {
    const { card } = await setup()
    const id = card.cardHayId!
    expect((await act(id, 'block', { note: 'lost in the post' })).statusCode).toBe(200)
    expect(svc.get(id)).toMatchObject({ status: 'BLOCKED', blockNote: 'lost in the post', statusBeforeBlock: 'AWAITING_ACTIVATION' })
    expect((await act(id, 'unblock', { note: 'found' })).statusCode).toBe(200)
    expect(await status(id)).toBe('AWAITING_ACTIVATION')

    svc.block(id, { actionOwner: 'PLATFORM' })
    expect(await getCard(id)).toMatchObject({ cardStatus: 'BLOCKED', blockedBy: 'PLATFORM' })
    expect((await act(id, 'unblock', { note: 'ok' })).statusCode).toBe(200)
    expect(await status(id)).toBe('AWAITING_ACTIVATION')
    expect((await cardEvents(id)).map((p) => [p.cardStatusChangeEvent.cardStatus, p.actionOwner])).toEqual([
      ['AWAITING_ACTIVATION', 'CLIENT'], ['BLOCKED', 'CLIENT'], ['AWAITING_ACTIVATION', 'CLIENT'], ['BLOCKED', 'PLATFORM'], ['AWAITING_ACTIVATION', 'CLIENT'],
    ])
  })

  it('INACTIVE and EXPIRED cards cannot be blocked (422); a malformed optional body is 400', async () => {
    const { card } = await setup({ cardType: 'VIRTUAL' })
    expectError(await act(card.cardHayId!, 'block', { note: 5 }), 400, /^BAD_REQUEST/)
    expectError(await app.inject({ method: 'POST', url: `/v0/cards/${card.cardHayId}/block`, payload: '[1]', headers: { 'content-type': 'application/json' } }), 400, /^BAD_REQUEST/)
    expect((await act(card.cardHayId!, 'cancel')).statusCode).toBe(200)
    expectError(await act(card.cardHayId!, 'block'), 422, /^INVALID_CARD_STATUS: Card .* cannot be blocked from status INACTIVE/)
    const expired = await setup({ cardType: 'VIRTUAL' })
    svc.setExpiryDate(expired.card.cardHayId!, '2000-01-15')
    expect(await status(expired.card.cardHayId!)).toBe('EXPIRED')
    expectError(await act(expired.card.cardHayId!, 'block'), 422, /^INVALID_CARD_STATUS: .* EXPIRED/)
  })
})

describe('cancelCard', () => {
  it('ACTIVE / AWAITING_ACTIVATION / BLOCKED / EXPIRED -> INACTIVE (voided, wallets disabled); INACTIVE is terminal and a repeat is a no-op', async () => {
    const customer = await newCustomer()
    const account = await newAccount(customer)
    const active = await newCard(account, customer, { cardType: 'VIRTUAL' })
    const awaiting = await newCard(account, customer)
    const blocked = await newCard(account, customer, { cardType: 'VIRTUAL' })
    const expired = await newCard(account, customer, { cardType: 'VIRTUAL' })
    svc.provisionWallet(active.cardHayId!, 'APPLE_WALLET')
    expect((await act(blocked.cardHayId!, 'block')).statusCode).toBe(200)
    svc.setExpiryDate(expired.cardHayId!, '2001-02-01')
    for (const c of [active, awaiting, blocked, expired]) {
      const res = await act(c.cardHayId!, 'cancel')
      expect(res.statusCode, res.body).toBe(200)
      const after = await getCard(c.cardHayId!)
      expect(after.cardStatus).toBe('INACTIVE')
      expect(after.voidDateTimeUtc).toMatch(ISO_MICROS)
      expect(after).not.toHaveProperty('blockedBy')
      expect((await statuses(c.cardHayId!)).at(-1)).toBe('INACTIVE')
    }
    expect((await app.inject({ method: 'GET', url: `/v0/cards/${active.cardHayId}/digital-wallets` })).json().wallets).toEqual([expect.objectContaining({ digitalWalletStatus: 'INACTIVE_TOKEN' })])
    const before = (await cardEvents(active.cardHayId!)).length
    expect((await act(active.cardHayId!, 'cancel')).statusCode).toBe(200)
    expect((await cardEvents(active.cardHayId!)).length).toBe(before)
    expectError(await act(active.cardHayId!, 'activate'), 422, /^INVALID_CARD_STATUS/)
    expect(() => svc.setStatus(active.cardHayId!, 'ACTIVE', { actionOwner: 'PLATFORM' })).toThrow(/INVALID_CARD_STATUS/)
  })
})

describe('convertCard', () => {
  it('an ACTIVE VIRTUAL card becomes PHYSICAL and AWAITING_ACTIVATION, keeping id / token / PAN / expiry; wallet tokens survive; the delivery address may be replaced', async () => {
    const { card } = await setup({ cardType: 'VIRTUAL' })
    const id = card.cardHayId!
    svc.provisionWallet(id, 'ANDROID_WALLET')
    const res = await act(id, 'convert', { deliveryAddress: { line1: '2 New St', countryCodeIso: 'AUS' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ cardHayId: id, cardType: 'PHYSICAL', cardStatus: 'AWAITING_ACTIVATION', cardToken: card.cardToken, lastFourDigits: card.lastFourDigits, expiryDate: card.expiryDate })
    expect(svc.get(id).deliveryAddress).toEqual({ line1: '2 New St', countryCodeIso: 'AUS' })
    expect((await app.inject({ method: 'GET', url: `/v0/cards/${id}/digital-wallets` })).json().wallets[0].digitalWalletStatus).toBe('ACTIVE_TOKEN')
    expect(await statuses(id)).toEqual(['ACTIVE', 'AWAITING_ACTIVATION'])
    expect((await act(id, 'activate')).statusCode).toBe(200)
    expect(await status(id)).toBe('ACTIVE')
  })

  it('422 INVALID_CARD_TYPE for a PHYSICAL card, 422 INVALID_CARD_STATUS for a non-ACTIVE virtual card, 400 for a malformed address; no body keeps the stored address', async () => {
    const physical = await setup()
    expectError(await act(physical.card.cardHayId!, 'convert'), 422, /^INVALID_CARD_TYPE/)
    const virtual = await setup({ cardType: 'VIRTUAL' })
    expectError(await act(virtual.card.cardHayId!, 'convert', { deliveryAddress: { line1: 'x' } }), 400, /^BAD_REQUEST/)
    expect((await act(virtual.card.cardHayId!, 'block')).statusCode).toBe(200)
    expectError(await act(virtual.card.cardHayId!, 'convert'), 422, /^INVALID_CARD_STATUS/)
    expect((await act(virtual.card.cardHayId!, 'unblock', { note: 'ok' })).statusCode).toBe(200)
    expect((await act(virtual.card.cardHayId!, 'convert')).statusCode).toBe(200)
    expect(svc.get(virtual.card.cardHayId!).deliveryAddress).toEqual(ADDRESS)
  })
})

describe('payment preferences', () => {
  it('defaults from the spec; PATCH applies only the provided flags and returns the full set; freezing is not a status change', async () => {
    const { card } = await setup({ cardType: 'VIRTUAL' })
    const id = card.cardHayId!
    expect((await app.inject({ method: 'GET', url: `/v0/cards/${id}/payment-preferences` })).json()).toEqual(DEFAULT_PREFERENCES)
    const patched = await app.inject({ method: 'PATCH', url: `/v0/cards/${id}/payment-preferences`, payload: { cardEnabled: false, contactlessEnabled: true } })
    expect(patched.statusCode).toBe(200)
    expect(patched.json()).toEqual({ ...DEFAULT_PREFERENCES, cardEnabled: false, contactlessEnabled: true })
    expect((await app.inject({ method: 'PATCH', url: `/v0/cards/${id}/payment-preferences`, payload: {} })).json()).toEqual({ ...DEFAULT_PREFERENCES, cardEnabled: false, contactlessEnabled: true })
    expect(await status(id)).toBe('ACTIVE')
    expect(await statuses(id)).toEqual(['ACTIVE'])
    expectError(await app.inject({ method: 'PATCH', url: `/v0/cards/${id}/payment-preferences`, payload: { cardEnabled: 'yes' } }), 400, /^BAD_REQUEST/)
  })

  it('422 INVALID_CARD_STATUS unless the card is ACTIVE (reads still work)', async () => {
    const { card } = await setup()
    const id = card.cardHayId!
    expectError(await app.inject({ method: 'PATCH', url: `/v0/cards/${id}/payment-preferences`, payload: { cardNotPresentEnabled: true } }), 422, /^INVALID_CARD_STATUS/)
    expect((await app.inject({ method: 'GET', url: `/v0/cards/${id}/payment-preferences` })).json()).toEqual(DEFAULT_PREFERENCES)
    expectError(await app.inject({ method: 'GET', url: `/v0/cards/${UNKNOWN_ID}/payment-preferences` }), 404, /^NOT_FOUND: Card/)
  })
})

describe('PIN and CVV', () => {
  it('PIN: enabled by default, blocked after three failures, unblocked (no-op when enabled); changeCardPin needs exactly 4 digits and an ACTIVE / AWAITING_ACTIVATION card', async () => {
    const { card } = await setup()
    const id = card.cardHayId!
    expect((await app.inject({ method: 'GET', url: `/v0/cards/${id}/pin/status` })).json()).toEqual({ enabled: true })
    svc.recordPinFailure(id); svc.recordPinFailure(id)
    expect(svc.pinStatus(id)).toEqual({ enabled: true })
    svc.recordPinFailure(id)
    expect((await app.inject({ method: 'GET', url: `/v0/cards/${id}/pin/status` })).json()).toEqual({ enabled: false })
    expect((await act(id, 'pin/unblock')).statusCode).toBe(200)
    expect(svc.get(id)).toMatchObject({ pinEnabled: true, pinRemainingTries: 3 })
    expect((await act(id, 'pin/unblock')).statusCode).toBe(200)

    expectError(await app.inject({ method: 'PUT', url: `/v0/cards/${id}/pin`, payload: { newPin: '12345' } }), 400, /^BAD_REQUEST/)
    expectError(await app.inject({ method: 'PUT', url: `/v0/cards/${id}/pin`, payload: { newPin: 'abcd' } }), 400, /^BAD_REQUEST/)
    expectError(await app.inject({ method: 'PUT', url: `/v0/cards/${id}/pin`, payload: {} }), 400, /^BAD_REQUEST/)
    const changed = await app.inject({ method: 'PUT', url: `/v0/cards/${id}/pin`, payload: { newPin: '9876' } })
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toEqual({ message: expect.any(String) })
    expect(svc.verifyPin(id, '9876')).toBe(true)
    expect(svc.verifyPin(id, '1234')).toBe(false)

    expect((await act(id, 'block')).statusCode).toBe(200)
    expectError(await app.inject({ method: 'PUT', url: `/v0/cards/${id}/pin`, payload: { newPin: '1111' } }), 422, /^INVALID_CARD_STATUS/)
    expect((await act(id, 'cancel')).statusCode).toBe(200)
    expectError(await act(id, 'pin/unblock'), 422, /^INVALID_CARD_STATUS/)
    expect((await app.inject({ method: 'GET', url: `/v0/cards/${id}/pin/status` })).statusCode).toBe(200)
  })

  it('CVV: 3 tries, decremented by failures, blocked at 0, reset by unblock (no-op at 3); terminal cards refuse the unblock', async () => {
    const { card } = await setup({ cardType: 'VIRTUAL' })
    const id = card.cardHayId!
    expect((await app.inject({ method: 'GET', url: `/v0/cards/${id}/cvv/status` })).json()).toEqual({ cvvRemainingTries: 3 })
    svc.recordCvvFailure(id)
    expect(svc.cvvStatus(id)).toEqual({ cvvRemainingTries: 2 })
    svc.blockCvv(id)
    expect((await app.inject({ method: 'GET', url: `/v0/cards/${id}/cvv/status` })).json()).toEqual({ cvvRemainingTries: 0 })
    svc.recordCvvFailure(id)
    expect(svc.cvvStatus(id)).toEqual({ cvvRemainingTries: 0 })
    expect((await act(id, 'cvv/unblock')).statusCode).toBe(200)
    expect(svc.cvvStatus(id)).toEqual({ cvvRemainingTries: 3 })
    expect((await act(id, 'cvv/unblock')).statusCode).toBe(200)
    svc.setExpiryDate(id, '2010-06-30')
    expectError(await act(id, 'cvv/unblock'), 422, /^INVALID_CARD_STATUS: .* EXPIRED/)
    expectError(await act(UNKNOWN_ID, 'cvv/unblock'), 404, /^NOT_FOUND: Card/)
  })
})

describe('reissueHayCard', () => {
  it('voids the old card and issues a new one with a new PAN / token / expiry, copied configuration and PIN, default preferences and fresh tries; wallets of the old card are disabled; both webhooks fire', async () => {
    const { customer, account, card } = await setup({ cardType: 'VIRTUAL', nameOnCard: 'M SMITH', nameOnCardLine2: 'Trading', deliveryMethod: 'EXPRESS', cardSubDesign: 'SUB_DESIGN_3', pin: '2468' })
    const id = card.cardHayId!
    svc.provisionWallet(id, 'APPLE_WALLET')
    await app.inject({ method: 'PATCH', url: `/v0/cards/${id}/payment-preferences`, payload: { cardNotPresentEnabled: true } })
    svc.recordCvvFailure(id)
    const res = await act(id, 're-issue', { idempotencyKey: randomUUID() })
    expect(res.statusCode, res.body).toBe(200)
    const fresh = res.json() as HayCard
    expect(fresh.cardHayId).not.toBe(id)
    expect(fresh).toMatchObject({ accountHayId: account, customerHayId: customer, cardStatus: 'AWAITING_ACTIVATION', cardType: 'PHYSICAL', deliveryMethod: 'STANDARD', nameOnCard: 'M SMITH', nameOnCardLine2: 'Trading' })
    expect(fresh.cardToken).not.toBe(card.cardToken)
    expect(svc.get(fresh.cardHayId!).pan).not.toBe(svc.get(id).pan)
    expect(fresh).not.toHaveProperty('renewedIntoCardId')
    expect(svc.get(fresh.cardHayId!)).toMatchObject({ cardSubDesign: 'SUB_DESIGN_3', deliveryAddress: ADDRESS, phoneNumber: PHONE, preferences: DEFAULT_PREFERENCES, cvvRemainingTries: 3, pinEnabled: true, rewardsEnrolled: false })
    expect(svc.verifyPin(fresh.cardHayId!, '2468')).toBe(true)

    const old = await getCard(id)
    expect(old.cardStatus).toBe('INACTIVE')
    expect(old.voidDateTimeUtc).toMatch(ISO_MICROS)
    expect(old).not.toHaveProperty('renewedIntoCardId')
    expect(svc.get(id).replacedByCardId).toBe(fresh.cardHayId)
    expect((await app.inject({ method: 'GET', url: `/v0/cards/${id}/digital-wallets` })).json().wallets[0].digitalWalletStatus).toBe('INACTIVE_TOKEN')
    expect((await app.inject({ method: 'GET', url: `/v0/cards/${fresh.cardHayId}/digital-wallets` })).json()).toEqual({ wallets: [] })
    expect(await statuses(id)).toEqual(['ACTIVE', 'INACTIVE'])
    expect(await statuses(fresh.cardHayId!)).toEqual(['AWAITING_ACTIVATION'])
    // the old token no longer resolves to a usable card, the new one does
    expect(svc.byToken(card.cardToken!)?.status).toBe('INACTIVE')
    expect(svc.byToken(fresh.cardToken!)?.id).toBe(fresh.cardHayId)
  })

  it('honours cardType / deliveryAddress / deliveryMethod overrides (a VIRTUAL replacement is ACTIVE), replays by idempotencyKey, and is allowed from BLOCKED and EXPIRED but not AWAITING_ACTIVATION / INACTIVE', async () => {
    const { customer, account } = await setup()
    const blocked = await newCard(account, customer, { cardType: 'VIRTUAL' })
    expect((await act(blocked.cardHayId!, 'block')).statusCode).toBe(200)
    const body = { idempotencyKey: randomUUID(), cardType: 'VIRTUAL', deliveryAddress: { line1: '5 Other Rd', countryCodeIso: 'NZL' }, deliveryMethod: 'REGISTERED' }
    const a = await act(blocked.cardHayId!, 're-issue', body)
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json()).toMatchObject({ cardStatus: 'ACTIVE', cardType: 'VIRTUAL', deliveryMethod: 'REGISTERED' })
    expect(svc.get(a.json().cardHayId).deliveryAddress).toEqual({ line1: '5 Other Rd', countryCodeIso: 'NZL' })
    expect(await status(blocked.cardHayId!)).toBe('INACTIVE')
    const replay = await act(blocked.cardHayId!, 're-issue', body)
    expect(replay.json()).toEqual(a.json())
    expectError(await act(blocked.cardHayId!, 're-issue', { ...body, deliveryMethod: 'COURIER' }), 422, /^IDEMPOTENCY_KEY_REUSED/)
    expectError(await act(blocked.cardHayId!, 're-issue', { idempotencyKey: randomUUID() }), 422, /^INVALID_CARD_STATUS: Card .* cannot be re-issued from status INACTIVE/)

    const expired = await newCard(account, customer, { cardType: 'VIRTUAL' })
    svc.setExpiryDate(expired.cardHayId!, '2015-03-31')
    expect((await act(expired.cardHayId!, 're-issue', { idempotencyKey: randomUUID() })).statusCode).toBe(200)

    const awaiting = await newCard(account, customer)
    expectError(await act(awaiting.cardHayId!, 're-issue', { idempotencyKey: randomUUID() }), 422, /^INVALID_CARD_STATUS: Card .* cannot be re-issued from status AWAITING_ACTIVATION/)
    expectError(await act(awaiting.cardHayId!, 're-issue', {}), 400, /^BAD_REQUEST/)
    expectError(await act(UNKNOWN_ID, 're-issue', { idempotencyKey: randomUUID() }), 404, /^NOT_FOUND: Card/)
  })

  it('applies the customer / account gate: a BLOCKED cardholder cannot re-issue', async () => {
    const { customer, card } = await setup({ cardType: 'VIRTUAL' })
    expect((await app.inject({ method: 'POST', url: `/v0/customers/${customer}/block`, payload: { note: 'x' } })).statusCode).toBe(200)
    expectError(await act(card.cardHayId!, 're-issue', { idempotencyKey: randomUUID() }), 422, /^PERMISSION_DENIED: Card cannot be created for customer .* BLOCKED/)
    expect(await status(card.cardHayId!)).toBe('ACTIVE')
  })
})

describe('renewCard', () => {
  async function nearExpiry(overrides: Partial<CreateBody> = {}) {
    const s = await setup({ cardType: 'VIRTUAL', ...overrides })
    // move the expiry to the end of next month (inside the 2-month window) instead of moving the clock (other cards in this file must not expire)
    svc.setExpiryDate(s.card.cardHayId!, endOfNextMonth())
    return { ...s, card: await getCard(s.card.cardHayId!) }
  }

  it('422 RENEWAL_WINDOW more than 2 months before expiry; 422 INVALID_CARD_STATUS unless ACTIVE', async () => {
    const { card } = await setup({ cardType: 'VIRTUAL' })
    expectError(await act(card.cardHayId!, 'renew', {}), 422, /^RENEWAL_WINDOW: Card .* within 2 months of its expiry date/)
    const awaiting = await setup()
    expectError(await act(awaiting.card.cardHayId!, 'renew', {}), 422, /^INVALID_CARD_STATUS: Card .* cannot be renewed from status AWAITING_ACTIVATION/)
    expectError(await act(UNKNOWN_ID, 'renew', {}), 404, /^NOT_FOUND: Card/)
    // the window opens exactly 2 months (calendar, day clamped) before the expiry date
    expect(addMonthsClamped(new Date('2027-03-31T00:00:00Z'), -2).toISOString().slice(0, 10)).toBe('2027-01-31')
    expect(addMonthsClamped(new Date('2027-05-31T00:00:00Z'), -2).toISOString().slice(0, 10)).toBe('2027-03-31')
    expect(addMonthsClamped(new Date('2028-04-30T00:00:00Z'), -2).toISOString().slice(0, 10)).toBe('2028-02-29')
  })

  it('renews into a PHYSICAL card with the same PAN and token, a fresh expiry, copied preferences and wallets; the old card stays ACTIVE with renewedIntoCardId until the new card is activated, then goes INACTIVE', async () => {
    const { customer, account, card } = await nearExpiry()
    const id = card.cardHayId!
    await app.inject({ method: 'PATCH', url: `/v0/cards/${id}/payment-preferences`, payload: { contactlessEnabled: true } })
    svc.provisionWallet(id, 'SAMSUNG_WALLET')
    const res = await act(id, 'renew', { deliveryMethod: 'COURIER' })
    expect(res.statusCode, res.body).toBe(200)
    const fresh = res.json() as HayCard
    expect(fresh).toMatchObject({ accountHayId: account, customerHayId: customer, cardStatus: 'AWAITING_ACTIVATION', cardType: 'PHYSICAL', deliveryMethod: 'COURIER', cardToken: card.cardToken, lastFourDigits: card.lastFourDigits })
    expect(fresh.expiryDate! > card.expiryDate!).toBe(true)
    expect(svc.get(fresh.cardHayId!).pan).toBe(svc.get(id).pan)
    expect(svc.get(fresh.cardHayId!).preferences).toEqual({ ...DEFAULT_PREFERENCES, contactlessEnabled: true })
    expect(svc.verifyPin(fresh.cardHayId!, '1234')).toBe(true)

    const old = await getCard(id)
    expect(old).toMatchObject({ cardStatus: 'ACTIVE', renewedIntoCardId: fresh.cardHayId })
    expect(old).not.toHaveProperty('voidDateTimeUtc')
    // wallets moved to the renewal, with the new expiry
    expect((await app.inject({ method: 'GET', url: `/v0/cards/${id}/digital-wallets` })).json()).toEqual({ wallets: [] })
    expect((await app.inject({ method: 'GET', url: `/v0/cards/${fresh.cardHayId}/digital-wallets` })).json().wallets).toEqual([expect.objectContaining({ digitalWalletStatus: 'ACTIVE_TOKEN', type: 'SAMSUNG', expiresAt: fresh.expiryDate })])
    // the shared token resolves to the card that can transact
    expect(svc.byToken(card.cardToken!)?.id).toBe(id)
    expectError(await act(id, 'renew', {}), 422, /^INVALID_CARD_STATUS: Card .* has already been renewed into/)

    expect((await act(fresh.cardHayId!, 'activate')).statusCode).toBe(200)
    expect(await status(fresh.cardHayId!)).toBe('ACTIVE')
    const retired = await getCard(id)
    expect(retired).toMatchObject({ cardStatus: 'INACTIVE', renewedIntoCardId: fresh.cardHayId })
    expect(retired.voidDateTimeUtc).toMatch(ISO_MICROS)
    expect(svc.byToken(card.cardToken!)?.id).toBe(fresh.cardHayId)
    expect((await cardEvents(id)).map((p) => [p.cardStatusChangeEvent.cardStatus, p.actionOwner])).toEqual([['ACTIVE', 'CLIENT'], ['INACTIVE', 'CLIENT']])
    expect(await statuses(fresh.cardHayId!)).toEqual(['AWAITING_ACTIVATION', 'ACTIVE'])
  })

  it('a VIRTUAL renewal is ACTIVE at once and retires the old card immediately', async () => {
    const { card } = await nearExpiry()
    const res = await act(card.cardHayId!, 'renew', { cardType: 'VIRTUAL' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ cardStatus: 'ACTIVE', cardType: 'VIRTUAL', cardToken: card.cardToken })
    expect(await getCard(card.cardHayId!)).toMatchObject({ cardStatus: 'INACTIVE', renewedIntoCardId: res.json().cardHayId })
    expect(svc.byToken(card.cardToken!)?.id).toBe(res.json().cardHayId)
  })
})

describe('rewards', () => {
  it('201 on first enrolment, 200 when already enrolled; status must be ACTIVE; terminal cards are 422', async () => {
    const { card } = await setup({ cardType: 'VIRTUAL' })
    const first = await act(card.cardHayId!, 'rewards', { status: 'ACTIVE' })
    expect(first.statusCode).toBe(201)
    expect(first.json()).toEqual({ status: 'ACTIVE' })
    const again = await act(card.cardHayId!, 'rewards', { status: 'ACTIVE' })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual({ status: 'ACTIVE' })
    expectError(await act(card.cardHayId!, 'rewards', { status: 'INACTIVE' }), 400, /^BAD_REQUEST/)
    expectError(await act(card.cardHayId!, 'rewards', {}), 400, /^BAD_REQUEST: body\/status/)
    expect((await act(card.cardHayId!, 'cancel')).statusCode).toBe(200)
    expectError(await act(card.cardHayId!, 'rewards', { status: 'ACTIVE' }), 422, /^INVALID_CARD_STATUS/)
    expectError(await act(UNKNOWN_ID, 'rewards', { status: 'ACTIVE' }), 404, /^NOT_FOUND: Card/)
  })
})

describe('digital wallets and OEM provisioning', () => {
  it('no wallets until provisioned; provisioning stores an ACTIVE_TOKEN wallet, emits CARD_ADDED_TO_WALLET and needs an ACTIVE card', async () => {
    const { customer, card } = await setup({ cardType: 'VIRTUAL' })
    const id = card.cardHayId!
    expect((await app.inject({ method: 'GET', url: `/v0/cards/${id}/digital-wallets` })).json()).toEqual({ wallets: [] })
    const w = svc.provisionWallet(id, 'APPLE_WALLET')
    svc.provisionWallet(id, 'ANDROID_WALLET')
    const details = (await app.inject({ method: 'GET', url: `/v0/cards/${id}/digital-wallets` })).json()
    expect(details.primaryAccountIdentifier).toMatch(/^V[A-Z0-9]{28}$/)
    expect(details.wallets).toEqual([
      { createdAt: expect.stringMatching(ISO_MICROS), digitalWalletStatus: 'ACTIVE_TOKEN', expiresAt: card.expiryDate, reference: w.reference, type: 'APPLE' },
      expect.objectContaining({ type: 'GOOGLE', digitalWalletStatus: 'ACTIVE_TOKEN' }),
    ])
    const added = (await allPayloads()).filter((p) => p.type === 'CARD_ADDED_TO_WALLET' && p.cardHayId === id)
    expect(added).toHaveLength(2)
    expect(added[0]).toEqual({
      idempotencyKey: expect.stringMatching(UUID_RE), customerHayId: customer, type: 'CARD_ADDED_TO_WALLET', actionOwner: 'PLATFORM', cardHayId: id, productId: expect.stringMatching(UUID_RE),
      cardAdditionToWalletEvent: { cardHayId: id, cardLastFourDigits: card.lastFourDigits, walletType: 'APPLE_WALLET', activationCode: expect.stringMatching(/^\d{6}$/) },
    })
    const awaiting = await setup()
    expect(() => svc.provisionWallet(awaiting.card.cardHayId!, 'APPLE_WALLET')).toThrow(/INVALID_CARD_STATUS/)
    expectError(await app.inject({ method: 'GET', url: `/v0/cards/${UNKNOWN_ID}/digital-wallets` }), 404, /^NOT_FOUND: Card/)
  })

  it('OEM provisioning data carries the name on card, token and expiry with a fresh 6-digit OTP per call', async () => {
    const { card } = await setup({ nameOnCard: 'M SMITH' })
    const a = (await app.inject({ method: 'GET', url: `/v0/cards/${card.cardHayId}/oem-provisioning-data` })).json()
    const b = (await app.inject({ method: 'GET', url: `/v0/cards/${card.cardHayId}/oem-provisioning-data` })).json()
    expect(a).toEqual({ cardHolderName: 'M SMITH', cardToken: card.cardToken, expiryDate: card.expiryDate, otp: expect.stringMatching(/^\d{6}$/) })
    expect(b.otp).toMatch(/^\d{6}$/)
    expectError(await app.inject({ method: 'GET', url: `/v0/cards/${UNKNOWN_ID}/oem-provisioning-data` }), 404, /^NOT_FOUND: Card/)
  })
})

describe('expiry: reminders and the EXPIRED flip', () => {
  it('sends CARD_EXPIRY_MONTH / 2_WEEK / DAY reminders once each as the clock approaches expiry, then flips ACTIVE and AWAITING_ACTIVATION cards to EXPIRED (PLATFORM); BLOCKED cards keep their status; a renewed card gets no reminders', async () => {
    const { customer, account } = await setup({ cardType: 'VIRTUAL' })
    const active = await newCard(account, customer, { cardType: 'VIRTUAL' })
    const awaiting = await newCard(account, customer)
    const blocked = await newCard(account, customer, { cardType: 'VIRTUAL' })
    const renewed = await newCard(account, customer, { cardType: 'VIRTUAL' })
    expect((await act(blocked.cardHayId!, 'block')).statusCode).toBe(200)
    svc.setExpiryDate(renewed.cardHayId!, endOfNextMonth())
    expect((await act(renewed.cardHayId!, 'renew', {})).statusCode).toBe(200) // PHYSICAL renewal: the old card stays ACTIVE, flagged renewedIntoCardId
    for (const c of [active, awaiting, blocked, renewed]) svc.setExpiryDate(c.cardHayId!, '2031-03-15')
    expect((await getCard(active.cardHayId!)).expiryDate).toBe('2031-03-31')
    expect((await getCard(renewed.cardHayId!))).toMatchObject({ cardStatus: 'ACTIVE', renewedIntoCardId: expect.stringMatching(UUID_RE) })
    const reminders = async (id: string) => (await allPayloads()).filter((p) => p.type === 'REMINDER' && p.cardHayId === id).map((p) => p.reminderType)
    try {
      await setClock({ freeze: '2031-01-31T00:00:00Z' })
      expect(await reminders(active.cardHayId!)).toEqual([])
      await setClock({ freeze: '2031-02-28T10:00:00Z' })
      expect(await reminders(active.cardHayId!)).toEqual(['CARD_EXPIRY_MONTH_REMINDER'])
      await setClock({ freeze: '2031-03-10T00:00:00Z' })
      expect(await reminders(active.cardHayId!)).toEqual(['CARD_EXPIRY_MONTH_REMINDER'])
      await setClock({ freeze: '2031-03-17T00:00:00Z' })
      expect(await reminders(active.cardHayId!)).toEqual(['CARD_EXPIRY_MONTH_REMINDER', 'CARD_EXPIRY_2_WEEK_REMINDER'])
      await setClock({ freeze: '2031-03-30T23:59:59Z' })
      expect(await reminders(active.cardHayId!)).toEqual(['CARD_EXPIRY_MONTH_REMINDER', 'CARD_EXPIRY_2_WEEK_REMINDER', 'CARD_EXPIRY_DAY_REMINDER'])
      await setClock({ freeze: '2031-03-31T23:00:00Z' }) // still valid on the expiry date itself
      expect(await status(active.cardHayId!)).toBe('ACTIVE')
      for (const c of [awaiting, blocked]) expect(await reminders(c.cardHayId!)).toHaveLength(3)
      expect(await reminders(renewed.cardHayId!)).toEqual([])
      const reminder = (await allPayloads()).find((p) => p.type === 'REMINDER' && p.cardHayId === active.cardHayId)
      expect(reminder).toEqual({
        idempotencyKey: expect.stringMatching(UUID_RE), customerHayId: customer, type: 'REMINDER', actionOwner: 'PLATFORM', cardHayId: active.cardHayId, productId: expect.stringMatching(UUID_RE),
        reminderType: 'CARD_EXPIRY_MONTH_REMINDER', cardExpiryReminderEvent: { cardId: active.cardHayId, expirationMonth: 3, expirationYear: 2031 },
      })

      await setClock({ freeze: '2031-04-01T00:00:00Z' })
      expect(await status(active.cardHayId!)).toBe('EXPIRED')
      expect(await status(awaiting.cardHayId!)).toBe('EXPIRED')
      expect(await status(blocked.cardHayId!)).toBe('BLOCKED')
      const expiredEvent = (await cardEvents(active.cardHayId!)).at(-1)
      expect(expiredEvent).toMatchObject({ actionOwner: 'PLATFORM', cardStatusChangeEvent: { cardStatus: 'EXPIRED', cardHayId: active.cardHayId, accountHayId: account } })
      expect(await reminders(active.cardHayId!)).toHaveLength(3) // nothing more once expired
      // EXPIRED is terminal except for cancel / re-issue
      expectError(await act(active.cardHayId!, 'activate'), 422, /^INVALID_CARD_STATUS/)
      expectError(await act(active.cardHayId!, 'renew', {}), 422, /^INVALID_CARD_STATUS: Card .* cannot be renewed from status EXPIRED/)
      expectError(await app.inject({ method: 'PATCH', url: `/v0/cards/${active.cardHayId}/payment-preferences`, payload: { cardEnabled: true } }), 422, /^INVALID_CARD_STATUS/)
    } finally {
      await setClock({ reset: true })
    }
  })

  it('setExpiryDate (utilities) normalises to the month end, restarts reminders, expires a card whose new date is past, and rejects a malformed date', async () => {
    const { card } = await setup({ cardType: 'VIRTUAL' })
    const id = card.cardHayId!
    expect(svc.setExpiryDate(id, '2029-02-10').expiryDate).toBe('2029-02-28')
    expect(svc.setExpiryDate(id, '2028-02-01').expiryDate).toBe('2028-02-29')
    expect(await status(id)).toBe('ACTIVE')
    expect(() => svc.setExpiryDate(id, '2029-13-01')).toThrow(/BAD_REQUEST/)
    expect(() => svc.setExpiryDate(id, '2029-02-30')).toThrow(/BAD_REQUEST/)
    expect(() => svc.setExpiryDate(id, 'tomorrow')).toThrow(/BAD_REQUEST/)
    const past = svc.setExpiryDate(id, '2020-06-01')
    expect(past).toMatchObject({ status: 'EXPIRED', expiryDate: '2020-06-30' })
    expect((await cardEvents(id)).map((p) => [p.cardStatusChangeEvent.cardStatus, p.actionOwner])).toEqual([['ACTIVE', 'CLIENT'], ['EXPIRED', 'PLATFORM']])
    expect(() => svc.setExpiryDate(UNKNOWN_ID, '2030-01-01')).toThrow(/NOT_FOUND/)
  })
})

describe('account closure cascade (ctx.services.cards.cancelAllForAccount)', () => {
  it('closeAccount voids every card that is not INACTIVE with CARD_STATUS_CHANGE {INACTIVE} (PLATFORM) and restricts to one cardholder when asked', async () => {
    const customer = await newCustomer()
    const account = await newAccount(customer)
    const active = await newCard(account, customer, { cardType: 'VIRTUAL' })
    const awaiting = await newCard(account, customer)
    const gone = await newCard(account, customer, { cardType: 'VIRTUAL' })
    expect((await act(gone.cardHayId!, 'cancel')).statusCode).toBe(200)
    const before = (await cardEvents(gone.cardHayId!)).length
    const res = await app.inject({ method: 'POST', url: `/v0/accounts/${account}/close`, payload: { reason: 'CUSTOMER' } })
    expect(res.statusCode, res.body).toBe(202)
    await flush()
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${account}` })).json().status).toBe('CLOSED')
    for (const c of [active, awaiting]) {
      expect(await status(c.cardHayId!)).toBe('INACTIVE')
      expect((await cardEvents(c.cardHayId!)).at(-1)).toMatchObject({ actionOwner: 'PLATFORM', cardStatusChangeEvent: { cardStatus: 'INACTIVE' } })
    }
    expect((await cardEvents(gone.cardHayId!)).length).toBe(before)

    const other = await newCustomer()
    const account2 = await newAccount(other)
    const keep = await newCard(account2, other, { cardType: 'VIRTUAL' })
    svc.cancelAllForAccount(account2, 'CUSTOMER', { customerId: UNKNOWN_ID })
    expect(await status(keep.cardHayId!)).toBe('ACTIVE')
    svc.cancelAllForAccount(account2, 'CUSTOMER', { customerId: other })
    expect(await status(keep.cardHayId!)).toBe('INACTIVE')
  })
})

describe('authorisation checks (ctx.services.cards.authorise)', () => {
  it('status: BLOCKED, EXPIRED, AWAITING_ACTIVATION and INACTIVE cards refuse with the documented vocabulary; an ACTIVE card with a chip payment passes', async () => {
    const customer = await newCustomer()
    const account = await newAccount(customer)
    const active = await newCard(account, customer, { cardType: 'VIRTUAL' })
    const awaiting = await newCard(account, customer)
    const blocked = await newCard(account, customer, { cardType: 'VIRTUAL' })
    const expired = await newCard(account, customer, { cardType: 'VIRTUAL' })
    const gone = await newCard(account, customer, { cardType: 'VIRTUAL' })
    expect((await act(blocked.cardHayId!, 'block')).statusCode).toBe(200)
    svc.setExpiryDate(expired.cardHayId!, '2019-12-31')
    expect((await act(gone.cardHayId!, 'cancel')).statusCode).toBe(200)
    expect(svc.authorise(active.cardHayId!, { cardUsage: USAGE.chip })).toBeNull()
    expect(svc.authorise(active.cardToken!, { cardUsage: USAGE.chip })).toBeNull()
    expect(svc.authorise(blocked.cardHayId!, { cardUsage: USAGE.chip })).toEqual({ outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome: 'CARD_BLOCKED', cardProcessorResponse: 'REFUSED_CARD_BLOCKED', reason: expect.stringContaining('BLOCKED') })
    expect(svc.authorise(expired.cardHayId!, { cardUsage: USAGE.chip })).toEqual({ outcome: 'REFUSED_RULES', cardPreferenceOutcome: 'OK', cardProcessorResponse: 'EXPIRED_CARD', reason: expect.stringContaining('expired') })
    expect(svc.authorise(awaiting.cardHayId!, { cardUsage: USAGE.chip })).toMatchObject({ outcome: 'REFUSED_RULES', cardPreferenceOutcome: 'OK', cardProcessorResponse: 'CARD_IS_NOT_ACTIVE' })
    expect(svc.authorise(gone.cardHayId!, { cardUsage: USAGE.chip })).toMatchObject({ outcome: 'REFUSED_RULES', cardProcessorResponse: 'CARD_IS_NOT_ACTIVE' })
    // a card whose expiry date passed but which the tick has not flipped yet is refused as expired too
    const stale = svc.get(active.cardHayId!)
    stale.expiryDate = '2020-01-31'
    expect(svc.authorise(stale, { cardUsage: USAGE.chip })).toMatchObject({ cardProcessorResponse: 'EXPIRED_CARD' })
    expect(() => svc.authorise('000000001', {})).toThrow(/NOT_FOUND/)
  })

  it('preferences: each channel flag refuses with its cardPreferenceOutcome; cardEnabled false freezes everything except wallet payments', async () => {
    const { card } = await setup({ cardType: 'VIRTUAL' })
    const id = card.cardHayId!
    const prefs = async (patch: object) => { expect((await app.inject({ method: 'PATCH', url: `/v0/cards/${id}/payment-preferences`, payload: patch })).statusCode).toBe(200) }
    // defaults: chip and wallet allowed, contactless / magstripe / CNP / ATM disabled
    expect(svc.authorise(id, { cardUsage: USAGE.chip })).toBeNull()
    expect(svc.authorise(id, { cardUsage: USAGE.wallet })).toBeNull()
    expect(svc.authorise(id, { type: 'CARD_PRESENT_PAYMENT' })).toBeNull()
    expect(svc.authorise(id, { cardUsage: USAGE.contactless })).toMatchObject({ outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome: 'CONTACTLESS_DISABLED' })
    expect(svc.authorise(id, { cardUsage: USAGE.magstripe })).toMatchObject({ outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome: 'MAGNETIC_STRIPE_PAYMENT_DISABLED' })
    expect(svc.authorise(id, { cardUsage: USAGE.cnp })).toMatchObject({ outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome: 'CARD_NOT_PRESENT_DISABLED' })
    expect(svc.authorise(id, {})).toMatchObject({ cardPreferenceOutcome: 'CARD_NOT_PRESENT_DISABLED' })
    expect(svc.authorise(id, { cardUsage: USAGE.atm })).toMatchObject({ outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome: 'CASH_WITHDRAWAL_DISABLED' })
    expect(svc.authorise(id, { type: 'ATM_WITHDRAWAL' })).toMatchObject({ cardPreferenceOutcome: 'CASH_WITHDRAWAL_DISABLED' })
    for (const r of [svc.authorise(id, { cardUsage: USAGE.contactless })!, svc.authorise(id, { cardUsage: USAGE.cnp })!]) expect(r).not.toHaveProperty('cardProcessorResponse')

    await prefs({ contactlessEnabled: true, magneticStripeEnabled: true, cardNotPresentEnabled: true, cashWithdrawalEnabled: true })
    for (const usage of Object.values(USAGE)) expect(svc.authorise(id, { cardUsage: usage })).toBeNull()

    await prefs({ cardEnabled: false })
    for (const usage of [USAGE.chip, USAGE.contactless, USAGE.magstripe, USAGE.cnp, USAGE.atm]) {
      expect(svc.authorise(id, { cardUsage: usage })).toMatchObject({ outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome: 'CARD_FROZEN' })
    }
    expect(svc.authorise(id, { cardUsage: USAGE.wallet })).toBeNull()
    await prefs({ mobileWalletPaymentsEnabled: false })
    expect(svc.authorise(id, { cardUsage: USAGE.wallet })).toMatchObject({ outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome: 'MOBILE_WALLET_PAYMENT_DISABLED' })
  })

  it('a blocked PIN refuses ATM and chip payments (not contactless or wallet); a blocked CVV refuses card-not-present payments; explicit pinEntered / cvvEntered override the defaults', async () => {
    const { card } = await setup({ cardType: 'VIRTUAL' })
    const id = card.cardHayId!
    await app.inject({ method: 'PATCH', url: `/v0/cards/${id}/payment-preferences`, payload: { contactlessEnabled: true, cardNotPresentEnabled: true, cashWithdrawalEnabled: true } })
    svc.blockPin(id)
    expect(svc.authorise(id, { cardUsage: USAGE.atm })).toEqual({ outcome: 'REFUSED_RULES', cardPreferenceOutcome: 'OK', cardProcessorResponse: 'ALLOWED_PIN_RETRIES_EXCEEDED', reason: expect.stringContaining('PIN') })
    expect(svc.authorise(id, { cardUsage: USAGE.chip })).toMatchObject({ cardProcessorResponse: 'ALLOWED_PIN_RETRIES_EXCEEDED' })
    expect(svc.authorise(id, { cardUsage: USAGE.contactless })).toBeNull()
    expect(svc.authorise(id, { cardUsage: USAGE.wallet })).toBeNull()
    expect(svc.authorise(id, { cardUsage: USAGE.cnp })).toBeNull()
    expect(svc.authorise(id, { cardUsage: USAGE.chip, pinEntered: false })).toBeNull()
    expect(svc.authorise(id, { cardUsage: USAGE.contactless, pinEntered: true })).toMatchObject({ cardProcessorResponse: 'ALLOWED_PIN_RETRIES_EXCEEDED' })
    svc.unblockPin(id)
    expect(svc.authorise(id, { cardUsage: USAGE.chip })).toBeNull()

    svc.blockCvv(id)
    expect(svc.authorise(id, { cardUsage: USAGE.cnp })).toEqual({ outcome: 'REFUSED_RULES', cardPreferenceOutcome: 'OK', cardProcessorResponse: 'CVV2_FAILURE', reason: expect.stringContaining('CVV') })
    expect(svc.authorise(id, { cardUsage: USAGE.chip })).toBeNull()
    expect(svc.authorise(id, { cardUsage: USAGE.cnp, cvvEntered: false })).toBeNull()
    expect(svc.authorise(id, { cardUsage: USAGE.chip, cvvEntered: true })).toMatchObject({ cardProcessorResponse: 'CVV2_FAILURE' })
    // the third wrong CVV blocks it
    svc.unblockCvv(id)
    svc.recordCvvFailure(id); svc.recordCvvFailure(id)
    expect(svc.authorise(id, { cardUsage: USAGE.cnp })).toBeNull()
    svc.recordCvvFailure(id)
    expect(svc.authorise(id, { cardUsage: USAGE.cnp })).toMatchObject({ cardProcessorResponse: 'CVV2_FAILURE' })
  })

  it('authoriseHold drives the ledger: an accepted hold reserves funds and emits CARD_TRANSACTION; a card-side refusal holds nothing and emits the refused outcome; a caller decline wins', async () => {
    const { customer, account, card } = await setup({ cardType: 'VIRTUAL' }, { lowRisk: true })
    await credit(account, 100)
    const accepted = svc.authoriseHold(card.cardToken!, { amountCents: 2550, cardUsage: USAGE.chip, merchant: MERCHANT, description: 'IGA purchase' })
    expect(accepted.outcome).toBe('ACCEPTED')
    expect(accepted.card.id).toBe(card.cardHayId)
    expect(accepted.hold).toMatchObject({ cardId: card.cardHayId, cardToken: card.cardToken, lastFour: card.lastFourDigits, accountId: account, amount: 2550, channel: 'VISA_CARD_PRESENT', state: 'AUTHORISED' })
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${account}` })).json()).toMatchObject({ totalBalance: 100, heldBalance: 25.5, availableBalance: 74.5 })
    const txEvents = async () => (await allPayloads()).filter((p) => p.type === 'TRANSACTION' && p.transactionEvent?.accountHayId === account && p.transactionEvent.transactionType !== 'GENERAL_CREDIT')
    let events = await txEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ customerHayId: customer, transactionEvent: { transactionType: 'CARD_TRANSACTION', outcome: 'ACCEPTED', isPending: true, cardHayId: card.cardHayId, holdHayId: accepted.hold!.id, currencyAmount: { amount: -25.5, currency: 'AUD' }, counterpartName: MERCHANT.name } })

    const refused = svc.authoriseHold(card.cardHayId!, { amountCents: 1000, cardUsage: USAGE.contactless, merchant: MERCHANT })
    expect(refused).toMatchObject({ outcome: 'REFUSED_CARD_PREFERENCE' })
    expect(refused.hold).toBeUndefined()
    expect((await app.inject({ method: 'GET', url: `/v0/accounts/${account}` })).json()).toMatchObject({ heldBalance: 25.5, availableBalance: 74.5 })
    events = await txEvents()
    expect(events).toHaveLength(2)
    expect(events[1].transactionEvent).toMatchObject({ transactionType: 'CARD_TRANSACTION', outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome: 'CONTACTLESS_DISABLED', isPending: false, cardHayId: card.cardHayId, currencyAmount: { amount: -10, currency: 'AUD' } })
    expect(events[1].transactionEvent).not.toHaveProperty('cardProcessorResponse')

    const declined = svc.authoriseHold(card.cardHayId!, { amountCents: 500, cardUsage: USAGE.chip, refusal: { outcome: 'REFUSED_RULES', cardPreferenceOutcome: 'OK', cardProcessorResponse: 'INVALID_MERCHANT' } })
    expect(declined.outcome).toBe('REFUSED_RULES')
    expect((await txEvents()).at(-1).transactionEvent).toMatchObject({ outcome: 'REFUSED_RULES', cardPreferenceOutcome: 'OK', cardProcessorResponse: 'INVALID_MERCHANT' })

    // the ledger's own checks still apply after the card passes: funds
    expect(svc.authoriseHold(card.cardHayId!, { amountCents: 10_000, cardUsage: USAGE.chip }).outcome).toBe('REFUSED_NOT_ENOUGH_FUNDS')
    expect(() => svc.authoriseHold(UNKNOWN_ID, { amountCents: 1 })).toThrow(/NOT_FOUND: Card/)
    expect(svc.cardContext(svc.get(card.cardHayId!), { cardUsage: USAGE.atm })).toEqual({ cardHayId: card.cardHayId, cardToken: card.cardToken, lastFour: card.lastFourDigits, cardUsage: USAGE.atm })
  })
})
