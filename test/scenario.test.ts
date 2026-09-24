/**
 * End-to-end journeys through the real HTTP API, the way an integrating system sees the server: the app
 * listens on a port, every /v0 and /v1 call carries a bearer token from /oauth2/token (auth ON), and
 * notifications are POSTed to a real webhook receiver started by the test. Waiting is promise-based
 * (POST /_admin/flush, Receiver.waitFor) — no sleeps. Responses are contract-validated (startApp turns
 * validateResponses on), notifications are validated against wh:NotificationDto.
 */
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import type { BuiltServer } from '../src/server.js'
import { startApp } from './helpers.js'
import { assertValidNotification } from './webhook-schema.js'

const PRODUCT_ID = 'a1b2c3d4-0000-4000-8000-000000000001'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** First webhook retry delay of the test servers (doubles per attempt). */
const BACKOFF_MS = 40

// ---------------------------------------------------------------------------------------------- receiver

interface Delivery { path: string; body: any; status: number; at: number }

/** A tiny webhook endpoint: records every POST, answers 200 unless told otherwise (respondWith), and lets tests await deliveries. */
class Receiver {
  readonly deliveries: Delivery[] = []
  private readonly script: number[] = []
  private readonly waiters = new Set<() => void>()
  private readonly server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const status = this.script.shift() ?? 200
      this.deliveries.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')), status, at: Date.now() })
      res.writeHead(status).end()
      for (const w of [...this.waiters]) w()
    })
  })
  url = ''

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/hooks`
    return this
  }
  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()))
    this.server.closeAllConnections() // the dispatcher's keep-alive sockets would otherwise hold close() open
    await closed
  }
  /** Status codes for the next deliveries, in order (then 200 again). */
  respondWith(...statuses: number[]): void {
    this.script.push(...statuses)
  }
  /** Notifications the receiver accepted (answered 2xx), in arrival order. */
  accepted(filter: (n: any) => boolean = () => true): any[] {
    return this.deliveries.filter((d) => d.status < 300).map((d) => d.body).filter(filter)
  }
  /** Accepted notifications addressed to the customer. */
  for(customerHayId: string): any[] {
    return this.accepted((n) => n.customerHayId === customerHayId)
  }
  /** Resolves with the first truthy value `probe` returns, re-evaluated after every delivery. */
  waitFor<T>(probe: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
    const now = probe()
    if (now) return Promise.resolve(now)
    return new Promise<T>((resolve, reject) => {
      const check = () => {
        const v = probe()
        if (!v) return
        this.waiters.delete(check)
        clearTimeout(timer)
        resolve(v)
      }
      const timer = setTimeout(() => {
        this.waiters.delete(check)
        reject(new Error(`receiver: condition not met within ${timeoutMs} ms (${this.deliveries.length} deliveries)`))
      }, timeoutMs)
      this.waiters.add(check)
    })
  }
  /** Waits until the customer has received at least `count` notifications and returns them. */
  async waitForCount(customerHayId: string, count: number): Promise<any[]> {
    return this.waitFor(() => (this.for(customerHayId).length >= count ? this.for(customerHayId) : undefined))
  }
}

// ---------------------------------------------------------------------------------------------- client

interface Res { status: number; body: any; headers: Headers }

/** An integrating system's view: base URL + client credentials. */
class Client {
  token = ''
  constructor(readonly base: string) {}

  async login(clientId = 'local-client', clientSecret = 'local-secret'): Promise<void> {
    const res = await fetch(`${this.base}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { access_token: string; token_type: string; expires_in: number }
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 })
    this.token = body.access_token
  }

  async call(method: string, path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<Res> {
    const headers: Record<string, string> = {}
    if (opts.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers }
  }
  get(path: string) { return this.call('GET', path) }
  post(path: string, body?: unknown) { return this.call('POST', path, body) }
  patch(path: string, body?: unknown) { return this.call('PATCH', path, body) }
  put(path: string, body?: unknown) { return this.call('PUT', path, body) }

  /** Expects the status and returns the body. */
  async ok(method: string, path: string, body?: unknown, status = 200): Promise<any> {
    const res = await this.call(method, path, body)
    expect(res.status, `${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`).toBe(status)
    return res.body
  }

  /** Waits for deferred work and webhook deliveries to settle. */
  async flush(): Promise<void> {
    expect((await this.call('POST', '/_admin/flush')).status).toBe(200)
  }
  /** Waits for webhook deliveries only: safe while deferred work is pending on the virtual clock. */
  async flushNotifications(): Promise<void> {
    expect((await this.call('POST', '/_admin/notifications/flush')).status).toBe(200)
  }
  async advanceClock(ms: number): Promise<void> {
    expect((await this.call('POST', '/_admin/clock', { advanceMs: ms })).status).toBe(200)
  }
}

// ---------------------------------------------------------------------------------------------- environment

interface Env { built: BuiltServer; receiver: Receiver; api: Client }

async function startEnv(overrides: Partial<Config> = {}): Promise<Env> {
  const receiver = await new Receiver().start()
  const built = await startApp({ auth: true, webhookUrl: receiver.url, webhookBackoffMs: BACKOFF_MS, ...overrides })
  await built.app.listen({ port: 0, host: '127.0.0.1' })
  const api = new Client(`http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`)
  await api.login()
  return { built, receiver, api }
}
async function stopEnv(env: Env | undefined): Promise<void> {
  if (!env) return
  await env.built.app.close()
  await env.receiver.close()
}

// ---------------------------------------------------------------------------------------------- domain helpers

let seq = 0
function customerBody(tag = ''): Record<string, unknown> {
  seq++
  return {
    idempotencyKey: randomUUID(),
    email: `scenario${seq}${tag ? `+${tag}` : ''}@example.com`,
    customerTier: 'STANDARD',
    phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: `4${String(seq).padStart(8, '0')}` },
    address: { line1: '395 Bourke St', townOrCity: 'Melbourne', administrativeRegion: 'VIC', postcode: '3000', countryCodeIso: 'AUS' },
    customerDetails: { firstName: 'Jane', lastName: `Scenario${seq}`, dateOfBirth: '1990-01-01' },
  }
}

