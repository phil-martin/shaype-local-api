import { randomUUID } from 'node:crypto'
import { Ajv, type ValidateFunction } from 'ajv'
import addFormatsModule from 'ajv-formats'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getOperation, requestComponents } from '../src/contract/index.js'
import type { components } from '../src/contract/generated/b2b-types.js'
import { startApp } from './helpers.js'
import { assertValidNotification } from './webhook-schema.js'
import type { BuiltServer } from '../src/server.js'
import { LOCAL_PRODUCT_ID } from '../src/domains/accounts/index.js'
import { LOCAL_BSB } from '../src/lib/ids.js'
import { ACCOUNT_DETAILS_INCORRECT, BIC, mmsId, normaliseMandateId, nthDueDate, parseTrajectory, stepDate, v1Uuid, type PayToService } from '../src/domains/payto/index.js'
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
  it('accepts both encodings (hyphenated and 32-hex MMS form) on every input and serves the hyphenated v1 layout', async () => {
    const creditor = await newAccount()
    const debtor = await newAccount({ fund: 20 })
    const id = await createMandate(creditor, { accountId: debtor.accountHayId! })
    expect(id).toMatch(UUID_V1_RE)
    expect(mmsId(id)).toMatch(/^[a-f0-9]{12}1[a-f0-9]{3}[89ab][a-f0-9]{15}$/)
    expect(normaliseMandateId(mmsId(id).toUpperCase())).toBe(id)
    expect(svc.get(mmsId(id)).id).toBe(id)
    expect(svc.get(id.toUpperCase()).id).toBe(id)
    // path parameters: the 32-hex form reaches the domain although the contract declares `format: uuid`
    for (const form of [mmsId(id), mmsId(id).toUpperCase(), id.toUpperCase()]) {
      const res = await app.inject({ method: 'GET', url: `/v1/payto/mandates/${form}` })
      expect(res.statusCode, form).toBe(200)
      expect(res.json().mandateId).toBe(id)
    }
    expect((await patch(`/v1/payto/payer/mandates/${mmsId(id)}/resolve?resolution=ACCEPT`)).statusCode).toBe(200)
    expect((await actions(mmsId(id), 'payer')).map((a) => a.mandateIdentification)).toEqual([id])
    // body mandateId (makeAdhocPayment)
    const paid = await adhoc(mmsId(id), { amount: AUD(2) })
    expect(paid).toMatchObject({ mandateId: id, transactionStatus: 'ACCEPTED_AND_SETTLED' })
    const status = await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${mmsId(id)}/instructions/${paid.instructionId}/status` })
    expect(status.json()).toEqual({ transactionStatus: 'ACCEPTED_AND_SETTLED' })
    // anything else is still a schema violation
    for (const bad of ['not-a-mandate', `${mmsId(id)}0`, mmsId(id).slice(1)]) {
      const res = await app.inject({ method: 'GET', url: `/v1/payto/mandates/${bad}` })
      expect(res.statusCode, bad).toBe(400)
    }
    const missing = await app.inject({ method: 'GET', url: `/v1/payto/mandates/${UNKNOWN_ID}` })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().message).toBe(`NOT_FOUND: Mandate ${UNKNOWN_ID} not found`)
    expect((await app.inject({ method: 'GET', url: `/v1/payto/mandates/${mmsId(UNKNOWN_ID)}` })).statusCode).toBe(404)
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
    // "For the debtor, any BSB can be used when creating a mandate": checkBsbIsSupportedByPayTo stays advisory
    for (const accountNumber of ['00000012345678', '99999912345678']) {
      const unsupported = await getMandate(await createMandate(creditor, { accountNumber }))
      expect(unsupported.debtorDetails, accountNumber).toEqual({ accountNumber, partyName: 'JOHN MAXIMILLIAN DOE', partyType: 'PERSON' })
    }
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
      [mandateBody(creditor, { accountNumber: `${LOCAL_BSB}99999999` }), 422, new RegExp(`^${ACCOUNT_DETAILS_INCORRECT('Debtor').replace(/[()]/g, '\\$&')}`)],
      [mandateBody(creditor, { accountId: UNKNOWN_ID }), 422, /Debtor account details incorrect/],
      [mandateBody(creditor, { accountNumber: '0820161234567A' }), 400, /6-digit BSB followed by/],
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { paymentTerms: { frequency: 'ADHOC', type: 'VARIABLE', maximumAmount: { currency: 'USD', amount: 5 } } }), 422, /^INVALID_CURRENCY:/],
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { paymentTerms: { frequency: 'ADHOC', type: 'VARIABLE', maximumAmount: AUD(5.123) } }), 400, /at most 2 decimal places/],
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { paymentTerms: { frequency: 'ADHOC', type: 'VARIABLE', amount: AUD(0) } }), 400, /greater than 0/],
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { validityEndDate: '2020-10-05' }), 422, /validityEndDate must not precede/],
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { resolutionRequestedBy: 'tomorrow' }), 400, /resolutionRequestedBy/],
      // served in actions[].resolutionRequestedBy, whose spec pattern allows real calendar dates and at most 3 fractional digits
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { resolutionRequestedBy: '2030-02-30T10:00:00.000Z' }), 400, /resolutionRequestedBy/],
      [mandateBody(creditor, { accountId: debtor.accountHayId! }, { resolutionRequestedBy: '2030-02-28T10:00:00.123456Z' }), 400, /resolutionRequestedBy/],
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

  it('identifies a creditor by alias alone (PayID or the staging <bsb><account>@domain form) and debtors by the staging alias form', async () => {
    const creditor = await newAccount()
    const debtor = await newAccount()
    const bodyWithCreditorAlias = (alias: string, type: 'EMAIL_ADDRESS' | 'PHONE_NUMBER' = 'EMAIL_ADDRESS') => {
      const body = mandateBody(creditor, { accountId: debtor.accountHayId! })
      return { ...body, creditorDetails: { accountAliasIdentification: alias, accountAliasType: type, partyType: 'ORGANISATION' as const } }
    }
    // staging form: the alias carries the BSB + account number
    const staging = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: bodyWithCreditorAlias(`${LOCAL_BSB}${creditor.accountNumber}@payto.example`) })
    expect(staging.statusCode, staging.body).toBe(200)
    expect((await getMandate(staging.json().mandateId)).creditorDetails).toEqual({ accountId: creditor.accountHayId, partyType: 'ORGANISATION' })
    // a PayID registered on the creditor account
    const payId = `acme-${randomUUID().slice(0, 8)}@example.com`
    const reg = await app.inject({ method: 'POST', url: `/v1/accounts/${creditor.accountHayId}/payids/${encodeURIComponent(payId)}/register`, payload: { ownerName: 'ACME', payIdName: 'Main', payIdType: 'EMAIL' } })
    expect(reg.statusCode, reg.body).toBe(200)
    const byPayId = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: bodyWithCreditorAlias(payId) })
    expect(byPayId.statusCode, byPayId.body).toBe(200)
    expect(svc.mandateIdsForCreditorAccount(creditor.accountHayId!)).toEqual([staging.json().mandateId, byPayId.json().mandateId])
    // unresolvable aliases are the documented creditor rejection; a lone alias field is still a schema violation
    for (const alias of ['nobody@example.com', `08201612345678@payto.example`, `${LOCAL_BSB}99999999@payto.example`]) {
      const res = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: bodyWithCreditorAlias(alias) })
      expect(res.statusCode, alias).toBe(422)
      expect(res.json().message).toBe(ACCOUNT_DETAILS_INCORRECT('Creditor'))
    }
    const lone = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: { ...mandateBody(creditor, { accountId: debtor.accountHayId! }), creditorDetails: { accountAliasIdentification: payId } } })
    expect(lone.statusCode).toBe(400)
    const badType = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: { ...mandateBody(creditor, { accountId: debtor.accountHayId! }), creditorDetails: { accountAliasIdentification: payId, accountAliasType: 'PAYID' } } })
    expect(badType.statusCode).toBe(400)

    // debtor aliases: the staging form resolves a local account, a foreign BSB stays an external debtor
    const local = await getMandate(await createMandate(creditor, { accountAliasIdentification: `${LOCAL_BSB}${debtor.accountNumber}@payto.example`, accountAliasType: 'EMAIL_ADDRESS' }))
    expect(local.debtorDetails).toMatchObject({ accountId: debtor.accountHayId, accountNumber: `${LOCAL_BSB}${debtor.accountNumber}` })
    const foreign = await getMandate(await createMandate(creditor, { accountAliasIdentification: `${EXTERNAL_DEBTOR}@payto.example`, accountAliasType: 'EMAIL_ADDRESS' }))
    expect(foreign.debtorDetails).toEqual({ accountNumber: EXTERNAL_DEBTOR, partyName: 'JOHN MAXIMILLIAN DOE', partyType: 'PERSON' })
  })

  it('refuses a debtor account equal to the creditor account and amounts above maximumAmount', async () => {
    const creditor = await newAccount()
    const same = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: mandateBody(creditor, { accountId: creditor.accountHayId! }) })
    expect(same.statusCode).toBe(422)
    expect(same.json().message).toBe('INVALID_ARGUMENT: the debtor account must differ from the creditor account')
    for (const [terms, field] of [
      [{ frequency: 'ADHOC', type: 'FIXED', amount: AUD(10.01), maximumAmount: AUD(10) }, 'amount'],
      [{ frequency: 'MONTHLY', type: 'BALLOON', amount: AUD(5), maximumAmount: AUD(10), lastPayment: { amount: AUD(50), date: '2031-01-01' } }, 'lastPayment.amount'],
      [{ frequency: 'MONTHLY', type: 'FIXED', maximumAmount: AUD(10), firstPayment: { amount: AUD(11), date: '2030-01-01' } }, 'firstPayment.amount'],
    ] as const) {
      const res = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: mandateBody(creditor, { accountNumber: EXTERNAL_DEBTOR }, { paymentTerms: terms as CreateMandateBody['paymentTerms'] }) })
      expect(res.statusCode, field).toBe(422)
      expect(res.json().message).toBe(`INVALID_ARGUMENT: paymentTerms.${field} must not exceed paymentTerms.maximumAmount`)
    }
    expect(svc.mandateIdsForCreditorAccount(creditor.accountHayId!)).toEqual([])
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
    // a platform account id is matched against the debtor account too
    const byId = await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${debtor.accountHayId}&accountIds=${LOCAL_BSB}${other.accountNumber}&statuses=CREATED&statuses=ACTIVE&pageNumber=1&pageSize=50` })
    expect(byId.json().totalCount).toBe(4)
    const cancelled = await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${debtor.accountHayId}&statuses=CANCELLED&pageNumber=1&pageSize=50` })
    expect(cancelled.json()).toEqual({ totalCount: 0, result: [] })
    const beyond = await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${number}&pageNumber=3&pageSize=2` })
    expect(beyond.json()).toEqual({ totalCount: 3, result: [] })
    expect((await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${number}&statuses=PAUSED&pageNumber=1&pageSize=5` })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v1/payto/mandates?pageNumber=1&pageSize=5' })).statusCode).toBe(400)
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

describe('remaining status-machine rows', () => {
  it('Payer cancels an ACTIVE mandate; the Initiator cancels a SUSPENDED one and recalls a pending amendment with it', async () => {
    const byPayer = await activeMandate()
    expect((await patch(`/v1/payto/payer/mandates/${byPayer.id}/cancel`, { reasonCode: 'MD16' })).statusCode).toBe(200)
    expect(svc.get(byPayer.id)).toMatchObject({ status: 'CANCELLED', cxStatus: 'CANCELLED' })
    expect((await actions(byPayer.id, 'payer')).at(-1)).toMatchObject({ type: 'STATUS_CHANGE', creationEvent: { partyRole: 'DEBTOR' }, details: { statusChange: { change: 'CANCEL', reasonCode: 'MD16' } } })
    expect((await mandateEvents(byPayer.id)).slice(-2).map((e) => [e.customerHayId, e.mandateEventDto.trigger])).toEqual([[byPayer.creditor.accountHolderId, 'MSCH'], [byPayer.debtor.accountHolderId, 'MSCH']])

    const terms: CreateMandateBody['paymentTerms'] = { frequency: 'MONTHLY', type: 'VARIABLE', firstPayment: { date: '2035-01-10' } }
    const { id } = await activeMandate({ terms })
    expect((await patch(`/v1/payto/initiator/mandates/${id}/payment_terms`, { validityEndDate: '2040-01-01' })).statusCode).toBe(200)
    expect((await patch(`/v1/payto/initiator/mandates/${id}/suspend`, {})).statusCode).toBe(200)
    expect(svc.schedule(id)).toBeDefined()
    expect((await patch(`/v1/payto/initiator/mandates/${id}/cancel`, { reasonCode: 'MD17', reasonDescription: 'Requested by initiating party' })).statusCode).toBe(200)
    expect(svc.get(id)).toMatchObject({ status: 'CANCELLED', cxStatus: 'CANCELLED_BY_PAYMENT_INITIATOR' })
    expect(svc.schedule(id)).toBeUndefined()
    expect((await actions(id)).map((a) => [a.type, a.status])).toEqual([['CREATE', 'COMPLETED'], ['AMEND', 'RECALLED'], ['STATUS_CHANGE', 'COMPLETED'], ['STATUS_CHANGE', 'COMPLETED']])
    expect(await actions(id, 'initiator', '?pendingOnly=true')).toEqual([])
  })

  it('a suspension by the debtor\'s institution (platform) can be released by neither party', async () => {
    const { id } = await activeMandate()
    await clearNotifications()
    svc.transition(id, 'SUSPENDED', { side: 'PLATFORM', change: 'SUSPEND', reasonCode: 'MSUC', reasonDescription: 'Mandate suspended after 7 consecutive unsuccessful collections' })
    expect(svc.get(id)).toMatchObject({ status: 'SUSPENDED', cxStatus: 'PAUSED_BY_PAYER_INSTITUTION', suspendedBy: 'PLATFORM' })
    expect((await mandateEvents(id)).map((e) => [e.mandateEventDto.trigger, e.actionOwner])).toEqual([['MSCH', 'PLATFORM'], ['MSCH', 'PLATFORM']])
    for (const side of ['initiator', 'payer']) {
      const res = await patch(`/v1/payto/${side}/mandates/${id}/release`)
      expect(res.statusCode, side).toBe(422)
      expect(res.json().message).toBe(`INVALID_STATE: Mandate ${id} was suspended by the debtor's institution and can only be released by them.`)
    }
    // a suspended mandate is not payable
    expect((await adhoc(id, { amount: AUD(1) })).transactionStatus).toBe('REJECTED')
    expect(svc.instructions(id)[0]!.reasonCode).toBe('AG01')
    expect((await patch(`/v1/payto/initiator/mandates/${id}/cancel`, {})).statusCode).toBe(200)
  })

  it('closing the creditor account cancels its mandates too', async () => {
    const creditor = await newAccount()
    const { id } = await activeMandate({ creditor })
    const close = await app.inject({ method: 'POST', url: `/v0/accounts/${creditor.accountHayId}/close`, payload: { reason: 'CUSTOMER' } })
    expect(close.statusCode, close.body).toBe(202)
    await flush()
    expect(svc.get(id)).toMatchObject({ status: 'CANCELLED' })
    expect((await actions(id)).at(-1)).toMatchObject({ type: 'STATUS_CHANGE', details: { statusChange: { change: 'CANCEL', reasonCode: 'AC04' } } })
    // the closed account can no longer create mandates
    const again = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: mandateBody(creditor, { accountNumber: EXTERNAL_DEBTOR }) })
    expect(again.statusCode).toBe(422)
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

