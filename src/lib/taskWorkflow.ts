/**
 * Task stage workflow rules, shared by both backends so a move on the local
 * demo board and a move on Supabase stamp exactly the same record:
 *
 *  - Assigned At / Started At / Waiting Since / Submitted for Review At /
 *    Rework Started At / Completed At are maintained automatically (§3).
 *  - Stage history keeps every hop for auditability.
 *  - Pushing a due date AFTER the task already missed it preserves the
 *    original deadline, so on-time KPI history can't be rewritten (§15).
 *
 * Pure functions: the backends apply the returned patch to their own rows.
 */
import type { CreateTaskInput } from './backend'
import type { QaScore, ReworkType, Task, TaskRepeats, TaskStageEvent, TaskStatus, WaitingReason, Worker } from './types'
import { normalizeTaskStage } from './types'
import { isOverdueDate } from './utils'

/** Fields a stage hop changes — merged onto the row by the backend. */
export interface StagePatch {
  status: TaskStatus
  assigned_at?: string | null
  started_at?: string | null
  waiting_since?: string | null
  waiting_reason?: WaitingReason | null
  submitted_for_review_at?: string | null
  rework_started_at?: string | null
  completed_at?: string | null
  /** Entering For Review refreshes (but does not clear) the last decision. */
  qa_score?: QaScore | null
  qa_reviewed_at?: string | null
  qa_reviewed_by?: string | null
  rework_required?: boolean | null
  rework_type?: ReworkType | null
  rework_notes?: string | null
  stage_history: TaskStageEvent[]
  updated_at: string
}

/** Who is performing this action, for the history trail. */
export function stageActorName(
  role: 'admin' | 'worker',
  worker: Worker | null | undefined,
  email?: string | null,
): string {
  if (role === 'admin') return 'Owner'
  return worker?.name || email || 'Someone'
}

/** The initial workflow fields for a brand-new task (every key required —
 *  spreading these onto a fresh row satisfies the full Task shape). */
export interface InitialStageFields {
  original_due_date: null
  estimated_hours: null
  assigned_at: string
  started_at: string | null
  waiting_since: string | null
  waiting_reason: null
  submitted_for_review_at: string | null
  rework_started_at: string | null
  qa_score: null
  qa_reviewed_at: null
  qa_reviewed_by: null
  rework_required: null
  rework_type: null
  rework_notes: null
  stage_history: TaskStageEvent[]
}

export function initialStageFields(status: TaskStatus, now: string, actor: string): InitialStageFields {
  const stage = normalizeTaskStage(status)
  return {
    original_due_date: null,
    estimated_hours: null,
    assigned_at: now,
    started_at: stage === 'in_progress' ? now : null,
    waiting_since: stage === 'waiting' ? now : null,
    waiting_reason: null,
    submitted_for_review_at: stage === 'for_review' ? now : null,
    rework_started_at: stage === 'rework' ? now : null,
    qa_score: null,
    qa_reviewed_at: null,
    qa_reviewed_by: null,
    rework_required: null,
    rework_type: null,
    rework_notes: null,
    stage_history: [{ from: null, to: stage, at: now, by: actor }],
  }
}

/**
 * Compute the row after a move to `nextStatus`. Keeps first-seen stamps where
 * they make sense (Started At stays the first start; Completed At is cleared
 * when the task leaves Completed — same as before), refreshes Waiting Since
 * and Submitted for Review At on every entry into those columns, and appends
 * the hop to stage_history.
 */
export function applyStageTransition(
  current: Task,
  nextStatus: TaskStatus,
  now: string,
  actor: string,
): StagePatch {
  const from = normalizeTaskStage(current.status)
  const to = normalizeTaskStage(nextStatus)
  const history = Array.isArray(current.stage_history) ? current.stage_history.filter((e) => e && e.to) : []
  const patch: StagePatch = {
    status: to,
    stage_history: from === to && history.length > 0 ? history : [...history, { from, to, at: now, by: actor }],
    updated_at: now,
    assigned_at: current.assigned_at ?? current.created_at ?? now,
    started_at: current.started_at ?? null,
    waiting_since: current.waiting_since ?? null,
    waiting_reason: current.waiting_reason ?? null,
    submitted_for_review_at: current.submitted_for_review_at ?? null,
    rework_started_at: current.rework_started_at ?? null,
    completed_at: current.completed_at ?? null,
  }

  if (to === 'in_progress' && !patch.started_at) patch.started_at = now
  if (to === 'waiting') {
    patch.waiting_since = now
    // A hop out of Waiting and back means a NEW block — the reason is reset
    // rather than silently keeping the old one.
    if (from !== 'waiting') patch.waiting_reason = current.waiting_reason ?? null
  }
  if (to !== 'waiting') {
    patch.waiting_since = null
    if (to === 'in_progress' || to === 'todo') patch.waiting_reason = null
  }
  if (to === 'for_review') {
    patch.submitted_for_review_at = now
    // Entering review is a fresh review cycle: the previous decision doesn't
    // pre-judge this submission.
    if (from !== 'for_review') {
      patch.qa_score = current.qa_score ?? null
      patch.rework_required = current.rework_required ?? null
      patch.rework_type = current.rework_type ?? null
      patch.rework_notes = current.rework_notes ?? null
      patch.qa_reviewed_at = null
      patch.qa_reviewed_by = null
    }
  }
  if (to === 'rework') {
    patch.rework_started_at = now
    patch.completed_at = null
  }
  if (to === 'completed') {
    patch.completed_at = current.completed_at ?? now
  } else {
    patch.completed_at = null
  }
  return patch
}

