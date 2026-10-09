/**
 * Verification of the Tasks board by month (pure functions, no UI):
 *  - a task belongs to the month it is due (the original deadline wins, as KPI
 *    does); open work is carried over onto every later month's board until it
 *    is finished; a finished task belongs to the month it was finished in
 *  - the Recurring shelf shows in every month; archived cards stay in the archive
 *  - "this month" is resolved when the board renders, so it moves on by itself
 *  - the month's figures start from zero when a new month begins
 *  - the history can be narrowed to one month and still lists everything
 *  - the month and filter links round-trip; the views write nothing
 *  - KPI still counts a task in the month it was finished
 *
 * Run: npx tsx scripts/verify-task-months-local.ts
 */
import type { MonthlyGoal, Task, Worker } from '../src/lib/types'
import {
  BOARD_COMPLETED_LIMIT,
  DEFAULT_COMPLETED_HISTORY_FILTERS,
  byCompletionNewestFirst,
  completedAtMs,
  completedHistory,
  completionDay,
  completionMonth,
  isCompletedHistoryFilterActive,
} from '../src/lib/completedTasks'
import {
  boardMonthTotals,
  isFinishedTask,
  isShelfTask,
  taskMonthKey,
  taskMonthOptions,
  taskOnMonthBoard,
} from '../src/lib/taskMonths'
import {
  isMonthKey,
  monthKeyOfISO,
  monthLastDay,
  monthOptions,
  monthsDescending,
  resolveMonthScope,
} from '../src/lib/monthScope'
import {
  applyTaskFilters,
  boardFiltersFromParams,
  boardFiltersToParams,
  DEFAULT_BOARD_FILTERS,
  isAnyBoardFilterActive,
} from '../src/lib/taskFilters'
import { computeEmployeeKpi } from '../src/lib/kpi'

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

const TODAY = '2026-10-09'
const NOW = new Date(2026, 9, 9, 12, 0)
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString()

let seq = 0
/** A task with defaults; the caller sets what the rule under test needs. */
function task(over: Partial<Task> & { id?: string }): Task {
  seq += 1
  const created = over.created_at ?? '2026-06-01T09:00:00.000Z'
  return {
    id: `t${seq}`,
    worker_id: 'w1',
    client_id: null,
    title: `Task ${seq}`,
    status: 'todo',
    priority: 'medium',
    start_date: '2026-06-01',
    due_date: '2026-10-20',
    original_due_date: null,
    position: 0,
    completed_at: null,
    archived_at: null,
    created_at: created,
    updated_at: created,
    ...over,
  } as unknown as Task
}

/** A finished task, finished on `day` (local 'YYYY-MM-DD' at noon). */
function finishedOn(id: string, day: string, over: Partial<Task> = {}): Task {
  return task({ id, status: 'completed', completed_at: new Date(`${day}T12:00:00`).toISOString(), ...over })
}

const snapshot = (rows: Task[]) => JSON.stringify(rows)
const idsOf = (rows: Task[]) => rows.map((t) => t.id)

// ---- 1. Months and scopes ---------------------------------------------------
console.log('\n--- Months and scopes ---')
assert(monthKeyOfISO('2026-10-09') === '2026-10', 'an ISO date gives its month')
assert(monthKeyOfISO('') === '' && monthKeyOfISO(null) === '', 'no date gives no month')
assert(isMonthKey('2026-10') && !isMonthKey('2026-13') && !isMonthKey('2026-9'), 'only YYYY-MM with a real month is a month key')
assert(resolveMonthScope('current', TODAY) === '2026-10', '"this month" resolves to the month of today')
assert(resolveMonthScope('current', '2026-11-01') === '2026-11', '"this month" moves on when the next month begins')
assert(resolveMonthScope('all', TODAY) === 'all', '"all months" stays unlimited')
assert(resolveMonthScope('2026-08', TODAY) === '2026-08', 'a picked month stays where it was picked')
assert(monthLastDay('2026-02') === '2026-02-28' && monthLastDay('2028-02') === '2028-02-29', 'the last day of February follows the leap year')
assert(monthLastDay('2026-10') === '2026-10-31', 'the last day of October is the 31st')
assert(
  JSON.stringify(monthsDescending('2026-08', '2026-10')) === JSON.stringify(['2026-10', '2026-09', '2026-08']),
  'months run newest first between two ends',
)
assert(
  JSON.stringify(monthOptions(['2026-07', '2026-12'], TODAY)) ===
    JSON.stringify(['2026-12', '2026-11', '2026-10', '2026-09', '2026-08', '2026-07']),
  'the picker offers every month from the earliest record through the latest, this month included',
)
assert(JSON.stringify(monthOptions([], TODAY)) === JSON.stringify(['2026-10']), 'with no records the picker offers only this month')

