/**
 * Domain events emitted by AccountsService and their webhook mapping: ACCOUNT_STATUS_CHANGE on
 * creation (APPROVED, PLATFORM) and on every status transition, with LOCKED rendered as BLOCKED
 * (docs/map/webhooks.md §2.4, §5.5). One notification per owning customer (all members of a group).
 */
import type { AppContext } from '../../context.js'
import { notifyV0, type ActionOwner } from '../../events/notify.js'
import type { Account, AccountStatus } from './repo.js'
import type { AccountsService } from './service.js'

export type WebhookAccountStatus = 'ACTIVE' | 'BLOCKED' | 'PENDING_APPROVAL' | 'APPROVED' | 'DORMANT' | 'CLOSED' | 'ACTIVE_IN_ARREARS'

declare module '../../events/bus.js' {
  interface DomainEventMap {
    'account.created': { account: Account }
    /** Every effective status change (client- or platform-driven). */
    'account.statusChanged': { account: Account; previousStatus: AccountStatus; actionOwner: ActionOwner }
  }
}

export function webhookStatus(status: AccountStatus): WebhookAccountStatus {
  return status === 'LOCKED' ? 'BLOCKED' : status
}

export function registerEvents(ctx: AppContext, svc: AccountsService): void {
  const emit = (account: Account, actionOwner: ActionOwner): void => {
    for (const customerHayId of svc.holderCustomerIds(account)) {
      notifyV0(ctx, {
        customerHayId,
        type: 'ACCOUNT_STATUS_CHANGE',
        actionOwner,
        productId: account.productId,
        accountStatusChangeEvent: { accountHayId: account.id, accountStatus: webhookStatus(account.status) },
      })
    }
  }
  ctx.events.on('account.created', ({ account }) => emit(account, 'PLATFORM'))
  ctx.events.on('account.statusChanged', ({ account, actionOwner }) => emit(account, actionOwner))
}
