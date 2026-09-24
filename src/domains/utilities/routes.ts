/**
 * The 13 "Utilities API" operations. Input arrives validated against the spec schemas (after the
 * preValidation hook below, which lets the Initiator mock accept the docs' PCRD trigger); the response is
 * serialized through the success schema by defineRoute(). NPP v1 (required key) and DE inbound (optional
 * key) replay through withIdempotency.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { defineRoute } from '../../contract/route.js'
import type { AppContext } from '../../context.js'
import { withIdempotency } from '../../lib/idempotency.js'
import type { MandateTrigger } from '../payto/index.js'
import type {
  ChangeCardExpiryDateRequestBody,
  CreateStubForMandateSearchPaymentInstructionsRequestBody,
  GenerateCardHoldAndSettleTransactionRequestBody,
  GenerateCardHoldTransactionRequestBody,
  GenerateCardTransactionRequestBody,
  GenerateInboundDeRequestBody,
  GenerateInboundNppTransactionRequestBody,
  GenerateInitiatorMandateNotificationRequestBody,
  GeneratePayerMandateNotificationRequestBody,
  GenerateRapainRequestBody,
  GenerateRapRequestBody,
  GenerateUpdateHoldTransactionRequestBody,
  UtilitiesService,
} from './service.js'

/**
 * Triggers the Initiator mock accepts beyond its spec enum: docs:payto-staging-testing-suite sends PCRD
 * ("Payer mandate create declined") to it (00-webhook-matrix C14). The schema would refuse it, so the hook
 * swaps in a listed value before validation and the handler restores the original.
 */
const EXTRA_INITIATOR_TRIGGERS: ReadonlySet<string> = new Set(['PCRD'])
const PLACEHOLDER_TRIGGER = 'MCRD'

export function registerRoutes(app: FastifyInstance, ctx: AppContext, svc: UtilitiesService): void {
  const extraTrigger = new WeakMap<FastifyRequest, MandateTrigger>()
  app.addHook('preValidation', async (req) => {
    if ((req.routeOptions.config as { operationId?: string } | undefined)?.operationId !== 'generateMandateNotificationForInitiator') return
    const body = req.body as Record<string, unknown> | null | undefined
    if (!body || typeof body !== 'object' || typeof body.trigger !== 'string' || !EXTRA_INITIATOR_TRIGGERS.has(body.trigger)) return
    extraTrigger.set(req, body.trigger as MandateTrigger)
    body.trigger = PLACEHOLDER_TRIGGER
  })

  // ---------------------------------------------------------------- card mocks

  defineRoute<never, never, GenerateCardTransactionRequestBody>(app, ctx, 'generateAtmTransaction', (req) => svc.atm(req.body))
  defineRoute<never, never, GenerateCardHoldTransactionRequestBody>(app, ctx, 'generateAuthHold', (req) => svc.authHold(req.body))
  defineRoute<never, never, GenerateCardHoldAndSettleTransactionRequestBody>(app, ctx, 'generateCardTransaction', (req) => svc.holdAndSettle(req.body))
  defineRoute<never, never, GenerateUpdateHoldTransactionRequestBody>(app, ctx, 'generateHoldAndUpdateHoldTransactions', (req) => svc.holdAndUpdate(req.body))
  defineRoute<never, never, GenerateCardTransactionRequestBody>(app, ctx, 'generateRefundTransaction', (req) => svc.refund(req.body))
  defineRoute<{ cardId: string }, never, ChangeCardExpiryDateRequestBody>(app, ctx, 'changeCardExpiryDate', (req) => svc.changeExpiryDate(req.params.cardId, req.body))

  // ---------------------------------------------------------------- inbound NPP / DE

  defineRoute<never, never, GenerateInboundNppTransactionRequestBody>(app, ctx, 'generateInboundNppTransaction', async (req, reply) => {
    const r = await withIdempotency(ctx, 'generateInboundNppTransaction', req.body.idempotencyKey, req.body, () => ({ status: 200, body: svc.inboundNpp(req.body) }))
    reply.code(r.status)
    return r.body
  })
  defineRoute<never, never, GenerateRapRequestBody>(app, ctx, 'generateInboundNppTransactionV2', (req) => svc.receivePayment(req.body))
  defineRoute<never, never, GenerateInboundDeRequestBody>(app, ctx, 'generateInboundDeTransaction', async (req, reply) => {
    const r = await withIdempotency(ctx, 'generateInboundDeTransaction', req.body.idempotencyKey, req.body, () => ({ status: 200, body: svc.inboundDe(req.body) }))
    reply.code(r.status)
    return r.body
  })

  // ---------------------------------------------------------------- PayTo

  // the generated TS types keep the spec's comma-joined enum literal; the runtime schema has the split values
  defineRoute<never, never, GenerateInitiatorMandateNotificationRequestBody>(app, ctx, 'generateMandateNotificationForInitiator', (req) =>
    svc.mandateNotification('INITIATOR', extraTrigger.get(req) ?? (req.body.trigger as string as MandateTrigger), req.body))
  defineRoute<never, never, GeneratePayerMandateNotificationRequestBody>(app, ctx, 'generateMandateNotificationForPayer', (req) =>
    svc.mandateNotification('PAYER', req.body.trigger as string as MandateTrigger, req.body))
  defineRoute<never, never, GenerateRapainRequestBody>(app, ctx, 'generateReceiveAPaymentInstruction', (req) => svc.receivePaymentInstruction(req.body))
  defineRoute<never, never, CreateStubForMandateSearchPaymentInstructionsRequestBody>(app, ctx, 'createStubForMandateSearchPaymentInstructions', (req) => {
    svc.stubSearchInstructions(req.body)
    // the contract declares a 200 without content
    return undefined
  })
}
