/**
 * Deferred and time-driven work. `later()` runs a callback after a real delay (default
 * config.asyncDelayMs) but is also due on the virtual clock, so advancing the clock via the admin API
 * fires it early through `tick()`. `onTick()` registers lazy time-driven jobs (card expiry, scheduled
 * payments) that run on every tick.
 *
 * tick() runs the due deferred steps in due order (earliest dueAt first, creation order on a tie), including
 * steps that a step schedules and that are already due, and then every tick job: one clock jump therefore
 * replays the deferred steps as they would have happened, and the time-driven jobs see their outcome.
 * Real timers are clamped to setTimeout's 2^31-1 ms ceiling and re-armed until the real delay has passed.
 *
 * Domain steps go through `define(kind, handler)` + `defer(kind, args, delayMs)`: the step is stored in
 * scheduled_jobs as well, deleted when it runs, and `restore()` re-arms what an earlier process left pending,
 * so a file database keeps its in-flight asynchronous work (onboarding outcome, card settlement, direct-entry
 * hops, closure cascade, ...) across a restart. `later(fn)` is the in-memory form.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../db/index.js'
import type { Clock } from './clock.js'

/** dueAt is on the virtual clock (tick() fires it early); firesAt is when its real timer fires (epoch ms, wall clock). */
interface Entry { dueAt: number; firesAt: number; seq: number; timer: NodeJS.Timeout; run: () => void | Promise<void>; /** scheduled_jobs row */ jobId?: string }
export type JobHandler<A = any> = (args: A) => void | Promise<void>
interface Waiter { busy: () => boolean; done: () => void }

/** waitForIdle leaves this much of its timeout between the last timer it waits for and giving up. */
const IDLE_MARGIN_MS = 1_000
/** setTimeout's ceiling (2^31 - 1 ms); a longer delay would fire after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647
/** Bound on the steps one tick runs (a step that keeps scheduling due steps must not spin forever). */
const MAX_STEPS_PER_TICK = 10_000

export class Scheduler {
  private readonly entries = new Set<Entry>()
  private seq = 0
  private readonly ticks: (() => void | Promise<void>)[] = []
  private waiters: Waiter[] = []
  private running = 0
  private readonly handlers = new Map<string, JobHandler>()

  constructor(private readonly clock: Clock, private readonly defaultDelayMs: number, private readonly log: FastifyBaseLogger, private readonly db?: Db) {}

  later(run: () => void | Promise<void>, delayMs: number = this.defaultDelayMs): void {
    this.add({ dueAt: this.clock.now().getTime() + delayMs, firesAt: Date.now() + Math.max(0, delayMs), run })
  }

  /** Registers the handler of a persisted step kind (a domain, while it registers). */
  define<A>(kind: string, handler: JobHandler<A>): void {
    if (this.handlers.has(kind)) throw new Error(`Scheduler job ${kind} is already defined`)
    this.handlers.set(kind, handler as JobHandler)
  }

  /** Like later(), for a step defined with define(): stored in scheduled_jobs until it runs. `args` must be JSON. */
  defer(kind: string, args: Record<string, unknown>, delayMs: number = this.defaultDelayMs): void {
    const handler = this.handlers.get(kind)
    if (!handler) throw new Error(`Scheduler job ${kind} is not defined`)
    const dueAt = this.clock.now().getTime() + delayMs
    const firesAt = Date.now() + Math.max(0, delayMs)
    const jobId = randomUUID()
    const seq = this.seq
    this.db?.prepare('INSERT INTO scheduled_jobs(id, kind, args, due_at, fires_at, seq) VALUES (?,?,?,?,?,?)').run(jobId, kind, JSON.stringify(args), dueAt, firesAt, seq)
    this.add({ dueAt, firesAt, run: () => handler(args), jobId })
  }

