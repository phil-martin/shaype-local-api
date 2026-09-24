/**
 * Card rules (spec §5.4, docs/map/cards.md §1–§4): issuance, the cardStatus machine, preferences,
 * PIN / CVV state, re-issue / renew / convert, expiry with reminders, digital wallets, rewards, and the
 * card-side authorisation checks the ledger and the utilities mocks rely on. Publishes itself as
 * ctx.services.cards for accounts (closure cascade), customers (card list), utilities and groups.
 */
import { createHash, randomInt } from 'node:crypto'
import type { components } from '../../contract/generated/b2b-types.js'
import type { components as whComponents } from '../../contract/generated/webhook-types.js'
import type { AppContext } from '../../context.js'
import { isoDate, isoUtc } from '../../lib/clock.js'
import { badRequest, notFound, unprocessable } from '../../lib/errors.js'
import { cardPan, isUuid, uuid } from '../../lib/ids.js'
import { compact, type ActionOwner } from '../../events/notify.js'
import type { Cents } from '../../lib/money.js'
import type { AuthoriseHoldInput, CallerRefusal, CardUsageDetails, HoldResult, HoldType, Money } from '../transactions/index.js'
import type { Address, BlockedBy, Card, CardPreferences, CardRepo, CardStatus, CardType, DeliveryMethod, ExpiryReminderType, PhoneNumber, Wallet, WalletType } from './repo.js'

type S = components['schemas']
export type HayCard = S['HayCard']
export type CardPaymentPreferences = S['CardPaymentPreferences']
export type DigitalWalletDetails = S['DigitalWalletDetails']
export type ApiDigitalWallet = S['ApiDigitalWallet']
export type OemProvisioningData = S['OemProvisioningData']
export type ExternalMerchantDetails = S['ExternalMerchantDetails']
export type CardPreferenceOutcome = NonNullable<whComponents['schemas']['TransactionEventDto']['cardPreferenceOutcome']>
export type CardProcessorResponse = NonNullable<whComponents['schemas']['TransactionEventDto']['cardProcessorResponse']>

export interface CreateCardInput {
  accountId: string
  customerHayId: string
  firstName: string
  lastName: string
  email: string
  phoneNumber: PhoneNumber
  deliveryAddress: Address
  pin: string
  cardType?: CardType | null
  cardSubDesign?: string | null
  deliveryMethod?: DeliveryMethod | null
  nameOnCard?: string | null
  nameOnCardLine2?: string | null
  title?: string | null
}

export interface ReissueInput {
  cardType?: CardType | null
  deliveryAddress?: Address | null
  deliveryMethod?: DeliveryMethod | null
}

export type RenewInput = ReissueInput

export interface StatusOptions {
  actionOwner: ActionOwner
  blockedBy?: BlockedBy
  note?: string
}

/** A card-side refusal, in the shape transactions.holds.authorise takes as `refusal`, plus a human reason. */
export interface CardRefusal extends CallerRefusal {
  reason: string
}

export interface CardCheckInput {
  cardUsage?: CardUsageDetails
  /** default from cardUsage: ATM -> ATM_WITHDRAWAL, card present -> CARD_PRESENT_PAYMENT, else CARD_NOT_PRESENT_PAYMENT */
  type?: HoldType
  /** PIN was entered (default: ATM withdrawals and chip card-present payments). */
  pinEntered?: boolean
  /** CVV was entered (default: card-not-present payments). */
  cvvEntered?: boolean
}

export interface CardHoldInput extends CardCheckInput {
  /** positive cents */
  amountCents: Cents
  merchant?: ExternalMerchantDetails
  channel?: AuthoriseHoldInput['channel']
  originalAmount?: Money
  description?: string
  category?: string
  countryOfExpenditure?: AuthoriseHoldInput['countryOfExpenditure']
  externalIdentifiers?: AuthoriseHoldInput['externalIdentifiers']
  transactionTimeUtc?: string
  actionOwner?: ActionOwner
  /** A processor decline decided by the caller (utilities declineReason); takes precedence over the card checks. */
  refusal?: CallerRefusal
}

export const DEFAULT_PREFERENCES: CardPreferences = {
  cardEnabled: true,
  cardNotPresentEnabled: false,
  cashWithdrawalEnabled: false,
  contactlessEnabled: false,
  magneticStripeEnabled: false,
  mobileWalletPaymentsEnabled: true,
}

export const MAX_CVV_TRIES = 3
export const MAX_PIN_TRIES = 3
/** Years from issue to the expiry month (spec §5.4 decision). */
export const EXPIRY_YEARS = 4
/** Renewal window: from this many months before the expiry date (docs: "within 2 months of the expiry date"). */
export const RENEWAL_WINDOW_MONTHS = 2
const NAME_ON_CARD_MAX = 23
const OPEN_ACCOUNT_STATUSES: ReadonlySet<string> = new Set(['APPROVED', 'ACTIVE', 'ACTIVE_IN_ARREARS', 'DORMANT'])
const TERMINAL: ReadonlySet<CardStatus> = new Set(['INACTIVE', 'EXPIRED'])
const PIN_RE = /^\d{4,12}$/
const NEW_PIN_RE = /^\d{4}$/
const WALLET_PROVIDER: Record<WalletType, string> = { DEFAULT_WALLET: 'DEFAULT', APPLE_WALLET: 'APPLE', ANDROID_WALLET: 'GOOGLE', SAMSUNG_WALLET: 'SAMSUNG' }

declare module '../../context.js' {
  interface ServiceMap {
    cards: CardsService
  }
}

