/**
 * Team KPI engine — every number the Team KPI dashboard shows, computed from
 * the same task rows the board already holds. Nothing here touches the
 * network or React: pure functions so the verify script (and any click-through
 * drill-down) can trace each figure back to its source tasks.
 *
 * Formula (shared targets, §8):
 *   KPI = 30% On-Time + 30% QA + 25% Monthly Goal + 15% Rework Performance
 * Components with no data in the month are excluded and the remaining weights
 * renormalised — an empty month shows "—", never a fake 0.
 *
 * Rules honoured here:
 *  - Legacy tasks (no due date) are excluded from on-time math.
 *  - On-time compares against `original_due_date ?? due_date`, so pushing a
 *    deadline the task already missed cannot rewrite history.
 *  - Waiting/client-caused delays never lower an employee's score.
 *  - Workload = open estimated hours ÷ available work hours, schedule-aware
 *    (each employee's own workdays & weekly capacity).
 *  - Rework only counts against the employee when the reason is theirs
 *    (`isEmployeeCausedRework`).
 */
import type {
  BonusDecision,
  MonthlyGoal,
  QaScore,
  Task,
  TaskStatus,
  Worker,
} from './types'
import { isEmployeeCausedRework, normalizeTaskStage, TASK_STATUSES } from './types'
import { isOverdueDate } from './utils'

// ---- Month / date helpers ---------------------------------------------------

/** 'YYYY-MM' for the current month (local time). */
export function currentMonthKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 'YYYY-MM' shifted by `months` (negative = past). */
export function shiftMonthKey(month: string, months: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, (m || 1) - 1 + months, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** The last `n` months ending at `month`, oldest first (for the trend chart). */
export function lastNMonths(month: string, n: number): string[] {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) out.push(shiftMonthKey(month, -i))
  return out
}

/** 'Sep 2026' style label for a month key. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  if (!y || !m) return month
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

/** Short 'Sep' label for chart axes. */
export function monthShortLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  if (!y || !m) return month
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' })
}

/** Local 'YYYY-MM-DD' for a date. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Inclusive [from, to] date bounds of a month key as local date strings. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const start = new Date(y, (m || 1) - 1, 1)
  const end = new Date(y, (m || 1), 0)
  return { from: isoDate(start), to: isoDate(end) }
}

/** Does an ISO instant fall inside the month (local time)? */
export function inMonth(iso: string | null | undefined, month: string): boolean {
  if (!iso) return false
  const { from, to } = monthRange(month)
  const day = iso.slice(0, 10)
  return day >= from && day <= to
}

