/**
 * Month scopes for the boards (tasks and invoices).
 *
 * A scope is one of:
 *  - 'current' — the month we are in today. It is resolved when the page
 *    renders, so it moves on by itself when a new month starts and the
 *    month's totals begin again from zero.
 *  - 'all' — no month limit.
 *  - 'YYYY-MM' — one month, picked by hand. Earlier months stay reachable.
 *
 * Pure functions only, so the rules can be checked without the UI.
 */
import { addMonths, monthIndex } from './finance'

/** A month scope as stored in a board's filters. */
export type MonthScope = 'current' | 'all' | `${number}-${number}`

/** Whether a string is a 'YYYY-MM' month key. */
export function isMonthKey(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

/** The 'YYYY-MM' of an ISO date ('YYYY-MM-DD…'), or '' when there is none. */
export function monthKeyOfISO(iso: string | null | undefined): string {
  if (!iso || iso.length < 7) return ''
  const key = iso.slice(0, 7)
  return isMonthKey(key) ? key : ''
}

/** The scope as a concrete answer: a 'YYYY-MM' month, or 'all'. */
export function resolveMonthScope(scope: MonthScope, today: string): 'all' | string {
  if (scope === 'all') return 'all'
  if (scope === 'current') return monthKeyOfISO(today) || 'all'
  return scope
}

/** The first day of a 'YYYY-MM' month, as 'YYYY-MM-DD'. */
export function monthFirstDay(ym: string): string {
  return `${ym}-01`
}

/** The last day of a 'YYYY-MM' month, as 'YYYY-MM-DD'. */
export function monthLastDay(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const days = new Date(y, m, 0).getDate()
  return `${ym}-${String(days).padStart(2, '0')}`
}

/** Every month from `from` to `to` inclusive, newest first. Capped at `max` months back from `to`. */
export function monthsDescending(from: string, to: string, max = 120): string[] {
  const out: string[] = []
  const lowest = Math.max(monthIndex(from), monthIndex(to) - max + 1)
  let cursor = to
  while (monthIndex(cursor) >= lowest) {
    out.push(cursor)
    cursor = addMonths(cursor, -1)
  }
  return out
}

/**
 * The months a picker offers for a board: from the earliest month that has
 * records (or this month, if earlier) through the latest month that has
 * records (or this month, if later). Always includes this month.
 */
export function monthOptions(months: Iterable<string>, today: string): string[] {
  const current = monthKeyOfISO(today)
  if (!current) return []
  let earliest = current
  let latest = current
  for (const ym of months) {
    if (!isMonthKey(ym)) continue
    if (ym < earliest) earliest = ym
    if (ym > latest) latest = ym
  }
  return monthsDescending(earliest, latest)
}