/** Creates a customer and waits for the asynchronous onboarding outcome (ACTIVE by default). */
async function onboard(api: Client, tag = ''): Promise<string> {
  const c = await api.ok('POST', '/v0/customers/create', customerBody(tag))
  expect(c.status).toBe('PENDING_APPROVAL')
  await api.flush()
  return c.customerHayId as string
}
async function openAccount(api: Client, holder: string, opts: { lowRisk?: boolean } = {}): Promise<any> {
  const a = await api.ok('POST', '/v1/accounts', { idempotencyKey: randomUUID(), accountHolderId: holder, accountHolderType: 'CUSTOMER', productId: PRODUCT_ID })
  if (opts.lowRisk !== false) await api.ok('PATCH', `/v0/accounts/${a.accountHayId}/riskLevel`, { level: 'LOW', reason: 'KYC complete' })
  return a
}
async function credit(api: Client, accountHayId: string, amount: number): Promise<any> {
  return api.ok('POST', '/v1/transactions/credit', { idempotencyKey: randomUUID(), accountHayId, amount, counterpartName: 'Payroll Pty Ltd', description: 'Salary', transactionChannel: 'MANUAL_ADJUSTMENT' })
}
async function balances(api: Client, accountHayId: string): Promise<{ status: string; total: number; available: number; held: number; stacks: number }> {
  const a = await api.ok('GET', `/v0/accounts/${accountHayId}`)
  return { status: a.status, total: a.totalBalance, available: a.availableBalance, held: a.heldBalance, stacks: a.stacksBalance }
}
function cardBody(accountId: string, customerHayId: string, cardType: 'VIRTUAL' | 'PHYSICAL' = 'VIRTUAL'): Record<string, unknown> {
  return {
    idempotencyKey: randomUUID(), accountId, customerHayId, cardType, firstName: 'Jane', lastName: 'Scenario', email: 'jane@example.com',
    phoneNumber: { countryCodePrefix: '61', numberAfterPrefix: '412345678' },
    deliveryAddress: { line1: '395 Bourke St', townOrCity: 'Melbourne', administrativeRegion: 'VIC', postcode: '3000', countryCodeIso: 'AUS' },
    pin: '1234',
  }
}

/** One line per notification: the fields a client branches on. */
function summarise(n: any): Record<string, unknown> {
  const s: Record<string, unknown> = { type: n.type, actionOwner: n.actionOwner }
  switch (n.type) {
    case 'TRANSACTION': {
      const e = n.transactionEvent
      Object.assign(s, {
        transactionType: e.transactionType, isPending: e.isPending, amount: e.currencyAmount.amount, outcome: e.outcome,
        total: e.accountBalances.totalBalance.amount, held: e.accountBalances.heldBalance.amount, available: e.accountBalances.availableBalance.amount,
      })
      break
    }
    case 'ACCOUNT_STATUS_CHANGE': s.accountStatus = n.accountStatusChangeEvent.accountStatus; break
    case 'CUSTOMER_STATUS_UPDATED': s.customerStatus = n.customerStatusUpdatedEvent.customerStatus; break
    case 'CARD_STATUS_CHANGE': s.cardStatus = n.cardStatusChangeEvent.cardStatus; break
    case 'DIRECT_ENTRY': s.status = n.directEntryEvent.status; break
    case 'ONBOARDING_FAILED': s.state = n.onboardingFailedEvent.state; break
  }
  return s
}

// ---------------------------------------------------------------------------------------------- card mocks

/** Mock card purchase / refund through the Utilities API (/v0/utils/*), the way an integrating system drives them. */
interface CardMocks {
  purchase(cardToken: string, amount: number, settlementDelayInSeconds: number): Promise<void>
  refund(cardToken: string, amount: number): Promise<void>
}
const MERCHANT = { merchantName: 'IGA (Mt Cotton)', merchantId: '000009493578577', merchantCategoryCode: '5411' }

function httpMocks(api: Client): CardMocks {
  return {
    async purchase(cardToken, amount, settlementDelayInSeconds) {
      await api.ok('POST', '/v0/utils/generate-card-transaction', { amount: -amount, cardToken, merchantDetails: MERCHANT, settlementDelayInSeconds })
    },
    async refund(cardToken, amount) {
      await api.ok('POST', '/v0/utils/generate-refund-transaction', { amount: -amount, cardToken, merchantDetails: MERCHANT })
    },
  }
}

// ---------------------------------------------------------------------------------------------- journeys

let env: Env
beforeAll(async () => { env = await startEnv() })
afterAll(async () => { await stopEnv(env) })

const WEBHOOK_PATH = '/hooks/api/hay/v0/communications/notification'

/** Every notification the receiver got is a valid NotificationDto posted to the spec path. */
function expectWellFormed(receiver: Receiver): void {
  for (const d of receiver.deliveries) {
    expect(d.path).toBe(WEBHOOK_PATH)
    assertValidNotification(d.body)
  }
}

describe('auth', () => {
  it('refuses /v0 and /v1 calls without a bearer token (403 ErrorResponse) and accepts the issued one', async () => {
    const anonymous = await env.api.call('GET', '/v1/products', undefined, { auth: false })
    expect(anonymous.status).toBe(403)
    expect(anonymous.body).toMatchObject({ status: '403', message: 'FORBIDDEN: Missing bearer token' })
    expect((await env.api.get('/v1/products')).status).toBe(200)
  })
})

describe('onboarding outcomes steered by the email tag', () => {
  it('+referred and +rejected fail onboarding with the documented stage, +pending waits for the client', async () => {
    const { api, receiver } = env
    const outcome = async (tag: string) => {
      const id = await onboard(api, tag)
      return { status: (await api.ok('GET', `/v0/customers/${id}`)).status, events: receiver.for(id).map(summarise) }
    }
    expect(await outcome('referred')).toEqual({
      status: 'REFERRED',
      events: [{ type: 'ONBOARDING_FAILED', actionOwner: 'PLATFORM', state: 'KYC_AML_SCAN' }, { type: 'CUSTOMER_STATUS_UPDATED', actionOwner: 'PLATFORM', customerStatus: 'REFERRED' }],
    })
    expect(await outcome('rejected')).toEqual({
      status: 'REJECTED',
      events: [{ type: 'ONBOARDING_FAILED', actionOwner: 'PLATFORM', state: 'DOCUMENT_SCAN' }, { type: 'CUSTOMER_STATUS_UPDATED', actionOwner: 'PLATFORM', customerStatus: 'REJECTED' }],
    })
    expect(await outcome('pending')).toEqual({ status: 'PENDING_APPROVAL', events: [] })
    expectWellFormed(receiver)
  })
})

