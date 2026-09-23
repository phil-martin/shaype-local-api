import type { FastifyBaseLogger } from 'fastify'
import type { Config } from './config.js'
import type { Db } from './db/index.js'
import type { Clock } from './lib/clock.js'
import type { WebhookDispatcher } from './events/webhooks.js'
import type { DomainEvents } from './events/bus.js'

export interface AppContext {
  config: Config
  db: Db
  clock: Clock
  log: FastifyBaseLogger
  events: DomainEvents
  webhooks: WebhookDispatcher
  /** operationIds with a registered handler (used to assert full coverage and to pick stubs) */
  handled: Set<string>
}
