import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '../src/contract/generated/b2b-types.js'
import { startApp } from './helpers.js'
import { assertValidNotification } from './webhook-schema.js'
import type { BuiltServer } from '../src/server.js'
import { LOCAL_PRODUCT_ID } from '../src/domains/accounts/index.js'
import { LOCAL_BSB } from '../src/lib/ids.js'
import { ACCOUNT_DETAILS_INCORRECT, BIC, mmsId, normaliseMandateId, stepDate, type PayToService } from '../src/domains/payto/index.js'
import type { PaymentInstructionSummary } from '../src/domains/payto/service.js'

type S = components['schemas']
type HayAccount = S['HayAccount']
type CreateMandateBody = S['CreateMandateRequestBody']
type GetMandate = S['GetMandateResponseBody']
type ActionDto = S['GetMandateActionsActionDto']
type AdhocResponse = S['MakeAdhocPaymentResponseBody']

const PAYTO_OPS = [
  'getMandateIdsByInitiator', 'createMandate', 'amendMandateByInitiator', 'getMandateActionsByInitiator', 'cancelMandateByInitiator',
  'getMandatePaymentStatus', 'amendMandatePaymentTerms', 'setScheduledPaymentInitiationRequestAmount', 'releaseMandateByInitiator',
  'resolveMandateByInitiator', 'searchPaymentsInstructions', 'suspendMandateByInitiator', 'getMandates', 'getMandate', 'amendMandateByPayer',
  'getMandateActionsByPayer', 'cancelMandateByPayer', 'releaseMandateByPayer', 'resolveMandateByPayer', 'suspendMandateByPayer',
  'makeAdhocPayment', 'checkBsbIsSupportedByPayTo',
]
const UNKNOWN_ID = '11111111-1111-1111-8111-111111111111'
const UUID_V1_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-1[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ISO_MICROS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const INSTRUCTION_RE = /^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}I[0-9]{8}00[0-9]{12}[0-9a-zA-Z]$/
const EXTERNAL_DEBTOR = '08201612345678'
const DAY_MS = 24 * 60 * 60 * 1000
const AUD = (amount: number) => ({ currency: 'AUD' as const, amount })

let built: BuiltServer
let app: BuiltServer['app']
let svc: PayToService
beforeAll(async () => { built = await startApp(); app = built.app; svc = built.ctx.services.payto })
afterAll(async () => { await built.app.close() })

// ---------------------------------------------------------------- helpers

