/**
 * Outbound webhook delivery. Persists every notification, POSTs it to the configured client base URL
 * at the spec paths, and retries with exponential backoff on 401/403/429/5xx or network failure —
 * the same trigger set Shaype documents (18 attempts over 48h there; a handful over seconds here).
 *
 * close() (app shutdown) and reset() (/_admin/reset) abort the delivery in flight and wait, bounded, for
 * the delivery loop to stop. Every step of the loop re-checks after each await that the dispatcher was
 * neither closed nor reset meanwhile, so a delivery that outlives either never touches the database (closed,
 * or holding other rows by then) and nothing queued before a reset is sent after it.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import type { Config } from '../config.js'
import { nextSeq, type Db } from '../db/index.js'
import { isoUtc, type Clock } from '../lib/clock.js'

export type WebhookVersion = 'v0' | 'v1'
export type NotificationStatus = 'queued' | 'delivered' | 'failed' | 'stored'

export interface NotificationRow {
  id: string
  version: WebhookVersion
  type: string
  payload: unknown
  status: NotificationStatus
  attempts: number
  lastStatus: number | null
  lastError: string | null
  createdAt: string
  nextAttemptAt: string | null
  deliveredAt: string | null
  seq: number
}

const RETRYABLE = (status: number) => status === 401 || status === 403 || status === 429 || status >= 500

export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null
  /** The running delivery loop, if any. */
  private pumping: Promise<void> | null = null
  private idleWaiters: (() => void)[] = []
  /** Abort handles of the requests in flight. */
  private readonly inflight = new Set<AbortController>()
  private closed = false
  /** Bumped by reset(): a loop started under an older epoch stops at its next step. */
  private epoch = 0

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly log: FastifyBaseLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get targetBase(): string | null {
    return this.config.webhookUrl ? this.config.webhookUrl.replace(/\/+$/, '') : null
  }

  urlFor(version: WebhookVersion): string | null {
    return this.targetBase ? `${this.targetBase}/api/hay/${version}/communications/notification` : null
  }

  /** Persist and schedule a notification. `payload` must already carry `idempotencyKey` and `type`. */
  enqueue(version: WebhookVersion, payload: { idempotencyKey?: string; type: string } & Record<string, unknown>): NotificationRow {
    const id = payload.idempotencyKey ?? randomUUID()
    const body = { ...payload, idempotencyKey: id }
    const now = isoUtc(this.clock.now())
    const status: NotificationStatus = this.targetBase ? 'queued' : 'stored'
    const seq = nextSeq(this.db, 'notification')
    this.db
      .prepare(`INSERT INTO notifications(id, version, type, payload, status, attempts, created_at, next_attempt_at, seq) VALUES (?,?,?,?,?,0,?,?,?)`)
      .run(id, version, body.type, JSON.stringify(body), status, now, status === 'queued' ? now : null, seq)
    if (status === 'queued') this.schedule(0)
    return this.get(id)!
  }

  get(id: string): NotificationRow | undefined {
    const r = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? rowToNotification(r) : undefined
  }

  list(filter: { type?: string; status?: NotificationStatus; sinceSeq?: number; limit?: number } = {}): NotificationRow[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.type) { where.push('type = ?'); args.push(filter.type) }
    if (filter.status) { where.push('status = ?'); args.push(filter.status) }
    if (filter.sinceSeq !== undefined) { where.push('seq > ?'); args.push(filter.sinceSeq) }
    const sql = `SELECT * FROM notifications ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ASC LIMIT ?`
    args.push(filter.limit ?? 1000)
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map(rowToNotification)
  }

  clear(): number {
    return this.db.prepare('DELETE FROM notifications').run().changes
  }

  /** Re-queue a notification for delivery (any status). */
  redeliver(id: string): NotificationRow | undefined {
    if (!this.get(id)) return undefined
    if (!this.targetBase) return this.get(id)
    this.db.prepare(`UPDATE notifications SET status='queued', next_attempt_at=?, last_error=NULL WHERE id=?`).run(isoUtc(this.clock.now()), id)
    this.schedule(0)
    return this.get(id)
  }

  /** Resolves once nothing is queued for immediate delivery and no request is in flight. */
  waitForIdle(timeoutMs = 10_000): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('webhook dispatcher did not become idle in time')), timeoutMs)
      this.idleWaiters.push(() => { clearTimeout(t); resolve() })
    })
  }

  /** App shutdown: no further delivery; resolves once the loop has stopped (at most `timeoutMs`). */
  async close(timeoutMs = 2000): Promise<void> {
    this.closed = true
    await this.stop(timeoutMs)
    const w = this.idleWaiters
    this.idleWaiters = []
    w.forEach((f) => f())
  }

  /**
   * /_admin/reset, before the tables are emptied: drops the delivery in flight and whatever the running
   * loop still meant to send. Deliveries of notifications enqueued afterwards proceed as usual.
   */
  async reset(timeoutMs = 2000): Promise<void> {
    this.epoch++
    await this.stop(timeoutMs)
  }

  private async stop(timeoutMs: number): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const a of this.inflight) a.abort()
    if (!this.pumping) return
    let t: NodeJS.Timeout | undefined
    await Promise.race([this.pumping, new Promise<void>((resolve) => { t = setTimeout(resolve, timeoutMs) })])
    clearTimeout(t)
  }

  /** True when the loop started under `epoch` must stop: the dispatcher was closed or reset since. */
  private stale(epoch: number): boolean {
    return this.closed || epoch !== this.epoch
  }

  private isIdle(): boolean {
    if (this.closed) return true
    if (this.inflight.size > 0 || this.pumping) return false
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE status='queued'`).get() as { n: number }
    return row.n === 0
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => { this.timer = null; void this.pump() }, delayMs)
    this.timer.unref()
  }

  private pump(): Promise<void> {
    if (this.pumping || this.closed) return this.pumping ?? Promise.resolve()
    const run = this.pumpLoop(this.epoch).finally(() => {
      this.pumping = null
      if (this.isIdle()) { const w = this.idleWaiters; this.idleWaiters = []; w.forEach((f) => f()) }
    })
    this.pumping = run
    return run
  }

  private async pumpLoop(epoch: number): Promise<void> {
    try {
      for (;;) {
        const now = isoUtc(this.clock.now())
        const due = (this.db.prepare(`SELECT * FROM notifications WHERE status='queued' AND next_attempt_at <= ? ORDER BY seq ASC LIMIT 50`).all(now) as Record<string, unknown>[]).map(rowToNotification)
        if (!due.length) break
        for (const n of due) {
          await this.deliver(n, epoch)
          if (this.stale(epoch)) return
        }
      }
    } finally {
      // Wake up for the next retry, or for rows enqueued after a reset while this loop was winding down.
      if (!this.closed) {
        const next = this.db.prepare(`SELECT MIN(next_attempt_at) AS at FROM notifications WHERE status='queued'`).get() as { at: string | null }
        if (next.at) this.schedule(Math.max(0, new Date(next.at).getTime() - this.clock.now().getTime()))
      }
    }
  }

  private async deliver(n: NotificationRow, epoch: number): Promise<void> {
    const url = this.urlFor(n.version)
    if (!url) return
    const abort = new AbortController()
    this.inflight.add(abort)
    let status: number | null = null
    let error: string | null = null
    try {
      const res = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(n.payload), signal: abort.signal })
      status = res.status
      if (!res.ok) error = `HTTP ${status}`
    } catch (e) {
      error = (e as Error).message
    } finally {
      this.inflight.delete(abort)
    }
    // Closed (the database may be gone) or reset (the row is gone) while the request was in flight.
    if (this.stale(epoch)) return
    if (status !== null && error === null) {
      this.db.prepare(`UPDATE notifications SET status='delivered', attempts=attempts+1, last_status=?, last_error=NULL, delivered_at=?, next_attempt_at=NULL WHERE id=?`).run(status, isoUtc(this.clock.now()), n.id)
      this.log.info({ id: n.id, type: n.type, status }, 'webhook delivered')
      return
    }
    const attempts = n.attempts + 1
    const retry = (status === null || RETRYABLE(status)) && attempts < this.config.webhookMaxAttempts
    if (retry) {
      const delay = this.config.webhookBackoffMs * 2 ** (attempts - 1)
      const nextAt = isoUtc(new Date(this.clock.now().getTime() + delay))
      this.db.prepare(`UPDATE notifications SET attempts=?, last_status=?, last_error=?, next_attempt_at=? WHERE id=?`).run(attempts, status, error, nextAt, n.id)
      this.log.warn({ id: n.id, type: n.type, status, error, attempts, retryInMs: delay }, 'webhook delivery failed, will retry')
    } else {
      this.db.prepare(`UPDATE notifications SET status='failed', attempts=?, last_status=?, last_error=?, next_attempt_at=NULL WHERE id=?`).run(attempts, status, error, n.id)
      this.log.error({ id: n.id, type: n.type, status, error, attempts }, 'webhook delivery failed permanently')
    }
  }
}

function rowToNotification(r: Record<string, unknown>): NotificationRow {
  return {
    id: r.id as string,
    version: r.version as WebhookVersion,
    type: r.type as string,
    payload: JSON.parse(r.payload as string),
    status: r.status as NotificationStatus,
    attempts: r.attempts as number,
    lastStatus: (r.last_status as number | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    createdAt: r.created_at as string,
    nextAttemptAt: (r.next_attempt_at as string | null) ?? null,
    deliveredAt: (r.delivered_at as string | null) ?? null,
    seq: r.seq as number,
  }
}