describe('amendments never make the creditor and debtor account the same', () => {
  it('refuses moving the creditor onto the debtor account and the debtor onto the creditor account (as createMandate does)', async () => {
    const holder = await newCustomer()
    const creditor = await newAccount({ holder, fund: 1 })
    const debtor = await newAccount({ holder, fund: 1 })
    const { id } = await activeMandate({ creditor, debtor })
    const byInitiator = await app.inject({ method: 'PUT', url: `/v1/payto/initiator/mandates/${id}`, payload: { creditorAccountId: debtor.accountHayId } })
    expect(byInitiator.statusCode).toBe(422)
    expect(byInitiator.json().message).toBe('INVALID_ARGUMENT: the debtor account must differ from the creditor account')
    const byPayer = await app.inject({ method: 'PUT', url: `/v1/payto/payer/mandates/${id}`, payload: { debtorAccountId: creditor.accountHayId } })
    expect(byPayer.statusCode).toBe(422)
    expect(byPayer.json().message).toBe('INVALID_ARGUMENT: the debtor account must differ from the creditor account')
    expect(await getMandate(id)).toMatchObject({ creditorDetails: { accountId: creditor.accountHayId }, debtorDetails: { accountId: debtor.accountHayId } })
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

  it('refuses an account that is not ACTIVE, an unknown account and a mandate that is not ACTIVE / SUSPENDED', async () => {
    const holder = await newCustomer()
    const debtor = await newAccount({ holder })
    const approved = await newAccount({ holder })
    const funded = await newAccount({ holder, fund: 5 })
    const { id, creditor } = await activeMandate({ debtor })
    const put = (mandateId: string, debtorAccountId: string) => app.inject({ method: 'PUT', url: `/v1/payto/payer/mandates/${mandateId}`, payload: { debtorAccountId } })
    const notActive = await put(id, approved.accountHayId!)
    expect(notActive.statusCode).toBe(422)
    expect(notActive.json().message).toMatch(/^INVALID_ACCOUNT_STATUS: .*must be ACTIVE/)
    expect((await put(id, UNKNOWN_ID)).statusCode).toBe(404)
    expect((await app.inject({ method: 'PUT', url: `/v1/payto/payer/mandates/${id}`, payload: {} })).statusCode).toBe(400)
    const created = await createMandate(creditor, { accountId: debtor.accountHayId! })
    const notAmendable = await put(created, funded.accountHayId!)
    expect(notAmendable.statusCode).toBe(422)
    expect(notAmendable.json().message).toMatch(/is CREATED; to amend a mandate it must be ACTIVE or SUSPENDED/)
    expect((await patch(`/v1/payto/initiator/mandates/${id}/cancel`, {})).statusCode).toBe(200)
    expect((await put(id, funded.accountHayId!)).statusCode).toBe(422)
    expect((await getMandate(id)).debtorDetails.accountId).toBe(debtor.accountHayId)
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

  it('an accepted amendment replaces the payment terms (the request carries full terms): fields it leaves out are gone', async () => {
    const debtor = await newAccount({ fund: 2000 })
    const { id } = await activeMandate({ debtor })
    expect((await getMandate(id)).paymentTerms).toEqual({ frequency: 'ADHOC', type: 'VARIABLE', maximumAmount: AUD(900) })
    expect((await patch(`/v1/payto/initiator/mandates/${id}/payment_terms`, { paymentTerms: { frequency: 'ADHOC', type: 'VARIABLE', amount: AUD(1000) } })).statusCode).toBe(200)
    expect((await patch(`/v1/payto/payer/mandates/${id}/resolve?resolution=ACCEPT`)).statusCode).toBe(200)
    expect((await getMandate(id)).paymentTerms).toEqual({ frequency: 'ADHOC', type: 'VARIABLE', amount: AUD(1000) })
    // the agreed amount is payable: no stale maximumAmount below it
    expect((await adhoc(id, { amount: undefined })).transactionStatus).toBe('ACCEPTED_AND_SETTLED')
    expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(1000)
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
      [{ validityEndDate: '2040-01-01', resolutionRequestedBy: '2031-04-31T00:00:00.000Z' }, 400, /resolutionRequestedBy/],
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

    expect((await adhoc(id, { amount: { currency: 'NZD', amount: 1 } })).transactionStatus).toBe('REJECTED')
    expect(svc.instructions(id)[0]!.reasonCode).toBe('AM03')
    expect((await adhoc(id, { amount: AUD(0) })).transactionStatus).toBe('REJECTED')
    expect(svc.instructions(id)[0]!.reasonCode).toBe('AM01')

    expect((await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId: UNKNOWN_ID, amount: AUD(1) } })).statusCode).toBe(404)
    for (const payload of [{ amount: AUD(1.005) }, { amount: AUD(-1) }, { endToEndId: '' }, { endToEndId: 'x'.repeat(36) }, { mandateId: 'nope' }, { idempotencyKey: undefined }]) {
      const res = await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId: id, amount: AUD(1), ...payload } })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      expect(res.json().message).toMatch(/^BAD_REQUEST:/)
    }
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

describe('staging payment trajectories (paymentstatus: hints)', () => {
  async function status(mandateId: string, instructionId: string) {
    const res = await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${mandateId}/instructions/${instructionId}/status` })
    expect(res.statusCode, res.body).toBe(200)
    return res.json()
  }

  it('parseTrajectory reads paymentstatus:<initial>[&<final>] and timeout_rjct from the first text carrying one', () => {
    expect(parseTrajectory('Electricity')).toBeUndefined()
    expect(parseTrajectory(undefined, 'paymentstatus:sent&undv')).toEqual({ initial: 'SENT', final: 'UNDELIVERED' })
    expect(parseTrajectory('bill paymentstatus:SAFD please')).toEqual({ initial: 'STORE_AND_FORWARD' })
    expect(parseTrajectory('paymentstatus:recv&rjct')).toEqual({ initial: 'RECEIVED', final: 'REJECTED' })
    expect(parseTrajectory('paymentstatus:timeout_rjct')).toEqual({ initial: 'REJECTED' })
    expect(parseTrajectory('paymentstatus:acsc')).toEqual({ initial: 'ACCEPTED_AND_SETTLED' })
    expect(parseTrajectory('paymentstatus:nope', 'paymentstatus:accp&zzzz')).toEqual({ initial: 'ACCEPTED_FOR_CLEARANCE' })
    expect(parseTrajectory('paymentstatus:undv', 'paymentstatus:sent')).toEqual({ initial: 'UNDELIVERED' })
  })

  it('a non-final initial status is answered at once (no MANDATE_PAYMENT), then reaches its final status asynchronously', async () => {
    const debtor = await newAccount({ fund: 50 })
    const { id, creditor } = await activeMandate({ debtor, overrides: { description: 'Utility paymentstatus:sent&undv' } })
    await clearNotifications()
    svc.paymentProgressDelayMs = DAY_MS
    try {
      const res = await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId: id, amount: AUD(5) } })
      expect(res.json()).toMatchObject({ transactionStatus: 'SENT', transactionStatusDisplay: 'Sent', statusIsFinal: false, message: 'Adhoc payment executed successfully.' })
      const { instructionId } = res.json() as AdhocResponse
      expect(await status(id, instructionId)).toEqual({ transactionStatus: 'SENT' })
      expect((await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/search` })).json().paymentInstructions[0]).toMatchObject({ id: instructionId, transactionStatus: 'SENT' })
      await advanceClock(DAY_MS)
      expect(await status(id, instructionId)).toEqual({ transactionStatus: 'UNDELIVERED' })
      const events = await paymentEvents(id)
      expect(events).toEqual([{ customerHayId: creditor.accountHolderId, idempotencyKey: expect.any(String), type: 'MANDATE_PAYMENT', actionOwner: 'PLATFORM', mandatePaymentEventDto: { instructionId, mandateId: id, paymentStatus: 'MANDATE_PAYMENT_UNDELIVERED', isFinal: true, originId: id, originType: 'MANDATE_PAYMENT' } }])
      assertValidNotification(events[0], 'v0')
      expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(50)
    } finally {
      svc.paymentProgressDelayMs = undefined
      await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
    }
  })

  it('a single non-final hint settles afterwards; a hint on the payment description overrides the mandate\'s; recv&rjct rejects with AB01', async () => {
    const debtor = await newAccount({ fund: 50 })
    const { id } = await activeMandate({ debtor, overrides: { description: 'paymentstatus:safd' } })
    await clearNotifications()
    svc.paymentProgressDelayMs = DAY_MS
    try {
      const safd = await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId: id, amount: AUD(5) } })
      expect(safd.json()).toMatchObject({ transactionStatus: 'STORE_AND_FORWARD', transactionStatusDisplay: 'Store & Forward', statusIsFinal: false })
      expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(50)
      await advanceClock(DAY_MS)
      expect(await status(id, safd.json().instructionId)).toEqual({ transactionStatus: 'ACCEPTED_AND_SETTLED' })
      expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(45)
      const settled = (await allPayloads()).filter((p) => p.type === 'TRANSACTION' || p.type === 'MANDATE_PAYMENT')
      expect(settled.map((p) => [p.type, p.actionOwner])).toEqual([['TRANSACTION', 'PLATFORM'], ['TRANSACTION', 'PLATFORM'], ['MANDATE_PAYMENT', 'PLATFORM']])

      const recv = await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId: id, amount: AUD(5), description: 'paymentstatus:recv&rjct' } })
      expect(recv.json()).toMatchObject({ transactionStatus: 'RECEIVED', transactionStatusDisplay: 'Received', statusIsFinal: false })
      await advanceClock(DAY_MS)
      expect(await status(id, recv.json().instructionId)).toEqual({ transactionStatus: 'REJECTED', transactionStatusReasonCode: 'AB01' })
      expect((await paymentEvents(id)).at(-1).mandatePaymentEventDto).toMatchObject({ instructionId: recv.json().instructionId, paymentStatus: 'MANDATE_PAYMENT_REJECTED', reasonCode: 'AB01' })
      expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(45)

      const timeout = await adhoc(id, { amount: AUD(5), description: 'paymentstatus:timeout_rjct' })
      expect(timeout).toMatchObject({ transactionStatus: 'REJECTED', statusIsFinal: true })
      expect(await status(id, timeout.instructionId)).toEqual({ transactionStatus: 'REJECTED', transactionStatusReasonCode: 'AB01' })
      // the agreement checks run first: a hint does not rescue a payment above maximumAmount
      const tooMuch = await adhoc(id, { amount: AUD(1000), description: 'paymentstatus:sent&acsc' })
      expect(tooMuch).toMatchObject({ transactionStatus: 'REJECTED', statusIsFinal: true })
      expect(svc.instructions(id)[0]!.reasonCode).toBe('AM21')
      // a settlement the ledger refuses after the hint is still a rejection with the ledger's reason
      const poor = await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId: id, amount: AUD(100), description: 'paymentstatus:accp' } })
      expect(poor.json().transactionStatus).toBe('ACCEPTED_FOR_CLEARANCE')
      await advanceClock(DAY_MS)
      expect(await status(id, poor.json().instructionId)).toEqual({ transactionStatus: 'REJECTED', transactionStatusReasonCode: 'AM04' })
    } finally {
      svc.paymentProgressDelayMs = undefined
      await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
    }
  })

  it('an in-flight payment never settles once its mandate is no longer ACTIVE (cancelled or suspended meanwhile): REJECTED AG01', async () => {
    const debtor = await newAccount({ fund: 50 })
    const cancelled = await activeMandate({ debtor })
    const suspended = await activeMandate({ debtor })
    await clearNotifications()
    svc.paymentProgressDelayMs = DAY_MS
    try {
      const pay = async (mandateId: string) => {
        const res = await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId, amount: AUD(5), description: 'paymentstatus:sent' } })
        expect(res.json().transactionStatus).toBe('SENT')
        return res.json().instructionId as string
      }
      const a = await pay(cancelled.id)
      const b = await pay(suspended.id)
      expect((await patch(`/v1/payto/initiator/mandates/${cancelled.id}/cancel`, {})).statusCode).toBe(200)
      expect((await patch(`/v1/payto/payer/mandates/${suspended.id}/suspend`, {})).statusCode).toBe(200)
      await advanceClock(DAY_MS)
      expect(await status(cancelled.id, a)).toEqual({ transactionStatus: 'REJECTED', transactionStatusReasonCode: 'AG01' })
      expect(await status(suspended.id, b)).toEqual({ transactionStatus: 'REJECTED', transactionStatusReasonCode: 'AG01' })
      expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(50)
      expect((await paymentEvents(cancelled.id)).map((e) => [e.mandatePaymentEventDto.paymentStatus, e.mandatePaymentEventDto.reasonCode])).toEqual([['MANDATE_PAYMENT_REJECTED', 'AG01']])
    } finally {
      svc.paymentProgressDelayMs = undefined
      await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
    }
  })

  it('an external debtor rejects with AB01 by default (the staging RJCT) but follows a hint that does not settle', async () => {
    const creditor = await newAccount()
    const external = await createMandate(creditor, { accountNumber: EXTERNAL_DEBTOR })
    svc.emitMandateNotification('INITIATOR', external, 'MCRC')
    const plain = await adhoc(external, { amount: AUD(1) })
    expect(plain).toMatchObject({ transactionStatus: 'REJECTED', statusIsFinal: true })
    const undelivered = await adhoc(external, { amount: AUD(1), description: 'paymentstatus:undv' })
    expect(undelivered).toMatchObject({ transactionStatus: 'UNDELIVERED', transactionStatusDisplay: 'Undelivered', statusIsFinal: true })
    const pending = await adhoc(external, { amount: AUD(1), description: 'paymentstatus:acsp&recv' })
    expect(pending).toMatchObject({ transactionStatus: 'SETTLEMENT_ABORTED', statusIsFinal: false })
    await flush()
    expect(await status(external, pending.instructionId)).toEqual({ transactionStatus: 'RECEIVED' })
    expect((await paymentEvents(external)).map((e) => e.mandatePaymentEventDto.paymentStatus)).toEqual(['MANDATE_PAYMENT_REJECTED', 'MANDATE_PAYMENT_UNDELIVERED'])
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

  it('the documented flow stubs a makeAdhocPayment instructionId: the search reports the stub (endToEndId joined from the payment), the instruction itself is untouched', async () => {
    const debtor = await newAccount({ fund: 20 })
    const { id } = await activeMandate({ debtor })
    const paid = await adhoc(id, { amount: AUD(3), endToEndId: 'NET-1724' })
    const search = async () => (await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/search` })).json().paymentInstructions
    const real = (await search())[0]
    svc.addStubInstructions(mmsId(id), [{ instructionIdentification: paid.instructionId, instructedAmount: 1.28, creationDateTime: '2023-11-29T12:33:59.833Z', transactionStatus: 'RECV', transactionStatusReasonCode: 'AB01' }])
    expect(await search()).toEqual([{ id: paid.instructionId, amount: 1.28, creationDateTime: '2023-11-29T12:33:59.833000Z', endToEndId: 'NET-1724', transactionStatus: 'RECEIVED', transactionStatusReasonCode: 'AB01' }])
    expect(svc.instruction(id, paid.instructionId)).toMatchObject({ origin: 'ADHOC', status: 'ACCEPTED_AND_SETTLED', amountCents: 300 })
    const status = await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/instructions/${paid.instructionId}/status` })
    expect(status.json()).toEqual({ transactionStatus: 'ACCEPTED_AND_SETTLED' })
    // the next stub replaces the earlier one: the real instruction is reported as it is again, not deleted
    svc.addStubInstructions(id, [{ instructionIdentification: `${BIC}I20231129000000000093420`, instructedAmount: 2, creationDateTime: '2023-11-29T12:33:59.833Z', transactionStatus: 'ACSC' }])
    expect((await search()).map((i: { id: string }) => i.id)).toEqual([`${BIC}I20231129000000000093420`, paid.instructionId])
    expect((await search())[1]).toEqual(real)
  })
})