let n = 0
async function flush(): Promise<void> {
  await app.inject({ method: 'POST', url: '/_admin/flush' })
}
async function advanceClock(ms: number): Promise<void> {
  await app.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: ms } })
}
async function today(): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/_admin/clock' })
  return (res.json().now as string).slice(0, 10)
}
function plusDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10)
}
async function newCustomer(): Promise<string> {
  n++
  const res = await app.inject({
    method: 'POST', url: '/v0/customers/create',
    payload: {
      idempotencyKey: randomUUID(), email: `payto${n}@example.com`, customerTier: 'STANDARD',
      phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: `7${String(n).padStart(8, '0')}` },
      address: { line1: '1 Test St', townOrCity: 'Sydney', administrativeRegion: 'NSW', postcode: '2000', countryCodeIso: 'AUS' },
      customerDetails: { firstName: 'Mandate', lastName: `Holder${n}`, dateOfBirth: '1990-01-01' },
    },
  })
  expect(res.statusCode, res.body).toBe(200)
  await flush()
  return res.json().customerHayId as string
}
/** A LOW-risk account (limits open) unless `risk: 'HIGH'`, credited with `fund` when given (so it is ACTIVE). */
async function newAccount(opts: { holder?: string; risk?: 'LOW' | 'HIGH'; fund?: number } = {}): Promise<HayAccount> {
  const holder = opts.holder ?? (await newCustomer())
  const res = await app.inject({ method: 'POST', url: '/v1/accounts', payload: { idempotencyKey: randomUUID(), accountHolderId: holder, accountHolderType: 'CUSTOMER', productId: LOCAL_PRODUCT_ID } })
  expect(res.statusCode, res.body).toBe(200)
  const a = res.json() as HayAccount
  if (opts.risk !== 'HIGH') {
    const r = await app.inject({ method: 'PATCH', url: `/v0/accounts/${a.accountHayId}/riskLevel`, payload: { level: 'LOW', reason: 'test' } })
    expect(r.statusCode, r.body).toBe(200)
  }
  if (opts.fund) {
    const c = await app.inject({ method: 'POST', url: '/v1/transactions/credit', payload: { idempotencyKey: randomUUID(), accountHayId: a.accountHayId, amount: opts.fund, counterpartName: 'Payroll', description: 'fund', transactionChannel: 'MANUAL_ADJUSTMENT' } })
    expect(c.statusCode, c.body).toBe(200)
    expect(c.json().outcome).toBe('ACCEPTED')
  }
  await flush()
  return getAccount(a.accountHayId!)
}
async function getAccount(id: string): Promise<HayAccount> {
  const res = await app.inject({ method: 'GET', url: `/v0/accounts/${id}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as HayAccount
}
function mandateBody(creditor: HayAccount, debtor: Partial<CreateMandateBody['debtorDetails']>, overrides: Partial<CreateMandateBody> = {}): CreateMandateBody {
  return {
    idempotencyKey: randomUUID(),
    creditorDetails: { accountId: creditor.accountHayId!, partyReference: 'NET-1724', partyType: 'ORGANISATION', ultimatePartyName: 'ACME Utilities' },
    debtorDetails: { partyName: 'JOHN MAXIMILLIAN DOE', partyType: 'PERSON', ...debtor },
    description: 'Electricity',
    paymentTerms: { frequency: 'ADHOC', type: 'VARIABLE', maximumAmount: AUD(900) },
    purposeCode: 'UTILITY',
    validityStartDate: '2020-10-06',
    ...overrides,
  }
}
async function createMandate(creditor: HayAccount, debtor: Partial<CreateMandateBody['debtorDetails']>, overrides: Partial<CreateMandateBody> = {}): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: mandateBody(creditor, debtor, overrides) })
  expect(res.statusCode, res.body).toBe(200)
  await flush()
  return res.json().mandateId as string
}
async function getMandate(id: string): Promise<GetMandate> {
  const res = await app.inject({ method: 'GET', url: `/v1/payto/mandates/${id}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as GetMandate
}
async function actions(id: string, side: 'initiator' | 'payer' = 'initiator', query = ''): Promise<ActionDto[]> {
  const res = await app.inject({ method: 'GET', url: `/v1/payto/${side}/mandates/${id}/actions${query}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json().actions as ActionDto[]
}
async function patch(url: string, payload?: object) {
  return app.inject({ method: 'PATCH', url, payload })
}
/** A CREATED mandate between two local LOW-risk accounts, then accepted by the Payer -> ACTIVE. */
async function activeMandate(opts: { creditor?: HayAccount; debtor?: HayAccount; terms?: CreateMandateBody['paymentTerms']; overrides?: Partial<CreateMandateBody> } = {}): Promise<{ id: string; creditor: HayAccount; debtor: HayAccount }> {
  const creditor = opts.creditor ?? (await newAccount())
  const debtor = opts.debtor ?? (await newAccount())
  const id = await createMandate(creditor, { accountId: debtor.accountHayId! }, { ...(opts.terms ? { paymentTerms: opts.terms } : {}), ...(opts.overrides ?? {}) })
  const res = await patch(`/v1/payto/payer/mandates/${id}/resolve?resolution=ACCEPT`)
  expect(res.statusCode, res.body).toBe(200)
  await flush()
  return { id, creditor, debtor }
}
async function allPayloads(): Promise<any[]> {
  await flush()
  const res = await app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })
  return (res.json() as { payload: any }[]).map((r) => r.payload)
}
async function clearNotifications(): Promise<void> {
  await flush()
  await app.inject({ method: 'DELETE', url: '/_admin/notifications' })
}
async function mandateEvents(mandateId: string): Promise<any[]> {
  return (await allPayloads()).filter((p) => p.type === 'MANDATE' && p.mandateEventDto?.mandateId === mandateId)
}
async function paymentEvents(mandateId: string): Promise<any[]> {
  return (await allPayloads()).filter((p) => p.type === 'MANDATE_PAYMENT' && p.mandatePaymentEventDto?.mandateId === mandateId)
}
async function adhoc(mandateId: string, overrides: Partial<S['MakeAdhocPaymentRequestBody']> = {}): Promise<AdhocResponse> {
  const res = await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId, amount: AUD(12.5), endToEndId: 'INV-1', description: 'Bill', ...overrides } })
  expect(res.statusCode, res.body).toBe(200)
  await flush()
  return res.json() as AdhocResponse
}

// ---------------------------------------------------------------- registration and lookups

describe('payto domain: registration', () => {
  it('handles every PayTo API operation (none left on the stub)', async () => {
    const res = await app.inject({ method: 'GET', url: '/_admin/operations' })
    const { handled, stubbed } = res.json() as { handled: string[]; stubbed: string[] }
    expect(PAYTO_OPS).toHaveLength(22)
    for (const op of PAYTO_OPS) {
      expect(handled, op).toContain(op)
      expect(stubbed, op).not.toContain(op)
    }
  })
})

describe('checkBsbIsSupportedByPayTo', () => {
  it('supports every 6-digit BSB except 000000 and 999999; other shapes are 400', async () => {
    for (const [bsb, supported] of [[LOCAL_BSB, true], ['082016', true], ['000000', false], ['999999', false]] as const) {
      const res = await app.inject({ method: 'GET', url: `/v1/payto/supported-bsbs/${bsb}` })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({ supported })
    }
    const bad = await app.inject({ method: 'GET', url: '/v1/payto/supported-bsbs/12345' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().message).toMatch(/^BAD_REQUEST:/)
  })
})

describe('mandate ids', () => {
  it('accepts both encodings at the service and serves the hyphenated v1 layout', async () => {
    const creditor = await newAccount()
    const id = await createMandate(creditor, { accountNumber: EXTERNAL_DEBTOR })
    expect(id).toMatch(UUID_V1_RE)
    expect(mmsId(id)).toMatch(/^[a-f0-9]{12}1[a-f0-9]{3}[89ab][a-f0-9]{15}$/)
    expect(normaliseMandateId(mmsId(id).toUpperCase())).toBe(id)
    expect(svc.get(mmsId(id)).id).toBe(id)
    expect(svc.get(id.toUpperCase()).id).toBe(id)
    // the contract validates `format: uuid` path params before any handler runs
    const res = await app.inject({ method: 'GET', url: `/v1/payto/mandates/${mmsId(id)}` })
    expect(res.statusCode).toBe(400)
    const missing = await app.inject({ method: 'GET', url: `/v1/payto/mandates/${UNKNOWN_ID}` })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().message).toBe(`NOT_FOUND: Mandate ${UNKNOWN_ID} not found`)
  })
})

// ---------------------------------------------------------------- createMandate

describe('createMandate', () => {
  it('creates a CREATED mandate with a pending bilateral CREATE action and notifies a local Payer with MCRT', async () => {
    await clearNotifications()
    const creditor = await newAccount()
    const debtor = await newAccount()
    const body = mandateBody(creditor, { accountId: debtor.accountHayId! }, { validityEndDate: '2030-12-31', transferArrangement: 'Transfer arrangement test', resolutionRequestedBy: '2030-09-10T10:00:00.000Z' })
    const res = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: body })
    expect(res.statusCode, res.body).toBe(200)
    const { mandateId } = res.json() as { mandateId: string }
    expect(mandateId).toMatch(UUID_V1_RE)

    const m = await getMandate(mandateId)
    expect(m).toEqual({
      mandateId,
      creditorDetails: { accountId: creditor.accountHayId, partyReference: 'NET-1724', partyType: 'ORGANISATION', ultimatePartyName: 'ACME Utilities' },
      debtorDetails: { accountId: debtor.accountHayId, accountNumber: `${LOCAL_BSB}${debtor.accountNumber}`, partyName: 'JOHN MAXIMILLIAN DOE', partyType: 'PERSON' },
      description: 'Electricity',
      paymentTerms: { frequency: 'ADHOC', type: 'VARIABLE', maximumAmount: AUD(900) },
      purposeCode: 'UTILITY',
      registrationDateTime: expect.stringMatching(ISO_MICROS_RE),
      status: 'CREATED',
      transferArrangement: 'Transfer arrangement test',
      validityEndDate: '2030-12-31',
      validityStartDate: '2020-10-06',
    })

    const [create] = await actions(mandateId)
    expect(create).toMatchObject({
      actionIdentification: expect.stringMatching(UUID_V1_RE),
      mandateIdentification: mandateId,
      type: 'CREATE',
      status: 'PENDING',
      bilateral: true,
      notificationPriority: 'NORMAL',
      creationEvent: { partyRole: 'PAYMENT_INITIATOR', servicerBic: BIC, sponsorBic: BIC, time: expect.stringMatching(ISO_MS_RE) },
      expiryTime: expect.stringMatching(ISO_MS_RE),
      resolutionRequestedBy: '2030-09-10T10:00:00.000Z',
      cxEventNameCreation: 'Payment agreement received',
      details: {
        creation: {
          automaticExtensionIndicator: false,
          establishmentScheme: 'AUTHORISED_PAYMENT_MANDATE',
          mandateType: 'DIRECT_DEBIT',
          mandatePurposeCode: 'UTILITY',
          validityStartDate: '2020-10-06',
          validityEndDate: '2030-12-31',
          debtorInformation: { accountId: debtor.accountHayId, accountNumber: `${LOCAL_BSB}${debtor.accountNumber}`, accountIdentificationTypeCode: 'BASIC_BANK_ACCOUNT_NUMBER', partyName: 'JOHN MAXIMILLIAN DOE', partyType: 'PERSON' },
          creditorInformation: { accountId: creditor.accountHayId, partyName: 'ACME Utilities', partyReference: 'NET-1724', ultimatePartyName: 'ACME Utilities' },
          paymentInformation: { maximumAmount: { amount: '900.00', currency: 'AUD' }, paymentAmountType: 'VARIABLE', paymentFrequency: 'ADHOC' },
          paymentInitiatorInformation: { partyLegalName: 'ACME Utilities', partyName: 'ACME Utilities', partyServicerBic: BIC },
        },
      },
    })
    expect(create!.resolutionEvent).toBeUndefined()
    expect(new Date(create!.expiryTime!).getTime() - new Date(create!.creationEvent.time).getTime()).toBe(6 * DAY_MS)

    const events = await mandateEvents(mandateId)
    expect(events).toEqual([
      { customerHayId: debtor.accountHolderId, idempotencyKey: expect.any(String), type: 'MANDATE', actionOwner: 'CLIENT', mandateEventDto: { mandateId, actionId: create!.actionIdentification, description: 'Mandate created', trigger: 'MCRT' } },
    ])
    assertValidNotification(events[0], 'v0')

    // the initiator sees it under the creditor account
    const ids = await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates?creditorAccountId=${creditor.accountHayId}` })
    expect(ids.json()).toEqual([mandateId])
  })

  it('replays the same idempotencyKey and refuses it with a different body', async () => {
    const creditor = await newAccount()
    const body = mandateBody(creditor, { accountNumber: EXTERNAL_DEBTOR })
    const first = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: body })
    const again = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: body })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual(first.json())
    const other = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: { ...body, description: 'Gas' } })
    expect(other.statusCode).toBe(422)
    expect(other.json().message).toMatch(/^IDEMPOTENCY_KEY_REUSED:/)
    expect(svc.mandateIdsForCreditorAccount(creditor.accountHayId!)).toEqual([first.json().mandateId])
  })

  it('refuses an unknown or closed creditor account with the documented 422', async () => {
    const creditor = await newAccount()
    const res = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: mandateBody({ ...creditor, accountHayId: UNKNOWN_ID }, { accountNumber: EXTERNAL_DEBTOR }) })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ message: ACCOUNT_DETAILS_INCORRECT('Creditor'), status: '422', details: 'Please refer to the API documentation or contact Shaype for more info with the traceId.' })
    await app.inject({ method: 'POST', url: `/v0/accounts/${creditor.accountHayId}/close`, payload: { reason: 'CUSTOMER' } })
    await flush()
    const closed = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: mandateBody(creditor, { accountNumber: EXTERNAL_DEBTOR }) })
    expect(closed.statusCode).toBe(422)
    expect(closed.json().message).toBe(ACCOUNT_DETAILS_INCORRECT('Creditor'))
  })

  it('identifies the debtor by accountId, by a local or external BSB + account number, or by an alias', async () => {
    const creditor = await newAccount()
    const debtor = await newAccount()
    const byNumber = await getMandate(await createMandate(creditor, { accountNumber: `${LOCAL_BSB}${debtor.accountNumber}` }))
    expect(byNumber.debtorDetails).toMatchObject({ accountId: debtor.accountHayId, accountNumber: `${LOCAL_BSB}${debtor.accountNumber}` })
    const external = await getMandate(await createMandate(creditor, { accountNumber: EXTERNAL_DEBTOR }))
    expect(external.debtorDetails).toEqual({ accountNumber: EXTERNAL_DEBTOR, partyName: 'JOHN MAXIMILLIAN DOE', partyType: 'PERSON' })
    const alias = await getMandate(await createMandate(creditor, { accountAliasIdentification: 'john@example.com', accountAliasType: 'EMAIL_ADDRESS' }))
    expect(alias.debtorDetails).toEqual({ partyName: 'JOHN MAXIMILLIAN DOE', partyType: 'PERSON' })
    // an external Payer is never notified and cannot use the Payer-only operations
    expect(await mandateEvents(external.mandateId)).toEqual([])
    const payerOp = await patch(`/v1/payto/payer/mandates/${external.mandateId}/resolve?resolution=ACCEPT`)
    expect(payerOp.statusCode).toBe(403)
    expect(payerOp.json().message).toMatch(/^FORBIDDEN:/)
    const payerActions = await app.inject({ method: 'GET', url: `/v1/payto/payer/mandates/${external.mandateId}/actions` })
    expect(payerActions.statusCode).toBe(403)
  })

  it('validates the request beyond the schema', async () => {
    const creditor = await newAccount()
    const debtor = await newAccount()
    const cases: [object, number, RegExp][] = [
      [mandateBody(creditor, {}), 400, /debtorDetails must identify the debtor/],
      [mandateBody(creditor, { accountAliasIdentification: 'x' }), 400, /accountAliasIdentification and accountAliasType/],
      [mandateBody(creditor, { accountNumber: '99999912345678' }), 422, /^BSB_NOT_SUPPORTED: Debtor BSB 999999/],
      [mandateBody(creditor, { accountNumber: `${LOCAL_BSB}99999999` }), 422, new RegExp(`^${ACCOUNT_DETAILS_INCORRECT('Debtor').replace(/[()]/g, '\\$&')}`)],
      [mandateBody(creditor, { accountId: UNKNOWN_ID }), 422, /Debtor account details incorrect/],
      [mandateBody(creditor, { accountNumber: '0820161234567A' }), 400, /6-digit BSB followed by/],
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { paymentTerms: { frequency: 'ADHOC', type: 'VARIABLE', maximumAmount: { currency: 'USD', amount: 5 } } }), 422, /^INVALID_CURRENCY:/],
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { paymentTerms: { frequency: 'ADHOC', type: 'VARIABLE', maximumAmount: AUD(5.123) } }), 400, /at most 2 decimal places/],
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { paymentTerms: { frequency: 'ADHOC', type: 'VARIABLE', amount: AUD(0) } }), 400, /greater than 0/],
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { validityEndDate: '2020-10-05' }), 422, /validityEndDate must not precede/],
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { resolutionRequestedBy: 'tomorrow' }), 400, /resolutionRequestedBy/],
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { paymentTerms: { frequency: 'MONTHLY', type: 'FIXED', amount: AUD(5), firstPayment: { date: '2030-01-10' }, lastPayment: { date: '2029-01-10' } } }), 422, /lastPayment.date/],
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { paymentTerms: { frequency: 'MONTHLY', type: 'FIXED', amount: AUD(5), countPerPeriod: 'two' } }), 400, /countPerPeriod/],
      [{ ...mandateBody(creditor, { accountId: debtor.accountHayId! }), creditorDetails: { partyType: 'PERSON' } }, 400, /^BAD_REQUEST:/],
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { purposeCode: 'FUN' as never }), 400, /^BAD_REQUEST:/],
    ]
    for (const [payload, status, message] of cases) {
      const res = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload })
      expect(res.statusCode, res.body).toBe(status)
      expect(res.json().message, res.body).toMatch(message)
    }
  })

  it('getMandateIdsByInitiator lists every status in creation order and is 404 for an unknown account', async () => {
    const creditor = await newAccount()
    const a = await createMandate(creditor, { accountNumber: EXTERNAL_DEBTOR })
    const b = await createMandate(creditor, { accountNumber: EXTERNAL_DEBTOR })
    await patch(`/v1/payto/initiator/mandates/${a}/resolve`)
    const res = await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates?creditorAccountId=${creditor.accountHayId}` })
    expect(res.json()).toEqual([a, b])
    const missing = await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates?creditorAccountId=${UNKNOWN_ID}` })
    expect(missing.statusCode).toBe(404)
    const noQuery = await app.inject({ method: 'GET', url: '/v1/payto/initiator/mandates' })
    expect(noQuery.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------- getMandates (Payer)

describe('getMandates', () => {
  it('pages the Payer\'s mandates by debtor BSB + account number with totalCount and a statuses filter', async () => {
    const creditor = await newAccount()
    const debtor = await newAccount()
    const other = await newAccount()
    const number = `${LOCAL_BSB}${debtor.accountNumber}`
    const ids = [await createMandate(creditor, { accountId: debtor.accountHayId! }), await createMandate(creditor, { accountNumber: number }), await createMandate(creditor, { accountId: debtor.accountHayId! })]
    await createMandate(creditor, { accountId: other.accountHayId! })
    await patch(`/v1/payto/payer/mandates/${ids[1]}/resolve?resolution=ACCEPT`)

    const page1 = await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${number}&pageNumber=1&pageSize=2` })
    expect(page1.statusCode, page1.body).toBe(200)
    expect(page1.json()).toEqual({
      totalCount: 3,
      result: [
        { debtorAccountId: debtor.accountHayId, description: 'Electricity', mandateId: ids[0], paymentTerms: { frequency: 'ADHOC', maximumAmount: AUD(900) }, purposeCode: 'UTILITY', status: 'CREATED' },
        { debtorAccountId: debtor.accountHayId, description: 'Electricity', mandateId: ids[1], paymentTerms: { frequency: 'ADHOC', maximumAmount: AUD(900) }, purposeCode: 'UTILITY', status: 'ACTIVE' },
      ],
    })
    const page2 = await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${number}&pageNumber=2&pageSize=2` })
    expect(page2.json()).toEqual({ totalCount: 3, result: [expect.objectContaining({ mandateId: ids[2] })] })
    const active = await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${number}&accountIds=${LOCAL_BSB}${other.accountNumber}&statuses=ACTIVE&pageNumber=1&pageSize=50` })
    expect(active.json()).toEqual({ totalCount: 1, result: [expect.objectContaining({ mandateId: ids[1] })] })
    const comma = await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${number},${LOCAL_BSB}${other.accountNumber}&pageNumber=1&pageSize=50` })
    expect(comma.json().totalCount).toBe(4)
    // external debtors are never the client's Payer side
    await createMandate(creditor, { accountNumber: EXTERNAL_DEBTOR })
    const external = await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${EXTERNAL_DEBTOR}&pageNumber=1&pageSize=50` })
    expect(external.json()).toEqual({ totalCount: 0, result: [] })
    for (const q of ['pageNumber=0&pageSize=10', 'pageNumber=1&pageSize=51', 'pageNumber=1', 'pageSize=10']) {
      const bad = await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${number}&${q}` })
      expect(bad.statusCode, q).toBe(400)
    }
  })
})

