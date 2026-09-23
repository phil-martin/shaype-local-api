/**
 * customers domain — spec §5.1 (docs/superpowers/specs/2026-09-24-shaype-local-api-design.md) and docs/map/customers.md.
 * Publishes ctx.services.customers; other domains read customers through it and through the
 * customer.* domain events (events.ts). Expected shapes of later domains' services: deps.ts.
 *
 * Decisions beyond the spec (all covered in test/customers.test.ts):
 * - blockCustomer is allowed from every status except INACTIVE (docs give no precondition; the critic's
 *   matrix would also refuse REJECTED, but changeHayCustomerStatus may set BLOCKED from anywhere, so the
 *   refusal would be cosmetic). Consequence: a client status change made before the platform onboarding
 *   outcome arrives — block included — supersedes it: no ONBOARDING_* webhook is ever sent for that
 *   customer and unblockCustomer lands on ACTIVE (docs: unblock always -> ACTIVE). unblockCustomer also
 *   clears PLATFORM blocks.
 * - CUSTOMER_DETAILS_CHANGE is sent only when at least one of its four booleans is true (webhook-matrix
 *   decision); other field changes still publish customer.detailsChanged internally.
 * - CUSTOMER_STATUS_UPDATED {INACTIVE} for the platform closure cascade (markInactive) is behind
 *   config.emitCustomerInactive (default off, webhook-matrix C2); client-driven INACTIVE always emits.
 * - taxObligations are held as a non-empty list or absent ([] clears); HayCustomer.customData echoes an
 *   explicit null.
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import './schema.js'
import { assertDeps } from './deps.js'
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
  app.addHook('onReady', async () => assertDeps(ctx))
}