// ---- 2. The link and the default ------------------------------------------
console.log('\n--- Filters and links ---')
assert(DEFAULT_BOARD_FILTERS.month === 'all', 'the dashboard and other callers default to all months')
assert(boardFiltersFromParams(new URLSearchParams()).month === 'current', 'a Tasks link with no month opens this month')
assert(boardFiltersFromParams(new URLSearchParams('month=all')).month === 'all', 'month=all opens every month')
assert(boardFiltersFromParams(new URLSearchParams('month=2026-08')).month === '2026-08', 'month=YYYY-MM opens that month')
assert(boardFiltersFromParams(new URLSearchParams('month=2026-99')).month === 'current', 'an unreadable month falls back to this month')
const currentParams = boardFiltersToParams({ ...DEFAULT_BOARD_FILTERS, month: 'current' })
assert(!currentParams.has('month'), 'this month is the default, so the link does not spell it out')
assert(boardFiltersToParams({ ...DEFAULT_BOARD_FILTERS, month: 'all' }).get('month') === 'all', 'all months is written to the link')
assert(
  boardFiltersFromParams(boardFiltersToParams({ ...DEFAULT_BOARD_FILTERS, month: '2026-08', worker: 'w2' })).month === '2026-08',
  'a picked month survives a round trip through the link',
)
assert(!isAnyBoardFilterActive({ ...DEFAULT_BOARD_FILTERS, month: '2026-08' }), 'the month is a scope, not a filter that hides the board')

// ---- 3. Which month a task is in ------------------------------------------
console.log('\n--- A task\'s month ---')
assert(taskMonthKey(task({ due_date: '2026-08-28' })) === '2026-08', 'a task belongs to the month it is due')
assert(
  taskMonthKey(task({ due_date: '2026-09-03', original_due_date: '2026-08-15' })) === '2026-08',
  'a pushed deadline keeps the task in the month it was first due (as KPI does)',
)
assert(taskMonthKey(task({ due_date: null, start_date: '2026-07-02' })) === '2026-07', 'an undated legacy task falls back to its start')

// ---- 4. What the board shows for a month ----------------------------------
console.log('\n--- The board for a month ---')
const openOct = task({ id: 'open-oct', status: 'todo', due_date: '2026-10-20' })
const openAug = task({ id: 'open-aug', status: 'in_progress', due_date: '2026-08-14' })
const openNov = task({ id: 'open-nov', status: 'todo', due_date: '2026-11-03' })
const doneOctFromSep = finishedOn('done-oct', '2026-10-03', { due_date: '2026-09-28' })
const doneSep = finishedOn('done-sep', '2026-09-05', { due_date: '2026-09-02' })
const doneLateNov = finishedOn('done-nov', '2026-11-02', { due_date: '2026-10-08' })
const shelf = task({ id: 'shelf', status: 'recurring', due_date: '2026-05-01', repeats: 'monthly' })
const archivedSep = finishedOn('arch-sep', '2026-09-04', { archived_at: ago(30), due_date: '2026-09-01' })
const everything = [openOct, openAug, openNov, doneOctFromSep, doneSep, doneLateNov, shelf, archivedSep]

