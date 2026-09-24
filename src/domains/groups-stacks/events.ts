/**
 * Domain events emitted by the groups and stacks services. No webhook maps to any of them: the
 * notification spec has no group or stack event type and the webhook matrix (docs/map/00-webhook-matrix.md)
 * lists nothing for Groups / Stacks CRUD. The notifications a client does receive around this domain
 * are emitted by the services this domain calls: ACCOUNT_STATUS_CHANGE {APPROVED} to every member when
 * a group account is created and {ACTIVE} on the first stack move (accounts), CUSTOMER_STATUS_UPDATED
 * {INACTIVE} for the removal cascade (customers, behind config.emitCustomerInactive) and
 * CARD_STATUS_CHANGE {INACTIVE} for the cancelled cards (cards).
 *
 * This module also subscribes to the account-closure cascade: a CLOSED account's remaining (empty)
 * open stacks are closed by the platform (00-status B.7).
 */
import type { AppContext } from '../../context.js'
import type { ActionOwner } from '../../events/notify.js'
import type { Group, Stack, StackTransaction } from './repo.js'
import type { StacksService } from './service.js'

declare module '../../events/bus.js' {
  interface DomainEventMap {
    'group.created': { group: Group }
    'group.updated': { group: Group }
    'group.membershipChanged': { group: Group; added: string[]; removed: string[] }
    'stack.created': { stack: Stack }
    'stack.updated': { stack: Stack }
    /** OPEN -> CLOSED; sweptCents is the balance returned to the account (0 when empty). */
    'stack.closed': { stack: Stack; sweptCents: number; actionOwner: ActionOwner }
    /** One per HayStackTransaction record (two for a stack-to-stack transfer). `stack` is the post-movement snapshot. */
    'stack.transactionPosted': { transaction: StackTransaction; stack: Stack }
  }
}

export function registerEvents(ctx: AppContext, stacks: StacksService): void {
  ctx.events.on('account.statusChanged', ({ account }) => {
    if (account.status === 'CLOSED') stacks.closeAllForAccount(account.id)
  })
}
