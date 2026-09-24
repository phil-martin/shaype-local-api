/**
 * The 22 "PayTo API" operations. Input arrives validated against the spec schemas after the
 * preValidation hook below has normalised it: a `mandateId` in the path or body may use either
 * encoding (hyphenated UUID or the 32-hex MMS form, which the contract's `format: uuid` would otherwise
 * refuse), and a createMandate creditor identified by alias only gets the local account it resolves to.
 * The response is serialized through the success schema by defineRoute().
 */
import type { FastifyInstance } from 'fastify'
import { defineRoute } from '../../contract/route.js'
import type { AppContext } from '../../context.js'
import { withIdempotency } from '../../lib/idempotency.js'
import type { AccountAliasType, MandateStatus } from './repo.js'
import {
  SUCCESS_MESSAGE,
  normaliseMandateId,
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

const TAG = 'PayTo API'
const ALIAS_TYPES: ReadonlySet<string> = new Set<AccountAliasType>(['AUSTRALIAN_BUSINESS_NUMBER', 'EMAIL_ADDRESS', 'ORGANISATION_ID', 'PHONE_NUMBER'])

export function registerRoutes(app: FastifyInstance, ctx: AppContext, svc: PayToService): void {
  app.addHook('preValidation', async (req) => {
    if ((req.routeOptions.config as { tag?: string } | undefined)?.tag !== TAG) return
    const params = req.params as Record<string, unknown> | undefined
    if (typeof params?.mandateId === 'string') params.mandateId = normaliseMandateId(params.mandateId)
    // getMandates: statuses comma-joined like accountIds (I11), split before the enum schema runs
    const query = req.query as Record<string, unknown> | undefined
    if (query && (typeof query.statuses === 'string' || Array.isArray(query.statuses))) {
      query.statuses = ([] as unknown[]).concat(query.statuses).flatMap((v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [v]))
    }
    const body = req.body as Record<string, unknown> | null | undefined
    if (!body || typeof body !== 'object') return
    if (typeof body.mandateId === 'string') body.mandateId = normaliseMandateId(body.mandateId)
    // createMandate: "instead of providing account_id to identify creditor or debtor, an alias might be used instead" (docs)
    const creditor = body.creditorDetails as Record<string, unknown> | undefined
    // (a malformed alias is left to the schema, which then answers 400 for the missing accountId)
    if (creditor && typeof creditor === 'object' && creditor.accountId === undefined && typeof creditor.accountAliasIdentification === 'string' && ALIAS_TYPES.has(creditor.accountAliasType as string)) {
      creditor.accountId = svc.resolveCreditorAlias(creditor.accountAliasIdentification, creditor.accountAliasType as AccountAliasType)
    }
  })

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

  defineRoute<ByMandate, ActionsQuery>(app, ctx, 'getMandateActionsByInitiator', (req) => {
    svc.requireAsInitiator(req.params.mandateId)
    return { actions: svc.actions(req.params.mandateId, req.query).map((a) => svc.actionToResponse(a)) }
  })

  defineRoute<ByMandate, never, CancelMandateRequestBody>(app, ctx, 'cancelMandateByInitiator', (req) => {
    svc.cancel(req.params.mandateId, 'INITIATOR', req.body)
    return { message: SUCCESS_MESSAGE.cancelled }
  })

  defineRoute<ByMandate & { instructionId: string }>(app, ctx, 'getMandatePaymentStatus', (req) => {
    svc.requireAsInitiator(req.params.mandateId)
    return svc.paymentStatus(req.params.mandateId, req.params.instructionId)
  })

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

  defineRoute<ByMandate>(app, ctx, 'searchPaymentsInstructions', (req) => {
    svc.requireAsInitiator(req.params.mandateId)
    return { paymentInstructions: svc.instructions(req.params.mandateId).map((i) => svc.instructionToResponse(i)) }
  })

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
