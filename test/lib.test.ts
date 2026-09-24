import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db/index.js'
import { withIdempotency } from '../src/lib/idempotency.js'
import { hasAtMostTwoDecimals, toCents, toCentsStrict } from '../src/lib/money.js'
import { startApp } from './helpers.js'
import type { BuiltServer } from '../src/server.js'

let built: BuiltServer
beforeAll(async () => { built = await startApp() })
afterAll(async () => { await built.app.close() })

describe('money', () => {
  it('hasAtMostTwoDecimals accepts every 2-dp amount and refuses a third decimal or a non-finite value', () => {
    for (const ok of [0, 1, 0.1, 0.01, 1234.56, 50_000.01, 1_000_000.5, 99_999_999.99, 10_000.01, 0.07, 19.99, 100]) expect(hasAtMostTwoDecimals(ok), String(ok)).toBe(true)
    for (const bad of [0.005, 12.345, 1.005, 0.001, 99.999, Number.NaN, Number.POSITIVE_INFINITY]) expect(hasAtMostTwoDecimals(bad), String(bad)).toBe(false)
  })

  it('toCentsStrict matches toCents on 2-dp amounts and throws instead of rounding otherwise', () => {
    expect(toCentsStrict(1234.56)).toBe(123456)
    expect(toCentsStrict(0.07)).toBe(toCents(0.07))
    expect(() => toCentsStrict(0.005)).toThrow(RangeError)
    expect(() => toCentsStrict(12.345)).toThrow(/more than 2 decimal places/)
    expect(toCents(12.345)).toBe(1235) // the lenient helper still rounds
  })
})

describe('withIdempotency', () => {
  it('replays the stored response for the same key and body, and refuses a different body', async () => {
    let calls = 0
    const run = () => ({ status: 200, body: { n: ++calls } })
    const a = await withIdempotency(built.ctx, 'op', 'k1', { x: 1, y: [1, 2] }, run)
    const b = await withIdempotency(built.ctx, 'op', 'k1', { y: [1, 2], x: 1 }, run)
    expect(a).toEqual({ status: 200, body: { n: 1 }, replayed: false })
    expect(b).toEqual({ status: 200, body: { n: 1 }, replayed: true })
    await expect(withIdempotency(built.ctx, 'op', 'k1', { x: 2 }, run)).rejects.toMatchObject({ status: 422 })
    const c = await withIdempotency(built.ctx, 'other-op', 'k1', { x: 1 }, run)
    expect(c.body).toEqual({ n: 2 })
    const d = await withIdempotency(built.ctx, 'op', undefined, { x: 1 }, run)
    expect(d.replayed).toBe(false)
  })
})

describe('scheduler', () => {
  it('runs deferred work after the delay and early when the virtual clock passes it', async () => {
    const ran: string[] = []
    built.ctx.scheduler.later(() => { ran.push('soon') }, 0)
    await built.ctx.scheduler.waitForIdle()
    expect(ran).toEqual(['soon'])
    built.ctx.scheduler.later(() => { ran.push('later') }, 60_000)
    expect(built.ctx.scheduler.pending()).toBe(1)
    await built.app.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: 61_000 } })
    expect(ran).toEqual(['soon', 'later'])
    await built.app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
  })

  it('/_admin/flush waits for the work that falls due within its window (and what that schedules) and leaves later steps pending', async () => {
    const ran: string[] = []
    built.ctx.scheduler.later(() => { ran.push('soon'); built.ctx.scheduler.later(() => { ran.push('chained') }, 20) }, 20)
    built.ctx.scheduler.later(() => { ran.push('much later') }, 60_000)
    const started = Date.now()
    const res = await built.app.inject({ method: 'POST', url: '/_admin/flush' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ status: 'idle', deferred: 1 })
    expect(ran).toEqual(['soon', 'chained'])
    expect(Date.now() - started).toBeLessThan(2_000)
    // the pending step still runs once the virtual clock passes it
    await built.app.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: 61_000 } })
    expect(ran).toEqual(['soon', 'chained', 'much later'])
    expect(built.ctx.scheduler.pending()).toBe(0)
    await built.app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
  })

  it('a clock jump runs the deferred steps it makes due in due order, not creation order (due steps they schedule included)', async () => {
    const ran: string[] = []
    built.ctx.scheduler.later(() => { ran.push('+300s') }, 300_000)
    // a step scheduled by a step is due from the clock's time at that point (+400 s): still in this tick, last
    built.ctx.scheduler.later(() => { ran.push('+60s'); built.ctx.scheduler.later(() => { ran.push('chained') }, 0) }, 60_000)
    built.ctx.scheduler.later(() => { ran.push('+120s') }, 120_000)
    await built.app.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: 400_000 } })
    expect(ran).toEqual(['+60s', '+120s', '+300s', 'chained'])
    await built.app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
  })

  it('a delay beyond the 32-bit timer range waits (virtual clock) instead of firing after 1 ms', async () => {
    const ran: string[] = []
    built.ctx.scheduler.later(() => { ran.push('30 days') }, 30 * 24 * 3600 * 1000)
    await new Promise((r) => setTimeout(r, 50))
    expect(ran).toEqual([])
    await built.app.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: 31 * 24 * 3600 * 1000 } })
    expect(ran).toEqual(['30 days'])
    await built.app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
  })

  it('/_admin/reset releases a /_admin/flush that was waiting for the work it cancelled', async () => {
    const other = await startApp({ asyncDelayMs: 2_000 })
    try {
      other.ctx.scheduler.later(() => {})
      const started = Date.now()
      const flushing = other.app.inject({ method: 'POST', url: '/_admin/flush' })
      await new Promise((r) => setTimeout(r, 50))
      expect((await other.app.inject({ method: 'POST', url: '/_admin/reset' })).statusCode).toBe(200)
      const res = await flushing
      expect(res.statusCode, res.body).toBe(200)
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      await other.app.close()
    }
  })

  it('runs tick jobs on requests and on /_admin/flush', async () => {
    let ticks = 0
    built.ctx.scheduler.onTick(() => { ticks++ })
    await built.app.inject({ method: 'GET', url: '/v1/products' })
    expect(ticks).toBeGreaterThanOrEqual(1)
    const res = await built.app.inject({ method: 'POST', url: '/_admin/flush' })
    expect(res.json()).toEqual({ status: 'idle' })
  })
})

