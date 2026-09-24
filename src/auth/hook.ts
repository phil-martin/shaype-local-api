/**
 * Bearer-token guard for every /v0 and /v1 route. Failures use the spec's 403 ErrorResponse
 * (the B2B spec declares 403 on every operation and never 401). The decision follows the routed operation
 * (every B2B route carries its operationId), not the raw request target: the router decodes
 * percent-escapes and accepts absolute-form targets (`/%76%31/...`, `http://host/v1/...`), which a
 * prefix test on req.url would let through. Unrouted /v0 and /v1 paths are guarded too (403, not 404).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppContext } from '../context.js'
import { errorBody } from '../lib/errors.js'
import type { TokenService } from './token.js'

const PROTECTED = /^\/v[01]\//

/** True for a request routed to a B2B operation, or aimed at an unrouted /v0 or /v1 path. */
export function isB2bRequest(req: FastifyRequest): boolean {
  if ((req.routeOptions.config as { operationId?: string } | undefined)?.operationId) return true
  return PROTECTED.test(req.url.split('?')[0] ?? '')
}

/** The 403 message for a request without a valid bearer token, or null when its token is valid. */
export async function bearerFailure(req: FastifyRequest, tokens: TokenService): Promise<string | null> {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return 'FORBIDDEN: Missing bearer token'
  const result = await tokens.verify(header.slice(7).trim())
  if (result.ok) return null
  return result.reason === 'expired' ? 'FORBIDDEN: Token expired' : 'FORBIDDEN: Invalid token'
}

export function registerAuthHook(app: FastifyInstance, ctx: AppContext, tokens: TokenService): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!ctx.config.auth) return
    if (!isB2bRequest(req)) return
    const failure = await bearerFailure(req, tokens)
    if (failure) return reply.code(403).send(errorBody(403, failure))
  })
}