export class CardsService {
  constructor(private readonly ctx: AppContext, private readonly repo: CardRepo) {}

  // ---------------------------------------------------------------- reads

  find(id: string): Card | undefined {
    return this.repo.byId(id)
  }

  /** @throws 404 NOT_FOUND */
  get(id: string): Card {
    const c = this.repo.byId(id)
    if (!c) throw notFound(`NOT_FOUND: Card ${id} not found`)
    return c
  }

  /** Alias of get(): the card must exist. */
  require(id: string): Card {
    return this.get(id)
  }

  /** The usable card for a public token (a renewed card and its renewal share it: the ACTIVE one wins, then the newest). */
  byToken(cardToken: string): Card | undefined {
    return this.repo.byToken(cardToken)
  }

  /** Card by id (uuid) or by public token. @throws 404 */
  resolve(ref: string): Card {
    const c = isUuid(ref) ? this.repo.byId(ref) : this.repo.byToken(ref)
    if (!c) throw notFound(`NOT_FOUND: Card ${ref} not found`)
    return c
  }

  /** Cards linked to the account, every status, creation order. */
  listForAccount(accountId: string): HayCard[] {
    return this.repo.byAccount(accountId).map((c) => this.toResponse(c))
  }

  /** Cards whose cardholder is the customer, every status, creation order. */
  listForCustomer(customerHayId: string): HayCard[] {
    return this.repo.byCustomer(customerHayId).map((c) => this.toResponse(c))
  }

  listEntitiesForAccount(accountId: string): Card[] {
    return this.repo.byAccount(accountId)
  }

  toResponse(c: Card): HayCard {
    return compact({
      cardHayId: c.id,
      accountHayId: c.accountId,
      customerHayId: c.customerId,
      cardStatus: c.status,
      cardType: c.cardType,
      blockedBy: c.status === 'BLOCKED' ? c.blockedBy : undefined,
      cardToken: c.cardToken,
      lastFourDigits: c.pan.slice(-4),
      expiryDate: c.expiryDate,
      issuedDateTimeUtc: c.issuedAt,
      voidDateTimeUtc: c.voidAt,
      renewedIntoCardId: c.renewedIntoCardId,
      deliveryMethod: c.deliveryMethod,
      nameOnCard: c.nameOnCard,
      nameOnCardLine2: c.nameOnCardLine2,
    }) as HayCard
  }

  // ---------------------------------------------------------------- create

  /**
   * createHayCard. Customer must be ACTIVE (422 PERMISSION_DENIED), the account open (422 ACCOUNT_BLOCKED /
   * ACCOUNT_CLOSED) and held by the customer (422 PERMISSION_DENIED); pin 4–12 digits (400). PHYSICAL ->
   * AWAITING_ACTIVATION, VIRTUAL -> ACTIVE; fresh PAN / token / CVV, expiry = last day of the month 4
   * years out, default nameOnCard rule, default preferences. Emits card.created (CARD_STATUS_CHANGE).
   * Idempotency is the route's concern. Returns the HayCard body.
   */
  create(input: CreateCardInput, opts: { actionOwner?: ActionOwner } = {}): HayCard {
    return this.toResponse(this.createEntity(input, opts))
  }

  createEntity(input: CreateCardInput, opts: { actionOwner?: ActionOwner } = {}): Card {
    if (!PIN_RE.test(input.pin)) throw badRequest('BAD_REQUEST: pin must be 4 to 12 digits')
    const nameOnCard = input.nameOnCard ?? defaultNameOnCard(input.firstName, input.lastName)
    if (nameOnCard.length > NAME_ON_CARD_MAX) throw badRequest(`BAD_REQUEST: nameOnCard must be at most ${NAME_ON_CARD_MAX} characters`)
    this.ctx.services.customers.requireActive(input.customerHayId, 'Card')
    this.requireOpenAccountHeldBy(input.accountId, input.customerHayId)
    const cardType = input.cardType ?? 'PHYSICAL'
    const now = this.ctx.clock.now()
    const id = uuid()
    const card: Card = {
      id,
      accountId: input.accountId,
      customerId: input.customerHayId,
      status: cardType === 'VIRTUAL' ? 'ACTIVE' : 'AWAITING_ACTIVATION',
      cardType,
      pan: cardPan(this.repo.nextPanSeq()),
      cardToken: this.nextToken(),
      cvv: randomDigits(3),
      expiryDate: expiryDateFrom(now),
      issuedAt: isoUtc(now),
      deliveryMethod: input.deliveryMethod ?? 'STANDARD',
      deliveryAddress: input.deliveryAddress,
      phoneNumber: input.phoneNumber,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      cardSubDesign: input.cardSubDesign ?? 'SUB_DESIGN_1',
      nameOnCard,
      pinHash: hashPin(input.pin),
      pinEnabled: true,
      pinRemainingTries: MAX_PIN_TRIES,
      cvvRemainingTries: MAX_CVV_TRIES,
      preferences: { ...DEFAULT_PREFERENCES },
      rewardsEnrolled: false,
      remindersSent: [],
      createdAt: isoUtc(now),
    }
    if (input.title != null) card.title = input.title
    if (input.nameOnCardLine2 != null) card.nameOnCardLine2 = input.nameOnCardLine2
    this.repo.insert(card)
    this.ctx.events.emit('card.created', { card: structuredClone(card), actionOwner: opts.actionOwner ?? 'CLIENT' })
    return card
  }

  private nextToken(): string {
    // 9-digit public token from a sequence (spec: "maximum 9 digits in length")
    return String(100_000_000 + this.repo.nextTokenSeq())
  }

