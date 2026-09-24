/**
 * Domain events emitted by KycService and the subscriptions that tie KYC to the customers domain:
 * - kyc.onboardingCompleted -> ONBOARDING_PASSED (actionOwner CLIENT: a manual approval finished onboarding;
 *   the platform's own ONBOARDING_PASSED is emitted by customers/events.ts). Envelope per docs/map/webhooks.md
 *   §2.4 / §5.5 (no payload DTO).
 * - customer.created links the case named by identityVerificationCaseId; customer.onboardingFailed records the
 *   failed stage the approval endpoints act on; customer.statusChanged sets the linked case's verdict.
 */
import type { AppContext } from '../../context.js'
import { notifyV0, type ActionOwner } from '../../events/notify.js'
import type { Customer } from '../customers/index.js'
import type { KycCase, OnboardingStage } from './repo.js'
import type { ApprovableStage, KycService } from './service.js'

declare module '../../events/bus.js' {
  interface DomainEventMap {
    'kyc.caseCreated': { case: KycCase }
    /** An approve*Check call marked the stage APPROVED (or repeated an earlier approval); `outstanding` = failed stages still open afterwards. */
    'kyc.stageApproved': { customer: Customer; stage: ApprovableStage; comments?: string; outstanding: OnboardingStage[] }
    /** The last outstanding stage was approved; emitted just before customers.setStatus(ACTIVE). */
    'kyc.onboardingCompleted': { customer: Customer; actionOwner: ActionOwner }
  }
}

export function registerEvents(ctx: AppContext, svc: KycService): void {
  ctx.events.on('kyc.onboardingCompleted', ({ customer, actionOwner }) => {
    notifyV0(ctx, { customerHayId: customer.id, type: 'ONBOARDING_PASSED', actionOwner })
  })
  ctx.events.on('customer.created', ({ customer }) => {
    if (customer.identityVerificationCaseId) svc.linkCase(customer.identityVerificationCaseId, customer.id)
  })
  ctx.events.on('customer.onboardingFailed', ({ customer, state, submissionFailure }) => {
    svc.recordFailure(customer.id, state, submissionFailure)
  })
  ctx.events.on('customer.statusChanged', ({ customer, previousStatus, actionOwner }) => {
    svc.reflectOnboardingOutcome(customer, previousStatus, actionOwner)
  })
}
