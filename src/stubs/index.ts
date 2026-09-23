/**
 * Registers a spec-conformant stub for every operation that no domain module handles. Stubs
 * validate input like real routes and answer with deterministic example data (see example.ts).
 */
import type { FastifyInstance } from 'fastify'
import { operations } from '../contract/index.js'
import { defineRoute } from '../contract/route.js'
import type { AppContext } from '../context.js'
import { exampleFor } from './example.js'

export function registerStubs(app: FastifyInstance, ctx: AppContext): string[] {
  const stubbed: string[] = []
  for (const op of operations) {
    if (ctx.handled.has(op.operationId)) continue
    stubbed.push(op.operationId)
    defineRoute(app, ctx, op.operationId, (_req, reply) => {
      reply.header('x-shaype-local-stub', op.operationId)
      const schema = op.responses[String(op.successStatus)]
      return schema ? exampleFor(schema, ctx.clock.now()) : undefined
    })
  }
  return stubbed
}
