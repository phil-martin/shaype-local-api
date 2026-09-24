/**
 * What this domain expects from the cards domain (registered before it, developed in parallel) for the
 * removeCustomerFromGroup cascade: "search for any cards the customer holds that are issued against
 * accounts held by the group and cancel them" [docs:customer-removal]. The method is optional at runtime:
 * a cards service without it logs a warning and the removal proceeds without cancelling cards, so the
 * two domains can merge in either order (the accounts/customers guards already require cards.listFor*).
 */
import type { AppContext } from '../../context.js'

export interface CardsDep {
  /**
   * Cards the customer (cardholder) holds on the account that are not already INACTIVE move to INACTIVE
   * (voided) with a CARD_STATUS_CHANGE (actionOwner PLATFORM). `reason` is free text for the cards log.
   */
  cancelForCustomerOnAccount?(customerHayId: string, accountId: string, reason?: string): void
}

export function deps(ctx: AppContext): { cards?: CardsDep } {
  return ctx.services as Partial<{ cards: CardsDep }>
}
