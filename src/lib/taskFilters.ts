import type { Task, TaskPriority, TaskStatus } from '@/lib/types'
import { TASK_STATUSES } from '@/lib/types'
import { daysUntilDue, isOverdueDate } from '@/lib/utils'

/**
 * A due-date window. ISO date strings (yyyy-mm-dd), both ends inclusive.
 * `null` on an end means open — "This week" has no lower bound so overdue
 * work never disappears from the view.
 */
export interface DueRange {
  from: string | null
  to: string | null
}

/**
 * The board's filter state, shared by the Dashboard (whose stat cards,
 * focus rows and workload rows all point into it) and the TaskBoard itself
 * (whose own dropdowns and search box write into it). One source of truth
 * keeps every number on the dashboard describing exactly the rows the board
 * would show.
 */
export interface BoardFilters {
  /** 'all' or one worker id (admin only). */
  worker: string
  /** 'all' or one kanban stage. */
  stage: 'all' | TaskStatus
  /** 'all' or one client id. */
  client: string
  /** 'all' or one priority. */
  priority: 'all' | TaskPriority
  /** Only open tasks past their due date (behind the "Overdue" stat card). */
  overdueOnly: boolean
  /** Only open tasks due today (behind the "Due today" stat card). */
  dueTodayOnly: boolean
  /** Due-date window (this week / this month / custom). Null = all dates. */
  dueRange: DueRange | null
  /** Title-only search. */
  search: string
}

export const DEFAULT_BOARD_FILTERS: BoardFilters = {
  worker: 'all',
  stage: 'all',
  client: 'all',
  priority: 'all',
  overdueOnly: false,
  dueTodayOnly: false,
  dueRange: null,
  search: '',
}

export function isAnyBoardFilterActive(f: BoardFilters): boolean {
  return (
    f.worker !== 'all' ||
    f.stage !== 'all' ||
    f.client !== 'all' ||
    f.priority !== 'all' ||
    f.overdueOnly ||
    f.dueTodayOnly ||
    f.dueRange !== null ||
    f.search.trim().length > 0
  )
}

/** Today (or today ± N days) as a local ISO date string. */
export function dateOffsetISO(days = 0): string {
  const d = new Date()
  d.setHours(12, 0, 0, 0) // noon — dodges DST day-edges
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Apply the role scope (null = see everyone, otherwise only that worker's
    tasks) plus every board filter. Archived rows stay in the result — the
    caller splits active vs archived. */
export function applyTaskFilters(tasks: Task[], ownWorkerId: string | null, f: BoardFilters): Task[] {
  let rows = ownWorkerId ? tasks.filter((t) => t.worker_id === ownWorkerId) : tasks
  if (f.worker !== 'all') rows = rows.filter((t) => t.worker_id === f.worker)
  if (f.client !== 'all') rows = rows.filter((t) => t.client_id === f.client)
  if (f.priority !== 'all') rows = rows.filter((t) => t.priority === f.priority)
  if (f.overdueOnly) rows = rows.filter((t) => t.status !== 'completed' && isOverdueDate(t.due_date))
  if (f.dueTodayOnly) rows = rows.filter((t) => t.status !== 'completed' && daysUntilDue(t.due_date) === 0)
  if (f.dueRange) {
    const { from, to } = f.dueRange
    // ISO date strings compare lexicographically, so plain string ops work.
    rows = rows.filter((t) => t.due_date && (from === null || t.due_date >= from) && (to === null || t.due_date <= to))
  }
  const q = f.search.trim().toLocaleLowerCase()
  if (q) rows = rows.filter((t) => t.title.toLocaleLowerCase().includes(q))
  return rows
}

// ---- URL params ----------------------------------------------------------------
// The dashboard's stat cards, focus rows and workload rows navigate to the
// Tasks page with the matching filter pre-applied. Round-tripping through the
// query string (instead of global state) keeps each page simple and makes
// filtered boards shareable/bookmarkable.

export function boardFiltersToParams(f: BoardFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (f.worker !== 'all') p.set('worker', f.worker)
  if (f.stage !== 'all') p.set('stage', f.stage)
  if (f.client !== 'all') p.set('client', f.client)
  if (f.priority !== 'all') p.set('priority', f.priority)
  if (f.overdueOnly) p.set('overdue', '1')
  if (f.dueTodayOnly) p.set('dueToday', '1')
  if (f.dueRange?.from) p.set('from', f.dueRange.from)
  if (f.dueRange?.to) p.set('to', f.dueRange.to)
  if (f.search.trim()) p.set('q', f.search.trim())
  return p
}

export function boardFiltersFromParams(p: URLSearchParams): BoardFilters {
  const f: BoardFilters = { ...DEFAULT_BOARD_FILTERS }
  const worker = p.get('worker')
  if (worker) f.worker = worker
  const stage = p.get('stage')
  if (stage && (TASK_STATUSES as string[]).includes(stage)) f.stage = stage as TaskStatus
  const client = p.get('client')
  if (client) f.client = client
  const priority = p.get('priority')
  if (priority && (['high', 'medium', 'low'] as string[]).includes(priority)) f.priority = priority as TaskPriority
  if (p.get('overdue') === '1') f.overdueOnly = true
  if (p.get('dueToday') === '1') f.dueTodayOnly = true
  const from = p.get('from')
  const to = p.get('to')
  if (from || to) f.dueRange = { from: from || null, to: to || null }
  const q = p.get('q')
  if (q) f.search = q
  return f
}