/**
 * Apply a due-date change safely: if the deadline moved while the task was
 * ALREADY past it, keep the missed date in `original_due_date` (first miss
 * wins). Changing a date before the deadline is a legitimate reschedule — no
 * original is recorded. Returns the fields to write plus whether history
 * needs an audit line.
 */
export function applyDueDateChange(
  current: Pick<Task, 'due_date' | 'original_due_date'>,
  nextDueDate: string | null,
): { due_date: string | null; original_due_date: string | null; changed: boolean; missedDeadline: boolean } {
  const changed = (current.due_date ?? null) !== (nextDueDate ?? null)
  if (!changed) {
    return { due_date: current.due_date ?? null, original_due_date: current.original_due_date ?? null, changed: false, missedDeadline: false }
  }
  const wasMissed = isOverdueDate(current.due_date)
  const original = current.original_due_date ?? null
  if (wasMissed && current.due_date) {
    return {
      due_date: nextDueDate,
      // First missed deadline is kept forever; later pushes don't replace it.
      original_due_date: original ?? current.due_date,
      changed: true,
      missedDeadline: true,
    }
  }
  return { due_date: nextDueDate, original_due_date: original, changed: true, missedDeadline: false }
}

/** QA / rework patches are the reviewers' alone (Owner + Project Manager). */
export const QA_PATCH_FIELDS = [
  'qa_score',
  'qa_reviewed_at',
  'qa_reviewed_by',
  'rework_required',
  'rework_type',
  'rework_notes',
] as const

/** Does this patch try to change a QA/rework decision? */
export function patchTouchesQa(patch: Partial<Task>): boolean {
  return QA_PATCH_FIELDS.some((f) => patch[f] !== undefined)
}

/** Normalize & validate an incoming QA score (1–5 or null). */
export function normalizeQaScore(value: unknown): QaScore | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 5) return null
  return n as QaScore
}

/** Normalize an incoming rework type (unknown values become null). */
export function normalizeReworkType(value: unknown): ReworkType | null {
  return typeof value === 'string' ? (value as ReworkType) : null
}

/** Normalize an incoming waiting reason (unknown values become null). */
export function normalizeWaitingReason(value: unknown): WaitingReason | null {
  return typeof value === 'string' ? (value as WaitingReason) : null
}

/** Estimated hours: a positive finite number, or null. */
export function normalizeEstimatedHours(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null
}

/**
 * Read-side hydration for a stored task row: maps legacy `approval` onto
 * `for_review`, fills every KPI-era field with its neutral default, and keeps
 * the Completed invariants (stamp present while completed, cleared otherwise).
 * Both backends run rows through this so the UI never sees a half-shaped task.
 */
export function hydrateTask(t: Task): Task {
  const status = normalizeTaskStage(t.status)
  const priority = t.priority === 'low' || t.priority === 'high' ? t.priority : 'medium'
  return {
    ...t,
    status,
    priority,
    description: t.description ?? null,
    client_id: t.client_id ?? null,
    due_date: t.due_date ?? null,
    original_due_date: t.original_due_date ?? null,
    estimated_hours: normalizeEstimatedHours(t.estimated_hours),
    assigned_at: t.assigned_at ?? t.created_at ?? null,
    started_at: t.started_at ?? null,
    waiting_since: t.waiting_since ?? (status === 'waiting' ? (t.updated_at ?? null) : null),
    waiting_reason: t.waiting_reason ?? null,
    submitted_for_review_at: t.submitted_for_review_at ?? (status === 'for_review' ? (t.updated_at ?? null) : null),
    rework_started_at: t.rework_started_at ?? null,
    qa_score: normalizeQaScore(t.qa_score),
    qa_reviewed_at: t.qa_reviewed_at ?? null,
    qa_reviewed_by: t.qa_reviewed_by ?? null,
    rework_required: typeof t.rework_required === 'boolean' ? t.rework_required : null,
    rework_type: normalizeReworkType(t.rework_type),
    rework_notes: t.rework_notes ?? null,
    stage_history: Array.isArray(t.stage_history) ? t.stage_history.filter((e) => e && e.to) : [],
    position: Number.isFinite(t.position) ? t.position : 0,
    created_by_role: t.created_by_role === 'admin' ? 'admin' : 'worker',
    completed_at: status === 'completed' ? (t.completed_at ?? t.updated_at ?? null) : null,
    archived_at: status === 'completed' ? (t.archived_at ?? null) : null,
    // Recurrence: rows written before the feature exist load as one-off tasks.
    repeats: normalizeRepeats(t.repeats),
    repeat_until: typeof t.repeat_until === 'string' && t.repeat_until ? t.repeat_until.slice(0, 10) : null,
    series_id: typeof t.series_id === 'string' && t.series_id ? t.series_id : null,
    occurrence: normalizeOccurrence(t.occurrence),
  }
}

