/**
 * Virtual clock. Real time by default; tests can pin or advance it through the admin API
 * (card expiry, scheduled payments, token expiry all read from here).
 */
export class Clock {
  private offsetMs = 0
  private frozenAt: number | null = null

  now(): Date {
    return new Date(this.frozenAt ?? Date.now() + this.offsetMs)
  }
  /** Pin the clock to a fixed instant (subsequent now() calls return the same value until advanced). */
  freeze(at: Date | string): void {
    this.frozenAt = new Date(at).getTime()
  }
  /** Move the clock so that now() == at, but keep it ticking. */
  set(at: Date | string): void {
    this.frozenAt = null
    this.offsetMs = new Date(at).getTime() - Date.now()
  }
  advance(ms: number): void {
    if (this.frozenAt !== null) this.frozenAt += ms
    else this.offsetMs += ms
  }
  reset(): void {
    this.offsetMs = 0
    this.frozenAt = null
  }
  get isFrozen(): boolean {
    return this.frozenAt !== null
  }
}

/** ISO-8601 UTC with microsecond precision, as Shaype renders it: 2024-03-12T22:59:48.357089Z */
export function isoUtc(d: Date): string {
  return d.toISOString().replace('Z', '000Z')
}

/** YYYY-MM-DD (UTC) */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
