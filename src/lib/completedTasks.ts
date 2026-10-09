/**
 * The Completed column of the task board, and the full completed history.
 *
 * The board is organised by month: a finished task shows on the board of the
 * month it was finished in, and the Completed column shows the newest few of
 * those. Older ones are not moved, archived or changed: they stay in the task
 * records, where KPI and the reports read them, and they are reached through
 * the history, which can be narrowed to any month. Everything here is a view
 * over the stored tasks, so no status, date or archive flag is ever written.
 *
 * Pure functions only, so the rules can be checked without the UI.
 */
import type { Task } from './types'
import { normalizeTaskStage } from './types'

/** How many completed cards the board shows at once, newest first. */
export const BOARD_COMPLETED_LIMIT = 5

/** When a completed task was finished, in epoch ms. A task with no usable stamp counts as the oldest. */
export function completedAtMs(task: Task): number {
  const stamp = Date.parse(task.completed_at ?? task.updated_at)
  return Number.isNaN(stamp) ? 0 : stamp
}

/** Newest completion first; equal times fall back to the newest creation. */
export function byCompletionNewestFirst(a: Task, b: Task): number {
  return completedAtMs(b) - completedAtMs(a) || b.created_at.localeCompare(a.created_at)
}

/** The local calendar day a task was finished, 'YYYY-MM-DD'. */
export function completionDay(task: Task): string {
  const d = new Date(completedAtMs(task))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The 'YYYY-MM' month a task was finished in (local time). */
export function completionMonth(task: Task): string {
  return completionDay(task).slice(0, 7)
}

/** The filters on the full history. Dates are local 'YYYY-MM-DD', both ends inclusive. */
export interface CompletedHistoryFilters {
  /** 'all' or one worker id. */
  worker: string
  /** 'all', 'none' (tasks with no client) or one client id. */
  client: string
  /** 'all', or one 'YYYY-MM' month the task was finished in. */
  month: 'all' | string
  /** Null means open on that side. */
  from: string | null
  to: string | null
}

export const DEFAULT_COMPLETED_HISTORY_FILTERS: CompletedHistoryFilters = {
  worker: 'all',
  client: 'all',
  month: 'all',
  from: null,
  to: null,
}

export function isCompletedHistoryFilterActive(f: CompletedHistoryFilters): boolean {
  return f.worker !== 'all' || f.client !== 'all' || f.month !== 'all' || f.from !== null || f.to !== null
}

/**
 * The completed history, newest first, narrowed by the filters. Archived tasks
 * are included (the caller marks them), so the history is complete.
 */
export function completedHistory(tasks: Task[], f: CompletedHistoryFilters): Task[] {
  return tasks
    .filter((t) => normalizeTaskStage(t.status) === 'completed')
    .filter((t) => f.worker === 'all' || t.worker_id === f.worker)
    .filter((t) => f.client === 'all' || (f.client === 'none' ? !t.client_id : t.client_id === f.client))
    .filter((t) => f.month === 'all' || completionMonth(t) === f.month)
    .filter((t) => {
      const day = completionDay(t)
      return (f.from === null || day >= f.from) && (f.to === null || day <= f.to)
    })
    .sort(byCompletionNewestFirst)
}
