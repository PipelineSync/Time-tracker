/**
 * Ad-hoc verification of Personal Tracker recurring-payment run limits:
 *  - legacy recurring rows stay open-ended and infer already-paid runs
 *  - a set run limit switches the payment off after its final payment
 *  - an open-ended payment keeps running until manually switched off
 *
 * Run: npx tsx scripts/verify-personal-recurring.ts
 */

import { emptyPFData, normalizePFData, recordRecurringRun, type PFRecurring } from '../src/lib/personalFinance'

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

console.log('\nDone.')
