/**
 * Carrying recurring tasks into a new month.
 *
 * A repeating task lives on the Recurring shelf as its template. Its due date
 * is an anchor: each time a cycle is started, the anchor moves to that cycle's
 * date (the same as "Start occurrence" on the board). When a new month begins,
 * every template whose anchor is still in an earlier month gets its cycle for
 * the new month: one To Do card, due on the cycle date, and the anchor moves
 * with it. Because the anchor moves, the same cycle is never created twice,
 * and deleting the card does not bring it back.
 *
 * Rules, stated plainly:
 *  - only templates on the shelf carry over; a series continued with
 *    "Recreate next" keeps its manual step;
 *  - a month that was skipped is not back-filled: the next cycle is the first
 *    one that falls in the current month;
 *  - a cycle that would fall after the series' end date is not created;
 *  - nothing is created when the series already has a card due in this month.
 *
 * Pure: the caller supplies the tasks, today, the workdays and who may write,
 * and carries out the returned plans through its own backend.
 */
import type { CreateTaskInput } from './backend'
import type { Task } from './types'
import { normalizeOccurrence, normalizeRepeats, nextRecurringDueDate } from './taskWorkflow'
import { isShelfTask } from './taskMonths'
import { monthFirstDay, monthKeyOfISO, monthLastDay } from './monthScope'

/** Who a carried-over card is recorded as having been started by, in the stage history. */
export const RECURRING_CARRY_OVER_ACTOR = 'Recurring carry-over'

/** Upper bound on steps when walking a long-idle series forward. */
const MAX_STEPS = 10000

export interface CarryOverPlan {
  /** The shelf template the card comes from. Its anchor moves to `due`. */
  templateId: string
  /** The card to create: To Do, due on the cycle date, same series. */
  input: CreateTaskInput
  /** The cycle date ('YYYY-MM-DD'). */
  due: string
  /** The occurrence number the card takes (and the template records). */
  occurrence: number
}

export interface CarryOverOptions {
  /** Every task the viewer can see (archived ones included). */
  tasks: Task[]
  /** Today, 'YYYY-MM-DD' (local). Its month is the month being carried into. */
  today: string
  /** The working days of a worker, 1 = Monday … 7 = Sunday. */
  workdaysOf: (workerId: string) => number[]
  /** Whether the viewer may create a card on this template's board. */
  canWrite: (task: Task) => boolean
}

/**
 * One template per series. A card returned to the shelf keeps its series, so a
 * series can have more than one shelf card; the one with the latest anchor (the
 * series root on a tie) speaks for the series, so its cycle is made once.
 */
function templatesBySeries(tasks: Task[], canWrite: (task: Task) => boolean): Task[] {
  const chosen = new Map<string, Task>()
  for (const task of tasks) {
    if (!isShelfTask(task) || task.archived_at) continue
    if (normalizeRepeats(task.repeats) === 'none' || !task.due_date) continue
    if (!canWrite(task)) continue
    const key = task.series_id ?? task.id
    const current = chosen.get(key)
    const latest =
      !current ||
      task.due_date! > current.due_date! ||
      (task.due_date === current.due_date && task.id === key)
    if (latest) chosen.set(key, task)
  }
  return [...chosen.values()]
}

/** The cards to create so that every template has its cycle in the current month. */
export function planRecurringCarryOver({ tasks, today, workdaysOf, canWrite }: CarryOverOptions): CarryOverPlan[] {
  const month = monthKeyOfISO(today)
  if (!month) return []
  const first = monthFirstDay(month)
  const last = monthLastDay(month)
  const plans: CarryOverPlan[] = []

  for (const template of templatesBySeries(tasks, canWrite)) {
    const repeats = normalizeRepeats(template.repeats)
    const anchor = template.due_date
    if (!anchor) continue
    // The anchor is already this month or later: this month's cycle is on the
    // board, or was started on purpose. Nothing to carry.
    if (anchor >= first) continue

    const key = template.series_id ?? template.id
    const series = tasks.filter((t) => (t.series_id ?? t.id) === key)
    if (series.some((t) => t.due_date !== null && t.due_date >= first && t.due_date <= last)) continue

    // Walk forward from the anchor to the first cycle in this month or later.
    const workdays = workdaysOf(template.worker_id)
    let due = anchor
    let steps = 0
    do {
      due = nextRecurringDueDate(due, repeats, workdays)
      steps += 1
    } while (due < first && steps < MAX_STEPS)
    if (due < first || due > last) continue
    if (template.repeat_until && due > template.repeat_until) continue

    const occurrence = (normalizeOccurrence(template.occurrence) ?? 0) + 1
    plans.push({
      templateId: template.id,
      due,
      occurrence,
      input: {
        worker_id: template.worker_id,
        client_id: template.client_id,
        title: template.title,
        description: template.description,
        status: 'todo',
        priority: template.priority,
        start_date: today,
        due_date: due,
        estimated_hours: template.estimated_hours,
        qa_required: template.qa_required === true,
        repeats,
        repeat_until: template.repeat_until,
        series_id: key,
        occurrence,
      },
    })
  }
  return plans
}
