/**
 * Domain events emitted by PayToService and their webhook mappings (docs/map/webhooks.md §2.4,
 * docs/map/00-webhook-matrix.md C5): MANDATE (`mandateEventDto`), MANDATE_PAYMENT
 * (`mandatePaymentEventDto`, final statuses only) and MANDATE_DUE_PAYMENT (`mandateDuePaymentEventDto`),
 * spec property names. One notification per customer behind the addressed side's local account —
 * the creditor's holders for the Initiator, the debtor's for the Payer.
 */
import type { AppContext } from '../../context.js'
import { compact, notifyV0, type ActionOwner } from '../../events/notify.js'
import type { Mandate, MandateSide, MandateStatus, PaymentInstruction, ScheduledPayment } from './repo.js'
import { PAYMENT_STATUS, type MandateTrigger, type PayToService } from './service.js'

declare module '../../events/bus.js' {
  interface DomainEventMap {
    'mandate.created': { mandate: Mandate }
    /** Every effective mandate status change; `by` is the side that caused it. No webhook by itself (MANDATE carries the trigger). */
    'mandate.statusChanged': { mandate: Mandate; previousStatus: MandateStatus; by: MandateSide }
    /** A MANDATE notification for one side of the mandate. */
    'mandate.notified': { mandate: Mandate; side: 'INITIATOR' | 'PAYER'; trigger: MandateTrigger; actionId?: string; description: string; actionOwner: ActionOwner }
    /** A payment instruction reached a final status (ACCEPTED_AND_SETTLED / REJECTED / UNDELIVERED). */
    'mandate.paymentFinal': { mandate: Mandate; instruction: PaymentInstruction; actionOwner: ActionOwner }
    /** The next payment of a non-ADHOC mandate was scheduled. */
    'mandate.paymentDue': { mandate: Mandate; schedule: ScheduledPayment }
  }
}

export function registerEvents(ctx: AppContext, svc: PayToService): void {
  /** Initiator-side recipients, falling back to the Payer's when the Initiator is not on the platform. */
  const initiatorSide = (m: Mandate): string[] => {
    const ids = svc.customersFor(m, 'INITIATOR')
    return ids.length ? ids : svc.customersFor(m, 'PAYER')
  }

  ctx.events.on('mandate.notified', ({ mandate, side, trigger, actionId, description, actionOwner }) => {
    let recipients = svc.customersFor(mandate, side)
    if (!recipients.length) recipients = svc.customersFor(mandate, side === 'INITIATOR' ? 'PAYER' : 'INITIATOR')
    for (const customerHayId of recipients) {
      notifyV0(ctx, {
        customerHayId,
        type: 'MANDATE',
        actionOwner,
        mandateEventDto: compact({ mandateId: mandate.id, actionId, description, trigger }),
      })
    }
  })

  ctx.events.on('mandate.paymentFinal', ({ mandate, instruction, actionOwner }) => {
    for (const customerHayId of initiatorSide(mandate)) {
      notifyV0(ctx, {
        customerHayId,
        type: 'MANDATE_PAYMENT',
        actionOwner,
        mandatePaymentEventDto: compact({
          instructionId: instruction.id,
          mandateId: mandate.id,
          paymentStatus: PAYMENT_STATUS[instruction.status],
          reasonCode: instruction.reasonCode,
          // "When payment status is rejected, transaction identifier is null" -> omitted (compact envelope)
          transactionHayId: instruction.transactionId,
          isFinal: true,
          originId: mandate.id,
          originType: 'MANDATE_PAYMENT',
        }),
      })
    }
  })

  ctx.events.on('mandate.paymentDue', ({ mandate, schedule }) => {
    for (const customerHayId of initiatorSide(mandate)) {
      notifyV0(ctx, {
        customerHayId,
        type: 'MANDATE_DUE_PAYMENT',
        actionOwner: 'PLATFORM',
        mandateDuePaymentEventDto: { mandateId: mandate.id, notificationId: schedule.notificationId, paymentDateTimeUtc: schedule.paymentDateTime },
      })
    }
  })

  // Account closure cascade (docs:account-closure): every PayTo arrangement registered with a closed account is cancelled.
  ctx.events.on('account.statusChanged', ({ account }) => {
    if (account.status !== 'CLOSED') return
    for (const m of svc.mandatesForAccount(account.id)) {
      if (m.status === 'CANCELLED') continue
      svc.transition(m, 'CANCELLED', { side: 'PLATFORM', change: 'CANCEL', reasonCode: 'AC04', reasonDescription: 'Closed account number', actionOwner: 'PLATFORM' })
    }
  })
}
