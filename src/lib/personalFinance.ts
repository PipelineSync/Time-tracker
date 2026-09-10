import { createClient } from '@supabase/supabase-js'

export type PFAccount = { id: string; name: string; purpose: string; startingBalance: number; archived: boolean }
export type PFCategory = { id: string; name: string }
export type PFSource = { id: string; name: string }
export type PFIncome = { id: string; date: string; sourceId: string; amount: number; accountId: string; note: string }
export type PFExpense = { id: string; date: string; name: string; categoryId: string; amount: number; accountId: string; paid: boolean; note: string; recurringId?: string; period?: string }
export type PFTransfer = { id: string; date: string; fromId: string; toId: string; amount: number; note: string }
export type PFRecurring = { id: string; name: string; categoryId: string; accountId: string; expectedAmount: number | null; dueDay: number | null; active: boolean }
export type PFData = { accounts: PFAccount[]; categories: PFCategory[]; sources: PFSource[]; incomes: PFIncome[]; expenses: PFExpense[]; transfers: PFTransfer[]; recurring: PFRecurring[] }

export const emptyPFData = (): PFData => ({ accounts: [], categories: [], sources: [], incomes: [], expenses: [], transfers: [], recurring: [] })
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

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined
const cloud = url && key ? createClient(url, key) : null
const localKey = (userId: string) => `work-tracker:personal-finance:${userId}`

export interface PFLoadResult {
  data: PFData
  /**
   * True when the cloud copy could not be read (network failure, auth blip —
   * anything except "the table does not exist") and the caller is looking at
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
    if (!error && data?.data) return { data: { ...emptyPFData(), ...(data.data as PFData) }, stale: false, cloudError: null }
    const missingTable = error?.code === '42P01'
    if (error) console.warn('[personal-finance] Cloud load failed', error.message)
    // Fall back to the local copy, but flag it: silently serving a stale
    // balance during an outage is how "the tracker says I have X" goes wrong.
    try {
      return {
        data: { ...emptyPFData(), ...JSON.parse(localStorage.getItem(localKey(userId)) || '{}') },
        stale: !missingTable,
        cloudError: error?.message ?? null,
      }
    } catch { return { data: emptyPFData(), stale: false, cloudError: error?.message ?? null } }
  }
  try { return { data: { ...emptyPFData(), ...JSON.parse(localStorage.getItem(localKey(userId)) || '{}') }, stale: false, cloudError: null } }
  catch { return { data: emptyPFData(), stale: false, cloudError: null } }
}

export async function savePersonalFinance(userId: string, data: PFData) {
  const serialized = JSON.stringify(data)
  if (serialized.length > MAX_PF_BYTES) {
    throw new Error('Personal tracker data is too large to save. Archive old accounts or delete transactions you no longer need.')
  }
  localStorage.setItem(localKey(userId), serialized)
  if (cloud) {
    const { error } = await cloud.from('personal_finance_data').upsert({ user_id: userId, data, updated_at: new Date().toISOString() })
    if (error) throw new Error(error.code === '42P01' ? 'Personal Tracker database is not installed. Run supabase/personal-finance.sql.' : error.message)
  }
}
