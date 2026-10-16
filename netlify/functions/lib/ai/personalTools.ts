/**
 * Nova-only tools for the signed-in person's Personal Tracker (private
 * finance workspace, /personal).
 *
 * Deliberately NOT part of the MCP connector registry (../mcp/tools): the
 * personal tracker is private to its owner, so it is only reachable from
 * inside the app. The read goes through the caller's own Supabase client, and
 * personal_finance_data's RLS lets an account read only its own row.
 */
import type { Tool } from '../mcp/tools'

/** Most recent transactions returned when no date range is given. */
const DEFAULT_DAYS = 90
const MAX_ROWS = 300

type Row = Record<string, unknown>
const list = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : [])
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

const getPersonalTracker: Tool = {
  name: 'get_personal_tracker',
  title: 'Read my personal tracker',
  description:
    "Read the signed-in person's own Personal Tracker (their private finance workspace): accounts with current balances, recurring bills and installments, unpaid expenses, and income, expenses and transfers in a date range (default: the last 90 days). Only ever the caller's own data. Amounts are in the workspace currency.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Start date, YYYY-MM-DD (inclusive). Default: 90 days ago.' },
      to: { type: 'string', description: 'End date, YYYY-MM-DD (inclusive). Default: today.' },
    },
    additionalProperties: false,
  },
  handler: async (caller, args) => {
    const { data: row, error } = await caller.sb
      .from('personal_finance_data')
      .select('data, updated_at')
      .eq('user_id', caller.userId)
      .maybeSingle()
    if (error) {
      if (error.code === '42P01') return { message: 'The Personal Tracker is not installed in this workspace yet.' }
      throw error
    }
    const d = (row?.data ?? {}) as Row
    const accounts = list(d.accounts)
    const incomes = list(d.incomes)
    const expenses = list(d.expenses)
    const transfers = list(d.transfers)
    if (!accounts.length && !incomes.length && !expenses.length) {
      return { message: 'The personal tracker is empty: no accounts or transactions yet.' }
    }

    const nameOf = (rows: Row[]) => {
      const names = new Map(rows.map((r) => [str(r.id), str(r.name)]))
      return (id: unknown) => names.get(str(id)) || null
    }
    const account = nameOf(accounts)
    const category = nameOf(list(d.categories))
    const source = nameOf(list(d.sources))

    // Same formula as accountBalance() in src/lib/personalFinance.ts.
    const sum = (rows: Row[], key: string, id: string) =>
      rows.filter((r) => r[key] === id).reduce((s, r) => s + num(r.amount), 0)
    const balanceOf = (a: Row) => {
      const id = str(a.id)
      return (
        num(a.startingBalance) +
        sum(incomes, 'accountId', id) -
        sum(expenses, 'accountId', id) +
        sum(transfers, 'toId', id) -
        sum(transfers, 'fromId', id)
      )
    }

    const today = new Date().toISOString().slice(0, 10)
    const to = isDate(args.to) ? args.to : today
    const from = isDate(args.from)
      ? args.from
      : new Date(Date.parse(to) - DEFAULT_DAYS * 86_400_000).toISOString().slice(0, 10)
    const inRange = (r: Row) => str(r.date) >= from && str(r.date) <= to
    const recent = (rows: Row[]) =>
      rows
        .filter(inRange)
        .sort((a, b) => str(b.date).localeCompare(str(a.date)))
        .slice(0, MAX_ROWS)

    const activeAccounts = accounts.filter((a) => !a.archived)
    return {
      lastSaved: row?.updated_at ?? null,
      range: { from, to },
      totalBalance: activeAccounts.reduce((s, a) => s + balanceOf(a), 0),
      accounts: accounts.map((a) => ({
        name: str(a.name),
        purpose: str(a.purpose) || null,
        balance: balanceOf(a),
        archived: a.archived === true,
      })),
      recurring: list(d.recurring).map((r) => {
        const installments = list(r.installments)
        return {
          name: str(r.name),
          category: category(r.categoryId),
          account: account(r.accountId),
          expectedAmount: r.expectedAmount ?? null,
          dueDay: r.dueDay ?? null,
          active: r.active !== false,
          totalPayments: r.maxOccurrences ?? null,
          paymentsMade: num(r.runCount),
          nextUnpaidDue:
            installments
              .filter((i) => i.paid !== true)
              .map((i) => str(i.dueDate))
              .sort()[0] ?? null,
        }
      }),
      unpaidExpenses: expenses
        .filter((e) => e.paid === false)
        .map((e) => ({ name: str(e.name), amount: num(e.amount), due: str(e.dueDate) || str(e.date), account: account(e.accountId) })),
      income: recent(incomes).map((i) => ({ date: str(i.date), source: source(i.sourceId), amount: num(i.amount), account: account(i.accountId), note: str(i.note) || undefined })),
      expenses: recent(expenses).map((e) => ({ date: str(e.date), name: str(e.name), category: category(e.categoryId), amount: num(e.amount), account: account(e.accountId), paid: e.paid !== false, note: str(e.note) || undefined })),
      transfers: recent(transfers).map((t) => ({ date: str(t.date), from: account(t.fromId), to: account(t.toId), amount: num(t.amount), note: str(t.note) || undefined })),
    }
  },
}

export const PERSONAL_TOOLS: Tool[] = [getPersonalTracker]
