/**
 * Domain events emitted by CardsService and their webhook mappings (docs/map/webhooks.md §2.4, §5.7
 * skeletons; docs/map/00-webhook-matrix.md rows for cards): CARD_STATUS_CHANGE on creation and on every
 * status transition, REMINDER / CARD_EXPIRY_* before expiry, CARD_ADDED_TO_WALLET on provisioning. One
 * notification per card, to the cardholder; the envelope carries cardHayId and the account's productId.
 */
import type { AppContext } from '../../context.js'
import { notifyV0, type ActionOwner } from '../../events/notify.js'
import type { Card, CardStatus, ExpiryReminderType, Wallet } from './repo.js'

declare module '../../events/bus.js' {
  interface DomainEventMap {
    /** A card was issued (create, re-issue, renew): CARD_STATUS_CHANGE with its initial status. */
    'card.created': { card: Card; actionOwner: ActionOwner }
    /** Every effective status change (client- or platform-driven). */
    'card.statusChanged': { card: Card; previousStatus: CardStatus; actionOwner: ActionOwner }
    'card.expiryReminder': { card: Card; reminderType: ExpiryReminderType }
    'card.addedToWallet': { card: Card; wallet: Wallet; activationCode: string }
  }
}

export function registerEvents(ctx: AppContext): void {
  const productId = (card: Card): string | undefined => ctx.services.accounts.find(card.accountId)?.productId
  const statusChange = (card: Card, actionOwner: ActionOwner): void => {
    notifyV0(ctx, {
      customerHayId: card.customerId,
      type: 'CARD_STATUS_CHANGE',
      actionOwner,
      cardHayId: card.id,
      productId: productId(card),
      cardStatusChangeEvent: { cardHayId: card.id, accountHayId: card.accountId, cardStatus: card.status, cardLastFourDigits: card.pan.slice(-4) },
    })
  }
  ctx.events.on('card.created', ({ card, actionOwner }) => statusChange(card, actionOwner))
  ctx.events.on('card.statusChanged', ({ card, actionOwner }) => statusChange(card, actionOwner))
  ctx.events.on('card.expiryReminder', ({ card, reminderType }) => {
    const [year, month] = card.expiryDate.split('-').map(Number)
    notifyV0(ctx, {
      customerHayId: card.customerId,
      type: 'REMINDER',
      actionOwner: 'PLATFORM',
      cardHayId: card.id,
      productId: productId(card),
      reminderType,
      cardExpiryReminderEvent: { cardId: card.id, expirationMonth: month, expirationYear: year },
    })
  })
  ctx.events.on('card.addedToWallet', ({ card, wallet, activationCode }) => {
    notifyV0(ctx, {
      customerHayId: card.customerId,
      type: 'CARD_ADDED_TO_WALLET',
      actionOwner: 'PLATFORM',
      cardHayId: card.id,
      productId: productId(card),
      cardAdditionToWalletEvent: { cardHayId: card.id, cardLastFourDigits: card.pan.slice(-4), walletType: wallet.walletType, activationCode },
    })
  })
}