  /** @throws 404 unknown account; 422 ACCOUNT_BLOCKED / ACCOUNT_CLOSED; 422 PERMISSION_DENIED when the customer does not hold it */
  private requireOpenAccountHeldBy(accountId: string, customerHayId: string, action = 'created'): void {
    const accounts = this.ctx.services.accounts
    const a = accounts.get(accountId)
    if (a.status === 'LOCKED') throw unprocessable(`ACCOUNT_BLOCKED: Card cannot be ${action} for account ${accountId} as its status is currently LOCKED`)
    if (a.status === 'CLOSED') throw unprocessable(`ACCOUNT_CLOSED: Card cannot be ${action} for account ${accountId} as its status is currently CLOSED`)
    if (!OPEN_ACCOUNT_STATUSES.has(a.status)) throw unprocessable(`PERMISSION_DENIED: Card cannot be ${action} for account ${accountId} as its status is currently ${a.status}`)
    if (!accounts.holderCustomerIds(a).includes(customerHayId)) {
      throw unprocessable(`PERMISSION_DENIED: Customer ${customerHayId} does not hold account ${accountId}`)
    }
  }

  // ---------------------------------------------------------------- status machine

  /**
   * activateCard: AWAITING_ACTIVATION -> ACTIVE (422 INVALID_CARD_STATUS otherwise). The same cardholder /
   * account gate as issuance (00-open-questions S7): customer ACTIVE (422 PERMISSION_DENIED), account open
   * (422 ACCOUNT_BLOCKED / ACCOUNT_CLOSED). Activating a renewal card retires the card it renewed
   * (INACTIVE, voided).
   */
  activate(id: string, opts: { actionOwner?: ActionOwner } = {}): Card {
    const actionOwner = opts.actionOwner ?? 'CLIENT'
    return this.ctx.db.transaction(() => {
      const c = this.get(id)
      if (c.status !== 'AWAITING_ACTIVATION') throw this.invalidStatus(c, 'activated')
      const holder = this.ctx.services.customers.get(c.customerId)
      if (holder.status !== 'ACTIVE') {
        throw unprocessable(`PERMISSION_DENIED: Card cannot be activated for customer with id ${c.customerId} as their status is currently ${holder.status}`)
      }
      this.requireOpenAccountHeldBy(c.accountId, c.customerId, 'activated')
      this.transition(c, 'ACTIVE', { actionOwner })
      const old = this.repo.renewedInto(c.id)
      if (old && !TERMINAL.has(old.status)) {
        // wallet tokens added to the old card while the renewal was in transit follow it too
        this.moveWallets(old, c)
        this.transition(old, 'INACTIVE', { actionOwner })
      }
      return c
    })()
  }

  /**
   * blockCard: ACTIVE / AWAITING_ACTIVATION -> BLOCKED (blockedBy CLIENT unless given; the prior status
   * is remembered for unblock). Already BLOCKED -> no-op; INACTIVE / EXPIRED -> 422 INVALID_CARD_STATUS.
   */
  block(id: string, opts: { note?: string | null; actionOwner?: ActionOwner; blockedBy?: BlockedBy } = {}): Card {
    const c = this.get(id)
    if (c.status === 'BLOCKED') return c
    if (c.status !== 'ACTIVE' && c.status !== 'AWAITING_ACTIVATION') throw this.invalidStatus(c, 'blocked')
    const actionOwner = opts.actionOwner ?? 'CLIENT'
    return this.transition(c, 'BLOCKED', { actionOwner, blockedBy: opts.blockedBy ?? actionOwner, note: opts.note ?? undefined })
  }

  /** unblockCard: BLOCKED -> the status held before the block (ACTIVE for a card blocked while ACTIVE). Not BLOCKED -> 422 INVALID_CARD_STATUS. */
  unblock(id: string, opts: { note?: string; actionOwner?: ActionOwner } = {}): Card {
    const c = this.get(id)
    if (c.status !== 'BLOCKED') throw this.invalidStatus(c, 'unblocked')
    return this.transition(c, c.statusBeforeBlock ?? 'ACTIVE', { actionOwner: opts.actionOwner ?? 'CLIENT', note: opts.note })
  }

  /** cancelCard: any non-INACTIVE status -> INACTIVE (voided, wallet tokens disabled). Already INACTIVE -> no-op. */
  cancel(id: string, opts: { actionOwner?: ActionOwner } = {}): Card {
    const c = this.get(id)
    if (c.status === 'INACTIVE') return c
    return this.transition(c, 'INACTIVE', { actionOwner: opts.actionOwner ?? 'CLIENT' })
  }

  /**
   * Generic status change for other domains / the expiry job. Same status -> no-op; leaving INACTIVE ->
   * 422 INVALID_CARD_STATUS. Emits card.statusChanged.
   */
  setStatus(id: string, status: CardStatus, opts: StatusOptions): Card {
    const c = this.get(id)
    if (c.status === status) return c
    if (c.status === 'INACTIVE') throw this.invalidStatus(c, `moved to ${status}`)
    return this.transition(c, status, opts)
  }

  /**
   * Account-closure cascade (accounts/deps.ts): every card on the account that is not INACTIVE is
   * voided with CARD_STATUS_CHANGE {INACTIVE} (PLATFORM); `customerId` restricts it to one cardholder
   * (group-member removal).
   */
  cancelAllForAccount(accountId: string, _reason?: string, opts: { customerId?: string } = {}): void {
    for (const c of this.repo.byAccount(accountId)) {
      if (c.status === 'INACTIVE') continue
      if (opts.customerId && c.customerId !== opts.customerId) continue
      this.transition(c, 'INACTIVE', { actionOwner: 'PLATFORM' })
    }
  }

