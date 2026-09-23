/**
 * Test-control API (no auth), all under /_admin.
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { resetDatabase } from '../db/index.js'
import { isoUtc } from '../lib/clock.js'
import type { NotificationStatus } from '../events/webhooks.js'

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext, extras: { version: string; stubbed: string[] }): void {
  app.get('/_admin/health', async () => ({
    status: 'ok',
    version: extras.version,
    now: isoUtc(ctx.clock.now()),
    clockFrozen: ctx.clock.isFrozen,
    db: ctx.config.db,
    auth: ctx.config.auth,
    webhookUrl: ctx.config.webhookUrl,
    operations: ctx.handled.size,
    stubbed: extras.stubbed.length,
  }))

  app.get('/_admin/operations', async () => ({
    handled: [...ctx.handled].filter((id) => !extras.stubbed.includes(id)).sort(),
    stubbed: [...extras.stubbed].sort(),
  }))

  app.post('/_admin/reset', async () => {
    ctx.webhooks.close()
    resetDatabase(ctx.db)
    ctx.clock.reset()
    return { status: 'ok' }
  })

  app.get('/_admin/clock', async () => ({ now: isoUtc(ctx.clock.now()), frozen: ctx.clock.isFrozen }))
  app.post<{ Body: { set?: string; freeze?: string; advanceMs?: number; reset?: boolean } }>('/_admin/clock', {
    schema: { body: { type: 'object', properties: { set: { type: 'string' }, freeze: { type: 'string' }, advanceMs: { type: 'number' }, reset: { type: 'boolean' } } } },
  }, async (req) => {
    const b = req.body ?? {}
    if (b.reset) ctx.clock.reset()
    if (b.set) ctx.clock.set(b.set)
    if (b.freeze) ctx.clock.freeze(b.freeze)
    if (b.advanceMs) ctx.clock.advance(b.advanceMs)
    return { now: isoUtc(ctx.clock.now()), frozen: ctx.clock.isFrozen }
  })

  app.get<{ Querystring: { type?: string; status?: NotificationStatus; sinceSeq?: number; limit?: number } }>('/_admin/notifications', {
    schema: { querystring: { type: 'object', properties: { type: { type: 'string' }, status: { type: 'string', enum: ['queued', 'delivered', 'failed', 'stored'] }, sinceSeq: { type: 'integer' }, limit: { type: 'integer' } } } },
  }, async (req) => ctx.webhooks.list(req.query))
  app.delete('/_admin/notifications', async () => ({ deleted: ctx.webhooks.clear() }))
  app.get<{ Params: { id: string } }>('/_admin/notifications/:id', async (req, reply) => ctx.webhooks.get(req.params.id) ?? reply.code(404).send({ message: 'notification not found' }))
  app.post<{ Params: { id: string } }>('/_admin/notifications/:id/redeliver', async (req, reply) => ctx.webhooks.redeliver(req.params.id) ?? reply.code(404).send({ message: 'notification not found' }))
  app.post('/_admin/notifications/flush', async () => {
    await ctx.webhooks.waitForIdle()
    return { status: 'idle' }
  })
}
