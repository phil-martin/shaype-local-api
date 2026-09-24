/**
 * The BPAY biller directory (spec §5.7 [decision]): every 4–10 digit biller code is an active biller
 * with synthesised names, except `000000` (the deactivated biller). The five Staging fixtures from
 * docs/map/bpay.md §2 are seeded verbatim on top (names, ANZSIC codes, accepted CRN lengths and
 * amount bounds — their documented inconsistencies included), so the developer-docs walkthroughs
 * behave here as they do on Shaype's staging. Check-digit algorithms (MOD10V01, MOD11V09) are not
 * modelled: a CRN is valid when it is all digits and has an accepted length.
 */
import type { Cents } from '../../lib/money.js'

export interface DirectoryBiller {
  billerCode: string
  shortName: string
  longName: string
  industryAnzsicCode: string
  /** Look Who's Charging logo URL (fabricated locally). */
  image: string
  /** Accepted CRN lengths; absent = any length from 2 to 20. */
  crnLengths?: readonly number[]
  /** Lower / upper payment bounds (cents), when the biller declares them. */
  minCents?: Cents
  maxCents?: Cents
  /** ICRNAMT billers: the CRN encodes the amount due, which the payment must match exactly. */
  exactCents?: Cents
  active: boolean
}

export type CrnFailure = 'BILLER_CODE' | 'REFERENCE' | 'AMOUNT'
export interface DirectoryRefusal { ok: false; failure: CrnFailure; message: string }
export type DirectoryResult = { ok: true; biller: DirectoryBiller } | DirectoryRefusal

const BILLER_CODE_RE = /^\d{4,10}$/
const CRN_RE = /^\d{2,20}$/
export const DEACTIVATED_BILLER_CODE = '000000'

export const billerImage = (billerCode: string): string => `https://billers.local/${billerCode}.png`

const D = 100
/** Every CRN length from `from` to `to` inclusive. */
const lengths = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** Staging biller fixtures [docs:bpay], as documented (fixture 1016 is the "Inactive Biller"). */
export const STAGING_BILLERS: readonly DirectoryBiller[] = [
  { billerCode: '7773', shortName: 'APIBCD SERVICES AV1', longName: 'APIBCD SERVICES AV1', industryAnzsicCode: '1113', image: billerImage('7773'), crnLengths: [8], minCents: 20 * D, maxCents: 50_000 * D, active: true },
  { billerCode: '93849', shortName: 'APIBCD SERVICES AV8', longName: 'APIBCD SERVICES AV8', industryAnzsicCode: '6931', image: billerImage('93849'), crnLengths: [7, 9, 10], minCents: 10 * D, maxCents: 20_000 * D, active: true },
  { billerCode: '93880', shortName: 'APIBCD SERVICES AV12', longName: 'APIBCD SERVICES AV12', industryAnzsicCode: '94540', image: billerImage('93880'), crnLengths: [12], minCents: 10 * D, maxCents: 4_000 * D, active: true },
  { billerCode: '600015', shortName: 'API2 SERVICES ICRN', longName: 'API2 SERVICES ICRN AMT', industryAnzsicCode: '3501', image: billerImage('600015'), crnLengths: lengths(4, 20), exactCents: 104 * D, active: true },
  { billerCode: '1016', shortName: 'BILLER 505529', longName: 'BILLER LONG NAME 505529', industryAnzsicCode: '3501', image: billerImage('1016'), crnLengths: [10], active: false },
]

const fixtures = new Map(STAGING_BILLERS.map((b) => [b.billerCode, b]))

/** The directory entry for a code (active or not), or undefined when the code is not a biller code at all. */
export function lookupBiller(billerCode: string): DirectoryBiller | undefined {
  const fixture = fixtures.get(billerCode)
  if (fixture) return fixture
  if (!BILLER_CODE_RE.test(billerCode)) return undefined
  if (billerCode === DEACTIVATED_BILLER_CODE) {
    return { billerCode, shortName: `BILLER ${billerCode}`, longName: `DEACTIVATED BILLER ${billerCode}`, industryAnzsicCode: '9999', image: billerImage(billerCode), active: false }
  }
  return { billerCode, shortName: `BILLER ${billerCode}`, longName: `BILLER LONG NAME ${billerCode}`, industryAnzsicCode: '9999', image: billerImage(billerCode), active: true }
}

/**
 * Validates a biller code, a CRN against that biller's rules and (when given) the amount against the
 * biller's bounds, in that order: the first failure names the field (BILLER_CODE / REFERENCE / AMOUNT).
 */
export function validateDirectory(billerCode: string, reference: string, amountCents?: Cents): DirectoryResult {
  const biller = lookupBiller(billerCode)
  if (!biller) return { ok: false, failure: 'BILLER_CODE', message: `Biller code ${billerCode} must be 4 to 10 digits` }
  if (!biller.active) return { ok: false, failure: 'BILLER_CODE', message: `Biller code ${billerCode} is not an active BPAY biller` }
  if (!CRN_RE.test(reference)) return { ok: false, failure: 'REFERENCE', message: `Reference ${reference} must be 2 to 20 digits` }
  if (biller.crnLengths && !biller.crnLengths.includes(reference.length)) {
    return { ok: false, failure: 'REFERENCE', message: `Reference ${reference} must be ${describeLengths(biller.crnLengths)} digits for biller ${billerCode}` }
  }
  if (amountCents !== undefined) {
    if (biller.exactCents !== undefined && amountCents !== biller.exactCents) {
      return { ok: false, failure: 'AMOUNT', message: `Biller ${billerCode} only accepts the exact amount due of ${dollars(biller.exactCents)}` }
    }
    if (biller.minCents !== undefined && amountCents < biller.minCents) return { ok: false, failure: 'AMOUNT', message: `Biller ${billerCode} accepts a minimum of ${dollars(biller.minCents)}` }
    if (biller.maxCents !== undefined && amountCents > biller.maxCents) return { ok: false, failure: 'AMOUNT', message: `Biller ${billerCode} accepts a maximum of ${dollars(biller.maxCents)}` }
  }
  return { ok: true, biller }
}

/** "8", "7, 9, 10", or "4 to 20" for a contiguous run of three or more. */
function describeLengths(ls: readonly number[]): string {
  const contiguous = ls.length >= 3 && ls.every((l, i) => i === 0 || l === ls[i - 1]! + 1)
  return contiguous ? `${ls[0]} to ${ls[ls.length - 1]}` : ls.join(', ')
}

function dollars(cents: Cents): string {
  return `$${(cents / 100).toFixed(2)}`
}
