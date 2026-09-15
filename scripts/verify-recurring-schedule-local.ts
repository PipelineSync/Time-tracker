/**
 * Ad-hoc verification of the Personal Tracker payment schedule:
 *  - a fixed-term bill (e.g. 10 months of Home Credit) produces exactly that
 *    many dated rows, one per month from the first payment date
 *  - due dates never drift: month-end starts clamp (31 Jan → 28 Feb) and no
 *    date is shifted a day by the local timezone
 *  - the schedule is flat across bills and ordered nearest date first, so a
 *    newly added bill merges its rows into the same ordering
 *  - paid rows drop below the unpaid ones, most recent payment first
 *  - open-ended bills project their upcoming months; switched-off and
 *    completed bills keep their paid history only
 *  - legacy plans saved with drifted dates are repaired on load
 *
 * Run: npx tsx scripts/verify-recurring-schedule-local.ts
 * Also worth running in a non-UTC zone: TZ=Asia/Manila npx tsx scripts/verify-recurring-schedule-local.ts
 */

import {
  addMonthsClamped,
  buildInstallments,
  emptyPFData,
  getScheduledPayments,
  formatShortDate,
  normalizePFData,
  scheduledPaymentLabel,
  type PFData,
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

const bill = (overrides: Partial<PFRecurring>): PFRecurring => ({
  id: overrides.id ?? 'bill',
  name: overrides.name ?? 'Bill',
  categoryId: 'category-loans',
  accountId: 'account-1',
  expectedAmount: 1500,
  dueDay: null,
  active: true,
  maxOccurrences: null,
  runCount: 0,
  ...overrides,
})

const dataWith = (...recurring: PFRecurring[]): PFData => normalizePFData({ ...emptyPFData(), recurring })

// ── Month arithmetic ────────────────────────────────────────────────────────
assert(addMonthsClamped('2026-09-15', 1) === '2026-10-15', 'adding a month keeps the day of the month')
assert(addMonthsClamped('2026-01-31', 1) === '2026-02-28', 'a 31st start clamps to 28 February instead of overflowing into March')
assert(addMonthsClamped('2028-01-31', 1) === '2028-02-29', 'a 31st start clamps to 29 February in a leap year')
assert(addMonthsClamped('2026-01-31', 3) === '2026-04-30', 'a 31st start clamps to 30 April')
assert(addMonthsClamped('2026-11-15', 3) === '2027-02-15', 'adding months rolls the year over')

// ── A 10-month bill builds 10 dated rows ────────────────────────────────────
const homeCredit = bill({
  id: 'home-credit',
  name: 'Home Credit',
  expectedAmount: 1500,
  maxOccurrences: 10,
  startDate: '2026-09-15',
  installments: buildInstallments('2026-09-15', 10),
})
assert(homeCredit.installments?.length === 10, 'ten months of Home Credit builds ten installments')
assert(
  homeCredit.installments?.map(i => i.dueDate).join(',') ===
    '2026-09-15,2026-10-15,2026-11-15,2026-12-15,2027-01-15,2027-02-15,2027-03-15,2027-04-15,2027-05-15,2027-06-15',
  'the ten installments fall one per month from the first payment date',
)
assert(
  homeCredit.installments?.every((i, index) => i.number === index + 1 && !i.paid) === true,
  'installments are numbered 1-10 and start unpaid',
)
assert(buildInstallments('2026-01-31', 3).map(i => i.dueDate).join(',') === '2026-01-31,2026-02-28,2026-03-31', 'a month-end plan keeps every due date inside its own month')
assert(buildInstallments('2026-09-15', 0).length === 0, 'an open-ended bill stores no installments (its dates are projected)')

const asOf = '2026-09-15'
const homeCreditSchedule = getScheduledPayments(dataWith(homeCredit), asOf)
assert(homeCreditSchedule.length === 10, `all ten Home Credit payments are listed as rows (got ${homeCreditSchedule.length})`)
assert(homeCreditSchedule[0].dueDate === '2026-09-15', 'the nearest date leads the schedule')
assert(homeCreditSchedule[0].status === 'due-today', 'a payment dated today is flagged as due today')
assert(homeCreditSchedule[9].dueDate === '2027-06-15', 'the last row is the final month of the plan')
assert(
  homeCreditSchedule.every((row, index) => index === 0 || row.dueDate >= homeCreditSchedule[index - 1].dueDate),
  'rows stay in ascending date order',
)
assert(homeCreditSchedule[0].installmentNumber === 1 && homeCreditSchedule[9].installmentNumber === 10, 'each row carries its installment number')
assert(homeCreditSchedule.every(row => row.amount === 1500 && row.recurringName === 'Home Credit'), 'each row carries the bill name and expected amount')
assert(homeCreditSchedule.every(row => !row.projected), 'a fixed-term plan uses its stored dates, not projected ones')
assert(scheduledPaymentLabel(homeCreditSchedule[0]) === 'Due today', 'today is labelled "Due today"')
assert(scheduledPaymentLabel(homeCreditSchedule[1]) === 'Due in 30 days', 'an upcoming row is labelled with the days until it is due')

// ── A second bill merges into the same ordering ─────────────────────────────
const condoDues = bill({
  id: 'condo-dues',
  name: 'Condo dues',
  expectedAmount: 2500,
  maxOccurrences: 6,
  startDate: '2026-09-05',
  installments: buildInstallments('2026-09-05', 6),
})
const merged = getScheduledPayments(dataWith(homeCredit, condoDues), asOf)
assert(merged.length === 16, `both bills list every payment as its own row (got ${merged.length})`)
assert(merged[0].recurringName === 'Condo dues' && merged[0].dueDate === '2026-09-05', 'the newly added bill takes the top spot when its date is nearer')
assert(merged[0].status === 'overdue' && merged[0].daysFromReference === -10, 'a past unpaid date is overdue with the right day count')
assert(scheduledPaymentLabel(merged[0]) === '10 days overdue', 'an overdue row is labelled with how late it is')
assert(merged[1].recurringName === 'Home Credit' && merged[1].dueDate === '2026-09-15', 'the other bill slots in behind it by date')
assert(merged[2].dueDate === '2026-10-05' && merged[3].dueDate === '2026-10-15', 'rows of different bills interleave by date, not by bill')
assert(
  merged.slice(0, 12).every((row, index) => index === 0 || row.dueDate >= merged[index - 1].dueDate),
  'the merged unpaid block stays sorted nearest first',
)

// ── Paid rows fall below the unpaid ones ────────────────────────────────────
const partlyPaid: PFData = {
  ...dataWith(condoDues),
  recurring: [{
    ...condoDues,
    runCount: 2,
    installments: condoDues.installments?.map(i => (i.number <= 2 ? { ...i, paid: true } : i)),
  }],
  expenses: [
    { id: 'exp-1', date: '2026-09-05', dueDate: '2026-09-05', name: 'Condo dues', categoryId: 'category-loans', amount: 2500, accountId: 'account-1', paid: true, note: 'Recurring payment', recurringId: 'condo-dues', period: '2026-09', installmentNumber: 1 },
    { id: 'exp-2', date: '2026-10-04', dueDate: '2026-10-05', name: 'Condo dues', categoryId: 'category-loans', amount: 2500, accountId: 'account-1', paid: true, note: 'Recurring payment', recurringId: 'condo-dues', period: '2026-10', installmentNumber: 2 },
  ],
}
const withPaid = getScheduledPayments(partlyPaid, '2026-10-20')
assert(withPaid.length === 6, 'paid payments stay visible as rows in the schedule')
assert(withPaid[0].dueDate === '2026-09-05' && withPaid[0].paid, 'a settled payment keeps its place in the calendar')
assert(withPaid[1].dueDate === '2026-10-05' && withPaid[1].paidOn === '2026-10-04', 'a paid row keeps the date it was actually paid on')
assert(scheduledPaymentLabel(withPaid[1]) === `Paid ${formatShortDate('2026-10-04')}`, 'a paid row is labelled with the day it was paid')
assert(withPaid[2].dueDate === '2026-11-05' && !withPaid[2].paid, 'the next unpaid payment follows the settled ones, still in date order')
assert(
  withPaid.every((row, index) => index === 0 || row.dueDate >= withPaid[index - 1].dueDate),
  'the whole schedule — paid and unpaid — is arranged by date of payment',
)
assert(withPaid.every(row => row.status !== 'overdue' || !row.paid), 'no paid row is reported overdue')

// ── Open-ended bills project their dates ────────────────────────────────────
const internet = bill({ id: 'internet', name: 'Internet', expectedAmount: 1200, dueDay: 5, maxOccurrences: null, startDate: '2026-08-01' })
const projected = getScheduledPayments(dataWith(internet), asOf)
assert(projected.length === 8 && projected.every(row => row.projected), `an open-ended bill has projected rows instead of stored ones (got ${projected.length})`)
assert(projected[0].dueDate === '2026-08-05' && projected[0].installmentNumber === 1, 'projection starts at the bill\'s first month and numbers it 1')
assert(projected[1].dueDate === '2026-09-05' && projected[1].status === 'overdue', 'the projected row for the month just past is the overdue one')
assert(projected[2].dueDate === '2026-10-05' && projected[2].status === 'upcoming', 'projected rows continue month by month')
assert(projected.every(row => row.dueDate.slice(8, 10) === '05'), 'projected rows land on the configured due day')
assert(projected.some(row => row.dueDate > asOf), 'projected rows reach into the future')
assert(projected.every(row => row.dueDate <= addMonthsClamped(asOf, 6)), 'projection stops at the six-month horizon')

// ── Switched-off and completed bills keep paid history only ─────────────────
const switchedOff: PFData = {
  ...dataWith(homeCredit),
  recurring: [{
    ...homeCredit,
    active: false,
    runCount: 3,
    installments: homeCredit.installments?.map(i => (i.number <= 3 ? { ...i, paid: true } : i)),
  }],
}
const offRows = getScheduledPayments(switchedOff, asOf)
assert(offRows.length === 3 && offRows.every(row => row.paid), 'a switched-off bill lists only the payments already made')

const completed: PFData = {
  ...dataWith(homeCredit),
  recurring: [{
    ...homeCredit,
    active: false,
    runCount: 10,
    installments: homeCredit.installments?.map(i => ({ ...i, paid: true })),
  }],
}
const completedRows = getScheduledPayments(completed, asOf)
assert(completedRows.length === 10, 'a finished plan still shows all ten of its rows')
assert(completedRows.every(row => row.paid) && completedRows[0].dueDate === '2026-09-15', 'finished rows are all paid, first payment first')

// ── Legacy drifted schedules are repaired on load ───────────────────────────
const legacy = normalizePFData({
  ...emptyPFData(),
  recurring: [{
    id: 'legacy-loan',
    name: 'Legacy loan',
    categoryId: 'category-loans',
    accountId: 'account-1',
    expectedAmount: 900,
    dueDay: null,
    active: true,
    maxOccurrences: 3,
    runCount: 0,
    startDate: '2026-01-31',
    // What an older client stored by stepping months with Date#setMonth.
    installments: [
      { id: 'i-1', dueDate: '2026-01-31', number: 1, paid: true },
      { id: 'i-2', dueDate: '2026-03-03', number: 2, paid: false },
      { id: 'i-3', dueDate: '2026-04-03', number: 3, paid: false },
    ],
  }],
})
assert(
  legacy.recurring[0].installments?.map(i => i.dueDate).join(',') === '2026-01-31,2026-02-28,2026-03-31',
  'loading repairs a plan whose dates overflowed into the wrong months',
)
assert(
  legacy.recurring[0].installments?.map(i => `${i.id}:${i.paid}`).join(',') === 'i-1:true,i-2:false,i-3:false',
  'repairing dates keeps installment ids and paid flags',
)
const handAdjusted = normalizePFData({
  ...emptyPFData(),
  recurring: [{
    ...legacy.recurring[0],
    installments: [
      { id: 'i-1', dueDate: '2026-01-31', number: 1, paid: false },
      { id: 'i-2', dueDate: '2026-02-20', number: 2, paid: false },
      { id: 'i-3', dueDate: '2026-03-31', number: 3, paid: false },
    ],
  }],
})
assert(handAdjusted.recurring[0].installments?.[1].dueDate === '2026-02-28', 'a plan-shaped schedule is re-derived from its start date (payment dates are never edited by hand)')
const notAPlan = normalizePFData({
  ...emptyPFData(),
  recurring: [{
    ...legacy.recurring[0],
    maxOccurrences: 3,
    installments: [
      { id: 'i-1', dueDate: '2026-01-31', number: 1, paid: false },
      { id: 'i-2', dueDate: '2026-03-03', number: 5, paid: false },
    ],
  }],
})
assert(notAPlan.recurring[0].installments?.[1].dueDate === '2026-03-03', 'a schedule that no longer matches its plan is left untouched')

// ── Timezone safety ─────────────────────────────────────────────────────────
assert(
  buildInstallments('2026-09-15', 3).every((i, index) => i.dueDate === ['2026-09-15', '2026-10-15', '2026-11-15'][index]),
  `due dates are the days asked for in ${Intl.DateTimeFormat().resolvedOptions().timeZone} (no one-day shift)`,
)

console.log('\nDone.')