describe('journey (a): onboard -> account -> risk LOW -> virtual card -> mock purchase -> settlement -> refund', () => {
  /** Moves the balances step by step and checks the exact webhook sequence; `mocks` makes the card purchase and refund. */
  async function journey(mocks: CardMocks): Promise<void> {
    const { api, receiver } = env
    // onboarding is asynchronous: PENDING_APPROVAL on create, ACTIVE once the platform outcome arrives
    const customer = await onboard(api)
    expect((await api.ok('GET', `/v0/customers/${customer}`)).status).toBe('ACTIVE')

    const account = await openAccount(api, customer, { lowRisk: false })
    expect(account).toMatchObject({ status: 'APPROVED', bsb: '636220', accountNumber: expect.stringMatching(/^\d{8}$/), totalBalance: 0, availableBalance: 0 })
    const id = account.accountHayId as string
    expect(await api.ok('GET', `/v0/accounts/${id}/riskLevel`)).toEqual({ accountId: id, riskLevel: 'HIGH' })
    // risk level HIGH refuses every movement until the client sets LOW
    expect((await credit(api, id, 100)).outcome).toBe('REFUSED_MAX_BALANCE_EXCEEDED')
    await api.ok('PATCH', `/v0/accounts/${id}/riskLevel`, { level: 'LOW', reason: 'KYC complete' })
    expect(await api.ok('GET', `/v0/accounts/${id}/riskLevel`)).toEqual({ accountId: id, riskLevel: 'LOW' })

    const card = await api.ok('POST', '/v0/cards/create', cardBody(id, customer, 'VIRTUAL'))
    expect(card).toMatchObject({ cardType: 'VIRTUAL', cardStatus: 'ACTIVE', accountHayId: id, cardToken: expect.stringMatching(/^\d{9}$/) })
    // a virtual card is used online: card-not-present payments are off by default
    await api.ok('PATCH', `/v0/cards/${card.cardHayId}/payment-preferences`, { cardNotPresentEnabled: true })

    const topUp = await credit(api, id, 100)
    expect(topUp).toEqual({ outcome: 'ACCEPTED', transactionId: expect.stringMatching(UUID_RE) })
    await api.flush()
    expect(await balances(api, id)).toEqual({ status: 'ACTIVE', total: 100, available: 100, held: 0, stacks: 0 })

    // purchase: the hold is authorised now, the settlement follows 60 s later on the virtual clock
    await mocks.purchase(card.cardToken, 25.5, 60)
    const hold = await receiver.waitFor(() => receiver.for(customer).find((n) => n.transactionEvent?.transactionType === 'CARD_TRANSACTION'))
    expect(await balances(api, id)).toEqual({ status: 'ACTIVE', total: 100, available: 74.5, held: 25.5, stacks: 0 })
    const holdId = hold.transactionEvent.transactionHayId as string
    expect(hold.transactionEvent.holdHayId).toBe(holdId)
    expect(await api.ok('GET', `/v0/accounts/${id}/holds`)).toEqual([expect.objectContaining({ holdHayId: holdId, accountHayId: id, cardId: card.cardHayId, currencyAmount: { amount: -25.5, currency: 'AUD' } })])

    await api.advanceClock(60_000)
    await api.flush()
    expect(await balances(api, id)).toEqual({ status: 'ACTIVE', total: 74.5, available: 74.5, held: 0, stacks: 0 })
    expect(await api.ok('GET', `/v0/accounts/${id}/holds`)).toEqual([])
    const settled = receiver.for(customer).find((n) => n.transactionEvent?.transactionType === 'CARD_TRANSACTION_SETTLED')
    expect(settled.transactionEvent.holdHayId).toBe(holdId)
    expect(settled.transactionEvent.transactionHayId).not.toBe(holdId)
    const settlement = await api.ok('GET', `/v1/transactions/${settled.transactionEvent.transactionHayId}`)
    expect(settlement).toMatchObject({ accountHayId: id, cardId: card.cardHayId, relatedHoldHayId: holdId, currencyAmount: { amount: -25.5, currency: 'AUD' }, rollingAccountBalance: 74.5 })

    await mocks.refund(card.cardToken, 5.99)
    await api.flush()
    expect(await balances(api, id)).toEqual({ status: 'ACTIVE', total: 80.49, available: 80.49, held: 0, stacks: 0 })

    const received = receiver.for(customer)
    expect(received.map(summarise)).toEqual([
      { type: 'ONBOARDING_PASSED', actionOwner: 'PLATFORM' },
      { type: 'CUSTOMER_STATUS_UPDATED', actionOwner: 'PLATFORM', customerStatus: 'ACTIVE' },
      { type: 'ACCOUNT_STATUS_CHANGE', actionOwner: 'PLATFORM', accountStatus: 'APPROVED' },
      { type: 'CARD_STATUS_CHANGE', actionOwner: 'CLIENT', cardStatus: 'ACTIVE' },
      { type: 'ACCOUNT_STATUS_CHANGE', actionOwner: 'PLATFORM', accountStatus: 'ACTIVE' },
      { type: 'TRANSACTION', actionOwner: 'CLIENT', transactionType: 'GENERAL_CREDIT', isPending: false, amount: 100, outcome: 'ACCEPTED', total: 100, held: 0, available: 100 },
      // mock-driven card events: actionOwner is the utilities mocks' call, so it is not pinned here
      expect.objectContaining({ type: 'TRANSACTION', transactionType: 'CARD_TRANSACTION', isPending: true, amount: -25.5, outcome: 'ACCEPTED', total: 100, held: 25.5, available: 74.5 }),
      expect.objectContaining({ type: 'TRANSACTION', transactionType: 'CARD_TRANSACTION_SETTLED', isPending: false, amount: -25.5, outcome: 'ACCEPTED', total: 74.5, held: 0, available: 74.5 }),
      expect.objectContaining({ type: 'TRANSACTION', transactionType: 'CARD_TRANSACTION_REFUND', isPending: false, amount: 5.99, outcome: 'ACCEPTED', total: 80.49, held: 0, available: 80.49 }),
    ])
    // card events name the card; the refund stands alone (no hold link)
    expect(received[6].transactionEvent).toMatchObject({ cardHayId: card.cardHayId, accountHayId: id, updatedBalance: { amount: 74.5, currency: 'AUD' }, counterpartName: 'IGA (Mt Cotton)', merchantId: MERCHANT.merchantId })
    expect(received[8].transactionEvent).not.toHaveProperty('holdHayId')
    expect(received[3].cardStatusChangeEvent).toEqual({ cardHayId: card.cardHayId, accountHayId: id, cardStatus: 'ACTIVE', cardLastFourDigits: card.lastFourDigits })
    expect(new Set(received.map((n) => n.idempotencyKey)).size).toBe(received.length)
    expectWellFormed(receiver)
  }

  it('over HTTP: the purchase and refund through the Utilities API mocks (/v0/utils/*)', async () => {
    await journey(httpMocks(env.api))
  })
})

function transferBody(sender: string, amount: number, target: Record<string, unknown>): Record<string, unknown> {
  return { idempotencyKey: randomUUID(), amount, description: 'Scenario transfer', senderCustomerHayId: sender, ...target }
}

