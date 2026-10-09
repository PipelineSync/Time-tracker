/**
 * Verification of the recurring carry-over into a new month (local backend):
 *  - the planner: a Recurring-shelf template whose cycle is in an earlier month
 *    gets this month's cycle; the first cycle in the month is the one created;
 *    skipped months are not back-filled; nothing is created for a series that
 *    already has a card this month, an ended series, a template that is not on
 *    the shelf, or a viewer who may not write the template
 *  - applying a plan moves the template's anchor, so the same cycle is never
 *    created twice, and deleting the carried card does not bring it back
 *  - through the backend: the first read in a month carries the cycle onto the
 *    board (To Do, top of the column, same series, no notification), later
 *    reads add nothing, a worker only ever carries their own templates
 *
 * Run: npx tsx scripts/verify-task-carryover-local.ts
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
import { planRecurringCarryOver, RECURRING_CARRY_OVER_ACTOR, type CarryOverPlan } from '../src/lib/taskCarryOver'

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

const MON_FRI = [1, 2, 3, 4, 5]
const TODAY = '2026-10-09'
const ANY = () => true

/** A full Task row from a partial — the planner reads a handful of fields. */
function mkTask(over: Partial<Task> & { id: string }): Task {
  const now = '2026-06-01T09:00:00.000Z'
  return {
    worker_id: 'w1',
    client_id: 'c1',
    title: 'Monthly report',
    description: 'Same every month',
    status: 'recurring',
    priority: 'high',
    start_date: '2026-06-01',
    due_date: '2026-09-28',
    original_due_date: null,
    estimated_hours: 2,
    qa_required: false,
    repeats: 'monthly',
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
    created_by_role: 'admin',
    completed_at: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    ...over,
  } as Task
}

const plan = (tasks: Task[], opts: { today?: string; canWrite?: (t: Task) => boolean } = {}) =>
  planRecurringCarryOver({
    tasks,
    today: opts.today ?? TODAY,
    workdaysOf: () => MON_FRI,
    canWrite: opts.canWrite ?? ANY,
  })

/** Carry a plan onto a task list the way the backends do: a card, and the template's anchor moves. */
function apply(tasks: Task[], plans: CarryOverPlan[]): Task[] {
  const next = tasks.map((t) => ({ ...t }))
  for (const p of plans) {
    const template = next.find((t) => t.id === p.templateId)!
    next.push(
      mkTask({
        id: `card-${p.due}-${p.templateId}`,
        status: 'todo',
        due_date: p.due,
        occurrence: p.occurrence,
        series_id: p.input.series_id ?? null,
        repeats: 'monthly',
        created_by_role: template.created_by_role,
      }),
    )
    template.due_date = p.due
    template.occurrence = p.occurrence
  }
  return next
}

// ---- 1. The planner ---------------------------------------------------------
console.log('\n--- The planner ---')

const monthly = mkTask({ id: 'rep', due_date: '2026-09-28' })
const first = plan([monthly])
assert(first.length === 1, 'a shelf template anchored last month is carried into this month')
assert(first[0].due === '2026-10-28' && first[0].occurrence === 1, 'the carried cycle is the next monthly date, occurrence #1')
const input = first[0].input
assert(input.status === 'todo' && input.worker_id === 'w1' && input.client_id === 'c1', 'the card is To Do, for the same worker and client')
assert(input.title === 'Monthly report' && input.description === 'Same every month' && input.priority === 'high', 'the card keeps title, description and priority')
assert(input.estimated_hours === 2 && input.repeats === 'monthly' && input.qa_required === false, 'the card keeps estimate, interval and QA setting')
assert(input.series_id === 'rep' && input.start_date === TODAY && input.due_date === '2026-10-28', 'the card joins the template\'s series and starts today')

const alreadyThisMonth = mkTask({ id: 'a1', due_date: '2026-10-02' })
assert(plan([alreadyThisMonth]).length === 0, 'a template whose cycle is already this month carries nothing')
const future = mkTask({ id: 'a2', due_date: '2026-11-02' })
assert(plan([future]).length === 0, 'a template anchored in a later month carries nothing')

const onBoard = mkTask({ id: 'b1', status: 'todo', due_date: '2026-09-28', repeats: 'monthly' })
assert(plan([onBoard]).length === 0, 'only Recurring-shelf templates carry over; a series on the board keeps its manual step')
const oneOff = mkTask({ id: 'b2', repeats: 'none', due_date: '2026-09-28' })
assert(plan([oneOff]).length === 0, 'a one-off card parked on the shelf does not repeat, so it carries nothing')
const archived = mkTask({ id: 'b3', archived_at: '2026-09-30T10:00:00.000Z' })
assert(plan([archived]).length === 0, 'an archived template is left alone')
const undated = mkTask({ id: 'b4', due_date: null })
assert(plan([undated]).length === 0, 'a template with no date has no cycle to carry')
assert(plan([monthly], { canWrite: () => false }).length === 0, 'a viewer who may not write the template does not carry it')