describe('instruction ids', () => {
  it('a new instruction id skips ids already taken (by a RAPAIN or a stub) instead of failing with 500', async () => {
    const debtor = await newAccount({ fund: 50 })
    const { id } = await activeMandate({ debtor })
    const first = await adhoc(id, { amount: AUD(1) })
    const seq = Number(first.instructionId.slice(-13, -1))
    const idFor = (n: number) => `${first.instructionId.slice(0, -13)}${String(n).padStart(12, '0')}0`
    svc.receivePaymentInstruction({ mandateId: id, instructionId: idFor(seq + 1), amountCents: 100, status: 'ACCP' })
    svc.addStubInstructions(id, [{ instructionIdentification: idFor(seq + 2), instructedAmount: 1, creationDateTime: '2023-11-29T12:33:59.833Z', transactionStatus: 'ACSC' }])
    const next = await adhoc(id, { amount: AUD(1) })
    expect(next.transactionStatus).toBe('ACCEPTED_AND_SETTLED')
    expect([idFor(seq + 1), idFor(seq + 2)]).not.toContain(next.instructionId)
    expect(svc.instructions(id)).toHaveLength(4)
  })

  it('a scheduled payment that throws does not block the other due schedules of the tick', async () => {
    const now = await today()
    const debtor = await newAccount({ fund: 100 })
    const terms: CreateMandateBody['paymentTerms'] = { frequency: 'MONTHLY', type: 'FIXED', amount: AUD(1) }
    const a = await activeMandate({ debtor, terms, overrides: { validityStartDate: plusDays(now, 2) } })
    const b = await activeMandate({ debtor, terms, overrides: { validityStartDate: plusDays(now, 2) } })
    const spy = vi.spyOn(svc as unknown as { scheduledAmount: () => unknown }, 'scheduledAmount').mockImplementationOnce(() => { throw new Error('boom') })
    try {
      await advanceClock(3 * DAY_MS)
      // one schedule threw (and stays scheduled); the other was initiated in the same tick
      expect([svc.instructions(a.id).length, svc.instructions(b.id).length].sort()).toEqual([0, 1])
      await flush()
      expect([svc.instructions(a.id).length, svc.instructions(b.id).length]).toEqual([1, 1])
      expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(98)
    } finally {
      spy.mockRestore()
      await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
    }
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
    // an instruction id already final on this mandate is a no-op; one of another mandate is refused
    await clearNotifications()
    const replay = svc.receivePaymentInstruction({ mandateId: id, instructionId: `${BIC}I20230718000000000077260`, amountCents: 1, status: 'RJCT' })
    expect(replay.instruction).toMatchObject({ status: 'REJECTED', reasonCode: 'AM04', amountCents: 5000 })
    expect(await allPayloads()).toEqual([])
    const other = await activeMandate({ debtor })
    expect(() => svc.receivePaymentInstruction({ mandateId: other.id, instructionId: `${BIC}I20230718000000000077260`, amountCents: 1, status: 'RJCT' })).toThrow(expect.objectContaining({ status: 422 }))
    expect((await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/search` })).json().paymentInstructions).toHaveLength(3)
    // a RAPAIN supersedes a stubbed search entry with its id
    const stubId = `${BIC}I20230718000000000077270`
    svc.addStubInstructions(id, [{ instructionIdentification: stubId, instructedAmount: 1, creationDateTime: '2023-07-18T00:00:00.000Z', transactionStatus: 'ACSC' }])
    const overStub = svc.receivePaymentInstruction({ mandateId: id, instructionId: stubId, amountCents: 100, status: 'ACCP' })
    expect(overStub.instruction).toMatchObject({ id: stubId, origin: 'INBOUND', status: 'ACCEPTED_AND_SETTLED' })
    expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(19)
  })

  it('the documented staging flow: makeAdhocPayment, then RAPAIN with its instructionId reconciles instead of paying twice', async () => {
    const debtor = await newAccount({ fund: 30 })
    const { id, creditor } = await activeMandate({ debtor })
    // settled locally already: the RAPAIN is a no-op (no second debit, no second MANDATE_PAYMENT)
    const paid = await adhoc(id, { amount: AUD(10) })
    expect(paid.transactionStatus).toBe('ACCEPTED_AND_SETTLED')
    await clearNotifications()
    const again = svc.receivePaymentInstruction({ mandateId: mmsId(id), instructionId: paid.instructionId, amountCents: 1000, initiatingPartyName: 'ACME', status: 'ACCP' })
    expect(again.instruction).toMatchObject({ id: paid.instructionId, origin: 'ADHOC', status: 'ACCEPTED_AND_SETTLED' })
    expect(again.transactionId).toBe(svc.instruction(id, paid.instructionId).transactionId)
    expect(await allPayloads()).toEqual([])
    expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(20)
    expect(svc.instructions(id)).toHaveLength(1)

    // still in flight (staging trajectory): the RAPAIN finishes it (ACCP: debtor leg; RJCT: rejected); the later hops are no-ops
    svc.paymentProgressDelayMs = DAY_MS
    try {
      const inFlight = async (): Promise<AdhocResponse> => {
        const res = await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId: id, amount: AUD(5), description: 'paymentstatus:sent' } })
        expect(res.json().transactionStatus).toBe('SENT')
        return res.json() as AdhocResponse
      }
      const sent = await inFlight()
      const settled = svc.receivePaymentInstruction({ mandateId: id, instructionId: sent.instructionId, amountCents: 500, status: 'ACCP' })
      expect(settled.instruction).toMatchObject({ id: sent.instructionId, origin: 'ADHOC', status: 'ACCEPTED_AND_SETTLED', transactionId: settled.transactionId })
      expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(15)
      expect((await getAccount(creditor.accountHayId!)).availableBalance).toBe(10) // the creditor leg arrives with the RAP mock
      const refused = await inFlight()
      const rejected = svc.receivePaymentInstruction({ mandateId: id, instructionId: refused.instructionId, amountCents: 500, status: 'RJCT', reasonCode: 'AM04' })
      expect(rejected.instruction).toMatchObject({ status: 'REJECTED', reasonCode: 'AM04' })
      await advanceClock(DAY_MS)
      expect(svc.instruction(id, sent.instructionId).status).toBe('ACCEPTED_AND_SETTLED')
      expect(svc.instruction(id, refused.instructionId)).toMatchObject({ status: 'REJECTED', reasonCode: 'AM04' })
      expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(15)
      expect((await paymentEvents(id)).map((e) => [e.mandatePaymentEventDto.instructionId, e.mandatePaymentEventDto.paymentStatus])).toEqual([
        [sent.instructionId, 'MANDATE_PAYMENT_ACCEPTED'], [refused.instructionId, 'MANDATE_PAYMENT_REJECTED'],
      ])
      expect(svc.instructions(id)).toHaveLength(3)
    } finally {
      svc.paymentProgressDelayMs = undefined
      await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
    }
  })
})

// ---------------------------------------------------------------- scheduled payments

describe('scheduled payments and setScheduledPaymentInitiationRequestAmount', () => {
  it('a VARIABLE monthly mandate: MANDATE_DUE_PAYMENT one day before the initiation, the amount is set by notificationId and initiated when the clock reaches the due time', async () => {
    const now = await today()
    const debtor = await newAccount({ fund: 500 })
    const creditor = await newAccount()
    const id = await createMandate(creditor, { accountId: debtor.accountHayId! }, { paymentTerms: { frequency: 'MONTHLY', type: 'VARIABLE', maximumAmount: AUD(100) }, validityStartDate: plusDays(now, 3) })
    await clearNotifications()
    expect((await patch(`/v1/payto/payer/mandates/${id}/resolve?resolution=ACCEPT`)).statusCode).toBe(200)
    const scheduled = svc.schedule(id)!
    expect(scheduled).toMatchObject({ dueDate: plusDays(now, 3), paymentDateTime: `${plusDays(now, 3)}T00:00:00.000000Z`, announce: true })
    expect(scheduled.announcedAt).toBeUndefined()
    expect((await allPayloads()).filter((p) => p.type === 'MANDATE_DUE_PAYMENT')).toEqual([])

    await advanceClock(2 * DAY_MS)
    const due = (await allPayloads()).filter((p) => p.type === 'MANDATE_DUE_PAYMENT')
    expect(due).toEqual([{ customerHayId: creditor.accountHolderId, idempotencyKey: expect.any(String), type: 'MANDATE_DUE_PAYMENT', actionOwner: 'PLATFORM', mandateDuePaymentEventDto: { mandateId: id, notificationId: scheduled.notificationId, paymentDateTimeUtc: `${plusDays(now, 3)}T00:00:00.000000Z` } }])
    assertValidNotification(due[0], 'v0')
    const { notificationId } = due[0].mandateDuePaymentEventDto
    expect(svc.instructions(id)).toEqual([])

    const wrongMandate = await patch(`/v1/payto/initiator/mandates/${UNKNOWN_ID}/payments/amount`, { amount: AUD(40), notificationId })
    expect(wrongMandate.statusCode).toBe(404)
    const wrongNotification = await patch(`/v1/payto/initiator/mandates/${id}/payments/amount`, { amount: AUD(40), notificationId: UNKNOWN_ID })
    expect(wrongNotification.statusCode).toBe(422)
    expect(wrongNotification.json().message).toMatch(/^NOT_FOUND: Notification/)
    const tooMuch = await patch(`/v1/payto/initiator/mandates/${id}/payments/amount`, { amount: AUD(140), notificationId })
    expect(tooMuch.statusCode).toBe(422)
    expect(tooMuch.json().message).toMatch(/^INVALID_AMOUNT:/)
    for (const payload of [{ amount: AUD(40) }, { notificationId }, { amount: AUD(40.001), notificationId }, { amount: AUD(40), notificationId: 'x' }]) {
      expect((await patch(`/v1/payto/initiator/mandates/${id}/payments/amount`, payload)).statusCode, JSON.stringify(payload)).toBe(400)
    }
    const set = await patch(`/v1/payto/initiator/mandates/${id}/payments/amount`, { amount: AUD(40), notificationId })
    expect(set.statusCode, set.body).toBe(200)
    expect(set.json()).toEqual({ message: 'Scheduled payment amount set successfully.' })
    expect(svc.schedule(id)?.amountCents).toBe(4000)

    await clearNotifications()
    await advanceClock(2 * DAY_MS)
    const [instruction] = svc.instructions(id)
    expect(instruction).toMatchObject({ origin: 'SCHEDULED', amountCents: 4000, status: 'ACCEPTED_AND_SETTLED', endToEndId: 'NET-1724' })
    expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(460)
    const payloads = await allPayloads()
    // the creditor account's first posting also flips it APPROVED -> ACTIVE (accounts domain); the next payment is a month away
    expect(payloads.map((p) => p.type)).toEqual(['TRANSACTION', 'ACCOUNT_STATUS_CHANGE', 'TRANSACTION', 'MANDATE_PAYMENT'])
    expect(payloads[1]).toMatchObject({ customerHayId: creditor.accountHolderId, accountStatusChangeEvent: { accountStatus: 'ACTIVE' } })
    expect(payloads[0].transactionEvent).toMatchObject({ transactionType: 'INTERBANK_TRANSFER_OUT', currencyAmount: AUD(-40), originType: 'MANDATE_PAYMENT', mandatePaymentDetails: { mandateId: id, instructionId: instruction!.id } })
    expect(payloads[3]).toMatchObject({ actionOwner: 'PLATFORM', mandatePaymentEventDto: { instructionId: instruction!.id, paymentStatus: 'MANDATE_PAYMENT_ACCEPTED', isFinal: true } })
    for (const p of payloads) assertValidNotification(p, 'v0')
    const next = svc.schedule(id)!
    expect(next).toMatchObject({ dueDate: stepDate(plusDays(now, 3), 'MONTHLY'), paymentDateTime: `${stepDate(plusDays(now, 3), 'MONTHLY')}T00:00:00.000000Z` })
    expect(next.notificationId).not.toBe(notificationId)

    // a suspended mandate defers both the announcement and the payment; on release both happen, and without an amount the PIR is rejected with AM12
    expect((await patch(`/v1/payto/initiator/mandates/${id}/suspend`, {})).statusCode).toBe(200)
    await advanceClock(32 * DAY_MS)
    expect(svc.instructions(id)).toHaveLength(1)
    expect(svc.schedule(id)).toMatchObject({ notificationId: next.notificationId })
    expect(svc.schedule(id)!.announcedAt).toBeUndefined()
    await clearNotifications()
    expect((await patch(`/v1/payto/initiator/mandates/${id}/release`)).statusCode).toBe(200)
    await flush()
    expect(svc.instructions(id)[0]).toMatchObject({ origin: 'SCHEDULED', status: 'REJECTED', reasonCode: 'AM12' })
    const afterRelease = await allPayloads()
    expect(afterRelease.map((p) => p.type)).toEqual(['MANDATE', 'MANDATE', 'MANDATE_DUE_PAYMENT', 'MANDATE_PAYMENT'])
    expect(afterRelease[2].mandateDuePaymentEventDto.notificationId).toBe(next.notificationId)
    expect(afterRelease[3].mandatePaymentEventDto).toMatchObject({ paymentStatus: 'MANDATE_PAYMENT_REJECTED', reasonCode: 'AM12' })
    expect(afterRelease[3].mandatePaymentEventDto.transactionHayId).toBeUndefined()
    expect(svc.schedule(id)?.notificationId).not.toBe(next.notificationId)
    // cancellation drops the schedule
    expect((await patch(`/v1/payto/payer/mandates/${id}/cancel`, {})).statusCode).toBe(200)
    expect(svc.schedule(id)).toBeUndefined()
    await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
  })

  it('FIXED terms take the amount from paymentTerms / firstPayment / lastPayment and stop after lastPayment.date; no MANDATE_DUE_PAYMENT, the amount cannot be set', async () => {
    const now = await today()
    const debtor = await newAccount({ fund: 500 })
    const first = plusDays(now, 2)
    await clearNotifications()
    const { id } = await activeMandate({ debtor, terms: { frequency: 'WEEKLY', type: 'FIXED', amount: AUD(10), firstPayment: { amount: AUD(15), date: first }, lastPayment: { amount: AUD(5), date: plusDays(first, 7) } } })
    expect(svc.schedule(id)).toMatchObject({ dueDate: first, announce: false })
    const set = await patch(`/v1/payto/initiator/mandates/${id}/payments/amount`, { amount: AUD(40), notificationId: svc.schedule(id)!.notificationId })
    expect(set.statusCode).toBe(422)
    expect(set.json().message).toMatch(/FIXED payment terms/)
    await advanceClock(3 * DAY_MS)
    expect(svc.instructions(id).map((i) => i.amountCents)).toEqual([1500])
    await advanceClock(7 * DAY_MS)
    expect(svc.instructions(id).map((i) => i.amountCents)).toEqual([500, 1500])
    expect(svc.schedule(id)).toBeUndefined()
    expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(480)
    expect((await allPayloads()).filter((p) => p.type === 'MANDATE_DUE_PAYMENT')).toEqual([])
    await app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
  })

  it('never initiates a due date twice: an amendment accepted, or a release, on the day of a payment schedules the next period', async () => {
    const now = await today()
    const debtor = await newAccount({ fund: 500 })
    const due = plusDays(now, 1)
    const terms: CreateMandateBody['paymentTerms'] = { frequency: 'MONTHLY', type: 'FIXED', amount: AUD(10), maximumAmount: AUD(50) }
    const { id } = await activeMandate({ debtor, terms, overrides: { validityStartDate: due } })
    expect(svc.schedule(id)).toMatchObject({ dueDate: due })
    await advanceClock(DAY_MS)
    expect(svc.instructions(id).map((i) => i.amountCents)).toEqual([1000])
    const next = stepDate(due, 'MONTHLY')
    expect(svc.schedule(id)).toMatchObject({ dueDate: next })
    // a payment-terms amendment accepted on the (UTC) day of the payment
    expect((await patch(`/v1/payto/initiator/mandates/${id}/payment_terms`, { paymentTerms: { ...terms, amount: AUD(11) } })).statusCode).toBe(200)
    expect((await patch(`/v1/payto/payer/mandates/${id}/resolve?resolution=ACCEPT`)).statusCode).toBe(200)
    expect(svc.schedule(id)).toMatchObject({ dueDate: next })
    // an amendment accepted while SUSPENDED drops the schedule; the release on the same day re-schedules the next period
    expect((await patch(`/v1/payto/initiator/mandates/${id}/suspend`, {})).statusCode).toBe(200)
    expect((await patch(`/v1/payto/initiator/mandates/${id}/payment_terms`, { paymentTerms: { ...terms, amount: AUD(12) } })).statusCode).toBe(200)
    expect((await patch(`/v1/payto/payer/mandates/${id}/resolve?resolution=ACCEPT`)).statusCode).toBe(200)
    expect(svc.schedule(id)).toBeUndefined()
    expect((await patch(`/v1/payto/initiator/mandates/${id}/release`)).statusCode).toBe(200)
    expect(svc.schedule(id)).toMatchObject({ dueDate: next })
    await advanceClock(DAY_MS)
    expect(svc.instructions(id).map((i) => i.amountCents)).toEqual([1000])
    expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(490)
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

  it('due dates are counted from the anchor, so the day of the month survives a short month (no drift)', async () => {
    expect([0, 1, 2, 3, 4].map((n) => nthDueDate('2026-01-31', 'MONTHLY', n))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'])
    expect([1, 2, 3].map((n) => nthDueDate('2026-11-30', 'QUARTERLY', n))).toEqual(['2027-02-28', '2027-05-30', '2027-08-30'])
    expect([1, 2].map((n) => nthDueDate('2026-08-31', 'SEMI_ANNUAL', n))).toEqual(['2027-02-28', '2027-08-31'])
    expect([1, 4].map((n) => nthDueDate('2028-02-29', 'ANNUAL', n))).toEqual(['2029-02-28', '2032-02-29'])
    expect([1, 2].map((n) => nthDueDate('2026-02-25', 'WEEKLY', n))).toEqual(['2026-03-04', '2026-03-11'])
    // a mandate anchored on the 31st of a past month is next due on the last day of the current month, not on the 28th
    const now = await today()
    const [y, m] = now.split('-').map(Number) as [number, number]
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    const { id } = await activeMandate({ terms: { frequency: 'MONTHLY', type: 'FIXED', amount: AUD(1), firstPayment: { date: '2020-01-31' } } })
    expect(svc.schedule(id)).toMatchObject({ dueDate: monthEnd })
    expect((await patch(`/v1/payto/initiator/mandates/${id}/cancel`, {})).statusCode).toBe(200)
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
    // 1x MANDATE with the requested trigger (webhook-matrix row generateMandateNotificationForInitiator): the state change it implies is silent
    expect(events.map((e) => [e.customerHayId, e.mandateEventDto.trigger, e.actionOwner])).toEqual([[creditor.accountHolderId, 'MCRC', 'PLATFORM']])
    expect(events[0].mandateEventDto).toEqual({ mandateId: id, actionId: (await actions(id))[0]!.actionIdentification, description: 'Mandate create confirmed', trigger: 'MCRC' })
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

  it('applies the MMS state of each trigger: PCRD declines like MCRD, MCRX times out, MAMC / MAMD / MAMX / MAMR resolve a pending amendment, others only notify', async () => {
    const creditor = await newAccount()
    const debtor = await newAccount()
    const declined = await createMandate(creditor, { accountId: debtor.accountHayId! })
    await clearNotifications()
    svc.emitMandateNotification('INITIATOR', declined, 'PCRD')
    expect(svc.get(declined)).toMatchObject({ status: 'CANCELLED', cxStatus: 'CANCELLED' })
    expect((await actions(declined))[0]).toMatchObject({ type: 'CREATE', status: 'DECLINED' })
    expect((await mandateEvents(declined)).map((e) => [e.customerHayId, e.mandateEventDto.trigger, e.actionOwner])).toEqual([[creditor.accountHolderId, 'PCRD', 'PLATFORM']])

    const expired = await createMandate(creditor, { accountId: debtor.accountHayId! })
    await clearNotifications()
    svc.emitMandateNotification('PAYER', expired, 'MCRX')
    expect(svc.get(expired)).toMatchObject({ status: 'CANCELLED', cxStatus: 'CANCELLED_AUTHORISATION_TIMED_OUT' })
    expect((await actions(expired))[0]).toMatchObject({ status: 'TIMED_OUT' })
    expect((await mandateEvents(expired)).map((e) => [e.customerHayId, e.mandateEventDto.trigger])).toEqual([[debtor.accountHolderId, 'MCRX']])

    const terms: CreateMandateBody['paymentTerms'] = { frequency: 'MONTHLY', type: 'VARIABLE', maximumAmount: AUD(10), firstPayment: { date: '2035-01-10' } }
    const { id } = await activeMandate({ creditor, debtor, terms })
    for (const [trigger, outcome, max] of [['MAMC', 'COMPLETED', AUD(20)], ['MAMD', 'DECLINED', AUD(20)], ['MAMX', 'TIMED_OUT', AUD(20)], ['MAMR', 'RECALLED', AUD(20)]] as const) {
      expect((await patch(`/v1/payto/initiator/mandates/${id}/payment_terms`, { paymentTerms: { ...terms, maximumAmount: AUD(max.amount + (outcome === 'COMPLETED' ? 0 : 5)) } })).statusCode).toBe(200)
      await clearNotifications()
      svc.emitMandateNotification('INITIATOR', id, trigger)
      expect((await actions(id)).at(-1), trigger).toMatchObject({ type: 'AMEND', status: outcome })
      expect(svc.get(id).status).toBe('ACTIVE')
      expect((await mandateEvents(id)).map((e) => [e.customerHayId, e.mandateEventDto.trigger]), trigger).toEqual([[creditor.accountHolderId, trigger]])
    }
    expect((await getMandate(id)).paymentTerms.maximumAmount).toEqual(AUD(20))
    await clearNotifications()
    for (const trigger of ['MSCH', 'MAMN', 'MPOF', 'MCRT'] as const) svc.emitMandateNotification('PAYER', id, trigger)
    expect(svc.get(id).status).toBe('ACTIVE')
    expect((await mandateEvents(id)).map((e) => [e.customerHayId, e.mandateEventDto.trigger])).toEqual(['MSCH', 'MAMN', 'MPOF', 'MCRT'].map((t) => [debtor.accountHolderId, t]))
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
    // the local Payer resolves it like any other; the Initiator side has nobody to notify and its
    // payments arrive as inbound instructions (RAPAIN), so nothing is scheduled locally
    await clearNotifications()
    expect((await patch(`/v1/payto/payer/mandates/${m.id}/resolve?resolution=ACCEPT`)).statusCode).toBe(200)
    expect(svc.get(m.id).status).toBe('ACTIVE')
    expect(await allPayloads()).toEqual([])
    expect(svc.schedule(m.id)).toBeUndefined()
    // the client is only the Payer here: every Initiator-only operation is refused with 403
    const initiatorOps: [string, string, object | undefined][] = [
      ['PUT', `/v1/payto/initiator/mandates/${m.id}`, { creditorAccountId: debtor.accountHayId }],
      ['GET', `/v1/payto/initiator/mandates/${m.id}/actions`, undefined],
      ['PATCH', `/v1/payto/initiator/mandates/${m.id}/cancel`, {}],
      ['GET', `/v1/payto/initiator/mandates/${m.id}/instructions/${BIC}I20230801000000000079280/status`, undefined],
      ['PATCH', `/v1/payto/initiator/mandates/${m.id}/payment_terms`, { validityEndDate: '2041-01-01' }],
      ['PATCH', `/v1/payto/initiator/mandates/${m.id}/payments/amount`, { amount: AUD(1), notificationId: UNKNOWN_ID }],
      ['PATCH', `/v1/payto/initiator/mandates/${m.id}/release`, undefined],
      ['PATCH', `/v1/payto/initiator/mandates/${m.id}/resolve`, undefined],
      ['GET', `/v1/payto/initiator/mandates/${m.id}/search`, undefined],
      ['PATCH', `/v1/payto/initiator/mandates/${m.id}/suspend`, {}],
      ['POST', '/v1/payto/payments/adhoc', { idempotencyKey: randomUUID(), mandateId: m.id, amount: AUD(1) }],
    ]
    for (const [method, url, payload] of initiatorOps) {
      const res = await app.inject({ method: method as 'GET', url, ...(payload ? { payload } : {}) })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(res.json().message).toBe(`FORBIDDEN: the client is not the Initiator of mandate ${m.id}`)
    }
    expect((await getMandate(m.id)).status).toBe('ACTIVE')
    const search = await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${LOCAL_BSB}${debtor.accountNumber}&pageNumber=1&pageSize=10` })
    expect(search.json().result.map((r: { mandateId: string }) => r.mandateId)).toEqual([m.id])
    // an inbound RAPAIN on it settles the debtor leg only
    const r = svc.receivePaymentInstruction({ mandateId: id, instructionId: `${BIC}I20230801000000000079280`, amountCents: 2500, initiatingPartyName: 'EXT', status: 'ACCP' })
    expect(r.instruction.status).toBe('ACCEPTED_AND_SETTLED')
    expect((await getAccount(debtor.accountHayId!)).availableBalance).toBe(15)
  })
})

