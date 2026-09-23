/**
 * The 11 "Customers API" operations. Input arrives validated against the spec schemas; the response is
 * serialized through the success schema by defineRoute().
 */
import type { FastifyInstance } from 'fastify'
import type { components } from '../../contract/generated/b2b-types.js'
import { defineRoute } from '../../contract/route.js'
import type { AppContext } from '../../context.js'
import { badRequest, unprocessable } from '../../lib/errors.js'
import { withIdempotency } from '../../lib/idempotency.js'
import { deps } from './deps.js'
import type { Page } from './repo.js'
import type { CreateCustomerInput, CustomersService, UpdateCustomerInput } from './service.js'

type S = components['schemas']
type ById = { customerId: string }
type ByHayId = { customerHayId: string }
type Paging = { offset: number; limit: number }

/** Legacy offset/limit flavour: both required by schema; limit 1..1000 and offset >= 0 by decision. */
function page(q: Paging): Page {
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 1000) throw badRequest('BAD_REQUEST: limit must be between 1 and 1000')
  if (!Number.isInteger(q.offset) || q.offset < 0) throw badRequest('BAD_REQUEST: offset must be 0 or greater')
  return { offset: q.offset, limit: q.limit }
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext, svc: CustomersService): void {
  const toResponse = (c: Parameters<CustomersService['toResponse']>[0]) => svc.toResponse(c)

  defineRoute<never, Paging>(app, ctx, 'getAllCustomers', (req) => svc.list(page(req.query)).map(toResponse))

  defineRoute<never, never, CreateCustomerInput>(app, ctx, 'createHayCustomer', async (req) => {
    const r = await withIdempotency(ctx, 'createHayCustomer', req.body.idempotencyKey, req.body, () => ({ status: 200, body: toResponse(svc.create(req.body)) }))
    return r.body
  })

  defineRoute<never, Paging, S['SearchCustomersRequestBody']>(app, ctx, 'searchCustomers', (req) => svc.search(req.body ?? {}, page(req.query)).map(toResponse))

  defineRoute<ByHayId, never, S['CreateHayAccountRequest']>(app, ctx, 'createHayAccount', async (req) => {
    const { customerHayId } = req.params
    const r = await withIdempotency(ctx, 'createHayAccount', req.body.idempotencyKey, { ...req.body, customerHayId }, async () => {
      svc.requireActive(customerHayId)
      const accounts = deps(ctx).accounts
      if (!accounts) throw unprocessable('NOT_AVAILABLE: accounts domain not loaded')
      const customData = req.body.customData === undefined ? undefined : (req.body.customData as Record<string, unknown> | null)
      const body = await accounts.create({ accountHolderType: 'CUSTOMER', accountHolderId: customerHayId, customData }, { actionOwner: 'CLIENT' })
      return { status: 200, body }
    })
    return r.body
  })

  defineRoute<ByHayId>(app, ctx, 'getAccountsForCustomerId', (req) => {
    svc.get(req.params.customerHayId)
    return deps(ctx).accounts?.listForHolder(req.params.customerHayId) ?? []
  })

  defineRoute<ByHayId>(app, ctx, 'getCardsForCustomerId', (req) => {
    svc.get(req.params.customerHayId)
    return deps(ctx).cards?.listForCustomer(req.params.customerHayId) ?? []
  })

  defineRoute<ById>(app, ctx, 'getHayCustomerById', (req) => toResponse(svc.get(req.params.customerId)))

  defineRoute<ById, never, UpdateCustomerInput>(app, ctx, 'updateCustomer', (req) => toResponse(svc.update(req.params.customerId, req.body)))

  defineRoute<ById, never, S['BlockCustomerRequestBody']>(app, ctx, 'blockCustomer', (req) => {
    svc.block(req.params.customerId, { note: req.body.note, actionOwner: 'CLIENT' })
    return { message: 'Customer blocked successfully.' }
  })

  defineRoute<ById, never, S['ChangeHayCustomerStatusRequestBody']>(app, ctx, 'changeHayCustomerStatus', (req) => toResponse(svc.changeStatus(req.params.customerId, req.body.newStatus)))

  defineRoute<ById, never, S['UnblockCustomerRequestBody']>(app, ctx, 'unblockCustomer', (req) => {
    svc.unblock(req.params.customerId, { actionOwner: 'CLIENT' })
    return { message: 'Customer unblocked successfully.' }
  })
}
