import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { createRequire } from 'node:module'
import { registerAdminRoutes } from './admin/routes.js'
import { bearerFailure, registerAuthHook } from './auth/hook.js'
import { registerAuthRoutes } from './auth/routes.js'
import { TokenService } from './auth/token.js'
import { defaultConfig, type Config } from './config.js'
import { operations, requestComponents, responseComponents } from './contract/index.js'
import type { AppContext } from './context.js'
import { openDatabase } from './db/index.js'
import { DomainEvents } from './events/bus.js'
import { WebhookDispatcher } from './events/webhooks.js'
import { Clock } from './lib/clock.js'
import { Scheduler } from './lib/scheduler.js'
import { ApiError, errorBody } from './lib/errors.js'
import { registerStubs } from './stubs/index.js'
import { registerDomains } from './domains/index.js'

const pkg = createRequire(import.meta.url)('../package.json') as { version: string }

export interface BuiltServer {
  app: FastifyInstance
  ctx: AppContext
  stubbed: string[]
}

export async function buildServer(overrides: Partial<Config> = {}, deps: { fetch?: typeof fetch } = {}): Promise<BuiltServer> {
  const config: Config = { ...defaultConfig, ...overrides }
  const clock = new Clock()
  const tokens = new TokenService(clock, config.tokenTtlSeconds)
  const app = Fastify({
    logger: { level: config.logLevel },
    // PayID path values are free text (EMAIL up to 256 chars, ORGANISATION names); Fastify's 100-char
    // default would refuse them in the router, so the domain can 422 instead. (routerOptions: the top-level
    // option is deprecated, FSTDEP022.)
    routerOptions: { maxParamLength: 512 },
    // A malformed percent-escape or an over-long path parameter is refused by the router before any hook or
    // handler runs; answer it like any other input fault (400 ErrorResponse, spec §4), after the same bearer
    // check the auth hook applies (403) to everything outside /_admin and /oauth2.
    frameworkErrors: (err, req, res) => {
      const reply = res as unknown as FastifyReply
      void (async () => {
        const path = req.raw.url ?? ''
        const failure = config.auth && !/^\/(_admin|oauth2)(\/|$)/.test(path) ? await bearerFailure(req, tokens) : null
        if (failure) return reply.code(403).send(errorBody(403, failure))
        return reply.code(400).send(errorBody(400, `BAD_REQUEST: ${err.message}`))
      })()
    },
    ajv: {
      customOptions: {
        coerceTypes: 'array',
        useDefaults: true,
        removeAdditional: false,
        allErrors: false,
        strict: false,
        unicodeRegExp: false,
        allowUnionTypes: true,
      },
    },
  })

  const db = openDatabase(config.db)
  const events = new DomainEvents()
  const webhooks = new WebhookDispatcher(db, config, clock, app.log, deps.fetch)
  const scheduler = new Scheduler(clock, config.asyncDelayMs, app.log, db)
  const ctx: AppContext = { config, db, clock, log: app.log, events, webhooks, scheduler, services: {} as AppContext['services'], handled: new Set() }

  for (const s of requestComponents) app.addSchema(s)
  for (const s of responseComponents) app.addSchema(s)

  // Most HTTP clients send `Content-Type: application/json` on every POST, body or not. Fastify's default
  // parser answers an empty body with FST_ERR_CTP_EMPTY_JSON_BODY (400); here it is the same as no body at
  // all, so the optional-body ops (bodyRequired: false, e.g. createCase) accept it and the required-body
  // ops fail schema validation ("body must be object") as they do without the header.
  const parseJson = app.getDefaultJsonParser('error', 'error')
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    if (body.length === 0) return done(null, undefined)
    parseJson(req, body, done)
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      reply.code(err.status)
      return reply.send(err.body ?? errorBody(err.status, err.message))
    }
    const e = err as Error & { validation?: unknown; statusCode?: number; code?: string }
    if (e.validation) return reply.code(400).send(errorBody(400, `BAD_REQUEST: ${e.message}`))
    // Every other client fault is malformed input (spec §4: 400), whatever status Fastify gives it: an
    // unsupported media type (415) or an oversized body (413) is declared nowhere.
    if (e.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || (e.statusCode && e.statusCode < 500)) {
      return reply.code(400).send(errorBody(400, `BAD_REQUEST: ${e.message}`))
    }
    req.log.error({ err }, 'unhandled error')
    return reply.code(500).send(errorBody(500, `INTERNAL_ERROR: ${e.message}`))
  })
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(errorBody(404, `NOT_FOUND: Route ${req.method}:${req.url.split('?')[0]} not found`))
  })

  if (config.validateResponses) {
    // Loaded only when asked for: Ajv is a test-time concern and stays off the default startup path.
    const { installResponseValidation } = await import('./contract/validate-responses.js')
    installResponseValidation(app)
  }
  registerAuthHook(app, ctx, tokens)
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/_admin/')) return
    await scheduler.tick()
  })
  registerAuthRoutes(app, ctx, tokens)
  registerDomains(app, ctx)
  scheduler.restore() // steps a file database kept from an earlier run (every handler is defined by now)
  const stubbed = registerStubs(app, ctx)
  registerAdminRoutes(app, ctx, { version: pkg.version, stubbed })

  const missing = operations.filter((o) => !ctx.handled.has(o.operationId))
  if (missing.length) throw new Error(`Operations without a route: ${missing.map((m) => m.operationId).join(', ')}`)

  app.addHook('onClose', async () => {
    scheduler.cancelAll()
    await webhooks.close() // aborts the delivery in flight and waits for the loop to stop: it must not outlive the database
    db.close()
  })
  return { app, ctx, stubbed }
}
