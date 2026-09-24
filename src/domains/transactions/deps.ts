/**
 * What this domain expects from a domain registered after it (payid-npp). Declared here — not on
 * ServiceMap — so that domain owns its ServiceMap entry; the shape below is the exact call site in
 * service.ts (PAY_ID transfers). The `satisfies` check fails typecheck once ServiceMap.payid exists
 * and diverges, and assertDeps() fails startup (onReady) when a registered service lacks the method.
 */
import type { AppContext, ServiceMap } from '../../context.js'

export type PayIdType = 'EMAIL' | 'TELEPHONE' | 'INDIVIDUAL_AUSTRALIAN_BUSINESS' | 'ORGANISATION'

export interface ResolvedPayId {
  accountNumber: string
  branchNumber: string
  ownerName?: string
}

export interface PayIdDep {
  /**
   * Resolves a PayID (any status that can receive payments) to its BSB / account number, or
   * undefined when the PayID is unknown, disabled or deregistered (-> REFUSED_INVALID_PAY_ID).
   */
  resolve(payId: string, payIdType?: PayIdType): ResolvedPayId | undefined
}

const REQUIRED_METHODS: Record<'payid', string[]> = { payid: ['resolve'] }

export function deps(ctx: AppContext): { payid?: PayIdDep } {
  return ctx.services as Partial<{ payid: PayIdDep }>
}

/** Runs at app ready (every domain registered): a present payid service must expose resolve(). */
export function assertDeps(ctx: AppContext): void {
  const services = ctx.services as unknown as Record<string, Record<string, unknown> | undefined>
  const missing: string[] = []
  for (const [name, methods] of Object.entries(REQUIRED_METHODS)) {
    const svc = services[name]
    if (!svc) continue
    for (const m of methods) if (typeof svc[m] !== 'function') missing.push(`${name}.${m}`)
  }
  if (missing.length) throw new Error(`transactions: dependency methods missing: ${missing.join(', ')} (shapes in src/domains/transactions/deps.ts)`)
}

// Compile-time conformance: `undefined` while the member is not declared, then the real service type.
type Declared<K extends string> = K extends keyof ServiceMap ? ServiceMap[K] : undefined
type Satisfies<T, Dep, Name extends string> = [T] extends [undefined] ? true : [T] extends [Dep] ? true : `ServiceMap.${Name} does not satisfy the ${Name} shape transactions/service.ts calls (see transactions/deps.ts)`
true satisfies Satisfies<Declared<'payid'>, PayIdDep, 'payid'>
