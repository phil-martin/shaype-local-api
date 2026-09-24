/**
 * groups-stacks domain — spec §5.9 (docs/superpowers/specs/2026-09-24-shaype-local-api-design.md) and
 * docs/map/groups-stacks.md. Owns the "Groups API" (6) and "Stacks API" (9) operations. Publishes
 * ctx.services.groups (the accounts domain's GroupsDep: requireAllMembersActive / memberIds /
 * groupIdsForCustomer, plus get / require / members / isMember / accounts) and ctx.services.stacks.
 *
 * Contract deviations: none — every response follows the declared schema. In particular createStack
 * and closeStack answer the bare `true` the spec declares (the new stackHayId is discovered through
 * getAllStacks, 00-open-questions I6 / C4), and updateStack reports a name clash inside its 200 body
 * (`{ error: STACK_NAME_ALREADY_IN_USE }`, no `stack`).
 *
 * Decisions beyond the spec (all covered in test/groups-stacks.test.ts):
 * - Groups: >= 1 member on create (422 INVALID_ARGUMENT); members must exist (404) and may not be
 *   INACTIVE / REJECTED (422 PERMISSION_DENIED) — any other status may join, only account creation needs
 *   every member ACTIVE (spec's verbatim 422); duplicate ids and re-added members are ignored (set
 *   union; an empty addCustomers list is a no-op); groupType defaults to PERSONAL and may be changed
 *   later even once an account exists; groupName defaults to "<clientId> Group <n>"; businessIdentifiers
 *   are stored as sent and replaced as a whole on update; "a group should have a single account" is not
 *   enforced — HayJointAccount.hayAccount is the account just created, else the first-created one, and
 *   is omitted while the group has none. createHayAccountForGroup is createAccount with the default
 *   product / AUD and its own idempotency scope.
 * - removeCustomerFromGroup: unknown customer 404; not a member 422 NOT_A_MEMBER; final member 422
 *   LAST_GROUP_MEMBER. The cascade is synchronous: every non-INACTIVE card the customer holds on the
 *   group's accounts is voided (cards.cancelAllForAccount with { customerId }: CARD_STATUS_CHANGE
 *   {INACTIVE}, PLATFORM; cards registers before this domain), and the customer becomes INACTIVE
 *   (customers.markInactive, PLATFORM, no statusReason) when no open account remains — personal or
 *   through a remaining group — and it was linked to at least one account, counting the accounts of the
 *   group just left (so the usual "one party leaves the joint account" case deactivates it; S18). A
 *   customer that never had an account (e.g. leaving a group without one) keeps its status.
 * - Stacks: createStack / updateStack need a non-CLOSED account (422 ACCOUNT_CLOSED); names are unique
 *   (exact match) among the account's OPEN stacks and may not contain emojis (422 INVALID_ARGUMENT);
 *   targetAmount takes <= 2 dp (400) and at most the account's MAX_BALANCE limit (account override, else
 *   product; 422); no open / total stack count limit. Closing an already CLOSED stack is a 200 no-op;
 *   update / transfer on a CLOSED stack is 422 STACK_CLOSED.
 * - Movements: amounts are positive magnitudes with <= 2 dp (400); customerId must exist (404) and hold
 *   the account — the holder or a group member (422 PERMISSION_DENIED); a LOCKED / CLOSED account is
 *   422 ACCOUNT_BLOCKED / ACCOUNT_CLOSED (the stack outcome enums carry no status value); funds
 *   refusals are 200 REFUSED_INSUFFICIENT_FUNDS with no transaction id (transfer-in checks the account's
 *   availableBalance — overdraft funds may be stacked — transfer-out and stack-to-stack the source
 *   stack's balance). Stack moves are exempt from every limit; stacked money stays on the ledger, so
 *   MAX_BALANCE counts it and it is never spendable. Any stack move (stack-to-stack included) is the
 *   account's first transactional action: APPROVED / DORMANT -> ACTIVE (00-status D-14).
 * - HayStackTransaction.amount is signed from the stack's perspective (deposit +, withdrawal −;
 *   00-transactions C12); stack-to-stack writes a withdrawal and a deposit cross-linked by
 *   counterpartTransactionId; closeStack sweeps a balance as an OPERATIONS withdrawal (customerId = the
 *   holder of a personal account, absent for a group account). Lists are in posting order, oldest
 *   first (spec §4: no sortBy, so creation time ascending; overrides 00-open-questions G2); limit 1..1000
 *   and offset >= 0 (400). ROUND_UP records come only from StacksService.roundUp (no B2B operation).
 * - Account closure: the accounts domain refuses closure while stacksBalance != 0 (ACCOUNT_BALANCE_STACKS);
 *   once an account is CLOSED its remaining empty open stacks are closed by the platform.
 * - No webhook is emitted by this domain (none exists for groups or stacks); see events.ts.
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import './schema.js'
import { GroupsStacksRepo } from './repo.js'
import { GroupsService, StacksService } from './service.js'
import { registerEvents } from './events.js'
import { registerRoutes } from './routes.js'

export { GroupsService, StacksService } from './service.js'
export type { CreateGroupInput, UpdateGroupInput, CreateStackInput, UpdateStackInput, StackMoveInput, StackMoveResult, StackToStackResult, StackOutcome, HayGroup, HayJointAccount, HayStack, HayStackTransaction } from './service.js'
export type { Group, GroupType, BusinessIdentifiers, Stack, StackStatus, StackTransaction, StackTransactionType, StackOriginType } from './repo.js'

export function register(app: FastifyInstance, ctx: AppContext): void {
  const repo = new GroupsStacksRepo(ctx.db)
  const groups = new GroupsService(ctx, repo)
  const stacks = new StacksService(ctx, repo)
  ctx.services.groups = groups
  ctx.services.stacks = stacks
  registerEvents(ctx, stacks)
  registerRoutes(app, ctx, groups, stacks)
}
