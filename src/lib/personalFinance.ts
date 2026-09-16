import { createClient } from '@supabase/supabase-js'
import { storage } from './storage'

export type PFAccount = { id: string; name: string; purpose: string; startingBalance: number; archived: boolean }
export type PFCategory = { id: string; name: string }
export type PFSource = { id: string; name: string }
export type PFIncome = { id: string; date: string; sourceId: string; amount: number; accountId: string; note: string }
export type PFExpense = { id: string; date: string; name: string; categoryId: string; amount: number; accountId: string; paid: boolean; note: string; recurringId?: string; period?: string; dueDate?: string; installmentNumber?: number }
export type PFInstallment = { id: string; dueDate: string; number: number; paid: boolean }
export type PFTransfer = { id: string; date: string; fromId: string; toId: string; amount: number; note: string }
export type PFRecurring = {
  id: string
  name: string
  categoryId: string
  accountId: string
  expectedAmount: number | null
  dueDay: number | null
  active: boolean
  /** Null means the payment continues until it is switched off manually. */
  maxOccurrences: number | null
  /** Number of payments recorded from this recurring item. */
  runCount: number
  startDate?: string
  installments?: PFInstallment[]
}
export type PFData = { accounts: PFAccount[]; categories: PFCategory[]; sources: PFSource[]; incomes: PFIncome[]; expenses: PFExpense[]; transfers: PFTransfer[]; recurring: PFRecurring[] }

export const emptyPFData = (): PFData => ({ accounts: [], categories: [], sources: [], incomes: [], expenses: [], transfers: [], recurring: [] })

function occurrenceLimit(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : null
}