/** Midnight local of an ISO date string (date or instant). */
function parseDay(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00`)
}

// ---- Schedule-aware workdays ------------------------------------------------

/** Is this calendar day one of the worker's workdays? */
export function isWorkday(d: Date, workdays: number[]): boolean {
  const days = workdays.length > 0 ? workdays : [1, 2, 3, 4, 5]
  return days.includes(d.getDay())
}

/** Every workday date (local 'YYYY-MM-DD') between two dates, inclusive. */
export function workdaysBetween(from: Date, to: Date, workdays: number[]): Date[] {
  const out: Date[] = []
  const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate())
  // Hard stop: a pathological schedule can't loop forever.
  let guard = 0
  while (cur <= end && guard++ < 4000) {
    if (isWorkday(cur, workdays)) out.push(new Date(cur))
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

/** How many of `workdays` fall in the month key. */
export function workdaysInMonth(month: string, workdays: number[]): number {
  const { from, to } = monthRange(month)
  return workdaysBetween(parseDay(from), parseDay(to), workdays).length
}

/**
 * Business days aged between two instants on THIS employee's schedule —
 * counting only their own workdays (Monday is not a workday for Tue–Sat
 * staff). Whole workdays elapsed: the start day doesn't count, today does if
 * it's a workday and we've passed it. Negative when `end` is before `start`.
 */
export function businessDaysBetween(startISO: string, endISO: string, workdays: number[]): number {
  const from = parseDay(startISO)
  const to = parseDay(endISO)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0
  const sign = to.getTime() >= from.getTime() ? 1 : -1
  const [a, b] = sign > 0 ? [from, to] : [to, from]
  const days = workdaysBetween(a, b, workdays).length
  // Same calendar day → 0 whole days aged.
  if (isoDate(a) === isoDate(b)) return 0
  // Exclude the start day itself (aging begins the next day).
  const startCounted = isWorkday(a, workdays) ? 1 : 0
  return sign * Math.max(0, days - startCounted)
}

/** Calendar days between two ISO days (today=0), never negative. */
export function calendarDaysSince(iso: string | null | undefined, now = new Date()): number {
  if (!iso) return 0
  const ms = parseDay(isoDate(now)).getTime() - parseDay(iso).getTime()
  return Math.max(0, Math.round(ms / 86_400_000))
}

/**
 * Work hours still available to this worker in the month: workdays from
 * max(today, month start) through month end × their daily hours
 * (weekly capacity ÷ workdays per week). Past months count the whole month;
 * future months start at zero consumed.
 */
export function availableWorkHours(worker: Worker, month: string, now = new Date()): number {
  const workdays = worker.workdays?.length ? worker.workdays : [1, 2, 3, 4, 5]
  const perWeek = worker.weekly_capacity_hours > 0 ? worker.weekly_capacity_hours : 40
  const daysPerWeek = workdays.length
  const dailyHours = perWeek / daysPerWeek
  const { from, to } = monthRange(month)
  const monthStart = parseDay(from)
  const monthEnd = parseDay(to)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const cursor = today > monthStart ? today : monthStart
  if (cursor > monthEnd) {
    // Fully past month — full capacity (a snapshot for the trend chart).
    return workdaysInMonth(month, workdays) * dailyHours
  }
  return workdaysBetween(cursor, monthEnd, workdays).length * dailyHours
}

// ---- Task-level predicates --------------------------------------------------

/** Legacy rows created before due dates were mandatory — out of on-time KPI. */
export function isLegacyNoDue(task: Task): boolean {
  return !task.due_date
}

/** The deadline on-time math uses: the original (first missed) date wins. */
export function effectiveDueDate(task: Task): string | null {
  return task.original_due_date ?? task.due_date
}

/** Open = not completed (archive only hides completed work from the board). */
export function isOpen(task: Task): boolean {
  return normalizeTaskStage(task.status) !== 'completed'
}

/** A non-completed task past its (current) due date. */
export function isOverdueTask(task: Task): boolean {
  return isOpen(task) && isOverdueDate(task.due_date)
}

/**
 * Did this completed task land on time? Null when the rule doesn't apply
 * (legacy no due date) — those are excluded, never counted as late.
 */
export function wasOnTime(task: Task): boolean | null {
  if (normalizeTaskStage(task.status) !== 'completed') return null
  if (isLegacyNoDue(task)) return null
  const due = effectiveDueDate(task)
  if (!due) return null
  const done = (task.completed_at ?? '').slice(0, 10)
  if (!done) return false
  // Completed on or before the due day (due dates are end-of-day).
  return done <= due
}

/** Estimated hours on an open task (0 when unset). */
export function openEstimatedHours(task: Task): number {
  if (!isOpen(task)) return 0
  const h = Number(task.estimated_hours)
  return Number.isFinite(h) && h > 0 ? h : 0
}

/** Waiting / For Review aging in days on this employee's schedule. */
export function stageAgeDays(task: Task, now = new Date()): number {
  const stage = normalizeTaskStage(task.status)
  if (stage === 'waiting') return calendarDaysSince(task.waiting_since ?? task.updated_at, now)
  if (stage === 'for_review') return calendarDaysSince(task.submitted_for_review_at ?? task.updated_at, now)
  return 0
}

/** Same aging but in the employee's business days (attention rules §13). */
export function stageAgeBusinessDays(task: Task, workdays: number[], now = new Date()): number {
  const stage = normalizeTaskStage(task.status)
  const since = stage === 'waiting'
    ? (task.waiting_since ?? task.updated_at)
    : stage === 'for_review'
      ? (task.submitted_for_review_at ?? task.updated_at)
      : null
  if (!since) return 0
  return businessDaysBetween(since, now.toISOString(), workdays)
}

// ---- Compact card health badges --------------------------------------------

export interface TaskHealthBadge {
  label: string
  /** Tailwind tone classes for the badge. */
  tone: string
}

const TONE = {
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  info: 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  violet: 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  muted: 'border-border text-muted-foreground',
} as const

/** The compact health chips a card shows: Due Today / N Days Overdue / … */
export function taskHealthBadges(task: Task, workdays: number[], now = new Date()): TaskHealthBadge[] {
  const out: TaskHealthBadge[] = []
  const stage = normalizeTaskStage(task.status)
  if (stage === 'completed') return out

  if (!task.due_date) {
    out.push({ label: 'Legacy / No Due Date', tone: TONE.muted })
  } else if (isOverdueDate(task.due_date)) {
    const days = calendarDaysSince(task.due_date, now)
    out.push({
      label: days <= 0 ? 'Overdue' : days === 1 ? '1 Day Overdue' : `${days} Days Overdue`,
      tone: TONE.danger,
    })
  } else {
    const dueDay = parseDay(task.due_date).getTime()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    if (dueDay === today) out.push({ label: 'Due Today', tone: TONE.warn })
  }

  if (stage === 'waiting') {
    const d = calendarDaysSince(task.waiting_since ?? task.updated_at, now)
    out.push({ label: `Waiting ${d} Day${d === 1 ? '' : 's'}`, tone: TONE.warn })
  }
  if (stage === 'for_review') {
    const d = calendarDaysSince(task.submitted_for_review_at ?? task.updated_at, now)
    out.push({ label: `For Review ${d} Day${d === 1 ? '' : 's'}`, tone: TONE.violet })
  }
  if (stage === 'rework') {
    out.push({ label: 'Rework', tone: TONE.danger })
  }
  return out
}

// ---- Workload ---------------------------------------------------------------

export type WorkloadLevel = 'available' | 'normal' | 'high' | 'overloaded'

export interface WorkloadResult {
  /** Open estimated hours ÷ available hours, 0–∞ (as a percentage). */
  pct: number | null
  level: WorkloadLevel
  openHours: number
  availableHours: number
}

export const WORKLOAD_LABELS: Record<WorkloadLevel, { label: string; chip: string }> = {
  available: { label: 'Available', chip: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  normal: { label: 'Normal', chip: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  high: { label: 'High', chip: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  overloaded: { label: 'Overloaded', chip: 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300' },
}

/** §7: <60% Available · 60–80% Normal · 81–100% High · >100% Overloaded. */
export function workloadLevel(pct: number): WorkloadLevel {
  if (pct < 60) return 'available'
  if (pct <= 80) return 'normal'
  if (pct <= 100) return 'high'
  return 'overloaded'
}

/**
 * Schedule-aware workload for one employee in `month`: the sum of estimated
 * hours on their OPEN tasks over the work hours they still have (or had, for
 * past months) on their own workweek.
 */
export function computeWorkload(worker: Worker, allTasks: Task[], month: string, now = new Date()): WorkloadResult {
  const mine = allTasks.filter((t) => t.worker_id === worker.id && !t.archived_at)
  const openHours = mine.reduce((sum, t) => sum + openEstimatedHours(t), 0)
  const availableHours = availableWorkHours(worker, month, now)
  if (availableHours <= 0) return { pct: null, level: 'normal', openHours, availableHours }
  const pct = Math.round((openHours / availableHours) * 100)
  return { pct, level: workloadLevel(pct), openHours, availableHours }
}

// ---- Per-employee monthly metrics -------------------------------------------

/** Targets (§8/§9). A MonthlyGoal row can override on-time/QA per person/month. */
export const KPI_TARGETS = {
  onTime: 90,
  qa: 90,
  rework: 5,
  goal: 90,
} as const

export const KPI_WEIGHTS = { onTime: 0.3, qa: 0.3, goal: 0.25, rework: 0.15 } as const

export interface EmployeeKpi {
  worker: Worker
  /** Open, unarchived tasks right now. */
  activeCount: number
  /** Tasks completed during the month. */
  completedCount: number
  /** On-time % of QA-eligible completions (null = nothing to judge). */
  onTimePct: number | null
  /** Completed in month that were late (traceable). */
  lateCount: number
  /** Legacy completions excluded from on-time. */
  legacyExcluded: number
  /** Open overdue right now. */
  overdueCount: number
  /** Open waiting right now. */
  blockedCount: number
  /** Open for_review right now. */
  reviewCount: number
  /** Average QA as % (score/5), over reviews in the month. */
  qaPct: number | null
  qaReviewed: number
  /** Employee-caused rework ÷ QA-reviewed, as % (null without reviews). */
  reworkRatePct: number | null
  reworkEmployeeCount: number
  workload: WorkloadResult
  /** Monthly goal achievement 0–1+ (null when no target is set). */
  goalAchievement: number | null
  goalTarget: number | null
  goalAchieved: number
  onTimeTarget: number
  qaTarget: number
  /** Weighted score 0–100 (null when no component has data). */
  score: number | null
  /** Which components fed the score (for the drill-down / tooltip). */
  scoreParts: { onTime: number | null; qa: number | null; goal: number | null; rework: number | null }
}

/**
 * Rework performance (0–100): full marks while the rate is at/below the 5%
 * target; above it, 10 points off per point of rate.
 */
export function reworkPerformance(ratePct: number): number {
  if (ratePct <= KPI_TARGETS.rework) return 100
  return Math.max(0, 100 - (ratePct - KPI_TARGETS.rework) * 10)
}

/**
 * Weighted KPI score from the four components. `null` components are dropped
 * and the remaining weights renormalised; all-null → null.
 */
export function weightedKpiScore(parts: {
  onTime: number | null
  qa: number | null
  goal: number | null
  rework: number | null
}): number | null {
  let total = 0
  let weight = 0
  if (parts.onTime !== null) { total += parts.onTime * KPI_WEIGHTS.onTime; weight += KPI_WEIGHTS.onTime }
  if (parts.qa !== null) { total += parts.qa * KPI_WEIGHTS.qa; weight += KPI_WEIGHTS.qa }
  if (parts.goal !== null) { total += parts.goal * KPI_WEIGHTS.goal; weight += KPI_WEIGHTS.goal }
  if (parts.rework !== null) { total += parts.rework * KPI_WEIGHTS.rework; weight += KPI_WEIGHTS.rework }
  if (weight === 0) return null
  return Math.round(total / weight)
}

/** Everything the metrics for one employee in one month need. */
export interface EmployeeKpiInput {
  worker: Worker
  tasks: Task[]
  month: string
  goal: MonthlyGoal | null
  now?: Date
}

/** Compute one employee's month. Filtering (client/status) happens outside. */
export function computeEmployeeKpi({ worker, tasks, month, goal, now = new Date() }: EmployeeKpiInput): EmployeeKpi {
  const mine = tasks.filter((t) => t.worker_id === worker.id && !t.archived_at)
  const activeCount = mine.filter(isOpen).length
  const completed = mine.filter((t) => normalizeTaskStage(t.status) === 'completed' && inMonth(t.completed_at, month))
  const completedCount = completed.length

  // On-time over this month's completions that have a due date at all.
  let onTime = 0
  let judged = 0
  let late = 0
  let legacy = 0
  for (const t of completed) {
    const verdict = wasOnTime(t)
    if (verdict === null) { legacy++; continue }
    judged++
    if (verdict) onTime++
    else late++
  }
  const onTimePct = judged > 0 ? Math.round((onTime / judged) * 100) : null

  const overdueCount = mine.filter(isOverdueTask).length
  const blockedCount = mine.filter((t) => normalizeTaskStage(t.status) === 'waiting').length
  const reviewCount = mine.filter((t) => normalizeTaskStage(t.status) === 'for_review').length

  // QA: reviews recorded during the month.
  const reviewed = mine.filter((t) => t.qa_score != null && (inMonth(t.qa_reviewed_at, month) || (!t.qa_reviewed_at && inMonth(t.completed_at, month))))
  const qaPct = reviewed.length > 0
    ? Math.round((reviewed.reduce((s, t) => s + (Number(t.qa_score) || 0), 0) / (reviewed.length * 5)) * 100)
    : null

  // Rework rate = employee-caused rework ÷ QA-reviewed (§11).
  const employeeRework = reviewed.filter((t) => t.rework_required === true && isEmployeeCausedRework(t.rework_type))
  const reworkRatePct = reviewed.length > 0
    ? Math.round((employeeRework.length / reviewed.length) * 1000) / 10
    : null
  const reworkPerformancePct = reworkRatePct !== null ? reworkPerformance(reworkRatePct) : null

  // Monthly goal: completions vs the configured target (role-specific units).
  const goalTarget = goal?.target ?? null
  const goalAchieved = goalTarget !== null ? completedCount : 0
  const goalAchievement = goalTarget !== null && goalTarget > 0 ? goalAchieved / goalTarget : null
  const goalPct = goalAchievement !== null ? Math.min(100, Math.round(goalAchievement * 100)) : null

  const workload = computeWorkload(worker, tasks, month, now)

  const scoreParts = { onTime: onTimePct, qa: qaPct, goal: goalPct, rework: reworkPerformancePct }
  const score = weightedKpiScore(scoreParts)

  return {
    worker,
    activeCount,
    completedCount,
    onTimePct,
    lateCount: late,
    legacyExcluded: legacy,
    overdueCount,
    blockedCount,
    reviewCount,
    qaPct,
    qaReviewed: reviewed.length,
    reworkRatePct,
    reworkEmployeeCount: employeeRework.length,
    workload,
    goalAchievement,
    goalTarget,
    goalAchieved,
    onTimeTarget: goal?.on_time_target ?? KPI_TARGETS.onTime,
    qaTarget: goal?.qa_target ?? KPI_TARGETS.qa,
    score,
    scoreParts,
  }
}

// ---- Team aggregates --------------------------------------------------------

export interface TeamKpi {
  /** Headline score: mean of per-employee scores that have one. */
  score: number | null
  onTimePct: number | null
  overdueCount: number
  blockedCount: number
  reviewCount: number
  /** Team workload %: total open hours ÷ total available hours. */
  workloadPct: number | null
  completedCount: number
  qaPct: number | null
  reworkRatePct: number | null
  employees: EmployeeKpi[]
}

/** Aggregate the per-employee rows into the summary cards. */
export function computeTeamKpi(employees: EmployeeKpi[]): TeamKpi {
  const scored = employees.filter((e) => e.score !== null).map((e) => e.score!)
  let openHours = 0
  let availableHours = 0
  let qaSum = 0
  let qaN = 0
  let reworkN = 0
  let reworkEmp = 0
  for (const e of employees) {
    openHours += e.workload.openHours
    availableHours += e.workload.availableHours
    qaSum += (e.qaPct ?? 0) * e.qaReviewed
    qaN += e.qaReviewed
    if (e.reworkRatePct !== null) {
      reworkN += e.qaReviewed
      reworkEmp += e.reworkEmployeeCount
    }
  }
  // Team on-time/QA = the mean of the per-person figures the table shows, so
  // the headline card and the rows always agree.
  const onTimes = employees.filter((e) => e.onTimePct !== null).map((e) => e.onTimePct!)

  return {
    score: scored.length > 0 ? Math.round(scored.reduce((s, v) => s + v, 0) / scored.length) : null,
    onTimePct: onTimes.length > 0 ? Math.round(onTimes.reduce((s, v) => s + v, 0) / onTimes.length) : null,
    overdueCount: employees.reduce((s, e) => s + e.overdueCount, 0),
    blockedCount: employees.reduce((s, e) => s + e.blockedCount, 0),
    reviewCount: employees.reduce((s, e) => s + e.reviewCount, 0),
    workloadPct: availableHours > 0 ? Math.round((openHours / availableHours) * 100) : null,
    completedCount: employees.reduce((s, e) => s + e.completedCount, 0),
    qaPct: qaN > 0 ? Math.round(qaSum / qaN) : null,
    reworkRatePct: reworkN > 0 ? Math.round((reworkEmp / reworkN) * 1000) / 10 : null,
    employees,
  }
}

// ---- Needs Attention (§13) ---------------------------------------------------

export type AttentionSeverity = 'critical' | 'warning' | 'info'

/** What a Needs Attention row is about — used to open the exact task list. */
export type AttentionDrill =
  | { kind: 'workload' }
  | { kind: 'overdue'; highOnly?: boolean }
  | { kind: 'blocked'; agedOnly?: boolean }
  | { kind: 'review'; agedOnly?: boolean }
  | { kind: 'qa' }
  | { kind: 'rework' }
  | { kind: 'goal' }
  | { kind: 'available' }

export interface AttentionItem {
  id: string
  worker: Worker
  severity: AttentionSeverity
  message: string
  drill: AttentionDrill
}

/** Goal pace: you should have finished `elapsed workdays / total` of the target
 *  (allowing the 90% goal target) by now. Behind that = significantly behind. */
export function goalBehindPace(emp: EmployeeKpi, month: string, now = new Date()): boolean {
  if (emp.goalAchievement === null) return false
  const workdays = emp.worker.workdays?.length ? emp.worker.workdays : [1, 2, 3, 4, 5]
  const total = workdaysInMonth(month, workdays)
  if (total <= 0) return false
  const { from, to } = monthRange(month)
  const elapsed = workdaysBetween(
    parseDay(from),
    now > parseDay(to) ? parseDay(to) : new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    workdays,
  ).length
  if (elapsed <= 1) return false // first day: no pace yet
  const pace = elapsed / total
  const expected = pace * (KPI_TARGETS.goal / 100)
  return emp.goalAchievement < expected * 0.8 // clearly behind, not a rounding wobble
}

/**
 * The Needs Attention list for the month. Waiting/client-caused delays are
 * never blamed on the employee (§12) — a long wait surfaces the *task*, and
 * the row says follow up, not "underperforming".
 */
export function buildAttention(
  employees: EmployeeKpi[],
  tasks: Task[],
  month: string,
  now = new Date(),
): AttentionItem[] {
  const items: AttentionItem[] = []
  const scoped = tasks.filter((t) => !t.archived_at)

  for (const emp of employees) {
    const w = emp.worker
    const workdays = w.workdays?.length ? w.workdays : [1, 2, 3, 4, 5]
    const add = (severity: AttentionSeverity, message: string, drill: AttentionDrill, key: string) =>
      items.push({ id: `${w.id}:${key}`, worker: w, severity, message, drill })

    if (emp.workload.pct !== null && emp.workload.pct > 100) {
      add('critical', `${w.name} is overloaded — ${emp.workload.pct}% of remaining capacity.`, { kind: 'workload' }, 'workload')
    }

    const mine = scoped.filter((t) => t.worker_id === w.id)
    const overdueHigh = mine.filter((t) => isOverdueTask(t) && t.priority === 'high')
    if (overdueHigh.length > 0) {
      add('critical', `${overdueHigh.length} high-priority overdue ${overdueHigh.length === 1 ? 'task' : 'tasks'} for ${w.name}.`, { kind: 'overdue', highOnly: true }, 'overdue-high')
    } else if (emp.overdueCount >= 3) {
      add('warning', `${w.name} has ${emp.overdueCount} overdue tasks.`, { kind: 'overdue' }, 'overdue')
    }

    const staleWaiting = mine.filter(
      (t) => normalizeTaskStage(t.status) === 'waiting' && stageAgeBusinessDays(t, workdays, now) > 3,
    )
    if (staleWaiting.length > 0) {
      add('warning', `A ${staleWaiting.length === 1 ? 'task' : `${staleWaiting.length} tasks`} of ${w.name}'s has been Waiting over 3 business days.`, { kind: 'blocked', agedOnly: true }, 'blocked')
    }

    const staleReview = mine.filter(
      (t) => normalizeTaskStage(t.status) === 'for_review' && stageAgeBusinessDays(t, workdays, now) > 2,
    )
    if (staleReview.length > 0) {
      add('warning', `${staleReview.length} task${staleReview.length === 1 ? '' : 's'} of ${w.name}'s waiting for QA over 2 business days.`, { kind: 'review', agedOnly: true }, 'review')
    }

    if (emp.qaPct !== null && emp.qaPct < emp.qaTarget) {
      add('warning', `${w.name}'s QA is ${emp.qaPct}% — below the ${emp.qaTarget}% target.`, { kind: 'qa' }, 'qa')
    }

    if (emp.reworkRatePct !== null && emp.reworkRatePct > KPI_TARGETS.rework) {
      add('warning', `${w.name}'s internal rework is ${emp.reworkRatePct}% — above the 5% target.`, { kind: 'rework' }, 'rework')
    }

    if (goalBehindPace(emp, month, now)) {
      add('warning', `${w.name} is behind pace on the monthly goal (${Math.round((emp.goalAchievement ?? 0) * 100)}% of target).`, { kind: 'goal' }, 'goal')
    }

    if (emp.workload.pct !== null && emp.workload.pct < 60) {
      add('info', `${w.name} is at ${emp.workload.pct}% workload — available for more work.`, { kind: 'available' }, 'available')
    }
  }

  const rank: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 }
  return items.sort((a, b) => rank[a.severity] - rank[b.severity] || a.worker.name.localeCompare(b.worker.name))
}

