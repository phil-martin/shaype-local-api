/**
 * Domain registry. Each domain module exports `register(app, ctx)` and wires its operations with
 * defineRoute(); anything left unregistered falls through to the spec-conformant stubs.
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'

export const domains: { name: string; register: (app: FastifyInstance, ctx: AppContext) => void }[] = []

export function registerDomains(app: FastifyInstance, ctx: AppContext): void {
  for (const d of domains) d.register(app, ctx)
}
