/**
 * Domain events emitted by CustomersService and their webhook mappings (docs/map/webhooks.md §2.4, §5.5).
 */
import type { AppContext } from '../../context.js'
import { notifyV0, type ActionOwner } from '../../events/notify.js'
import type { Customer, CustomerStatus } from './repo.js'

export type OnboardingFailedState = 'DOCUMENT_SCAN' | 'SANCTIONS_SCAN' | 'KYC_AML_SCAN' | 'DUPLICATE_CHECK'

export interface CustomerDetailsChanges {
  phoneNumberChanged: boolean
  customerNameChanged: boolean
  emailAddressChanged: boolean
  addressChanged: boolean
}

declare module '../../events/bus.js' {
  interface DomainEventMap {
    'customer.created': { customer: Customer }
    /** Every effective status change (client- or platform-driven). Accounts subscribes for the close-account cascade bookkeeping. */
    'customer.statusChanged': { customer: Customer; previousStatus: CustomerStatus; actionOwner: ActionOwner }
    /** updateCustomer changed at least one field; `changes` carries the four webhook booleans. PayID reacts to customerNameChanged unless skipPayIdUpdate. */
    'customer.detailsChanged': { customer: Customer; previous: Customer; changes: CustomerDetailsChanges; skipPayIdUpdate: boolean }
    'customer.onboardingPassed': { customer: Customer }
    'customer.onboardingFailed': { customer: Customer; state: OnboardingFailedState; submissionFailure: boolean }
  }
}

export function registerEvents(ctx: AppContext): void {
  ctx.events.on('customer.statusChanged', ({ customer, actionOwner }) => {
    notifyV0(ctx, {
      customerHayId: customer.id,
      type: 'CUSTOMER_STATUS_UPDATED',
      actionOwner,
      customerStatusUpdatedEvent: { customerStatus: customer.status },
    })
  })
  ctx.events.on('customer.detailsChanged', ({ customer, changes }) => {
    notifyV0(ctx, {
      customerHayId: customer.id,
      type: 'CUSTOMER_DETAILS_CHANGE',
      actionOwner: 'CLIENT',
      customerDetailsChangeEvent: { ...changes },
    })
  })
  ctx.events.on('customer.onboardingPassed', ({ customer }) => {
    notifyV0(ctx, { customerHayId: customer.id, type: 'ONBOARDING_PASSED', actionOwner: 'PLATFORM' })
  })
  ctx.events.on('customer.onboardingFailed', ({ customer, state, submissionFailure }) => {
    notifyV0(ctx, {
      customerHayId: customer.id,
      type: 'ONBOARDING_FAILED',
      actionOwner: 'PLATFORM',
      onboardingFailedEvent: { state, submissionFailure },
    })
  })
}