  /**
   * Group-member removal cascade (groups-stacks/deps.ts CardsDep): the cards the customer holds on the
   * group account that are not INACTIVE are voided with CARD_STATUS_CHANGE {INACTIVE} (PLATFORM).
   */
  cancelForCustomerOnAccount(customerHayId: string, accountId: string, reason?: string): void {
    this.cancelAllForAccount(accountId, reason, { customerId: customerHayId })
  }

  private transition(c: Card, to: CardStatus, opts: StatusOptions): Card {
    if (c.status === to) return c
    const from = c.status
    const now = isoUtc(this.ctx.clock.now())
    c.status = to
    c.updatedAt = now
    if (to === 'BLOCKED') {
      c.blockedBy = opts.blockedBy ?? opts.actionOwner
      c.statusBeforeBlock = from
      if (opts.note !== undefined) c.blockNote = opts.note
    } else {
      delete c.blockedBy
      delete c.statusBeforeBlock
      if (from === 'BLOCKED' && opts.note !== undefined) c.blockNote = opts.note
    }
    if (to === 'INACTIVE') c.voidAt = now
    this.repo.save(c)
    if (to === 'INACTIVE') this.disableWallets(c.id)
    this.ctx.events.emit('card.statusChanged', { card: structuredClone(c), previousStatus: from, actionOwner: opts.actionOwner })
    return c
  }

  private invalidStatus(c: Card, action: string) {
    return unprocessable(`INVALID_CARD_STATUS: Card ${c.id} cannot be ${action} from status ${c.status}`)
  }

  // ---------------------------------------------------------------- convert / re-issue / renew

  /**
   * convertCard: an ACTIVE VIRTUAL card becomes PHYSICAL and AWAITING_ACTIVATION with the same PAN,
   * token, expiry and design; wallet tokens survive. PHYSICAL or not ACTIVE -> 422 INVALID_CARD_STATUS
   * (spec §5.4 "convert only VIRTUAL+ACTIVE"). An explicit deliveryAddress replaces the stored one.
   */
  convert(id: string, input: { deliveryAddress?: Address | null } = {}, opts: { actionOwner?: ActionOwner } = {}): Card {
    const c = this.get(id)
    if (c.cardType !== 'VIRTUAL') throw unprocessable(`INVALID_CARD_STATUS: Card ${id} cannot be converted as it is already PHYSICAL`)
    if (c.status !== 'ACTIVE') throw this.invalidStatus(c, 'converted')
    return this.ctx.db.transaction(() => {
      c.cardType = 'PHYSICAL'
      if (input.deliveryAddress) c.deliveryAddress = input.deliveryAddress
      this.repo.save(c)
      return this.transition(c, 'AWAITING_ACTIVATION', { actionOwner: opts.actionOwner ?? 'CLIENT' })
    })()
  }

  /**
   * reissueHayCard (lost / stolen / damaged): the old card (ACTIVE, BLOCKED or EXPIRED; 422 otherwise)
   * is voided (INACTIVE, wallet tokens disabled) and a new card is issued with a new PAN, token, CVV and
   * expiry, copying name on card, delivery address, phone, design and PIN; cardType defaults to PHYSICAL,
   * deliveryMethod to STANDARD; preferences and PIN / CVV state start fresh. The cardholder must be
   * ACTIVE and the account open. Idempotency is the route's concern. Returns the new card.
   */
  reissue(id: string, input: ReissueInput = {}, opts: { actionOwner?: ActionOwner } = {}): Card {
    const actionOwner = opts.actionOwner ?? 'CLIENT'
    const old = this.get(id)
    if (old.status !== 'ACTIVE' && old.status !== 'BLOCKED' && old.status !== 'EXPIRED') throw this.invalidStatus(old, 're-issued')
    this.ctx.services.customers.requireActive(old.customerId, 'Card')
    this.requireOpenAccountHeldBy(old.accountId, old.customerId)
    return this.ctx.db.transaction(() => {
      const now = this.ctx.clock.now()
      const cardType = input.cardType ?? 'PHYSICAL'
      const id2 = uuid()
      const card: Card = {
        ...structuredClone(old),
        id: id2,
        status: cardType === 'VIRTUAL' ? 'ACTIVE' : 'AWAITING_ACTIVATION',
        cardType,
        pan: cardPan(this.repo.nextPanSeq()),
        cardToken: this.nextToken(),
        cvv: randomDigits(3),
        expiryDate: expiryDateFrom(now),
        issuedAt: isoUtc(now),
        deliveryMethod: input.deliveryMethod ?? 'STANDARD',
        deliveryAddress: input.deliveryAddress ?? old.deliveryAddress,
        pinEnabled: true,
        pinRemainingTries: MAX_PIN_TRIES,
        cvvRemainingTries: MAX_CVV_TRIES,
        preferences: { ...DEFAULT_PREFERENCES },
        rewardsEnrolled: false,
        remindersSent: [],
        createdAt: isoUtc(now),
      }
      delete card.blockedBy
      delete card.blockNote
      delete card.statusBeforeBlock
      delete card.voidAt
      delete card.renewedIntoCardId
      delete card.replacedByCardId
      delete card.updatedAt
      this.repo.insert(card)
      old.replacedByCardId = id2
      this.repo.save(old)
      this.transition(old, 'INACTIVE', { actionOwner })
      // a renewal still in transit shares the lost / stolen PAN and token: it is voided with the old card
      const renewal = old.renewedIntoCardId ? this.repo.byId(old.renewedIntoCardId) : undefined
      if (renewal && !TERMINAL.has(renewal.status)) this.transition(renewal, 'INACTIVE', { actionOwner })
      this.ctx.events.emit('card.created', { card: structuredClone(card), actionOwner })
      return card
    })()
  }