// ---- Recurring tasks ("Recreate next") ---------------------------------------

/** Normalize an incoming repeat interval (unknown values become 'none'). */
export function normalizeRepeats(value: unknown): TaskRepeats {
  return value === 'daily' || value === 'weekly' || value === 'biweekly' || value === 'monthly' ? value : 'none'
}

/** Normalize an occurrence counter (1+, or null when not in a series). */
export function normalizeOccurrence(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : null
}

/** Parse a local 'YYYY-MM-DD' string into a local-midnight Date, or null. */
function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** Local-midnight Date → 'YYYY-MM-DD'. */
function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Advance a due date by one repeat interval. If the result lands on a day the
 * assignee does not work, roll forward to their next workday (an empty
 * `workdays` list defaults to Mon–Fri, matching the workload math).
 *
 * The advance is computed from the PLANNED due date — never "today" — so a
 * late completion cannot drift the series: a weekly task due Monday stays
 * Monday-to-Monday regardless of when it was actually completed.
 *
 *  - daily → +1 day · weekly → +7 days · biweekly → +14 days
 *  - monthly → same day of the next month, clamped (Jan 31 → Feb 28/29)
 */
export function nextRecurringDueDate(dueDate: string, repeats: TaskRepeats, workdays: number[]): string {
  const base = parseLocalDate(dueDate)
  if (!base) return dueDate
  const d = new Date(base)
  switch (repeats) {
    case 'daily':
      d.setDate(d.getDate() + 1)
      break
    case 'weekly':
      d.setDate(d.getDate() + 7)
      break
    case 'biweekly':
      d.setDate(d.getDate() + 14)
      break
    case 'monthly': {
      const lastDay = new Date(base.getFullYear(), base.getMonth() + 2, 0).getDate()
      d.setMonth(d.getMonth() + 1, Math.min(base.getDate(), lastDay))
      break
    }
    default:
      break
  }
  const days = workdays.length > 0 ? workdays : [1, 2, 3, 4, 5]
  let guard = 0
  while (!days.includes(d.getDay()) && guard < 8) {
    d.setDate(d.getDate() + 1)
    guard += 1
  }
  return formatLocalDate(d)
}

export interface RecreatePlan {
  /** The next instance, ready for the existing createTask path. */
  input: CreateTaskInput
  /** The due date the new instance would get. */
  nextDue: string
  /** True when `nextDue` passes the series' end date — do not offer it. */
  blockedByEnd: boolean
}

/**
 * The "Recreate next" plan for a completed repeating task: everything is
 * carried over (worker, client, title, description, priority, estimate,
 * repeat settings), the due date advances by one interval, and the series
 * counter grows. Returns null when there is nothing to recreate — a one-off
 * task or a legacy row without a due date (no anchor to advance from).
 */
export function planRecreate(task: Task, workdays: number[]): RecreatePlan | null {
  const repeats = normalizeRepeats(task.repeats)
  if (repeats === 'none' || !task.due_date) return null
  const nextDue = nextRecurringDueDate(task.due_date, repeats, workdays)
  return {
    input: {
      worker_id: task.worker_id,
      client_id: task.client_id,
      title: task.title,
      description: task.description,
      status: 'todo',
      priority: task.priority,
      due_date: nextDue,
      estimated_hours: task.estimated_hours,
      repeats,
      repeat_until: task.repeat_until,
      series_id: task.series_id ?? task.id,
      occurrence: (normalizeOccurrence(task.occurrence) ?? 1) + 1,
    },
    nextDue,
    blockedByEnd: task.repeat_until != null && nextDue > task.repeat_until,
  }
}