// ---------------------------------------------------------------- bilateral resolution

describe('resolveMandateByPayer / resolveMandateByInitiator', () => {
  it('ACCEPT activates the mandate, completes the CREATE action and notifies the Initiator with MCRC', async () => {
    await clearNotifications()
    const creditor = await newAccount()
    const debtor = await newAccount()
    const id = await createMandate(creditor, { accountId: debtor.accountHayId! })
    const res = await patch(`/v1/payto/payer/mandates/${id}/resolve?resolution=ACCEPT`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Mandate resolved successfully.' })
    expect((await getMandate(id)).status).toBe('ACTIVE')
    const [create] = await actions(id, 'payer')
    expect(create).toMatchObject({ type: 'CREATE', status: 'COMPLETED', resolutionEvent: { time: expect.stringMatching(ISO_MS_RE), servicerBic: BIC, sponsorBic: BIC }, cxEventNameResolution: 'Payment agreement authorised' })
    const events = await mandateEvents(id)
    expect(events.map((e) => [e.customerHayId, e.mandateEventDto.trigger, e.actionOwner])).toEqual([[debtor.accountHolderId, 'MCRT', 'CLIENT'], [creditor.accountHolderId, 'MCRC', 'CLIENT']])
    expect(events[1].mandateEventDto).toEqual({ mandateId: id, actionId: create!.actionIdentification, description: 'Mandate create confirmed', trigger: 'MCRC' })
    // nothing left to resolve
    const again = await patch(`/v1/payto/payer/mandates/${id}/resolve?resolution=ACCEPT`)
    expect(again.statusCode).toBe(422)
    expect(again.json().message).toMatch(/^INVALID_STATE: .* no pending action/)
    expect(await actions(id, 'initiator', '?pendingOnly=true')).toEqual([])
  })

  it('REJECT declines the CREATE action and cancels the mandate (MCRD)', async () => {
    const creditor = await newAccount()
    const debtor = await newAccount()
    const id = await createMandate(creditor, { accountId: debtor.accountHayId! })
    const res = await patch(`/v1/payto/payer/mandates/${id}/resolve?resolution=REJECT`)
    expect(res.statusCode, res.body).toBe(200)
    expect((await getMandate(id)).status).toBe('CANCELLED')
    expect(svc.get(id).cxStatus).toBe('CANCELLED')
    expect((await actions(id))[0]).toMatchObject({ type: 'CREATE', status: 'DECLINED', cxEventNameResolution: 'Payment agreement declined' })
    expect((await mandateEvents(id)).map((e) => [e.customerHayId, e.mandateEventDto.trigger])).toEqual([[debtor.accountHolderId, 'MCRT'], [creditor.accountHolderId, 'MCRD']])
    const missing = await patch(`/v1/payto/payer/mandates/${UNKNOWN_ID}/resolve?resolution=REJECT`)
    expect(missing.statusCode).toBe(404)
    const noResolution = await patch(`/v1/payto/payer/mandates/${id}/resolve`)
    expect(noResolution.statusCode).toBe(400)
    const badResolution = await patch(`/v1/payto/payer/mandates/${id}/resolve?resolution=MAYBE`)
    expect(badResolution.statusCode).toBe(400)
  })

  it('the Initiator recalls a pending CREATE: action RECALLED, mandate CANCELLED, MCRR to the Payer', async () => {
    const creditor = await newAccount()
    const debtor = await newAccount()
    const id = await createMandate(creditor, { accountId: debtor.accountHayId! })
    const res = await patch(`/v1/payto/initiator/mandates/${id}/resolve`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Mandate action recalled successfully.' })
    expect(svc.get(id)).toMatchObject({ status: 'CANCELLED', cxStatus: 'CANCELLED_BY_PAYMENT_INITIATOR' })
    expect((await actions(id))[0]).toMatchObject({ type: 'CREATE', status: 'RECALLED', cxEventNameResolution: 'Payment agreement recalled' })
    expect((await mandateEvents(id)).map((e) => [e.customerHayId, e.mandateEventDto.trigger])).toEqual([[debtor.accountHolderId, 'MCRT'], [debtor.accountHolderId, 'MCRR']])
    const again = await patch(`/v1/payto/initiator/mandates/${id}/resolve`)
    expect(again.statusCode).toBe(422)
    expect(again.json().message).toMatch(/no pending action to recall/)
  })
})

// ---------------------------------------------------------------- status machine

describe('suspend / release / cancel', () => {
  it('Initiator: ACTIVE -> SUSPENDED -> ACTIVE -> CANCELLED with STATUS_CHANGE actions and MSCH to both parties', async () => {
    await clearNotifications()
    const { id, creditor, debtor } = await activeMandate()
    const suspend = await patch(`/v1/payto/initiator/mandates/${id}/suspend`, { reasonCode: 'MD17', reasonDescription: 'Requested by initiating party' })
    expect(suspend.statusCode, suspend.body).toBe(200)
    expect(suspend.json()).toEqual({ message: 'Mandate suspended successfully.' })
    expect(svc.get(id)).toMatchObject({ status: 'SUSPENDED', cxStatus: 'PAUSED_BY_PAYMENT_INITIATOR', suspendedBy: 'INITIATOR' })
    const release = await patch(`/v1/payto/initiator/mandates/${id}/release`)
    expect(release.statusCode, release.body).toBe(200)
    expect(release.json()).toEqual({ message: 'Mandate released successfully.' })
    expect(svc.get(id)).toMatchObject({ status: 'ACTIVE', cxStatus: 'ACTIVE' })
    expect(svc.get(id).suspendedBy).toBeUndefined()
    const cancel = await patch(`/v1/payto/initiator/mandates/${id}/cancel`, { reasonCode: 'MD17' })
    expect(cancel.statusCode, cancel.body).toBe(200)
    expect(cancel.json()).toEqual({ message: 'Mandate cancelled successfully.' })
    expect(svc.get(id)).toMatchObject({ status: 'CANCELLED', cxStatus: 'CANCELLED_BY_PAYMENT_INITIATOR' })

    const acts = await actions(id)
    expect(acts.map((a) => [a.type, a.status, a.bilateral, a.creationEvent.partyRole, a.details?.statusChange])).toEqual([
      ['CREATE', 'COMPLETED', true, 'PAYMENT_INITIATOR', undefined],
      ['STATUS_CHANGE', 'COMPLETED', undefined, 'PAYMENT_INITIATOR', { change: 'SUSPEND', reasonCode: 'MD17', reasonDescription: 'Requested by initiating party' }],
      ['STATUS_CHANGE', 'COMPLETED', undefined, 'PAYMENT_INITIATOR', { change: 'RELEASE' }],
      ['STATUS_CHANGE', 'COMPLETED', undefined, 'PAYMENT_INITIATOR', { change: 'CANCEL', reasonCode: 'MD17' }],
    ])
    const events = await mandateEvents(id)
    expect(events.map((e) => [e.customerHayId, e.mandateEventDto.trigger, e.mandateEventDto.actionId])).toEqual([
      [debtor.accountHolderId, 'MCRT', acts[0]!.actionIdentification],
      [creditor.accountHolderId, 'MCRC', acts[0]!.actionIdentification],
      [creditor.accountHolderId, 'MSCH', acts[1]!.actionIdentification], [debtor.accountHolderId, 'MSCH', acts[1]!.actionIdentification],
      [creditor.accountHolderId, 'MSCH', acts[2]!.actionIdentification], [debtor.accountHolderId, 'MSCH', acts[2]!.actionIdentification],
      [creditor.accountHolderId, 'MSCH', acts[3]!.actionIdentification], [debtor.accountHolderId, 'MSCH', acts[3]!.actionIdentification],
    ])
    for (const e of events) assertValidNotification(e, 'v0')
    // terminal
    for (const op of ['suspend', 'cancel']) {
      const res = await patch(`/v1/payto/initiator/mandates/${id}/${op}`, {})
      expect(res.statusCode, op).toBe(422)
    }
    expect((await patch(`/v1/payto/initiator/mandates/${id}/release`)).statusCode).toBe(422)
  })

  it('refuses suspend when not ACTIVE and release when not SUSPENDED with the documented messages', async () => {
    const creditor = await newAccount()
    const debtor = await newAccount()
    const id = await createMandate(creditor, { accountId: debtor.accountHayId! })
    for (const side of ['initiator', 'payer']) {
      const suspend = await patch(`/v1/payto/${side}/mandates/${id}/suspend`, {})
      expect(suspend.statusCode, side).toBe(422)
      expect(suspend.json().message).toBe(`Validation of the request for suspension mandate with id: ${id}: To suspend a mandate it must be in active status.`)
      const release = await patch(`/v1/payto/${side}/mandates/${id}/release`)
      expect(release.statusCode, side).toBe(422)
      expect(release.json().message).toBe(`Validation of the request for releasing mandate with id: ${id} failed. To release a mandate it must be in suspended status.`)
    }
    expect((await patch(`/v1/payto/initiator/mandates/${UNKNOWN_ID}/suspend`, {})).statusCode).toBe(404)
    expect((await patch(`/v1/payto/initiator/mandates/${id}/suspend`, { reasonCode: 'XX99' })).statusCode).toBe(400)
  })

  it('a suspension is released only by the side that suspended it', async () => {
    const { id } = await activeMandate()
    expect((await patch(`/v1/payto/payer/mandates/${id}/suspend`, { reasonCode: 'MD16' })).statusCode).toBe(200)
    expect(svc.get(id)).toMatchObject({ status: 'SUSPENDED', cxStatus: 'PAUSED_BY_CUSTOMER', suspendedBy: 'PAYER' })
    const byInitiator = await patch(`/v1/payto/initiator/mandates/${id}/release`)
    expect(byInitiator.statusCode).toBe(422)
    expect(byInitiator.json().message).toBe(`INVALID_STATE: Mandate ${id} was suspended by the Payer and can only be released by them.`)
    expect((await patch(`/v1/payto/payer/mandates/${id}/release`)).statusCode).toBe(200)
    expect(svc.get(id).status).toBe('ACTIVE')
    expect((await patch(`/v1/payto/initiator/mandates/${id}/suspend`, {})).statusCode).toBe(200)
    const byPayer = await patch(`/v1/payto/payer/mandates/${id}/release`)
    expect(byPayer.statusCode).toBe(422)
    expect(byPayer.json().message).toMatch(/suspended by the Initiator/)
    expect((await patch(`/v1/payto/payer/mandates/${id}/cancel`, {})).statusCode).toBe(200)
    expect(svc.get(id)).toMatchObject({ status: 'CANCELLED', cxStatus: 'CANCELLED' })
  })

  it('cancelling a CREATED mandate: refused for the Initiator (recall instead), allowed for the Payer (declines the pending CREATE)', async () => {
    const creditor = await newAccount()
    const debtor = await newAccount()
    const id = await createMandate(creditor, { accountId: debtor.accountHayId! })
    const byInitiator = await patch(`/v1/payto/initiator/mandates/${id}/cancel`, {})
    expect(byInitiator.statusCode).toBe(422)
    expect(byInitiator.json().message).toMatch(/^INVALID_STATE: .*CREATED status cannot be cancelled by the Initiator/)
    const byPayer = await patch(`/v1/payto/payer/mandates/${id}/cancel`, { reasonCode: 'MD16', reasonDescription: 'Requested by Customer' })
    expect(byPayer.statusCode, byPayer.body).toBe(200)
    expect(svc.get(id)).toMatchObject({ status: 'CANCELLED', cxStatus: 'CANCELLED' })
    expect((await actions(id)).map((a) => [a.type, a.status])).toEqual([['CREATE', 'DECLINED'], ['STATUS_CHANGE', 'COMPLETED']])
    expect((await mandateEvents(id)).map((e) => e.mandateEventDto.trigger)).toEqual(['MCRT', 'MSCH', 'MSCH'])
    const again = await patch(`/v1/payto/payer/mandates/${id}/cancel`, {})
    expect(again.statusCode).toBe(422)
    expect(again.json().message).toBe(`INVALID_STATE: Mandate ${id} is already cancelled`)
    // an external debtor's mandate has no local Payer
    const external = await createMandate(creditor, { accountNumber: EXTERNAL_DEBTOR })
    expect((await patch(`/v1/payto/payer/mandates/${external}/cancel`, {})).statusCode).toBe(403)
    expect((await patch(`/v1/payto/payer/mandates/${external}/suspend`, {})).statusCode).toBe(403)
    expect((await patch(`/v1/payto/payer/mandates/${external}/release`)).statusCode).toBe(403)
  })

  it('the transition helper is a no-op for the same status and lets the platform cancel from any status', async () => {
    const creditor = await newAccount()
    const debtor = await newAccount()
    const id = await createMandate(creditor, { accountId: debtor.accountHayId! })
    await clearNotifications()
    const seen: unknown[] = []
    const off = built.ctx.events.on('mandate.statusChanged', (e) => seen.push(e))
    expect(svc.transition(id, 'CREATED', { side: 'PLATFORM', change: 'SUSPEND' }).status).toBe('CREATED')
    expect(seen).toEqual([])
    expect(await mandateEvents(id)).toEqual([])
    const m = svc.transition(mmsId(id), 'CANCELLED', { side: 'PLATFORM', change: 'CANCEL', reasonCode: 'MD20' })
    off()
    expect(m).toMatchObject({ status: 'CANCELLED', cxStatus: 'CANCELLED' })
    expect(seen).toEqual([expect.objectContaining({ previousStatus: 'CREATED', by: 'PLATFORM' })])
    expect((await actions(id)).map((a) => [a.type, a.status, a.creationEvent.partyRole])).toEqual([['CREATE', 'TIMED_OUT', 'PAYMENT_INITIATOR'], ['STATUS_CHANGE', 'COMPLETED', 'PAYMENT_INITIATOR']])
    expect((await mandateEvents(id)).map((e) => [e.customerHayId, e.mandateEventDto.trigger, e.actionOwner])).toEqual([[creditor.accountHolderId, 'MSCH', 'PLATFORM'], [debtor.accountHolderId, 'MSCH', 'PLATFORM']])
  })
})

// ---------------------------------------------------------------- amendments

describe('amendMandateByInitiator', () => {
  it('moves the creditor account to another ACTIVE account of the same holder and notifies the Payer with MAMN', async () => {
    const holder = await newCustomer()
    const creditor = await newAccount({ holder })
    const replacement = await newAccount({ holder, fund: 10 })
    const { id, debtor } = await activeMandate({ creditor })
    const res = await app.inject({ method: 'PUT', url: `/v1/payto/initiator/mandates/${id}`, payload: { creditorAccountId: replacement.accountHayId, ultimatePartyName: 'ACME Energy' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Mandate amended successfully.' })
    expect((await getMandate(id)).creditorDetails).toEqual({ accountId: replacement.accountHayId, partyReference: 'NET-1724', partyType: 'ORGANISATION', ultimatePartyName: 'ACME Energy' })
    expect(svc.mandateIdsForCreditorAccount(replacement.accountHayId!)).toEqual([id])
    expect(svc.mandateIdsForCreditorAccount(creditor.accountHayId!)).toEqual([])
    const amend = (await actions(id)).at(-1)!
    expect(amend).toMatchObject({ type: 'AMEND', status: 'COMPLETED', bilateral: false, creationEvent: { partyRole: 'PAYMENT_INITIATOR' }, details: { amendment: { creditorInformation: { accountId: replacement.accountHayId, ultimatePartyName: 'ACME Energy' } } } })
    expect(amend.resolutionEvent).toBeDefined()
    const last = (await mandateEvents(id)).at(-1)!
    expect(last).toMatchObject({ customerHayId: debtor.accountHolderId, actionOwner: 'CLIENT', mandateEventDto: { trigger: 'MAMN', actionId: amend.actionIdentification, description: 'Mandate amended' } })
  })

  it('refuses another holder\'s account, an account that is not ACTIVE, an unknown account and a mandate that is not ACTIVE / SUSPENDED', async () => {
    const holder = await newCustomer()
    const creditor = await newAccount({ holder })
    const { id, debtor } = await activeMandate({ creditor })
    const foreign = await newAccount({ fund: 10 })
    const approved = await newAccount({ holder })
    const put = (mandateId: string, creditorAccountId: string) => app.inject({ method: 'PUT', url: `/v1/payto/initiator/mandates/${mandateId}`, payload: { creditorAccountId } })
    const other = await put(id, foreign.accountHayId!)
    expect(other.statusCode).toBe(422)
    expect(other.json().message).toMatch(/^PERMISSION_DENIED: .*does not belong to the holder/)
    const notActive = await put(id, approved.accountHayId!)
    expect(notActive.statusCode).toBe(422)
    expect(notActive.json().message).toMatch(/^INVALID_ACCOUNT_STATUS: .*must be ACTIVE/)
    expect((await put(id, UNKNOWN_ID)).statusCode).toBe(404)
    const created = await createMandate(creditor, { accountId: debtor.accountHayId! })
    const notAmendable = await put(created, creditor.accountHayId!)
    expect(notAmendable.statusCode).toBe(422)
    expect(notAmendable.json().message).toMatch(/^INVALID_STATE: .*is CREATED; to amend a mandate it must be ACTIVE or SUSPENDED/)
    expect((await getMandate(id)).creditorDetails?.accountId).toBe(creditor.accountHayId)
  })
})

describe('amendMandateByPayer', () => {
  it('moves the debtor account to another ACTIVE account of the same holder (mandate ACTIVE or SUSPENDED) and notifies the Initiator with MAMN', async () => {
    const holder = await newCustomer()
    const debtor = await newAccount({ holder })
    const replacement = await newAccount({ holder, fund: 10 })
    const { id, creditor } = await activeMandate({ debtor })
    expect((await patch(`/v1/payto/payer/mandates/${id}/suspend`, {})).statusCode).toBe(200)
    const res = await app.inject({ method: 'PUT', url: `/v1/payto/payer/mandates/${id}`, payload: { debtorAccountId: replacement.accountHayId } })
    expect(res.statusCode, res.body).toBe(200)
    expect((await getMandate(id)).debtorDetails).toMatchObject({ accountId: replacement.accountHayId, accountNumber: `${LOCAL_BSB}${replacement.accountNumber}` })
    const amend = (await actions(id, 'payer')).at(-1)!
    expect(amend).toMatchObject({ type: 'AMEND', status: 'COMPLETED', bilateral: false, creationEvent: { partyRole: 'DEBTOR' }, details: { amendment: { debtorInformation: { accountId: replacement.accountHayId } } } })
    expect((await mandateEvents(id)).at(-1)).toMatchObject({ customerHayId: creditor.accountHolderId, mandateEventDto: { trigger: 'MAMN', actionId: amend.actionIdentification } })
    // the new debtor account now answers the Payer search
    const search = await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${LOCAL_BSB}${replacement.accountNumber}&pageNumber=1&pageSize=10` })
    expect(search.json().result.map((m: { mandateId: string }) => m.mandateId)).toEqual([id])
    const foreign = await newAccount({ fund: 10 })
    const other = await app.inject({ method: 'PUT', url: `/v1/payto/payer/mandates/${id}`, payload: { debtorAccountId: foreign.accountHayId } })
    expect(other.statusCode).toBe(422)
    const external = await createMandate(creditor, { accountNumber: EXTERNAL_DEBTOR })
    expect((await app.inject({ method: 'PUT', url: `/v1/payto/payer/mandates/${external}`, payload: { debtorAccountId: replacement.accountHayId } })).statusCode).toBe(403)
  })
})

describe('amendMandatePaymentTerms', () => {
  const terms: CreateMandateBody['paymentTerms'] = { frequency: 'MONTHLY', type: 'VARIABLE', maximumAmount: AUD(100), firstPayment: { date: '2035-01-10' } }

  it('proposes a bilateral AMEND (MAMP to the Payer) that changes nothing until the Payer accepts (MAMC)', async () => {
    const { id, creditor, debtor } = await activeMandate({ terms })
    const res = await patch(`/v1/payto/initiator/mandates/${id}/payment_terms`, { paymentTerms: { ...terms, maximumAmount: AUD(150), amount: AUD(20) }, validityEndDate: '2036-01-01', resolutionRequestedBy: '2035-01-01T00:00:00.000Z' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ message: 'Mandate payment terms amendment proposed successfully.' })
    const before = await getMandate(id)
    expect(before.paymentTerms).toEqual({ frequency: 'MONTHLY', type: 'VARIABLE', maximumAmount: AUD(100), firstPayment: { date: '2035-01-10' } })
    expect(before.validityEndDate).toBeUndefined()
    const [pending] = await actions(id, 'payer', '?pendingOnly=true')
    expect(pending).toMatchObject({
      type: 'AMEND', status: 'PENDING', bilateral: true, expiryTime: expect.stringMatching(ISO_MS_RE), resolutionRequestedBy: '2035-01-01T00:00:00.000Z', cxEventNameCreation: 'Updated payment terms received',
      details: { amendment: { validityEndDate: '2036-01-01', paymentInformation: { amount: { amount: '20.00', currency: 'AUD' }, maximumAmount: { amount: '150.00', currency: 'AUD' }, paymentFrequency: 'MONTHLY', paymentAmountType: 'VARIABLE', firstPaymentDate: '2035-01-10' } } },
    })
    expect((await mandateEvents(id)).at(-1)).toMatchObject({ customerHayId: debtor.accountHolderId, mandateEventDto: { trigger: 'MAMP', actionId: pending!.actionIdentification } })
    // a second proposal must wait
    const second = await patch(`/v1/payto/initiator/mandates/${id}/payment_terms`, { validityEndDate: '2037-01-01' })
    expect(second.statusCode).toBe(422)
    expect(second.json().message).toMatch(/already has a pending action/)

    const accept = await patch(`/v1/payto/payer/mandates/${id}/resolve?resolution=ACCEPT`)
    expect(accept.statusCode, accept.body).toBe(200)
    const after = await getMandate(id)
    expect(after.paymentTerms).toEqual({ frequency: 'MONTHLY', type: 'VARIABLE', amount: AUD(20), maximumAmount: AUD(150), firstPayment: { date: '2035-01-10' } })
    expect(after.validityEndDate).toBe('2036-01-01')
    expect((await actions(id)).at(-1)).toMatchObject({ type: 'AMEND', status: 'COMPLETED', cxEventNameResolution: 'Updated payment terms authorised' })
    expect((await mandateEvents(id)).at(-1)).toMatchObject({ customerHayId: creditor.accountHolderId, mandateEventDto: { trigger: 'MAMC', description: 'Mandate amend confirmed' } })
  })

  it('REJECT declines the amendment (MAMD) and a recall withdraws it (MAMR to the Payer); validation of the proposal', async () => {
    const { id, creditor, debtor } = await activeMandate({ terms })
    expect((await patch(`/v1/payto/initiator/mandates/${id}/payment_terms`, { paymentTerms: { ...terms, maximumAmount: AUD(150) } })).statusCode).toBe(200)
    expect((await patch(`/v1/payto/payer/mandates/${id}/resolve?resolution=REJECT`)).statusCode).toBe(200)
    expect((await getMandate(id)).paymentTerms.maximumAmount).toEqual(AUD(100))
    expect((await actions(id)).at(-1)).toMatchObject({ type: 'AMEND', status: 'DECLINED' })
    expect((await mandateEvents(id)).at(-1)).toMatchObject({ customerHayId: creditor.accountHolderId, mandateEventDto: { trigger: 'MAMD' } })

    expect((await patch(`/v1/payto/initiator/mandates/${id}/payment_terms`, { validityEndDate: '2040-01-01' })).statusCode).toBe(200)
    expect((await patch(`/v1/payto/initiator/mandates/${id}/resolve`)).statusCode).toBe(200)
    expect((await getMandate(id)).validityEndDate).toBeUndefined()
    expect((await actions(id)).at(-1)).toMatchObject({ type: 'AMEND', status: 'RECALLED', cxEventNameResolution: 'Updated payment terms recalled' })
    expect((await mandateEvents(id)).at(-1)).toMatchObject({ customerHayId: debtor.accountHolderId, mandateEventDto: { trigger: 'MAMR' } })
    expect((await getMandate(id)).status).toBe('ACTIVE')

    const cases: [object, number, RegExp][] = [
      [{}, 400, /paymentTerms or validityEndDate is required/],
      [{ paymentTerms: { ...terms, frequency: 'WEEKLY' } }, 422, /frequency and paymentTerms.type cannot be amended/],
      [{ paymentTerms: { ...terms, type: 'FIXED' } }, 422, /cannot be amended/],
      [{ validityEndDate: '2019-01-01' }, 422, /validityEndDate must not precede/],
      [{ validityEndDate: '2040-01-01', resolutionRequestedBy: 'soon' }, 400, /resolutionRequestedBy/],
      [{ paymentTerms: { ...terms, maximumAmount: AUD(1.005) } }, 400, /2 decimal places/],
    ]
    for (const [payload, status, message] of cases) {
      const res = await patch(`/v1/payto/initiator/mandates/${id}/payment_terms`, payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(status)
      expect(res.json().message).toMatch(message)
    }
    const created = await createMandate(creditor, { accountId: debtor.accountHayId! })
    expect((await patch(`/v1/payto/initiator/mandates/${created}/payment_terms`, { validityEndDate: '2040-01-01' })).statusCode).toBe(422)
    expect((await patch(`/v1/payto/initiator/mandates/${UNKNOWN_ID}/payment_terms`, { validityEndDate: '2040-01-01' })).statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------- actions query

describe('getMandateActionsByInitiator / ByPayer', () => {
  it('filters by [from, to] on the creation time and by pendingOnly; future bounds are 400', async () => {
    const { id } = await activeMandate({ terms: { frequency: 'MONTHLY', type: 'VARIABLE', firstPayment: { date: '2035-01-10' } } })
    const acts = await actions(id, 'payer')
    expect(acts).toHaveLength(1)
    const t0 = acts[0]!.creationEvent.time
    await advanceClock(60_000)
    expect((await patch(`/v1/payto/initiator/mandates/${id}/payment_terms`, { validityEndDate: '2040-01-01' })).statusCode).toBe(200)
    const all = await actions(id)
    expect(all.map((a) => a.type)).toEqual(['CREATE', 'AMEND'])
    const later = new Date(new Date(t0).getTime() + 30_000).toISOString()
    expect((await actions(id, 'initiator', `?from=${later}`)).map((a) => a.type)).toEqual(['AMEND'])
    expect((await actions(id, 'payer', `?to=${later}`)).map((a) => a.type)).toEqual(['CREATE'])
    expect((await actions(id, 'initiator', `?from=${t0}&to=${t0}`)).map((a) => a.type)).toEqual(['CREATE'])
    expect((await actions(id, 'initiator', '?pendingOnly=true')).map((a) => a.type)).toEqual(['AMEND'])
    expect((await actions(id, 'initiator', '?pendingOnly=false')).map((a) => a.type)).toEqual(['CREATE', 'AMEND'])
    const future = new Date(new Date(all[1]!.creationEvent.time).getTime() + DAY_MS).toISOString()
    for (const q of [`?from=${future}`, `?to=${future}`, `?from=${later}&to=${t0}`, '?from=2024-01-01', '?from=2024-02-30T00:00:00Z', '?to=2024-01-01T00:00:00+10:00']) {
      const res = await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/actions${q}` })
      expect(res.statusCode, q).toBe(400)
    }
    expect((await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${UNKNOWN_ID}/actions` })).statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------- payments

describe('makeAdhocPayment', () => {
  it('settles between two local accounts: INTERBANK_TRANSFER_OUT / _IN with mandatePaymentDetails, then MANDATE_PAYMENT ACCEPTED', async () => {
    await clearNotifications()
    const creditor = await newAccount()
    const debtor = await newAccount({ fund: 100 })
    const { id } = await activeMandate({ creditor, debtor })
    await clearNotifications()
    const res = await adhoc(id, { amount: AUD(12.5), endToEndId: 'INV-1', description: 'Bill' })
    expect(res).toEqual({ mandateId: id, instructionId: expect.stringMatching(INSTRUCTION_RE), transactionStatus: 'ACCEPTED_AND_SETTLED', transactionStatusDisplay: 'Accepted and Settled', statusIsFinal: true, message: 'Adhoc payment executed successfully.' })
    expect(res.instructionId.startsWith(`${BIC}I`)).toBe(true)
    expect(await getAccount(debtor.accountHayId!)).toMatchObject({ availableBalance: 87.5, totalBalance: 87.5 })
    expect(await getAccount(creditor.accountHayId!)).toMatchObject({ availableBalance: 12.5, totalBalance: 12.5, status: 'ACTIVE' })

    const payloads = await allPayloads()
    const tx = payloads.filter((p) => p.type === 'TRANSACTION').map((p) => p.transactionEvent)
    expect(tx).toHaveLength(2)
    const out = tx.find((t) => t.accountHayId === debtor.accountHayId)!
    const into = tx.find((t) => t.accountHayId === creditor.accountHayId)!
    expect(out).toMatchObject({
      transactionType: 'INTERBANK_TRANSFER_OUT', currencyAmount: AUD(-12.5), isPending: false, outcome: 'ACCEPTED', originType: 'MANDATE_PAYMENT', originId: id,
      mandatePaymentDetails: { mandateId: id, instructionId: res.instructionId, initiatingPartyName: 'ACME Utilities' }, reference: 'INV-1', description: 'Bill',
      counterpartDetails: { accountId: creditor.accountHayId, customerId: creditor.accountHolderId, name: 'ACME Utilities', basicAccountNumber: { branchNumber: LOCAL_BSB, accountNumber: creditor.accountNumber } },
    })
    expect(into).toMatchObject({
      transactionType: 'INTERBANK_TRANSFER_IN', currencyAmount: AUD(12.5), originType: 'MANDATE_PAYMENT', originId: id,
      mandatePaymentDetails: { mandateId: id, instructionId: res.instructionId, initiatingPartyName: 'ACME Utilities' },
      counterpartDetails: { accountId: debtor.accountHayId, customerId: debtor.accountHolderId, name: 'JOHN MAXIMILLIAN DOE', basicAccountNumber: { branchNumber: LOCAL_BSB, accountNumber: debtor.accountNumber } },
    })
    const payment = payloads.filter((p) => p.type === 'MANDATE_PAYMENT')
    expect(payment).toEqual([{
      customerHayId: creditor.accountHolderId, idempotencyKey: expect.any(String), type: 'MANDATE_PAYMENT', actionOwner: 'CLIENT',
      mandatePaymentEventDto: { instructionId: res.instructionId, mandateId: id, paymentStatus: 'MANDATE_PAYMENT_ACCEPTED', transactionHayId: into.transactionHayId, isFinal: true, originId: id, originType: 'MANDATE_PAYMENT' },
    }])
    for (const p of payloads) assertValidNotification(p, 'v0')

    // the ledger read carries the mandate details too
    const t = await app.inject({ method: 'GET', url: `/v1/transactions/${into.transactionHayId}` })
    expect(t.json()).toMatchObject({ type: 'INTERBANK_TRANSFER_IN', transactionChannel: 'CUSCAL_NPP_TRANSFER_IN', originType: 'MANDATE_PAYMENT', mandatePaymentDetails: { mandateId: id, instructionId: res.instructionId } })

    const status = await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/instructions/${res.instructionId}/status` })
    expect(status.json()).toEqual({ transactionStatus: 'ACCEPTED_AND_SETTLED' })
    const search = await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/search` })
    expect(search.json()).toEqual({ paymentInstructions: [{ id: res.instructionId, amount: 12.5, creationDateTime: expect.stringMatching(ISO_MICROS_RE), endToEndId: 'INV-1', transactionStatus: 'ACCEPTED_AND_SETTLED' }] })
  })

  it('replays the same idempotencyKey without paying twice', async () => {
    const debtor = await newAccount({ fund: 50 })
    const { id } = await activeMandate({ debtor })
    const body = { idempotencyKey: randomUUID(), mandateId: id, amount: AUD(10) }
    const first = await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: body })
    const again = await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: body })
    expect(again.json()).toEqual(first.json())
    expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(40)
    expect((await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { ...body, amount: AUD(11) } })).statusCode).toBe(422)
    expect(svc.instructions(id)).toHaveLength(1)
  })

  it('rejects (200, REJECTED, reason code) instead of erroring: funds, external debtor, inactive mandate, non-ADHOC, above maximum, missing amount', async () => {
    const creditor = await newAccount()
    const poor = await newAccount({ fund: 5 })
    const { id } = await activeMandate({ creditor, debtor: poor })
    await clearNotifications()
    const funds = await adhoc(id, { amount: AUD(12.5), endToEndId: undefined })
    expect(funds).toMatchObject({ transactionStatus: 'REJECTED', transactionStatusDisplay: 'Rejected', statusIsFinal: true, message: 'Adhoc payment executed successfully.' })
    expect((await getAccount(poor.accountHayId!)).availableBalance).toBe(5)
    const [rejected] = await paymentEvents(id)
    expect(rejected).toEqual({
      customerHayId: creditor.accountHolderId, idempotencyKey: expect.any(String), type: 'MANDATE_PAYMENT', actionOwner: 'CLIENT',
      mandatePaymentEventDto: { instructionId: funds.instructionId, mandateId: id, paymentStatus: 'MANDATE_PAYMENT_REJECTED', reasonCode: 'AM04', isFinal: true, originId: id, originType: 'MANDATE_PAYMENT' },
    })
    assertValidNotification(rejected, 'v0')
    expect((await allPayloads()).filter((p) => p.type === 'TRANSACTION')).toEqual([])
    const status = await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/instructions/${funds.instructionId}/status` })
    expect(status.json()).toEqual({ transactionStatus: 'REJECTED', transactionStatusReasonCode: 'AM04' })
    expect((await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/search` })).json().paymentInstructions[0]).toMatchObject({ endToEndId: 'Not provided', transactionStatusReasonCode: 'AM04' })

    expect((await adhoc(id, { amount: AUD(1000) })).transactionStatus).toBe('REJECTED')
    expect(svc.instructions(id)[0]!.reasonCode).toBe('AM21')
    expect((await adhoc(id, { amount: undefined })).transactionStatus).toBe('REJECTED')
    expect(svc.instructions(id)[0]!.reasonCode).toBe('AM12')

    const external = await createMandate(creditor, { accountNumber: EXTERNAL_DEBTOR })
    svc.emitMandateNotification('INITIATOR', external, 'MCRC')
    const staging = await adhoc(external, { amount: AUD(2.1) })
    expect(staging).toMatchObject({ transactionStatus: 'REJECTED', statusIsFinal: true })
    expect(svc.instructions(external)[0]!.reasonCode).toBe('AB01')

    const created = await createMandate(creditor, { accountId: poor.accountHayId! })
    expect((await adhoc(created)).transactionStatus).toBe('REJECTED')
    expect(svc.instructions(created)[0]!.reasonCode).toBe('AG01')

    const monthly = await activeMandate({ creditor, debtor: poor, terms: { frequency: 'MONTHLY', type: 'FIXED', amount: AUD(1), firstPayment: { date: '2035-01-01' } } })
    expect((await adhoc(monthly.id, { amount: AUD(1) })).transactionStatus).toBe('REJECTED')
    expect(svc.instructions(monthly.id)[0]!.reasonCode).toBe('AG03')

    const blocked = await newAccount({ fund: 50 })
    const { id: blockedMandate } = await activeMandate({ creditor, debtor: blocked })
    await app.inject({ method: 'POST', url: `/v0/accounts/${blocked.accountHayId}/block`, payload: { note: 'x', accountBlockStyle: 'ACCOUNT_ONLY' } })
    expect((await adhoc(blockedMandate)).transactionStatus).toBe('REJECTED')
    expect(svc.instructions(blockedMandate)[0]!.reasonCode).toBe('AC06')

    expect((await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId: UNKNOWN_ID, amount: AUD(1) } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId: id, amount: AUD(1.005) } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId: id, amount: { currency: 'NZD', amount: 1 } } })).statusCode).toBe(422)
    expect((await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId: id, endToEndId: '' } })).statusCode).toBe(400)
    const missing = await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/instructions/${staging.instructionId}/status` })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().message).toBe(`NOT_FOUND: Payment instruction ${staging.instructionId} not found for mandate ${id}`)
  })

  it('a HIGH-risk (default) debtor account is refused by the ledger limits (AG07)', async () => {
    const debtor = await newAccount({ risk: 'HIGH' })
    const { id } = await activeMandate({ debtor })
    expect((await adhoc(id, { amount: AUD(1) })).transactionStatus).toBe('REJECTED')
    expect(svc.instructions(id)[0]!.reasonCode).toBe('AG07')
  })
})

