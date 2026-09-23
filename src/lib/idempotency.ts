/**
 * Body-carried idempotency (18 create operations send `idempotencyKey`). Scope = operationId.
 * Same key + identical body -> replay the stored status and body. Same key + different body -> 422.
 */
import { createHash } from 'node:crypto'
import type { AppContext } from '../context.js'
import { isoUtc } from './clock.js'
import { unprocessable } from './errors.js'

export interface IdempotentResult<T> { status: number; body: T; replayed: boolean }

export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

export async function withIdempotency<T>(
  ctx: AppContext,
  scope: string,
  key: string | undefined | null,
  body: unknown,
  run: () => { status: number; body: T } | Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  if (!key) {
    const r = await run()
    return { ...r, replayed: false }
  }
  const hash = stableHash(body)
  const existing = ctx.db.prepare('SELECT request_hash, status, body FROM idempotency WHERE scope = ? AND key = ?').get(scope, key) as
    | { request_hash: string; status: number; body: string | null }
    | undefined
  if (existing) {
    if (existing.request_hash !== hash) throw unprocessable(`IDEMPOTENCY_KEY_REUSED: idempotencyKey ${key} was already used with a different request body`)
    return { status: existing.status, body: (existing.body === null ? undefined : JSON.parse(existing.body)) as T, replayed: true }
  }
  const r = await run()
  ctx.db
    .prepare('INSERT INTO idempotency(scope, key, request_hash, status, body, created_at) VALUES (?,?,?,?,?,?)')
    .run(scope, key, hash, r.status, r.body === undefined ? null : JSON.stringify(r.body), isoUtc(ctx.clock.now()))
  return { ...r, replayed: false }
}
