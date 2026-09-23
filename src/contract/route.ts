/**
 * Registers a Fastify route for one OpenAPI operation, wiring the spec's schemas for request
 * validation (params/query/body) and response serialization (success + error codes).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppContext } from '../context.js'
import { getOperation, type JsonSchema } from './index.js'

export type RouteHandler<P = any, Q = any, B = any> = (
  req: FastifyRequest<{ Params: P; Querystring: Q; Body: B }>,
  reply: FastifyReply,
  ctx: AppContext,
) => unknown | Promise<unknown>

export function defineRoute<P = any, Q = any, B = any>(app: FastifyInstance, ctx: AppContext, operationId: string, handler: RouteHandler<P, Q, B>): void {
  const op = getOperation(operationId)
  if (ctx.handled.has(operationId)) throw new Error(`Duplicate handler for operation ${operationId}`)
  ctx.handled.add(operationId)

  const response: Record<string, JsonSchema> = {}
  for (const [code, schema] of Object.entries(op.responses)) if (schema) response[code] = schema

  const schema: Record<string, unknown> = { response }
  if (op.params) schema.params = op.params
  if (op.querystring) schema.querystring = op.querystring
  // Optional bodies (5 ops) are validated inside the handler; a route-level body schema would reject an absent body.
  if (op.body && op.bodyRequired) schema.body = op.body

  app.route({
    method: op.method,
    url: op.url,
    schema,
    config: { operationId, tag: op.tag },
    handler: async (req, reply) => {
      reply.code(op.successStatus)
      const out = await handler(req as any, reply, ctx)
      if (reply.sent) return reply
      if (out === undefined && op.responses[String(reply.statusCode)] === null) return reply.send()
      return out
    },
  })
}
