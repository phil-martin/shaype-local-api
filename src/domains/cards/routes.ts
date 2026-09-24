/**
 * The 19 "Cards API" operations. Input arrives validated against the spec schemas (optional bodies —
 * blockCard, convertCard — are checked here); the response is serialized through the success schema by
 * defineRoute().
 */
import type { FastifyInstance } from 'fastify'
import type { components } from '../../contract/generated/b2b-types.js'
import { defineRoute } from '../../contract/route.js'
import type { AppContext } from '../../context.js'
import { badRequest } from '../../lib/errors.js'
import { withIdempotency } from '../../lib/idempotency.js'
import type { CardsService } from './service.js'

type S = components['schemas']
type ById = { cardId: string }

const ok = (message: string) => ({ message })

export function registerRoutes(app: FastifyInstance, ctx: AppContext, svc: CardsService): void {
  defineRoute<never, never, S['CreateHayCardRequestBody']>(app, ctx, 'createHayCard', async (req) => {
    const b = req.body
    const r = await withIdempotency(ctx, 'createHayCard', b.idempotencyKey, b, () => ({
      status: 200,
      body: svc.create({
        accountId: b.accountId,
        customerHayId: b.customerHayId,
        firstName: b.firstName,
        lastName: b.lastName,
        email: b.email,
        phoneNumber: b.phoneNumber,
        deliveryAddress: b.deliveryAddress,
        pin: b.pin,
        cardType: b.cardType,
        cardSubDesign: b.cardSubDesign,
        deliveryMethod: b.deliveryMethod,
        nameOnCard: b.nameOnCard,
        nameOnCardLine2: b.nameOnCardLine2,
        title: b.title,
      }, { actionOwner: 'CLIENT' }),
    }))
    return r.body
  })

  defineRoute<ById>(app, ctx, 'getCard', (req) => svc.toResponse(svc.get(req.params.cardId)))

  defineRoute<ById>(app, ctx, 'activateCard', (req) => {
    svc.activate(req.params.cardId)
    return ok('Activate Card successful.')
  })

  defineRoute<ById, never, S['BlockCardRequestBody'] | undefined>(app, ctx, 'blockCard', (req) => {
    const b = optionalBody(req.body)
    if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') throw badRequest('BAD_REQUEST: body/note must be string')
    svc.block(req.params.cardId, { note: b.note })
    return ok('Block Card successful.')
  })

  defineRoute<ById, never, S['UnblockCardRequestBody']>(app, ctx, 'unblockCard', (req) => {
    svc.unblock(req.params.cardId, { note: req.body.note })
    return ok('Unblock Card successful.')
  })

  defineRoute<ById>(app, ctx, 'cancelCard', (req) => {
    svc.cancel(req.params.cardId)
    return ok('Cancel Card successful.')
  })

  defineRoute<ById, never, S['ConvertCardRequestBody'] | undefined>(app, ctx, 'convertCard', (req) => {
    const b = optionalBody(req.body)
    const address = b.deliveryAddress
    if (address !== undefined && address !== null) {
      if (typeof address !== 'object' || typeof address.line1 !== 'string' || typeof address.countryCodeIso !== 'string' || address.countryCodeIso.length !== 3) {
        throw badRequest('BAD_REQUEST: body/deliveryAddress must have line1 and a three-letter countryCodeIso')
      }
    }
    return svc.toResponse(svc.convert(req.params.cardId, { deliveryAddress: address }))
  })

  defineRoute<ById>(app, ctx, 'getCardCvvStatus', (req) => svc.cvvStatus(req.params.cardId))

  defineRoute<ById>(app, ctx, 'unblockCardCvv', (req) => {
    svc.unblockCvv(req.params.cardId)
    return ok('Unblock Card CVV successful.')
  })

  defineRoute<ById>(app, ctx, 'getDigitalWalletDetails', (req) => svc.wallets(req.params.cardId))

  defineRoute<ById>(app, ctx, 'getOemProvisioningData', (req) => svc.oemProvisioningData(req.params.cardId))

  defineRoute<ById>(app, ctx, 'getPaymentPreferences', (req) => svc.preferences(req.params.cardId))

  defineRoute<ById, never, S['UpdatePaymentPreferencesRequestBody']>(app, ctx, 'updatePaymentPreferences', (req) =>
    svc.updatePreferences(req.params.cardId, req.body))

  defineRoute<ById, never, S['ChangeCardPinRequestBody']>(app, ctx, 'changeCardPin', (req) => {
    svc.changePin(req.params.cardId, req.body.newPin)
    return ok('Change Card PIN successful.')
  })

  defineRoute<ById>(app, ctx, 'getCardPinStatus', (req) => svc.pinStatus(req.params.cardId))

  defineRoute<ById>(app, ctx, 'unblockCardPin', (req) => {
    svc.unblockPin(req.params.cardId)
    return ok('Unblock Card PIN successful.')
  })

  defineRoute<ById, never, S['ReissueHayCardRequestBody']>(app, ctx, 'reissueHayCard', async (req) => {
    const b = req.body
    const r = await withIdempotency(ctx, 'reissueHayCard', b.idempotencyKey, { cardId: req.params.cardId, ...b }, () => ({
      status: 200,
      body: svc.toResponse(svc.reissue(req.params.cardId, { cardType: b.cardType, deliveryAddress: b.deliveryAddress, deliveryMethod: b.deliveryMethod })),
    }))
    return r.body
  })

  defineRoute<ById, never, S['RenewCardRequestBody']>(app, ctx, 'renewCard', (req) => {
    const b = req.body
    return svc.toResponse(svc.renew(req.params.cardId, { cardType: b.cardType, deliveryAddress: b.deliveryAddress, deliveryMethod: b.deliveryMethod }))
  })

  defineRoute<ById, never, S['CardRewardsStatusBody']>(app, ctx, 'rewards', (req, reply) => {
    if (req.body.status !== 'ACTIVE') throw badRequest('BAD_REQUEST: body/status must be ACTIVE')
    const created = svc.enrolRewards(req.params.cardId)
    reply.code(created ? 201 : 200)
    return { status: 'ACTIVE' }
  })
}

/** Optional request bodies are not validated at the route level: an absent body is {}; anything but an object is 400. */
function optionalBody<T extends object>(body: T | undefined | null): Partial<T> {
  if (body === undefined || body === null) return {}
  if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('BAD_REQUEST: body must be object')
  return body
}
