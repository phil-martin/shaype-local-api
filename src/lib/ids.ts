import { randomUUID } from 'node:crypto'

export const uuid = (): string => randomUUID()

/** Single BSB issued by the local bank (from the docs sample account). */
export const LOCAL_BSB = '636220'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s)

/** 8-digit account number matching CreateAccountRequestBody's ^[1-9][0-9]{7,8}$ */
export function accountNumber(seq: number): string {
  return String(10_000_000 + seq)
}

/** 16-digit Visa-style PAN (Luhn-valid) — only lastFourDigits and a token are ever exposed. */
export function cardPan(seq: number): string {
  const base = '4' + String(seq).padStart(14, '0')
  let sum = 0
  for (let i = 0; i < base.length; i++) {
    let d = Number(base[base.length - 1 - i])
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return base + String((10 - (sum % 10)) % 10)
}
