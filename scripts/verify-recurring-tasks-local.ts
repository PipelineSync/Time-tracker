/**
 * Verification of recurring tasks ("Recreate next") (demo-mode local backend):
 *  - the interval math is drift-free (it advances from the PLANNED due date),
 *    monthly clamps to the month's last day, and a result on a non-workday
 *    rolls to the assignee's next workday
 *  - "Recreate next" clones a completed task into To Do: same worker/client/
 *    title/description/priority/estimate, next due date, occurrence +1 and
 *    the series id carried — while the original stays completed
 *  - end date: once the computed next due date passes repeat_until, the plan
 *    is blocked (and the boundary date itself is still allowed)
 *  - legacy rows (one-off, or no due date) load as 'none' and never offer a
 *    recreate plan
 *
 * Run: npx tsx scripts/verify-recurring-tasks-local.ts
 */
// Minimal browser stub so storage.ts works in Node.
const mem = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  },
}

import type { Task } from '../src/lib/types'

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

/** A full Task row from a partial — the plan only reads a few fields. */
function mkTask(over: Partial<Task>): Task {
  const now = new Date().toISOString()
  return {
    id: 't-x',
    worker_id: 'w-x',
    client_id: 'c-x',
    title: 'x',
    description: null,
    status: 'todo',
    priority: 'medium',
    due_date: null,
    original_due_date: null,
    estimated_hours: null,
    repeats: 'none',
    repeat_until: null,
    series_id: null,
    occurrence: null,
    assigned_at: now,
    started_at: null,
    waiting_since: null,
    waiting_reason: null,
    submitted_for_review_at: null,
    rework_started_at: null,
    qa_score: null,
    qa_reviewed_at: null,
    qa_reviewed_by: null,
    rework_required: null,
    rework_type: null,
    rework_notes: null,
    stage_history: [],
    position: 0,
    created_by_role: 'worker',
    completed_at: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    ...over,
  }
}

