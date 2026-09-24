/**
 * Deferred and time-driven work. `later()` runs a callback after a real delay (default
 * config.asyncDelayMs) but is also due on the virtual clock, so advancing the clock via the admin API
 * fires it early through `tick()`. `onTick()` registers lazy time-driven jobs (card expiry, scheduled
 * payments) that run on every tick.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { Clock } from './clock.js'

/** dueAt is on the virtual clock (tick() fires it early); firesAt is when its real timer fires (epoch ms, wall clock). */
interface Entry { dueAt: number; firesAt: number; timer: NodeJS.Timeout; run: () => void | Promise<void> }
interface Waiter { busy: () => boolean; done: () => void }

/** waitForIdle leaves this much of its timeout between the last timer it waits for and giving up. */
const IDLE_MARGIN_MS = 1_000

export class Scheduler {
  private readonly entries = new Set<Entry>()
  private readonly ticks: (() => void | Promise<void>)[] = []
  private waiters: Waiter[] = []
  private running = 0

  constructor(private readonly clock: Clock, private readonly defaultDelayMs: number, private readonly log: FastifyBaseLogger) {}

  later(run: () => void | Promise<void>, delayMs: number = this.defaultDelayMs): void {
    const entry: Entry = { dueAt: this.clock.now().getTime() + delayMs, firesAt: Date.now() + Math.max(0, delayMs), run, timer: null as unknown as NodeJS.Timeout }
    entry.timer = setTimeout(() => void this.fire(entry), Math.max(0, delayMs))
    entry.timer.unref()
    this.entries.add(entry)
  }

  onTick(job: () => void | Promise<void>): void {
    this.ticks.push(job)
  }

  /** Run due deferred work (per the virtual clock) and every registered tick job. */
  async tick(): Promise<void> {
    const now = this.clock.now().getTime()
    for (const e of [...this.entries]) if (e.dueAt <= now) await this.fire(e)
    for (const job of this.ticks) {
      try { await job() } catch (err) { this.log.error({ err }, 'tick job failed') }
    }
  }

  pending(): number {
    return this.entries.size + this.running
  }

  cancelAll(): void {
    for (const e of this.entries) clearTimeout(e.timer)
    this.entries.clear()
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
      const idle = this.waiters.filter((w) => !w.busy())
      if (idle.length) {
        this.waiters = this.waiters.filter((w) => !idle.includes(w))
        idle.forEach((w) => w.done())
      }
    }
  }
}
