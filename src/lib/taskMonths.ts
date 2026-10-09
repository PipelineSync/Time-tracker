/**
 * Which month a task belongs to, and what the Tasks board shows for a month.
 *
 * A task belongs to the month it is due. That is the same rule Team KPI uses
 * (the original deadline wins, so pushing a date never moves a task to another
 * month). Open work is carried over: an open task stays on the board of every
 * later month until it is finished. A finished task belongs to the month it was
 * finished in. The Recurring shelf holds templates rather than dated work, so
 * it shows in every month.
 *
 * Pure functions only.
 */
import type { Task } from './types'
import { normalizeTaskStage } from './types'
import { effectiveDueDate } from './kpi'
import { completionMonth } from './completedTasks'
import { monthKeyOfISO, monthOptions } from './monthScope'

/** The month a task is planned in: its effective due date. Undated legacy rows fall back to their start. */
export function taskMonthKey(task: Task): string {
  return monthKeyOfISO(effectiveDueDate(task)) || monthKeyOfISO(task.start_date) || monthKeyOfISO(task.created_at)
}

/** A card on the Recurring shelf: a template, not dated work. */
export function isShelfTask(task: Task): boolean {
  return normalizeTaskStage(task.status) === 'recurring'
}

/** A card that has been finished (archived cards included). */
export function isFinishedTask(task: Task): boolean {
  return normalizeTaskStage(task.status) === 'completed'
}

/**
 * Whether a task belongs on the board for `month` ('YYYY-MM', or 'all').
 * Archived cards are not decided here; the board keeps them out already.
 */
export function taskOnMonthBoard(task: Task, month: string): boolean {
  if (month === 'all') return true
  if (isShelfTask(task)) return true
  if (isFinishedTask(task)) return completionMonth(task) === month
  return taskMonthKey(task) <= month
}

export interface BoardMonthTotals {
  /** Open or finished tasks planned in the month. */
  due: number
  /** Of those, how many are finished. */
  dueDone: number
  /** Tasks finished in the month, whatever month they were planned for. */
  finished: number
  /** Open tasks planned in an earlier month and still open. */
  carried: number
}

/**
 * The figures above the board for one month. Counts cover what the board can
 * show, so archived cards and the Recurring shelf are left out.
 */
export function boardMonthTotals(tasks: Task[], month: string): BoardMonthTotals {
  const totals: BoardMonthTotals = { due: 0, dueDone: 0, finished: 0, carried: 0 }
  for (const task of tasks) {
    if (task.archived_at || isShelfTask(task)) continue
    const finished = isFinishedTask(task)
    if (finished && completionMonth(task) === month) totals.finished += 1
    const planned = taskMonthKey(task)
    if (planned === month) {
      totals.due += 1
      if (finished) totals.dueDone += 1
    } else if (!finished && planned && planned < month) {
      totals.carried += 1
    }
  }
  return totals
}

/** The months the month picker offers for a set of tasks (planned or finished). */
export function taskMonthOptions(tasks: Task[], today: string): string[] {
  const months = new Set<string>()
  for (const task of tasks) {
    // A template is not dated work, so its anchor date does not put a month on the list.
    if (isShelfTask(task)) continue
    const planned = taskMonthKey(task)
    if (planned) months.add(planned)
    if (isFinishedTask(task)) {
      const done = completionMonth(task)
      if (done) months.add(done)
    }
  }
  return monthOptions(months, today)
}