describe('journey (b): internal and external transfers, daily transfers-out limit', () => {
  it('posts both legs of an intrabank transfer, one leg of an interbank transfer, and refuses past the daily cap', async () => {
    const { api, receiver } = env
    const alice = await onboard(api)
    const bob = await onboard(api)
    const a = await openAccount(api, alice)
    const b = await openAccount(api, bob)
    await credit(api, a.accountHayId, 120_000)
    await api.flush()
    const before = { alice: receiver.for(alice).length, bob: receiver.for(bob).length }

    // local BSB + account number = intrabank transfer
    const internal = await api.ok('POST', `/v1/accounts/${a.accountHayId}/transfer`, transferBody(alice, 50_000, {
      transferType: 'ACCOUNT', accountTransfer: { bsb: '636220', accountNumber: b.accountNumber, recipientName: 'Bob' },
    }))
    expect(internal).toEqual({ outcome: 'ACCEPTED', transactionId: expect.stringMatching(UUID_RE) })
    // any other BSB leaves through NPP
    const external = await api.ok('POST', `/v1/accounts/${a.accountHayId}/transfer`, transferBody(alice, 50_000, {
      transferType: 'ACCOUNT', accountTransfer: { bsb: '062000', accountNumber: '12345678', recipientName: 'Landlord Pty Ltd' },
    }))
    expect(external).toEqual({ outcome: 'ACCEPTED', transactionId: expect.stringMatching(UUID_RE) })
    await api.flush()
    expect(await balances(api, a.accountHayId)).toMatchObject({ total: 20_000, available: 20_000 })
    expect(await balances(api, b.accountHayId)).toMatchObject({ status: 'ACTIVE', total: 50_000, available: 50_000 })

    expect(receiver.for(alice).slice(before.alice).map(summarise)).toEqual([
      { type: 'TRANSACTION', actionOwner: 'CLIENT', transactionType: 'INTRABANK_TRANSFER_OUT', isPending: false, amount: -50_000, outcome: 'ACCEPTED', total: 70_000, held: 0, available: 70_000 },
      { type: 'TRANSACTION', actionOwner: 'CLIENT', transactionType: 'INTERBANK_TRANSFER_OUT', isPending: false, amount: -50_000, outcome: 'ACCEPTED', total: 20_000, held: 0, available: 20_000 },
    ])
    expect(receiver.for(bob).slice(before.bob).map(summarise)).toEqual([
      { type: 'ACCOUNT_STATUS_CHANGE', actionOwner: 'PLATFORM', accountStatus: 'ACTIVE' },
      { type: 'TRANSACTION', actionOwner: 'CLIENT', transactionType: 'INTRABANK_TRANSFER_IN', isPending: false, amount: 50_000, outcome: 'ACCEPTED', total: 50_000, held: 0, available: 50_000 },
    ])
    const [out, interbank] = receiver.for(alice).slice(before.alice)
    expect(out.transactionEvent).toMatchObject({ transactionHayId: internal.transactionId, counterpartDetails: { accountId: b.accountHayId, customerId: bob, name: 'Bob' } })
    expect(interbank.transactionEvent).toMatchObject({ transactionHayId: external.transactionId, counterpartDetails: { name: 'Landlord Pty Ltd', basicAccountNumber: { accountNumber: '12345678', branchNumber: '062000' } } })
    expect(receiver.for(bob).at(-1).transactionEvent.counterpartDetails).toMatchObject({ accountId: a.accountHayId, customerId: alice })

    // 100,000 transferred out today: the hidden daily transfers-out cap refuses the next cent, posts nothing, notifies nothing
    const refused = await api.ok('POST', `/v1/accounts/${a.accountHayId}/transfer`, transferBody(alice, 0.01, {
      transferType: 'ACCOUNT', accountTransfer: { bsb: '062000', accountNumber: '12345678', recipientName: 'Landlord Pty Ltd' },
    }))
    expect(refused).toEqual({ outcome: 'REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED' })
    await api.flush()
    expect(receiver.for(alice)).toHaveLength(before.alice + 2)
    expect(await balances(api, a.accountHayId)).toMatchObject({ total: 20_000 })

    // the window is a rolling 24 h on the virtual clock (tokens expire on it too: log in again)
    await api.advanceClock(DAY_MS + 1000)
    await api.login()
    const nextDay = await api.ok('POST', `/v1/accounts/${a.accountHayId}/transfer`, transferBody(alice, 0.01, {
      transferType: 'ACCOUNT', accountTransfer: { bsb: '062000', accountNumber: '12345678', recipientName: 'Landlord Pty Ltd' },
    }))
    expect(nextDay.outcome).toBe('ACCEPTED')
    await api.ok('POST', '/_admin/clock', { reset: true })
    await api.login()
    expectWellFormed(receiver)
  })
})

describe('journey (c): BPAY payment', () => {
  it('validates the biller, pays it and notifies BPAY_TRANSFER_OUT with the biller details; biller 000000 is refused', async () => {
    const { api, receiver } = env
    const customer = await onboard(api)
    const account = await openAccount(api, customer)
    await credit(api, account.accountHayId, 500)
    await api.flush()
    const mark = receiver.for(customer).length

    expect((await api.post('/v1/bpay-billers/validate', { billerCode: '93880', reference: '271682361223' })).status).toBe(200)
    const paid = await api.ok('POST', `/v1/accounts/${account.accountHayId}/payments/bpay`, {
      idempotencyKey: randomUUID(), senderCustomerHayId: customer, amount: 120.5, billerCode: '93880', reference: '271682361223', category: 'Utilities', description: 'Internet bill', name: 'iiNet',
    })
    expect(paid).toEqual({ outcome: 'ACCEPTED', transactionId: expect.stringMatching(UUID_RE) })
    await api.flush()
    expect(await balances(api, account.accountHayId)).toMatchObject({ total: 379.5, available: 379.5 })
    const events = receiver.for(customer).slice(mark)
    expect(events.map(summarise)).toEqual([
      { type: 'TRANSACTION', actionOwner: 'CLIENT', transactionType: 'BPAY_TRANSFER_OUT', isPending: false, amount: -120.5, outcome: 'ACCEPTED', total: 379.5, held: 0, available: 379.5 },
    ])
    expect(events[0].transactionEvent).toMatchObject({
      transactionHayId: paid.transactionId, reference: '271682361223',
      counterpartDetails: { name: 'iiNet', bpayDetails: { billerCode: '93880', billerReference: '271682361223' } },
    })
    expect(await api.ok('GET', `/v1/transactions/${paid.transactionId}`)).toMatchObject({ type: 'BPAY_TRANSFER_OUT', transactionChannel: 'CUSCAL_BPAY_TRANSFER_OUT', currencyAmount: { amount: -120.5, currency: 'AUD' } })

    // test steering: biller code 000000 is a deactivated biller
    expect((await api.post('/v1/bpay-billers/validate', { billerCode: '000000', reference: '1234567' })).status).toBe(422)
    const refused = await api.ok('POST', `/v1/accounts/${account.accountHayId}/payments/bpay`, {
      idempotencyKey: randomUUID(), senderCustomerHayId: customer, amount: 10, billerCode: '000000', reference: '1234567', category: 'Utilities',
    })
    expect(refused).toEqual({ outcome: 'REFUSED_BPAY_INVALID_BILLER_CODE' })
    await api.flush()
    expect(receiver.for(customer)).toHaveLength(mark + 1)
    expectWellFormed(receiver)
  })
})