// A monthly template idle since January: one card, in October, nothing back-filled.
// (Weekend rolls move the series on by a day each time they happen; that is the
// recurrence rule the rest of the tracker uses, so only the month is asserted.)
const longIdle = mkTask({ id: 'idle', due_date: '2026-01-15' })
const idle = plan([longIdle])
assert(idle.length === 1 && idle[0].due.startsWith('2026-10-'), 'a template idle since January is carried to a single cycle in this month, not back-filled')
const daily = mkTask({ id: 'daily', due_date: '2026-09-30', repeats: 'daily' })
assert(plan([daily])[0].due === '2026-10-01', 'a daily template carries to the first day of the month')
const dailyIdle = mkTask({ id: 'daily-idle', due_date: '2026-01-15', repeats: 'daily' })
assert(plan([dailyIdle])[0].due === '2026-10-01', 'a daily template idle since January lands on the first of this month')
const weekly = mkTask({ id: 'weekly', due_date: '2026-09-26', repeats: 'weekly' })
assert(plan([weekly])[0].due === '2026-10-05', 'a weekly template that lands on a Saturday rolls to Monday for a Mon–Fri worker')
const monthEnd = mkTask({ id: 'end', due_date: '2026-09-30', repeats: 'monthly' })
assert(plan([monthEnd])[0].due === '2026-10-30', 'a monthly template anchored on the 30th keeps the 30th')

const ended = mkTask({ id: 'ended', due_date: '2026-09-28', repeat_until: '2026-10-10' })
assert(plan([ended]).length === 0, 'a series that ends before the cycle date is not carried')
const endsLater = mkTask({ id: 'ok-end', due_date: '2026-09-28', repeat_until: '2026-10-31' })
assert(plan([endsLater]).length === 1, 'a series that ends after the cycle date is carried')

const withOccurrence = mkTask({ id: 'occ', due_date: '2026-09-28', occurrence: 4 })
const counted = plan([withOccurrence])
assert(counted[0].occurrence === 5, 'the carried card takes the next occurrence number')
const cardAlready = mkTask({ id: 'occ-card', status: 'todo', due_date: '2026-10-20', series_id: 'occ', repeats: 'monthly' })
assert(plan([withOccurrence, cardAlready]).length === 0, 'a series that already has a card due this month is not carried twice')

// 15 Nov 2026 is a Sunday, so the cycle rolls to Monday the 16th.
const nextMonth = plan([mkTask({ id: 'nov', due_date: '2026-10-15' })], { today: '2026-11-01' })
assert(nextMonth.length === 1 && nextMonth[0].due === '2026-11-16', 'on the first of the next month the cycle carries forward again')
assert(plan([mkTask({ id: 'oct', due_date: '2026-09-28' })], { today: '2026-10-31' })[0].due === '2026-10-28', 'the planner judges the month of "today", not the first day')

// Two shelf cards in one series (a card returned to the shelf keeps its series):
// only the template with the latest anchor carries, so the cycle is made once.
const rootTemplate = mkTask({ id: 'series-root', due_date: '2026-09-28' })
const returned = mkTask({ id: 'series-returned', due_date: '2026-09-30', series_id: 'series-root', occurrence: 3 })
const both = plan([rootTemplate, returned])
assert(both.length === 1, 'two shelf cards in one series make one cycle, not two')
assert(both[0].templateId === 'series-returned' && both[0].due === '2026-10-30', 'the template with the latest anchor is the one that carries')

// ---- 2. Applying a plan is idempotent, and a deleted card stays deleted -----
console.log('\n--- Applying a plan ---')
const once = apply([monthly], first)
assert(plan(once).length === 0, 'after the card is created, the same month carries nothing more')
assert(once.find((t) => t.id === 'rep')!.due_date === '2026-10-28', 'the template\'s anchor moved to the carried cycle')
const withoutCard = once.filter((t) => t.id !== `card-2026-10-28-rep`)
assert(plan(withoutCard).length === 0, 'deleting the carried card does not bring it back: the anchor already moved')
// 28 Nov 2026 is a Saturday: the cycle rolls to Monday the 30th.
const nextTime = plan(apply([monthly], first), { today: '2026-11-02' })
assert(nextTime.length === 1 && nextTime[0].due === '2026-11-30', 'next month the cycle is carried as usual')