  /**
   * renewCard: an ACTIVE card within 2 months of its expiry date (422 RENEWAL_WINDOW otherwise; 422
   * INVALID_CARD_STATUS when not ACTIVE or already renewed) is renewed into a new card with the same PAN
   * and token and a fresh expiry, copying configuration and preferences; wallet tokens move to the new
   * card. The old card records renewedIntoCardId and stays ACTIVE until the new PHYSICAL card is activated
   * (a VIRTUAL renewal retires it immediately). Returns the new card.
   */
  renew(id: string, input: RenewInput = {}, opts: { actionOwner?: ActionOwner } = {}): Card {
    const actionOwner = opts.actionOwner ?? 'CLIENT'
    const old = this.get(id)
    if (old.status !== 'ACTIVE') throw this.invalidStatus(old, 'renewed')
    if (old.renewedIntoCardId) throw unprocessable(`INVALID_CARD_STATUS: Card ${id} has already been renewed into ${old.renewedIntoCardId}`)
    const now = this.ctx.clock.now()
    const windowStart = addMonthsClamped(parseDate(old.expiryDate)!, -RENEWAL_WINDOW_MONTHS)
    if (isoDate(now) < isoDate(windowStart)) {
      throw unprocessable(`RENEWAL_WINDOW: Card ${id} can only be renewed within ${RENEWAL_WINDOW_MONTHS} months of its expiry date ${old.expiryDate}`)
    }
    this.ctx.services.customers.requireActive(old.customerId, 'Card')
    this.requireOpenAccountHeldBy(old.accountId, old.customerId)
    return this.ctx.db.transaction(() => {
      const cardType = input.cardType ?? 'PHYSICAL'
      const id2 = uuid()
      const card: Card = {
        ...structuredClone(old),
        id: id2,
        status: cardType === 'VIRTUAL' ? 'ACTIVE' : 'AWAITING_ACTIVATION',
        cardType,
        cvv: randomDigits(3),
        expiryDate: expiryDateFrom(now),
        issuedAt: isoUtc(now),
        deliveryMethod: input.deliveryMethod ?? 'STANDARD',
        deliveryAddress: input.deliveryAddress ?? old.deliveryAddress,
        pinEnabled: true,
        pinRemainingTries: MAX_PIN_TRIES,
        cvvRemainingTries: MAX_CVV_TRIES,
        preferences: { ...old.preferences },
        remindersSent: [],
        createdAt: isoUtc(now),
      }
      delete card.blockedBy
      delete card.blockNote
      delete card.statusBeforeBlock
      delete card.voidAt
      delete card.renewedIntoCardId
      delete card.replacedByCardId
      delete card.updatedAt
      this.repo.insert(card)
      this.moveWallets(old, card)
      old.renewedIntoCardId = id2
      old.updatedAt = isoUtc(now)
      this.repo.save(old)
      this.ctx.events.emit('card.created', { card: structuredClone(card), actionOwner })
      if (card.status === 'ACTIVE') this.transition(old, 'INACTIVE', { actionOwner })
      return card
    })()
  }

  // ---------------------------------------------------------------- preferences, PIN, CVV, rewards

  preferences(id: string): CardPaymentPreferences {
    return { ...this.get(id).preferences }
  }

  /** updatePaymentPreferences: only while ACTIVE (422 INVALID_CARD_STATUS); provided non-null booleans are applied. */
  updatePreferences(id: string, patch: Partial<Record<keyof CardPreferences, boolean | null | undefined>>): CardPaymentPreferences {
    const c = this.get(id)
    if (c.status !== 'ACTIVE') throw unprocessable(`INVALID_CARD_STATUS: Card ${id} preferences can only be updated while ACTIVE (status is ${c.status})`)
    let changed = false
    for (const key of Object.keys(DEFAULT_PREFERENCES) as (keyof CardPreferences)[]) {
      const v = patch[key]
      if (v === undefined || v === null) continue
      if (c.preferences[key] !== v) { c.preferences[key] = v; changed = true }
    }
    if (changed) {
      c.updatedAt = isoUtc(this.ctx.clock.now())
      this.repo.save(c)
    }
    return { ...c.preferences }
  }

  pinStatus(id: string): { enabled: boolean } {
    return { enabled: this.get(id).pinEnabled }
  }

  /** unblockCardPin: re-enables the PIN with fresh tries (no-op when enabled); INACTIVE / EXPIRED -> 422. */
  unblockPin(id: string): Card {
    const c = this.requireNotTerminal(id, 'PIN unblocked')
    if (c.pinEnabled && c.pinRemainingTries === MAX_PIN_TRIES) return c
    c.pinEnabled = true
    c.pinRemainingTries = MAX_PIN_TRIES
    return this.touch(c)
  }

  /** changeCardPin: exactly 4 digits (400); ACTIVE or AWAITING_ACTIVATION (422 otherwise). The PIN block is untouched. */
  changePin(id: string, newPin: string): Card {
    if (typeof newPin !== 'string' || !NEW_PIN_RE.test(newPin)) throw badRequest('BAD_REQUEST: newPin must consist of exactly 4 digits')
    const c = this.get(id)
    if (c.status !== 'ACTIVE' && c.status !== 'AWAITING_ACTIVATION') throw this.invalidStatus(c, 'given a new PIN')
    c.pinHash = hashPin(newPin)
    return this.touch(c)
  }

