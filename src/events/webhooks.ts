/**
 * Outbound webhook delivery. Persists every notification, POSTs it to the configured client base URL
 * at the spec paths, and retries with exponential backoff on 401/403/429/5xx or network failure —
 * the same trigger set Shaype documents (18 attempts over 48h there; a handful over seconds here).
 *
 * Timing runs on the real (wall) clock, never the virtual one: a retry is due webhookBackoffMs (doubling)
 * of real time after the failed attempt, whether the virtual clock is frozen or was moved, and each request
 * times out after webhookTimeoutMs (a retryable network error). next_attempt_at is informational (virtual
 * time + backoff). Rows left queued by an earlier process on a file database resume at startup (kept as
 * stored when no webhook URL is configured). A redeliver() asked for while that row's delivery is in flight
 * is sent once the delivery completes.
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
/** setTimeout's ceiling (2^31 - 1 ms); a longer delay would fire after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647

export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null
  /** When the armed timer fires (Date.now based). */
  private timerAt = 0
  /** The running delivery loop, if any. */
  private pumping: Promise<void> | null = null
  private idleWaiters: (() => void)[] = []
  /** Abort handles of the requests in flight. */
  private readonly inflight = new Set<AbortController>()
  private closed = false
  /** Bumped by reset(): a loop started under an older epoch stops at its next step. */
  private epoch = 0
  /** Wall-clock time (Date.now) before which a queued row is not retried; a row without an entry is due now. */
  private readonly retryAt = new Map<string, number>()
  /** Ids whose delivery is in flight, and those a redeliver() asked for meanwhile. */
  private readonly inflightIds = new Set<string>()
  private readonly redeliverAfter = new Set<string>()

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly log: FastifyBaseLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    // A file database may hold rows an earlier process left queued (a retry pending at shutdown): resume them,
    // or keep them as stored when there is nowhere to send them (flush must not wait on them forever).
    if (!this.targetBase) this.db.prepare(`UPDATE notifications SET status='stored', next_attempt_at=NULL WHERE status='queued'`).run()
    else if (this.queuedIds().length) this.schedule(0)
  }

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

  /** Oldest first unless `order` is 'desc'; at most `limit` rows (default 1000). */
  list(filter: { type?: string; status?: NotificationStatus; sinceSeq?: number; limit?: number; order?: 'asc' | 'desc' } = {}): NotificationRow[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.type) { where.push('type = ?'); args.push(filter.type) }
    if (filter.status) { where.push('status = ?'); args.push(filter.status) }
    if (filter.sinceSeq !== undefined) { where.push('seq > ?'); args.push(filter.sinceSeq) }
    const sql = `SELECT * FROM notifications ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ${filter.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`
    args.push(filter.limit ?? 1000)
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map(rowToNotification)
  }

  clear(): number {
    this.retryAt.clear()
    this.redeliverAfter.clear()
    return this.db.prepare('DELETE FROM notifications').run().changes
  }

  /** Re-queue a notification for delivery (any status). */
  redeliver(id: string): NotificationRow | undefined {
    if (!this.get(id)) return undefined
    if (!this.targetBase) return this.get(id)
    this.retryAt.delete(id)
    // in flight: that attempt's outcome would overwrite the re-queue, so it is re-queued again once recorded
    if (this.inflightIds.has(id)) this.redeliverAfter.add(id)
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
    this.retryAt.clear()
    this.redeliverAfter.clear()
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

  private queuedIds(): string[] {
    return (this.db.prepare(`SELECT id FROM notifications WHERE status='queued' ORDER BY seq ASC`).all() as { id: string }[]).map((r) => r.id)
  }

  /** Arms the wake-up timer, or brings an armed one forward (a new notification never waits for a pending retry). */
  private schedule(delayMs: number): void {
    if (this.closed) return
    // clamped: a longer wait simply wakes up early, finds nothing due and schedules again
    const delay = Math.min(Math.max(0, delayMs), MAX_TIMER_MS)
    if (this.timer) {
      if (Date.now() + delay >= this.timerAt) return
      clearTimeout(this.timer)
    }
    this.timerAt = Date.now() + delay
    this.timer = setTimeout(() => { this.timer = null; void this.pump() }, delay)
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
        const now = Date.now()
        const due = this.queuedIds().filter((id) => (this.retryAt.get(id) ?? 0) <= now).slice(0, 50)
        if (!due.length) break
        for (const id of due) {
          const n = this.get(id)
          if (n?.status === 'queued') await this.deliver(n, epoch)
          if (this.stale(epoch)) return
        }
      }
    } finally {
      // Wake up for the next retry, or for rows enqueued after a reset while this loop was winding down.
      if (!this.closed) {
        const ids = this.queuedIds()
        if (ids.length) this.schedule(Math.min(...ids.map((id) => this.retryAt.get(id) ?? 0)) - Date.now())
      }
    }
  }

  private async deliver(n: NotificationRow, epoch: number): Promise<void> {
    const url = this.urlFor(n.version)
    if (!url) return
    const abort = new AbortController()
    const timeout = AbortSignal.timeout(this.config.webhookTimeoutMs)
    this.inflight.add(abort)
    this.inflightIds.add(n.id)
    let status: number | null = null
    let error: string | null = null
    try {
      const res = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(n.payload), signal: AbortSignal.any([abort.signal, timeout]) })
      status = res.status
      if (!res.ok) error = `HTTP ${status}`
    } catch (e) {
      error = timeout.aborted && !abort.signal.aborted ? `timeout after ${this.config.webhookTimeoutMs} ms` : (e as Error).message
    } finally {
      this.inflight.delete(abort)
      this.inflightIds.delete(n.id)
    }
    // Closed (the database may be gone) or reset (the row is gone) while the request was in flight.
    if (this.stale(epoch)) return
    this.record(n, status, error)
    if (this.redeliverAfter.delete(n.id)) {
      this.retryAt.delete(n.id)
      this.db.prepare(`UPDATE notifications SET status='queued', next_attempt_at=?, last_error=NULL WHERE id=?`).run(isoUtc(this.clock.now()), n.id)
    }
  }

  /** Stores the outcome of one attempt: delivered, queued for a retry (real-time backoff) or failed. */
  private record(n: NotificationRow, status: number | null, error: string | null): void {
    if (status !== null && error === null) {
      this.retryAt.delete(n.id)
      this.db.prepare(`UPDATE notifications SET status='delivered', attempts=attempts+1, last_status=?, last_error=NULL, delivered_at=?, next_attempt_at=NULL WHERE id=?`).run(status, isoUtc(this.clock.now()), n.id)
      this.log.info({ id: n.id, type: n.type, status }, 'webhook delivered')
      return
    }
    const attempts = n.attempts + 1
    const retry = (status === null || RETRYABLE(status)) && attempts < this.config.webhookMaxAttempts
    if (retry) {
      const delay = this.config.webhookBackoffMs * 2 ** (attempts - 1)
      this.retryAt.set(n.id, Date.now() + delay)
      const nextAt = isoUtc(new Date(this.clock.now().getTime() + delay))
      this.db.prepare(`UPDATE notifications SET attempts=?, last_status=?, last_error=?, next_attempt_at=? WHERE id=?`).run(attempts, status, error, nextAt, n.id)
      this.log.warn({ id: n.id, type: n.type, status, error, attempts, retryInMs: delay }, 'webhook delivery failed, will retry')
    } else {
      this.retryAt.delete(n.id)
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