// ---- Review backlog (§12) ----------------------------------------------------

export interface ReviewBacklog {
  /** Open tasks sitting in For Review (within the active filters). */
  count: number
  /** Calendar days since the oldest submission ('—' friendly: null when empty). */
  oldestDays: number | null
  oldestTask: Task | null
  /** The reviewer who most recently scored anything in scope (or null → Owner/PM). */
  reviewer: string | null
}

export function buildReviewBacklog(tasks: Task[], now = new Date()): ReviewBacklog {
  const waiting = tasks
    .filter((t) => !t.archived_at && normalizeTaskStage(t.status) === 'for_review')
    .sort((a, b) => (a.submitted_for_review_at || a.updated_at).localeCompare(b.submitted_for_review_at || b.updated_at))
  const oldest = waiting[0] ?? null
  const reviewers = tasks
    .map((t) => t.qa_reviewed_by)
    .filter((r): r is string => !!r)
  return {
    count: waiting.length,
    oldestDays: oldest ? calendarDaysSince(oldest.submitted_for_review_at ?? oldest.updated_at, now) : null,
    oldestTask: oldest,
    reviewer: reviewers.length > 0 ? reviewers[reviewers.length - 1] : null,
  }
}

// ---- Filtering for the dashboard --------------------------------------------

/** The Team KPI page's header filters (§5). */
export interface KpiFilters {
  /** 'YYYY-MM'. */
  month: string
  /** 'all' or a worker id. */
  employee: string
  /** 'all' or a client id. */
  client: string
  /** 'all' or one stage. */
  status: 'all' | TaskStatus
}

