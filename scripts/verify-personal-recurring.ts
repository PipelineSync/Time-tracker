/**
 * Ad-hoc verification of Personal Tracker recurring-payment run limits:
 *  - legacy recurring rows stay open-ended and infer already-paid runs
 *  - a set run limit switches the payment off after its final payment
 *  - an open-ended payment keeps running until manually switched off
 *
 * Run: npx tsx scripts/verify-personal-recurring.ts
 */

import { deleteRecurringPayment, emptyPFData, normalizePFData, recordRecurringRun, type PFRecurring } from '../src/lib/personalFinance'

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    process.exitCode = 1
  } else {
    console.log(`ok: ${message}`)
  }
}

const legacy = normalizePFData({
  ...emptyPFData(),
  expenses: [
    {
      id: 'expense-1',
      date: '2026-07-01',
      name: 'Legacy payment',
      categoryId: 'category-1',
      amount: 100,
      accountId: 'account-1',
      paid: true,
      note: 'Recurring payment',
      recurringId: 'recurring-1',
      period: '2026-07',
    },
    {
      id: 'expense-2',
      date: '2026-08-01',
      name: 'Legacy payment',
      categoryId: 'category-1',
      amount: 100,
      accountId: 'account-1',
      paid: true,
      note: 'Recurring payment',
      recurringId: 'recurring-1',
      period: '2026-08',
    },
  ],
  recurring: [{
    id: 'recurring-1',
    name: 'Legacy payment',
    categoryId: 'category-1',
    accountId: 'account-1',
    expectedAmount: 100,
    dueDay: 1,
    active: true,
  }],
})
assert(legacy.recurring[0].maxOccurrences === null, 'legacy payments remain active until switched off')
assert(legacy.recurring[0].runCount === 2, 'legacy payments infer their run count from generated expenses')

const limited: PFRecurring = {
  id: 'limited',
  name: 'Two-payment plan',
  categoryId: 'category-1',
  accountId: 'account-1',
  expectedAmount: 500,
  dueDay: 15,
  active: true,
  maxOccurrences: 2,
  runCount: 0,
}
const first = recordRecurringRun(limited)
assert(first.runCount === 1 && first.active, 'the first payment counts as run 1 and stays active below the limit')
const final = recordRecurringRun(first)
assert(final.runCount === 2, 'the final payment increments the run count')
assert(!final.active, 'reaching the configured run limit switches the payment off')
const afterFinal = recordRecurringRun({ ...final, active: true })
assert(afterFinal.runCount === 2 && !afterFinal.active, 'a completed plan cannot run past its configured limit')

const openEnded: PFRecurring = { ...limited, id: 'open', maxOccurrences: null, runCount: 20 }
const nextOpenEnded = recordRecurringRun(openEnded)
assert(nextOpenEnded.runCount === 21 && nextOpenEnded.active, 'an open-ended payment keeps running until manually switched off')

const manuallyOff = recordRecurringRun({ ...openEnded, active: false })
assert(!manuallyOff.active && manuallyOff.runCount === openEnded.runCount, 'a switched-off payment cannot record another run')

// Deleting a recurring payment
const testData = normalizePFData({
  ...emptyPFData(),
  expenses: [
    {
      id: 'expense-1',
      date: '2026-07-01',
      name: 'Gym membership',
      categoryId: 'category-1',
      amount: 50,
      accountId: 'account-1',
      paid: true,
      note: 'Recurring payment',
      recurringId: 'recurring-gym',
      period: '2026-07',
    },
  ],
  recurring: [
    {
      id: 'recurring-gym',
      name: 'Gym membership',
      categoryId: 'category-1',
      accountId: 'account-1',
      expectedAmount: 50,
      dueDay: 5,
      active: true,
      maxOccurrences: null,
      runCount: 1,
    },
    {
      id: 'recurring-cloud',
      name: 'Cloud storage',
      categoryId: 'category-2',
      accountId: 'account-1',
      expectedAmount: 10,
      dueDay: 12,
      active: true,
      maxOccurrences: null,
      runCount: 0,
    },
  ],
})