describe('journey (d): PayID register and transfer by PayID', () => {
  it('registers a PayID, resolves it and routes a PAY_ID transfer to the owning account', async () => {
    const { api, receiver } = env
    const payer = await onboard(api)
    const payee = await onboard(api)
    const from = await openAccount(api, payer)
    const to = await openAccount(api, payee)
    await credit(api, from.accountHayId, 300)
    const payId = `payee.${randomUUID().slice(0, 8)}@example.com`

    expect(await api.ok('GET', `/v0/payids/${encodeURIComponent(payId)}/availability`)).toEqual({ availability: true })
    expect(await api.ok('POST', `/v1/accounts/${to.accountHayId}/payids/${encodeURIComponent(payId)}/register`, { ownerName: 'Pat Payee', payIdName: 'Pat', payIdType: 'EMAIL' }))
      .toEqual({ message: 'PayID registered successfully.' })
    expect(await api.ok('GET', `/v0/payids/${encodeURIComponent(payId)}/resolve`)).toEqual({
      payIdValue: payId, payIdType: 'EMAIL', payIdName: 'Pat', accountDetails: { accountNumber: to.accountNumber, branchNumber: '636220', ownerName: 'Pat Payee' },
    })
    await api.flush()
    const mark = { payer: receiver.for(payer).length, payee: receiver.for(payee).length }

    const sent = await api.ok('POST', `/v1/accounts/${from.accountHayId}/transfer`, transferBody(payer, 75, { transferType: 'PAY_ID', payIdTransfer: { payId, recipientName: 'Pat Payee' } }))
    expect(sent).toEqual({ outcome: 'ACCEPTED', transactionId: expect.stringMatching(UUID_RE) })
    await api.flush()
    expect(await balances(api, from.accountHayId)).toMatchObject({ total: 225, available: 225 })
    expect(await balances(api, to.accountHayId)).toMatchObject({ total: 75, available: 75 })
    expect(receiver.for(payer).slice(mark.payer).map(summarise)).toEqual([
      { type: 'TRANSACTION', actionOwner: 'CLIENT', transactionType: 'INTRABANK_TRANSFER_OUT', isPending: false, amount: -75, outcome: 'ACCEPTED', total: 225, held: 0, available: 225 },
    ])
    expect(receiver.for(payee).slice(mark.payee).map(summarise)).toEqual([
      { type: 'ACCOUNT_STATUS_CHANGE', actionOwner: 'PLATFORM', accountStatus: 'ACTIVE' },
      { type: 'TRANSACTION', actionOwner: 'CLIENT', transactionType: 'INTRABANK_TRANSFER_IN', isPending: false, amount: 75, outcome: 'ACCEPTED', total: 75, held: 0, available: 75 },
    ])

    // an unknown PayID is an outcome, not an HTTP error
    const unknown = await api.ok('POST', `/v1/accounts/${from.accountHayId}/transfer`, transferBody(payer, 1, { transferType: 'PAY_ID', payIdTransfer: { payId: 'nobody@example.com', recipientName: 'Nobody' } }))
    expect(unknown).toEqual({ outcome: 'REFUSED_INVALID_PAY_ID' })
    expectWellFormed(receiver)
  })
})

describe('journey (e): direct debit lifecycle driven by the virtual clock', () => {
  // Every asynchronous platform effect waits one virtual hour (--async-delay-ms 3600000): nothing happens
  // until the test moves the clock, so each intermediate status can be observed. /_admin/flush would wait for
  // that work in real time (and answer 500 after 10 s), so this journey waits on the receiver or on
  // /_admin/notifications/flush instead.
  let clockEnv: Env
  beforeAll(async () => { clockEnv = await startEnv({ asyncDelayMs: HOUR_MS }) })
  afterAll(async () => { await stopEnv(clockEnv) })

  /** Moves the virtual clock (running due work) and logs in again: tokens expire on the same clock. */
  async function advance(ms: number): Promise<void> {
    await clockEnv.api.advanceClock(ms)
    await clockEnv.api.login()
  }

  it('RECEIVED/ACCEPTED synchronously, SUBMITTED and COMPLETE one clock step apart, then the credit', async () => {
    const { api, receiver } = clockEnv
    const created = await api.ok('POST', '/v0/customers/create', customerBody())
    const customer = created.customerHayId as string
    expect(created.status).toBe('PENDING_APPROVAL')
    await advance(HOUR_MS)
    await receiver.waitFor(() => receiver.for(customer).find((n) => n.type === 'CUSTOMER_STATUS_UPDATED'))
    expect((await api.ok('GET', `/v0/customers/${customer}`)).status).toBe('ACTIVE')
    const account = await openAccount(api, customer)
    await receiver.waitForCount(customer, 3)

    const transactionId = randomUUID()
    const dd = {
      idempotencyKey: randomUUID(), transactionId, amount: 250.5, description: 'Gym membership',
      senderBsb: account.bsb, senderAccountNumber: account.accountNumber, senderName: 'Scenario Gym',
      recipientBsb: '062000', recipientAccountNumber: '123456789', recipientName: 'Member Name',
    }
    expect(await api.ok('POST', '/v1/direct-debits', dd)).toMatchObject({ outcome: 'ACCEPTED', transactionId })
    const deStatus = async () => {
      const [record, status] = await Promise.all([api.ok('GET', `/v1/direct-debits/${transactionId}`), api.ok('GET', `/v1/direct-entry/${transactionId}/status`)])
      expect(record.outcome).toBe(status.status)
      return status.status as string
    }
    const deEvents = () => receiver.for(customer).filter((n) => n.type === 'DIRECT_ENTRY').map((n) => [n.directEntryEvent.status, n.actionOwner])
    await receiver.waitFor(() => deEvents().length === 2)
    expect(await deStatus()).toBe('ACCEPTED')
    expect(await balances(api, account.accountHayId)).toMatchObject({ status: 'APPROVED', total: 0 })

    await advance(HOUR_MS)
    await receiver.waitFor(() => deEvents().length === 3)
    expect(await deStatus()).toBe('SUBMITTED')
    expect(await balances(api, account.accountHayId)).toMatchObject({ total: 0 })

    await advance(HOUR_MS)
    await receiver.waitFor(() => deEvents().length === 4 && receiver.for(customer).find((n) => n.transactionEvent?.transactionType === 'DIRECT_DEBIT_TRANSFER'))
    expect(await deStatus()).toBe('COMPLETE')
    expect(await balances(api, account.accountHayId)).toEqual({ status: 'ACTIVE', total: 250.5, available: 250.5, held: 0, stacks: 0 })
    expect(deEvents()).toEqual([['RECEIVED', 'CLIENT'], ['ACCEPTED', 'CLIENT'], ['SUBMITTED', 'PLATFORM'], ['COMPLETE', 'PLATFORM']])
    for (const n of receiver.for(customer).filter((x) => x.type === 'DIRECT_ENTRY')) {
      expect(n.directEntryEvent).toMatchObject({ transactionId, type: 'DEBIT', direction: 'OUTBOUND' })
    }
    const credited = receiver.for(customer).find((n) => n.transactionEvent?.transactionType === 'DIRECT_DEBIT_TRANSFER')
    expect(summarise(credited)).toEqual({ type: 'TRANSACTION', actionOwner: 'PLATFORM', transactionType: 'DIRECT_DEBIT_TRANSFER', isPending: false, amount: 250.5, outcome: 'ACCEPTED', total: 250.5, held: 0, available: 250.5 })
    expect(credited.transactionEvent.transactionHayId).toBe(transactionId)
    expect(receiver.for(customer).map(summarise)).toEqual([
      { type: 'ONBOARDING_PASSED', actionOwner: 'PLATFORM' },
      { type: 'CUSTOMER_STATUS_UPDATED', actionOwner: 'PLATFORM', customerStatus: 'ACTIVE' },
      { type: 'ACCOUNT_STATUS_CHANGE', actionOwner: 'PLATFORM', accountStatus: 'APPROVED' },
      { type: 'DIRECT_ENTRY', actionOwner: 'CLIENT', status: 'RECEIVED' },
      { type: 'DIRECT_ENTRY', actionOwner: 'CLIENT', status: 'ACCEPTED' },
      { type: 'DIRECT_ENTRY', actionOwner: 'PLATFORM', status: 'SUBMITTED' },
      { type: 'ACCOUNT_STATUS_CHANGE', actionOwner: 'PLATFORM', accountStatus: 'ACTIVE' },
      { type: 'TRANSACTION', actionOwner: 'PLATFORM', transactionType: 'DIRECT_DEBIT_TRANSFER', isPending: false, amount: 250.5, outcome: 'ACCEPTED', total: 250.5, held: 0, available: 250.5 },
      { type: 'DIRECT_ENTRY', actionOwner: 'PLATFORM', status: 'COMPLETE' },
    ])

    // test steering: recipient BSB 999999 is rejected at once (RECEIVED then REJECTED, nothing posted)
    const mark = receiver.for(customer).length
    const rejectedId = randomUUID()
    const rejected = await api.ok('POST', '/v1/direct-debits', { ...dd, idempotencyKey: randomUUID(), transactionId: rejectedId, recipientBsb: '999999' })
    expect(rejected).toMatchObject({ outcome: 'REJECTED', transactionId: rejectedId, details: 'Invalid recipient BSB 999999' })
    await api.flushNotifications()
    expect(receiver.for(customer).slice(mark).map(summarise)).toEqual([
      { type: 'DIRECT_ENTRY', actionOwner: 'CLIENT', status: 'RECEIVED' },
      { type: 'DIRECT_ENTRY', actionOwner: 'CLIENT', status: 'REJECTED' },
    ])
    expect((await api.ok('GET', `/v1/direct-entry/${rejectedId}/status`)).status).toBe('REJECTED')
    expect(await balances(api, account.accountHayId)).toMatchObject({ total: 250.5 })
    expectWellFormed(receiver)
  })
})

