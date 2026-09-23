/**
 * Deferred and time-driven work. `later()` runs a callback after a real delay (default
 * config.asyncDelayMs) but is also due on the virtual clock, so advancing the clock via the admin API
 * fires it early through `tick()`. `onTick()` registers lazy time-driven jobs (card expiry, scheduled
 * payments) that run on every tick.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { Clock } from './clock.js'

interface Entry { dueAt: number; timer: NodeJS.Timeout; run: () => void | Promise<void> }

export class Scheduler {
  private readonly entries = new Set<Entry>()
  private readonly ticks: (() => void | Promise<void>)[] = []
  private waiters: (() => void)[] = []
  private running = 0

  constructor(private readonly clock: Clock, private readonly defaultDelayMs: number, private readonly log: FastifyBaseLogger) {}

  later(run: () => void | Promise<void>, delayMs: number = this.defaultDelayMs): void {
    const entry: Entry = { dueAt: this.clock.now().getTime() + delayMs, run, timer: null as unknown as NodeJS.Timeout }
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

  /** Resolves when no deferred work is pending or running. */
  waitForIdle(timeoutMs = 10_000): Promise<void> {
    if (this.pending() === 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('scheduler did not become idle in time')), timeoutMs)
      this.waiters.push(() => { clearTimeout(t); resolve() })
    })
  }

  private async fire(e: Entry): Promise<void> {
    if (!this.entries.has(e)) return
    this.entries.delete(e)
    clearTimeout(e.timer)
    this.running++
    try { await e.run() } catch (err) { this.log.error({ err }, 'deferred job failed') } finally {
      this.running--
      if (this.pending() === 0) { const w = this.waiters; this.waiters = []; w.forEach((f) => f()) }
    }
  }
}
