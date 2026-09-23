/**
 * customers domain — spec §5.1 (docs/superpowers/specs/2026-09-24-shaype-local-api-design.md) and docs/map/customers.md.
 * Publishes ctx.services.customers; other domains read customers through it and through the
 * customer.* domain events (events.ts). Expected shapes of later domains' services: deps.ts.
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import './schema.js'
import { CustomerRepo } from './repo.js'
import { CustomersService } from './service.js'
import { registerEvents } from './events.js'
import { registerRoutes } from './routes.js'

export { CustomersService } from './service.js'
export type { Customer, CustomerStatus, StatusReason, BlockedBy } from './repo.js'
export type { AccountsDep, CardsDep } from './deps.js'

export function register(app: FastifyInstance, ctx: AppContext): void {
  const svc = new CustomersService(ctx, new CustomerRepo(ctx.db))
  ctx.services.customers = svc
  registerEvents(ctx)
  registerRoutes(app, ctx, svc)
}