describe('database migrations', () => {
  it('adds a column registered after a file database was created (registerColumn) when it is reopened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shaype-db-'))
    try {
      const file = join(dir, 'old.db')
      const first = openDatabase(file)
      first.exec('ALTER TABLE accounts DROP COLUMN close_requested_at') // what an earlier version created
      first.close()
      const reopened = openDatabase(file)
      const cols = (reopened.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]).map((c) => c.name)
      reopened.close()
      expect(cols).toContain('close_requested_at')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('scheduler: deferred platform steps survive a restart on a file database', () => {
  it('onboarding outcome, card settlement and the closure cascade still run after the server restarts on the same --db file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shaype-jobs-'))
    const db = join(dir, 'jobs.db')
    const HOUR = 3_600_000
    const config = { db, asyncDelayMs: HOUR, defaultRiskLevel: 'LOW' as const }
    try {
      const run1 = await startApp(config)
      const a1 = run1.app
      const post = (url: string, payload: object) => a1.inject({ method: 'POST', url, payload })
      const newCustomer = async (n: number) => (await post('/v0/customers/create', {
        idempotencyKey: randomUUID(), email: `restart${n}@example.com`, customerTier: 'STANDARD', phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: `48888888${n}` },
        address: { line1: '1 Test St', townOrCity: 'Sydney', administrativeRegion: 'NSW', postcode: '2000', countryCodeIso: 'AUS' },
        customerDetails: { firstName: 'Restart', lastName: `Holder${n}`, dateOfBirth: '1990-01-01' },
      })).json().customerHayId as string
      const customer = await newCustomer(1)
      await a1.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: HOUR + 1000 } }) // onboarded
      const lateCustomer = await newCustomer(2) // its outcome is still pending at the restart
      const openAccount = async () => (await post('/v1/accounts', { idempotencyKey: randomUUID(), accountHolderId: customer, accountHolderType: 'CUSTOMER', productId: 'a1b2c3d4-0000-4000-8000-000000000001' })).json().accountHayId as string
      const accountId = await openAccount()
      const closingId = await openAccount()
      expect((await post('/v1/transactions/credit', { idempotencyKey: randomUUID(), accountHayId: accountId, amount: 100, counterpartName: 'x', description: 'fund', transactionChannel: 'MANUAL_ADJUSTMENT' })).json().outcome).toBe('ACCEPTED')
      const card = await post('/v0/cards/create', {
        idempotencyKey: randomUUID(), accountId, customerHayId: customer, firstName: 'Restart', lastName: 'Holder', email: 'restart@example.com',
        phoneNumber: { countryCodePrefix: '61', numberAfterPrefix: '412345678' }, cardType: 'VIRTUAL', pin: '1234',
        deliveryAddress: { line1: '9 Fifth Ave', townOrCity: 'Adelaide', administrativeRegion: 'SA', postcode: '5012', countryCodeIso: 'AUS' },
      })
      expect(card.statusCode, card.body).toBe(200)
      const purchase = await post('/v0/utils/generate-card-transaction', {
        amount: -25.5, cardToken: card.json().cardToken, settlementDelayInSeconds: 120,
        merchantDetails: { merchantName: 'IGA (Mt Cotton)', merchantId: '000009493578577', merchantCategoryCode: '5411' },
      })
      expect(purchase.statusCode, purchase.body).toBe(200)
      expect((await a1.inject({ method: 'POST', url: `/v0/accounts/${closingId}/close`, payload: { reason: 'CUSTOMER' } })).statusCode).toBe(202)
      expect((await a1.inject({ method: 'GET', url: `/v0/customers/${lateCustomer}` })).json().status).toBe('PENDING_APPROVAL')
      await a1.close()

      const run2 = await startApp(config)
      const a2 = run2.app
      expect(run2.ctx.scheduler.pending()).toBe(3)
      await a2.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: 2 * HOUR } })
      await a2.inject({ method: 'POST', url: '/_admin/flush' })
      expect((await a2.inject({ method: 'GET', url: `/v0/customers/${lateCustomer}` })).json().status).toBe('ACTIVE')
      expect((await a2.inject({ method: 'GET', url: `/v0/accounts/${accountId}` })).json()).toMatchObject({ totalBalance: 74.5, heldBalance: 0 })
      expect((await a2.inject({ method: 'GET', url: `/v0/accounts/${closingId}` })).json().status).toBe('CLOSED')
      const types = ((await a2.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })).json() as { type: string; payload: any }[])
      expect(types.filter((n) => n.type === 'ONBOARDING_PASSED' && n.payload.customerHayId === lateCustomer)).toHaveLength(1)
      expect(run2.ctx.scheduler.pending()).toBe(0)
      await a2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
