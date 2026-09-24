/**
 * The "Direct Debits API", "Direct Entry API" and "Scheduled Payments API" operations, plus the
 * test-control route POST /_admin/scheduled-payments (schedules are portal-only on Shaype).
 */
import type { FastifyInstance } from 'fastify'
import { defineRoute } from '../../contract/route.js'
import type { AppContext } from '../../context.js'
import { ApiError } from '../../lib/errors.js'
import { withIdempotency } from '../../lib/idempotency.js'
import type { DeStatus, DeStatusV0 } from './repo.js'
import type { CreateScheduleInput } from './schedules.js'
import { v0FilterStatuses, type CreateDirectDebitRequestBody, type DirectDebitResponse, type DirectDebitResponseV1, type DirectEntryService } from './service.js'

type ByAccount = { accountId: string }
type BySchedule = { accountId: string; paymentId: string }
type ByTransaction = { transactionId: string }
type ListQueryV1 = { fromUtc: string; toUtc: string; offset: number; limit: number; status?: DeStatus; senderAccountNumber?: string }
type ListQueryV0 = { fromUtc: string; toUtc: string; offset: number; limit: number; status?: DeStatusV0 }

/** Every request-level 422 of the deprecated v0 create is answered with the declared DirectDebitResponse body. */
function v0Rejection(transactionId: string, err: unknown): unknown {
  if (err instanceof ApiError && err.status === 422 && err.body === undefined) {
    const body: DirectDebitResponse = { transactionId, outcome: 'REJECTED', details: err.message }
    return new ApiError(422, err.message, body)
  }
  return err
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext, svc: DirectEntryService): void {
  // ---------------------------------------------------------------- Direct Debits API

  defineRoute<never, never, CreateDirectDebitRequestBody>(app, ctx, 'createDirectDebitV1', async (req) => {
    const b = req.body
    const r = await withIdempotency<DirectDebitResponseV1 | DirectDebitResponse>(ctx, 'createDirectDebitV1', b.idempotencyKey, b, () => svc.create(b, { version: 'v1' }))
    return r.body
  })

  defineRoute<never, never, CreateDirectDebitRequestBody>(app, ctx, 'createDirectDebitV0', async (req, reply) => {
    const b = req.body
    try {
      const r = await withIdempotency<DirectDebitResponseV1 | DirectDebitResponse>(ctx, 'createDirectDebitV0', b.idempotencyKey, b, () => svc.create(b, { version: 'v0' }))
      reply.code(r.status)
      return r.body
    } catch (err) {
      throw v0Rejection(b.transactionId, err)
    }
  })

  defineRoute<ByTransaction>(app, ctx, 'getDirectDebitV1', (req) => svc.responseV1(svc.get(req.params.transactionId)))
  defineRoute<ByTransaction>(app, ctx, 'getDirectDebitV0', (req) => svc.responseV0(svc.get(req.params.transactionId)))

  defineRoute<never, ListQueryV1>(app, ctx, 'getDirectDebitsV1', (req) => {
    const q = req.query
    return svc.list(q, q.status ? [q.status] : undefined).map((r) => svc.detailsV1(r))
  })
  defineRoute<never, ListQueryV0>(app, ctx, 'getDirectDebitsV0', (req) => {
    const q = req.query
    return svc.list({ fromUtc: q.fromUtc, toUtc: q.toUtc, offset: q.offset, limit: q.limit }, q.status ? v0FilterStatuses(q.status) : undefined).map((r) => svc.detailsV0(r))
  })

  // ---------------------------------------------------------------- Direct Entry API

  defineRoute<ByTransaction>(app, ctx, 'getDirectEntryStatusV1', (req) => svc.statusResponse(svc.get(req.params.transactionId)))

  // ---------------------------------------------------------------- Scheduled Payments API

  defineRoute<ByAccount>(app, ctx, 'getScheduledPayments', (req) => svc.schedules.listForAccount(req.params.accountId).map((s) => svc.schedules.toResponse(s)))
  defineRoute<BySchedule>(app, ctx, 'getScheduledPaymentById', (req) => svc.schedules.toResponse(svc.schedules.get(req.params.accountId, req.params.paymentId)))
  defineRoute<BySchedule>(app, ctx, 'cancelScheduledPayment', (req) => {
    svc.schedules.cancel(req.params.accountId, req.params.paymentId, { actionOwner: 'CLIENT' })
    return { message: 'Cancel Scheduled Payment successful.' }
  })

  /**
   * Test-control stand-in for the portal's createScheduledPayment / updateSchedulePayment mutations (spec §5.8).
   * Body (CreateScheduleInput): { accountId, customerHayId?, amount, currency?, description?, reference?,
   * type?: RECURRING | ONE_TIME, frequency?: WEEKLY | FORTNIGHTLY | MONTHLY | QUARTERLY, startDate, endDate?,
   * numberOfPayments?, shouldCancelOnFailure?, recipient: { recipientType: ACCOUNT | BPAY, recipientName?,
   * recipientAccountNumber?: { branchNumber, accountNumber }, bpayDetails?: { billerCode, billerReference, ... } },
   * replaces?: <hayId of an ACTIVE schedule to update in place> }. Answers 201 with the HayScheduledPayment
   * body (200 when `replaces` updated an existing schedule) and emits SCHEDULED_PAYMENT on creation.
   */
  app.post<{ Body: CreateScheduleInput }>('/_admin/scheduled-payments', {
    schema: {
      body: {
        type: 'object',
        required: ['accountId', 'amount', 'startDate', 'recipient'],
        properties: {
          accountId: { type: 'string' },
          customerHayId: { type: 'string' },
          amount: { type: 'number' },
          currency: { type: 'string' },
          description: { type: 'string' },
          reference: { type: 'string' },
          type: { type: 'string' },
          frequency: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          numberOfPayments: { type: 'integer' },
          shouldCancelOnFailure: { type: 'boolean' },
          recipient: { type: 'object' },
          replaces: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const s = svc.schedules.create(req.body)
    reply.code(req.body.replaces !== undefined ? 200 : 201)
    return svc.schedules.toResponse(s)
  })
}
