/**
 * Verification of the Finance monthly summary (pure functions, no UI):
 *  - one-time expenses appear only in the month they were recorded; earlier
 *    months are hidden from the current month and reachable by picking it
 *  - payroll covers the month it is for
 *  - subscriptions recur on their billing schedule: monthly ones every month
 *    from the month they were added, yearly ones once a year in their billing
 *    month, paused ones never, and a set number of bills ends on its own
 *  - the four cards add up: subscriptions + payroll + one-time expenses = total
 *  - expenses group by category, with no category counted as Other
 *
 * Run: npx tsx scripts/verify-finance-months-local.ts
 */
import type { FinanceItem } from '../src/lib/types'
import {
  addMonths,
  expenseCategoryTotals,
  expensesInMonth,
  monthIndex,
  monthlyFinanceSummary,
  payrollInMonth,
  subscriptionBillsIn,
} from '../src/lib/finance'

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const stamp = (y: number, m: number, d: number, h = 9, min = 0) => new Date(y, m - 1, d, h, min).toISOString()

let seq = 0
function item(over: Partial<FinanceItem> & { kind: FinanceItem['kind'] }): FinanceItem {
  seq += 1
  return {
    id: `f${seq}`,
    name: `Item ${seq}`,
    worker_id: null,
    amount: 10,
    cycle: null,
    period_month: null,
    due_date: iso(2026, 10, 15),
    status: 'unpaid',
    paid_at: null,
    note: null,
    max_occurrences: null,
    billed_count: 0,
    created_at: stamp(2026, 1, 5),
    updated_at: stamp(2026, 1, 5),
    ...over,
  } as FinanceItem
}

const ids = (rows: FinanceItem[]) => rows.map((r) => r.id).sort()

// ---- 1. Month arithmetic ----------------------------------------------------
console.log('\n--- Month arithmetic ---')
assert(monthIndex('2026-10') === 2026 * 12 + 9, 'a month becomes a running number')
assert(addMonths('2026-12', 1) === '2027-01', 'a month after December is January of the next year')
assert(addMonths('2026-01', -1) === '2025-12', 'a month before January is December of the year before')
assert(addMonths('2026-10', 0) === '2026-10', 'zero months away is the same month')
assert(addMonths('2026-10', 14) === '2027-12', 'more than a year away lands in the right month')

// ---- 2. One-time expenses belong to their month -----------------------------
console.log('\n--- One-time expenses ---')
const e1 = item({ id: 'e-oct-1', kind: 'expense', amount: 248.5, status: 'paid', expense_category: 'Software', due_date: iso(2026, 10, 2) })
const e2 = item({ id: 'e-oct-2', kind: 'expense', amount: 64, status: 'paid', expense_category: null, due_date: iso(2026, 10, 9) })
const e3 = item({ id: 'e-sep', kind: 'expense', amount: 100, status: 'paid', expense_category: 'Travel', due_date: iso(2026, 9, 28) })
const e4 = item({ id: 'e-aug', kind: 'expense', amount: 20, status: 'paid', expense_category: 'Travel', due_date: iso(2026, 8, 3) })
const expenses = [e1, e2, e3, e4]
assert(JSON.stringify(ids(expensesInMonth(expenses, '2026-10'))) === JSON.stringify(['e-oct-1', 'e-oct-2']), 'October shows only October expenses')
assert(!expensesInMonth(expenses, '2026-10').some((e) => e.id === 'e-sep'), 'a new month hides last month’s expenses from the current view')
assert(JSON.stringify(ids(expensesInMonth(expenses, '2026-09'))) === JSON.stringify(['e-sep']), 'picking September reaches its expenses')
assert(expensesInMonth(expenses, '2026-07').length === 0, 'a month with nothing recorded is empty')
const bill = item({ kind: 'bill', amount: 320, due_date: iso(2026, 10, 3) })
assert(expensesInMonth([bill], '2026-10').length === 0, 'a bill is not a one-time expense')

