/**
 * SQL for cards and card_wallets: rows <-> entities.
 */
import type { components } from '../../contract/generated/b2b-types.js'
import { json, nextSeq, type Db } from '../../db/index.js'

type S = components['schemas']
export type Address = S['Address']
export type PhoneNumber = S['PhoneNumber']
export type CardStatus = 'ACTIVE' | 'AWAITING_ACTIVATION' | 'BLOCKED' | 'INACTIVE' | 'EXPIRED'
export type CardType = 'PHYSICAL' | 'VIRTUAL'
export type BlockedBy = 'CLIENT' | 'PLATFORM'
export type DeliveryMethod = 'STANDARD' | 'REGISTERED' | 'COURIER' | 'EXPRESS'
export type ExpiryReminderType = 'CARD_EXPIRY_MONTH_REMINDER' | 'CARD_EXPIRY_2_WEEK_REMINDER' | 'CARD_EXPIRY_DAY_REMINDER'
export type WalletType = 'DEFAULT_WALLET' | 'APPLE_WALLET' | 'ANDROID_WALLET' | 'SAMSUNG_WALLET'
export type WalletStatus = 'ACTIVE_TOKEN' | 'INACTIVE_TOKEN'

export interface CardPreferences {
  cardEnabled: boolean
  cardNotPresentEnabled: boolean
  cashWithdrawalEnabled: boolean
  contactlessEnabled: boolean
  magneticStripeEnabled: boolean
  mobileWalletPaymentsEnabled: boolean
}

export interface Card {
  id: string
  accountId: string
  customerId: string
  status: CardStatus
  /** Status the card held before blockCard (restored by unblockCard). */
  statusBeforeBlock?: CardStatus
  cardType: CardType
  blockedBy?: BlockedBy
  blockNote?: string
  /** Full PAN; only the last four digits are exposed. */
  pan: string
  cardToken: string
  /** Never exposed. */
  cvv: string
  /** YYYY-MM-DD, always a month end */
  expiryDate: string
  issuedAt: string
  voidAt?: string
  renewedIntoCardId?: string
  replacedByCardId?: string
  deliveryMethod: DeliveryMethod
  deliveryAddress: Address
  phoneNumber: PhoneNumber
  email: string
  firstName: string
  lastName: string
  title?: string
  cardSubDesign: string
  nameOnCard: string
  nameOnCardLine2?: string
  pinHash: string
  pinEnabled: boolean
  pinRemainingTries: number
  cvvRemainingTries: number
  preferences: CardPreferences
  rewardsEnrolled: boolean
  remindersSent: ExpiryReminderType[]
  createdAt: string
  updatedAt?: string
}

export interface Wallet {
  id: string
  cardId: string
  walletType: WalletType
  status: WalletStatus
  reference: string
  primaryAccountIdentifier: string
  createdAt: string
  /** card expiry date (YYYY-MM-DD) */
  expiresAt: string
}

type Row = Record<string, unknown>

export class CardRepo {
  constructor(private readonly db: Db) {}

  nextPanSeq(): number {
    return nextSeq(this.db, 'card-pan')
  }

  nextTokenSeq(): number {
    return nextSeq(this.db, 'card-token')
  }

  insert(c: Card): void {
    const r = toRow(c)
    const cols = Object.keys(r)
    this.db.prepare(`INSERT INTO cards(seq, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(nextSeq(this.db, 'card-row'), ...cols.map((k) => r[k]))
  }

  save(c: Card): void {
    const r = toRow(c)
    const cols = Object.keys(r).filter((k) => k !== 'id')
    this.db.prepare(`UPDATE cards SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => r[k]), c.id)
  }

  byId(id: string): Card | undefined {
    const r = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Row | undefined
    return r ? fromRow(r) : undefined
  }

  /** The usable card for a public token: a renewed card and its renewal share the token, so prefer the ACTIVE one, then the newest. */
  byToken(token: string): Card | undefined {
    const r = this.db.prepare(`SELECT * FROM cards WHERE card_token = ? ORDER BY (status = 'ACTIVE') DESC, seq DESC LIMIT 1`).get(token) as Row | undefined
    return r ? fromRow(r) : undefined
  }

  byAccount(accountId: string): Card[] {
    return (this.db.prepare('SELECT * FROM cards WHERE account_id = ? ORDER BY seq ASC').all(accountId) as Row[]).map(fromRow)
  }

  byCustomer(customerId: string): Card[] {
    return (this.db.prepare('SELECT * FROM cards WHERE customer_id = ? ORDER BY seq ASC').all(customerId) as Row[]).map(fromRow)
  }

  /** The card whose renewedIntoCardId names `cardId` (the card it renewed). */
  renewedInto(cardId: string): Card | undefined {
    const r = this.db.prepare('SELECT * FROM cards WHERE renewed_into_card_id = ? LIMIT 1').get(cardId) as Row | undefined
    return r ? fromRow(r) : undefined
  }

  /**
   * The expiry tick's working set, creation order: ACTIVE / AWAITING_ACTIVATION cards expiring on or before
   * `horizon` (they may expire or be due a reminder) and BLOCKED cards expiring between `today` and `horizon`
   * (reminders only — a BLOCKED card past its expiry date has nothing left to do). Dates are YYYY-MM-DD.
   */
  expiryCandidates(today: string, horizon: string): Card[] {
    return (this.db
      .prepare(`SELECT * FROM cards WHERE expiry_date <= ? AND (status IN ('ACTIVE', 'AWAITING_ACTIVATION') OR (status = 'BLOCKED' AND expiry_date >= ?)) ORDER BY seq ASC`)
      .all(horizon, today) as Row[]).map(fromRow)
  }

  // ---------------------------------------------------------------- wallets

  insertWallet(w: Wallet): void {
    this.db
      .prepare('INSERT INTO card_wallets(id, seq, card_id, wallet_type, status, reference, primary_account_identifier, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(w.id, nextSeq(this.db, 'card-wallet'), w.cardId, w.walletType, w.status, w.reference, w.primaryAccountIdentifier, w.createdAt, w.expiresAt)
  }

  saveWallet(w: Wallet): void {
    this.db.prepare('UPDATE card_wallets SET card_id = ?, status = ?, expires_at = ? WHERE id = ?').run(w.cardId, w.status, w.expiresAt, w.id)
  }

  walletsFor(cardId: string): Wallet[] {
    return (this.db.prepare('SELECT * FROM card_wallets WHERE card_id = ? ORDER BY seq ASC').all(cardId) as Row[]).map(walletFromRow)
  }
}