const afterDelete = deleteRecurringPayment(testData, 'recurring-gym')
assert(afterDelete.recurring.length === 1, 'deleting a recurring payment removes it from the list')
assert(afterDelete.recurring[0].id === 'recurring-cloud', 'other recurring payments remain intact')
assert(afterDelete.expenses.length === 1, 'historical expenses are preserved when recurring payment is deleted')
assert(afterDelete.expenses[0].id === 'expense-1', 'preserved expense data remains unchanged')
const reNormalized = normalizePFData(afterDelete)
assert(reNormalized.recurring.length === 1, 'normalized data after deletion remains valid')

// Overdue recurring payments detection
import { getOverdueRecurringPayments } from '../src/lib/personalFinance'

const overdueTestData = normalizePFData({
  ...emptyPFData(),
  expenses: [
    {
      id: 'exp-1',
      date: '2026-08-01',
      dueDate: '2026-08-01',
      name: 'Phone bill',
      categoryId: 'category-1',
      amount: 40,
      accountId: 'account-1',
      paid: true,
      note: 'Recurring',
      recurringId: 'rec-phone',
      period: '2026-08',
      installmentNumber: 1,
    },
  ],
  recurring: [
    {
      id: 'rec-phone',
      name: 'Phone bill',
      categoryId: 'category-1',
      accountId: 'account-1',
      expectedAmount: 40,
      dueDay: 1,
      active: true,
      maxOccurrences: 12,
      runCount: 1,
      startDate: '2026-08-01',
      installments: [
        { id: 'inst-1', dueDate: '2026-08-01', number: 1, paid: true },
        { id: 'inst-2', dueDate: '2026-09-01', number: 2, paid: false }, // Overdue as of 2026-09-15
        { id: 'inst-3', dueDate: '2026-10-01', number: 3, paid: false }, // Upcoming
      ],
    },
    {
      id: 'rec-internet',
      name: 'Internet subscription',
      categoryId: 'category-1',
      accountId: 'account-1',
      expectedAmount: 60,
      dueDay: 5, // Due on the 5th, so 2026-09-05 is overdue as of 2026-09-15
      active: true,
      maxOccurrences: null,
      runCount: 0,
      startDate: '2026-09-01',
    },
    {
      id: 'rec-gym-inactive',
      name: 'Old gym',
      categoryId: 'category-1',
      accountId: 'account-1',
      expectedAmount: 30,
      dueDay: 2,
      active: false, // inactive, should NOT be overdue
      maxOccurrences: null,
      runCount: 0,
      startDate: '2026-09-01',
    },
  ],
})

const asOf = '2026-09-15'
const overdues = getOverdueRecurringPayments(overdueTestData, asOf)
assert(overdues.length === 2, `found 2 overdue recurring payments (got ${overdues.length})`)

const phoneOverdue = overdues.find(o => o.recurringId === 'rec-phone')
assert(phoneOverdue !== undefined, 'installment-based recurring phone bill is detected as overdue')
assert(phoneOverdue?.dueDate === '2026-09-01', 'overdue phone bill has correct due date 2026-09-01')
assert(phoneOverdue?.installmentNumber === 2, 'overdue phone bill has correct installment number 2')
assert(phoneOverdue?.daysOverdue === 14, `overdue phone bill calculates 14 days overdue (got ${phoneOverdue?.daysOverdue})`)

const internetOverdue = overdues.find(o => o.recurringId === 'rec-internet')
assert(internetOverdue !== undefined, 'open-ended recurring internet bill is detected as overdue')
assert(internetOverdue?.dueDate === '2026-09-05', 'overdue internet bill has correct due date 2026-09-05')
assert(internetOverdue?.daysOverdue === 10, `overdue internet bill calculates 10 days overdue (got ${internetOverdue?.daysOverdue})`)

