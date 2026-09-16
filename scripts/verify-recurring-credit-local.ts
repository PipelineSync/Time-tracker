/**
 * Ad-hoc verification of Personal Tracker recurring-payment carry-over and
 * the total balance to pay:
 *  - a payment larger than the monthly amount credits the next payment(s),
 *    which then cost less (possibly nothing)
 *  - leftover credit keeps flowing until it runs out
 *  - a payment smaller than the monthly amount adds its shortfall to the
 *    next payment, so nothing owed is silently lost
 *  - "Total balance to pay" = the plan's full cost − what was actually paid,
 *    which stays exact for over- and under-payments (the old
 *    `monthly × payments left` guess did not)
 *  - the schedule, the overdue list and the carry-over map all agree
 *  - money maths are rounded to centavos (no 0.30000000000000004)
 *
 * Run: npx tsx scripts/verify-recurring-credit-local.ts
 */

import {
  buildInstallments,
  effectiveUnpaidAmounts,
  emptyPFData,
  getOverdueRecurringPayments,
  getScheduledPayments,
  normalizePFData,
  recurringCarryOver,
  recurringPaidCount,
  recurringRemainingBalance,
  type PFData,
  type PFExpense,
  type PFRecurring,
} from '../src/lib/personalFinance'

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    process.exitCode = 1
  } else {
    console.log(`ok: ${message}`)
  }
}

/** A fixed 10-month plan: ₱1,000 a month, due on the 15th from Jan 2026. */
const plan = (overrides: Partial<PFRecurring> = {}): PFRecurring => ({
  id: 'plan',
  name: 'Home Credit',
  categoryId: 'category-loans',
  accountId: 'account-1',
  expectedAmount: 1000,
  dueDay: 15,
  active: true,
  maxOccurrences: 10,
  runCount: 0,
  startDate: '2026-01-15',
  installments: buildInstallments('2026-01-15', 10),
  ...overrides,
})

/** A recorded payment against installment `number` of the plan above. */
const paidExpense = (number: number, amount: number): PFExpense => {
  const dueDate = buildInstallments('2026-01-15', number)[number - 1].dueDate
  return {
    id: `expense-${number}`,
    date: dueDate,
    dueDate,
    name: 'Home Credit',
    categoryId: 'category-loans',
    amount,
    accountId: 'account-1',
    paid: true,
    note: `Recurring payment — installment ${number} of 10`,
    recurringId: 'plan',
    installmentNumber: number,
    period: dueDate.slice(0, 7),
  }
}

const dataWith = (recurring: PFRecurring[], expenses: PFExpense[]): PFData =>
  normalizePFData({ ...emptyPFData(), recurring, expenses })

const amountOf = (data: PFData, r: PFRecurring, installmentNumber: number): number | null | undefined =>
  getScheduledPayments(data, '2026-09-15').find(row => row.recurringId === r.id && row.installmentNumber === installmentNumber)?.amount

// ── Overpayment credits the next payment ────────────────────────────────────
{
  const r = plan()
  const data = dataWith([r], [paidExpense(1, 1200)])
  assert(recurringCarryOver(data, r) === 200, 'a ₱200 overpayment becomes ₱200 of carry-over credit')
  assert(amountOf(data, r, 1) === 1200, 'the paid row shows what was actually paid (₱1,200), not the monthly amount')
  assert(amountOf(data, r, 2) === 800, 'the next payment costs ₱800 after a ₱200 overpayment')
  assert(amountOf(data, r, 3) === 1000, 'the payment after that is back to the full ₱1,000 — credit is used once')
  assert(recurringRemainingBalance(data, r) === 8800, 'total balance to pay is ₱8,800: full cost ₱10,000 − ₱1,200 actually paid')
}

// ── A big overpayment spreads over several payments ─────────────────────────
{
  const r = plan()
  const data = dataWith([r], [paidExpense(1, 2400)])
  assert(recurringCarryOver(data, r) === 1400, 'a ₱1,400 credit is carried after paying ₱2,400 once')
  assert(amountOf(data, r, 2) === 0, 'the next payment is fully covered and costs ₱0')
  assert(amountOf(data, r, 3) === 600, 'the credit keeps flowing: the payment after costs ₱600')
  assert(amountOf(data, r, 4) === 1000, 'credit exhausted, later payments cost the full ₱1,000')
  assert(recurringRemainingBalance(data, r) === 7600, 'total balance to pay is ₱7,600 — not the naive ₱9,000 (monthly × left)')
}

// ── Marking a covered payment paid consumes its credit ──────────────────────
{
  const r = plan()
  const data = dataWith([r], [paidExpense(1, 2400), paidExpense(2, 0)])
  assert(recurringCarryOver(data, r) === 400, 'a ₱0 covered payment consumed ₱1,000 of credit, leaving ₱400')
  assert(amountOf(data, r, 3) === 600, 'the next payment costs ₱600 after the covered month is marked')
  assert(recurringPaidCount(data, r) === 2, 'the covered payment counts as paid (2 of 10)')
  assert(recurringRemainingBalance(data, r) === 7600, 'balance is unchanged by marking a ₱0 covered payment')
}

