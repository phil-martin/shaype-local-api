import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withIdempotency } from '../src/lib/idempotency.js'
import { startApp } from './helpers.js'
import type { BuiltServer } from '../src/server.js'

let built: BuiltServer
beforeAll(async () => { built = await startApp() })
afterAll(async () => { await built.app.close() })

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

  it('runs tick jobs on requests and on /_admin/flush', async () => {
    let ticks = 0
    built.ctx.scheduler.onTick(() => { ticks++ })
    await built.app.inject({ method: 'GET', url: '/v1/products' })
    expect(ticks).toBeGreaterThanOrEqual(1)
    const res = await built.app.inject({ method: 'POST', url: '/_admin/flush' })
    expect(res.json()).toEqual({ status: 'idle' })
  })
})
