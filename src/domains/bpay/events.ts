/**
 * Domain events emitted by BpayService. The only BPAY webhook — TRANSACTION / BPAY_TRANSFER_OUT with
 * counterpartDetails.bpayDetails (docs/map/webhooks.md §5.4, 00-webhook-matrix row BPAY_TRANSFER_OUT) —
 * is emitted by the ledger's transaction.posted subscriber for the posting BpayService makes, so no
 * notification is built here: refusals are sync-only and saved billers never notify.
 */
import type { AppContext } from '../../context.js'
import type { LedgerTransaction } from '../transactions/index.js'
import type { DirectoryBiller } from './directory.js'
import type { SavedBiller } from './repo.js'

export type BillerChangeKind = 'CREATED' | 'UPDATED' | 'DISMISSED'

declare module '../../events/bus.js' {
  interface DomainEventMap {
    /** A BPAY payment was accepted and posted (the TRANSACTION webhook is the ledger's). */
    'bpay.paymentAccepted': { transaction: LedgerTransaction; biller: DirectoryBiller; accountId: string }
    /** A saved biller was created, updated or dismissed. */
    'bpay.billerChanged': { biller: SavedBiller; kind: BillerChangeKind }
  }
}

export function registerEvents(_ctx: AppContext): void {
  // No webhook mappings: see the header comment.
}
