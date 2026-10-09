/**
 * Verification of "QA Required?" (demo-mode local backend, plus the pure rules
 * in src/lib/taskWorkflow.ts that every backend and the board UI share).
 *
 * "QA Required?" is a REQUEST for review, not a lock:
 *
 *   Yes → the card carries a "QA required" chip and is scored (1–5 + rework)
 *         by the Owner / `team_kpi.view` holders once it reaches For Review.
 *         Anyone who may edit the card can still complete it.
 *   No  → nothing to review.
 *
 * Anyone who may edit a card can tick or untick it — a worker on their own
 * board, a Supervisor on anyone's — and NO stage move is ever refused because
 * of the flag. QA SCORING still belongs to the Owner / KPI access.
 *
 * New one-off tasks default to Yes; repeating tasks default to No; tasks that
 * predate the field read as No.
 *
 * Run: npx tsx scripts/verify-qa-required-local.ts
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
import {
  DEFAULT_QA_REQUIRED,
  DEFAULT_RECURRING_QA_REQUIRED,
  defaultQaRequired,
  hydrateTask,
  isRecurringTask,
  normalizeQaRequired,
  planRecreate,
  resolveNewTaskQaRequired,
} from '../src/lib/taskWorkflow'

let failures = 0
const assert = (cond: unknown, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

async function main() {
  const { localBackend } = await import('../src/lib/localDb')

  // ---------------------------------------------------------------- 1. the pure rules
  console.log('\n--- 1. the shared rules ---')
  assert(DEFAULT_QA_REQUIRED === true, 'the default is Yes')
  assert(DEFAULT_RECURRING_QA_REQUIRED === false, 'the repeating default is No')
  assert(normalizeQaRequired(true) === true, 'true stays Yes')
  assert(normalizeQaRequired(false) === false, 'false stays No')
  assert(
    normalizeQaRequired(undefined) === false && normalizeQaRequired(null) === false && normalizeQaRequired('true') === false,
    'a missing / malformed value reads as No (legacy rows are never flagged)',
  )

  assert(resolveNewTaskQaRequired(undefined, false) === true, 'a new ONE-OFF task with no choice made asks for QA')
  assert(resolveNewTaskQaRequired(undefined, true) === false, 'a new REPEATING task with no choice made is QA-free')
  assert(resolveNewTaskQaRequired(false, false) === false, 'anyone may create a one-off task with QA Required = No')
  assert(resolveNewTaskQaRequired(true, true) === true, 'anyone may ask for QA on a repeating task')
  assert(resolveNewTaskQaRequired('maybe', false) === true, 'a malformed value falls back to the one-off default')
  assert(resolveNewTaskQaRequired('maybe', true) === false, 'a malformed value falls back to the repeating default')

  assert(isRecurringTask({ repeats: 'weekly', series_id: null }), 'a repeat interval marks a card as repeating')
  assert(isRecurringTask({ repeats: 'none', series_id: 't-1' }), 'a series id marks an occurrence as repeating')
  assert(!isRecurringTask({ repeats: 'none', series_id: null }), 'a plain card is not repeating')
  assert(defaultQaRequired({ repeats: 'weekly', series_id: null }) === false, 'the default for a repeating card is No QA')
  assert(defaultQaRequired({ repeats: 'none', series_id: null }) === true, 'the default for a one-off card is still Yes')

  const legacy = hydrateTask({ id: 'x', status: 'todo', created_at: '2026-01-01T00:00:00.000Z' } as unknown as Task)
  assert(legacy.qa_required === false, 'hydrateTask: a row without the field reads as No')
  const recurringDone = hydrateTask({
    id: 'r1', worker_id: 'w', client_id: null, title: 'Weekly report', description: null, status: 'completed',
    priority: 'medium', due_date: '2026-09-01', repeats: 'weekly', qa_required: false, occurrence: 1,
    created_at: '2026-08-01T00:00:00.000Z',
  } as unknown as Task)
  assert(planRecreate(recurringDone, [1, 2, 3, 4, 5])?.input.qa_required === false, 'planRecreate carries a No forward')
  assert(planRecreate({ ...recurringDone, qa_required: true }, [1, 2, 3, 4, 5])?.input.qa_required === true, 'planRecreate carries a Yes forward')

  // ---------------------------------------------------------------- 2. the demo workspace
  console.log('\n--- 2. the demo workspace ---')
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')
  const workers = (await localBackend.listWorkers()).data!
  const john = workers.find((w) => w.email === 'john@example.com')!
  const sarah = workers.find((w) => w.email === 'sarah@example.com')!
  assert(!(john.permissions ?? []).includes('team_kpi.view'), 'John is a plain worker (no KPI access)')
  assert(
    (sarah.permissions ?? []).includes('tasks.manage_all') && !(sarah.permissions ?? []).includes('team_kpi.view'),
    "Sarah is a Supervisor: runs everyone's board but has no KPI access",
  )
  const seeded = (await localBackend.listTasks()).data!
  // (Seed ids are re-keyed when the workspace loads, so look the samples up by title.)
  const hero = seeded.find((t) => t.title === 'Redesign the landing page hero section')
  const q3 = seeded.find((t) => t.title === 'Draft Q3 summary report')
  assert(hero?.worker_id === john.id && hero.qa_required === true, "the sample hero redesign (John's) asks for QA")
  assert(q3?.worker_id === sarah.id && q3.qa_required === false, "the sample Q3 report (Sarah's) does not")
  assert(seeded.every((t) => typeof t.qa_required === 'boolean'), 'every task carries a real Yes/No value')

  // ---------------------------------------------------------------- 3. creating
  console.log('\n--- 3. creating a task ---')
  const base = { due_date: '2099-12-31', client_id: null }
  const byAdminDefault = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-A admin default' })
  assert(!byAdminDefault.error && byAdminDefault.data!.qa_required === true, 'admin: a new task asks for QA by default')
  const byAdminNo = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-B admin says No', qa_required: false })
  assert(!byAdminNo.error && byAdminNo.data!.qa_required === false, 'admin: can untick QA Required on a new task')
  const byAdminYes = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-C admin says Yes', qa_required: true })
  assert(!byAdminYes.error && byAdminYes.data!.qa_required === true, 'admin: can tick QA Required on a new task')
  const stored = (await localBackend.listTasks()).data!
  assert(stored.find((t) => t.id === byAdminNo.data!.id)?.qa_required === false, 'the choice persists (read back from storage)')

  const adminCompleted = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-D admin completed', status: 'completed' })
  assert(!adminCompleted.error && adminCompleted.data!.status === 'completed', 'admin: can create a QA-required task straight into Completed')

  const johnIn = await localBackend.signIn('john@example.com', 'worker123')
  assert(!johnIn.error && johnIn.data?.role === 'worker', 'John signs in')
  const johnOwn = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-E John own task', status: 'in_progress' })
  assert(!johnOwn.error && johnOwn.data!.qa_required === true, 'worker: a task they create for themselves asks for QA (the default)')
  const johnNoQa = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-F John asks No', qa_required: false })
  assert(!johnNoQa.error && johnNoQa.data!.qa_required === false, 'worker: CAN create a task with QA Required = No (the tick is open to everyone)')
  const johnYes = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-G John says Yes', status: 'recurring', repeats: 'weekly', qa_required: true })
  assert(!johnYes.error && johnYes.data!.qa_required === true, 'worker: can tick Yes on a repeating task too')
  const johnDone = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-H John completed', status: 'completed' })
  assert(!johnDone.error && johnDone.data!.status === 'completed' && johnDone.data!.qa_required === true, 'worker: can create a QA-required task straight into Completed')
  const johnReview = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-I John for review', status: 'for_review' })
  assert(!johnReview.error && johnReview.data!.status === 'for_review', 'worker: can create one in For Review')

  // ---------------------------------------------------------------- 4. anyone may switch the tick, nothing is gated
  console.log('\n--- 4. the worker and the QA tick ---')
  const t = johnOwn.data!
  const toDone = await localBackend.moveTask(t.id, 'completed', 0)
  assert(!toDone.error && toDone.data!.status === 'completed' && !!toDone.data!.completed_at, 'worker: moveTask (drag / › button) into Completed works with QA Yes')
  const backToWork = await localBackend.moveTask(t.id, 'in_progress', 0)
  assert(!backToWork.error && backToWork.data!.status === 'in_progress', 'worker: moves it back out of Completed')
  const editToDone = await localBackend.updateTask(t.id, { status: 'completed' })
  assert(!editToDone.error && editToDone.data!.status === 'completed', 'worker: updateTask (edit dialog) into Completed works too')
  const toReview = await localBackend.moveTask(t.id, 'for_review', 0)
  assert(!toReview.error && toReview.data!.status === 'for_review', 'worker: For Review is open')
  const reviewToDone = await localBackend.moveTask(t.id, 'completed', 0)
  assert(!reviewToDone.error && reviewToDone.data!.status === 'completed', 'worker: For Review → Completed is theirs to make as well')

  const untick = await localBackend.updateTask(t.id, { qa_required: false })
  assert(!untick.error && untick.data!.qa_required === false, 'worker: CAN untick QA Required on their own task')
  const retick = await localBackend.updateTask(t.id, { qa_required: true })
  assert(!retick.error && retick.data!.qa_required === true, 'worker: and tick it back on')
  const untickAndDone = await localBackend.updateTask(t.id, { qa_required: false, status: 'in_progress' })
  assert(!untickAndDone.error && untickAndDone.data!.qa_required === false && untickAndDone.data!.status === 'in_progress', 'worker: untick + stage change in one save')
  const same = await localBackend.updateTask(t.id, { qa_required: false, title: 'QA-E John own task (renamed)' })
  assert(!same.error && same.data!.title.endsWith('(renamed)'), 'worker: re-sending the value while editing is fine')
  const stray = await localBackend.updateTask(t.id, { qa_required: undefined, priority: 'high' })
  assert(!stray.error && stray.data!.qa_required === false && stray.data!.priority === 'high', 'a missing qa_required key never wipes the flag')

  // Scoring stays the reviewers' call, even though the tick does not.
  const scoreByWorker = await localBackend.updateTask(t.id, { qa_score: 5 })
  assert(!!scoreByWorker.error && /score QA/.test(scoreByWorker.error), 'worker: still cannot SCORE QA (only the Owner / KPI access can)')

  // Someone else's card is still off limits without tasks.manage_all.
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const sarahTask = (await localBackend.createTask({ ...base, worker_id: sarah.id, title: 'QA-K1 Sarah task', qa_required: false })).data!
  await localBackend.signIn('john@example.com', 'worker123')
  const someoneElses = await localBackend.updateTask(sarahTask.id, { qa_required: true })
  assert(!!someoneElses.error && /own tasks/.test(someoneElses.error), "worker: cannot touch another worker's task, tick included")
  const someoneElsesMove = await localBackend.moveTask(sarahTask.id, 'completed', 0)
  assert(!!someoneElsesMove.error, "worker: cannot move another worker's task either")

  // ---------------------------------------------------------------- 5. the Owner and a Supervisor
  console.log('\n--- 5. the Owner / a Supervisor ---')
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const flipTask = (await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-L flip me', status: 'in_progress' })).data!
  assert(flipTask.qa_required === true, 'admin-created task starts as Yes')
  const toNo = await localBackend.updateTask(flipTask.id, { qa_required: false })
  assert(!toNo.error && toNo.data!.qa_required === false, 'admin: Yes → No')
  const toYes = await localBackend.updateTask(flipTask.id, { qa_required: true })
  assert(!toYes.error && toYes.data!.qa_required === true, 'admin: No → Yes')

  // The Supervisor runs everyone's board but holds no KPI access — the tick is
  // theirs to switch, the QA score is not.
  await localBackend.signIn('sarah@example.com', 'worker123')
  const supervisorFlag = await localBackend.updateTask(flipTask.id, { qa_required: false })
  assert(!supervisorFlag.error && supervisorFlag.data!.qa_required === false, "Supervisor (tasks.manage_all, no KPI): can switch the tick on someone else's card")
  const supervisorCreate = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-N supervisor No', qa_required: false })
  assert(!supervisorCreate.error && supervisorCreate.data!.qa_required === false, 'Supervisor: can create a No task')
  const supervisorMove = await localBackend.moveTask(flipTask.id, 'completed', 0)
  assert(!supervisorMove.error && supervisorMove.data!.status === 'completed', "Supervisor: can complete someone else's task regardless of the tick")
  const supervisorScore = await localBackend.updateTask(flipTask.id, { qa_score: 4 })
  assert(!!supervisorScore.error && /score QA/.test(supervisorScore.error), 'Supervisor: still cannot score QA')

  // KPI access keeps the scoring, nothing else.
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const granted = await localBackend.updateWorker(john.id, { permissions: ['team_kpi.view'] })
  assert(!granted.error && (granted.data?.permissions ?? []).includes('team_kpi.view'), 'admin grants John KPI access')
  await localBackend.signIn('john@example.com', 'worker123')
  const kpiScore = await localBackend.updateTask(flipTask.id, { qa_score: 5 })
  assert(!kpiScore.error && kpiScore.data!.qa_score === 5, 'KPI access: can score QA')
  const kpiFlag = await localBackend.updateTask(flipTask.id, { qa_required: true })
  assert(!kpiFlag.error && kpiFlag.data!.qa_required === true, 'KPI access: can change the flag (as before)')
  const kpiCreateNo = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-O kpi No', qa_required: false })
  assert(!kpiCreateNo.error && kpiCreateNo.data!.qa_required === false, 'KPI access: can create a No task')
  await localBackend.signIn('admin', 'admin.pipelinesync')
  await localBackend.updateWorker(john.id, { permissions: [] })

  // ---------------------------------------------------------------- 6. repeating tasks
  console.log('\n--- 6. repeating tasks keep their setting ---')
  const weeklyNo = (await localBackend.createTask({
    ...base, worker_id: john.id, title: 'QA-R weekly No', status: 'in_progress', due_date: '2026-09-01', repeats: 'weekly', qa_required: false,
  })).data!
  const weeklyYes = (await localBackend.createTask({
    ...base, worker_id: john.id, title: 'QA-S weekly Yes', status: 'in_progress', due_date: '2026-09-01', repeats: 'weekly', qa_required: true,
  })).data!
  await localBackend.signIn('john@example.com', 'worker123')
  const weeklyNoDone = await localBackend.moveTask(weeklyNo.id, 'completed', 0)
  assert(!weeklyNoDone.error, 'worker: completes the No-QA weekly task')
  const planNo = planRecreate(weeklyNoDone.data!, [1, 2, 3, 4, 5])!
  const nextNo = await localBackend.createTask(planNo.input)
  assert(!nextNo.error && nextNo.data!.qa_required === false, '"Recreate next" by the worker keeps the series at No (flag carried)')
  assert(nextNo.data!.series_id === weeklyNo.id, 'and it joins the same series')
  const nextNoDone = await localBackend.moveTask(nextNo.data!.id, 'completed', 0)
  assert(!nextNoDone.error, 'the new occurrence is completable by the worker')

  const yesDone = await localBackend.moveTask(weeklyYes.id, 'completed', 0)
  assert(!yesDone.error, 'admin-created Yes weekly task is completable by the worker too (nothing is locked)')
  const planYes = planRecreate(yesDone.data!, [1, 2, 3, 4, 5])!
  const nextYes = await localBackend.createTask(planYes.input)
  assert(!nextYes.error && nextYes.data!.qa_required === true, '"Recreate next" of a Yes task stays Yes')
  const nextYesDone = await localBackend.moveTask(nextYes.data!.id, 'completed', 0)
  assert(!nextYesDone.error && nextYesDone.data!.qa_required === true, 'and the worker completes it with the chip still on')

  // Starting an occurrence from the Recurring shelf.
  const shelfNo = (await localBackend.createTask({
    ...base, worker_id: john.id, title: 'QA-T shelf No', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly', qa_required: false,
  })).data!
  const shelfYes = (await localBackend.createTask({
    ...base, worker_id: john.id, title: 'QA-U shelf Yes', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly', qa_required: true,
  })).data!
  await localBackend.signIn('john@example.com', 'worker123')
  const startedNo = await localBackend.startRecurringOccurrence(shelfNo.id)
  assert(!startedNo.error && startedNo.data!.qa_required === false, 'starting an occurrence of a No shelf card gives a No task')
  const startedYes = await localBackend.startRecurringOccurrence(shelfYes.id)
  assert(!startedYes.error && startedYes.data!.qa_required === true, 'starting an occurrence of a Yes shelf card gives a Yes task')
  const shelfMove = await localBackend.moveTask(startedYes.data!.id, 'completed', 0)
  assert(!shelfMove.error && shelfMove.data!.status === 'completed', 'and that Yes occurrence completes like any other')

  // A WORKER's own repeating task defaults to No QA (routine work).
  const ownWeekly = (await localBackend.createTask({
    ...base, worker_id: john.id, title: 'QA-V worker weekly', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly',
  })).data!
  assert(ownWeekly.qa_required === false, 'worker: a repeating task they create defaults to No QA')
  const ownStart = await localBackend.startRecurringOccurrence(ownWeekly.id)
  assert(!ownStart.error && ownStart.data!.qa_required === false, 'its occurrence carries No forward')
  const ownDone = await localBackend.moveTask(ownStart.data!.id, 'completed', 0)
  assert(!ownDone.error && ownDone.data!.status === 'completed', 'and the worker moves it straight to Completed')
  const ownWeeklyYes = await localBackend.createTask({
    ...base, worker_id: john.id, title: 'QA-W worker weekly Yes', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly', qa_required: true,
  })
  assert(!ownWeeklyYes.error && ownWeeklyYes.data!.qa_required === true, 'worker: can ask for QA on their own repeating card')

  // A new ONE-OFF task from the same worker asks for QA by default.
  const ownOneOff = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-X worker one-off' })
  assert(!ownOneOff.error && ownOneOff.data!.qa_required === true, 'worker: a one-off task still asks for QA by default')

  // The Owner's opt-in on a series carries to its occurrence.
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const ownerYes = (await localBackend.createTask({
    ...base, worker_id: john.id, title: 'QA-Y owner weekly Yes', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly', qa_required: true,
  })).data!
  const ownerStart = await localBackend.startRecurringOccurrence(ownerYes.id)
  assert(!ownerStart.error && ownerStart.data!.qa_required === true, 'an opted-in series hands the worker a QA task')

  // ---------------------------------------------------------------- 7. tasks that predate the feature
  console.log('\n--- 7. tasks that predate the field ---')
  // Strip the field from every stored task, as a workspace saved by an older
  // version of the app would look.
  let stripped = 0
  const storedIds = new Set<string>()
  for (const [key, raw] of [...mem.entries()]) {
    let parsed: any
    try { parsed = JSON.parse(raw) } catch { continue }
    if (parsed && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
      for (const task of parsed.tasks) { delete task.qa_required; storedIds.add(task.id); stripped += 1 }
      mem.set(key, JSON.stringify(parsed))
    }
  }
  assert(stripped > 0, `removed qa_required from ${stripped} stored tasks`)
  await localBackend.signIn('admin', 'admin.pipelinesync')
  // A read can also carry a Recurring-shelf cycle into the current month; those
  // new cards are not legacy rows, but they must load as No all the same.
  const loaded = (await localBackend.listTasks()).data!
  const legacyRows = loaded.filter((x) => storedIds.has(x.id))
  const carriedRows = loaded.filter((x) => !storedIds.has(x.id))
  assert(legacyRows.length === stripped && legacyRows.every((x) => x.qa_required === false), 'every legacy task loads as No')
  assert(carriedRows.every((x) => x.qa_required === false), 'a cycle carried into this month loads as No as well')
  const reviewCard = legacyRows.find((x) => x.status === 'for_review' && x.worker_id === john.id) ?? legacyRows.find((x) => x.status === 'for_review')!
  const reviewOwner = workers.find((w) => w.id === reviewCard.worker_id)!
  await localBackend.signIn(reviewOwner.email, 'worker123')
  const legacyDone = await localBackend.moveTask(reviewCard.id, 'completed', 0)
  assert(!legacyDone.error && legacyDone.data!.status === 'completed', 'a worker completes a legacy task exactly as before')

  // ---------------------------------------------------------------- 8. repeating tasks from before the rule
  console.log('\n--- 8. repeating tasks from before the rule ---')
  // A one-off card with QA switched on, to prove the migration leaves it alone.
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const keepYes = (await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-Z one-off keeps Yes' })).data!
  assert(keepYes.qa_required === true, 'a new one-off task still defaults to Yes')
  // An older workspace: every repeating card carries QA Required = Yes (what
  // this app used to store) and the one-time marker is missing. The next read
  // should switch exactly those cards off.
  let oldRecurring = 0
  for (const [key, raw] of [...mem.entries()]) {
    let parsed: any
    try { parsed = JSON.parse(raw) } catch { continue }
    if (parsed && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
      delete parsed.recurringQaMigrated
      for (const task of parsed.tasks) {
        if ((task.repeats && task.repeats !== 'none') || task.series_id) {
          task.qa_required = true
          oldRecurring += 1
        }
      }
      mem.set(key, JSON.stringify(parsed))
    }
  }
  assert(oldRecurring > 0, `an old workspace with ${oldRecurring} QA-required repeating tasks is loaded`)
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const migrated = (await localBackend.listTasks()).data!
  const migratedRecurring = migrated.filter((t) => isRecurringTask(t))
  assert(
    migratedRecurring.length > 0 && migratedRecurring.every((t) => t.qa_required === false),
    'every repeating task in it loads as No QA (the one-time flip)',
  )
  assert(migrated.find((t) => t.id === keepYes.id)?.qa_required === true, 'and a one-off task keeps the QA setting it had')

  const migratedShelf = migratedRecurring.find((t) => t.status === 'recurring' && t.worker_id === john.id)!
  await localBackend.signIn('john@example.com', 'worker123')
  const migratedStart = await localBackend.startRecurringOccurrence(migratedShelf.id)
  assert(!migratedStart.error && migratedStart.data!.qa_required === false, 'an occurrence started from a migrated shelf card is No QA')
  const migratedDone = await localBackend.moveTask(migratedStart.data!.id, 'completed', 0)
  assert(!migratedDone.error && migratedDone.data!.status === 'completed', 'and the worker completes it')

  // A later opt-in is not undone (the migration only runs once).
  const optedIn = await localBackend.updateTask(migratedShelf.id, { qa_required: true })
  assert(!optedIn.error && optedIn.data!.qa_required === true, 'a worker can tick QA back on a repeating card')
  const afterOptIn = (await localBackend.listTasks()).data!.find((t) => t.id === optedIn.data!.id)!
  assert(afterOptIn.qa_required === true, 'and the one-time flip does not switch it off again')

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll QA Required (local backend) checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
