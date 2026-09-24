/**
 * The "Transactions API" and "Holds API" operations plus getPendingHolds and makeTransferV0/V1 from
 * the Accounts API. Input arrives validated against the spec schemas; responses are serialized
 * through the success schema by defineRoute().
 */
import type { FastifyInstance } from 'fastify'
import { defineRoute } from '../../contract/route.js'
import type { AppContext } from '../../context.js'
import { withIdempotency } from '../../lib/idempotency.js'
import type { SortBy } from './repo.js'
import { validateTagsBody, type CreateTransactionRequestBody, type ModifyTagsRequestBody, type SearchTransactionsRequestBody, type TransactionsService, type TransferOutRequestBody } from './service.js'

type ByTransaction = { transactionHayId: string }
type ByHold = { holdId: string }
type ByAccount = { accountId: string }
type SearchQuery = { limit: number; offset: number; sortBy?: SortBy }

export function registerRoutes(app: FastifyInstance, ctx: AppContext, svc: TransactionsService): void {
  // The spec's own 400 text for modifyTagsForTransaction must win over the schema validator's message,
  // so the body is checked before validation (scoped to this operation through the route config).
  app.addHook('preValidation', async (req) => {
    if ((req.routeOptions.config as { operationId?: string }).operationId === 'modifyTagsForTransaction') validateTagsBody(req.body)
  })

  const create = (operationId: string, direction: 'CREDIT' | 'DEBIT', legacy: boolean): void => {
    defineRoute<never, never, CreateTransactionRequestBody>(app, ctx, operationId, async (req) => {
      const b = req.body
      const r = await withIdempotency(ctx, operationId, b.idempotencyKey, b, () => ({ status: 200, body: svc.createGeneral(direction, b, { legacy }) }))
      return r.body
    })
  }
  create('createCreditTransactionV1', 'CREDIT', false)
  create('createDebitTransactionV1', 'DEBIT', false)
  create('createCreditTransactionV0', 'CREDIT', true)
  create('createDebitTransactionV0', 'DEBIT', true)

  // makeTransferV0 is served exactly like V1: its spec description only says "Please use v1 instead"
  // (the REFUSED_LIMIT_BREACH collapse is documented on the v0 create ops alone).
  const transfer = (operationId: string): void => {
    defineRoute<ByAccount, never, TransferOutRequestBody>(app, ctx, operationId, async (req) => {
      const b = req.body
      const r = await withIdempotency(ctx, operationId, b.idempotencyKey, b, () => ({ status: 200, body: svc.transfer(req.params.accountId, b, { actionOwner: 'CLIENT' }) }))
      return r.body
    })
  }
  transfer('makeTransferV1')
  transfer('makeTransferV0')

  defineRoute<never, SearchQuery, SearchTransactionsRequestBody>(app, ctx, 'searchTransactions', (req) =>
    svc.search(req.body, { limit: req.query.limit, offset: req.query.offset, sortBy: req.query.sortBy }))

  defineRoute<ByTransaction>(app, ctx, 'getTransactionById', (req) => svc.toResponse(svc.get(req.params.transactionHayId)))

  defineRoute<ByTransaction>(app, ctx, 'getTagsForTransaction', (req) => svc.listTags(req.params.transactionHayId))

  defineRoute<ByTransaction, never, ModifyTagsRequestBody>(app, ctx, 'modifyTagsForTransaction', (req) => svc.modifyTags(req.params.transactionHayId, req.body))

  defineRoute<ByHold>(app, ctx, 'getAuthorisationHold', (req) => svc.holds.toResponse(svc.holds.get(req.params.holdId)))

  defineRoute<ByAccount>(app, ctx, 'getPendingHolds', (req) => svc.holds.listOpen(req.params.accountId).map((h) => svc.holds.toResponse(h)))
}