const inactiveOverdue = overdues.find(o => o.recurringId === 'rec-gym-inactive')
assert(inactiveOverdue === undefined, 'inactive recurring payment is not reported as overdue')

// When internet bill is marked paid for 2026-09, it is no longer overdue
const afterPaidTestData = normalizePFData({
  ...overdueTestData,
  expenses: [
    ...overdueTestData.expenses,
    {
      id: 'exp-internet-paid',
      date: '2026-09-15',
      dueDate: '2026-09-05',
      name: 'Internet subscription',
      categoryId: 'category-1',
      amount: 60,
      accountId: 'account-1',
      paid: true,
      note: 'Recurring',
      recurringId: 'rec-internet',
      period: '2026-09',
    },
  ],
})
const overduesAfterPaid = getOverdueRecurringPayments(afterPaidTestData, asOf)
assert(overduesAfterPaid.length === 1, `only 1 overdue payment remaining after internet is paid (got ${overduesAfterPaid.length})`)
assert(overduesAfterPaid[0].recurringId === 'rec-phone', 'only phone bill is overdue')

// Overdue notification deduplication tests (each bill notified strictly once)
import { localBackend } from '../src/lib/localDb'

await localBackend.signIn('admin', 'admin.pipelinesync')
const me = (await localBackend.getSession()).data!
assert(me !== null, 'admin is signed in for notification tests')

// 1. First overdue bill notification created
const res1 = await localBackend.createNotification(me.id, {
  type: 'payment',
  message: 'Overdue recurring payment: "Phone bill" (₱40.00) was due on 2026-09-01 (14 days overdue)',
})
assert(res1.data !== null, 'first overdue notification created successfully')

// 2. Attempting to notify the same overdue bill again (even with updated days overdue)
const res2 = await localBackend.createNotification(me.id, {
  type: 'payment',
  message: 'Overdue recurring payment: "Phone bill" (₱40.00) was due on 2026-09-01 (15 days overdue)',
})
assert(res2.error === null, 'duplicate creation call succeeded without error')
const listAfterDup = (await localBackend.listNotifications()).data || []
const phoneNotifs = listAfterDup.filter(n => n.message.includes('Phone bill') && n.message.includes('2026-09-01'))
assert(phoneNotifs.length === 1, `phone bill is notified strictly once (got ${phoneNotifs.length})`)

// 3. Other overdue bill ("and other") is notified once
const resOther = await localBackend.createNotification(me.id, {
  type: 'payment',
  message: 'Overdue recurring payment: "Internet subscription" (₱60.00) was due on 2026-09-05 (10 days overdue)',
})
assert(resOther.data !== null, 'other overdue bill notification created')

// Attempting to re-notify the other bill
await localBackend.createNotification(me.id, {
  type: 'payment',
  message: 'Overdue recurring payment: "Internet subscription" (₱60.00) was due on 2026-09-05 (11 days overdue)',
})
const listAfterOther = (await localBackend.listNotifications()).data || []
const internetNotifs = listAfterOther.filter(n => n.message.includes('Internet subscription') && n.message.includes('2026-09-05'))
assert(internetNotifs.length === 1, `other overdue bill is notified strictly once (got ${internetNotifs.length})`)

// 4. Exceeding recent window: add 25 general notes, verify deduplication still holds
for (let i = 0; i < 25; i++) {
  await localBackend.createNotification(me.id, {
    type: 'note',
    message: `Test note ${i}`,
  })
}
const allNotifs = (await localBackend.listNotifications()).data || []
assert(allNotifs.length >= 27, `database has ${allNotifs.length} total notifications (exceeding 20-item window)`)

// Attempt to notify Phone bill again even though it rolled out of the top 20
await localBackend.createNotification(me.id, {
  type: 'payment',
  message: 'Overdue recurring payment: "Phone bill" (₱40.00) was due on 2026-09-01 (20 days overdue)',
})
const listAfterWindow = (await localBackend.listNotifications()).data || []
const phoneAfterWindow = listAfterWindow.filter(n => n.message.includes('Phone bill') && n.message.includes('2026-09-01'))
assert(phoneAfterWindow.length === 1, `phone bill is still notified strictly once even when older than 20 items (got ${phoneAfterWindow.length})`)