// ── A shortfall raises the next payment instead of vanishing ────────────────
{
  const r = plan()
  const data = dataWith([r], [paidExpense(1, 800)])
  assert(recurringCarryOver(data, r) === -200, 'a ₱800 payment on a ₱1,000 bill carries a ₱200 shortfall')
  assert(amountOf(data, r, 2) === 1200, 'the next payment costs ₱1,200 until the shortfall is made up')
  assert(recurringRemainingBalance(data, r) === 9200, 'total balance to pay is ₱9,200 — the ₱200 still owed is not lost')
}

// ── Centavos survive the arithmetic ─────────────────────────────────────────
{
  const r = plan({ expectedAmount: 0.3 })
  const data = dataWith([r], [paidExpense(1, 0.5)])
  assert(amountOf(data, r, 2) === 0.1, '₱0.50 paid on a ₱0.30 bill makes the next payment exactly ₱0.10, no float dust')
}

// ── The overdue list agrees with the schedule ───────────────────────────────
{
  const r = plan()
  const data = dataWith([r], [paidExpense(1, 1200)])
  const overdue = getOverdueRecurringPayments(data, '2026-02-20')
  assert(overdue.length === 1, 'only installment 2 is overdue')
  assert(overdue[0].amount === 800, 'the overdue payment shows its reduced cost of ₱800, not the full ₱1,000')
}

// ── Other bills never leak into a bill's carry-over ─────────────────────────
{
  const r = plan()
  const other = plan({ id: 'other', name: 'Internet' })
  const otherPayment = { ...paidExpense(1, 5000), recurringId: 'other', id: 'expense-other' }
  const data = dataWith([r, other], [otherPayment])
  assert(amountOf(data, r, 2) === 1000, 'another bill’s overpayment does not reduce this bill’s next payment')
}

// ── Open-ended bills carry credit across projected months ───────────────────
{
  const r = plan({ id: 'open', name: 'Water bill', maxOccurrences: null, installments: undefined, dueDay: 10, expectedAmount: 500, startDate: '2026-06-10' })
  const junePayment: PFExpense = {
    id: 'expense-june',
    date: '2026-06-10',
    dueDate: '2026-06-10',
    name: 'Water bill',
    categoryId: 'category-loans',
    amount: 750,
    accountId: 'account-1',
    paid: true,
    note: 'Recurring payment — payment 1',
    recurringId: 'open',
    period: '2026-06',
  }
  const data = dataWith([r], [junePayment])
  assert(recurringCarryOver(data, r) === 250, 'a ₱750 payment on a ₱500 bill carries ₱250 of credit')
  const rows = getScheduledPayments(data, '2026-08-15').filter(row => row.recurringId === 'open')
  const july = rows.find(row => row.dueDate === '2026-07-10')
  const august = rows.find(row => row.dueDate === '2026-08-10')
  assert(july?.amount === 250, 'the next projected month costs ₱250 after the overpayment')
  assert(august?.amount === 500, 'the month after is back to the full ₱500')
  assert(july?.paid === false, 'the credited month is still unpaid — it just costs less')
  const overdue = getOverdueRecurringPayments(data, '2026-08-15')
  assert(overdue.some(op => op.dueDate === '2026-07-10' && op.amount === 250), 'the overdue credited month shows ₱250')
  assert(recurringRemainingBalance(data, r) === null, 'an open-ended bill has no fixed total balance to pay')
}

// ── Paid counts and balances read the real data ─────────────────────────────
{
  const r = plan()
  assert(recurringPaidCount(dataWith([r], []), r) === 0, 'an untouched plan has 0 paid')
  const markedOnly = normalizePFData({ ...emptyPFData(), recurring: [{ ...r, runCount: 1, installments: r.installments?.map(i => i.number === 1 ? { ...i, paid: true } : i) }] })
  assert(recurringPaidCount(markedOnly, markedOnly.recurring[0]) === 1, 'an installment marked paid without a stored expense still counts')
  assert(recurringRemainingBalance(dataWith([r], []), r) === 10000, 'an untouched 10×₱1,000 plan has ₱10,000 left to pay')
  const finished = dataWith([r], Array.from({ length: 10 }, (_, i) => paidExpense(i + 1, 1000)))
  assert(recurringRemainingBalance(finished, r) === 0, 'a fully paid plan has ₱0 left to pay')
  const overpaidPlan = dataWith([r], [...Array.from({ length: 9 }, (_, i) => paidExpense(i + 1, 1000)), paidExpense(10, 1200)])
  assert(recurringRemainingBalance(overpaidPlan, r) === 0, 'overpaying the final installment never makes the balance negative')
  const variable = plan({ id: 'variable', expectedAmount: null })
  assert(recurringRemainingBalance(dataWith([variable], []), variable) === null, 'a variable-amount bill has no fixed total to pay')
  const costs = effectiveUnpaidAmounts(dataWith([r], [paidExpense(1, 1200)]), r)
  assert(costs.get(r.installments![1].id) === 800, 'the carry-over map keys fixed plans by installment id')
}

console.log('\nDone.')
