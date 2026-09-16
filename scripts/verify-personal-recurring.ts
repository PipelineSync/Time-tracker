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

// Clear notifications for a clean test slate
const notifsBefore = (await localBackend.listNotifications()).data || []
for (const n of notifsBefore) {
  // mark read or start fresh
}

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

console.log('\nDone.')
