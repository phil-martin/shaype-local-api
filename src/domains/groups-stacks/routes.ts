/**
 * The "Groups API" (6) and "Stacks API" (9) operations. Input arrives validated against the spec
 * schemas; the response is serialized through the success schema by defineRoute().
 */
import type { FastifyInstance } from 'fastify'
import type { components } from '../../contract/generated/b2b-types.js'
import { defineRoute } from '../../contract/route.js'
import type { AppContext } from '../../context.js'
import { withIdempotency } from '../../lib/idempotency.js'
import type { StackTransactionType } from './repo.js'
import type { GroupsService, StacksService } from './service.js'

type S = components['schemas']
type ByGroup = { groupHayId: string }
type ByAccount = { accountId: string }
type ByStack = { accountId: string; stackId: string }
type TxQuery = { offset: number; limit: number; type?: StackTransactionType | null }

export function registerRoutes(app: FastifyInstance, ctx: AppContext, groups: GroupsService, stacks: StacksService): void {
  // ---------------------------------------------------------------- Groups API

  defineRoute<never, never, S['CreateHayGroupRequestBody']>(app, ctx, 'createHayGroup', async (req) => {
    const b = req.body
    const r = await withIdempotency(ctx, 'createHayGroup', b.idempotencyKey, b, () => ({
      status: 200,
      body: groups.toResponse(groups.create({ customerHayIds: b.customerHayIds, groupName: b.groupName, groupType: b.groupType, businessIdentifiers: b.businessIdentifiers })),
    }))
    return r.body
  })

  defineRoute<ByGroup>(app, ctx, 'getHayJointAccountByGroupHayId', (req) => groups.toJointAccount(groups.get(req.params.groupHayId)))

  defineRoute<ByGroup, never, S['UpdateGroupRequestBody']>(app, ctx, 'updateGroup', (req) =>
    groups.toResponse(groups.update(req.params.groupHayId, { groupName: req.body.groupName, groupType: req.body.groupType, businessIdentifiers: req.body.businessIdentifiers })))

  defineRoute<ByGroup, never, S['CreateHayAccountForGroupRequestBody']>(app, ctx, 'createHayAccountForGroup', async (req) => {
    const b = req.body
    const groupHayId = req.params.groupHayId
    const r = await withIdempotency(ctx, 'createHayAccountForGroup', b.idempotencyKey, { ...b, groupHayId }, () => {
      const g = groups.get(groupHayId)
      // accounts.create runs the all-members-ACTIVE gate through ctx.services.groups.requireAllMembersActive
      const account = ctx.services.accounts.createEntity({ accountHolderType: 'GROUP', accountHolderId: g.id, customData: b.customData as Record<string, unknown> | null | undefined })
      return { status: 200, body: groups.toJointAccount(g, account) }
    })
    return r.body
  })

  defineRoute<ByGroup, never, S['AddCustomersToGroupRequestBody']>(app, ctx, 'addCustomersToGroup', (req) =>
    groups.toJointAccount(groups.addMembers(req.params.groupHayId, req.body.customerHayIds)))

  defineRoute<ByGroup, never, S['RemoveCustomerFromGroupRequestBody']>(app, ctx, 'removeCustomerFromGroup', (req) =>
    groups.toJointAccount(groups.removeMember(req.params.groupHayId, req.body.customerId)))

  // ---------------------------------------------------------------- Stacks API

  defineRoute<ByAccount, { includeClosed?: boolean }>(app, ctx, 'getAllStacks', (req) => stacks.list(req.params.accountId, req.query.includeClosed === true))

  defineRoute<ByAccount, never, S['CreateHayStackRequestBody']>(app, ctx, 'createStack', (req) => {
    stacks.create(req.params.accountId, { name: req.body.name, imageUrl: req.body.imageUrl, targetAmount: req.body.targetAmount })
    return true
  })

  defineRoute<ByAccount, TxQuery>(app, ctx, 'getAllStackTransactions', (req) => stacks.listTransactions(req.params.accountId, req.query))

  defineRoute<ByAccount, never, S['StackToStackTransferRequestBody']>(app, ctx, 'stackToStackTransfer', (req) =>
    stacks.transferBetween(req.params.accountId, {
      amount: req.body.amount, customerId: req.body.customerId, description: req.body.description,
      withdrawalStackId: req.body.withdrawalStackId, depositStackId: req.body.depositStackId,
    }))

  defineRoute<ByStack, never, S['UpdateStackRequestBody']>(app, ctx, 'updateStack', (req) =>
    stacks.update(req.params.accountId, req.params.stackId, { name: req.body.name, imageUrl: req.body.imageUrl, targetAmount: req.body.targetAmount }))

  defineRoute<ByStack>(app, ctx, 'closeStack', (req) => {
    stacks.close(req.params.accountId, req.params.stackId)
    return true
  })

  defineRoute<ByStack, TxQuery>(app, ctx, 'getTransactionsForStack', (req) => stacks.listTransactions(req.params.accountId, req.query, req.params.stackId))

  defineRoute<ByStack, never, S['AccountToStackTransferRequestBody']>(app, ctx, 'accountToStackTransfer', (req) =>
    stacks.transferIn(req.params.accountId, req.params.stackId, { amount: req.body.amount, customerId: req.body.customerId, description: req.body.description }))

  defineRoute<ByStack, never, S['StackToAccountTransferRequestBody']>(app, ctx, 'stackToAccountTransfer', (req) =>
    stacks.transferOut(req.params.accountId, req.params.stackId, { amount: req.body.amount, customerId: req.body.customerId, description: req.body.description }))
}
