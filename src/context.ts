import type { FastifyBaseLogger } from 'fastify'
import type { Config } from './config.js'
import type { Db } from './db/index.js'
import type { Clock } from './lib/clock.js'
import type { Scheduler } from './lib/scheduler.js'
import type { WebhookDispatcher } from './events/webhooks.js'
import type { DomainEvents } from './events/bus.js'

/**
 * Domain service singletons, registered by each domain's register() in dependency order.
 * Domains augment this interface: `declare module '../../context.js' { interface ServiceMap { customers: CustomersService } }`
 */
export interface ServiceMap {}

export interface AppContext {
  config: Config
  db: Db
  clock: Clock
  log: FastifyBaseLogger
  events: DomainEvents
  webhooks: WebhookDispatcher
  scheduler: Scheduler
  services: ServiceMap
  /** operationIds with a registered handler (used to assert full coverage and to pick stubs) */
  handled: Set<string>
}
