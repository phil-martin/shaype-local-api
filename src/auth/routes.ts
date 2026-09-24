/**
 * POST /oauth2/token — the Cognito client-credentials endpoint (form-encoded), accepting the client
 * either as HTTP Basic credentials or as client_id/client_secret body fields. The form parser lives in an
 * encapsulated plugin holding only this route: the B2B operations take application/json only.
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import type { TokenService } from './token.js'

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext, tokens: TokenService): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)))
      } catch (e) {
        done(e as Error, undefined)
      }
    })
    registerTokenRoute(scope, ctx, tokens)
  })
}

function registerTokenRoute(app: FastifyInstance, ctx: AppContext, tokens: TokenService): void {
  app.post('/oauth2/token', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>
    let clientId = body.client_id
    let clientSecret = body.client_secret
    const auth = req.headers.authorization
    if (auth?.startsWith('Basic ')) {
      const [id, secret] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':', 2)
      clientId = id
      clientSecret = secret
    }
    reply.header('cache-control', 'no-store')
    if (body.grant_type !== 'client_credentials') return reply.code(400).send({ error: 'unsupported_grant_type' })
    if (!clientId || !clientSecret) return reply.code(400).send({ error: 'invalid_request' })
    if (clientId !== ctx.config.clientId || clientSecret !== ctx.config.clientSecret) return reply.code(400).send({ error: 'invalid_client' })
    return tokens.issue(clientId)
  })
}
