/**
 * utilities domain — spec §5.5 (docs/superpowers/specs/2026-09-24-shaype-local-api-design.md),
 * docs/map/utilities.md and docs/map/00-webhook-matrix.md (§3, §8, C14–C22). Owns the 13 "Utilities API"
 * staging mock generators. It keeps no state of its own: every generator drives the owning domain through
 * ctx.services (cards, transactions, direct-entry, payto), so balances move only through the ledger and
 * every webhook is the owning domain's. Publishes ctx.services.utilities (service.ts).
 *
 * Contract deviations: the Initiator notification mock also accepts the docs' trigger PCRD, which its spec
 * enum omits (routes.ts preValidation, C14). createStubForMandateSearchPaymentInstructions answers 200 with no
 * body, as declared (the docs show a message).
 *
 * Decisions beyond the spec (all covered in test/utilities.test.ts):
 * - Errors: an unknown card (cardToken or cardId), account (BSB + account number / BBAN), mandate or
 *   outbound payment to return is 404 NOT_FOUND (spec §4, like every domain). Every business refusal is
 *   HTTP 200 with the refused TRANSACTION webhook (docs: "the platform will decline the simulated
 *   authorisation"; E3), including a mock addressed to a LOCKED / CLOSED account, directly or through its
 *   card: REFUSED_ACCOUNT_BLOCKED / REFUSED_ACCOUNT_CLOSED from the ledger's account gate (spec §5.2), which
 *   runs before the card-side checks. Schema
 *   violations are 400, including the docs-only declineReason PIN_BLOCKED (C17). The DE / NPP BSB and
 *   account-number patterns the spec leaves unanchored are full-matched (I7): 400.
 * - Success messages: the documented literals ("Receive A Payment Instruction generated.", "Receive A
 *   Payment generated.", "Mandate Notification for Initiator generated.") and the same style for the rest
 *   (service.ts MESSAGES), unchanged when the transaction is then refused (the outcome is in the webhook).
 * - Card mocks resolve the card by token (or id). An omitted cardUsage is a chip card-present payment (the
 *   docs hold sample: isCardPresent true); the webhook cardUsageDetails carries every flag. The card-side
 *   checks are cards.authorise (status, preferences, PIN / CVV), after the account gate and before the
 *   account rules, card limits and funds (transactions.holds.authorise). A `currency` other than the
 *   account's is carried as originalCurrencyAmount (and an _INTERNATIONAL channel) at 1:1 — no FX rates locally.
 * - declineReason forces a processor decline: outcome REFUSED_RULES, cardPreferenceOutcome OK and
 *   cardProcessorResponse mapped per C17 (CARD_EXPIRED->EXPIRED_CARD, WRONG_CVV->CVV_FAIL,
 *   CVV_BLOCKED->CVV2_FAILURE, the rest verbatim) — the cards domain's processor-decline vocabulary (W5)
 *   rather than the matrix's "outcome usually ACCEPTED", which would report a declined, unheld transaction as
 *   accepted. When that decline is the outcome sent (the account gate runs first: a LOCKED / CLOSED
 *   account refuses without it) it also moves the card state (W5): WRONG_CVV / INCORRECT_PIN spend a try,
 *   CVV_BLOCKED / ALLOWED_PIN_RETRIES_EXCEEDED block. Nothing is held and nothing settles after a decline.
 * - Delays: settlementDelayInSeconds / updateHoldDelayInSeconds are honoured on the virtual clock
 *   (ctx.scheduler.later; POST /_admin/clock advanceMs fires them); an omitted delay is config.asyncDelayMs
 *   (spec §5.5). The settlement of the hold + update mock is due settlementDelayInSeconds after the update
 *   was due, so one clock jump past both runs both. Avoid /_admin/flush while a delayed step is pending (it
 *   waits for the real timer).
 * - Hold + update: three webhooks (C19): the hold, the update (increase: CARD_TRANSACTION pending with the
 *   cumulative amount; decrease: CARD_TRANSACTION_REFUND pending with the released amount), the settlement of
 *   the updated hold. updateHoldAmount 0 or a decrease larger than the hold is 400; a decrease equal to it is
 *   a full reversal and no settlement follows. The increment re-runs the card checks (a card blocked
 *   meanwhile refuses it) and the ledger's limits / funds; a refused increment leaves the hold unchanged and
 *   the original hold still settles.
 * - Refund: credits abs(amount) (C20) as CARD_PAYMENT_REVERSAL / VISA_REFUND_DOMESTIC, CARD_TRANSACTION_REFUND
 *   isPending false, no hold link. A refund is not a spend, so no card-side checks apply (a frozen card still
 *   receives it); the ledger's account gate and MAX_BALANCE do.
 * - ATM: one settled ATM_WITHDRAWAL / VISA_ATM posting, webhook CARD_TRANSACTION isPending false with
 *   isAtmTransaction and cardUsageDetails.isAtmWithdrawal (no hold); the default card preferences refuse cash
 *   (CASH_WITHDRAWAL_DISABLED). Card-transaction postings carry the merchant as counterpart and the MCC as
 *   category, like settled holds.
 * - NPP v1 credits BSB 636220 + receiver account number (INTERBANK_TRANSFER_IN / CUSCAL_NPP_TRANSFER_IN,
 *   sender as counterpart with basicAccountNumber, category BANK_TRANSFER, reference passed through).
 * - NPP v2 (RAP): creditor / debtor accountIdentification = BSB + account number. Plain: the same credit, the
 *   debtor as counterpart, endToEndIdentification as reference, remittance information as description.
 *   With mandateInformation (PayTo creditor leg): the mandate must exist (404) and instructionIdentification
 *   + initiatingPartyName are required ("must be populated for mandate payments", 400); the posting carries
 *   mandatePaymentDetails, originType MANDATE_PAYMENT, originId = mandate id (webhook originId is a uuid);
 *   no MANDATE_PAYMENT (the matrix: the RAPAIN owns it). With paymentReturnInformation.returnReasonCode:
 *   an inbound return of the creditor account's outbound NPP payment — matched by
 *   originalTransactionIdentification against a PayTo instruction id (the I / N letter ignored), else the
 *   most recent one of the returned amount (returnAmount, else instructedAmount), each returned once (404
 *   when none; a larger return is 422) — posted positive as INTERBANK_TRANSFER_OUT / NPP_RETURN_IN,
 *   originType TRANSACTION, originId = the original posting (00-transactions C4), webhook returnReason mapped
 *   from the ISO code (MD06 / CUST -> CUSTOMER_REQUEST "Return of funds requested by end customer", AC04 ->
 *   ACCOUNT_CLOSED, …, else OTHER).
 * - DE inbound (M6 / C29 / W7): DIRECT / CREDIT -> INTERBANK_TRANSFER_IN (CUSCAL_DE_CREDIT_IN) into the
 *   recipient; DIRECT / DEBIT -> DIRECT_DEBIT_TRANSFER (negative, CUSCAL_DE_DEBIT_IN, originType DIRECT_DEBIT)
 *   out of the recipient, checked against DIRECT_DEBIT_PER_DAY (REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED) and
 *   funds; RETURN (returnReason required, 400; DEBIT only, else 422) -> directEntry.returnOutbound on the
 *   local sender's in-flight outbound direct debit of that amount -> DIRECT_ENTRY RETURNED only (C9; 404 when
 *   none matches); REFUSAL (refusalReason required, 400; DEBIT only, else 422; spec §5.5 "RETURN/REFUSAL ->
 *   DIRECT_ENTRY" and W7 win over the matrix's "nothing") -> directEntry.refuseOutbound on the in-flight
 *   outbound direct debit of that amount whose sender is the local account, given as the recipient as in the
 *   docs sample -> INCOMPLETE (return reason OTHER, the refusal reason in `details`) -> DIRECT_ENTRY
 *   INCOMPLETE only (404 when none matches). The optional idempotencyKey replays.
 * - Mandate notifications: the spec's comma-joined trigger enums are split (by gen-contract); PCRD is also
 *   accepted on the Initiator mock, MCRR / MAMR are refused on both (400, C14). payto.emitMandateNotification
 *   sends exactly one MANDATE (the requested trigger, to that side; actionId from actionDetails) and applies
 *   the MMS state silently (MCRC activates, MCRD / PCRD / MCRX cancel a CREATED mandate, MAM* resolve a
 *   pending amendment). An unknown mandate is 404 on the Initiator mock; on the Payer mock it is an external
 *   Initiator's mandate and is registered from mandateDetails when the debtor account is local (else 404).
 *   No MANDATE_ACTION_EXPIRATION (C12). mandateDetails dates are full-matched (400).
 * - RAPAIN: payto.receivePaymentInstruction — ACCP debits the mandate's local debtor (INTERBANK_TRANSFER_OUT,
 *   mandatePaymentDetails, originType MANDATE_PAYMENT) + MANDATE_PAYMENT_ACCEPTED; RJCT -> MANDATE_PAYMENT_REJECTED
 *   AB01, nothing moves; a refused debit (funds AM04, blocked AC06, closed AC05) -> MANDATE_PAYMENT_REJECTED.
 *   Unknown mandate 404; a non-positive instructedAmount 400.
 * - changeCardExpiryDate: cards.setExpiryDate — month-end normalisation; a past date expires the card at
 *   once (CARD_STATUS_CHANGE EXPIRED, PLATFORM; C30); later card mocks decline with EXPIRED_CARD.
 * - Webhook actionOwner is PLATFORM for everything the mocks cause (W3).
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import { UtilitiesService } from './service.js'
import { registerRoutes } from './routes.js'

export { UtilitiesService, MESSAGES, DECLINE_PROCESSOR_RESPONSE, CARD_USAGE } from './service.js'
export type { CardUsage, DeclineReason, GenericMessage } from './service.js'

export function register(app: FastifyInstance, ctx: AppContext): void {
  const svc = new UtilitiesService(ctx)
  ctx.services.utilities = svc
  registerRoutes(app, ctx, svc)
}