// ── Removing paid payments from recurring list & paid transactions view ──
const scenarioData: PFData = normalizePFData({
  ...emptyPFData(),
  accounts: [{ id: 'acc-1', name: 'Bank Account', startingBalance: 10000, color: 'blue' }],
  categories: [
    { id: 'cat-bills', name: 'Bills', color: 'indigo', icon: 'zap' },
    { id: 'cat-groceries', name: 'Groceries', color: 'green', icon: 'shopping-cart' },
  ],
  recurring: [
    {
      id: 'rec-phone',
      name: 'Phone bill',
      categoryId: 'cat-bills',
      accountId: 'acc-1',
      expectedAmount: 40,
      dueDay: 1,
      active: true,
      maxOccurrences: 3,
      runCount: 0,
      startDate: '2026-09-01',
      installments: [
        { id: 'inst-1', dueDate: '2026-09-01', number: 1, paid: false },
        { id: 'inst-2', dueDate: '2026-10-01', number: 2, paid: false },
        { id: 'inst-3', dueDate: '2026-11-01', number: 3, paid: false },
      ],
    },
    {
      id: 'rec-gym',
      name: 'Gym membership',
      categoryId: 'cat-bills',
      accountId: 'acc-1',
      expectedAmount: 30,
      dueDay: 10,
      active: true,
      maxOccurrences: null,
      runCount: 0,
      startDate: '2026-09-01',
    },
  ],
  expenses: [],
})

// Function mimicking Overview pending recurring payments filter:
const getPendingRecurringOverview = (data: PFData, thisPeriod: string) => {
  return data.recurring.filter(r => r.active).flatMap(r => {
    if (r.installments && r.installments.length > 0) {
      const monthInst = r.installments.filter(i => i.dueDate.slice(0, 7) === thisPeriod && !i.paid)
      if (monthInst.length > 0) {
        return monthInst.map(i => ({ recurringId: r.id, name: r.name, installmentId: i.id }))
      }
      return []
    }
    const paidThisMonth = data.expenses.some(x => x.recurringId === r.id && x.period === thisPeriod && x.paid !== false)
    if (!paidThisMonth) {
      return [{ recurringId: r.id, name: r.name }]
    }
    return []
  })
}

// Function mimicking Overview paid transactions list:
const getPaidTransactionsOverview = (data: PFData, scope: 'month' | 'all', thisPeriod: string) => {
  const allPaid = data.expenses.filter(x => x.paid !== false)
  if (scope === 'month') {
    return allPaid.filter(x => (x.period || x.date.slice(0, 7)) === thisPeriod)
  }
  return allPaid
}

const curMonth = '2026-09'

// Initially both Phone bill and Gym membership are pending:
let pendingOverview = getPendingRecurringOverview(scenarioData, curMonth)
assert(pendingOverview.length === 2, `initially 2 recurring payments pending this month (got ${pendingOverview.length})`)
let paidOverview = getPaidTransactionsOverview(scenarioData, 'month', curMonth)
assert(paidOverview.length === 0, 'initially 0 paid transactions')

// Mark Phone bill paid:
const phoneInst1 = scenarioData.recurring[0].installments![0]
const phoneExpense = {
  id: 'exp-phone-1',
  date: '2026-09-02',
  dueDate: phoneInst1.dueDate,
  name: scenarioData.recurring[0].name,
  categoryId: scenarioData.recurring[0].categoryId,
  amount: scenarioData.recurring[0].expectedAmount!,
  accountId: scenarioData.recurring[0].accountId,
  paid: true,
  note: 'Recurring payment',
  recurringId: scenarioData.recurring[0].id,
  period: curMonth,
  installmentNumber: phoneInst1.number,
}
const afterPhonePaid: PFData = {
  ...scenarioData,
  recurring: scenarioData.recurring.map(r =>
    r.id === 'rec-phone'
      ? {
          ...r,
          runCount: r.runCount + 1,
          installments: r.installments!.map(i => (i.id === phoneInst1.id ? { ...i, paid: true } : i)),
        }
      : r
  ),
  expenses: [...scenarioData.expenses, phoneExpense],
}