function occurrenceCount(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Add whole months to an ISO date, clamping the day to the length of the
 * target month (31 Jan + 1 month → 28/29 Feb, never 3 Mar). Plain
 * `Date#setMonth` overflows, which would silently drift every later due date
 * of a plan that starts on the 29th, 30th or 31st.
 */
export function addMonthsClamped(isoDate: string, months: number): string {
  if (!ISO_DATE.test(isoDate) || !Number.isInteger(months)) return isoDate
  const year = Number(isoDate.slice(0, 4))
  const month = Number(isoDate.slice(5, 7))
  const day = Number(isoDate.slice(8, 10))
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1))
  const lastDayOfTargetMonth = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate()
  const clampedDay = Math.min(day, lastDayOfTargetMonth)
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`
}

/** Whole months between two `YYYY-MM` periods (negative when `to` is earlier). */
function monthsBetween(fromPeriod: string, toPeriod: string): number {
  return (Number(toPeriod.slice(0, 4)) - Number(fromPeriod.slice(0, 4))) * 12
    + (Number(toPeriod.slice(5, 7)) - Number(fromPeriod.slice(5, 7)))
}

/**
 * Build the monthly payment rows of a fixed-term plan: `count` payments
 * starting on `startDate`, one per month — so a 10-month loan yields exactly
 * 10 dated rows. Ids are fresh; `paid` starts false.
 */
export function buildInstallments(startDate: string, count: number): PFInstallment[] {
  const start = ISO_DATE.test(startDate) ? startDate : today()
  const total = Number.isInteger(count) && count > 0 ? count : 0
  return Array.from({ length: total }, (_, index) => ({
    id: pfId(),
    dueDate: addMonthsClamped(start, index),
    number: index + 1,
    paid: false,
  }))
}

/**
 * The day of the month a recurring item charges on: its explicit due day, or
 * the day of its start date, clamped to 1–28 so short months always exist.
 */
function recurringDueDay(item: PFRecurring): number {
  const parsedDay = item.startDate ? Number(item.startDate.slice(8, 10)) : 1
  const dueDay = (item.dueDay ?? parsedDay) || 1
  return Math.max(1, Math.min(28, dueDay))
}

/**
 * Fix the due dates of a machine-generated plan that was saved by an older
 * client (whose month stepping overflowed on the 29th–31st). Only plans that
 * still look untouched are repaired: a start date, a run limit, and one
 * numbered installment per run. Paid flags and ids are preserved.
 */
function repairedInstallments(item: PFRecurring): PFInstallment[] | undefined {
  const installments = item.installments
  const start = item.startDate
  if (!installments?.length || !start || !ISO_DATE.test(start)) return installments
  if (item.maxOccurrences === null || installments.length !== item.maxOccurrences) return installments
  if (!installments.every((inst, index) => inst.number === index + 1)) return installments
  return installments.map((inst, index) => {
    const dueDate = addMonthsClamped(start, index)
    return dueDate === inst.dueDate ? inst : { ...inst, dueDate }
  })
}

/**
 * Bring saved Personal Tracker JSON forward to the current shape. Recurring
 * rows created before run limits existed infer their count from the expenses
 * they generated, while remaining open-ended exactly as they were before.
 */
export function normalizePFData(value: unknown): PFData {
  const input = value && typeof value === 'object' ? value as Partial<PFData> : {}
  const accounts = Array.isArray(input.accounts) ? input.accounts : []
  const categories = Array.isArray(input.categories) ? input.categories : []
  const sources = Array.isArray(input.sources) ? input.sources : []
  const incomes = Array.isArray(input.incomes) ? input.incomes : []
  const expenses = Array.isArray(input.expenses) ? input.expenses : []
  const transfers = Array.isArray(input.transfers) ? input.transfers : []
  const savedRecurring = Array.isArray(input.recurring) ? input.recurring : []

  const historicalRuns = new Map<string, number>()
  for (const expense of expenses) {
    if (!expense.recurringId) continue
    historicalRuns.set(expense.recurringId, (historicalRuns.get(expense.recurringId) ?? 0) + 1)
  }

  const recurring = savedRecurring.map((item) => {
    const maxOccurrences = occurrenceLimit(item.maxOccurrences)
    const runCount = occurrenceCount(item.runCount) ?? historicalRuns.get(item.id) ?? 0
    const normalized: PFRecurring = {
      ...item,
      maxOccurrences,
      runCount,
      // A completed limited plan stays off even if an older client saved a
      // stale active flag after its final payment.
      active: Boolean(item.active) && (maxOccurrences === null || runCount < maxOccurrences),
    }
    const installments = repairedInstallments(normalized)
    return installments && installments !== item.installments ? { ...normalized, installments } : normalized
  })

  return { ...input, accounts, categories, sources, incomes, expenses, transfers, recurring }
}

/** Count one recorded payment and switch the item off after its final run. */
export function recordRecurringRun(item: PFRecurring): PFRecurring {
  const maxOccurrences = occurrenceLimit(item.maxOccurrences)
  const currentRunCount = occurrenceCount(item.runCount) ?? 0
  if (!item.active || (maxOccurrences !== null && currentRunCount >= maxOccurrences)) {
    return { ...item, maxOccurrences, runCount: currentRunCount, active: false }
  }
  const runCount = currentRunCount + 1
  return {
    ...item,
    maxOccurrences,
    runCount,
    active: maxOccurrences === null || runCount < maxOccurrences,
  }
}

/**
 * Remove a recurring payment from Personal Tracker data. Past expenses
 * recorded against this recurring payment are preserved as transactions.
 */
export function deleteRecurringPayment(data: PFData, recurringId: string): PFData {
  return {
    ...data,
    recurring: data.recurring.filter((r) => r.id !== recurringId),
  }
}

export type PFOverduePayment = {
  recurringId: string
  recurringName: string
  installmentId?: string
  installmentNumber?: number
  dueDate: string
  period: string
  amount: number | null
  accountId: string
  categoryId: string
  daysOverdue: number
}

/** Calculate days between two ISO date strings (positive = toIso is after fromIso). */
export function daysDifference(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00`).getTime()
  const to = new Date(`${toIso}T00:00:00`).getTime()
  return Math.floor((to - from) / (1000 * 60 * 60 * 24))
}

/**
 * Return all overdue payments across active recurring items in the tracker.
 * Checks both fixed installments and monthly open-ended recurring payments.
 */
