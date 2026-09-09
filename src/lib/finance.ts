/**
 * Shared finance helpers: the arithmetic the Finance page and the Reports
 * finance section both need (billing-cycle dates, overdue math, monthly
 * equivalents and the summaries drawn from the finance ledger).
 *
 * Due dates are plain calendar dates ('YYYY-MM-DD', no time component, like
 * task due dates) and are always interpreted in the viewer's local timezone.
 */
import type { BillingCycle, FinanceItem, TimeEntry } from './types'

const DAY_MS = 24 * 60 * 60 * 1000

/** Today as a local 'YYYY-MM-DD' string. */
export function todayISO(): string {
  return toISODate(new Date())
}

/** A Date as a local 'YYYY-MM-DD' string. */
export function toISODate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** Parse 'YYYY-MM-DD' as a local midnight (not UTC) so day math is stable. */
export function parseISODate(iso: string): Date {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

/** The 'YYYY-MM' bucket a date falls in (local). */
export function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** The current month, 'YYYY-MM'. */
export function currentMonthKey(): string {
  return monthKeyOf(new Date())
}

/** 'YYYY-MM' → 'March 2026' style label for headings. */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m) return ym
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

/** 'YYYY-MM' → short month name for chart axes. */
export function monthShortLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m) return ym
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' })
}

/** 'YYYY-MM' for the month after `ym`. */
function nextMonthKey(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  // m is 1-based in 'YYYY-MM' but 0-based in Date, so Date(y, m, 1) is next month.
  return monthKeyOf(new Date(y, m, 1))
}

/** Every 'YYYY-MM' from the month of `from` to the month of `to`, inclusive (max 24). */
export function monthKeysBetween(from: Date, to: Date): string[] {
  const out: string[] = []
  let cur = monthKeyOf(from <= to ? from : to)
  const last = monthKeyOf(from <= to ? to : from)
  while (cur <= last && out.length < 24) {
    out.push(cur)
    cur = nextMonthKey(cur)
  }
  return out
}

/**
 * Roll a calendar date forward by one billing cycle. Monthly dates clamp to
 * the end of the target month (so a '31st' subscription doesn't skip months);
 * yearly keeps the same day where it exists.
 */
export function advanceCycle(isoDate: string, cycle: BillingCycle): string {
  const d = parseISODate(isoDate)
  if (cycle === 'yearly') {
    const target = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate())
    // Feb-29 in a non-leap year rolls over to Mar; clamp to Feb 28 instead.
    if (target.getMonth() !== d.getMonth()) target.setDate(0)
    return toISODate(target)
  }
  const target = new Date(d.getFullYear(), d.getMonth() + 1, 1)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(d.getDate(), lastDay))
  return toISODate(target)
}

/** Whole days from today until `isoDate` (negative = overdue). */
export function daysUntil(isoDate: string): number {
  const today = parseISODate(todayISO()).getTime()
  const target = parseISODate(isoDate).getTime()
  return Math.round((target - today) / DAY_MS)
}

/** Human label for how soon a date is due. */
export function dueLabel(days: number): string {
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  if (days === -1) return '1 day overdue'
  if (days < 0) return `${-days} days overdue`
  if (days <= 14) return `Due in ${days} days`
  if (days <= 60) return `Due in ${Math.round(days / 7)} weeks`
  return `Due in ${Math.round(days / 30)} months`
}

/** Is this line overdue — a pending (unpaid) subscription/payment past its date? */
export function isFinanceOverdue(item: FinanceItem): boolean {
  if (item.status === 'paid' || item.status === 'paused') return false
  return daysUntil(item.due_date) < 0
}

/** What the line is pending on the ledger (paid/paused lines contribute 0). */
export function pendingAmount(item: FinanceItem): number {
  return item.status === 'paid' || item.status === 'paused' ? 0 : item.amount
}

/** What an ACTIVE subscription costs per month (yearly divided by 12). */
export function monthlyEquivalent(item: FinanceItem): number {
  if (item.kind !== 'subscription' || item.status !== 'active') return 0
  return Math.round(((item.cycle === 'yearly' ? item.amount / 12 : item.amount) + Number.EPSILON) * 100) / 100
}

/** Sum of monthlyEquivalent over the active subscriptions. */
export function subscriptionsPerMonth(items: FinanceItem[]): number {
  return Math.round(items.reduce((sum, i) => sum + monthlyEquivalent(i), 0) * 100) / 100
}

/**
 * A unified due-date row: one line per open finance item, oldest date first.
 * `label` is resolved by the caller (payroll rows are named after their
 * worker), so this module stays free of UI/store concerns.
 */
export interface DueRow {
  item: FinanceItem
  days: number
}

/**
 * The due-date agenda: every unpaid bill / payroll run and every active
 * subscription's next bill date, overdue first, then soonest. Paused and paid
 * lines are left out (paid ones only make sense in the tabs' own history).
 */
export function buildDueRows(items: FinanceItem[]): DueRow[] {
  return items
    .filter((i) => (i.kind === 'subscription' ? i.status === 'active' : i.status !== 'paid'))
    .map((item) => ({ item, days: daysUntil(item.due_date) }))
    .sort((a, b) => a.item.due_date.localeCompare(b.item.due_date))
}