// Verify Phone bill is removed from recurring payments:
pendingOverview = getPendingRecurringOverview(afterPhonePaid, curMonth)
assert(pendingOverview.length === 1, `after paying phone bill, exactly 1 recurring payment remains pending (got ${pendingOverview.length})`)
assert(pendingOverview[0].recurringId === 'rec-gym', 'only Gym membership remains in pending recurring')
assert(!pendingOverview.some(p => p.recurringId === 'rec-phone'), 'Phone bill is removed from recurring payments when paid')

// Verify Phone bill appears in paid transactions view:
paidOverview = getPaidTransactionsOverview(afterPhonePaid, 'month', curMonth)
assert(paidOverview.length === 1, `paid transactions view now has 1 payment (got ${paidOverview.length})`)
assert(paidOverview[0].recurringId === 'rec-phone', 'Phone bill payment is listed in paid transactions')
assert(paidOverview[0].amount === 40, 'paid transaction has the correct amount')

// Mark Gym membership paid:
const gymExpense = {
  id: 'exp-gym-1',
  date: '2026-09-10',
  dueDate: '2026-09-10',
  name: 'Gym membership',
  categoryId: 'cat-bills',
  amount: 30,
  accountId: 'acc-1',
  paid: true,
  note: 'Recurring payment',
  recurringId: 'rec-gym',
  period: curMonth,
}
const afterBothPaid: PFData = {
  ...afterPhonePaid,
  recurring: afterPhonePaid.recurring.map(r =>
    r.id === 'rec-gym' ? { ...r, runCount: r.runCount + 1 } : r
  ),
  expenses: [...afterPhonePaid.expenses, gymExpense],
}

// Verify all recurring payments for the month are removed:
pendingOverview = getPendingRecurringOverview(afterBothPaid, curMonth)
assert(pendingOverview.length === 0, 'when all recurring payments are paid, recurring list for month is completely clear (all caught up)')

// Verify paid transactions view contains both payments:
paidOverview = getPaidTransactionsOverview(afterBothPaid, 'month', curMonth)
assert(paidOverview.length === 2, `paid transactions view contains 2 payments (got ${paidOverview.length})`)
assert(paidOverview.some(x => x.recurringId === 'rec-phone'), 'contains phone bill')
assert(paidOverview.some(x => x.recurringId === 'rec-gym'), 'contains gym membership')

// Add a one-time paid expense (e.g. Groceries):
const groceryExpense = {
  id: 'exp-groc-1',
  date: '2026-09-12',
  name: 'Supermarket Groceries',
  categoryId: 'cat-groceries',
  amount: 85,
  accountId: 'acc-1',
  paid: true,
  period: curMonth,
}
const withGrocery: PFData = {
  ...afterBothPaid,
  expenses: [...afterBothPaid.expenses, groceryExpense],
}

// In paid transactions view:
paidOverview = getPaidTransactionsOverview(withGrocery, 'month', curMonth)
assert(paidOverview.length === 3, `paid transactions view includes non-recurring expenses as well (got ${paidOverview.length})`)
const recurringOnlyPaid = paidOverview.filter(x => Boolean(x.recurringId))
assert(recurringOnlyPaid.length === 2, 'filter recurring-only paid transactions yields exactly 2')
const otherOnlyPaid = paidOverview.filter(x => !x.recurringId)
assert(otherOnlyPaid.length === 1 && otherOnlyPaid[0].name === 'Supermarket Groceries', 'filter other paid transactions yields groceries')

console.log('\nDone.')
