/**
 * What this domain expects from domains registered after it (cards, groups). Declared here — not on
 * ServiceMap — so those domains own their ServiceMap entries; the shapes below are the exact call
 * sites in service.ts / routes.ts. Two guards hold the implementers to them: the `satisfies` checks at
 * the bottom fail typecheck once ServiceMap.cards / ServiceMap.groups exist and diverge, and
 * assertDeps() fails startup (onReady) when a registered service lacks one of the methods.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import type { AppContext, ServiceMap } from '../../context.js'

export type HayCard = components['schemas']['HayCard']

export interface CardsDep {
  /** Cards linked to the account (HayCard.accountHayId == accountId), every status, creation order. */
  listForAccount(accountId: string): HayCard[]
  /**
   * Account-closure cascade: every card linked to the account that is not already INACTIVE moves to
   * INACTIVE (voided) with a CARD_STATUS_CHANGE (actionOwner PLATFORM). `reason` is the closure reason.
   */
  cancelAllForAccount(accountId: string, reason?: string): void
}

export interface GroupsDep {
  /** @throws 404 NOT_FOUND for an unknown group; 422 `PERMISSION_DENIED: Account cannot be created for group with id <id>, all members of the group should have an ACTIVE status` otherwise. */
  requireAllMembersActive(groupHayId: string): void
  /** Member customer ids of the group (empty for an unknown group). */
  memberIds(groupHayId: string): string[]
  /** Ids of the groups the customer is a member of (for the "last open account" check on closure). */
  groupIdsForCustomer(customerHayId: string): string[]
}

const REQUIRED_METHODS: Record<'cards' | 'groups', string[]> = {
  cards: ['listForAccount', 'cancelAllForAccount'],
  groups: ['requireAllMembersActive', 'memberIds', 'groupIdsForCustomer'],
}

export function deps(ctx: AppContext): { cards?: CardsDep; groups?: GroupsDep } {
  return ctx.services as Partial<{ cards: CardsDep; groups: GroupsDep }>
}

/** Runs at app ready (every domain registered): a present cards/groups service must expose the methods this domain calls. */
export function assertDeps(ctx: AppContext): void {
  const services = ctx.services as unknown as Record<string, Record<string, unknown> | undefined>
  const missing: string[] = []
  for (const [name, methods] of Object.entries(REQUIRED_METHODS)) {
    const svc = services[name]
    if (!svc) continue
    for (const m of methods) if (typeof svc[m] !== 'function') missing.push(`${name}.${m}`)
  }
  if (missing.length) throw new Error(`accounts: dependency methods missing: ${missing.join(', ')} (shapes in src/domains/accounts/deps.ts)`)
}

// Compile-time conformance: `undefined` while the member is not declared, then the real service type.
type Declared<K extends string> = K extends keyof ServiceMap ? ServiceMap[K] : undefined
type Satisfies<T, Dep, Name extends string> = [T] extends [undefined] ? true : [T] extends [Dep] ? true : `ServiceMap.${Name} does not satisfy the ${Name} shape accounts calls (see accounts/deps.ts)`
true satisfies Satisfies<Declared<'cards'>, CardsDep, 'cards'>
true satisfies Satisfies<Declared<'groups'>, GroupsDep, 'groups'>
