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
export const peso = (n: number) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(n)

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

export async function loadPersonalFinance(userId: string): Promise<PFData> {
  if (cloud) {
    const { data, error } = await cloud.from('personal_finance_data').select('data').eq('user_id', userId).maybeSingle()
    if (!error && data?.data) return { ...emptyPFData(), ...(data.data as PFData) }
    if (error && error.code !== '42P01') console.warn('[personal-finance] Cloud load failed', error.message)
  }
  try { return { ...emptyPFData(), ...JSON.parse(localStorage.getItem(localKey(userId)) || '{}') } } catch { return emptyPFData() }
}

export async function savePersonalFinance(userId: string, data: PFData) {
  localStorage.setItem(localKey(userId), JSON.stringify(data))
  if (cloud) {
    const { error } = await cloud.from('personal_finance_data').upsert({ user_id: userId, data, updated_at: new Date().toISOString() })
    if (error) throw new Error(error.code === '42P01' ? 'Personal Tracker database is not installed. Run supabase/personal-finance.sql.' : error.message)
  }
}
