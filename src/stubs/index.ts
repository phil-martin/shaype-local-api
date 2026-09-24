/**
 * Registers a spec-conformant stub for every operation that no domain module handles. Stubs
 * validate input like real routes and answer with deterministic example data (see example.ts):
 * an optional body (bodyRequired false, e.g. enrolCard) is schema-validated when one is sent (400),
 * and an op whose request body declares idempotencyKey (the FX / liquidity creates, spec §4) replays
 * its stored response for the same key and body and answers 422 IDEMPOTENCY_KEY_REUSED for another body.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { operations, requestComponents, type JsonSchema, type Operation } from '../contract/index.js'
import { defineRoute } from '../contract/route.js'
import type { AppContext } from '../context.js'
import { badRequest } from '../lib/errors.js'
import { withIdempotency } from '../lib/idempotency.js'
import { exampleFor } from './example.js'

const requestComponentById = new Map(requestComponents.map((c) => [c.$id, c]))

export function registerStubs(app: FastifyInstance, ctx: AppContext): string[] {
  const stubbed: string[] = []
  for (const op of operations) {
    if (ctx.handled.has(op.operationId)) continue
    stubbed.push(op.operationId)
    const keyed = declaresIdempotencyKey(op.body)
    defineRoute(app, ctx, op.operationId, async (req, reply) => {
      reply.header('x-shaype-local-stub', op.operationId)
      if (op.body && !op.bodyRequired) validatePresentBody(req, op.body)
      const answer = () => {
        const schema = op.responses[String(op.successStatus)]
        return { status: op.successStatus, body: schema ? exampleFor(schema, ctx.clock.now()) : undefined }
      }
      if (!keyed) return answer().body
      const body = req.body as { idempotencyKey?: string }
      return (await withIdempotency(ctx, op.operationId, body.idempotencyKey, { params: req.params, body }, answer)).body
    })
  }
  return stubbed
}

/** True when the op's request body schema (a req: component) has an idempotencyKey property. */
function declaresIdempotencyKey(body: Operation['body']): boolean {
  const ref = (body as { $ref?: string } | null | undefined)?.$ref
  const component = ref ? requestComponentById.get(ref.replace(/#$/, '')) : undefined
  return Boolean((component as { properties?: Record<string, unknown> } | undefined)?.properties?.idempotencyKey)
}

/** An optional body is not validated by the route (it may be absent); a present one is checked here (400). */
function validatePresentBody(req: FastifyRequest, schema: JsonSchema): void {
  const body: unknown = req.body
  if (body === undefined || body === null) return
  const validate = req.compileValidationSchema(schema, 'body')
  if (validate(body)) return
  const [e] = validate.errors ?? []
  throw badRequest(`BAD_REQUEST: body${e?.instancePath ?? ''} ${e?.message ?? 'is invalid'}`)
}
