/**
 * Opt-in response-contract check (Config.validateResponses, on in the test helpers): an onSend hook that
 * validates every JSON body a /v0 or /v1 route sends against that operation's response schema for the
 * status code (the generated `res:` components, so `required` is not enforced — the same flavour the
 * serializer uses). Validators are compiled lazily, once per (operationId, status); statuses without a
 * declared body schema are skipped. A mismatch is logged at error level and the response is replaced by a
 * 500 ErrorResponse naming the operation and the Ajv error, so tests fail loudly.
 *
 * Contract deviations recorded in a domain's index.ts header are validated against the documented shape
 * instead (DEVIATIONS below).
 */
import { Ajv, type ValidateFunction } from 'ajv'
import addFormatsModule from 'ajv-formats'
import type { FastifyInstance } from 'fastify'
import { errorBody } from '../lib/errors.js'
import { operationById, responseComponents, type JsonSchema } from './index.js'

/** operationId -> status -> the schema the route is documented to answer instead of the declared one. */
const DEVIATIONS: Record<string, Record<string, JsonSchema>> = {
  // bpay/index.ts: retrieveBillers answers a paged BPayBillerResponse[] (docs/map/00-open-questions.md F1).
  retrieveBillers: { '200': { type: 'array', items: { $ref: 'res:BPayBillerResponse#' } } },
}

const PROTECTED = /^\/v[01]\//

export function installResponseValidation(app: FastifyInstance): void {
  const ajv = new Ajv({ strict: false, allowUnionTypes: true, unicodeRegExp: false, allErrors: true })
  // ajv-formats is CommonJS: the callable plugin is also exposed as `.default`, which is what the NodeNext types see.
  addFormatsModule.default(ajv)
  for (const s of responseComponents) ajv.addSchema(s)
  const cache = new Map<string, ValidateFunction | null>()

  const validatorFor = (operationId: string, status: number): ValidateFunction | null => {
    const key = `${operationId}:${status}`
    let v = cache.get(key)
    if (v === undefined) {
      const schema = DEVIATIONS[operationId]?.[String(status)] ?? operationById.get(operationId)?.responses[String(status)]
      v = schema ? ajv.compile(schema) : null
      cache.set(key, v)
    }
    return v
  }

  app.addHook('onSend', async (req, reply, payload) => {
    const operationId = (req.routeOptions.config as { operationId?: string } | undefined)?.operationId
    if (!operationId || typeof payload !== 'string' || payload.length === 0) return payload
    if (!PROTECTED.test(req.url.split('?')[0] ?? '')) return payload
    const type = reply.getHeader('content-type')
    if (typeof type === 'string' && !type.includes('json')) return payload
    const validate = validatorFor(operationId, reply.statusCode)
    if (!validate) return payload
    let body: unknown
    try {
      body = JSON.parse(payload)
    } catch {
      return payload
    }
    if (validate(body)) return payload
    const status = reply.statusCode
    const error = ajv.errorsText(validate.errors, { separator: '; ', dataVar: 'response' })
    req.log.error({ operationId, status, errors: validate.errors, body }, 'response does not match the contract')
    reply.code(500).header('content-type', 'application/json; charset=utf-8')
    return JSON.stringify(errorBody(500, `RESPONSE_CONTRACT_VIOLATION: ${operationId} (${req.method} ${req.url.split('?')[0]} -> ${status}): ${error}`))
  })
}