export function getOverdueRecurringPayments(data: PFData, asOfDate: string = today()): PFOverduePayment[] {
  const overdue: PFOverduePayment[] = []

  for (const r of data.recurring) {
    if (!r.active) continue
    if (r.maxOccurrences !== null && r.runCount >= r.maxOccurrences) continue

    if (r.installments && r.installments.length > 0) {
      for (const inst of r.installments) {
        if (inst.paid) continue
        if (inst.dueDate < asOfDate) {
          const alreadyPaid = data.expenses.some(
            (e) => e.recurringId === r.id && (e.installmentNumber === inst.number || (e.dueDate === inst.dueDate && e.paid))
          )
          if (!alreadyPaid) {
            overdue.push({
              recurringId: r.id,
              recurringName: r.name,
              installmentId: inst.id,
              installmentNumber: inst.number,
              dueDate: inst.dueDate,
              period: inst.dueDate.slice(0, 7),
              amount: r.expectedAmount,
              accountId: r.accountId,
              categoryId: r.categoryId,
              daysOverdue: daysDifference(inst.dueDate, asOfDate),
            })
          }
        }
      }
    } else {
      // Monthly open-ended payment or recurring payment with no pre-generated installments
      const parsedDay = r.startDate ? Number(r.startDate.slice(8, 10)) : 1
      const dueDay = (r.dueDay ?? parsedDay) || 1
      const safeDueDay = Math.max(1, Math.min(28, dueDay))
      const dayStr = String(safeDueDay).padStart(2, '0')

      const startPeriod = r.startDate ? r.startDate.slice(0, 7) : asOfDate.slice(0, 7)
      const currentPeriodStr = asOfDate.slice(0, 7)

      let [year, month] = startPeriod.split('-').map(Number)
      const [endYear, endMonth] = currentPeriodStr.split('-').map(Number)

      // Cap backwards scan to at most 12 months
      const startLimit = new Date(`${asOfDate}T00:00:00`)
      startLimit.setMonth(startLimit.getMonth() - 12)
      const startLimitPeriod = startLimit.toISOString().slice(0, 7)
      if (startPeriod < startLimitPeriod) {
        [year, month] = startLimitPeriod.split('-').map(Number)
      }

      while (year < endYear || (year === endYear && month <= endMonth)) {
        const periodStr = `${year}-${String(month).padStart(2, '0')}`
        const dueDate = `${periodStr}-${dayStr}`

        if (dueDate < asOfDate) {
          const isPaid = data.expenses.some(
            (e) => e.recurringId === r.id && (e.period === periodStr || e.dueDate === dueDate || (e.dueDate && e.dueDate.slice(0, 7) === periodStr)) && e.paid
          )
          if (!isPaid) {
            overdue.push({
              recurringId: r.id,
              recurringName: r.name,
              dueDate,
              period: periodStr,
              amount: r.expectedAmount,
              accountId: r.accountId,
              categoryId: r.categoryId,
              daysOverdue: daysDifference(dueDate, asOfDate),
            })
          }
        }

        month++
        if (month > 12) {
          month = 1
          year++
        }
      }
    }
  }

  // Sort earliest due date first (most overdue on top)
  return overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate))
}

export type PFScheduleStatus = 'overdue' | 'due-soon' | 'upcoming' | 'paid'

/** A bill due today or within this many days reads as "Due Soon". */
export const DUE_SOON_DAYS = 3

/** One dated payment row in the schedule — a single installment of one bill. */
export type PFScheduledPayment = {
  /** Stable key for lists: the installment id, or a derived one for projected rows. */
  key: string
  recurring: PFRecurring
  recurringId: string
  recurringName: string
  /** Absent for projected rows of an open-ended bill (nothing is stored yet). */
  installmentId?: string
  installmentNumber: number
  dueDate: string
  period: string
  amount: number | null
  paid: boolean
  /** The date the payment was actually recorded, when it is paid. */
  paidOn: string | null
  status: PFScheduleStatus
  /** Days from the reference date to the due date — negative once it has passed. */
  daysFromReference: number
  /** True when the row was projected for an open-ended bill with no stored schedule. */
  projected: boolean
}

/**
 * How far an open-ended bill ("until switched off") is projected into the
 * future and back into the past when it has no stored installments. A
 * fixed-term plan needs neither: its rows were generated when it was added.
 */
export const SCHEDULE_HORIZON_MONTHS = 6
export const SCHEDULE_LOOKBACK_MONTHS = 12

/** The expense that settled a stored installment, if any. */
function paidExpenseForInstallment(data: PFData, recurringId: string, inst: PFInstallment): PFExpense | undefined {
  return data.expenses.find(
    (e) => e.recurringId === recurringId && (e.installmentNumber === inst.number || (e.dueDate === inst.dueDate && e.paid)),
  )
}

/** The expense that settled a projected month of an open-ended bill, if any. */
function paidExpenseForPeriod(data: PFData, recurringId: string, period: string, dueDate: string): PFExpense | undefined {
  return data.expenses.find(
    (e) => e.recurringId === recurringId && e.paid && (e.period === period || e.dueDate === dueDate),
  )
}

