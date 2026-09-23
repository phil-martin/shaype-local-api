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

export function fromCents(cents: Cents): number {
  return Math.round(cents) / 100
}

export function centsToString(cents: Cents): string {
  return fromCents(cents).toFixed(2)
}