describe('searchPaymentsInstructions with stubbed instructions', () => {
  it('serves stubbed MMS summaries (utilities createStubForMandateSearchPaymentInstructions) newest first, replacing earlier stubs', async () => {
    const debtor = await newAccount({ fund: 20 })
    const { id } = await activeMandate({ debtor })
    const paid = await adhoc(id, { amount: AUD(3) })
    const stub = (n: string, status: PaymentInstructionSummary['transactionStatus'], reason?: string): PaymentInstructionSummary => ({
      instructionIdentification: `${BIC}I20231129000000000093${n}`, instructedAmount: 1.28, creationDateTime: '2023-11-29T12:33:59.833Z', transactionStatus: status, ...(reason ? { transactionStatusReasonCode: reason } : {}),
    })
    svc.addStubInstructions(mmsId(id), [stub('410', 'RECV', 'AB01'), stub('411', 'ACSC')])
    const res = await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/search` })
    expect(res.json().paymentInstructions).toEqual([
      { id: `${BIC}I20231129000000000093411`, amount: 1.28, creationDateTime: '2023-11-29T12:33:59.833000Z', endToEndId: 'Not provided', transactionStatus: 'ACCEPTED_AND_SETTLED' },
      { id: `${BIC}I20231129000000000093410`, amount: 1.28, creationDateTime: '2023-11-29T12:33:59.833000Z', endToEndId: 'Not provided', transactionStatus: 'RECEIVED', transactionStatusReasonCode: 'AB01' },
      expect.objectContaining({ id: paid.instructionId }),
    ])
    const status = await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/instructions/${BIC}I20231129000000000093410/status` })
    expect(status.json()).toEqual({ transactionStatus: 'RECEIVED', transactionStatusReasonCode: 'AB01' })
    svc.addStubInstructions(id, [stub('412', 'UNDV')])
    expect((await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/search` })).json().paymentInstructions.map((i: { id: string }) => i.id)).toEqual([`${BIC}I20231129000000000093412`, paid.instructionId])
    expect(() => svc.addStubInstructions(UNKNOWN_ID, [stub('413', 'SENT')])).toThrow(expect.objectContaining({ status: 404 }))
    expect((await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${UNKNOWN_ID}/search` })).statusCode).toBe(404)
  })
})