describe('journey (f): stacks', () => {
  it('moves money into and out of a stack, keeps stacked funds unspendable and counts them toward MAX_BALANCE', async () => {
    const { api, receiver } = env
    const customer = await onboard(api)
    const account = await openAccount(api, customer)
    const id = account.accountHayId as string
    await credit(api, id, 1000)
    await api.flush()
    const mark = receiver.for(customer).length

    expect(await api.ok('POST', `/v0/accounts/${id}/stacks`, { name: 'Holiday', targetAmount: 500 })).toBe(true)
    const [stack] = await api.ok('GET', `/v0/accounts/${id}/stacks`)
    expect(stack).toMatchObject({ name: 'Holiday', status: 'OPEN', targetAmount: 500, balance: 0 })
    const stackId = stack.stackHayId as string

    const moveIn = await api.ok('POST', `/v0/accounts/${id}/stacks/${stackId}/transfer-in`, { amount: 300, customerId: customer, description: 'Save' })
    expect(moveIn).toEqual({ outcome: 'ACCEPTED', transactionId: expect.stringMatching(UUID_RE) })
    expect(await balances(api, id)).toEqual({ status: 'ACTIVE', total: 1000, available: 700, held: 0, stacks: 300 })
    const moveOut = await api.ok('POST', `/v0/accounts/${id}/stacks/${stackId}/transfer-out`, { amount: 100, customerId: customer })
    expect(moveOut.outcome).toBe('ACCEPTED')
    expect(await balances(api, id)).toEqual({ status: 'ACTIVE', total: 1000, available: 800, held: 0, stacks: 200 })
    expect((await api.ok('GET', `/v0/accounts/${id}/stacks`))[0]).toMatchObject({ stackHayId: stackId, balance: 200 })
    expect((await api.ok('GET', `/v0/accounts/${id}/stacks/${stackId}/transactions?offset=0&limit=10`)).map((t: any) => t.amount)).toEqual([300, -100])

    // stacked money is not spendable: 800 available although the total is 1000
    expect((await api.ok('POST', '/v1/transactions/debit', { idempotencyKey: randomUUID(), accountHayId: id, amount: 900, counterpartName: 'Shop', description: 'x', transactionChannel: 'MANUAL_ADJUSTMENT' })).outcome)
      .toBe('REFUSED_INSUFFICIENT_FUNDS')
    // ...and counts toward MAX_BALANCE: with a 1,200 cap only 200 more fits, whatever sits in the stack
    await api.ok('PATCH', `/v0/accounts/${id}/max-balance`, { maxBalanceLimit: 1200 })
    expect((await credit(api, id, 250)).outcome).toBe('REFUSED_MAX_BALANCE_EXCEEDED')
    expect((await credit(api, id, 200)).outcome).toBe('ACCEPTED')
    expect(await balances(api, id)).toEqual({ status: 'ACTIVE', total: 1200, available: 1000, held: 0, stacks: 200 })
    // a stack move is not a ledger movement: no limit applies and no webhook is sent
    expect((await api.ok('POST', `/v0/accounts/${id}/stacks/${stackId}/transfer-in`, { amount: 1000, customerId: customer })).outcome).toBe('ACCEPTED')
    expect((await api.ok('POST', `/v0/accounts/${id}/stacks/${stackId}/transfer-in`, { amount: 0.01, customerId: customer })).outcome).toBe('REFUSED_INSUFFICIENT_FUNDS')
    await api.flush()
    expect(receiver.for(customer).slice(mark).map(summarise)).toEqual([
      { type: 'TRANSACTION', actionOwner: 'CLIENT', transactionType: 'GENERAL_CREDIT', isPending: false, amount: 200, outcome: 'ACCEPTED', total: 1200, held: 0, available: 1000 },
    ])
    expect(receiver.for(customer).at(-1).transactionEvent.accountBalances.stacksBalance).toEqual({ amount: 200, currency: 'AUD' })

    // closing the stack returns its balance to the account
    expect(await api.ok('POST', `/v0/accounts/${id}/stacks/${stackId}/close`)).toBe(true)
    expect(await balances(api, id)).toEqual({ status: 'ACTIVE', total: 1200, available: 1200, held: 0, stacks: 0 })
    expectWellFormed(receiver)
  })
})