  /** True when `pin` matches the card's PIN (used by tests and mocks; never exposed by the API). */
  verifyPin(id: string, pin: string): boolean {
    return this.get(id).pinHash === hashPin(pin)
  }

  cvvStatus(id: string): { cvvRemainingTries: number } {
    return { cvvRemainingTries: this.get(id).cvvRemainingTries }
  }

  /** unblockCardCvv: resets the remaining tries to 3 (no-op at 3); INACTIVE / EXPIRED -> 422. */
  unblockCvv(id: string): Card {
    const c = this.requireNotTerminal(id, 'CVV unblocked')
    if (c.cvvRemainingTries === MAX_CVV_TRIES) return c
    c.cvvRemainingTries = MAX_CVV_TRIES
    return this.touch(c)
  }

  /** A wrong CVV at the processor: one try fewer; the CVV is blocked at 0. */
  recordCvvFailure(id: string): Card {
    const c = this.get(id)
    if (c.cvvRemainingTries > 0) c.cvvRemainingTries--
    return this.touch(c)
  }

  blockCvv(id: string): Card {
    const c = this.get(id)
    c.cvvRemainingTries = 0
    return this.touch(c)
  }

  /** A wrong PIN at the processor: one try fewer; the PIN is blocked after the third. */
  recordPinFailure(id: string): Card {
    const c = this.get(id)
    if (c.pinRemainingTries > 0) c.pinRemainingTries--
    if (c.pinRemainingTries === 0) c.pinEnabled = false
    return this.touch(c)
  }

  blockPin(id: string): Card {
    const c = this.get(id)
    c.pinRemainingTries = 0
    c.pinEnabled = false
    return this.touch(c)
  }

  /** rewards: enrols the card (true when newly enrolled, false when it already was); INACTIVE / EXPIRED -> 422. */
  enrolRewards(id: string): boolean {
    const c = this.requireNotTerminal(id, 'enrolled to rewards')
    if (c.rewardsEnrolled) return false
    c.rewardsEnrolled = true
    this.touch(c)
    return true
  }

  private requireNotTerminal(id: string, action: string): Card {
    const c = this.get(id)
    if (TERMINAL.has(c.status)) throw this.invalidStatus(c, action)
    return c
  }

  private touch(c: Card): Card {
    c.updatedAt = isoUtc(this.ctx.clock.now())
    this.repo.save(c)
    return c
  }

  // ---------------------------------------------------------------- digital wallets / OEM provisioning

  wallets(id: string): DigitalWalletDetails {
    const c = this.get(id)
    const wallets = this.repo.walletsFor(c.id)
    return compact({
      primaryAccountIdentifier: wallets[0]?.primaryAccountIdentifier,
      wallets: wallets.map((w) => ({ createdAt: w.createdAt, digitalWalletStatus: w.status, expiresAt: w.expiresAt, reference: w.reference, type: WALLET_PROVIDER[w.walletType] })),
    }) as DigitalWalletDetails
  }

  /**
   * Device provisioning (outside the B2B API): stores an ACTIVE_TOKEN wallet on an ACTIVE card and emits
   * CARD_ADDED_TO_WALLET. Provisioning ignores mobileWalletPaymentsEnabled (payments are gated at
   * authorisation). Not ACTIVE -> 422 INVALID_CARD_STATUS.
   */
  provisionWallet(id: string, walletType: WalletType): Wallet {
    const c = this.get(id)
    if (c.status !== 'ACTIVE') throw this.invalidStatus(c, 'added to a wallet')
    const w: Wallet = {
      id: uuid(),
      cardId: c.id,
      walletType,
      status: 'ACTIVE_TOKEN',
      reference: `DTR${randomDigits(12)}`,
      primaryAccountIdentifier: this.repo.walletsFor(c.id)[0]?.primaryAccountIdentifier ?? primaryAccountIdentifierFor(c.pan),
      createdAt: isoUtc(this.ctx.clock.now()),
      expiresAt: c.expiryDate,
    }
    this.repo.insertWallet(w)
    this.ctx.events.emit('card.addedToWallet', { card: structuredClone(c), wallet: { ...w }, activationCode: randomDigits(6) })
    return w
  }

  /** Active wallet tokens of `from` move to `to` (renewal: same PAN), taking its expiry date. */
  private moveWallets(from: Card, to: Card): void {
    for (const w of this.repo.walletsFor(from.id)) {
      if (w.status !== 'ACTIVE_TOKEN') continue
      w.cardId = to.id
      w.expiresAt = to.expiryDate
      this.repo.saveWallet(w)
    }
  }

  private disableWallets(cardId: string): void {
    for (const w of this.repo.walletsFor(cardId)) {
      if (w.status === 'INACTIVE_TOKEN') continue
      w.status = 'INACTIVE_TOKEN'
      this.repo.saveWallet(w)
    }
  }

  /** getOemProvisioningData: a fresh 6-digit one-time password each call. */
  oemProvisioningData(id: string): OemProvisioningData {
    const c = this.get(id)
    return { cardHolderName: c.nameOnCard, cardToken: c.cardToken, expiryDate: c.expiryDate, otp: randomDigits(6) }
  }

  // ---------------------------------------------------------------- expiry