export const DEFAULT_KPI_FILTERS = (): KpiFilters => ({
  month: currentMonthKey(),
  employee: 'all',
  client: 'all',
  status: 'all',
})

/**
 * Scope the raw task list by the employee/client/status header filters.
 * The MONTH is applied per-metric inside the calculators (completions vs
 * open state), never here.
 */
export function applyKpiFilters(tasks: Task[], f: KpiFilters): Task[] {
  let rows = tasks
  if (f.employee !== 'all') rows = rows.filter((t) => t.worker_id === f.employee)
  if (f.client !== 'all') rows = rows.filter((t) => t.client_id === f.client)
  if (f.status !== 'all') rows = rows.filter((t) => normalizeTaskStage(t.status) === f.status)
  return rows
}

/**
 * A worker is a KPI subject when they do NOT hold `team_kpi.view`.
 * Reviewers/viewers holding the grant are excluded from KPI numbers (§Requirement 1).
 */
export function isKpiSubject(worker: Worker): boolean {
  return !(worker.permissions && worker.permissions.includes('team_kpi.view'))
}

/** Which employees appear under the current employee filter (active KPI subjects only; reviewers excluded). */
export function scopeEmployees(workers: Worker[], f: KpiFilters): Worker[] {
  const subjects = workers.filter(isKpiSubject)
  const active = subjects.filter((w) => w.status === 'active')
  const base = active.length > 0 ? active : subjects
  if (f.employee === 'all') return base
  const matched = base.filter((w) => w.id === f.employee)
  return matched.length > 0 ? matched : base
}

/** Convenience: every open status (for "Active" style counts). */
export const OPEN_STATUSES: TaskStatus[] = TASK_STATUSES.filter((s) => s !== 'completed')

/** Format a nullable percentage for the UI ('—' when there is no data). */
export function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${n.toFixed(digits)}%`
}

/** QA score → display percentage (5 = 100%). */
export function qaScoreToPct(score: QaScore | null | undefined): number | null {
  return score == null ? null : Math.round((Number(score) / 5) * 100)
}

// ---- Bonus helpers ----------------------------------------------------------

/** What an employee shows when no bonus row exists yet for the month. */
export function effectiveBonus(decisions: BonusDecision[], workerId: string, month: string): BonusDecision | null {
  return decisions.find((d) => d.worker_id === workerId && d.month === month) ?? null
}