/** Schedule status: Overdue → Due soon (due today or within DUE_SOON_DAYS) → Upcoming → Paid. */
export function scheduleStatus(paid: boolean, daysFromReference: number): PFScheduleStatus {
  if (paid) return 'paid'
  if (daysFromReference < 0) return 'overdue'
  return daysFromReference <= DUE_SOON_DAYS ? 'due-soon' : 'upcoming'
}

/**
 * Order the schedule strictly by payment date, nearest first — paid rows keep
 * their place in the calendar instead of sinking, exactly like a paper
 * payment calendar. Ties (two bills charging on the same day) break by bill
 * name then installment number, so the list is stable.
 */
export function compareScheduledPayments(a: PFScheduledPayment, b: PFScheduledPayment): number {
  if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate)
  const byName = a.recurringName.localeCompare(b.recurringName)
  return byName !== 0 ? byName : a.installmentNumber - b.installmentNumber
}

/**
 * Every dated payment row of every recurring bill in one flat list, nearest
 * date first. A 10-month plan contributes all 10 of its dated rows; adding
 * another bill simply merges its rows into the same ordering, so the list
 * re-adjusts around whatever is due next.
 *
 * Switched-off and completed bills contribute their paid history only —
 * their remaining dates are no longer scheduled.
 */
export function getScheduledPayments(data: PFData, asOfDate: string = today()): PFScheduledPayment[] {
  const reference = ISO_DATE.test(asOfDate) ? asOfDate : today()
  const rows: PFScheduledPayment[] = []

  const push = (row: {
    recurring: PFRecurring
    installmentNumber: number
    dueDate: string
    installmentId?: string
    paid: boolean
    paidOn: string | null
    projected: boolean
  }) => {
    const { recurring, installmentNumber, dueDate, installmentId, paid, paidOn, projected } = row
    const daysFromReference = daysDifference(reference, dueDate)
    rows.push({
      key: installmentId || `${recurring.id}:${dueDate}`,
      recurring,
      recurringId: recurring.id,
      recurringName: recurring.name,
      installmentId,
      installmentNumber,
      dueDate,
      period: dueDate.slice(0, 7),
      amount: recurring.expectedAmount,
      paid,
      paidOn,
      status: scheduleStatus(paid, daysFromReference),
      daysFromReference,
      projected,
    })
  }

  const lookbackPeriod = addMonthsClamped(reference, -SCHEDULE_LOOKBACK_MONTHS).slice(0, 7)
  const horizonPeriod = addMonthsClamped(reference, SCHEDULE_HORIZON_MONTHS).slice(0, 7)

  for (const r of data.recurring) {
    const finished = r.maxOccurrences !== null && r.runCount >= r.maxOccurrences
    const schedulesUnpaid = r.active && !finished

    if (r.installments && r.installments.length > 0) {
      for (const inst of r.installments) {
        const expense = paidExpenseForInstallment(data, r.id, inst)
        const paid = inst.paid || Boolean(expense)
        // A switched-off bill keeps its paid history and drops its open dates.
        if (!paid && !schedulesUnpaid) continue
        push({ recurring: r, installmentNumber: inst.number, dueDate: inst.dueDate, installmentId: inst.id, paid, paidOn: expense?.date ?? null, projected: false })
      }
      continue
    }

    // Open-ended bill with no stored schedule: project its monthly dates from
    // the start (bounded by the lookback) to the horizon, and read each
    // month's paid state from the expenses it generated.
    const startPeriod = r.startDate && ISO_DATE.test(r.startDate) ? r.startDate.slice(0, 7) : reference.slice(0, 7)
    const firstPeriod = startPeriod < lookbackPeriod ? lookbackPeriod : startPeriod
    const dueDay = String(recurringDueDay(r)).padStart(2, '0')

    let [year, month] = firstPeriod.split('-').map(Number)
    const [endYear, endMonth] = horizonPeriod.split('-').map(Number)
    while (year < endYear || (year === endYear && month <= endMonth)) {
      const period = `${year}-${String(month).padStart(2, '0')}`
      const dueDate = `${period}-${dueDay}`
      const expense = paidExpenseForPeriod(data, r.id, period, dueDate)
      const paid = Boolean(expense)
      if (paid || schedulesUnpaid) {
        push({ recurring: r, installmentNumber: Math.max(1, monthsBetween(startPeriod, period) + 1), dueDate, paid, paidOn: expense?.date ?? null, projected: true })
      }
      month++
      if (month > 12) {
        month = 1
        year++
      }
    }
  }

  return rows.sort(compareScheduledPayments)
}