  /**
   * changeCardExpiryDate (utilities): the date is normalised to its month end; a card already past the new
   * date expires on the spot (CARD_STATUS_CHANGE {EXPIRED}, PLATFORM). Reminder bookkeeping restarts.
   */
  setExpiryDate(id: string, date: string): Card {
    const c = this.get(id)
    const parsed = parseDate(date)
    if (!parsed) throw badRequest(`BAD_REQUEST: expiryDate must be a date of the form YYYY-MM-DD, got ${date}`)
    c.expiryDate = isoDate(monthEnd(parsed))
    c.remindersSent = []
    this.touch(c)
    // ApiDigitalWallet.expiresAt is "the card expiry date"
    for (const w of this.repo.walletsFor(c.id)) {
      if (w.expiresAt === c.expiryDate) continue
      w.expiresAt = c.expiryDate
      this.repo.saveWallet(w)
    }
    this.expireCard(c)
    return c
  }

  /**
   * Time-driven job: ACTIVE / AWAITING_ACTIVATION cards past their expiry date become EXPIRED (PLATFORM);
   * cards approaching expiry (any non-terminal status, not yet renewed) get the CARD_EXPIRY_MONTH /
   * 2_WEEK / DAY reminders, each once.
   */
  tick(): void {
    const now = this.ctx.clock.now()
    const today = isoDate(now)
    // Only cards inside the earliest reminder window can have anything due (a few days of slack for the calendar-month clamp).
    const horizon = isoDate(addDays(addMonthsClamped(now, 1), 3))
    for (const c of this.repo.expiryCandidates(today, horizon)) {
      if (this.expireCard(c, today)) continue
      // a BLOCKED card keeps its status past the expiry date, but "about to expire" reminders stop there
      if (c.renewedIntoCardId || today > c.expiryDate) continue
      const expiry = parseDate(c.expiryDate)!
      const due: [ExpiryReminderType, Date][] = [
        ['CARD_EXPIRY_MONTH_REMINDER', addMonthsClamped(expiry, -1)],
        ['CARD_EXPIRY_2_WEEK_REMINDER', addDays(expiry, -14)],
        ['CARD_EXPIRY_DAY_REMINDER', addDays(expiry, -1)],
      ]
      for (const [type, at] of due) {
        if (c.remindersSent.includes(type) || today < isoDate(at)) continue
        c.remindersSent.push(type)
        this.touch(c)
        this.ctx.events.emit('card.expiryReminder', { card: structuredClone(c), reminderType: type })
      }
    }
  }

  /** EXPIRED when the card is ACTIVE / AWAITING_ACTIVATION and today is past its expiry date. */
  private expireCard(c: Card, today = isoDate(this.ctx.clock.now())): boolean {
    if (c.status !== 'ACTIVE' && c.status !== 'AWAITING_ACTIVATION') return false
    if (today <= c.expiryDate) return false
    this.transition(c, 'EXPIRED', { actionOwner: 'PLATFORM' })
    return true
  }

  // ---------------------------------------------------------------- authorisation

  /**
   * Card-side authorisation checks, in the shape transactions.holds.authorise takes as `refusal`: null
   * when the card may transact. Status: BLOCKED -> REFUSED_CARD_PREFERENCE / CARD_BLOCKED /
   * REFUSED_CARD_BLOCKED; EXPIRED or past expiry -> REFUSED_RULES / EXPIRED_CARD; AWAITING_ACTIVATION or
   * INACTIVE -> REFUSED_RULES / CARD_IS_NOT_ACTIVE. Preferences (REFUSED_CARD_PREFERENCE): wallet payments
   * need only mobileWalletPaymentsEnabled; otherwise cardEnabled overrides everything (CARD_FROZEN), then
   * the channel flag (CASH_WITHDRAWAL_DISABLED, MAGNETIC_STRIPE_PAYMENT_DISABLED, CONTACTLESS_DISABLED,
   * CARD_NOT_PRESENT_DISABLED). Then a blocked PIN (ALLOWED_PIN_RETRIES_EXCEEDED) or CVV (CVV2_FAILURE)
   * when one was entered. Account status, rules, limits and funds are the ledger's checks.
   */
  authorise(ref: string | Card, input: CardCheckInput = {}): CardRefusal | null {
    const c = typeof ref === 'string' ? this.resolve(ref) : ref
    const usage = input.cardUsage
    const type: HoldType = input.type ?? (usage?.isAtmWithdrawal ? 'ATM_WITHDRAWAL' : usage?.isCardPresent ? 'CARD_PRESENT_PAYMENT' : 'CARD_NOT_PRESENT_PAYMENT')
    const atm = type === 'ATM_WITHDRAWAL' || usage?.isAtmWithdrawal === true
    const wallet = usage?.isMobileWalletPayment === true
    const contactless = usage?.isContactless === true
    const magstripe = usage?.isMagneticStripePayment === true
    const cardPresent = atm || contactless || magstripe || usage?.isCardPresent === true || (usage === undefined && type === 'CARD_PRESENT_PAYMENT')
    const processor = (cardProcessorResponse: CardProcessorResponse, reason: string): CardRefusal => ({ outcome: 'REFUSED_RULES', cardPreferenceOutcome: 'OK', cardProcessorResponse, reason })
    const preference = (cardPreferenceOutcome: CardPreferenceOutcome, reason: string, cardProcessorResponse?: CardProcessorResponse): CardRefusal =>
      compact({ outcome: 'REFUSED_CARD_PREFERENCE', cardPreferenceOutcome, cardProcessorResponse, reason }) as CardRefusal

    if (c.status === 'BLOCKED') return preference('CARD_BLOCKED', `Card ${c.id} is BLOCKED`, 'REFUSED_CARD_BLOCKED')
    if (c.status === 'EXPIRED' || isoDate(this.ctx.clock.now()) > c.expiryDate) return processor('EXPIRED_CARD', `Card ${c.id} expired on ${c.expiryDate}`)
    if (c.status !== 'ACTIVE') return processor('CARD_IS_NOT_ACTIVE', `Card ${c.id} is ${c.status}`)

    const p = c.preferences
    if (wallet) {
      if (!p.mobileWalletPaymentsEnabled) return preference('MOBILE_WALLET_PAYMENT_DISABLED', `Card ${c.id} has mobile wallet payments disabled`)
    } else {
      if (!p.cardEnabled) return preference('CARD_FROZEN', `Card ${c.id} is frozen (cardEnabled false)`)
      if (atm) {
        if (!p.cashWithdrawalEnabled) return preference('CASH_WITHDRAWAL_DISABLED', `Card ${c.id} has cash withdrawals disabled`)
      } else if (magstripe) {
        if (!p.magneticStripeEnabled) return preference('MAGNETIC_STRIPE_PAYMENT_DISABLED', `Card ${c.id} has magnetic stripe payments disabled`)
      } else if (contactless) {
        if (!p.contactlessEnabled) return preference('CONTACTLESS_DISABLED', `Card ${c.id} has contactless payments disabled`)
      } else if (!cardPresent) {
        if (!p.cardNotPresentEnabled) return preference('CARD_NOT_PRESENT_DISABLED', `Card ${c.id} has card-not-present payments disabled`)
      }
    }

    const pinEntered = input.pinEntered ?? (!wallet && (atm || (cardPresent && !contactless && !magstripe)))
    const cvvEntered = input.cvvEntered ?? (!wallet && !cardPresent)
    if (pinEntered && !c.pinEnabled) return processor('ALLOWED_PIN_RETRIES_EXCEEDED', `Card ${c.id} PIN is blocked`)
    if (cvvEntered && c.cvvRemainingTries === 0) return processor('CVV2_FAILURE', `Card ${c.id} CVV is blocked`)
    return null
  }