// ---- 3. Payroll covers the month it is for ----------------------------------
console.log('\n--- Payroll ---')
const p1 = item({ id: 'p-oct-1', kind: 'payroll', worker_id: 'w1', amount: 1240, period_month: '2026-10', status: 'unpaid' })
const p2 = item({ id: 'p-oct-2', kind: 'payroll', worker_id: 'w2', amount: 1520, period_month: '2026-10', status: 'paid' })
const p3 = item({ id: 'p-sep', kind: 'payroll', worker_id: 'w1', amount: 1100, period_month: '2026-09', status: 'paid' })
assert(JSON.stringify(ids(payrollInMonth([p1, p2, p3], '2026-10'))) === JSON.stringify(['p-oct-1', 'p-oct-2']), 'payroll is grouped by the month it covers')

// ---- 4. Subscriptions on their billing schedule -----------------------------
console.log('\n--- Subscriptions ---')
const monthly = item({ kind: 'subscription', cycle: 'monthly', amount: 59.99, status: 'active', due_date: iso(2026, 10, 3), created_at: stamp(2026, 1, 5) })
assert(!subscriptionBillsIn(monthly, '2025-12'), 'a monthly subscription is not billed before the month it was added')
assert(subscriptionBillsIn(monthly, '2026-01'), 'a monthly subscription is billed in the month it was added')
assert(subscriptionBillsIn(monthly, '2026-10'), 'a monthly subscription is billed every month')
assert(subscriptionBillsIn(monthly, '2027-06'), 'and in future months too')

const addedLate = item({ kind: 'subscription', cycle: 'monthly', status: 'active', due_date: iso(2026, 10, 20), created_at: stamp(2026, 10, 20) })
assert(!subscriptionBillsIn(addedLate, '2026-09'), 'a subscription added in October is not counted in September')
assert(subscriptionBillsIn(addedLate, '2026-10'), 'and is counted from October')

const addedAtMonthEnd = item({ kind: 'subscription', cycle: 'monthly', status: 'active', due_date: iso(2026, 10, 1), created_at: stamp(2026, 9, 30, 23, 30) })
assert(subscriptionBillsIn(addedAtMonthEnd, '2026-09'), 'a subscription added at 23:30 on 30 September counts from September (local month)')

const yearly = item({ kind: 'subscription', cycle: 'yearly', amount: 149.99, status: 'active', due_date: iso(2026, 11, 15), created_at: stamp(2025, 1, 5) })
assert(subscriptionBillsIn(yearly, '2025-11'), 'a yearly subscription bills in its billing month of an earlier year')
assert(subscriptionBillsIn(yearly, '2026-11'), 'and in its billing month')
assert(!subscriptionBillsIn(yearly, '2026-10'), 'not in the month before its billing month')
assert(!subscriptionBillsIn(yearly, '2026-12'), 'not in the month after its billing month')

const yearlyNew = item({ kind: 'subscription', cycle: 'yearly', status: 'active', due_date: iso(2026, 11, 15), created_at: stamp(2026, 3, 1) })
assert(!subscriptionBillsIn(yearlyNew, '2025-11') && subscriptionBillsIn(yearlyNew, '2026-11'), 'a yearly subscription added in March starts with its November billing')

const paused = item({ kind: 'subscription', cycle: 'monthly', status: 'paused', due_date: iso(2026, 10, 3), created_at: stamp(2026, 1, 5) })
const pausedYearly = item({ kind: 'subscription', cycle: 'yearly', status: 'paused', due_date: iso(2026, 11, 15), created_at: stamp(2025, 1, 5) })
assert(!subscriptionBillsIn(paused, '2026-10') && !subscriptionBillsIn(pausedYearly, '2026-11'), 'a paused subscription never bills')

