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
 */
import type { FastifyBaseLogger } from 'fastify'
import type { Clock } from './clock.js'

/** dueAt is on the virtual clock (tick() fires it early); firesAt is when its real timer fires (epoch ms, wall clock). */
interface Entry { dueAt: number; firesAt: number; seq: number; timer: NodeJS.Timeout; run: () => void | Promise<void> }
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

  constructor(private readonly clock: Clock, private readonly defaultDelayMs: number, private readonly log: FastifyBaseLogger) {}

  later(run: () => void | Promise<void>, delayMs: number = this.defaultDelayMs): void {
    const entry: Entry = { dueAt: this.clock.now().getTime() + delayMs, firesAt: Date.now() + Math.max(0, delayMs), seq: this.seq++, run, timer: null as unknown as NodeJS.Timeout }
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

  /** Drops every pending step (reset / close); a flush waiting for them is released at once. */
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
