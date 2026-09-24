/**
 * Domain events of the direct-entry domain and their webhook mapping (docs/map/webhooks.md §2.4, §5.3;
 * docs/map/00-webhook-matrix.md rows DIRECT_ENTRY / SCHEDULED_PAYMENT):
 * - directEntry.statusChanged -> DIRECT_ENTRY { transactionId, type DEBIT, direction OUTBOUND, status },
 *   one per owning customer of the sender (credited) account, for every one of the 7 statuses.
 * - scheduledPayment.created -> SCHEDULED_PAYMENT { hayId } (creation only; cancel / complete / fail
 *   have no event type).
 * Money movements notify through the ledger's own TRANSACTION events.
 */
import type { AppContext } from '../../context.js'
import { notifyV0, type ActionOwner } from '../../events/notify.js'
import type { Account } from '../accounts/repo.js'
import type { LedgerTransaction } from '../transactions/repo.js'
import type { LedgerOutcome } from '../transactions/service.js'
import type { DeInstruction, DeStatus, ScheduledPayment, ScheduleStatus } from './repo.js'
import type { DirectEntryService } from './service.js'

declare module '../../events/bus.js' {
  interface DomainEventMap {
    /** An outbound instruction entered `instruction.status` (RECEIVED has no previousStatus). `account` is the sender (credited) account. */
    'directEntry.statusChanged': { instruction: DeInstruction; account: Account; previousStatus?: DeStatus; actionOwner: ActionOwner }
    'scheduledPayment.created': { schedule: ScheduledPayment; actionOwner: ActionOwner }
    'scheduledPayment.statusChanged': { schedule: ScheduledPayment; previousStatus: ScheduleStatus; actionOwner: ActionOwner }
    /** One occurrence ran (posted when outcome is ACCEPTED). */
    'scheduledPayment.executed': { schedule: ScheduledPayment; outcome: LedgerOutcome; transaction?: LedgerTransaction }
  }
}

export function registerEvents(ctx: AppContext, svc: DirectEntryService): void {
  ctx.events.on('directEntry.statusChanged', ({ instruction, account, actionOwner }) => {
    for (const customerHayId of ctx.services.accounts.holderCustomerIds(account)) {
      notifyV0(ctx, {
        customerHayId,
        type: 'DIRECT_ENTRY',
        actionOwner,
        directEntryEvent: { transactionId: instruction.id, type: 'DEBIT', direction: 'OUTBOUND', status: instruction.status },
      })
    }
  })

  ctx.events.on('scheduledPayment.created', ({ schedule, actionOwner }) => {
    notifyV0(ctx, { customerHayId: schedule.customerId, type: 'SCHEDULED_PAYMENT', actionOwner, scheduledPaymentEvent: { hayId: schedule.id } })
  })

  // Account closure cancels the account's ACTIVE schedules (docs/map/00-open-questions.md S8: they never block closure).
  ctx.events.on('account.statusChanged', ({ account }) => {
    if (account.status === 'CLOSED') svc.schedules.cancelAllForAccount(account.id)
  })
}
