/**
 * payid-npp domain — spec §5.6 (docs/superpowers/specs/2026-09-24-shaype-local-api-design.md) and docs/map/payid-npp.md.
 * Owns the 8 "PayID API" operations and verifyBranchIdentifier ("NPP API"). Publishes ctx.services.payid
 * (service.ts); transactions.transfer resolves PAY_ID transfers through payid.resolve() (shape in
 * src/domains/transactions/deps.ts). No PayID webhook exists in the notification spec, so this domain
 * emits none (docs/map/00-webhook-matrix.md).
 *
 * Contract deviations: none — every response follows the declared schema. verifyBranchIdentifier answers
 * the spec's documented 422 ("branchIdentifier format is not correct.") for a malformed path value instead
 * of the schema validator's 400.
 *
 * Decisions beyond the spec (all covered in test/payid-npp.test.ts):
 * - Identity is (value, type); a value is stored trimmed and, for EMAIL, lower-cased; lookups are
 *   case-insensitive. Without payIdType (availability / resolve) the value is searched across every type,
 *   preferring the live registration (ACTIVE, PORTABLE, DISABLED) over the latest DEREGISTERED one — no
 *   shape inference. De-register history merges every type of the value.
 * - Each registration is its own record: a DEREGISTERED value registered again (same or another account)
 *   gets a new ACTIVE record while the old account's list keeps the DEREGISTERED one. getPayIdsForAccount
 *   returns every status; getPayId returns a DEREGISTERED record (with its historical account details).
 * - Per-type formats are enforced on register (422 INVALID_PAY_ID): TELEPHONE `+<cc>-<1-9><digits>`,
 *   EMAIL one `@`, no whitespace, <= 256 chars, INDIVIDUAL_AUSTRALIAN_BUSINESS 9-11 digits, ORGANISATION
 *   free text <= 256 chars. ownerName is not checked against the account holder.
 * - Register preconditions (S7 gate): account open (LOCKED -> 422 ACCOUNT_BLOCKED, CLOSED -> 422
 *   ACCOUNT_CLOSED), BSB NPP-enabled (422 NPP_NOT_ENABLED), every owning customer ACTIVE (422
 *   PERMISSION_DENIED). A value ACTIVE/DISABLED on another account, or DISABLED on this one -> 422
 *   PAYID_ALREADY_REGISTERED; already ACTIVE on this account -> 200 no-op; PORTABLE on this account ->
 *   back to ACTIVE with the new names; PORTABLE on another account -> ported: the old registration becomes
 *   DEREGISTERED (reason PART, history entry) and the new one is ACTIVE.
 * - Status machine: ACTIVE -> DISABLED | PORTABLE | DEREGISTERED, DISABLED -> ACTIVE | DEREGISTERED,
 *   PORTABLE -> ACTIVE | DISABLED | DEREGISTERED (explicit PORTABLE -> ACTIVE accepted); same status ->
 *   200 no-op; DISABLED -> PORTABLE and anything else -> 422 INVALID_STATUS_TRANSITION; a DEREGISTERED
 *   PayID -> 422 INVALID_STATE. Any reason goes with any status; null/omitted clears the stored reason.
 * - Availability: true when nothing live holds the value (unknown, DEREGISTERED, PORTABLE), false while
 *   ACTIVE or DISABLED; `servicer` (local BIC11 LOCLAU2SXXX) only for a live registration.
 * - resolvePayId: ACTIVE and PORTABLE resolve (lastResolutionDateTimeUtc bumped, also when a PAY_ID
 *   transfer resolves); DISABLED / DEREGISTERED -> 422 INVALID_STATE; unknown -> 404 NOT_FOUND (spec §4:
 *   unknown entity). services.payid.resolve() answers undefined in every failing case -> REFUSED_INVALID_PAY_ID.
 * - updatePayIdDetails: omitted or null fields are unchanged, an empty string is a 400; allowed in every
 *   status but DEREGISTERED; an unchanged body does not bump lastUpdatedDateTimeUtc.
 * - Timers on the virtual clock (scheduler tick): PORTABLE -> ACTIVE after 14 days, DEREGISTERED record
 *   purged after 90 days (history kept), ACTIVE -> DISABLED (reason PART) after 10 years without activity.
 * - Cross-domain: updateCustomer name change sets ownerName ("<firstName> <lastName>") on the live PayIDs of
 *   the customer's own (not group) accounts unless skipPayIdUpdate; the account-closure cascade deregisters
 *   the account's PayIDs with the closure reason mapped CUSTOMER->CUST, DECEASED->DECD, SUSPICIOUS->FROD,
 *   OPERATIONAL->PART (CUST when none).
 * - verifyBranchIdentifier: every 6-digit BSB is enabled except 999999.
 * - GenericMessage texts: "PayID registered successfully." / "PayID details updated successfully." /
 *   "PayID status updated successfully.".
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import './schema.js'
import { PayIdRepo } from './repo.js'
import { PayIdService } from './service.js'
import { registerEvents } from './events.js'
import { registerRoutes } from './routes.js'

export { PayIdService, LOCAL_SERVICER_BIC, NPP_INELIGIBLE_BSB, PORTABLE_REVERT_DAYS, DEREGISTERED_PURGE_DAYS, INACTIVITY_DISABLE_YEARS, validateValue, normalise } from './service.js'
export type { ResolvedPayId } from './service.js'
export { PAY_ID_TYPES, PAY_ID_STATUSES, PAY_ID_REASONS } from './repo.js'
export type { PayId, PayIdType, PayIdStatus, PayIdReason } from './repo.js'
export { BRANCH_IDENTIFIER_FORMAT_MESSAGE } from './routes.js'

export function register(app: FastifyInstance, ctx: AppContext): void {
  const svc = new PayIdService(ctx, new PayIdRepo(ctx.db))
  ctx.services.payid = svc
  registerEvents(ctx, svc)
  registerRoutes(app, ctx, svc)
  ctx.scheduler.onTick(() => svc.tick())
}