// ---------------------------------------------------------------- response contract (strict: `required` kept)

const strictAjv = new Ajv({ strict: false, allowUnionTypes: true, unicodeRegExp: false, allErrors: true })
addFormatsModule.default(strictAjv)
for (const c of requestComponents) strictAjv.addSchema(c)
const strictValidators = new Map<string, ValidateFunction>()
/** Validates a success body against the operation's response schema with the spec's `required` lists (req: components). */
function assertStrictResponse(operationId: string, body: unknown): void {
  let v = strictValidators.get(operationId)
  if (!v) {
    const op = getOperation(operationId)
    const schema = JSON.parse(JSON.stringify(op.responses[String(op.successStatus)]).replace(/"res:/g, '"req:'))
    v = strictAjv.compile(schema)
    strictValidators.set(operationId, v)
  }
  // documented exception: getMandatePaymentStatus omits transactionStatusReasonCode when there is none (every docs sample does)
  const errors = v(body) ? [] : (v.errors ?? []).filter((e) => !(operationId === 'getMandatePaymentStatus' && e.keyword === 'required' && e.params.missingProperty === 'transactionStatusReasonCode'))
  if (errors.length) throw new Error(`${operationId} response violates the contract: ${strictAjv.errorsText(errors, { separator: '\n' })}\n${JSON.stringify(body, null, 2)}`)
}

describe('response contract', () => {
  it('every PayTo response satisfies its schema including the required lists and patterns (actions of every type included)', async () => {
    const creditor = await newAccount()
    const debtor = await newAccount({ fund: 100 })
    const terms: CreateMandateBody['paymentTerms'] = { frequency: 'ADHOC', type: 'VARIABLE', amount: AUD(10), maximumAmount: AUD(50), countPerPeriod: '2', pointInTime: '09', firstPayment: { amount: AUD(12.5), date: '2030-01-01' }, lastPayment: { amount: AUD(20), date: '2031-01-01' } }
    const body = mandateBody(creditor, { accountId: debtor.accountHayId!, partyReference: 'Debtor ref', ultimatePartyName: 'JOHN DOE' }, { paymentTerms: terms, validityEndDate: '2032-01-01', transferArrangement: 'Transfer arrangement test', resolutionRequestedBy: '2030-09-10T10:00:00.000Z' })
    const created = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: body })
    assertStrictResponse('createMandate', created.json())
    const id = created.json().mandateId as string
    const ok = (res: { statusCode: number; body: string; json: () => unknown }, op: string) => {
      expect(res.statusCode, `${op} ${res.body}`).toBe(200)
      assertStrictResponse(op, res.json())
    }
    ok(await patch(`/v1/payto/payer/mandates/${id}/resolve?resolution=ACCEPT`), 'resolveMandateByPayer')
    ok(await patch(`/v1/payto/initiator/mandates/${id}/payment_terms`, { paymentTerms: { ...terms, maximumAmount: AUD(60) }, validityEndDate: '2033-01-01', resolutionRequestedBy: '2030-01-01T00:00:00.000Z' }), 'amendMandatePaymentTerms')
    ok(await app.inject({ method: 'PUT', url: `/v1/payto/initiator/mandates/${id}`, payload: { creditorAccountId: creditor.accountHayId, ultimatePartyName: 'ACME Energy' } }), 'amendMandateByInitiator')
    ok(await app.inject({ method: 'PUT', url: `/v1/payto/payer/mandates/${id}`, payload: { debtorAccountId: debtor.accountHayId } }), 'amendMandateByPayer')
    ok(await patch(`/v1/payto/payer/mandates/${id}/suspend`, { reasonCode: 'MD16', reasonDescription: 'Requested by Customer' }), 'suspendMandateByPayer')
    ok(await patch(`/v1/payto/payer/mandates/${id}/release`), 'releaseMandateByPayer')
    ok(await patch(`/v1/payto/initiator/mandates/${id}/suspend`, {}), 'suspendMandateByInitiator')
    ok(await patch(`/v1/payto/initiator/mandates/${id}/release`), 'releaseMandateByInitiator')
    const adhocRes = await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId: id, amount: AUD(12.5), endToEndId: 'INV-9' } })
    ok(adhocRes, 'makeAdhocPayment')
    const rejected = await app.inject({ method: 'POST', url: '/v1/payto/payments/adhoc', payload: { idempotencyKey: randomUUID(), mandateId: id, amount: AUD(51) } })
    ok(rejected, 'makeAdhocPayment')
    svc.addStubInstructions(id, [{ instructionIdentification: `${BIC}I20231129000000000093999`, instructedAmount: 1.28, creationDateTime: '2023-11-29T12:33:59.833Z', transactionStatus: 'RECV', transactionStatusReasonCode: 'AB01' }])
    ok(await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/search` }), 'searchPaymentsInstructions')
    for (const instructionId of [adhocRes.json().instructionId, rejected.json().instructionId, `${BIC}I20231129000000000093999`]) {
      ok(await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${id}/instructions/${instructionId}/status` }), 'getMandatePaymentStatus')
    }
    ok(await app.inject({ method: 'GET', url: `/v1/payto/mandates/${id}` }), 'getMandate')
    ok(await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${LOCAL_BSB}${debtor.accountNumber}&pageNumber=1&pageSize=50` }), 'getMandates')
    ok(await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates?creditorAccountId=${creditor.accountHayId}` }), 'getMandateIdsByInitiator')
    ok(await app.inject({ method: 'GET', url: '/v1/payto/supported-bsbs/082016' }), 'checkBsbIsSupportedByPayTo')
    ok(await patch(`/v1/payto/initiator/mandates/${id}/resolve`), 'resolveMandateByInitiator')
    ok(await patch(`/v1/payto/initiator/mandates/${id}/cancel`, { reasonCode: 'MD17' }), 'cancelMandateByInitiator')
    for (const side of ['initiator', 'payer'] as const) {
      const res = await app.inject({ method: 'GET', url: `/v1/payto/${side}/mandates/${id}/actions` })
      ok(res, side === 'initiator' ? 'getMandateActionsByInitiator' : 'getMandateActionsByPayer')
      expect((res.json().actions as ActionDto[]).map((a) => [a.type, a.status])).toEqual([
        ['CREATE', 'COMPLETED'], ['AMEND', 'RECALLED'], ['AMEND', 'COMPLETED'], ['AMEND', 'COMPLETED'],
        ['STATUS_CHANGE', 'COMPLETED'], ['STATUS_CHANGE', 'COMPLETED'], ['STATUS_CHANGE', 'COMPLETED'], ['STATUS_CHANGE', 'COMPLETED'], ['STATUS_CHANGE', 'COMPLETED'],
      ])
    }
    // the variable-amount / scheduled ops
    const monthly = await activeMandate({ debtor, terms: { frequency: 'MONTHLY', type: 'USAGE_BASED', maximumAmount: AUD(30) }, overrides: { validityStartDate: await today() } })
    ok(await patch(`/v1/payto/initiator/mandates/${monthly.id}/payments/amount`, { amount: AUD(3), notificationId: svc.schedule(monthly.id)!.notificationId }), 'setScheduledPaymentInitiationRequestAmount')
    ok(await patch(`/v1/payto/payer/mandates/${monthly.id}/cancel`, {}), 'cancelMandateByPayer')
    const declined = await createMandate(creditor, { accountId: debtor.accountHayId! })
    ok(await patch(`/v1/payto/payer/mandates/${declined}/resolve?resolution=REJECT`), 'resolveMandateByPayer')
    ok(await app.inject({ method: 'GET', url: `/v1/payto/payer/mandates/${declined}/actions` }), 'getMandateActionsByPayer')
    // a mandate known only from an MMS notification (external Initiator)
    const mms = svc.emitMandateNotification('PAYER', v1Uuid(), 'MCRT', {
      mandateDetails: { mandateId: 'x', debtorInformation: { accountIdentification: `${LOCAL_BSB}${debtor.accountNumber}` }, paymentInformation: { paymentFrequency: 'ADHO', maximumAmount: '9.50' }, validityStartDate: '2025-01-01' },
    })
    ok(await app.inject({ method: 'GET', url: `/v1/payto/mandates/${mms.id}` }), 'getMandate')
    ok(await app.inject({ method: 'GET', url: `/v1/payto/payer/mandates/${mms.id}/actions` }), 'getMandateActionsByPayer')
    const summaries = await app.inject({ method: 'GET', url: `/v1/payto/mandates?accountIds=${debtor.accountHayId}&pageNumber=1&pageSize=50` })
    ok(summaries, 'getMandates')
    expect(summaries.json().result.find((r: { mandateId: string }) => r.mandateId === mms.id)).toEqual({ debtorAccountId: debtor.accountHayId, mandateId: mms.id, paymentTerms: { frequency: 'ADHOC', maximumAmount: AUD(9.5) }, purposeCode: 'OTHER', status: 'CREATED' })
  })
})

