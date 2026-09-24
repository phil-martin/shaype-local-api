/**
 * What this domain expects from domains registered after it (accounts, cards, kyc). Declared here — not on
 * ServiceMap — so those domains own their ServiceMap entries; the shapes below are the exact call
 * sites in routes.ts / service.ts. Two guards hold the implementers to them: the `satisfies` checks at the
 * bottom fail typecheck once ServiceMap.accounts / .cards / .kyc exist and diverge, and assertDeps() fails
 * startup (onReady) when a registered service lacks one of the methods.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import type { AppContext, ServiceMap } from '../../context.js'
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

export interface KycDep {
  /** The identity-verification case createCase returned (scanCase.id); customerId is set once a customer linked it. */
  findCase(id: string): { customerId?: string } | undefined
}

const REQUIRED_METHODS: Record<'accounts' | 'cards' | 'kyc', string[]> = { accounts: ['create', 'listForHolder'], cards: ['listForCustomer'], kyc: ['findCase'] }

export function deps(ctx: AppContext): { accounts?: AccountsDep; cards?: CardsDep; kyc?: KycDep } {
  return ctx.services as Partial<{ accounts: AccountsDep; cards: CardsDep; kyc: KycDep }>
}

/** Runs at app ready (every domain registered): a present accounts/cards/kyc service must expose the methods customers calls. */
export function assertDeps(ctx: AppContext): void {
  const services = ctx.services as unknown as Record<string, Record<string, unknown> | undefined>
  const missing: string[] = []
  for (const [name, methods] of Object.entries(REQUIRED_METHODS)) {
    const svc = services[name]
    if (!svc) continue
    for (const m of methods) if (typeof svc[m] !== 'function') missing.push(`${name}.${m}`)
  }
  if (missing.length) throw new Error(`customers: dependency methods missing: ${missing.join(', ')} (shapes in src/domains/customers/deps.ts)`)
}

// Compile-time conformance: `undefined` while the member is not declared, then the real service type.
type Declared<K extends string> = K extends keyof ServiceMap ? ServiceMap[K] : undefined
type Satisfies<T, Dep, Name extends string> = [T] extends [undefined] ? true : [T] extends [Dep] ? true : `ServiceMap.${Name} does not satisfy the ${Name} shape customers/routes.ts calls (see customers/deps.ts)`
true satisfies Satisfies<Declared<'accounts'>, AccountsDep, 'accounts'>
true satisfies Satisfies<Declared<'cards'>, CardsDep, 'cards'>
true satisfies Satisfies<Declared<'kyc'>, KycDep, 'kyc'>
