/**
 * direct-entry domain — spec §5.8 (docs/superpowers/specs/2026-09-24-shaype-local-api-design.md) and
 * docs/map/de-dd-scheduled.md. Owns the "Direct Debits API" (createDirectDebitV1/V0, getDirectDebitV1/V0,
 * getDirectDebitsV1/V0), "Direct Entry API" (getDirectEntryStatusV1) and "Scheduled Payments API"
 * (getScheduledPayments, getScheduledPaymentById, cancelScheduledPayment) operations, plus the
 * test-control route POST /_admin/scheduled-payments (routes.ts documents the body). Publishes
 * ctx.services.directEntry (service.ts: instructions; .schedules: ScheduledPaymentsService) for
 * utilities (returnOutbound) and registers the INFLIGHT_OUTBOUND_DIRECT_DEBITS closure checker with accounts.
 *
 * Contract deviations: none — every response follows the declared schema, including the deprecated
 * createDirectDebitV0's 422 DirectDebitResponse body.
 *
 * Decisions beyond the spec (all covered in test/direct-entry.test.ts):
 * - Ids: the client-supplied transactionId is the record id, the inner transactionHayId, the
 *   DIRECT_ENTRY transactionId, and both the id and the originId of the COMPLETE credit posting — so the
 *   TRANSACTION webhook's transactionHayId works on every DD read and on getTransactionById
 *   (00-open-questions I3; a local debtor's debit leg has an id of its own, originId the same). Reusing it
 *   with another idempotencyKey, or naming an existing ledger transaction with it, is 422
 *   DUPLICATE_TRANSACTION_ID; the same key replays (rejections too).
 * - Lifecycle: RECEIVED and ACCEPTED are recorded and notified synchronously (create answers ACCEPTED);
 *   ACCEPTED -> SUBMITTED -> COMPLETE run through scheduler.later() one hop apart, each due one hop after
 *   the previous one was due (a clock jump past both runs both) (actionOwner PLATFORM;
 *   CLIENT for the synchronous statuses). REJECTED (create) when the sender BSB + account number is not
 *   an open local account (no DIRECT_ENTRY webhook when there is no local account, hence no customer)
 *   or the recipient BSB is 999999. INCOMPLETE when the credit is refused by the ledger (MAX_BALANCE —
 *   so risk level HIGH — or a blocked / closed sender account at completion). RETURNED through
 *   directEntry.returnOutbound (the utilities RETURN mock: most recent SUBMITTED, else ACCEPTED, with the
 *   same sender BSB + account number + amount) or when the recipient is itself a local account and its
 *   debit leg is refused (DIRECT_DEBIT_PER_DAY, funds, blocked / closed) — the debtor institution's return.
 *   Post-COMPLETE returns are not modelled. Terminal statuses never change again.
 * - Money: COMPLETE posts DIRECT_DEBIT_TRANSFER, positive, CUSCAL_DE_DEBIT_OUT, originType DIRECT_DEBIT,
 *   category BANK_TRANSFER, counterpart = the recipient (00-transactions C1/C8); a local recipient is
 *   debited in the same transaction (negative, CUSCAL_DE_DEBIT_IN). DIRECT_DEBIT_PER_DAY governs the debit
 *   (money leaving an account by direct debit), never the creation of an outbound instruction (M6/C29).
 * - v0 is the v1 record rendered through the 4-value enum: RECEIVED -> ACCEPTED, COMPLETE -> SUBMITTED,
 *   INCOMPLETE -> RETURNED (S14); a v0 filter value matches every v1 status that renders to it; the v0
 *   create answers a rejection or a request-level 422 with the declared DirectDebitResponse body
 *   (outcome REJECTED, details = the reason).
 * - Lists: fromUtc / toUtc are whole UTC days on creation time, both inclusive; fromUtc > toUtc, limit
 *   outside 1..1000 and a negative offset are 400; creation order (spec §4). processingDate = the first
 *   Monday–Friday after the creation date (UTC). Unknown ids are 404 (spec §4).
 * - Validation the schema misses is a 400: amount > 0 with <= 2 dp; BSB / account-number patterns
 *   anchored (the spec's are not).
 * - Test knob: ctx.services.directEntry.progressDelayMs (default undefined = config.asyncDelayMs) is the
 *   delay of each asynchronous hop; set it to e.g. a day and drive the hops with POST /_admin/clock to
 *   observe ACCEPTED and SUBMITTED (avoid /_admin/flush while such a hop is pending).
 * - Scheduled payments (portal-only on Shaype) are seeded by POST /_admin/scheduled-payments, which also
 *   updates an ACTIVE schedule in place with `replaces` (the previous definition archived as REPLACED in
 *   previousVersions, no webhook; numberOfProcessedPayments / lastProcessedDateTimeUtc carry over and the
 *   next run is the new definition's first occurrence on or after today and after the last payment, so paid
 *   occurrences are never replayed; a definition with nothing left to run is 422 INVALID_SCHEDULE). SCHEDULED_PAYMENT { hayId } is emitted on creation only
 *   (actionOwner CLIENT: the portal is the client's). Dates are UTC calendar days; a schedule is due when
 *   nextRunDate <= today at any tick (request or clock change), missed periods are caught up in order.
 *   Occurrences are anchored on startDate; a MONTHLY / QUARTERLY day that does not exist rolls forward
 *   (30 Feb -> 1 Mar, the first day that exists after it). ONE_TIME carries numberOfPayments 1 and no frequency / endDate. Whichever of
 *   numberOfPayments / endDate is reached first ends the schedule (COMPLETED, set right after the last
 *   occurrence). Occurrences post through the ledger like makeTransferV1, in its check order and with its
 *   FX-child refusal (internal legs for BSB 636220, INTERBANK_TRANSFER_OUT via CUSCAL_NPP_TRANSFER_OUT
 *   otherwise) or through bpay.post (directory
 *   checks; the CRN is the transaction reference, the directory's biller name the counterpart's), stamped
 *   originType SCHEDULED_PAYMENT / originId hayId, actionOwner PLATFORM; a refused occurrence emits the
 *   TRANSACTION webhook with the refused outcome (the only failure signal the client can get) and
 *   ends a ONE_TIME schedule or a shouldCancelOnFailure one (recipient-side refusals -> REJECTED,
 *   anything else -> FAILED); otherwise it is skipped and the next occurrence stands.
 * - cancelScheduledPayment: ACTIVE -> CANCELLED; already CANCELLED is an idempotent 200; any other
 *   terminal status is 422 INVALID_STATUS_TRANSITION; no webhook. Closing an account cancels its
 *   ACTIVE schedules (PLATFORM) and a CLOSED account takes no new one (422 ACCOUNT_CLOSED); ACTIVE
 *   schedules never block closure, in-flight instructions do.
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import './schema.js'
import { DirectEntryRepo } from './repo.js'
import { DirectEntryService } from './service.js'
import { registerEvents } from './events.js'
import { registerRoutes } from './routes.js'

export { DirectEntryService, V0_STATUS, REJECTING_BSB, v0FilterStatuses } from './service.js'
export type { CreateDirectDebitRequestBody, DirectDebitResponse, DirectDebitResponseV1, DeTransactionDetails, DeTransactionDetailsV1, DirectEntryStatusResponseV1, DeReturnReason, ListQuery, ReturnInput, CreateResult } from './service.js'
export { ScheduledPaymentsService, validateRecipient } from './schedules.js'
export type { CreateScheduleInput, OccurrenceResult } from './schedules.js'
export type { DeInstruction, DeStatus, DeStatusV0, ScheduledPayment, ScheduleStatus, ScheduleType, ScheduleFrequency, HayScheduledPayment, HayArchivedScheduledPayment, ScheduledPaymentRecipient } from './repo.js'
export { DE_STATUSES, DE_TERMINAL, SCHEDULE_TERMINAL } from './repo.js'
export { addDays, addMonths, nextBusinessDay, nextOccurrence, occurrence, isIsoDate } from './dates.js'

export function register(app: FastifyInstance, ctx: AppContext): void {
  const svc = new DirectEntryService(ctx, new DirectEntryRepo(ctx.db))
  ctx.services.directEntry = svc
  ctx.services.accounts.addClosureChecker((account) => svc.closureErrors(account))
  ctx.scheduler.onTick(() => { svc.schedules.runDue() })
  registerEvents(ctx, svc)
  registerRoutes(app, ctx, svc)
}