// A set number of bills: the last of them is the last month it bills.
const tenOfTwelve = item({ kind: 'subscription', cycle: 'monthly', status: 'active', due_date: iso(2026, 10, 5), created_at: stamp(2026, 1, 5), max_occurrences: 12, billed_count: 10 })
assert(subscriptionBillsIn(tenOfTwelve, '2026-10') && subscriptionBillsIn(tenOfTwelve, '2026-11'), 'with two bills left, it bills this month and next')
assert(!subscriptionBillsIn(tenOfTwelve, '2026-12'), 'and stops after the last bill it has left')
const allBilled = item({ kind: 'subscription', cycle: 'monthly', status: 'active', due_date: iso(2026, 10, 5), created_at: stamp(2026, 1, 5), max_occurrences: 12, billed_count: 12 })
assert(!subscriptionBillsIn(allBilled, '2026-10'), 'a subscription with no bills left does not bill')
const yearlyLimited = item({ kind: 'subscription', cycle: 'yearly', status: 'active', due_date: iso(2026, 11, 15), created_at: stamp(2026, 1, 5), max_occurrences: 3, billed_count: 1 })
assert(subscriptionBillsIn(yearlyLimited, '2026-11') && subscriptionBillsIn(yearlyLimited, '2027-11'), 'a yearly limit counts years, not months')
assert(!subscriptionBillsIn(yearlyLimited, '2028-11'), 'and ends after the last year it has left')

assert(!subscriptionBillsIn(item({ kind: 'bill', status: 'active' }), '2026-10'), 'a bill is never a subscription')

// ---- 5. The four cards -------------------------------------------------------
console.log('\n--- The four cards ---')
const ledger = [monthly, yearly, p1, p2, p3, e1, e2, e3, e4, bill]
const oct = monthlyFinanceSummary(ledger, '2026-10')
assert(oct.subscriptions === 59.99 && oct.subscriptionCount === 1, 'October subscriptions: the monthly one only')
assert(oct.payroll === 2760 && oct.payrollCount === 2 && oct.payrollUnpaidCount === 1, 'October payroll: both runs, one unpaid')
assert(oct.expenses === 312.5 && oct.expenseCount === 2, 'October one-time expenses: the two October expenses')
assert(oct.total === 3132.49, 'October total is subscriptions + payroll + expenses')
assert(oct.total === Math.round((oct.subscriptions + oct.payroll + oct.expenses) * 100) / 100, 'the total is the sum of the three cards')

const nov = monthlyFinanceSummary(ledger, '2026-11')
assert(nov.subscriptions === 209.98 && nov.subscriptionCount === 2, 'November adds the yearly subscription in full, not divided by 12')
assert(nov.payroll === 0 && nov.expenses === 0 && nov.total === 209.98, 'November has no payroll or expenses, so the total is the subscriptions')

const sep = monthlyFinanceSummary(ledger, '2026-09')
assert(sep.expenses === 100 && sep.payroll === 1100 && sep.total === 59.99 + 1100 + 100, 'September shows its own expenses and payroll')

const rounding = monthlyFinanceSummary(
  [item({ kind: 'subscription', cycle: 'monthly', amount: 0.1, status: 'active', created_at: stamp(2026, 1, 1) }), item({ kind: 'subscription', cycle: 'monthly', amount: 0.2, status: 'active', created_at: stamp(2026, 1, 1) })],
  '2026-10'
)
assert(rounding.subscriptions === 0.3 && rounding.total === 0.3, 'cents add up without float noise (0.1 + 0.2 = 0.30)')

// Every expense lands in exactly one month, so the months add back up to the whole.
let byMonth = 0
for (let i = 0; i < 12; i++) byMonth += expensesInMonth(expenses, addMonths('2026-01', i)).reduce((s, e) => s + e.amount, 0)
const everyExpense = expenses.reduce((s, e) => s + e.amount, 0)
assert(Math.abs(byMonth - everyExpense) < 1e-9, 'the months of 2026 add back up to every recorded expense')

// ---- 6. Categories ----------------------------------------------------------
console.log('\n--- Categories ---')
const cats = expenseCategoryTotals(expensesInMonth(expenses, '2026-10'))
assert(JSON.stringify(cats.map((c) => c.category)) === JSON.stringify(['Software', 'Other']), 'categories are listed largest first, with Other last here')
assert(cats[0].amount === 248.5 && cats[0].count === 1, 'the Software total is the one expense in it')
assert(cats[1].amount === 64 && cats[1].count === 1, 'an expense with no category is counted as Other')
const travel = expenseCategoryTotals(expensesInMonth(expenses, '2026-09'))
assert(travel.length === 1 && travel[0].category === 'Travel' && travel[0].amount === 100, 'a month with one category shows just that category')

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll finance month checks passed.')
process.exitCode = failures ? 1 : 0
