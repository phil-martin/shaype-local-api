import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startApp } from './helpers.js'
import type { BuiltServer } from '../src/server.js'

interface Call { url: string; body: any }

function fakeFetch(script: number[], calls: Call[]): typeof fetch {
  return (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    const status = script.shift() ?? 200
    return new Response(null, { status })
  }) as typeof fetch
}

describe('webhook dispatcher', () => {
  let built: BuiltServer
  const calls: Call[] = []
  const script: number[] = []
  beforeAll(async () => {
    built = await startApp({ webhookUrl: 'http://sut.local/base/', webhookBackoffMs: 5, webhookMaxAttempts: 3 }, { fetch: fakeFetch(script, calls) })
  })
  afterAll(async () => { await built.app.close() })

  it('POSTs v0 notifications to the spec path and records delivery', async () => {
    const n = built.ctx.webhooks.enqueue('v0', { type: 'ACCOUNT_STATUS_CHANGE', accountStatusChangeEvent: { status: 'ACTIVE' } })
    await built.ctx.webhooks.waitForIdle()
    expect(calls.at(-1)?.url).toBe('http://sut.local/base/api/hay/v0/communications/notification')
    expect(calls.at(-1)?.body).toMatchObject({ type: 'ACCOUNT_STATUS_CHANGE', idempotencyKey: n.id })
    expect(built.ctx.webhooks.get(n.id)?.status).toBe('delivered')
  })

  it('retries on 5xx/429/401/403 with backoff and gives up after max attempts', async () => {
    script.push(500, 429, 403)
    const n = built.ctx.webhooks.enqueue('v1', { type: 'BATCH_COMPLETED' })
    await built.ctx.webhooks.waitForIdle()
    const row = built.ctx.webhooks.get(n.id)!
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(3)
    expect(row.lastStatus).toBe(403)
    expect(calls.filter((c) => c.body.idempotencyKey === n.id)).toHaveLength(3)
    expect(calls.at(-1)?.url).toBe('http://sut.local/base/api/hay/v1/communications/notification')
  })

  it('treats other 4xx as terminal without retry', async () => {
    script.push(422)
    const n = built.ctx.webhooks.enqueue('v0', { type: 'CUSTOMER_DETAILS_CHANGE' })
    await built.ctx.webhooks.waitForIdle()
    expect(built.ctx.webhooks.get(n.id)).toMatchObject({ status: 'failed', attempts: 1, lastStatus: 422 })
  })

  it('lists, filters, clears and redelivers through the admin API', async () => {
    const list = await built.app.inject({ method: 'GET', url: '/_admin/notifications?type=ACCOUNT_STATUS_CHANGE' })
    expect(list.json()).toHaveLength(1)
    const id = list.json()[0].id
    const re = await built.app.inject({ method: 'POST', url: `/_admin/notifications/${id}/redeliver` })
    expect(re.statusCode).toBe(200)
    await built.ctx.webhooks.waitForIdle()
    expect(built.ctx.webhooks.get(id)?.attempts).toBe(2)
    const del = await built.app.inject({ method: 'DELETE', url: '/_admin/notifications' })
    expect(del.json().deleted).toBe(3)
  })

  it('order=desc lists the newest first, so limit=1 gives the last seq however many are stored', async () => {
    const other = await startApp()
    const ids = Array.from({ length: 5 }, () => other.ctx.webhooks.enqueue('v0', { type: 'TRANSACTION' }).id)
    const oldest = await other.app.inject({ method: 'GET', url: '/_admin/notifications?limit=2' })
    expect(oldest.json().map((n: any) => n.id)).toEqual(ids.slice(0, 2))
    const newest = await other.app.inject({ method: 'GET', url: '/_admin/notifications?order=desc&limit=1' })
    expect(newest.json().map((n: any) => [n.id, n.seq])).toEqual([[ids[4], other.ctx.webhooks.get(ids[4]!)!.seq]])
    const since = await other.app.inject({ method: 'GET', url: `/_admin/notifications?order=desc&sinceSeq=${other.ctx.webhooks.get(ids[2]!)!.seq}` })
    expect(since.json().map((n: any) => n.id)).toEqual([ids[4], ids[3]])
    expect((await other.app.inject({ method: 'GET', url: '/_admin/notifications?order=sideways' })).statusCode).toBe(400)
    await other.app.close()
  })

  it('stores notifications without delivering when no webhook url is configured', async () => {
    const other = await startApp()
    const n = other.ctx.webhooks.enqueue('v0', { type: 'TRANSACTION' })
    expect(n.status).toBe('stored')
    await other.app.close()
  })
})