  /** Re-arms the steps an earlier process stored (startup, once every domain has defined its handlers). */
  restore(): void {
    if (!this.db) return
    const rows = this.db.prepare('SELECT * FROM scheduled_jobs ORDER BY seq ASC, rowid ASC').all() as { id: string; kind: string; args: string; due_at: number; fires_at: number }[]
    for (const r of rows) {
      const handler = this.handlers.get(r.kind)
      if (!handler) {
        this.log.warn({ kind: r.kind }, 'dropping a stored scheduled job of an unknown kind')
        this.db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(r.id)
        continue
      }
      const args = JSON.parse(r.args) as unknown
      this.add({ dueAt: r.due_at, firesAt: r.fires_at, run: () => handler(args), jobId: r.id })
    }
  }

  private add(e: Omit<Entry, 'seq' | 'timer'>): void {
    const entry: Entry = { ...e, seq: this.seq++, timer: null as unknown as NodeJS.Timeout }
    this.arm(entry)
    this.entries.add(entry)
  }

  /** The entry's real timer, clamped to the setTimeout range; it re-arms itself until firesAt has passed. */
  private arm(entry: Entry): void {
    const wait = Math.max(0, entry.firesAt - Date.now())
    entry.timer = setTimeout(() => {
      if (Date.now() < entry.firesAt) this.arm(entry)
      else void this.fire(entry)
    }, Math.min(wait, MAX_TIMER_MS))
    entry.timer.unref()
  }

  onTick(job: () => void | Promise<void>): void {
    this.ticks.push(job)
  }

  /** Run due deferred work (per the virtual clock) in due order, then every registered tick job. */
  async tick(): Promise<void> {
    for (let steps = 0; steps < MAX_STEPS_PER_TICK; steps++) {
      const now = this.clock.now().getTime()
      let next: Entry | undefined
      for (const e of this.entries) {
        if (e.dueAt > now) continue
        if (!next || e.dueAt < next.dueAt || (e.dueAt === next.dueAt && e.seq < next.seq)) next = e
      }
      if (!next) break
      await this.fire(next)
    }
    for (const job of this.ticks) {
      try { await job() } catch (err) { this.log.error({ err }, 'tick job failed') }
    }
  }

  pending(): number {
    return this.entries.size + this.running
  }

  /** Drops every pending step from memory (reset / close; their stored rows are the caller's); a flush waiting for them is released at once. */
  cancelAll(): void {
    for (const e of this.entries) clearTimeout(e.timer)
    this.entries.clear()
    this.releaseIdleWaiters()
  }

  /**
   * Resolves when no deferred work is running or due to fire within the wait (the timeout less a 1 s margin),
   * including work that work scheduled meanwhile. Later steps (a mock settlement minutes away) stay pending:
   * waiting for their real timers could only time out; advancing the virtual clock runs them.
   */
  waitForIdle(timeoutMs = 10_000): Promise<void> {
    const horizon = Date.now() + Math.max(0, timeoutMs - IDLE_MARGIN_MS)
    const busy = (): boolean => this.running > 0 || [...this.entries].some((e) => e.firesAt <= horizon)
    if (!busy()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        reject(new Error('scheduler did not become idle in time'))
      }, timeoutMs)
      const waiter: Waiter = { busy, done: () => { clearTimeout(t); resolve() } }
      this.waiters.push(waiter)
    })
  }

  private async fire(e: Entry): Promise<void> {
    if (!this.entries.has(e)) return
    this.entries.delete(e)
    clearTimeout(e.timer)
    if (e.jobId) this.db?.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(e.jobId)
    this.running++
    try { await e.run() } catch (err) { this.log.error({ err }, 'deferred job failed') } finally {
      this.running--
      this.releaseIdleWaiters()
    }
  }

  private releaseIdleWaiters(): void {
    const idle = this.waiters.filter((w) => !w.busy())
    if (!idle.length) return
    this.waiters = this.waiters.filter((w) => !idle.includes(w))
    idle.forEach((w) => w.done())
  }
}
