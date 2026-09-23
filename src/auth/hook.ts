/**
 * Bearer-token guard for every /v0 and /v1 route. Failures use the spec's 403 ErrorResponse
 * (the B2B spec declares 403 on every operation and never 401).
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { errorBody } from '../lib/errors.js'
import type { TokenService } from './token.js'

const PROTECTED = /^\/v[01]\//

export function registerAuthHook(app: FastifyInstance, ctx: AppContext, tokens: TokenService): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!ctx.config.auth) return
    const path = req.url.split('?')[0] ?? ''
    if (!PROTECTED.test(path)) return
    const header = req.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      return reply.code(403).send(errorBody(403, 'FORBIDDEN: Missing bearer token'))
    }
    const result = await tokens.verify(header.slice(7).trim())
    if (!result.ok) {
      return reply.code(403).send(errorBody(403, result.reason === 'expired' ? 'FORBIDDEN: Token expired' : 'FORBIDDEN: Invalid token'))
    }
  })
}
