/**
 * Verification of "QA Required?" (demo-mode local backend, plus the pure rules
 * in src/lib/taskWorkflow.ts that every backend and the board UI share).
 *
 *   Yes → a plain worker cannot move the task to Completed, by ANY path
 *         (drag, › button, edit dialog, create-as-completed). Only the Owner and
 *         people with KPI access (`team_kpi.view`) can.
 *   No  → the worker moves it to Completed as before.
 *
 * New tasks default to Yes; tasks that predate the field read as No; only the
 * Owner / KPI access can set or change the flag.
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
  QA_COMPLETION_BLOCKED_MESSAGE,
  QA_SETTING_LOCKED_MESSAGE,
  defaultQaRequired,
  hydrateTask,
  isQaCompletionBlocked,
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
  assert(normalizeQaRequired(true) === true, 'true stays Yes')
  assert(normalizeQaRequired(false) === false, 'false stays No')
  assert(
    normalizeQaRequired(undefined) === false && normalizeQaRequired(null) === false && normalizeQaRequired('true') === false,
    'a missing / malformed value reads as No (legacy rows are never locked)',
  )

  const block = (qaRequired: boolean, from: Task['status'] | null, to: Task['status'], reviewer: boolean) =>
    isQaCompletionBlocked({ qaRequired, from, to }, reviewer)
  assert(block(true, 'in_progress', 'completed', false), 'worker + QA Yes: In Progress → Completed is blocked')
  assert(block(true, 'for_review', 'completed', false), 'worker + QA Yes: For Review → Completed is blocked too')
  assert(block(true, 'todo', 'completed', false), 'worker + QA Yes: To Do → Completed is blocked')
  assert(block(true, null, 'completed', false), 'worker + QA Yes: creating straight into Completed is blocked')
  assert(!block(true, 'in_progress', 'for_review', false), 'worker + QA Yes: sending it to For Review is always allowed')
  assert(!block(true, 'todo', 'in_progress', false), 'worker + QA Yes: every other stage stays open')
  assert(!block(true, 'completed', 'completed', false), 'worker + QA Yes: re-ordering inside Completed is not a move into it')
  assert(!block(false, 'in_progress', 'completed', false), 'worker + QA No: Completed is open')
  assert(!block(false, null, 'completed', false), 'worker + QA No: can create straight into Completed')
  assert(!block(true, 'for_review', 'completed', true), 'reviewer + QA Yes: Completed is open')

  assert(resolveNewTaskQaRequired(undefined, false, false, false).value === true, 'a new ONE-OFF task with no choice made requires QA')
  assert(resolveNewTaskQaRequired(undefined, false, false, true).value === false, 'a new REPEATING task with no choice made is QA-free')
  assert(resolveNewTaskQaRequired(true, false, false, false).error === null, 'a worker may (re)state Yes')
  assert(resolveNewTaskQaRequired(false, false, false, false).error === QA_SETTING_LOCKED_MESSAGE, 'a worker asking for No on a one-off task is refused')
  assert(resolveNewTaskQaRequired(false, false, false, true).error === null, 'a worker asking for No on a repeating task is stating its default')
  assert(resolveNewTaskQaRequired(false, true, false, false).error === null, 'a reviewer may choose No')
  assert(resolveNewTaskQaRequired(false, false, true, false).error === null, 'the next occurrence of a series may carry its No forward')

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
    'Sarah is a Supervisor: runs everyone\'s board but has no KPI access',
  )
  const seeded = (await localBackend.listTasks()).data!
  // (Seed ids are re-keyed when the workspace loads, so look the samples up by title.)
  const hero = seeded.find((t) => t.title === 'Redesign the landing page hero section')
  const q3 = seeded.find((t) => t.title === 'Draft Q3 summary report')
  assert(hero?.worker_id === john.id && hero.qa_required === true, "the sample hero redesign (John's) requires QA")
  assert(q3?.worker_id === sarah.id && q3.qa_required === false, "the sample Q3 report (Sarah's) does not")
  assert(seeded.every((t) => typeof t.qa_required === 'boolean'), 'every task carries a real Yes/No value')

  // ---------------------------------------------------------------- 3. creating
  console.log('\n--- 3. creating a task ---')
  const base = { due_date: '2099-12-31', client_id: null }
  const byAdminDefault = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-A admin default' })
  assert(!byAdminDefault.error && byAdminDefault.data!.qa_required === true, 'admin: a new task requires QA by default')
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
  assert(!johnOwn.error && johnOwn.data!.qa_required === true, 'worker: a task they create for themselves requires QA (the default)')
  const johnNoQa = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-F John asks No', qa_required: false })
  assert(johnNoQa.error === QA_SETTING_LOCKED_MESSAGE, 'worker: cannot create a task with QA Required = No')
  const johnYes = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-G John says Yes', qa_required: true })
  assert(!johnYes.error && johnYes.data!.qa_required === true, 'worker: stating Yes explicitly is harmless')
  const johnDone = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-H John completed', status: 'completed' })
  assert(johnDone.error === QA_COMPLETION_BLOCKED_MESSAGE, 'worker: cannot create a QA-required task straight into Completed')
  const johnReview = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-I John for review', status: 'for_review' })
  assert(!johnReview.error && johnReview.data!.status === 'for_review', 'worker: can create one in For Review')
  assert(
    !(await localBackend.listTasks()).data!.some((t) => t.title === 'QA-F John asks No' || t.title === 'QA-H John completed'),
    'the refused tasks were not stored',
  )

  // ---------------------------------------------------------------- 4. a worker and a QA-required task
  console.log('\n--- 4. worker vs a QA-required task ---')
  const t = johnOwn.data!
  const toDone = await localBackend.moveTask(t.id, 'completed', 0)
  assert(toDone.error === QA_COMPLETION_BLOCKED_MESSAGE, 'moveTask (drag / › button) into Completed is refused')
  let after = (await localBackend.listTasks()).data!.find((x) => x.id === t.id)!
  assert(after.status === 'in_progress' && after.completed_at == null, 'the refused move left the card where it was')
  const editToDone = await localBackend.updateTask(t.id, { status: 'completed' })
  assert(editToDone.error === QA_COMPLETION_BLOCKED_MESSAGE, 'updateTask (edit dialog) with status Completed is refused')
  after = (await localBackend.listTasks()).data!.find((x) => x.id === t.id)!
  assert(after.status === 'in_progress', 'the refused edit left the stage alone')

  const toReview = await localBackend.moveTask(t.id, 'for_review', 0)
  assert(!toReview.error && toReview.data!.status === 'for_review', 'worker: For Review is open')
  const reviewToDone = await localBackend.moveTask(t.id, 'completed', 0)
  assert(reviewToDone.error === QA_COMPLETION_BLOCKED_MESSAGE, 'worker: For Review → Completed is refused as well (QA is the reviewer\'s step)')

  const untick = await localBackend.updateTask(t.id, { qa_required: false })
  assert(untick.error === QA_SETTING_LOCKED_MESSAGE, 'worker: cannot untick QA Required on an existing task')
  const untickAndDone = await localBackend.updateTask(t.id, { qa_required: false, status: 'completed' })
  assert(untickAndDone.error, 'worker: cannot untick it and complete it in one save')
  after = (await localBackend.listTasks()).data!.find((x) => x.id === t.id)!
  assert(after.qa_required === true && after.status === 'for_review', 'neither attempt changed the task')
  const same = await localBackend.updateTask(t.id, { qa_required: true, title: 'QA-E John own task (renamed)' })
  assert(!same.error && same.data!.qa_required === true && same.data!.title.endsWith('(renamed)'), 'worker: re-sending the current value while editing is fine')
  const stray = await localBackend.updateTask(t.id, { qa_required: undefined, priority: 'high' })
  assert(!stray.error && stray.data!.qa_required === true && stray.data!.priority === 'high', 'a missing qa_required key never wipes the flag')

  // No QA: the worker completes it themselves.
  const adminForJohnNo = await (async () => {
    await localBackend.signIn('admin', 'admin.pipelinesync')
    return localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-J No-QA task', status: 'in_progress', qa_required: false })
  })()
  await localBackend.signIn('john@example.com', 'worker123')
  const noQaDone = await localBackend.moveTask(adminForJohnNo.data!.id, 'completed', 0)
  assert(!noQaDone.error && noQaDone.data!.status === 'completed' && !!noQaDone.data!.completed_at, 'QA No: the worker moves it to Completed')
  const noQaCreatedDone = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-K legacy-style', status: 'completed', qa_required: true })
  assert(noQaCreatedDone.error === QA_COMPLETION_BLOCKED_MESSAGE, 'but a worker still cannot create a Yes task into Completed')

  // ---------------------------------------------------------------- 5. the Owner decides
  console.log('\n--- 5. the Owner decides ---')
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const ownerDone = await localBackend.moveTask(t.id, 'completed', 0)
  assert(!ownerDone.error && ownerDone.data!.status === 'completed', 'admin: moves the QA-required task from For Review to Completed')

  await localBackend.signIn('john@example.com', 'worker123')
  const reorder = await localBackend.moveTask(t.id, 'completed', 0)
  assert(!reorder.error, 'worker: re-ordering a reviewed (Completed, QA Yes) card still works')
  const archive = await localBackend.updateTask(t.id, { archived_at: new Date().toISOString() })
  assert(!archive.error && archive.data!.archived_at != null, 'worker: can archive it')
  const restore = await localBackend.updateTask(t.id, { archived_at: null })
  assert(!restore.error && restore.data!.archived_at == null && restore.data!.status === 'completed', 'worker: can restore it to Completed')

  // The flag can be flipped both ways by the Owner.
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const flipTask = (await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-L flip me', status: 'in_progress' })).data!
  assert(flipTask.qa_required === true, 'admin-created task starts as Yes')
  const toNo = await localBackend.updateTask(flipTask.id, { qa_required: false })
  assert(!toNo.error && toNo.data!.qa_required === false, 'admin: Yes → No')
  await localBackend.signIn('john@example.com', 'worker123')
  const nowOpen = await localBackend.moveTask(flipTask.id, 'completed', 0)
  assert(!nowOpen.error && nowOpen.data!.status === 'completed', 'worker: completes it once the Owner set it to No')
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const flipBack = (await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-M flip back', status: 'in_progress', qa_required: false })).data!
  const toYes = await localBackend.updateTask(flipBack.id, { qa_required: true })
  assert(!toYes.error && toYes.data!.qa_required === true, 'admin: No → Yes')
  await localBackend.signIn('john@example.com', 'worker123')
  const nowLocked = await localBackend.moveTask(flipBack.id, 'completed', 0)
  assert(nowLocked.error === QA_COMPLETION_BLOCKED_MESSAGE, 'worker: is locked out as soon as the Owner sets it to Yes')

  // ---------------------------------------------------------------- 6. KPI access
  console.log('\n--- 6. KPI access (team_kpi.view) ---')
  // A Supervisor runs the board but does not hold KPI access: no way around QA.
  await localBackend.signIn('sarah@example.com', 'worker123')
  const supervisorMove = await localBackend.moveTask(flipBack.id, 'completed', 0)
  assert(supervisorMove.error === QA_COMPLETION_BLOCKED_MESSAGE, "Supervisor (tasks.manage_all, no KPI): cannot complete someone else's QA task either")
  const supervisorFlag = await localBackend.updateTask(flipBack.id, { qa_required: false })
  assert(supervisorFlag.error === QA_SETTING_LOCKED_MESSAGE, 'Supervisor: cannot change the flag')
  const supervisorCreate = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-N supervisor No', qa_required: false })
  assert(supervisorCreate.error === QA_SETTING_LOCKED_MESSAGE, 'Supervisor: cannot create a No task')

  // The Owner gives John KPI access.
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const granted = await localBackend.updateWorker(john.id, { permissions: ['team_kpi.view'] })
  assert(!granted.error && (granted.data?.permissions ?? []).includes('team_kpi.view'), 'admin grants John KPI access')
  await localBackend.signIn('john@example.com', 'worker123')
  const kpiMove = await localBackend.moveTask(flipBack.id, 'completed', 0)
  assert(!kpiMove.error && kpiMove.data!.status === 'completed', 'KPI access: can move a QA-required task to Completed')
  const kpiFlag = await localBackend.updateTask(kpiMove.data!.id, { qa_required: false })
  assert(!kpiFlag.error && kpiFlag.data!.qa_required === false, 'KPI access: can change the flag')
  const kpiCreateNo = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-O kpi No', qa_required: false })
  assert(!kpiCreateNo.error && kpiCreateNo.data!.qa_required === false, 'KPI access: can create a No task')
  const kpiCreateDone = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-P kpi done', status: 'completed', qa_required: true })
  assert(!kpiCreateDone.error && kpiCreateDone.data!.status === 'completed', 'KPI access: can create a QA-required task straight into Completed')

  // …and takes it back.
  await localBackend.signIn('admin', 'admin.pipelinesync')
  await localBackend.updateWorker(john.id, { permissions: [] })
  const lockedAgain = (await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-Q after revoke', status: 'in_progress' })).data!
  await localBackend.signIn('john@example.com', 'worker123')
  const revoked = await localBackend.moveTask(lockedAgain.id, 'completed', 0)
  assert(revoked.error === QA_COMPLETION_BLOCKED_MESSAGE, 'revoking KPI access puts the gate back')

  // ---------------------------------------------------------------- 7. repeating tasks
  console.log('\n--- 7. repeating tasks keep their setting ---')
  await localBackend.signIn('admin', 'admin.pipelinesync')
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
  assert(!nextNo.error && nextNo.data!.qa_required === false, '"Recreate next" by the worker keeps the series at No (no error, flag carried)')
  assert(nextNo.data!.series_id === weeklyNo.id, 'and it joins the same series')
  const nextNoDone = await localBackend.moveTask(nextNo.data!.id, 'completed', 0)
  assert(!nextNoDone.error, 'the new occurrence is completable by the worker')

  await localBackend.signIn('admin', 'admin.pipelinesync')
  const yesDone = await localBackend.moveTask(weeklyYes.id, 'completed', 0)
  assert(!yesDone.error, 'admin completes the QA-required weekly task')
  await localBackend.signIn('john@example.com', 'worker123')
  const planYes = planRecreate(yesDone.data!, [1, 2, 3, 4, 5])!
  const nextYes = await localBackend.createTask(planYes.input)
  assert(!nextYes.error && nextYes.data!.qa_required === true, '"Recreate next" of a Yes task stays Yes')
  const nextYesDone = await localBackend.moveTask(nextYes.data!.id, 'completed', 0)
  assert(nextYesDone.error === QA_COMPLETION_BLOCKED_MESSAGE, 'and the worker still cannot complete it')

  // Starting an occurrence from the Recurring shelf.
  await localBackend.signIn('admin', 'admin.pipelinesync')
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
  const shelfMoveBlocked = await localBackend.moveTask(startedYes.data!.id, 'completed', 0)
  assert(shelfMoveBlocked.error === QA_COMPLETION_BLOCKED_MESSAGE, 'and that Yes occurrence is gated like any other')

  // A WORKER's own repeating task: repeating work defaults to No QA, so the
  // card is theirs to finish — the whole point of the rule.
  await localBackend.signIn('john@example.com', 'worker123')
  const ownWeekly = (await localBackend.createTask({
    ...base, worker_id: john.id, title: 'QA-V worker weekly', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly',
  })).data!
  assert(ownWeekly.qa_required === false, 'worker: a repeating task they create defaults to No QA')
  const ownStart = await localBackend.startRecurringOccurrence(ownWeekly.id)
  assert(!ownStart.error && ownStart.data!.qa_required === false, 'its occurrence carries No forward')
  const ownDone = await localBackend.moveTask(ownStart.data!.id, 'completed', 0)
  assert(!ownDone.error && ownDone.data!.status === 'completed', 'and the worker moves it straight to Completed')
  const ownWeeklyNo = await localBackend.createTask({
    ...base, worker_id: john.id, title: 'QA-W worker weekly No', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly', qa_required: false,
  })
  assert(!ownWeeklyNo.error && ownWeeklyNo.data!.qa_required === false, 'worker: stating No on a repeating task is accepted (it is the default)')

  // A new ONE-OFF task from the same worker is unchanged: QA, gated.
  const ownOneOff = await localBackend.createTask({ ...base, worker_id: john.id, title: 'QA-X worker one-off' })
  assert(!ownOneOff.error && ownOneOff.data!.qa_required === true, 'worker: a one-off task still requires QA')
  const oneOffBlocked = await localBackend.moveTask(ownOneOff.data!.id, 'completed', 0)
  assert(oneOffBlocked.error === QA_COMPLETION_BLOCKED_MESSAGE, 'and the worker still cannot complete it')

  // The Owner can still opt a series in — Yes carries to its occurrence.
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const ownerYes = (await localBackend.createTask({
    ...base, worker_id: john.id, title: 'QA-Y owner weekly Yes', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly', qa_required: true,
  })).data!
  const ownerStart = await localBackend.startRecurringOccurrence(ownerYes.id)
  assert(!ownerStart.error && ownerStart.data!.qa_required === true, 'an opted-in series hands the worker a QA task')
  await localBackend.signIn('john@example.com', 'worker123')
  const ownerStartBlocked = await localBackend.moveTask(ownerStart.data!.id, 'completed', 0)
  assert(ownerStartBlocked.error === QA_COMPLETION_BLOCKED_MESSAGE, 'which the worker cannot complete')

  // ---------------------------------------------------------------- 8. tasks that predate the feature
  console.log('\n--- 8. tasks that predate the field ---')
  // Strip the field from every stored task, as a workspace saved by an older
  // version of the app would look.
  let stripped = 0
  for (const [key, raw] of [...mem.entries()]) {
    let parsed: any
    try { parsed = JSON.parse(raw) } catch { continue }
    if (parsed && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
      for (const task of parsed.tasks) { delete task.qa_required; stripped += 1 }
      mem.set(key, JSON.stringify(parsed))
    }
  }
  assert(stripped > 0, `removed qa_required from ${stripped} stored tasks`)
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const legacyRows = (await localBackend.listTasks()).data!
  assert(legacyRows.length === stripped && legacyRows.every((x) => x.qa_required === false), 'every legacy task loads as No')
  const reviewCard = legacyRows.find((x) => x.status === 'for_review' && x.worker_id === john.id) ?? legacyRows.find((x) => x.status === 'for_review')!
  const reviewOwner = workers.find((w) => w.id === reviewCard.worker_id)!
  await localBackend.signIn(reviewOwner.email, 'worker123')
  const legacyDone = await localBackend.moveTask(reviewCard.id, 'completed', 0)
  assert(!legacyDone.error && legacyDone.data!.status === 'completed', 'a worker completes a legacy task exactly as before')

  // ---------------------------------------------------------------- 9. repeating tasks from before the rule
  console.log('\n--- 9. repeating tasks from before the rule ---')
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

  // The Owner's later opt-in is not undone (the migration only runs once).
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const optedIn = await localBackend.updateTask(migratedShelf.id, { qa_required: true })
  assert(!optedIn.error && optedIn.data!.qa_required === true, 'the Owner can tick QA back on a repeating card')
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