assert(isShelfTask(shelf) && !isFinishedTask(openOct), 'the shelf and finished cards are told apart from open work')
assert(taskOnMonthBoard(openOct, '2026-10') && !taskOnMonthBoard(openOct, '2026-09'), 'an open task due in October is on October, not September')
assert(taskOnMonthBoard(openOct, '2026-11'), 'an open task due in October is carried onto November')
assert(taskOnMonthBoard(openAug, '2026-10'), 'an open task from August is carried onto October')
assert(!taskOnMonthBoard(openNov, '2026-10'), 'an open task due in November is not on October yet')
assert(taskOnMonthBoard(doneOctFromSep, '2026-10') && !taskOnMonthBoard(doneOctFromSep, '2026-09'), 'a task finished in October shows in October, though it was due in September')
assert(taskOnMonthBoard(doneSep, '2026-09') && !taskOnMonthBoard(doneSep, '2026-10'), 'a task finished in September shows in September only')
assert(!taskOnMonthBoard(doneLateNov, '2026-10'), 'a task finished in November is not on October')
assert(taskOnMonthBoard(shelf, '2026-08') && taskOnMonthBoard(shelf, '2026-10'), 'the Recurring shelf shows in every month')
assert(everything.every((t) => taskOnMonthBoard(t, 'all')), 'all months keeps every card')

// applyTaskFilters keeps archived rows for the archive tab; the board takes them out.
const onOct = applyTaskFilters(everything, null, { ...DEFAULT_BOARD_FILTERS, month: 'current' }, TODAY)
const onOctBoard = onOct.filter((t) => !t.archived_at)
assert(
  JSON.stringify([...idsOf(onOctBoard)].sort()) === JSON.stringify(['done-oct', 'open-aug', 'open-oct', 'shelf'].sort()),
  'the October board holds October work, carried-over open work, October completions and the shelf',
)
assert(onOct.some((t) => t.id === 'arch-sep') && !onOctBoard.some((t) => t.id === 'arch-sep'), 'an archived card is kept for the archive tab, never on the board')
const archiveView = applyTaskFilters(everything, null, { ...DEFAULT_BOARD_FILTERS, month: '2026-10' }, TODAY)
assert(archiveView.some((t) => t.id === 'arch-sep'), 'the month never hides an archived card from the archive tab')
const rolledOver = applyTaskFilters(everything, null, { ...DEFAULT_BOARD_FILTERS, month: 'current' }, '2026-11-01')
assert(
  rolledOver.some((t) => t.id === 'open-nov') && !rolledOver.some((t) => t.id === 'done-sep'),
  'on 1 November the "this month" board is November: last month\'s finished work is off it, November\'s work is on',
)
const ownOnly = applyTaskFilters(everything, 'w2', { ...DEFAULT_BOARD_FILTERS, month: 'current' }, TODAY)
assert(ownOnly.length === 0, 'a worker only sees their own cards in the month (scope applies first)')

// ---- 5. The month's figures start from zero -------------------------------
console.log('\n--- Monthly totals ---')
const oct = boardMonthTotals(everything, '2026-10')
assert(oct.due === 2 && oct.dueDone === 1, 'October: two cards are planned for October; one of them was finished (later, in November)')
assert(oct.finished === 1, 'October: one card was finished in October (even though it was due in September)')
assert(oct.carried === 1, 'October: one open card from August is carried over')
const nov = boardMonthTotals(everything, '2026-11')
assert(nov.due === 1 && nov.finished === 1, 'November: its own planned and finished cards are counted')
assert(nov.carried === 2, 'November: the open cards from October and August are carried over')
const fresh = boardMonthTotals(everything, '2026-12')
assert(fresh.due === 0 && fresh.finished === 0, 'a new month starts at zero: nothing planned or finished yet')
assert(fresh.carried === 3, 'a new month still shows what is open from before it')
assert(boardMonthTotals(everything, '2026-09').finished === 1, 'September counts its own completion (the archived one is left out)')

// ---- 6. The month chooser -------------------------------------------------
console.log('\n--- Month chooser ---')
const choices = taskMonthOptions(everything, TODAY)
assert(choices[0] === '2026-11' && choices.includes('2026-10') && choices.includes('2026-08'), 'the chooser lists months with work, newest first')
assert(choices.includes('2026-09') && !choices.some((m) => m > '2026-11'), 'it covers every month in between, and nothing beyond the latest record')

