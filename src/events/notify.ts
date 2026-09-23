/**
 * Builds webhook envelopes (NotificationDto v0 / NotificationDtoV1) and hands them to the dispatcher.
 * Compact form: undefined/null-less — absent event properties are omitted rather than sent as null.
 */
import { randomUUID } from 'node:crypto'
import type { AppContext } from '../context.js'
import { isoUtc } from '../lib/clock.js'
import type { NotificationRow } from './webhooks.js'

export type ActionOwner = 'CLIENT' | 'PLATFORM'

export type V0Type =
  | 'ACCOUNT_STATUS_CHANGE' | 'CUSTOMER_STATUS_UPDATED' | 'CARD_ADDED_TO_WALLET' | 'CARD_STATUS_CHANGE'
  | 'CUSTOMER_DETAILS_CHANGE' | 'ONBOARDING_PASSED' | 'ONBOARDING_FAILED' | 'REMINDER' | 'SCHEDULED_PAYMENT'
  | 'TRANSACTION' | 'DIRECT_ENTRY' | 'MANDATE' | 'MANDATE_DUE_PAYMENT' | 'MANDATE_PAYMENT'
  | 'APPLE_PAY_REWARD_FOR_CUSTOMER' | 'MANDATE_ACTION_EXPIRATION' | 'DELEGATED_OTP_NOTIFICATION'

export interface V0Envelope {
  customerHayId: string
  type: V0Type
  actionOwner?: ActionOwner
  cardHayId?: string | null
  productId?: string
  firebaseDeviceToken?: string
  [eventProperty: string]: unknown
}

export interface V1Envelope {
  type: 'BATCH_COMPLETED' | 'PERK_ORDER_UPDATE'
  actionOwner?: ActionOwner
  eventDetails?: Record<string, unknown>
}

export function notifyV0(ctx: AppContext, envelope: V0Envelope): NotificationRow {
  return ctx.webhooks.enqueue('v0', compact({ idempotencyKey: randomUUID(), ...envelope }) as { idempotencyKey: string; type: string } & Record<string, unknown>)
}

export function notifyV1(ctx: AppContext, envelope: V1Envelope): NotificationRow {
  return ctx.webhooks.enqueue('v1', compact({ idempotencyKey: randomUUID(), createdTimeUtc: isoUtc(ctx.clock.now()), ...envelope }) as { idempotencyKey: string; type: string } & Record<string, unknown>)
}

/** Deep-removes undefined values (keeps explicit nulls). */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = compact(v)
    return out as T
  }
  return value
}