async function main() {
  const wf = await import('../src/lib/taskWorkflow')
  const kpi = await import('../src/lib/kpi')
  const { localBackend } = await import('../src/lib/localDb')

  // ---- 1. interval math (pure) ----
  const MON_FRI = [1, 2, 3, 4, 5]
  const TUE_SAT = [2, 3, 4, 5, 6]
  const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]
  // 2026-09-21 is a Monday.
  assert(wf.nextRecurringDueDate('2026-09-21', 'daily', MON_FRI) === '2026-09-22', 'daily advances +1 day')
  assert(wf.nextRecurringDueDate('2026-09-21', 'weekly', MON_FRI) === '2026-09-28', 'weekly advances +7 days')
  assert(wf.nextRecurringDueDate('2026-09-21', 'biweekly', MON_FRI) === '2026-10-05', 'biweekly advances +14 days')
  // Monthly clamps to the last day of the month (2026 is not a leap year).
  assert(wf.nextRecurringDueDate('2026-01-31', 'monthly', EVERY_DAY) === '2026-02-28', 'monthly Jan 31 clamps to Feb 28')
  assert(wf.nextRecurringDueDate('2028-01-31', 'monthly', EVERY_DAY) === '2028-02-29', 'monthly clamps to Feb 29 in a leap year')
  // Non-workday results roll to the assignee's next workday.
  // 2026-09-26 is a Saturday; +7 is the next Saturday → rolls to Monday.
  assert(wf.nextRecurringDueDate('2026-09-26', 'weekly', MON_FRI) === '2026-10-05', 'a Saturday result rolls to Monday for a Mon–Fri worker')
  // A Tue–Sat worker: Monday is a day off, so +7 from Monday rolls to Tuesday.
  assert(wf.nextRecurringDueDate('2026-09-28', 'weekly', TUE_SAT) === '2026-10-06', 'a Monday result rolls to Tuesday for a Tue–Sat worker')
  // No workdays set → defaults to Mon–Fri (same rule as the workload math).
  assert(wf.nextRecurringDueDate('2026-09-26', 'weekly', []) === '2026-10-05', 'an empty workday list defaults to Mon–Fri for the roll')

  // ---- 2. the recreate plan (pure) ----
  const done = mkTask({
    id: 't-series-1',
    worker_id: 'w-1',
    client_id: 'c-9',
    title: 'Weekly client report',
    description: 'Hours + highlights',
    status: 'completed',
    priority: 'high',
    due_date: '2026-09-21',
    estimated_hours: 4,
    repeats: 'weekly',
    occurrence: 2,
    series_id: 't-series-1',
    completed_at: '2026-09-30T10:00:00.000Z', // completed LATE — must not drift the series
  })
  const plan = wf.planRecreate(done, MON_FRI)
  assert(plan !== null, 'a completed recurring task with a due date yields a plan')
  if (!plan) return
  assert(plan.nextDue === '2026-09-28', 'the next due date advances from the PLANNED date, not the late completion date')
  assert(plan.blockedByEnd === false, 'no end date → the plan is not blocked')
  const i = plan.input
  assert(i.due_date === '2026-09-28' && i.status === 'todo', 'the clone is a To Do card due the next interval')
  assert(i.worker_id === 'w-1' && i.client_id === 'c-9' && i.title === 'Weekly client report', 'worker, client and title carry over')
  assert(i.description === 'Hours + highlights' && i.priority === 'high' && i.estimated_hours === 4, 'description, priority and estimate carry over')
  assert(i.repeats === 'weekly' && i.series_id === 't-series-1' && i.occurrence === 3, 'the series keeps its id and the occurrence grows (2 → 3)')

  // One-off and legacy rows never offer a plan.
  assert(wf.planRecreate(mkTask({ status: 'completed', due_date: '2026-09-21' }), MON_FRI) === null, 'a one-off completed task has no plan')
  assert(wf.planRecreate(mkTask({ status: 'completed', repeats: 'weekly' }), MON_FRI) === null, 'a recurring task with no due date (legacy) has no plan')

  // End-date boundary: past → blocked, exactly on the date → still allowed.
  const past = wf.planRecreate(mkTask({ status: 'completed', due_date: '2026-12-28', repeats: 'weekly', repeat_until: '2026-12-30' }), MON_FRI)
  assert(past !== null && past.blockedByEnd === true, 'next due date past repeat_until blocks the plan')
  const boundary = wf.planRecreate(mkTask({ status: 'completed', due_date: '2026-12-28', repeats: 'weekly', repeat_until: '2027-01-04' }), MON_FRI)
  assert(boundary !== null && boundary.blockedByEnd === false, 'a next due date ON the end date is still allowed')
  // The original task keeps its settings even when the series is done.
  assert(boundary!.input.repeat_until === '2027-01-04', 'the end date carries onto the clone')

  // ---- 3. the local backend stores & round-trips the fields ----
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in (auto-seeds the demo workspace)')
  const workers = (await localBackend.listWorkers()).data!
  const john = workers.find((w) => w.email === 'john@example.com')!
  const client = (await localBackend.listClients()).data!.find((c) => c.status === 'active')!

  const recurring = (await localBackend.createTask({
    worker_id: john.id, client_id: client.id, title: 'VR recurring', status: 'todo',
    due_date: '2026-12-28', priority: 'high', estimated_hours: 3,
    repeats: 'weekly', repeat_until: null,
  })).data!
  assert(recurring.repeats === 'weekly' && recurring.repeat_until === null, 'recurring fields are stored on create')
  assert(recurring.series_id === null && recurring.occurrence === null, 'a fresh recurring task starts its series (no id/occurrence yet)')

  const plain = (await localBackend.createTask({
    worker_id: john.id, client_id: client.id, title: 'VR plain', status: 'todo', due_date: '2099-12-31',
  })).data!
  assert(plain.repeats === 'none' && plain.series_id === null && plain.occurrence === null, 'a plain task loads as one-off (no series)')

  const edited = (await localBackend.updateTask(plain.id, { repeats: 'monthly', repeat_until: '2027-06-30' })).data!
  assert(edited.repeats === 'monthly' && edited.repeat_until === '2027-06-30', 'editing the repeat settings saves')
  const unedited = (await localBackend.updateTask(plain.id, { repeats: 'none', repeat_until: null })).data!
  assert(unedited.repeats === 'none' && unedited.repeat_until === null, 'switching back to "does not repeat" clears the end date')

  // ---- 4. the end-to-end recreate flow through the same create path ----
  const completed = (await localBackend.moveTask(recurring.id, 'completed', 0)).data!
  const e2e = wf.planRecreate(completed, john.workdays)
  assert(e2e !== null, 'the backend row yields a recreate plan')
  const next = (await localBackend.createTask(e2e!.input)).data!
  assert(next.status === 'todo' && next.due_date === e2e!.nextDue, 'the clone lands in To Do with the advanced due date')
  assert(next.worker_id === john.id && next.client_id === client.id && next.title === 'VR recurring', 'the clone keeps worker, client and title')
  assert(next.estimated_hours === 3 && next.priority === 'high' && next.repeats === 'weekly', 'the clone keeps estimate, priority and interval')
  assert(next.series_id === recurring.id && next.occurrence === 2, 'the clone inherits the series id and is occurrence #2')
  const original = (await localBackend.listTasks()).data!.find((t) => t.id === recurring.id)!
  assert(original.status === 'completed' && original.occurrence === null, 'the original card is left exactly as completed')

  // And the chain continues: recreating the clone grows the series again.
  const completed2 = (await localBackend.moveTask(next.id, 'completed', 0)).data!
  const again = wf.planRecreate(completed2, john.workdays)
  assert(again !== null && again.input.occurrence === 3 && again.input.series_id === recurring.id, 'recreating the clone continues the same series (#3)')

  // ---- 5. the demo seed shows a recurring example ----
  // (the auto-seed remaps seed row ids, so match by title; the series id
  // must point at the remapped row itself)
  const seeded = (await localBackend.listTasks()).data!.find((t) => t.title === 'Weekly status report — Acme Corp')
  assert(
    seeded && seeded.status === 'completed' && seeded.repeats === 'weekly' && seeded.occurrence === 2 && seeded.series_id === seeded.id,
    'the demo seed carries a recurring completed task with an intact series id',
  )
  if (seeded) {
    const seedPlan = wf.planRecreate(seeded, john.workdays)
    assert(seedPlan !== null && !seedPlan.blockedByEnd, 'the seeded example offers a next occurrence in demo mode')
  }

  // ---- 6. the Recurring shelf: start / return flow (local backend) ----
  // John works Mon–Fri in the seed. 2026-09-28 is a Monday.
  const shelf = (await localBackend.createTask({
    worker_id: john.id, client_id: client.id, title: 'RS shelf daily', status: 'recurring',
    due_date: '2026-09-28', priority: 'medium', estimated_hours: 2, repeats: 'daily',
  })).data!
  assert(shelf.status === 'recurring', 'a task can be created straight onto the Recurring shelf')

  const started = (await localBackend.startRecurringOccurrence(shelf.id)).data!
  assert(started.id !== shelf.id, 'starting creates a NEW occurrence card — the template is not moved')
  assert(started.status === 'todo', 'the occurrence lands in To Do')
  assert(started.due_date === '2026-09-29', 'the occurrence is due the next interval (daily → +1 day)')
  assert(started.occurrence === 1 && started.series_id === shelf.id, 'the occurrence is #1, anchored on the template as its series')
  assert(started.position === 0, 'the occurrence lands at the top of To Do')
  assert(started.repeats === 'daily' && started.title === shelf.title && started.estimated_hours === 2,
    'the occurrence keeps the interval and the template\'s fields')
  const shelfAfter = (await localBackend.listTasks()).data!.find((t) => t.id === shelf.id)!
  assert(shelfAfter.status === 'recurring', 'the template STAYS on the Recurring shelf')
  assert(shelfAfter.due_date === '2026-09-29' && shelfAfter.occurrence === 1, 'the template\'s anchor advances one interval (#1)')

  const started2 = (await localBackend.startRecurringOccurrence(shelf.id)).data!
  const shelfAfter2 = (await localBackend.listTasks()).data!.find((t) => t.id === shelf.id)!
  assert(started2.due_date === '2026-09-30' && started2.occurrence === 2, 'the next start schedules the following cycle (#2)')
  assert(shelfAfter2.due_date === '2026-09-30', 'the anchor keeps advancing with each start')

  // An occurrence can still be re-shelved as the template (the reset path).
  const reShelved = (await localBackend.moveTask(started.id, 'recurring', 0)).data!
  assert(reShelved.status === 'recurring', 'an occurrence can be re-shelved as the template')

  // Weekend roll on the shelf: a weekly card anchored on Saturday rolls the
  // occurrence to the assignee's next workday (Monday).
  const weekendShelf = (await localBackend.createTask({
    worker_id: john.id, client_id: client.id, title: 'RS shelf weekend', status: 'recurring',
    due_date: '2026-09-26', repeats: 'weekly',
  })).data!
  const weekendStarted = (await localBackend.startRecurringOccurrence(weekendShelf.id)).data!
  assert(weekendStarted.due_date === '2026-10-05', 'a Saturday-anchored weekly occurrence rolls to Monday for a Mon–Fri worker')
  const weekendShelfAfter = (await localBackend.listTasks()).data!.find((t) => t.id === weekendShelf.id)!
  assert(weekendShelfAfter.status === 'recurring' && weekendShelfAfter.due_date === '2026-10-05',
    'the weekend template stays on the shelf, anchor rolled to Monday')

  // A non-repeating card parked on the shelf just moves (no clone, no date/
  // occurrence math).
  const plainShelf = (await localBackend.createTask({
    worker_id: john.id, client_id: client.id, title: 'RS shelf plain', status: 'recurring',
    due_date: '2026-10-12',
  })).data!
  const plainStarted = (await localBackend.startRecurringOccurrence(plainShelf.id)).data!
  assert(plainStarted.id === plainShelf.id && plainStarted.status === 'todo' && plainStarted.due_date === '2026-10-12' && plainStarted.occurrence === null,
    'a non-repeating shelf card starts as a plain move (no clone, no date/occurrence change)')

  // A recurring shelf card with no due date has no anchor to advance from.
  const noAnchorCreated = (await localBackend.createTask({
    worker_id: john.id, client_id: client.id, title: 'RS no anchor', status: 'recurring',
    due_date: '2026-10-12', repeats: 'weekly',
  })).data!
  const noAnchor = (await localBackend.updateTask(noAnchorCreated.id, { due_date: null })).data!
  assert(noAnchor.due_date === null, 'legacy: a shelf card can hold no due date')
  const noAnchorStart = await localBackend.startRecurringOccurrence(noAnchor.id)
  assert(!!noAnchorStart.error && /due date/i.test(noAnchorStart.error!), 'a recurring shelf card without a due date cannot start an occurrence')

  // Guards: only shelf cards can start; workers only their own.
  const guard = await localBackend.startRecurringOccurrence(plainShelf.id)
  assert(!!guard.error, 'starting is refused for a card that is no longer on the shelf')
  const otherShelf = (await localBackend.createTask({
    worker_id: john.id, client_id: client.id, title: 'RS other worker', status: 'recurring',
    due_date: '2026-10-12', repeats: 'daily',
  })).data!
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const sarah = workers.find((w) => w.email === 'sarah@example.com')!
  const notMine = (await localBackend.createTask({
    worker_id: sarah.id, client_id: client.id, title: 'RS not mine', status: 'recurring',
    due_date: '2026-10-12', repeats: 'daily',
  })).data!
  await localBackend.signIn('john@example.com', 'worker123')
  const refused = await localBackend.startRecurringOccurrence(notMine.id)
  assert(!!refused.error, 'a worker cannot start someone else\'s shelf card')
  const ownOk = await localBackend.startRecurringOccurrence(otherShelf.id)
  assert(!ownOk.error, 'a worker CAN start their own shelf card')
  await localBackend.signIn('admin', 'admin.pipelinesync')

  // ---- 7. the shelf is not working area: KPI math excludes it ----
  // A shelf card with a PAST due date and a big estimate: it must not read
  // as overdue work, not count toward workload, and not count as active.
  const kpiShelf = (await localBackend.createTask({
    worker_id: john.id, client_id: client.id, title: 'RS kpi shelf', status: 'recurring',
    due_date: '2020-01-01', estimated_hours: 40, repeats: 'weekly',
  })).data!
  assert(kpi.isOverdueTask(kpiShelf) === false, 'a past-anchored shelf card is NOT overdue')
  assert(kpi.openEstimatedHours(kpiShelf) === 0, 'a shelf card contributes 0 hours to the workload math')
  const monthKey = new Date().toISOString().slice(0, 7)
  const rowWithShelf = kpi.computeEmployeeKpi({ worker: john, tasks: (await localBackend.listTasks()).data!, month: monthKey, goal: null })
  const rowWithoutShelf = kpi.computeEmployeeKpi({ worker: john, tasks: (await localBackend.listTasks()).data!.filter((t) => t.id !== kpiShelf.id), month: monthKey, goal: null })
  assert(rowWithShelf.activeCount === rowWithoutShelf.activeCount, 'a shelf card does not change the member\'s active task count')
  assert(rowWithShelf.workload.pct === rowWithoutShelf.workload.pct, 'a shelf card does not change the member\'s workload %')

  // ---- 8. the demo seed shows a shelf example ----
  const seededShelf = (await localBackend.listTasks()).data!.find((t) => t.title === 'Daily standup note — Acme Corp')
  assert(seededShelf && seededShelf.status === 'recurring' && seededShelf.repeats === 'daily', 'the demo seed carries a template on the Recurring shelf')

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll recurring-task checks passed.')
  if (failures) process.exitCode = 1
}

main()