// ---- 7. The history by month ----------------------------------------------
console.log('\n--- History by month ---')
assert(completionMonth(finishedOn('x', '2026-10-31')) === '2026-10', 'a task finished on the last day of October counts for October')
const lateOct = task({ id: 'late-oct', status: 'completed', completed_at: new Date(2026, 9, 31, 23, 30).toISOString() })
const earlyNov = task({ id: 'early-nov', status: 'completed', completed_at: new Date(2026, 10, 1, 0, 10).toISOString() })
assert(completionMonth(lateOct) === '2026-10' && completionMonth(earlyNov) === '2026-11', 'the month turns over at local midnight')
const historyAll = completedHistory(everything, DEFAULT_COMPLETED_HISTORY_FILTERS)
assert(historyAll.some((t) => t.id === 'done-sep') && historyAll.some((t) => t.id === 'done-nov'), 'the history without a month lists every month')
const historyOct = idsOf(completedHistory(everything, { ...DEFAULT_COMPLETED_HISTORY_FILTERS, month: '2026-10' }))
assert(JSON.stringify(historyOct) === JSON.stringify(['done-oct']), 'the history narrowed to October lists only what was finished in October')
const historySepArchived = idsOf(completedHistory(everything, { ...DEFAULT_COMPLETED_HISTORY_FILTERS, month: '2026-09' }))
assert(historySepArchived.includes('arch-sep') && historySepArchived.includes('done-sep'), 'the history keeps archived cards, marked by the dialog, for the month they were finished')
assert(isCompletedHistoryFilterActive({ ...DEFAULT_COMPLETED_HISTORY_FILTERS, month: '2026-10' }), 'a month chosen in the history counts as a filter')
assert(!isCompletedHistoryFilterActive(DEFAULT_COMPLETED_HISTORY_FILTERS), 'no month chosen by default')

// ---- 8. The newest five, by completion -------------------------------------
console.log('\n--- The newest five in a month ---')
const octCompletions = [1, 2, 3, 4, 5, 6, 7].map((day) => finishedOn(`oc${day}`, `2026-10-0${day}`))
const topFive = [...octCompletions].sort(byCompletionNewestFirst).slice(0, BOARD_COMPLETED_LIMIT)
assert(JSON.stringify(idsOf(topFive)) === JSON.stringify(['oc7', 'oc6', 'oc5', 'oc4', 'oc3']), 'the Completed column shows the five most recent of the month')
assert(byCompletionNewestFirst(octCompletions[0], octCompletions[1]) > 0, 'an earlier finish sorts after a later one')
assert(completedAtMs(octCompletions[2]) > completedAtMs(octCompletions[1]), 'the completion stamp is read as a time')
assert(completionDay(octCompletions[2]) === '2026-10-03', 'the day a task was finished is its local day')

// ---- 9. The views write nothing -------------------------------------------
console.log('\n--- Nothing is written ---')
const before = snapshot(everything)
applyTaskFilters(everything, null, { ...DEFAULT_BOARD_FILTERS, month: 'current' }, TODAY)
boardMonthTotals(everything, '2026-10')
taskMonthOptions(everything, TODAY)
completedHistory(everything, { ...DEFAULT_COMPLETED_HISTORY_FILTERS, month: '2026-09' })
assert(snapshot(everything) === before, 'the month views leave every task row exactly as it was')
assert(doneSep.archived_at === null && doneSep.status === 'completed', 'a September finish is still completed and not archived')

// ---- 10. KPI keeps the records --------------------------------------------
console.log('\n--- KPI keeps the records ---')
const worker = { id: 'w1', name: 'Ana', role: 'worker', color: null } as unknown as Worker
const augustTask = finishedOn('kpi-aug', '2026-08-25', { due_date: '2026-08-28' })
const inAugust = computeEmployeeKpi({ worker, tasks: [augustTask], month: '2026-08', goal: null as MonthlyGoal | null, now: NOW })
assert(inAugust.completedCount === 1, 'a task finished in August still counts in August for KPI')
const inOctober = computeEmployeeKpi({ worker, tasks: [augustTask], month: '2026-10', goal: null as MonthlyGoal | null, now: NOW })
assert(inOctober.completedCount === 0, 'it does not count in October, the month it was not finished')

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll task-month checks passed.')
process.exitCode = failures ? 1 : 0
