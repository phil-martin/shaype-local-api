/**
 * Money helpers. Stored as integer minor units (cents) in SQLite; exposed as JSON numbers with ≤2 dp
 * (the B2B spec uses `number` amounts) or as strings where a DTO demands it (PayTo CurrencyAmountDto).
 */
export type Cents = number

export function toCents(amount: number | string): Cents {
  const n = typeof amount === 'string' ? Number(amount) : amount
  if (!Number.isFinite(n)) throw new TypeError(`Invalid amount: ${amount}`)
  return Math.round(n * 100)
}

/**
 * True when a JSON amount carries at most two decimal places (the spec's "value to 2 decimal places").
 * Exact for every 2-dp decimal literal: `Math.round(x * 100) / 100` re-derives the same double the
 * parser produced, while a third decimal changes it. Non-finite values are refused.
 */
export function hasAtMostTwoDecimals(amount: number): boolean {
  return Number.isFinite(amount) && Math.round(amount * 100) / 100 === amount
}

/** toCents for request amounts: refuses more than two decimal places (RangeError) instead of silently rounding. */
export function toCentsStrict(amount: number): Cents {
  if (!hasAtMostTwoDecimals(amount)) throw new RangeError(`Invalid amount: ${amount} has more than 2 decimal places`)
  return Math.round(amount * 100)
}

export function fromCents(cents: Cents): number {
  return Math.round(cents) / 100
}

export function centsToString(cents: Cents): string {
  return fromCents(cents).toFixed(2)
}