// ---------------------------------------------------------------- row mapping

function toRow(c: Card): Row {
  const p = c.preferences
  return {
    id: c.id,
    account_id: c.accountId,
    customer_id: c.customerId,
    status: c.status,
    status_before_block: c.statusBeforeBlock ?? null,
    card_type: c.cardType,
    blocked_by: c.blockedBy ?? null,
    block_note: c.blockNote ?? null,
    pan: c.pan,
    card_token: c.cardToken,
    cvv: c.cvv,
    expiry_date: c.expiryDate,
    issued_at: c.issuedAt,
    void_at: c.voidAt ?? null,
    renewed_into_card_id: c.renewedIntoCardId ?? null,
    replaced_by_card_id: c.replacedByCardId ?? null,
    delivery_method: c.deliveryMethod,
    delivery_address: JSON.stringify(c.deliveryAddress),
    phone_number: JSON.stringify(c.phoneNumber),
    email: c.email,
    first_name: c.firstName,
    last_name: c.lastName,
    title: c.title ?? null,
    card_sub_design: c.cardSubDesign,
    name_on_card: c.nameOnCard,
    name_on_card_line2: c.nameOnCardLine2 ?? null,
    pin_hash: c.pinHash,
    pin_enabled: c.pinEnabled ? 1 : 0,
    pin_remaining_tries: c.pinRemainingTries,
    cvv_remaining_tries: c.cvvRemainingTries,
    pref_card_enabled: p.cardEnabled ? 1 : 0,
    pref_card_not_present: p.cardNotPresentEnabled ? 1 : 0,
    pref_cash_withdrawal: p.cashWithdrawalEnabled ? 1 : 0,
    pref_contactless: p.contactlessEnabled ? 1 : 0,
    pref_magnetic_stripe: p.magneticStripeEnabled ? 1 : 0,
    pref_mobile_wallet: p.mobileWalletPaymentsEnabled ? 1 : 0,
    rewards_enrolled: c.rewardsEnrolled ? 1 : 0,
    reminders_sent: JSON.stringify(c.remindersSent),
    created_at: c.createdAt,
    updated_at: c.updatedAt ?? null,
  }
}

function fromRow(r: Row): Card {
  const c: Card = {
    id: r.id as string,
    accountId: r.account_id as string,
    customerId: r.customer_id as string,
    status: r.status as CardStatus,
    cardType: r.card_type as CardType,
    pan: r.pan as string,
    cardToken: r.card_token as string,
    cvv: r.cvv as string,
    expiryDate: r.expiry_date as string,
    issuedAt: r.issued_at as string,
    deliveryMethod: r.delivery_method as DeliveryMethod,
    deliveryAddress: JSON.parse(r.delivery_address as string) as Address,
    phoneNumber: JSON.parse(r.phone_number as string) as PhoneNumber,
    email: r.email as string,
    firstName: r.first_name as string,
    lastName: r.last_name as string,
    cardSubDesign: r.card_sub_design as string,
    nameOnCard: r.name_on_card as string,
    pinHash: r.pin_hash as string,
    pinEnabled: r.pin_enabled === 1,
    pinRemainingTries: r.pin_remaining_tries as number,
    cvvRemainingTries: r.cvv_remaining_tries as number,
    preferences: {
      cardEnabled: r.pref_card_enabled === 1,
      cardNotPresentEnabled: r.pref_card_not_present === 1,
      cashWithdrawalEnabled: r.pref_cash_withdrawal === 1,
      contactlessEnabled: r.pref_contactless === 1,
      magneticStripeEnabled: r.pref_magnetic_stripe === 1,
      mobileWalletPaymentsEnabled: r.pref_mobile_wallet === 1,
    },
    rewardsEnrolled: r.rewards_enrolled === 1,
    remindersSent: (json.parse<ExpiryReminderType[]>(r.reminders_sent as string) ?? []),
    createdAt: r.created_at as string,
  }
  setIfPresent(c, [
    ['statusBeforeBlock', r.status_before_block], ['blockedBy', r.blocked_by], ['blockNote', r.block_note], ['voidAt', r.void_at],
    ['renewedIntoCardId', r.renewed_into_card_id], ['replacedByCardId', r.replaced_by_card_id], ['title', r.title],
    ['nameOnCardLine2', r.name_on_card_line2], ['updatedAt', r.updated_at],
  ])
  return c
}

function walletFromRow(r: Row): Wallet {
  return {
    id: r.id as string,
    cardId: r.card_id as string,
    walletType: r.wallet_type as WalletType,
    status: r.status as WalletStatus,
    reference: r.reference as string,
    primaryAccountIdentifier: r.primary_account_identifier as string,
    createdAt: r.created_at as string,
    expiresAt: r.expires_at as string,
  }
}

function setIfPresent<T extends object>(target: T, entries: [keyof T, unknown][]): void {
  for (const [k, v] of entries) if (v !== null && v !== undefined) (target as Record<keyof T, unknown>)[k] = v
}