describe('receivePaymentInstruction (RAPAIN, for utilities)', () => {
  it('ACCP debits the local debtor with mandatePaymentDetails and answers MANDATE_PAYMENT_ACCEPTED; RJCT answers REJECTED', async () => {
    const debtor = await newAccount({ fund: 30 })
    const { id, creditor } = await activeMandate({ debtor })
    await clearNotifications()
    const accepted = svc.receivePaymentInstruction({ mandateId: mmsId(id), instructionId: `${BIC}I20230718000000000077240`, amountCents: 1000, initiatingPartyName: 'ACME', status: 'ACCP' })
    expect(accepted.instruction).toMatchObject({ id: `${BIC}I20230718000000000077240`, status: 'ACCEPTED_AND_SETTLED', origin: 'INBOUND', transactionId: accepted.transactionId })
    expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(20)
    expect((await getAccount(creditor.accountHayId!)).availableBalance).toBe(0) // the creditor leg arrives with the RAP mock
    const payloads = await allPayloads()
    expect(payloads.map((p) => p.type)).toEqual(['TRANSACTION', 'MANDATE_PAYMENT'])
    expect(payloads[0].transactionEvent).toMatchObject({ transactionType: 'INTERBANK_TRANSFER_OUT', currencyAmount: AUD(-10), mandatePaymentDetails: { mandateId: id, instructionId: `${BIC}I20230718000000000077240`, initiatingPartyName: 'ACME' } })
    expect(payloads[1]).toMatchObject({ customerHayId: creditor.accountHolderId, actionOwner: 'PLATFORM', mandatePaymentEventDto: { paymentStatus: 'MANDATE_PAYMENT_ACCEPTED', transactionHayId: accepted.transactionId, isFinal: true } })
    const rejected = svc.receivePaymentInstruction({ mandateId: id, instructionId: `${BIC}I20230718000000000077250`, amountCents: 1000, status: 'RJCT', reasonCode: 'AC06' })
    expect(rejected.instruction).toMatchObject({ status: 'REJECTED', reasonCode: 'AC06' })
    expect(rejected.transactionId).toBeUndefined()
    const short = svc.receivePaymentInstruction({ mandateId: id, instructionId: `${BIC}I20230718000000000077260`, amountCents: 5000, status: 'ACCP' })
    expect(short.instruction).toMatchObject({ status: 'REJECTED', reasonCode: 'AM04' })
    expect(() => svc.receivePaymentInstruction({ mandateId: id, instructionId: `${BIC}I20230718000000000077260`, amountCents: 1, status: 'RJCT' })).toThrow(expect.objectContaining({ status: 422 }))
    expect((await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/search` })).json().paymentInstructions).toHaveLength(3)
  })
})

// ---------------------------------------------------------------- scheduled payments

describe('scheduled payments and setScheduledPaymentInitiationRequestAmount', () => {
  it('a VARIABLE monthly mandate gets MANDATE_DUE_PAYMENT on activation; the amount is set by notificationId and initiated when the clock reaches the due time', async () => {
    const now = await today()
    const debtor = await newAccount({ fund: 500 })
    const creditor = await newAccount()
    const id = await createMandate(creditor, { accountId: debtor.accountHayId! }, { paymentTerms: { frequency: 'MONTHLY', type: 'VARIABLE', maximumAmount: AUD(100) }, validityStartDate: plusDays(now, 3) })
    await clearNotifications()
    expect((await patch(`/v1/payto/payer/mandates/${id}/resolve?resolution=ACCEPT`)).statusCode).toBe(200)
    const due = (await allPayloads()).filter((p) => p.type === 'MANDATE_DUE_PAYMENT')
    expect(due).toEqual([{ customerHayId: creditor.accountHolderId, idempotencyKey: expect.any(String), type: 'MANDATE_DUE_PAYMENT', actionOwner: 'PLATFORM', mandateDuePaymentEventDto: { mandateId: id, notificationId: expect.any(String), paymentDateTimeUtc: `${plusDays(now, 3)}T00:00:00.000000Z` } }])
    assertValidNotification(due[0], 'v0')
    const { notificationId } = due[0].mandateDuePaymentEventDto
    expect(svc.schedule(id)).toMatchObject({ notificationId, dueDate: plusDays(now, 3) })

    const wrongMandate = await patch(`/v1/payto/initiator/mandates/${UNKNOWN_ID}/payments/amount`, { amount: AUD(40), notificationId })
    expect(wrongMandate.statusCode).toBe(404)
    const wrongNotification = await patch(`/v1/payto/initiator/mandates/${id}/payments/amount`, { amount: AUD(40), notificationId: UNKNOWN_ID })
    expect(wrongNotification.statusCode).toBe(422)
    expect(wrongNotification.json().message).toMatch(/^NOT_FOUND: Notification/)
    const tooMuch = await patch(`/v1/payto/initiator/mandates/${id}/payments/amount`, { amount: AUD(140), notificationId })
    expect(tooMuch.statusCode).toBe(422)
    expect(tooMuch.json().message).toMatch(/^INVALID_AMOUNT:/)
    const set = await patch(`/v1/payto/initiator/mandates/${id}/payments/amount`, { amount: AUD(40), notificationId })
    expect(set.statusCode, set.body).toBe(200)
    expect(set.json()).toEqual({ message: 'Scheduled payment amount set successfully.' })

    await clearNotifications()
    await advanceClock(2 * DAY_MS)
    expect(svc.instructions(id)).toEqual([])
    await advanceClock(2 * DAY_MS)
    const [instruction] = svc.instructions(id)
    expect(instruction).toMatchObject({ origin: 'SCHEDULED', amountCents: 4000, status: 'ACCEPTED_AND_SETTLED', endToEndId: 'NET-1724' })
    expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(460)
    const payloads = await allPayloads()
    // the creditor account's first posting also flips it APPROVED -> ACTIVE (accounts domain)
    expect(payloads.map((p) => p.type)).toEqual(['TRANSACTION', 'ACCOUNT_STATUS_CHANGE', 'TRANSACTION', 'MANDATE_PAYMENT', 'MANDATE_DUE_PAYMENT'])
    expect(payloads[1]).toMatchObject({ customerHayId: creditor.accountHolderId, accountStatusChangeEvent: { accountStatus: 'ACTIVE' } })
    expect(payloads[3]).toMatchObject({ actionOwner: 'PLATFORM', mandatePaymentEventDto: { instructionId: instruction!.id, paymentStatus: 'MANDATE_PAYMENT_ACCEPTED', isFinal: true } })
    expect(payloads[4].mandateDuePaymentEventDto).toMatchObject({ mandateId: id, paymentDateTimeUtc: `${stepDate(plusDays(now, 3), 'MONTHLY')}T00:00:00.000000Z` })
    expect(payloads[4].mandateDuePaymentEventDto.notificationId).not.toBe(notificationId)
    for (const p of payloads) assertValidNotification(p, 'v0')

    // without an amount the next scheduled PIR is rejected with AM12; a suspended mandate defers
    const next = svc.schedule(id)!
    expect((await patch(`/v1/payto/initiator/mandates/${id}/suspend`, {})).statusCode).toBe(200)
    await advanceClock(32 * DAY_MS)
    expect(svc.instructions(id)).toHaveLength(1)
    expect(svc.schedule(id)?.notificationId).toBe(next.notificationId)
    expect((await patch(`/v1/payto/initiator/mandates/${id}/release`)).statusCode).toBe(200)
    await flush()
    expect(svc.instructions(id)[0]).toMatchObject({ origin: 'SCHEDULED', status: 'REJECTED', reasonCode: 'AM12' })
    expect(svc.schedule(id)?.notificationId).not.toBe(next.notificationId)
    // cancellation drops the schedule
    expect((await patch(`/v1/payto/payer/mandates/${id}/cancel`, {})).statusCode).toBe(200)
    expect(svc.schedule(id)).toBeUndefined()
    await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
  })

  it('FIXED terms take the amount from paymentTerms / firstPayment / lastPayment and stop after lastPayment.date; the amount cannot be set', async () => {
    const now = await today()
    const debtor = await newAccount({ fund: 500 })
    const first = plusDays(now, 2)
    const { id } = await activeMandate({ debtor, terms: { frequency: 'WEEKLY', type: 'FIXED', amount: AUD(10), firstPayment: { amount: AUD(15), date: first }, lastPayment: { amount: AUD(5), date: plusDays(first, 7) } } })
    const set = await patch(`/v1/payto/initiator/mandates/${id}/payments/amount`, { amount: AUD(40), notificationId: svc.schedule(id)!.notificationId })
    expect(set.statusCode).toBe(422)
    expect(set.json().message).toMatch(/FIXED payment terms/)
    await advanceClock(3 * DAY_MS)
    expect(svc.instructions(id).map((i) => i.amountCents)).toEqual([1500])
    await advanceClock(7 * DAY_MS)
    expect(svc.instructions(id).map((i) => i.amountCents)).toEqual([500, 1500])
    expect(svc.schedule(id)).toBeUndefined()
    expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(480)
    await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
  })

  it('stepDate walks the calendar by frequency', () => {
    expect(stepDate('2026-01-31', 'MONTHLY')).toBe('2026-02-28')
    expect(stepDate('2028-01-31', 'MONTHLY')).toBe('2028-02-29')
    expect(stepDate('2026-11-30', 'QUARTERLY')).toBe('2027-02-28')
    expect(stepDate('2026-03-15', 'SEMI_ANNUAL')).toBe('2026-09-15')
    expect(stepDate('2026-03-15', 'ANNUAL')).toBe('2027-03-15')
    expect(stepDate('2026-12-31', 'DAILY')).toBe('2027-01-01')
    expect(stepDate('2026-12-31', 'INTRA_DAY')).toBe('2027-01-01')
    expect(stepDate('2026-02-25', 'WEEKLY')).toBe('2026-03-04')
    expect(stepDate('2026-02-25', 'FORTNIGHTLY')).toBe('2026-03-11')
  })
})

// ---------------------------------------------------------------- time-driven behaviour

describe('expiry', () => {
  it('a pending CREATE times out after 6 days: action TIMED_OUT, mandate CANCELLED, MCRX to both (PLATFORM)', async () => {
    const creditor = await newAccount()
    const debtor = await newAccount()
    const id = await createMandate(creditor, { accountId: debtor.accountHayId! })
    await clearNotifications()
    await advanceClock(6 * DAY_MS - 1000)
    expect(svc.get(id).status).toBe('CREATED')
    await advanceClock(2000)
    expect(svc.get(id)).toMatchObject({ status: 'CANCELLED', cxStatus: 'CANCELLED_AUTHORISATION_TIMED_OUT' })
    expect((await actions(id))[0]).toMatchObject({ type: 'CREATE', status: 'TIMED_OUT', cxEventNameResolution: 'Payment agreement expired' })
    const events = await mandateEvents(id)
    expect(events.map((e) => [e.customerHayId, e.mandateEventDto.trigger, e.actionOwner])).toEqual([[creditor.accountHolderId, 'MCRX', 'PLATFORM'], [debtor.accountHolderId, 'MCRX', 'PLATFORM']])
    await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
  })

  it('a pending AMEND times out with MAMX and the mandate stays ACTIVE', async () => {
    const { id, creditor, debtor } = await activeMandate({ terms: { frequency: 'MONTHLY', type: 'VARIABLE', firstPayment: { date: '2035-01-10' } } })
    expect((await patch(`/v1/payto/initiator/mandates/${id}/payment_terms`, { validityEndDate: '2040-01-01' })).statusCode).toBe(200)
    await clearNotifications()
    await advanceClock(7 * DAY_MS)
    expect(svc.get(id).status).toBe('ACTIVE')
    expect((await actions(id)).at(-1)).toMatchObject({ type: 'AMEND', status: 'TIMED_OUT', cxEventNameResolution: 'Updated payment terms expired' })
    expect((await mandateEvents(id)).map((e) => [e.customerHayId, e.mandateEventDto.trigger])).toEqual([[creditor.accountHolderId, 'MAMX'], [debtor.accountHolderId, 'MAMX']])
    await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
  })

  it('a mandate is cancelled (CTEX) once the date passes validityEndDate', async () => {
    const now = await today()
    const { id } = await activeMandate({ overrides: { validityEndDate: plusDays(now, 1) } })
    await advanceClock(DAY_MS)
    expect(svc.get(id).status).toBe('ACTIVE')
    await advanceClock(DAY_MS)
    expect(svc.get(id)).toMatchObject({ status: 'CANCELLED', cxStatus: 'CANCELLED' })
    expect((await actions(id)).at(-1)).toMatchObject({ type: 'STATUS_CHANGE', details: { statusChange: { change: 'CANCEL', reasonCode: 'CTEX', reasonDescription: 'Contract expired' } } })
    expect((await mandateEvents(id)).at(-1)).toMatchObject({ actionOwner: 'PLATFORM', mandateEventDto: { trigger: 'MSCH' } })
    await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
  })

  it('closing the creditor or debtor account cancels its mandates (AC04)', async () => {
    const debtor = await newAccount()
    const { id } = await activeMandate({ debtor })
    const other = await createMandate(await newAccount(), { accountId: debtor.accountHayId! })
    const close = await app.inject({ method: 'POST', url: `/v0/accounts/${debtor.accountHayId}/close`, payload: { reason: 'CUSTOMER' } })
    expect(close.statusCode, close.body).toBe(202)
    await flush()
    expect((await getAccount(debtor.accountHayId!)).status).toBe('CLOSED')
    for (const m of [id, other]) {
      expect(svc.get(m).status, m).toBe('CANCELLED')
      expect((await actions(m)).at(-1)).toMatchObject({ type: 'STATUS_CHANGE', details: { statusChange: { change: 'CANCEL', reasonCode: 'AC04' } } })
    }
    expect((await actions(other))[0]).toMatchObject({ type: 'CREATE', status: 'TIMED_OUT' })
  })
})

// ---------------------------------------------------------------- mock notifications (for utilities)

describe('emitMandateNotification (mock generators)', () => {
  it('sends the requested trigger to one side and applies the MMS state it implies', async () => {
    const creditor = await newAccount()
    const debtor = await newAccount()
    const id = await createMandate(creditor, { accountId: debtor.accountHayId! })
    await clearNotifications()
    svc.emitMandateNotification('INITIATOR', mmsId(id), 'MCRC', { actionId: mmsId((await actions(id))[0]!.actionIdentification) })
    expect(svc.get(id).status).toBe('ACTIVE')
    expect((await actions(id))[0]!.status).toBe('COMPLETED')
    let events = await mandateEvents(id)
    // the resolution itself informed the Initiator (MCRC, PLATFORM) and the mock sent its own MCRC
    expect(events.map((e) => [e.customerHayId, e.mandateEventDto.trigger, e.actionOwner])).toEqual([[creditor.accountHolderId, 'MCRC', 'PLATFORM'], [creditor.accountHolderId, 'MCRC', 'PLATFORM']])
    expect(events[1].mandateEventDto).toEqual({ mandateId: id, actionId: (await actions(id))[0]!.actionIdentification, description: 'Mandate create confirmed', trigger: 'MCRC' })
    await clearNotifications()
    svc.emitMandateNotification('PAYER', id, 'MSCH', { description: 'Custom text', actionOwner: 'CLIENT' })
    events = await mandateEvents(id)
    expect(events).toEqual([{ customerHayId: debtor.accountHolderId, idempotencyKey: expect.any(String), type: 'MANDATE', actionOwner: 'CLIENT', mandateEventDto: { mandateId: id, actionId: expect.any(String), description: 'Custom text', trigger: 'MSCH' } }])
    assertValidNotification(events[0], 'v0')
    expect(svc.get(id).status).toBe('ACTIVE')
    // a Payer-side notification on a mandate whose debtor is external falls back to the Initiator's customer
    const external = await createMandate(creditor, { accountNumber: EXTERNAL_DEBTOR })
    await clearNotifications()
    svc.emitMandateNotification('PAYER', external, 'MCRT')
    expect((await mandateEvents(external)).map((e) => e.customerHayId)).toEqual([creditor.accountHolderId])
    svc.emitMandateNotification('INITIATOR', external, 'MCRD')
    expect(svc.get(external).status).toBe('CANCELLED')
    expect(() => svc.emitMandateNotification('PAYER', UNKNOWN_ID, 'MCRT')).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => svc.emitMandateNotification('PAYER', 'not-an-id', 'MCRT')).toThrow(expect.objectContaining({ status: 404 }))
  })

  it('creates an unknown mandate from the mock mandateDetails (an external Initiator reaching a local Payer)', async () => {
    const debtor = await newAccount({ fund: 40 })
    const id = mmsId('1212c423-262b-11ee-844d-95ee6a0c000c')
    await clearNotifications()
    const m = svc.emitMandateNotification('PAYER', id, 'MCRT', {
      mandateDetails: {
        mandateId: id,
        creditorInformation: { accountIdentification: '08201699999999' },
        debtorInformation: { accountIdentification: `${LOCAL_BSB}${debtor.accountNumber}` },
        description: 'From the MMS',
        paymentInformation: { paymentFrequency: 'MNTH', paymentAmountType: 'FIXE', amount: '25.00', firstPaymentDate: '2035-02-01' },
        validityStartDate: '2025-01-01',
        validityEndDate: '2040-01-01',
      },
    })
    expect(m).toMatchObject({ id: '1212c423-262b-11ee-844d-95ee6a0c000c', status: 'CREATED', debtor: { accountId: debtor.accountHayId, accountNumber: `${LOCAL_BSB}${debtor.accountNumber}` }, creditor: { accountNumber: '08201699999999' }, paymentTerms: { frequency: 'MONTHLY', type: 'FIXED', amount: { amountCents: 2500, currency: 'AUD' }, firstPayment: { date: '2035-02-01' } } })
    expect((await mandateEvents(m.id)).map((e) => [e.customerHayId, e.mandateEventDto.trigger])).toEqual([[debtor.accountHolderId, 'MCRT']])
    const read = await getMandate(m.id)
    expect(read.creditorDetails).toBeUndefined()
    expect(read).toMatchObject({ status: 'CREATED', description: 'From the MMS', validityStartDate: '2025-01-01', paymentTerms: { frequency: 'MONTHLY', type: 'FIXED', amount: AUD(25) } })
    // the local Payer resolves it like any other, the Initiator side has nobody to notify
    await clearNotifications()
    expect((await patch(`/v1/payto/payer/mandates/${m.id}/resolve?resolution=ACCEPT`)).statusCode).toBe(200)
    expect(svc.get(m.id).status).toBe('ACTIVE')
    expect((await allPayloads()).map((p) => p.type)).toEqual(['MANDATE_DUE_PAYMENT'])
    const search = await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${LOCAL_BSB}${debtor.accountNumber}&pageNumber=1&pageSize=10` })
    expect(search.json().result.map((r: { mandateId: string }) => r.mandateId)).toEqual([m.id])
    // an inbound RAPAIN on it settles the debtor leg only
    const r = svc.receivePaymentInstruction({ mandateId: id, instructionId: `${BIC}I20230801000000000079280`, amountCents: 2500, initiatingPartyName: 'EXT', status: 'ACCP' })
    expect(r.instruction.status).toBe('ACCEPTED_AND_SETTLED')
    expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(15)
  })
})