/** A receiver that holds every request open until release() (then answers 200 at once). */
class SlowReceiver {
  /** Notification types, in arrival order. */
  readonly received: string[] = []
  private readonly held: http.ServerResponse[] = []
  private released = false
  private arrivals: (() => void)[] = []
  private readonly server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      this.received.push((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { type: string }).type)
      if (this.released) res.writeHead(200).end()
      else this.held.push(res)
      const a = this.arrivals
      this.arrivals = []
      a.forEach((f) => f())
    })
  })
  url = ''

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }
  /** Resolves once `count` requests have arrived. */
  async arrived(count: number): Promise<void> {
    while (this.received.length < count) await new Promise<void>((resolve) => this.arrivals.push(resolve))
  }
  release(): void {
    this.released = true
    for (const res of this.held.splice(0)) if (!res.destroyed) res.writeHead(200).end()
  }
  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()))
    this.server.closeAllConnections()
    await closed
  }
}

describe('webhook dispatcher shutdown and reset with a delivery in flight', () => {
  let receiver: SlowReceiver
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  beforeEach(async () => {
    receiver = await new SlowReceiver().start()
    unhandled.length = 0
    process.on('unhandledRejection', onUnhandled)
  })
  afterEach(async () => {
    process.off('unhandledRejection', onUnhandled)
    await receiver.close()
  })
  /** Lets a delivery that outlived close/reset run to completion (and fail, if it touches the database). */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
  /** Real fetch, recording each request's abort signal. */
  const signals: AbortSignal[] = []
  const recording = ((url: any, init: any) => { signals.push(init.signal); return fetch(url, init) }) as typeof fetch
  beforeEach(() => { signals.length = 0 })

  it('app.close() stops the in-flight delivery before closing the database', async () => {
    const built = await startApp({ webhookUrl: receiver.url }, { fetch: recording })
    built.ctx.webhooks.enqueue('v0', { type: 'TRANSACTION' })
    await receiver.arrived(1)
    await built.app.close()
    expect(signals.map((s) => s.aborted)).toEqual([true])
    receiver.release()
    await settle()
    expect(unhandled).toEqual([])
    expect(receiver.received).toEqual(['TRANSACTION'])
  })

  it('a delivery that ignores the abort does not touch the rows once the dispatcher is closed', async () => {
    let finish!: () => void
    const hanging = (async () => { await new Promise<void>((resolve) => { finish = resolve }); return new Response(null, { status: 200 }) }) as typeof fetch
    const built = await startApp({ webhookUrl: 'http://sut.local' }, { fetch: hanging })
    const n = built.ctx.webhooks.enqueue('v0', { type: 'TRANSACTION' })
    await built.ctx.webhooks.waitForIdle(20).catch(() => {}) // the delivery is now in flight
    await built.ctx.webhooks.close(20) // bounded: the fetch never settles on its own
    finish()
    await settle()
    expect(built.ctx.webhooks.get(n.id)).toMatchObject({ status: 'queued', attempts: 0, deliveredAt: null })
    await built.app.close()
    expect(unhandled).toEqual([])
  })

  it('/_admin/reset drops the in-flight delivery and everything queued behind it; later notifications are delivered', async () => {
    const built = await startApp({ webhookUrl: receiver.url }, { fetch: recording })
    built.ctx.webhooks.enqueue('v0', { type: 'BEFORE_RESET_1' })
    built.ctx.webhooks.enqueue('v0', { type: 'BEFORE_RESET_2' })
    await receiver.arrived(1)
    expect((await built.app.inject({ method: 'POST', url: '/_admin/reset' })).statusCode).toBe(200)
    expect(signals.map((s) => s.aborted)).toEqual([true])
    receiver.release()
    await settle()
    const after = built.ctx.webhooks.enqueue('v0', { type: 'AFTER_RESET' })
    await built.ctx.webhooks.waitForIdle()
    expect(receiver.received).toEqual(['BEFORE_RESET_1', 'AFTER_RESET'])
    expect(built.ctx.webhooks.list().map((r) => [r.type, r.status])).toEqual([['AFTER_RESET', 'delivered']])
    expect(after.id).toBe(built.ctx.webhooks.list()[0]!.id)
    await built.app.close()
    expect(unhandled).toEqual([])
  })
})