  /** The CardContext the ledger's holds take, for a card resolved by id or token. */
  cardContext(c: Card, extra: { cardUsage?: CardUsageDetails; merchant?: ExternalMerchantDetails } = {}): AuthoriseHoldInput['card'] {
    return compact({ cardHayId: c.id, cardToken: c.cardToken, lastFour: c.pan.slice(-4), cardUsage: extra.cardUsage, merchant: extra.merchant })
  }

  /**
   * A card authorisation end to end: the card-side checks (or the caller's processor decline) feed
   * transactions.holds.authorise on the card's account, which applies the account gate, rules, limits and
   * funds, holds the amount or emits the refused TRANSACTION webhook. @throws 404 unknown card
   */
  authoriseHold(ref: string | Card, input: CardHoldInput): HoldResult & { card: Card } {
    const c = typeof ref === 'string' ? this.resolve(ref) : ref
    const refusal = input.refusal ?? this.authorise(c, input) ?? undefined
    const result = this.ctx.services.transactions.holds.authorise(compact({
      accountId: c.accountId,
      card: this.cardContext(c, { cardUsage: input.cardUsage, merchant: input.merchant }),
      amountCents: input.amountCents,
      type: input.type,
      channel: input.channel,
      originalAmount: input.originalAmount,
      description: input.description,
      category: input.category,
      countryOfExpenditure: input.countryOfExpenditure,
      externalIdentifiers: input.externalIdentifiers,
      transactionTimeUtc: input.transactionTimeUtc,
      actionOwner: input.actionOwner,
      refusal: refusal ? { outcome: refusal.outcome, cardPreferenceOutcome: refusal.cardPreferenceOutcome, cardProcessorResponse: refusal.cardProcessorResponse } : undefined,
    }))
    return { ...result, card: c }
  }
}

// ---------------------------------------------------------------- helpers

/**
 * docs:card-creation — "first last" when shorter than 23 characters, else "F last". A last name too long
 * even for that is cut at the 23-character limit rather than failing a request that never sent nameOnCard.
 */
export function defaultNameOnCard(firstName: string, lastName: string): string {
  const full = `${firstName} ${lastName}`
  return full.length < NAME_ON_CARD_MAX ? full : `${firstName.charAt(0)} ${lastName}`.slice(0, NAME_ON_CARD_MAX).trimEnd()
}

/** Last day of the month EXPIRY_YEARS after `issued` (YYYY-MM-DD). */
export function expiryDateFrom(issued: Date): string {
  return isoDate(new Date(Date.UTC(issued.getUTCFullYear() + EXPIRY_YEARS, issued.getUTCMonth() + 1, 0)))
}

export function monthEnd(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
}

/** YYYY-MM-DD -> UTC midnight, or undefined when malformed / not a real date. */
export function parseDate(s: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return undefined
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return isoDate(d) === s ? d : undefined
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000)
}

/** Calendar-month arithmetic with the day clamped to the target month's length (Mar 31 - 1 month = Feb 28/29). */
export function addMonthsClamped(d: Date, months: number): Date {
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + months
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay)))
}

function hashPin(pin: string): string {
  return createHash('sha256').update(`card-pin:${pin}`).digest('hex')
}

function randomDigits(n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += String(randomInt(0, 10))
  return s
}

/** Opaque wallet-provider PAN reference (Visa PAR style: 'V' + 28 alphanumerics), stable per PAN. */
function primaryAccountIdentifierFor(pan: string): string {
  return 'V' + createHash('sha256').update(`par:${pan}`).digest('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 28).toUpperCase()
}