describe('journey (g): group account with two members', () => {
  it('opens a joint account for two ACTIVE members and notifies both of every account event', async () => {
    const { api, receiver } = env
    const first = await onboard(api)
    const second = await onboard(api)
    const group = await api.ok('POST', '/v0/groups/create', { idempotencyKey: randomUUID(), customerHayIds: [first, second], groupType: 'PERSONAL', groupName: 'Household' })
    expect(group).toMatchObject({ groupHayId: expect.stringMatching(UUID_RE), groupName: 'Household', groupType: 'PERSONAL' })
    const joint = await api.ok('POST', `/v0/groups/${group.groupHayId}/account`, { idempotencyKey: randomUUID() })
    const account = joint.hayAccount
    expect(account).toMatchObject({ accountHolderType: 'GROUP', accountHolderId: group.groupHayId, status: 'APPROVED' })
    const id = account.accountHayId as string
    expect((await api.ok('GET', `/v0/groups/${group.groupHayId}`)).hayAccount.accountHayId).toBe(id)
    await api.ok('PATCH', `/v0/accounts/${id}/riskLevel`, { level: 'LOW', reason: 'KYC complete' })

    await credit(api, id, 200)
    // either member may act on the joint account
    const card = await api.ok('POST', '/v0/cards/create', cardBody(id, second, 'VIRTUAL'))
    expect(card).toMatchObject({ customerHayId: second, accountHayId: id, cardStatus: 'ACTIVE' })
    const out = await api.ok('POST', `/v1/accounts/${id}/transfer`, transferBody(second, 50, { transferType: 'ACCOUNT', accountTransfer: { bsb: '062000', accountNumber: '12345678', recipientName: 'Utility Co' } }))
    expect(out.outcome).toBe('ACCEPTED')
    await api.flush()
    expect(await balances(api, id)).toEqual({ status: 'ACTIVE', total: 150, available: 150, held: 0, stacks: 0 })

    const accountEvents = (customer: string) => receiver.for(customer).filter((n) => n.accountStatusChangeEvent?.accountHayId === id || n.transactionEvent?.accountHayId === id || n.cardStatusChangeEvent?.accountHayId === id).map(summarise)
    const expected = [
      { type: 'ACCOUNT_STATUS_CHANGE', actionOwner: 'PLATFORM', accountStatus: 'APPROVED' },
      { type: 'ACCOUNT_STATUS_CHANGE', actionOwner: 'PLATFORM', accountStatus: 'ACTIVE' },
      { type: 'TRANSACTION', actionOwner: 'CLIENT', transactionType: 'GENERAL_CREDIT', isPending: false, amount: 200, outcome: 'ACCEPTED', total: 200, held: 0, available: 200 },
      { type: 'TRANSACTION', actionOwner: 'CLIENT', transactionType: 'INTERBANK_TRANSFER_OUT', isPending: false, amount: -50, outcome: 'ACCEPTED', total: 150, held: 0, available: 150 },
    ]
    expect(accountEvents(first)).toEqual(expected)
    // the card event goes to its cardholder only
    expect(accountEvents(second)).toEqual([...expected.slice(0, 3), { type: 'CARD_STATUS_CHANGE', actionOwner: 'CLIENT', cardStatus: 'ACTIVE' }, expected[3]])
    expectWellFormed(receiver)
  })
})

describe('journey (h): activate a physical card, close account cascade and refusals on a closed account', () => {
  it('activates the physical card, refuses closure with money on it, then closes: cards INACTIVE, customer INACTIVE, every movement refused', async () => {
    const { api, receiver } = env
    const customer = await onboard(api)
    const other = await onboard(api)
    const account = await openAccount(api, customer)
    const payer = await openAccount(api, other)
    const id = account.accountHayId as string
    const virtualCard = await api.ok('POST', '/v0/cards/create', cardBody(id, customer, 'VIRTUAL'))
    const physicalCard = await api.ok('POST', '/v0/cards/create', cardBody(id, customer, 'PHYSICAL'))
    expect(physicalCard.cardStatus).toBe('AWAITING_ACTIVATION')
    // the cardholder received the card: activate it
    expect(await api.ok('POST', `/v0/cards/${physicalCard.cardHayId}/activate`)).toEqual({ message: 'Activate Card successful.' })
    expect((await api.ok('GET', `/v0/cards/${physicalCard.cardHayId}`)).cardStatus).toBe('ACTIVE')
    await api.flush()
    const physicalEvents = () => receiver.for(customer).filter((n) => n.cardStatusChangeEvent?.cardHayId === physicalCard.cardHayId)
    expect(physicalEvents().map(summarise)).toEqual([
      { type: 'CARD_STATUS_CHANGE', actionOwner: 'CLIENT', cardStatus: 'AWAITING_ACTIVATION' },
      { type: 'CARD_STATUS_CHANGE', actionOwner: 'CLIENT', cardStatus: 'ACTIVE' },
    ])
    expect(physicalEvents()[1].cardStatusChangeEvent).toEqual({ cardHayId: physicalCard.cardHayId, accountHayId: id, cardStatus: 'ACTIVE', cardLastFourDigits: physicalCard.lastFourDigits })
    await credit(api, id, 50)
    await credit(api, payer.accountHayId, 50)
    await api.flush()

    const refused = await api.call('POST', `/v0/accounts/${id}/close`, { reason: 'CUSTOMER' })
    expect(refused.status).toBe(422)
    expect(refused.body).toMatchObject({ result: 'FAILURE', errors: [expect.objectContaining({ type: 'ACCOUNT_BALANCE_TOTAL' })] })

    expect((await api.ok('POST', '/v1/transactions/debit', { idempotencyKey: randomUUID(), accountHayId: id, amount: 50, counterpartName: 'Payout', description: 'Closing balance', transactionChannel: 'MANUAL_ADJUSTMENT' })).outcome).toBe('ACCEPTED')
    await api.flush()
    const mark = receiver.for(customer).length
    const closing = await api.call('POST', `/v0/accounts/${id}/close`, { reason: 'CUSTOMER' })
    expect(closing.status).toBe(202)
    expect(closing.body).toMatchObject({ result: 'SUCCESS', errors: [] })
    await api.flush()

    expect(await api.ok('GET', `/v0/accounts/${id}`)).toMatchObject({ status: 'CLOSED', closedDateTimeUtc: expect.any(String) })
    expect((await api.ok('GET', `/v0/cards/${virtualCard.cardHayId}`)).cardStatus).toBe('INACTIVE')
    expect((await api.ok('GET', `/v0/cards/${physicalCard.cardHayId}`)).cardStatus).toBe('INACTIVE')
    expect(await api.ok('GET', `/v0/customers/${customer}`)).toMatchObject({ status: 'INACTIVE', statusReason: 'CUSTOMER' })
    const cascade = receiver.for(customer).slice(mark)
    // docs:account-closure: the account closes first, the linked cards follow; the customer's INACTIVE is silent by default (--emit-customer-inactive)
    expect(cascade.map(summarise)).toEqual([
      { type: 'ACCOUNT_STATUS_CHANGE', actionOwner: 'CLIENT', accountStatus: 'CLOSED' },
      { type: 'CARD_STATUS_CHANGE', actionOwner: 'PLATFORM', cardStatus: 'INACTIVE' },
      { type: 'CARD_STATUS_CHANGE', actionOwner: 'PLATFORM', cardStatus: 'INACTIVE' },
    ])
    expect(cascade.slice(1).map((n) => n.cardStatusChangeEvent.cardHayId).sort()).toEqual([virtualCard.cardHayId, physicalCard.cardHayId].sort())

    // refusals: outcomes for money movement, 422 for new resources
    const creditRes = await credit(api, id, 10)
    const debitRes = await api.ok('POST', '/v1/transactions/debit', { idempotencyKey: randomUUID(), accountHayId: id, amount: 1, counterpartName: 'x', description: 'x', transactionChannel: 'MANUAL_ADJUSTMENT' })
    const into = await api.ok('POST', `/v1/accounts/${payer.accountHayId}/transfer`, transferBody(other, 5, { transferType: 'INTERNAL', internalTransfer: { recipientAccountHayId: id, recipientName: 'Closed', senderName: 'Other' } }))
    const cardRes = await api.call('POST', '/v0/cards/create', cardBody(id, customer, 'VIRTUAL'))
    const stackRes = await api.call('POST', `/v0/accounts/${id}/stacks`, { name: 'Late' })
    expect(creditRes).toEqual({ outcome: 'REFUSED_ACCOUNT_CLOSED' })
    expect(debitRes).toEqual({ outcome: 'REFUSED_ACCOUNT_CLOSED' })
    expect(into).toEqual({ outcome: 'REFUSED_RECIPIENT_ACCOUNT_CLOSED' })
    expect(cardRes.status).toBe(422)
    expect(cardRes.body.message).toMatch(/^PERMISSION_DENIED: .* INACTIVE/) // the holder is INACTIVE now
    expect(stackRes.status).toBe(422)
    expect(stackRes.body.message).toMatch(/^ACCOUNT_CLOSED/)
    await api.flush()
    expect(receiver.for(customer)).toHaveLength(mark + 3)
    expectWellFormed(receiver)
  })
})

