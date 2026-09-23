import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

  it('stores notifications without delivering when no webhook url is configured', async () => {
    const other = await startApp()
    const n = other.ctx.webhooks.enqueue('v0', { type: 'TRANSACTION' })
    expect(n.status).toBe('stored')
    await other.app.close()
  })
})