describe('free text in the action DTOs', () => {
  it('fits stored free text into the MMS action DTO limits: printable ASCII names (1-140), transferArrangement (1-140), reasonDescription (1-256)', async () => {
    const holder = await newCustomer()
    const creditor = await newAccount({ holder })
    const replacement = await newAccount({ holder, fund: 1 })
    const debtor = await newAccount()
    const body = mandateBody(creditor, { accountId: debtor.accountHayId!, partyName: 'José Müller-Łukasz' }, { transferArrangement: 'T'.repeat(200) })
    body.creditorDetails.ultimatePartyName = '株式会社'
    const res = await app.inject({ method: 'POST', url: '/v1/payto/initiator/mandates', payload: body })
    expect(res.statusCode, res.body).toBe(200)
    const id = res.json().mandateId as string
    // the mandate itself keeps what the client sent
    expect(await getMandate(id)).toMatchObject({ transferArrangement: 'T'.repeat(200), debtorDetails: { partyName: 'José Müller-Łukasz' }, creditorDetails: { ultimatePartyName: '株式会社' } })
    expect((await patch(`/v1/payto/payer/mandates/${id}/resolve?resolution=ACCEPT`)).statusCode).toBe(200)
    expect((await patch(`/v1/payto/initiator/mandates/${id}/suspend`, { reasonDescription: 'R'.repeat(300) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PUT', url: `/v1/payto/initiator/mandates/${id}`, payload: { creditorAccountId: replacement.accountHayId, ultimatePartyName: `Ünïcödé Energy ${'E'.repeat(150)}` } })).statusCode).toBe(200)
    const empty = await createMandate(creditor, { accountId: debtor.accountHayId! }, { transferArrangement: '' })
    for (const mandateId of [id, empty]) {
      const acts = await app.inject({ method: 'GET', url: `/v1/payto/initiator/mandates/${mandateId}/actions` })
      expect(acts.statusCode).toBe(200)
      assertStrictResponse('getMandateActionsByInitiator', acts.json())
    }
    const [create, suspend, amend] = await actions(id)
    expect(create!.details!.creation).toMatchObject({
      transferArrangement: 'T'.repeat(140),
      debtorInformation: { partyName: 'Jose Muller-?ukasz', ultimatePartyName: 'Jose Muller-?ukasz' },
      creditorInformation: { partyName: '????', ultimatePartyName: '????' },
      paymentInitiatorInformation: { partyName: '????', partyLegalName: '????' },
    })
    expect(suspend!.details!.statusChange).toEqual({ change: 'SUSPEND', reasonDescription: 'R'.repeat(256) })
    expect(amend!.details!.amendment!.creditorInformation).toMatchObject({ ultimatePartyName: `Unicode Energy ${'E'.repeat(125)}` })
    expect((await actions(empty))[0]!.details!.creation!.transferArrangement).toBeUndefined()
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
    // due today: initiated one lead time from now, so MANDATE_DUE_PAYMENT goes out at once
    const monthly = await activeMandate({ debtor, terms: { frequency: 'MONTHLY', type: 'VARIABLE' }, overrides: { validityStartDate: await today() } })
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
