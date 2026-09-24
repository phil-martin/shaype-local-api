/**
 * Bank-account details shared by Direct Entry instructions (service.ts) and scheduled payments
 * (schedules.ts): the anchored BSB / account-number patterns and the resolution of a BSB + account
 * number to a local account.
 */
import type { AppContext } from '../../context.js'
import { LOCAL_BSB } from '../../lib/ids.js'
import type { Account } from '../accounts/repo.js'

export const BSB_RE = /^\d{6}$/
export const ACCOUNT_NUMBER_RE = /^\d{5,9}$/

/** The local account a BSB + account number denote (BSB 636220, exact account number, any status), if any. */
export function resolveLocalAccount(ctx: AppContext, bsb: string, accountNumber: string): Account | undefined {
  if (bsb !== LOCAL_BSB) return undefined
  const hit = ctx.services.accounts.search(accountNumber)[0]
  return hit?.accountHayId ? ctx.services.accounts.find(hit.accountHayId) : undefined
}
