/**
 * The 8 "PayID API" operations and verifyBranchIdentifier ("NPP API"). Input arrives validated against
 * the spec schemas; responses are serialized through the success schema by defineRoute().
 */
import type { FastifyInstance } from 'fastify'
import { defineRoute } from '../../contract/route.js'
import type { AppContext } from '../../context.js'
import { ApiError } from '../../lib/errors.js'
import type { PayIdType } from './repo.js'
import type { PayIdService, RegisterInput, UpdateDetailsInput, UpdateStatusInput } from './service.js'

type ByPayId = { payId: string }
type ByAccount = { accountId: string }
type TypeQuery = { payIdType?: PayIdType }
type RequiredTypeQuery = { payIdType: PayIdType }

const BSB_RE = /^\d{6}$/
/** The spec's documented 422 for a malformed branchIdentifier (its example body, verbatim). */
export const BRANCH_IDENTIFIER_FORMAT_MESSAGE = 'branchIdentifier format is not correct.'

export function registerRoutes(app: FastifyInstance, ctx: AppContext, svc: PayIdService): void {
  // The path schema (pattern ^\d{6}$) would answer 400; the spec declares 422 with its own message for
  // this operation, so the format is checked before validation (scoped through the route config).
  app.addHook('preValidation', async (req) => {
    if ((req.routeOptions.config as { operationId?: string }).operationId !== 'verifyBranchIdentifier') return
    const { branchIdentifier } = req.params as { branchIdentifier?: string }
    if (typeof branchIdentifier !== 'string' || !BSB_RE.test(branchIdentifier)) throw new ApiError(422, BRANCH_IDENTIFIER_FORMAT_MESSAGE)
  })

  defineRoute<ByPayId, RequiredTypeQuery>(app, ctx, 'getPayId', (req) => svc.details(req.params.payId, req.query.payIdType))

  defineRoute<ByPayId, TypeQuery>(app, ctx, 'getPayIdAvailability', (req) => svc.availability(req.params.payId, req.query.payIdType))

  defineRoute<ByPayId>(app, ctx, 'getPayIdDeregisterHistory', (req) => svc.deregisterHistory(req.params.payId))

  defineRoute<ByPayId, never, UpdateDetailsInput>(app, ctx, 'updatePayIdDetails', (req) => {
    svc.updateDetails(req.params.payId, req.body)
    return { message: 'PayID details updated successfully.' }
  })

  defineRoute<ByPayId, TypeQuery>(app, ctx, 'resolvePayId', (req) => svc.resolveOrThrow(req.params.payId, req.query.payIdType))

  defineRoute<ByPayId, never, UpdateStatusInput>(app, ctx, 'updatePayIdStatus', (req) => {
    svc.updateStatus(req.params.payId, req.body)
    return { message: 'PayID status updated successfully.' }
  })

  defineRoute<ByAccount>(app, ctx, 'getPayIdsForAccount', (req) => svc.listForAccount(req.params.accountId))

  defineRoute<ByAccount & ByPayId, never, RegisterInput>(app, ctx, 'postPayIdRegister', (req) => {
    svc.register(req.params.accountId, req.params.payId, req.body)
    return { message: 'PayID registered successfully.' }
  })

  defineRoute<{ branchIdentifier: string }>(app, ctx, 'verifyBranchIdentifier', (req) => ({ enabled: svc.isNppEnabled(req.params.branchIdentifier) }))
}
