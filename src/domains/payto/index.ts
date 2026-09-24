/**
 * payto domain — spec §5.11 (docs/superpowers/specs/2026-09-24-shaype-local-api-design.md) and docs/map/payto.md.
 * Owns the 22 "PayTo API" operations and publishes ctx.services.payto (service.ts) for the utilities mock
 * generators: create / get / transition helpers, emitMandateNotification(side, mandateId, trigger, details),
 * receivePaymentInstruction (RAPAIN) and addStubInstructions (search stub).
 *
 * Contract deviations: none — every response follows the declared schema. Mandate / action ids are served
 * hyphenated (UUID v1 layout); the 32-hex MMS form is accepted by every service method and by the utilities
 * DTOs that declare it, but not on `format: uuid` path / body fields, where the contract's own validation
 * answers 400 first.
 *
 * Decisions beyond the spec (all covered in test/payto.test.ts):
 * - Single tenant: the client is the Initiator of every mandate with a local creditor account and the Payer
 *   of every mandate with a local debtor account. Payer-only operations (getMandates aside, which just
 *   matches nothing) on a mandate whose debtor is not on the platform answer 403.
 * - createMandate: the creditor account must exist and not be CLOSED (else the documented 422
 *   `NOT_FOUND: CUS.API.100522 - Creditor account details incorrect ...`); the debtor is identified by
 *   accountId, by accountNumber (BSB + account; the local BSB must resolve to a local account, another BSB
 *   must support PayTo — 422 BSB_NOT_SUPPORTED — and is an external debtor) or by an alias (resolved through
 *   the PayID service when loaded, else external), at least one being required (400). Amounts must be AUD
 *   (422 INVALID_CURRENCY), positive with at most 2 dp (400). validityEndDate before validityStartDate is 422.
 *   The mandate starts CREATED with a pending bilateral CREATE action expiring after 6 days (MMS window);
 *   a local Payer receives MCRT. No rate limiting: 429 is never returned.
 * - Status machine: suspend needs ACTIVE and release needs SUSPENDED (documented texts, no reason prefix);
 *   a suspension can only be released by the side that suspended it (422 otherwise). The Initiator cancels
 *   from ACTIVE / SUSPENDED (CREATED -> 422, recall instead: 00-status D-7); the Payer also from CREATED;
 *   cancelling a CANCELLED mandate is 422. Cancellation resolves any pending action (recalled by the
 *   Initiator, declined by the Payer, timed out by the platform). Every status change records a
 *   STATUS_CHANGE action and sends MSCH to both local parties.
 * - Bilateral actions: resolveMandateByPayer / resolveMandateByInitiator act on the oldest PENDING action
 *   (422 when none). Payer ACCEPT of a CREATE -> ACTIVE + MCRC; REJECT -> CANCELLED + MCRD; Initiator recall
 *   -> CANCELLED + MCRR to the Payer (the counterparty; MAMR likewise). Expiry (6 days, scheduler tick) ->
 *   TIMED_OUT, CANCELLED for a CREATE, MCRX / MAMX to both, actionOwner PLATFORM. No
 *   MANDATE_ACTION_EXPIRATION is emitted (webhook-matrix C12).
 * - amendMandatePaymentTerms needs ACTIVE / SUSPENDED, a body with paymentTerms or validityEndDate (400),
 *   immutable frequency / type (422) and no other pending action (422); the proposal is visible only in the
 *   action's details until the Payer accepts (MAMC applies it and re-schedules the next payment).
 *   amendMandateByInitiator / amendMandateByPayer need ACTIVE / SUSPENDED and a replacement account that
 *   exists (404), is ACTIVE (422 INVALID_ACCOUNT_STATUS) and has the same holder (422 PERMISSION_DENIED);
 *   the counterparty receives MAMN.
 * - Payments: business refusals are 200 with transactionStatus REJECTED and a PaymentReasonCode (mandate
 *   not ACTIVE AG01, non-ADHOC mandate AG03, before validity DT04, zero AM01, non-AUD AM03, above
 *   maximumAmount AM21, missing amount with no paymentTerms.amount AM12, external debtor AB01 — the staging
 *   default —, debtor funds AM04 / blocked AC06 / closed AC05 / other limit AG07, creditor MAX_BALANCE AC14).
 *   A local debtor with funds settles synchronously: INTERBANK_TRANSFER_OUT on the debtor and
 *   INTERBANK_TRANSFER_IN on a local creditor, both with mandatePaymentDetails, originType MANDATE_PAYMENT
 *   and originId = mandateId, then ACCEPTED_AND_SETTLED. MANDATE_PAYMENT goes to the Initiator side once,
 *   when the status is final, transactionHayId omitted on rejection. Instruction ids follow the NPP pattern
 *   with BIC ANNCAU22XXX; endToEndId defaults to "Not provided"; instruction lists are newest first and
 *   never archived. getMandatePaymentStatus omits transactionStatusReasonCode when there is none.
 * - Scheduler (non-ADHOC mandates): on activation the next due date (firstPayment.date or
 *   validityStartDate, stepped by frequency, bounded by lastPayment.date / validityEndDate; INTRA_DAY steps
 *   daily, pointInTime / countPerPeriod are recorded only) is scheduled with a MANDATE_DUE_PAYMENT to the
 *   Initiator and initiated when the virtual clock reaches it — at least one day after scheduling so that
 *   setScheduledPaymentInitiationRequestAmount (USAGE_BASED / VARIABLE only, else 422; unknown
 *   notificationId 422) can set the amount; a missing amount rejects with AM12. SUSPENDED defers,
 *   CANCELLED drops the schedule.
 * - Validity: a mandate is cancelled (CTEX, MSCH, PLATFORM) once the UTC date passes validityEndDate;
 *   closing the creditor or debtor account cancels its mandates (AC04, docs:account-closure).
 * - Webhooks: spec property names (mandateEventDto ...), `description` = the trigger's meaning, one
 *   notification per customer behind the addressed side's account (Initiator = creditor holders, Payer =
 *   debtor holders; a side with no local account falls back to the other side for mock-driven
 *   notifications); actionOwner CLIENT for API-driven changes, PLATFORM for mocks / scheduler / expiry.
 * - checkBsbIsSupportedByPayTo: every 6-digit BSB except 000000 (staging fixture) and 999999 (spec §5.6).
 * - Unknown mandate / instruction / account ids are 404 (spec convention) rather than the map's inferred 422.
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import './schema.js'
import { MandateRepo } from './repo.js'
import { PayToService } from './service.js'
import { registerEvents } from './events.js'
import { registerRoutes } from './routes.js'

export { PayToService, ACCOUNT_DETAILS_INCORRECT, normaliseMandateId, mmsId, v1Uuid, stepDate, TRIGGER_DESCRIPTION, MANDATE_TRIGGERS, STATUS_DISPLAY, MMS_STATUS, PAYMENT_STATUS, SUCCESS_MESSAGE, UNSUPPORTED_BSBS, BIC, NOT_PROVIDED, ACTION_EXPIRY_MS, DUE_PAYMENT_LEAD_MS } from './service.js'
export type { MandateTrigger, NotificationDetails, ReceivePaymentInput, PaymentOutcome, MandateDetailsDto, PaymentInstructionSummary, Resolution } from './service.js'
export type { Mandate, MandateStatus, MandateSide, MandateAction, ActionType, ActionStatus, PaymentInstruction, InstructionStatus, ScheduledPayment, PaymentTerms, PartyDetails, Money, CxMandateStatus } from './repo.js'

export function register(app: FastifyInstance, ctx: AppContext): void {
  const svc = new PayToService(ctx, new MandateRepo(ctx.db))
  ctx.services.payto = svc
  registerEvents(ctx, svc)
  registerRoutes(app, ctx, svc)
  ctx.scheduler.onTick(() => svc.tick())
}