// ---------------------------------------------------------------- webhook contract

describe('webhook contract', () => {
  it('every notification emitted by this domain validates against wh:NotificationDto', async () => {
    await clearNotifications()
    const debtor = await newAccount({ fund: 100 })
    const { id } = await activeMandate({ debtor })
    await adhoc(id, { amount: AUD(1) })
    await patch(`/v1/payto/initiator/mandates/${id}/suspend`, { reasonCode: 'MD17' })
    await patch(`/v1/payto/initiator/mandates/${id}/release`)
    await patch(`/v1/payto/initiator/mandates/${id}/cancel`, {})
    const monthly = await activeMandate({ debtor, terms: { frequency: 'MONTHLY', type: 'VARIABLE', firstPayment: { date: '2035-01-10' } } })
    await patch(`/v1/payto/initiator/mandates/${monthly.id}/payment_terms`, { validityEndDate: '2040-01-01' })
    await patch(`/v1/payto/payer/mandates/${monthly.id}/resolve?resolution=REJECT`)
    await flush()
    const res = await app.inject({ method: 'GET', url: '/_admin/notifications?limit=1000' })
    const rows = res.json() as { version: string; type: string; payload: unknown }[]
    // account / customer set-up and the creditor's first posting add their own (other domains') notifications
    expect([...new Set(rows.map((r) => r.type))]).toEqual(expect.arrayContaining(['MANDATE', 'MANDATE_DUE_PAYMENT', 'MANDATE_PAYMENT', 'TRANSACTION']))
    for (const r of rows) {
      expect(r.version).toBe('v0')
      assertValidNotification(r.payload, 'v0')
    }
  })
})