// ---- 3. Through the local backend ------------------------------------------
console.log('\n--- Through the backend ---')
async function backendChecks() {
  const { localBackend } = await import('../src/lib/localDb')

  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin signs in (auto-seeds the demo workspace)')
  const workers = (await localBackend.listWorkers()).data!
  const john = workers.find((w) => w.email === 'john@example.com')!
  const sarah = workers.find((w) => w.email === 'sarah@example.com')!
  const client = (await localBackend.listClients()).data!.find((c) => c.status === 'active')!

  // The anchor sits in the previous calendar month (the 15th), so the first read
  // this month carries its cycle; the cycle is the 15th of this month.
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15)
  const anchor = `${lastMonth.getFullYear()}-${pad(lastMonth.getMonth() + 1)}-15`
  const thisMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
  const expectedDue = `${thisMonth}-15`

  const template = (await localBackend.createTask({
    worker_id: john.id, client_id: client.id, title: 'CO monthly close', status: 'recurring',
    due_date: anchor, priority: 'medium', estimated_hours: 1, repeats: 'monthly',
  })).data!
  assert(template.status === 'recurring', 'a monthly template is parked on the Recurring shelf')

  const cardsOf = (rows: Task[]) => rows.filter((t) => t.series_id === template.id && t.status === 'todo')
  // Notifications for John before the first read: a carry-over must add none.
  await localBackend.signIn('john@example.com', 'worker123')
  const notesBefore = (await localBackend.listNotifications(500)).data!.length
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const firstRead = (await localBackend.listTasks()).data!
  await localBackend.signIn('john@example.com', 'worker123')
  const notesAfter = (await localBackend.listNotifications(500)).data!.length
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const created = cardsOf(firstRead)
  assert(created.length === 1, 'the first read this month puts one card for this month on the board')
  assert(created[0].due_date === expectedDue && created[0].occurrence === 1, 'the card is due on this month\'s cycle date, occurrence #1')
  assert(created[0].position === 0 && created[0].worker_id === john.id, 'the card sits at the top of John\'s To Do')
  assert(created[0].title === 'CO monthly close' && created[0].repeats === 'monthly', 'the card keeps the template\'s title and interval')
  assert(JSON.stringify(created[0].stage_history).includes(RECURRING_CARRY_OVER_ACTOR), 'the card\'s history says it was carried over, not started by a person')
  const anchorNow = firstRead.find((t) => t.id === template.id)!
  assert(anchorNow.status === 'recurring' && anchorNow.due_date === expectedDue && anchorNow.occurrence === 1, 'the template stays on the shelf, its anchor moved to the cycle')

  const secondRead = (await localBackend.listTasks()).data!
  assert(cardsOf(secondRead).length === 1, 'a later read finds the cycle already there: no duplicate')

  const deleted = await localBackend.deleteTask(created[0].id)
  assert(!deleted.error, 'the carried card can be deleted')
  const afterDelete = (await localBackend.listTasks()).data!
  assert(cardsOf(afterDelete).length === 0, 'the deleted card does not come back on the next read')

  // Starting an occurrence by hand still works after a carry-over: it moves the anchor on.
  const started = (await localBackend.startRecurringOccurrence(template.id)).data!
  assert(started.due_date && started.due_date > expectedDue, 'a manual start after the carry-over schedules the following cycle')

  // A worker only carries their own templates. Sarah's template is left for an admin read.
  const sarahTemplate = (await localBackend.createTask({
    worker_id: sarah.id, client_id: client.id, title: 'CO sarah close', status: 'recurring',
    due_date: anchor, priority: 'medium', estimated_hours: 1, repeats: 'monthly',
  })).data!
  await localBackend.signIn('john@example.com', 'worker123')
  const asJohn = (await localBackend.listTasks()).data!
  assert(!asJohn.some((t) => t.series_id === sarahTemplate.id && t.status === 'todo'), 'a worker\'s read does not carry someone else\'s template')
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const asAdmin = (await localBackend.listTasks()).data!
  assert(asAdmin.some((t) => t.series_id === sarahTemplate.id && t.status === 'todo' && t.due_date === expectedDue), 'the admin read carries Sarah\'s template into this month')
  assert(asAdmin.find((t) => t.id === sarahTemplate.id)?.due_date === expectedDue, 'and moves her template\'s anchor the same way')

  // Carrying over is not an assignment: John is not notified when the cycle lands.
  assert(notesAfter === notesBefore, 'carrying a template over sends no notification to the worker')
}

await backendChecks()

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll recurring carry-over checks passed.')
process.exitCode = failures ? 1 : 0
