/**
 * Domain registry, in dependency order. Each domain's register(app, ctx) wires its operations with
 * defineRoute() and publishes its service in ctx.services; anything left unregistered falls through to
 * the spec-conformant stubs.
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import * as customers from './customers/index.js'
import * as accounts from './accounts/index.js'
import * as transactions from './transactions/index.js'
import * as cards from './cards/index.js'
import * as payidNpp from './payid-npp/index.js'
import * as bpay from './bpay/index.js'
import * as directEntry from './direct-entry/index.js'
import * as groupsStacks from './groups-stacks/index.js'
import * as kyc from './kyc/index.js'
import * as payto from './payto/index.js'
import * as utilities from './utilities/index.js'

export const domains: { name: string; register: (app: FastifyInstance, ctx: AppContext) => void }[] = [
  { name: 'customers', register: customers.register },
  { name: 'accounts', register: accounts.register },
  { name: 'transactions', register: transactions.register },
  { name: 'cards', register: cards.register },
  { name: 'payid-npp', register: payidNpp.register },
  { name: 'bpay', register: bpay.register },
  { name: 'direct-entry', register: directEntry.register },
  { name: 'groups-stacks', register: groupsStacks.register },
  { name: 'kyc', register: kyc.register },
  { name: 'payto', register: payto.register },
  { name: 'utilities', register: utilities.register },
]

export function registerDomains(app: FastifyInstance, ctx: AppContext): void {
  for (const d of domains) d.register(app, ctx)
}
