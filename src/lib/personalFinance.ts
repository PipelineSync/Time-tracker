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
    return {
      ...item,
      maxOccurrences,
      runCount,
      // A completed limited plan stays off even if an older client saved a
      // stale active flag after its final payment.
      active: Boolean(item.active) && (maxOccurrences === null || runCount < maxOccurrences),
    }
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
