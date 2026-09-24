/**
 * kyc domain — spec §5.10 (docs/superpowers/specs/2026-09-24-shaype-local-api-design.md) and docs/map/kyc.md.
 * Owns the 4 "KYC API" operations and publishes ctx.services.kyc (service.ts). Depends on customers
 * (registered earlier): approvals go through customers.setStatus so CUSTOMER_STATUS_UPDATED fires, and the
 * failed stages they clear are the ones customers' platform outcome reports (customer.onboardingFailed).
 *
 * Contract deviations: none — every response follows the declared schema.
 *
 * Decisions beyond the spec (all covered in test/kyc.test.ts):
 * - createCase accepts an absent body, JSON null or a literal {} (the docs sample sends none; an empty body
 *   with Content-Type: application/json counts as absent); userLocationCountry defaults to AUS. Any other
 *   body is validated against UserConsentRequestBody with the app's ajv (routes.ts; optional bodies get no
 *   route schema), so userLocationCountry is required, then the prose-only rules: userLocationCountry
 *   ^[A-Z]{3}$ (ISO 3166-1 alpha-3), consentObtained 'yes' | 'no' | 'na' -> 400.
 *   scanCase.timestamp uses the docs sample's millisecond form. webLink is an unserved local URL in the shape
 *   of the sample (…?authorizationToken=<mobileToken>&locale=en-US); mobileToken is a JWS-shaped opaque
 *   string (HS512 header, gzip payload). No webhook is emitted for case creation.
 * - Case <-> customer link: customers does not consult this domain on create (no validation of
 *   identityVerificationCaseId there), so the link is made here on customer.created when the id names a
 *   known, unlinked case (journeyId is folded into identityVerificationCaseId by customers). One customer
 *   per case. The case verdict is set once from the platform's first PENDING_APPROVAL exit (ACTIVE -> PASSED,
 *   REFERRED -> WARNING, REJECTED -> REJECTED); client status changes and manual approvals never rewrite it.
 * - approve*Check: customer must be REFERRED (422 INVALID_STATE otherwise — ACTIVE, PENDING_APPROVAL incl.
 *   skipKyc, REJECTED, BLOCKED, INACTIVE); unknown customer 404. Each endpoint approves its own stage
 *   (amlKycCheck = KYC_AML_SCAN, documentCheck = DOCUMENT_SCAN, sanctionCheck = SANCTIONS_SCAN). Approving a
 *   stage that never failed records the approval and is otherwise a no-op; repeating an approval keeps the
 *   first comment. The customer activates when no FAILED stage remains — so a customer the client referred
 *   with no failure on record activates on the first approval, and a DUPLICATE_CHECK failure (no endpoint)
 *   can never be cleared here. Reduced KYC (onlySanctionsCheck) runs Sanctions Screening only: the
 *   platform fails SANCTIONS_SCAN (customers.completeOnboarding), and approveDocumentCheck /
 *   approveAmlKycCheck on such a customer are 422 INVALID_STATE (00-status C.1). Webhooks on activation: ONBOARDING_PASSED then
 *   CUSTOMER_STATUS_UPDATED {ACTIVE}, both actionOwner CLIENT; no webhook while stages remain outstanding.
 * - ConfirmationResponse.message = "<Operation summary> successful." (critic E8 template).
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import './schema.js'
import { KycRepo } from './repo.js'
import { KycService } from './service.js'
import { registerEvents } from './events.js'
import { registerRoutes } from './routes.js'

export { KycService, validateConsent, mintToken, ONBOARDING_STAGES, APPROVABLE_STAGES } from './service.js'
export type { ApprovableStage, ApprovalResult, UserConsentInput, CreateCaseResponse, ExternalCase } from './service.js'
export type { KycCase, CaseOutcome, ConsentObtained, OnboardingStage, OnboardingStageRecord, StageResult } from './repo.js'

export function register(app: FastifyInstance, ctx: AppContext): void {
  const svc = new KycService(ctx, new KycRepo(ctx.db))
  ctx.services.kyc = svc
  registerEvents(ctx, svc)
  registerRoutes(app, ctx, svc)
}