/** `2026-10-05` → `Oct 5, 2026`, read as a local day so the date never shifts by timezone. */
export const formatShortDate = (iso: string) =>
  ISO_DATE.test(iso) ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : iso

/** Human wording for a schedule row's due date, relative to the reference day. */
export function scheduledPaymentLabel(row: PFScheduledPayment): string {
  const days = row.daysFromReference
  if (row.paid) return row.paidOn ? `Paid ${formatShortDate(row.paidOn)}` : 'Paid'
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  if (days > 1) return `Due in ${days} days`
  if (days === -1) return '1 day overdue'
  return `${Math.abs(days)} days overdue`
}

export const pfId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`
export const today = () => new Date().toISOString().slice(0, 10)
export const currentPeriod = () => new Date().toISOString().slice(0, 7)
/**
 * Money formatting for the personal tracker. The workspace currency is used
 * when one is configured (Settings), otherwise PHP — the tracker was built
 * for PHP and that stays the default for workspaces without a currency set.
 */
export const money = (n: number, currency: string) => new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(n)

// The dataset is one jsonb row per account. If it ever grows past this the
// upsert becomes slow and eats free-tier egress — refuse with a clear message
// instead of silently degrading (the user should archive/consolidate).
const MAX_PF_BYTES = 4 * 1024 * 1024

export function accountBalance(data: PFData, accountId: string) {
  const a = data.accounts.find((x) => x.id === accountId)
  if (!a) return 0
  return a.startingBalance
    + data.incomes.filter((x) => x.accountId === accountId).reduce((s, x) => s + x.amount, 0)
    - data.expenses.filter((x) => x.accountId === accountId).reduce((s, x) => s + x.amount, 0)
    + data.transfers.filter((x) => x.toId === accountId).reduce((s, x) => s + x.amount, 0)
    - data.transfers.filter((x) => x.fromId === accountId).reduce((s, x) => s + x.amount, 0)
}

const env = import.meta.env
const url = env?.VITE_SUPABASE_URL as string | undefined
const key = (env?.VITE_SUPABASE_PUBLISHABLE_KEY || env?.VITE_SUPABASE_ANON_KEY) as string | undefined
const cloud = url && key ? createClient(url, key) : null
const localKey = (userId: string) => `work-tracker:personal-finance:${userId}`

export interface PFLoadResult {
  data: PFData
  /**
   * True when the cloud copy could not be read (network failure, auth blip —
   * anything except \"the table does not exist\") and the caller is looking at
   * the last locally-saved copy instead. Callers should say so, not silently
   * present stale balances as current.
   */
  stale: boolean
  /** The cloud read error message when `stale` (or the table is missing). */
  cloudError: string | null
}

export async function loadPersonalFinance(userId: string): Promise<PFLoadResult> {
  if (cloud) {
    const { data, error } = await cloud.from('personal_finance_data').select('data').eq('user_id', userId).maybeSingle()
    if (!error && data?.data) return { data: normalizePFData(data.data), stale: false, cloudError: null }
    const missingTable = error?.code === '42P01'
    if (error) console.warn('[personal-finance] Cloud load failed', error.message)
    // Fall back to the local copy, but flag it: silently serving a stale
    // balance during an outage is how \"the tracker says I have X\" goes wrong.
    try {
      return {
        data: normalizePFData(JSON.parse(storage.getItem(localKey(userId)) || '{}')),
        stale: !missingTable,
        cloudError: error?.message ?? null,
      }
    } catch { return { data: emptyPFData(), stale: false, cloudError: error?.message ?? null } }
  }
  try { return { data: normalizePFData(JSON.parse(storage.getItem(localKey(userId)) || '{}')), stale: false, cloudError: null } }
  catch { return { data: emptyPFData(), stale: false, cloudError: null } }
}

export async function savePersonalFinance(userId: string, data: PFData) {
  const normalized = normalizePFData(data)
  const serialized = JSON.stringify(normalized)
  if (serialized.length > MAX_PF_BYTES) {
    throw new Error('Personal tracker data is too large to save. Archive old accounts or delete transactions you no longer need.')
  }
  storage.setItem(localKey(userId), serialized)
  if (cloud) {
    const { error } = await cloud.from('personal_finance_data').upsert({ user_id: userId, data: normalized, updated_at: new Date().toISOString() })
    if (error) throw new Error(error.code === '42P01' ? 'Personal Tracker database is not installed. Run supabase/personal-finance.sql.' : error.message)
  }
}
