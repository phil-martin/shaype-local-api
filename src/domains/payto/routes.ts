/**
 * The 22 "PayTo API" operations. Input arrives validated against the spec schemas (mandate ids in
 * paths and bodies are `format: uuid`, so the hyphenated form is the one the contract admits there);
 * the response is serialized through the success schema by defineRoute().
 */
import type { FastifyInstance } from 'fastify'
import { defineRoute } from '../../contract/route.js'
import type { AppContext } from '../../context.js'
import { withIdempotency } from '../../lib/idempotency.js'
import type { MandateStatus } from './repo.js'
import {
  SUCCESS_MESSAGE,
  type ActionsQuery,
  type AmendMandateByInitiatorRequestBody,
  type AmendMandateByPayerRequestBody,
  type AmendMandatePaymentTermsRequestBody,
  type CancelMandateRequestBody,
  type CreateMandateRequestBody,
  type MakeAdhocPaymentRequestBody,
  type PayToService,
  type Resolution,
  type SetScheduledPaymentInitiationAmountRequestBody,
  type SuspendMandateRequestBody,
} from './service.js'

type ByMandate = { mandateId: string }
type MandatesQuery = { accountIds: string[]; statuses?: MandateStatus[]; pageNumber: number; pageSize: number }

export function registerRoutes(app: FastifyInstance, ctx: AppContext, svc: PayToService): void {
  // ---------------------------------------------------------------- initiator

  defineRoute<never, { creditorAccountId: string }>(app, ctx, 'getMandateIdsByInitiator', (req) => svc.mandateIdsForCreditorAccount(req.query.creditorAccountId))

  defineRoute<never, never, CreateMandateRequestBody>(app, ctx, 'createMandate', async (req) => {
    const r = await withIdempotency(ctx, 'createMandate', req.body.idempotencyKey, req.body, () => ({ status: 200, body: { mandateId: svc.create(req.body).id } }))
    return r.body
  })

  defineRoute<ByMandate, never, AmendMandateByInitiatorRequestBody>(app, ctx, 'amendMandateByInitiator', (req) => {
    svc.amendByInitiator(req.params.mandateId, req.body)
    return { message: SUCCESS_MESSAGE.amended }
  })

  defineRoute<ByMandate, ActionsQuery>(app, ctx, 'getMandateActionsByInitiator', (req) => ({ actions: svc.actions(req.params.mandateId, req.query).map((a) => svc.actionToResponse(a)) }))

  defineRoute<ByMandate, never, CancelMandateRequestBody>(app, ctx, 'cancelMandateByInitiator', (req) => {
    svc.cancel(req.params.mandateId, 'INITIATOR', req.body)
    return { message: SUCCESS_MESSAGE.cancelled }
  })

  defineRoute<ByMandate & { instructionId: string }>(app, ctx, 'getMandatePaymentStatus', (req) => svc.paymentStatus(req.params.mandateId, req.params.instructionId))

  defineRoute<ByMandate, never, AmendMandatePaymentTermsRequestBody>(app, ctx, 'amendMandatePaymentTerms', (req) => {
    svc.amendPaymentTerms(req.params.mandateId, req.body)
    return { message: SUCCESS_MESSAGE.amendProposed }
  })

  defineRoute<ByMandate, never, SetScheduledPaymentInitiationAmountRequestBody>(app, ctx, 'setScheduledPaymentInitiationRequestAmount', (req) => {
    svc.setScheduledAmount(req.params.mandateId, req.body)
    return { message: SUCCESS_MESSAGE.amountSet }
  })

  defineRoute<ByMandate>(app, ctx, 'releaseMandateByInitiator', (req) => {
    svc.release(req.params.mandateId, 'INITIATOR')
    return { message: SUCCESS_MESSAGE.released }
  })

  defineRoute<ByMandate>(app, ctx, 'resolveMandateByInitiator', (req) => {
    svc.recallByInitiator(req.params.mandateId)
    return { message: SUCCESS_MESSAGE.recalled }
  })

  defineRoute<ByMandate>(app, ctx, 'searchPaymentsInstructions', (req) => ({ paymentInstructions: svc.instructions(req.params.mandateId).map((i) => svc.instructionToResponse(i)) }))

  defineRoute<ByMandate, never, SuspendMandateRequestBody>(app, ctx, 'suspendMandateByInitiator', (req) => {
    svc.suspend(req.params.mandateId, 'INITIATOR', req.body)
    return { message: SUCCESS_MESSAGE.suspended }
  })

  // ---------------------------------------------------------------- shared

  defineRoute<never, MandatesQuery>(app, ctx, 'getMandates', (req) => {
    const { result, totalCount } = svc.search(req.query.accountIds, req.query.statuses, { pageNumber: req.query.pageNumber, pageSize: req.query.pageSize })
    return { result: result.map((m) => svc.toSummary(m)), totalCount }
  })

  defineRoute<ByMandate>(app, ctx, 'getMandate', (req) => svc.toResponse(svc.get(req.params.mandateId)))

  // ---------------------------------------------------------------- payer

  defineRoute<ByMandate, never, AmendMandateByPayerRequestBody>(app, ctx, 'amendMandateByPayer', (req) => {
    svc.amendByPayer(req.params.mandateId, req.body)
    return { message: SUCCESS_MESSAGE.amended }
  })

  defineRoute<ByMandate, ActionsQuery>(app, ctx, 'getMandateActionsByPayer', (req) => {
    svc.requireAsPayer(req.params.mandateId)
    return { actions: svc.actions(req.params.mandateId, req.query).map((a) => svc.actionToResponse(a)) }
  })

  defineRoute<ByMandate, never, CancelMandateRequestBody>(app, ctx, 'cancelMandateByPayer', (req) => {
    svc.cancel(req.params.mandateId, 'PAYER', req.body)
    return { message: SUCCESS_MESSAGE.cancelled }
  })

  defineRoute<ByMandate>(app, ctx, 'releaseMandateByPayer', (req) => {
    svc.release(req.params.mandateId, 'PAYER')
    return { message: SUCCESS_MESSAGE.released }
  })

  defineRoute<ByMandate, { resolution: Resolution }>(app, ctx, 'resolveMandateByPayer', (req) => {
    svc.resolveByPayer(req.params.mandateId, req.query.resolution)
    return { message: SUCCESS_MESSAGE.resolved }
  })

  defineRoute<ByMandate, never, SuspendMandateRequestBody>(app, ctx, 'suspendMandateByPayer', (req) => {
    svc.suspend(req.params.mandateId, 'PAYER', req.body)
    return { message: SUCCESS_MESSAGE.suspended }
  })

  // ---------------------------------------------------------------- payments and lookups

  defineRoute<never, never, MakeAdhocPaymentRequestBody>(app, ctx, 'makeAdhocPayment', async (req) => {
    const r = await withIdempotency(ctx, 'makeAdhocPayment', req.body.idempotencyKey, req.body, () => ({ status: 200, body: svc.adhocPayment(req.body) }))
    return r.body
  })

  defineRoute<{ bsbNumber: string }>(app, ctx, 'checkBsbIsSupportedByPayTo', (req) => ({ supported: svc.bsbSupported(req.params.bsbNumber) }))
}
