/**
 * Opt-in response-contract check (Config.validateResponses, on in the test helpers). Every JSON body a /v0
 * or /v1 route answers is validated against that operation's response schema for the status code (the
 * generated `res:` components, so `required` is not enforced — the same flavour the serializer uses):
 *
 * - Object bodies are checked in preSerialization, on a JSON round-trip of what the handler returned, i.e.
 *   before fast-json-stringify coerces ('12.5' -> 12.5, null -> "") or strips fields and hides the error.
 * - Bodies sent as strings (retrieveBillers, see DEVIATIONS) never reach preSerialization and are checked
 *   in onSend.
 * - A status the operation does not declare: >= 400 is checked against res:ErrorResponse (404 NOT_FOUND is
 *   undeclared on almost every operation); 2xx is a violation unless DEVIATIONS documents it.
 *
 * Validators are compiled lazily, once per (operationId, status). A mismatch is logged at error level and
 * the response is replaced by a 500 ErrorResponse naming the operation and the Ajv error, so tests fail
 * loudly.
 *
 * Contract deviations recorded in a domain's index.ts header are validated against the documented shape
 * instead (DEVIATIONS below).
 */
import { Ajv, type ValidateFunction } from 'ajv'
import addFormatsModule from 'ajv-formats'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { errorBody } from '../lib/errors.js'
import { operationById, responseComponents, type JsonSchema } from './index.js'

/** operationId -> status -> the schema the route is documented to answer instead of the declared one. */
const DEVIATIONS: Record<string, Record<string, JsonSchema>> = {
  // bpay/index.ts: retrieveBillers answers a paged BPayBillerResponse[] (docs/map/00-open-questions.md F1).
  retrieveBillers: { '200': { type: 'array', items: { $ref: 'res:BPayBillerResponse#' } } },
}

const PROTECTED = /^\/v[01]\//
const ERROR_RESPONSE: JsonSchema = { $ref: 'res:ErrorResponse#' }

/** What to do with a body answered with a given status: validate it, refuse the status, or let it through. */
type Check = { validate: ValidateFunction } | { undeclared: true } | null

export function installResponseValidation(app: FastifyInstance): void {
  const ajv = new Ajv({ strict: false, allowUnionTypes: true, unicodeRegExp: false, allErrors: true })
  // ajv-formats is CommonJS: the callable plugin is also exposed as `.default`, which is what the NodeNext types see.
  addFormatsModule.default(ajv)
  for (const s of responseComponents) ajv.addSchema(s)
  const cache = new Map<string, Check>()
  /** Requests whose body preSerialization already checked (onSend sees the serialized form of the same body). */
  const checked = new WeakSet<FastifyRequest>()

  const checkFor = (operationId: string, status: number): Check => {
    const key = `${operationId}:${status}`
    let c = cache.get(key)
    if (c === undefined) {
      const responses = operationById.get(operationId)?.responses ?? {}
      const deviation = DEVIATIONS[operationId]?.[String(status)]
      const declared = String(status) in responses
      const schema = deviation ?? (declared ? responses[String(status)] : status >= 400 ? ERROR_RESPONSE : null)
      if (schema) c = { validate: ajv.compile(schema) }
      else if (!deviation && !declared && status >= 200 && status < 300) c = { undeclared: true }
      else c = null // declared without a body, or an informational/redirect status
      cache.set(key, c)
    }
    return c
  }

  /** The operation a /v0 or /v1 request was routed to, or undefined when the response is not checked. */
  const operationOf = (req: FastifyRequest): string | undefined => {
    const operationId = (req.routeOptions.config as { operationId?: string } | undefined)?.operationId
    return operationId && PROTECTED.test(req.url.split('?')[0] ?? '') ? operationId : undefined
  }

  /** Validates `body`; answers the 500 violation body (and sets the status) when it breaks the contract. */
  const violation = (req: FastifyRequest, reply: FastifyReply, operationId: string, body: unknown): ReturnType<typeof errorBody> | undefined => {
    const check = checkFor(operationId, reply.statusCode)
    if (!check) return undefined
    let error: string
    if ('undeclared' in check) error = `status ${reply.statusCode} is not declared by the contract`
    else if (check.validate(body)) return undefined
    else error = ajv.errorsText(check.validate.errors, { separator: '; ', dataVar: 'response' })
    const status = reply.statusCode
    req.log.error({ operationId, status, errors: 'validate' in check ? check.validate.errors : undefined, body }, 'response does not match the contract')
    reply.code(500)
    return errorBody(500, `RESPONSE_CONTRACT_VIOLATION: ${operationId} (${req.method} ${req.url.split('?')[0]} -> ${status}): ${error}`)
  }

  app.addHook('preSerialization', async (req, reply, payload: unknown) => {
    const operationId = operationOf(req)
    if (!operationId) return payload
    checked.add(req)
    // What the client receives from a faithful serializer: toJSON applied, undefined properties dropped.
    return violation(req, reply, operationId, JSON.parse(JSON.stringify(payload))) ?? payload
  })

  app.addHook('onSend', async (req, reply, payload) => {
    const operationId = operationOf(req)
    if (!operationId || checked.has(req)) return payload
    if (payload === undefined || payload === null || payload === '') {
      // No body to validate, but the status itself may be undeclared (e.g. a bare 204).
      const check = checkFor(operationId, reply.statusCode)
      if (!check || !('undeclared' in check)) return payload
      reply.header('content-type', 'application/json; charset=utf-8')
      return JSON.stringify(violation(req, reply, operationId, undefined))
    }
    if (typeof payload !== 'string') return payload
    const type = reply.getHeader('content-type')
    if (typeof type === 'string' && !type.includes('json')) return payload
    let body: unknown
    try {
      body = JSON.parse(payload)
    } catch {
      return payload
    }
    const refused = violation(req, reply, operationId, body)
    if (!refused) return payload
    reply.header('content-type', 'application/json; charset=utf-8')
    return JSON.stringify(refused)
  })
}
