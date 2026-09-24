/**
 * Domain events of the PayID service and the cross-domain reactions this domain owns. The
 * notification spec has no PayID event type (docs/map/00-webhook-matrix.md: "Never emitted for ...
 * PayID"), so no webhook is built here; the events exist for other domains and tests.
 *
 * Reactions:
 * - customer.detailsChanged with customerNameChanged (and not skipPayIdUpdate): ownerName of every live
 *   PayID on the customer's own accounts follows the new name (spec §5.1 updateCustomer).
 * - account.statusChanged to CLOSED: every live PayID on the account is deregistered with reason CUST
 *   (docs:account-closure "All PayID's registered to that account are deleted"; 00-status B.4 decision).
 */
import type { AppContext } from '../../context.js'
import type { Customer } from '../customers/index.js'
import type { PayId, PayIdStatus } from './repo.js'
import type { PayIdService } from './service.js'

declare module '../../events/bus.js' {
  interface DomainEventMap {
    /** A new ACTIVE registration (first registration, re-registration of a DEREGISTERED value, or a port). */
    'payid.registered': { payId: PayId }
    /** Every effective status change, client- or timer-driven (DEREGISTERED included). */
    'payid.statusChanged': { payId: PayId; previousStatus: PayIdStatus }
  }
}

/** Account-holder name as registered against PayIDs: first and last name (same rule as the ledger's counterpart name). */
export function ownerNameOf(c: Customer): string {
  return [c.customerDetails.firstName, c.customerDetails.lastName].filter(Boolean).join(' ')
}

export function registerEvents(ctx: AppContext, svc: PayIdService): void {
  ctx.events.on('customer.detailsChanged', ({ customer, changes, skipPayIdUpdate }) => {
    if (!changes.customerNameChanged || skipPayIdUpdate) return
    svc.propagateOwnerName(customer.id, ownerNameOf(customer))
  })
  ctx.events.on('account.statusChanged', ({ account }) => {
    if (account.status !== 'CLOSED') return
    svc.deregisterAllForAccount(account.id)
  })
}
