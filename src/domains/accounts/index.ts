/**
 * accounts domain — spec §5.2 (docs/superpowers/specs/2026-09-24-shaype-local-api-design.md) and docs/map/accounts.md.
 * Owns the "Accounts API" operations except makeTransferV0/V1 and getPendingHolds (transactions domain)
 * plus the seeded reference data getAllProducts and getAllMerchantCategoryCodes (mccs.ts). Publishes ctx.services.accounts (service.ts) for the ledger, cards, groups and
 * payment domains; expected shapes of later domains' services: deps.ts.
 *
 * Contract deviations: none — every response follows the declared schema. getAllProducts is bound by
 * the spec to the perk ProductSummary schema, so the seeded banking product is carried in its
 * id/name/description/countryIsoCode fields.
 *
 * Decisions beyond the spec (all covered in test/accounts.test.ts):
 * - Money movement gate: APPROVED / ACTIVE / ACTIVE_IN_ARREARS / DORMANT are open; DORMANT behaves as
 *   ACTIVE and any ledger or stack movement promotes APPROVED/DORMANT to ACTIVE.
 * - unblockAccount lands on ACTIVE_IN_ARREARS instead of ACTIVE when the account is technically overdrawn
 *   and also unblocks child accounts. Customers blocked through blockAccount are released only when the
 *   last LOCKED account holding them is unblocked (each default-style block records the customers it
 *   holds); customers blocked independently through blockCustomer stay BLOCKED, and a customer that
 *   leaves BLOCKED by any other route is dropped from every account's holds (a later blockCustomer is its own).
 * - blockAccount never touches cards (spec §5.2 lists no card cascade); child FX accounts are blocked too.
 *   A default-style block on an already LOCKED account still blocks the customer (it widens an earlier
 *   ACCOUNT_ONLY block); blockedBy follows the caller (CLIENT from the API, PLATFORM for platform blocks).
 *   A child account cannot be created under a LOCKED parent (422 ACCOUNT_BLOCKED) — a blocked wallet must
 *   not be partly reopened; a child that fx.childAccounts provisions after its parent was blocked is
 *   created LOCKED with the parent's block (APPROVED then BLOCKED, both PLATFORM).
 * - closeAccount on a CLOSED account is a 202 SUCCESS no-op; success bodies carry `errors: []`. An accepted
 *   closure is recorded (closeRequestedAt) and money movements are refused REFUSED_ACCOUNT_CLOSED from then
 *   on, so the asynchronous cascade always finds the balances it validated and closes the account (a child
 *   cannot be opened under it either); a repeated request while pending schedules nothing new. Owners inside the cascade follow the webhook matrix:
 *   ACCOUNT_STATUS_CHANGE {CLOSED} is CLIENT (the closeAccount call caused it), while the card
 *   cancellations (deps.ts) and the customer's INACTIVE are PLATFORM cascades.
 * - Limits: accountLimit is omitted (not null) when no override exists; effectiveLimit is 0 while risk
 *   level HIGH (overrides are preserved); deleteAccountLimit on a non-settable type answers success:false;
 *   a hidden product-level TRANSFERS_OUT_PER_DAY limit backs REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED;
 *   OVERDRAFT_PRODUCT_LIMIT is 10,000, PAYMENT_TO_PAY_ID 50,000, MIN_* 0; updateOverdraftLimit accepts 0.
 *   Request amounts with more than two decimal places are refused (400), never rounded.
 * - Rules: rule echoes the submitted ruleDetails; ownerId is the account holder id; name matching is
 *   case-insensitive; expired rules read disabled:true; disableRule is a soft delete (rule stays listed);
 *   an expiresIn past the Date range is 422 INVALID_RULE.
 * - createAccount: customData is returned only through getHayAccount?expand=customData; non-AUD accounts
 *   need parentAccountId (one child per currency, same holder); fx.childAccounts provisions children
 *   asynchronously (CUSTOM/ALL) after the documented INVALID_ARGUMENT 422s, without re-checking the holder
 *   (the parent was already authorised); homeCurrencyBalanceEquivalent is the identity on AUD accounts
 *   and omitted on FX children (no FX rates locally).
 * - PENDING_APPROVAL is never produced (setStatus refuses it): accounts created through this API are APPROVED.
 * - ACCOUNT_STATUS_CHANGE on creation is always actionOwner PLATFORM (docs sample); status changes made by
 *   API calls are CLIENT, ledger-driven flips PLATFORM. Group-held accounts notify every member.
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import './schema.js'
import { assertDeps } from './deps.js'
import { AccountRepo } from './repo.js'
import { AccountsService } from './service.js'
import { registerEvents } from './events.js'
import { registerRoutes } from './routes.js'

export { AccountsService, computeBalances, balancesToJson } from './service.js'
export type { Balances, BalanceDeltas, CreateAccountInput, MovementRefusal, LimitUsageProvider, ClosureChecker, MerchantInput } from './service.js'
export type { Account, AccountStatus, AccountRule, CloseReason, HolderType, RiskLevel } from './repo.js'
export type { CardsDep, GroupsDep } from './deps.js'
export { LOCAL_PRODUCT_ID, LIMIT_TYPES, SETTABLE_LIMIT_TYPES, LIMIT_OUTCOME, LOCAL_PRODUCT } from './products.js'
export type { LimitType, InternalLimitType, LimitOutcome, WebhookOutcome, Product } from './products.js'

export function register(app: FastifyInstance, ctx: AppContext): void {
  const svc = new AccountsService(ctx, new AccountRepo(ctx.db))
  ctx.services.accounts = svc
  registerEvents(ctx, svc)
  registerRoutes(app, ctx, svc)
  app.addHook('onReady', async () => assertDeps(ctx))
}
