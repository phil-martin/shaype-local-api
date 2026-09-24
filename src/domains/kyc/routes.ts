/**
 * The 4 "KYC API" operations. createCase's body is optional, so defineRoute() attaches no body schema: a
 * present, non-empty body is validated here against UserConsentRequestBody with the app's own ajv (same
 * coercion and formats as every route-validated body); the three approval bodies are validated against
 * OnboardingStageApprovalBody by defineRoute().
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { components } from '../../contract/generated/b2b-types.js'
import { getOperation } from '../../contract/index.js'
import { defineRoute } from '../../contract/route.js'
import type { AppContext } from '../../context.js'
import { badRequest } from '../../lib/errors.js'
import type { ApprovableStage, KycService, UserConsentInput } from './service.js'

type S = components['schemas']
type ByCustomerId = { customerId: string }

/** operationId -> the stage it approves and the ConfirmationResponse text ("<Operation summary> successful."). */
const APPROVALS: { operationId: string; stage: ApprovableStage; message: string }[] = [
  { operationId: 'approveAmlKycCheck', stage: 'KYC_AML_SCAN', message: 'Approve AML Check successful.' },
  { operationId: 'approveDocumentCheck', stage: 'DOCUMENT_SCAN', message: 'Approve Document Check successful.' },
  { operationId: 'approveSanctionCheck', stage: 'SANCTIONS_SCAN', message: 'Approve Sanctions Check successful.' },
]

export function registerRoutes(app: FastifyInstance, ctx: AppContext, svc: KycService): void {
  const consentSchema = getOperation('createCase').body!
  defineRoute<never, never, UserConsentInput | undefined>(app, ctx, 'createCase', (req) => {
    validatePresentBody(req, consentSchema)
    return svc.toCreateCaseResponse(svc.createCase(req.body))
  })

  for (const { operationId, stage, message } of APPROVALS) {
    defineRoute<ByCustomerId, never, S['OnboardingStageApprovalBody']>(app, ctx, operationId, (req) => {
      svc.approve(req.params.customerId, stage, req.body.comments)
      return { message }
    })
  }
}

/**
 * Schema-validates an optional body when one was sent (400 in Fastify's "body/<path> <message>" form). An
 * absent body, JSON null and a literal {} carry nothing to validate and are left to the service's defaults.
 */
function validatePresentBody(req: FastifyRequest, schema: Record<string, unknown>): void {
  const body: unknown = req.body
  if (body === undefined || body === null) return
  if (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) return
  const validate = req.compileValidationSchema(schema, 'body')
  if (validate(body)) return
  const [e] = validate.errors ?? []
  throw badRequest(`BAD_REQUEST: body${e?.instancePath ?? ''} ${e?.message ?? 'is invalid'}`)
}