describe('webhook delivery retries', () => {
  it('retries a 5xx with doubling backoff until the receiver answers 200, and records the attempts', async () => {
    const { api, receiver } = env
    const mark = receiver.deliveries.length
    // a customer held in PENDING_APPROVAL (+pending) produces no notification until the client changes its status
    const created = await api.ok('POST', '/v0/customers/create', customerBody('pending'))
    await api.flush()
    expect(receiver.deliveries).toHaveLength(mark)
    receiver.respondWith(500, 500)
    await api.ok('PATCH', `/v0/customers/${created.customerHayId}/status`, { newStatus: 'ACTIVE' })
    await api.flush() // waits until the notification is no longer queued, retries included

    const attempts = receiver.deliveries.slice(mark)
    expect(attempts.map((d) => d.status)).toEqual([500, 500, 200])
    const [one, two, three] = attempts
    expect(new Set(attempts.map((d) => d.body.idempotencyKey)).size).toBe(1) // the same notification each time
    expect(two!.body).toEqual(one!.body)
    expect(three!.body).toEqual(one!.body)
    expect(one!.body).toMatchObject({ type: 'CUSTOMER_STATUS_UPDATED', actionOwner: 'CLIENT', customerStatusUpdatedEvent: { customerStatus: 'ACTIVE' } })
    // backoff doubles: >= 40 ms before the 2nd attempt, >= 80 ms before the 3rd (timer granularity tolerated)
    expect(two!.at - one!.at).toBeGreaterThanOrEqual(BACKOFF_MS - 5)
    expect(three!.at - two!.at).toBeGreaterThanOrEqual(2 * BACKOFF_MS - 5)

    const row = await api.ok('GET', `/_admin/notifications/${one!.body.idempotencyKey}`)
    expect(row).toMatchObject({ id: one!.body.idempotencyKey, version: 'v0', type: 'CUSTOMER_STATUS_UPDATED', status: 'delivered', attempts: 3, lastStatus: 200, lastError: null, deliveredAt: expect.any(String) })
    expect((await api.ok('GET', '/_admin/notifications?status=delivered&type=CUSTOMER_STATUS_UPDATED')).map((n: any) => n.id)).toContain(row.id)
    expect(receiver.for(created.customerHayId)).toHaveLength(1)
    expectWellFormed(receiver)
  })
})

// Runs last: it wipes the shared server.
describe('journey (i): reset, then reuse the same server', () => {
  it('forgets every entity and notification, keeps the token valid, and serves the same journey again', async () => {
    const { api, receiver } = env
    const body = customerBody()
    const run = async () => {
      const c = await api.ok('POST', '/v0/customers/create', { ...body, idempotencyKey: randomUUID() })
      await api.flush()
      const a = await openAccount(api, c.customerHayId)
      await credit(api, a.accountHayId, 10)
      await api.flush()
      return { customer: c.customerHayId as string, account: a }
    }
    const first = await run()
    expect((await api.ok('GET', '/_admin/notifications')).length).toBeGreaterThan(0)
    expect((await api.ok('GET', '/v0/customers?offset=0&limit=1000')).length).toBeGreaterThan(1) // every journey's customers
    await api.advanceClock(HOUR_MS / 2)

    expect(await api.ok('POST', '/_admin/reset')).toEqual({ status: 'ok' })
    expect((await api.get(`/v0/customers/${first.customer}`)).status).toBe(404)
    expect((await api.get(`/v0/accounts/${first.account.accountHayId}`)).status).toBe(404)
    expect(await api.ok('GET', '/_admin/notifications')).toEqual([])
    const clock = await api.ok('GET', '/_admin/clock')
    expect(Math.abs(new Date(clock.now).getTime() - Date.now())).toBeLessThan(60_000) // back on real time

    expect(await api.ok('GET', '/v0/customers?offset=0&limit=1000')).toEqual([])

    // the same customer details are not duplicates any more; account numbering starts again
    const second = await run()
    expect(second.customer).not.toBe(first.customer)
    expect(second.account.accountNumber).toBe('10000001')
    expect(await balances(api, second.account.accountHayId)).toMatchObject({ status: 'ACTIVE', total: 10 })
    expect(receiver.for(second.customer).map((n) => n.type)).toEqual(['ONBOARDING_PASSED', 'CUSTOMER_STATUS_UPDATED', 'ACCOUNT_STATUS_CHANGE', 'ACCOUNT_STATUS_CHANGE', 'TRANSACTION'])
    expect((await api.ok('GET', '/_admin/notifications')).map((n: any) => n.type)).toEqual(['ONBOARDING_PASSED', 'CUSTOMER_STATUS_UPDATED', 'ACCOUNT_STATUS_CHANGE', 'ACCOUNT_STATUS_CHANGE', 'TRANSACTION'])
    expectWellFormed(receiver)
  })
})
