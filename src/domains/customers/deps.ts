/**
 * What this domain expects from domains registered after it (accounts, cards). Declared here — not on
 * ServiceMap — so those domains own their ServiceMap entries; the shapes below are the exact call
 * sites in routes.ts and the implementers must match them.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import type { AppContext } from '../../context.js'
import type { ActionOwner } from '../../events/notify.js'

export type HayAccount = components['schemas']['HayAccount']
export type HayCard = components['schemas']['HayCard']

export interface AccountsDep {
  /**
   * Creates a personal account for a customer the caller has already verified ACTIVE (requireActive)
   * and de-duplicated by idempotencyKey (scope 'createHayAccount'): default product, AUD, status
   * APPROVED, balances 0, ACCOUNT_STATUS_CHANGE emitted. Returns the HayAccount response body.
   */
  create(
    input: { accountHolderType: 'CUSTOMER'; accountHolderId: string; customData?: Record<string, unknown> | null },
    opts: { actionOwner: ActionOwner },
  ): HayAccount | Promise<HayAccount>
  /** Accounts with accountHolderType CUSTOMER and accountHolderId == customerHayId, every status, creation order. */
  listForHolder(customerHayId: string): HayAccount[]
}

export interface CardsDep {
  /** Cards whose cardholder (customerHayId) is the customer, every status, creation order. */
  listForCustomer(customerHayId: string): HayCard[]
}

export function deps(ctx: AppContext): { accounts?: AccountsDep; cards?: CardsDep } {
  return ctx.services as unknown as { accounts?: AccountsDep; cards?: CardsDep }
}