/**
 * Payroll figures for a report range: what the team earned per month (from the
 * tracked time), so a "suggested payroll amount" can be offered when adding a
 * run, and so reports can compare time cost vs. what was actually paid out.
 */
export function earningsByWorkerAndMonth(entries: TimeEntry[]): Map<string, number> {
  // key: `${monthKey}|${workerId}` → earnings total
  const map = new Map<string, number>()
  for (const e of entries) {
    const key = `${monthKeyOf(new Date(e.start_time))}|${e.worker_id}`
    map.set(key, (map.get(key) || 0) + (e.earnings || 0))
  }
  return map
}

/** The earnings suggestion for one worker's payroll run for `ym`. */
export function suggestedPayroll(
  earnings: Map<string, number>,
  workerId: string,
  ym: string
): number | null {
  const v = earnings.get(`${ym}|${workerId}`)
  if (!v) return null
  return Math.round(v * 100) / 100
}

/** Totals the Finance page header and the Reports finance card share. */
export interface FinanceSummary {
  /** Active subscriptions, normalised to one month. */
  subsMonthly: number
  /** Unpaid payroll + bills, i.e. money still to go out. */
  owedPayroll: number
  owedBills: number
  /** Overdue lines (any kind). */
  overdueCount: number
  overdueAmount: number
  /** Lines due within the next 30 days (incl. today). */
  next30Count: number
  next30Amount: number
}

export function summarizeFinance(items: FinanceItem[]): FinanceSummary {
  const subsMonthly = subscriptionsPerMonth(items)
  let owedPayroll = 0
  let owedBills = 0
  let overdueCount = 0
  let overdueAmount = 0
  let next30Count = 0
  let next30Amount = 0
  for (const i of items) {
    if (i.kind === 'payroll') owedPayroll += pendingAmount(i)
    if (i.kind === 'bill') owedBills += pendingAmount(i)
    const days = daysUntil(i.due_date)
    const open = i.kind === 'subscription' ? i.status === 'active' : i.status !== 'paid'
    if (!open) continue
    if (days < 0) {
      overdueCount += 1
      overdueAmount += i.amount
    } else if (days <= 30) {
      next30Count += 1
      next30Amount += i.amount
    }
  }
  return {
    subsMonthly,
    owedPayroll: Math.round(owedPayroll * 100) / 100,
    owedBills: Math.round(owedBills * 100) / 100,
    overdueCount,
    overdueAmount: Math.round(overdueAmount * 100) / 100,
    next30Count,
    next30Amount: Math.round(next30Amount * 100) / 100,
  }
}

/**
 * The reports figures for the selected range: what the ledger says the
 * business pays out, bucketed per month so the chart can show the mix.
 * - subscriptions are counted in the month their billing date falls in
 * - payroll in the month it covers (period_month)
 * - bills in the month they are due
 */
export interface FinancePeriodRow {
  month: string // 'YYYY-MM'
  subscriptions: number
  payroll: number
  bills: number
  total: number
  paid: number
  unpaid: number
}

export function financeByMonth(items: FinanceItem[], months: string[]): FinancePeriodRow[] {
  const idx = new Map(months.map((m, i) => [m, i] as const))
  const rows: FinancePeriodRow[] = months.map((month) => ({
    month,
    subscriptions: 0,
    payroll: 0,
    bills: 0,
    total: 0,
    paid: 0,
    unpaid: 0,
  }))
  const bump = (m: string, key: 'subscriptions' | 'payroll' | 'bills', amount: number, paid: boolean) => {
    const i = idx.get(m)
    if (i === undefined) return
    rows[i][key] += amount
    rows[i].total += amount
    if (paid) rows[i].paid += amount
    else rows[i].unpaid += amount
  }
  for (const item of items) {
    const paid = item.status === 'paid'
    if (item.kind === 'subscription') {
      // A paused subscription stopped billing; active ones show up once per
      // month they cover — approximated by their billing month here.
      if (item.status !== 'active') continue
      bump(monthKeyOf(parseISODate(item.due_date)), 'subscriptions', item.cycle === 'yearly' ? item.amount / 12 : item.amount, false)
    } else if (item.kind === 'payroll') {
      bump(item.period_month || monthKeyOf(parseISODate(item.due_date)), 'payroll', item.amount, paid)
    } else {
      bump(monthKeyOf(parseISODate(item.due_date)), 'bills', item.amount, paid)
    }
  }
  return rows.map((r) => ({
    ...r,
    subscriptions: Math.round(r.subscriptions * 100) / 100,
    payroll: Math.round(r.payroll * 100) / 100,
    bills: Math.round(r.bills * 100) / 100,
    total: Math.round(r.total * 100) / 100,
    paid: Math.round(r.paid * 100) / 100,
    unpaid: Math.round(r.unpaid * 100) / 100,
  }))
}

/**
 * Months to chart for a report range: the range's own months when it spans
 * more than two, otherwise the six months ending with the range.
 */
export function financeChartMonths(range: { from: Date; to: Date }): string[] {
  const inRange = monthKeysBetween(range.from, range.to)
  if (inRange.length >= 2) return inRange
  const end = new Date(range.to.getFullYear(), range.to.getMonth(), 1)
  const out: string[] = []
  for (let i = 5; i >= 0; i--) out.push(monthKeyOf(new Date(end.getFullYear(), end.getMonth() - i, 1)))
  return out
}
