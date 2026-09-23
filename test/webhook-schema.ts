/**
 * Test-only validator for outbound webhook payloads: compiles the generated notification-webhooks
 * components (wh:*) with Ajv and asserts a payload against wh:NotificationDto (v0) or
 * wh:NotificationDtoV1 (v1).
 */
import { Ajv, type ValidateFunction } from 'ajv'
import addFormatsModule from 'ajv-formats'
import { webhookContract } from '../src/contract/index.js'

const ajv = new Ajv({ strict: false, allowUnionTypes: true, unicodeRegExp: false, allErrors: true })
// ajv-formats is CommonJS: the callable plugin is also exposed as `.default`, which is what the NodeNext types see.
addFormatsModule.default(ajv)
for (const s of webhookContract.components) ajv.addSchema(s)

const validators: Record<string, ValidateFunction> = {}
function validator(id: string): ValidateFunction {
  return (validators[id] ??= ajv.compile({ $ref: `${id}#` }))
}

export function assertValidNotification(payload: unknown, version: 'v0' | 'v1' = 'v0'): void {
  const v = validator(version === 'v0' ? 'wh:NotificationDto' : 'wh:NotificationDtoV1')
  if (!v(payload)) {
    throw new Error(`webhook payload does not match ${version} schema: ${ajv.errorsText(v.errors, { separator: '\n' })}\n${JSON.stringify(payload, null, 2)}`)
  }
}
