/**
 * The 4 "KYC API" operations. createCase's body is optional (not validated by the route); the three
 * approval bodies are validated against OnboardingStageApprovalBody by defineRoute().
 */
import type { FastifyInstance } from 'fastify'
import type { components } from '../../contract/generated/b2b-types.js'
import { defineRoute } from '../../contract/route.js'
import type { AppContext } from '../../context.js'
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
  defineRoute<never, never, UserConsentInput | undefined>(app, ctx, 'createCase', (req) => svc.toCreateCaseResponse(svc.createCase(req.body)))

  for (const { operationId, stage, message } of APPROVALS) {
    defineRoute<ByCustomerId, never, S['OnboardingStageApprovalBody']>(app, ctx, operationId, (req) => {
      svc.approve(req.params.customerId, stage, req.body.comments)
      return { message }
    })
  }
}
