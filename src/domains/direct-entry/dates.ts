/**
 * Calendar-date helpers (YYYY-MM-DD, UTC — docs/map/crosscutting.md: everything is UTC unless the
 * field says otherwise; the one exception is a Direct Entry processingDate, a Sydney day per
 * 00-open-questions T4, see sydneyDate). Business days are Monday to Friday with no holiday table.
 */
import type { ScheduleFrequency } from './repo.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return [y, m, d]
}

function render(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date)
  return render(new Date(Date.UTC(y, m - 1, d + days)))
}

/**
 * `months` months after `date`, keeping the day of month; a day that does not exist in the target
 * month rolls forward to the next available date (spec: "payment triggered on next available date
 * where invalid date is encountered in schedule i.e. 30th February" -> 1 March, the first day that
 * exists after it).
 */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = parts(date)
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  if (d > daysInTarget) return render(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 1)))
  return render(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), d)))
}

const SYDNEY = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' })

/** The Australia/Sydney calendar date (YYYY-MM-DD) of an instant. */
export function sydneyDate(at: Date): string {
  const p = Object.fromEntries(SYDNEY.formatToParts(at).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}

/** The first Monday–Friday strictly after `date`. */
export function nextBusinessDay(date: string): string {
  let next = addDays(date, 1)
  while (isWeekend(next)) next = addDays(next, 1)
  return next
}

export function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay()
  return day === 0 || day === 6
}

/** The k-th occurrence (0-based) of a schedule anchored on `startDate`. */
export function occurrence(startDate: string, frequency: ScheduleFrequency, k: number): string {
  switch (frequency) {
    case 'WEEKLY': return addDays(startDate, 7 * k)
    case 'FORTNIGHTLY': return addDays(startDate, 14 * k)
    case 'MONTHLY': return addMonths(startDate, k)
    case 'QUARTERLY': return addMonths(startDate, 3 * k)
  }
}

/** The first occurrence strictly after `after` (occurrences are anchored on startDate, never on the rolled date). */
export function nextOccurrence(startDate: string, frequency: ScheduleFrequency, after: string): string {
  for (let k = 0; ; k++) {
    const date = occurrence(startDate, frequency, k)
    if (date > after) return date
  }
}
