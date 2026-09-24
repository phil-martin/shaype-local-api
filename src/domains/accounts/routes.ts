/**
 * The "Accounts API" operations owned by this domain (transfers and holds belong to transactions) plus
 * getAllProducts. Input arrives validated against the spec schemas; the response is serialized through
 * the success schema by defineRoute().
 */
import type { FastifyInstance } from 'fastify'
import type { components } from '../../contract/generated/b2b-types.js'
import { defineRoute } from '../../contract/route.js'
import type { AppContext } from '../../context.js'
import { badRequest } from '../../lib/errors.js'
import { withIdempotency } from '../../lib/idempotency.js'
import { deps } from './deps.js'
import type { LimitType } from './products.js'
import type { CloseReason } from './repo.js'
import type { AccountsService, AddRuleInput } from './service.js'

type S = components['schemas']
type ById = { accountId: string }
type ByRule = { accountId: string; ruleId: string }
type ByLimit = { accountId: string; limitType: LimitType }

const CLOSE_REASONS: ReadonlySet<string> = new Set(['SUSPICIOUS', 'DECEASED', 'CUSTOMER', 'OPERATIONAL'])

export function registerRoutes(app: FastifyInstance, ctx: AppContext, svc: AccountsService): void {
  defineRoute(app, ctx, 'getAllProducts', () => svc.productSummaries())

  defineRoute<never, never, S['CreateAccountRequestBody']>(app, ctx, 'createAccount', async (req) => {
    const b = req.body
    const r = await withIdempotency(ctx, 'createAccount', b.idempotencyKey, b, () => ({
      status: 200,
      body: svc.create({
        accountHolderType: b.accountHolderType,
        accountHolderId: b.accountHolderId,
        productId: b.productId,
        accountNumber: b.accountNumber,
        currency: b.currency,
        customData: b.customData as Record<string, unknown> | null | undefined,
        parentAccountId: b.parentAccountId,
        fx: b.fx,
      }, { actionOwner: 'CLIENT' }),
    }))
    return r.body
  })

  defineRoute<never, never, S['SearchAccountsRequestBody']>(app, ctx, 'searchAccounts', (req) => svc.search(req.body.accountNumber))

  defineRoute<ById, { expand?: string }>(app, ctx, 'getHayAccount', (req) => {
    const expand = (req.query.expand ?? '').split(',').map((s) => s.trim())
    return svc.toResponse(svc.get(req.params.accountId), { expandCustomData: expand.includes('customData') })
  })

  defineRoute<ById, never, S['BlockAccountRequestBody']>(app, ctx, 'blockAccount', (req) =>
    svc.block(req.params.accountId, { note: req.body.note, style: req.body.accountBlockStyle, actionOwner: 'CLIENT' }))

  defineRoute<ById, never, S['UnblockAccountRequestBody']>(app, ctx, 'unblockAccount', (req) => {
    svc.unblock(req.params.accountId, { note: req.body.note, actionOwner: 'CLIENT' })
    return { message: 'Account unblocked successfully.' }
  })

  defineRoute<ById, never, S['CloseAccountRequestBody'] | undefined>(app, ctx, 'closeAccount', (req) => {
    const body = req.body
    let reason: CloseReason | undefined
    if (body !== undefined && body !== null) {
      if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('BAD_REQUEST: body must be an object')
      if (body.reason !== undefined && body.reason !== null) {
        if (typeof body.reason !== 'string' || !CLOSE_REASONS.has(body.reason)) throw badRequest(`BAD_REQUEST: body/reason must be equal to one of the allowed values`)
        reason = body.reason
      }
    }
    return svc.close(req.params.accountId, reason)
  })

  defineRoute<ById, never, S['UpdateOptOutRequestBody']>(app, ctx, 'updateCopOptOut', (req) => {
    svc.setCopOptOut(req.params.accountId, req.body.optOut)
    return { message: 'CoP opt-out updated successfully.' }
  })

  defineRoute<ById, never, S['UpdateMaxBalanceLimitRequestBody']>(app, ctx, 'updateMaxBalanceLimit', (req) => {
    svc.setLimit(req.params.accountId, 'MAX_BALANCE', req.body.maxBalanceLimit, 'maxBalanceLimit')
    return { message: 'Max balance limit updated successfully.' }
  })

  defineRoute<ById, never, S['UpdateOverdraftLimitRequestBody']>(app, ctx, 'updateOverdraftLimit', (req) => {
    svc.setOverdraftLimit(req.params.accountId, req.body.overdraftLimit)
    return { message: 'Overdraft limit updated successfully.' }
  })

  defineRoute<ById>(app, ctx, 'getAccountRiskLevel', (req) => ({ accountId: req.params.accountId, riskLevel: svc.riskLevel(req.params.accountId) }))

  defineRoute<ById, never, S['ChangeHayAccountRiskLevelRequestBody']>(app, ctx, 'changeAccountRiskLevel', (req) => {
    svc.setRiskLevel(req.params.accountId, req.body.level, req.body.reason)
    return { message: 'Risk level changed successfully.' }
  })

  defineRoute<ById>(app, ctx, 'getCardsForAccountId', (req) => {
    svc.get(req.params.accountId)
    return deps(ctx).cards?.listForAccount(req.params.accountId) ?? []
  })

  defineRoute<ById>(app, ctx, 'getAccountLimits', (req) => svc.limits(req.params.accountId))

  defineRoute<ByLimit, never, S['ExternalSetAccountLimitRequestBody']>(app, ctx, 'setAccountLimit', (req) =>
    svc.setLimit(req.params.accountId, req.params.limitType, req.body.limitAmount))

  defineRoute<ByLimit>(app, ctx, 'deleteAccountLimit', (req) => ({ success: svc.deleteLimit(req.params.accountId, req.params.limitType) }))

  defineRoute<ById>(app, ctx, 'getAccountRules', (req) => svc.rules(req.params.accountId))

  defineRoute<ById, never, AddRuleInput>(app, ctx, 'addAccountRule', (req) => svc.addRule(req.params.accountId, req.body))

  defineRoute<ByRule>(app, ctx, 'getAccountRuleById', (req) => svc.rule(req.params.accountId, req.params.ruleId))

  defineRoute<ByRule>(app, ctx, 'disableRule', (req) => ({ success: svc.disableRule(req.params.accountId, req.params.ruleId) }))

  defineRoute<ById, never, S['CreateAccountCustomDataRequestBody']>(app, ctx, 'createAccountCustomData', (req) => {
    svc.setCustomData(req.params.accountId, req.body.customData as Record<string, unknown>)
    return { message: 'Custom data created successfully.' }
  })

  defineRoute<ById>(app, ctx, 'deleteAccountCustomData', (req) => {
    svc.deleteCustomData(req.params.accountId)
    return { message: 'Custom data deleted successfully.' }
  })
}
