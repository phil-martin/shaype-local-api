/**
 * The 6 "BPAY API" operations. Input arrives validated against the spec schemas; responses are
 * serialized through the success schema by defineRoute() — except retrieveBillers (see below).
 */
import type { FastifyInstance } from 'fastify'
import { defineRoute } from '../../contract/route.js'
import type { AppContext } from '../../context.js'
import { badRequest } from '../../lib/errors.js'
import { withIdempotency } from '../../lib/idempotency.js'
import type { Page } from './repo.js'
import type { BPayBillerAddRequestBody, BPayBillerRequestBody, BPayBillerUpdateRequestBody, BPayPaymentRequestBody, BpayService } from './service.js'

type ByAccount = { accountId: string }
type ByBiller = { billerId: string }
type Paging = { offset: number; limit: number }

/** Legacy offset/limit flavour: both required by schema; limit 1..1000 and offset >= 0 by decision (spec §4). */
function page(q: Paging): Page {
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 1000) throw badRequest('BAD_REQUEST: limit must be between 1 and 1000')
  if (!Number.isInteger(q.offset) || q.offset < 0) throw badRequest('BAD_REQUEST: offset must be 0 or greater')
  return { offset: q.offset, limit: q.limit }
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext, svc: BpayService): void {
  defineRoute<ByAccount, Paging>(app, ctx, 'retrieveBillers', (req, reply) => {
    const list = svc.listBillers(req.params.accountId, page(req.query)).map((b) => svc.toResponse(b))
    // Contract deviation (spec §4 "Contract fidelity"): the operation declares a single BPayBillerResponse
    // but is a paged list, so the array is sent past the object serializer.
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(list))
  })

  defineRoute<ByAccount, never, BPayBillerAddRequestBody>(app, ctx, 'createBPayBiller', (req) => svc.toResponse(svc.createBiller(req.params.accountId, req.body)))

  defineRoute<ByAccount, never, BPayPaymentRequestBody>(app, ctx, 'makeBpayPayment', async (req) => {
    const { accountId } = req.params
    const b = req.body
    const r = await withIdempotency(ctx, 'makeBpayPayment', b.idempotencyKey, { ...b, accountId }, () => ({ status: 200, body: svc.pay(accountId, b, { actionOwner: 'CLIENT' }) }))
    return r.body
  })

  defineRoute<never, never, BPayBillerRequestBody>(app, ctx, 'validateBpay', (req) => svc.validateBpay(req.body))

  defineRoute<ByBiller>(app, ctx, 'retrieveBpayBiller', (req) => svc.toResponse(svc.getBiller(req.params.billerId)))

  defineRoute<ByBiller, never, BPayBillerUpdateRequestBody>(app, ctx, 'updateBpayBiller', (req, reply) => {
    svc.updateBiller(req.params.billerId, req.body)
    // 204: the contract declares an (empty) JSON object body; nothing is sent.
    return reply.code(204).send()
  })
}
