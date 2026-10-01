/**
 * Verification of "QA Required?" against the Supabase backend (the REAL
 * src/lib/supabaseDb.ts, pointed at the in-memory mock client).
 *
 *   Yes → a plain worker cannot move the task to Completed, by any path. Only
 *         the Owner and people with KPI access (`team_kpi.view`) can.
 *   No  → the worker completes it as before.
 *
 * These are the app-side checks (the friendly refusals). The same rules are
 * enforced again inside the database by supabase/RUN-THIS-task-qa-required.sql,
 * which is exercised separately against a real Postgres.
 *
 * Run: npx tsx scripts/verify-qa-required-supabase.ts
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { state, resetState } from './supabase-mock/mock-supabase.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcFile = path.join(root, 'src', 'lib', 'supabaseDb.ts')
const tmpFile = path.join(root, 'src', 'lib', '__test_qa_supabaseDb_tmp.ts')

// Load the REAL module source with two substitutions:
//  - Vite's import.meta.env → a global we control
//  - @supabase/supabase-js  → our mock client
let mod: typeof import('../src/lib/supabaseDb')
try {
  const source = readFileSync(srcFile, 'utf8')
    .replaceAll('import.meta.env', 'globalThis.__VITE_ENV__')
    .replaceAll(`from '@supabase/supabase-js'`, `from '../../scripts/supabase-mock/mock-supabase.mjs'`)
  writeFileSync(tmpFile, source)
  globalThis.__VITE_ENV__ = {
    VITE_SUPABASE_URL: 'https://mock.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'mock-pub-key',
  }
  mod = await import('../src/lib/__test_qa_supabaseDb_tmp')
} finally {
  rmSync(tmpFile, { force: true })
}
const { supabaseBackend } = mod
const { QA_COMPLETION_BLOCKED_MESSAGE, QA_SETTING_LOCKED_MESSAGE, planRecreate } = await import('../src/lib/taskWorkflow')

globalThis.fetch = async (url) => {
  const entry = Object.entries(state.fetchHandlers).find(([k]) => String(url).includes(k))
  if (!entry) throw new Error(`No fetch handler for ${url}`)
  const { status = 200, body = {} } = entry[1](url)
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let failures = 0
const assert = (cond: unknown, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

const ADMIN = { id: 'user-admin', email: 'admin@x.com', password: 'admin123' }
const JOHN_USER = { id: 'user-john', email: 'john@example.com', password: 'john123' }
const SARAH_USER = { id: 'user-sarah', email: 'sarah@example.com', password: 'sarah123' }
const JOHN = 'worker-1'
const SARAH = 'worker-2'

function seedWorkspace() {
  resetState()
  state.users = [ADMIN, JOHN_USER, SARAH_USER].map((u) => ({ id: u.id, email: u.email, password: u.password }))
  state.profiles = [
    { user_id: ADMIN.id, role: 'admin', worker_id: null },
    { user_id: JOHN_USER.id, role: 'worker', worker_id: JOHN },
    { user_id: SARAH_USER.id, role: 'worker', worker_id: SARAH },
  ]
  state.workers = [
    // John: a plain worker. Sarah: a Supervisor — runs everyone's board, no KPI access.
    { id: JOHN, name: 'John', email: JOHN_USER.email, permissions: [] },
    { id: SARAH, name: 'Sarah', email: SARAH_USER.email, permissions: ['tasks.view_all', 'tasks.manage_all'] },
  ]
  state.fetchHandlers['sync-worker-profile'] = () => ({ status: 404, body: { error: 'no match' } })
}

const as = async (who: { email: string; password: string }) => {
  const res = await supabaseBackend.signIn(who.email, who.password)
  if (res.error) throw new Error(`sign-in as ${who.email} failed: ${res.error}`)
  return res.data!
}
const row = (id: string) => state.tasks.find((t) => t.id === id)
const base = { due_date: '2099-12-31', client_id: null }

async function main() {
  seedWorkspace()

  // ---------------------------------------------------------------- 1. the Owner creates
  console.log('\n--- 1. the Owner creates tasks ---')
  const owner = await as(ADMIN)
  assert(owner.role === 'admin', 'admin can sign in')
  const aDefault = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-A default' })
  assert(!aDefault.error && aDefault.data!.qa_required === true, 'a new task requires QA by default')
  assert(row(aDefault.data!.id)?.qa_required === true, 'the value is written explicitly to the row (not left to the column default)')
  const aNo = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-B No', qa_required: false })
  assert(!aNo.error && aNo.data!.qa_required === false && row(aNo.data!.id)?.qa_required === false, 'the Owner can create a task with QA Required = No')
  const aDone = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-C done', status: 'completed' })
  assert(!aDone.error && aDone.data!.status === 'completed', 'the Owner can create a QA-required task straight into Completed')

  // ---------------------------------------------------------------- 2. a plain worker
  console.log('\n--- 2. a plain worker ---')
  const john = await as(JOHN_USER)
  assert(john.role === 'worker' && !(john.permissions ?? []).includes('team_kpi.view'), 'John signs in with no KPI access')
  const tasksBefore = state.tasks.length
  const own = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-D John own', status: 'in_progress' })
  assert(!own.error && own.data!.qa_required === true && row(own.data!.id)?.qa_required === true, 'a task the worker creates requires QA (the default)')
  const askNo = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-E John asks No', qa_required: false })
  assert(askNo.error === QA_SETTING_LOCKED_MESSAGE, 'the worker cannot create a task with QA Required = No')
  const askDone = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-F John completed', status: 'completed' })
  assert(askDone.error === QA_COMPLETION_BLOCKED_MESSAGE, 'the worker cannot create a QA-required task straight into Completed')
  assert(state.tasks.length === tasksBefore + 1, 'the refused creates inserted nothing')
  const review = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-G John review', status: 'for_review' })
  assert(!review.error && review.data!.status === 'for_review', 'the worker can create one in For Review')

  const t = own.data!
  const drag = await supabaseBackend.moveTask(t.id, 'completed', 0)
  assert(drag.error === QA_COMPLETION_BLOCKED_MESSAGE, 'moveTask into Completed is refused')
  assert(row(t.id)?.status === 'in_progress' && row(t.id)?.completed_at == null, 'the refused move changed nothing')
  const edit = await supabaseBackend.updateTask(t.id, { status: 'completed' })
  assert(edit.error === QA_COMPLETION_BLOCKED_MESSAGE && row(t.id)?.status === 'in_progress', 'updateTask with status Completed is refused')
  const toReview = await supabaseBackend.moveTask(t.id, 'for_review', 0)
  assert(!toReview.error && row(t.id)?.status === 'for_review', 'For Review stays open')
  const reviewDone = await supabaseBackend.moveTask(t.id, 'completed', 0)
  assert(reviewDone.error === QA_COMPLETION_BLOCKED_MESSAGE, 'For Review → Completed is refused as well')
  const untick = await supabaseBackend.updateTask(t.id, { qa_required: false })
  assert(untick.error === QA_SETTING_LOCKED_MESSAGE && row(t.id)?.qa_required === true, 'the worker cannot untick QA Required')
  const untickDone = await supabaseBackend.updateTask(t.id, { qa_required: false, status: 'completed' })
  assert(untickDone.error && row(t.id)?.qa_required === true && row(t.id)?.status === 'for_review', 'nor untick and complete in one save')
  const same = await supabaseBackend.updateTask(t.id, { qa_required: true, title: 'QA-D John own (renamed)' })
  assert(!same.error && row(t.id)?.title === 'QA-D John own (renamed)' && row(t.id)?.qa_required === true, 're-sending the current value while editing is fine')

  // No QA → the worker moves it themselves.
  const noQa = { ...aNo.data! }
  const noQaDone = await supabaseBackend.moveTask(noQa.id, 'completed', 0)
  assert(!noQaDone.error && row(noQa.id)?.status === 'completed' && !!row(noQa.id)?.completed_at, 'QA No: the worker moves the task to Completed')

  // ---------------------------------------------------------------- 3. the Owner decides
  console.log('\n--- 3. the Owner decides ---')
  await as(ADMIN)
  const ownerDone = await supabaseBackend.moveTask(t.id, 'completed', 0)
  assert(!ownerDone.error && row(t.id)?.status === 'completed', 'the Owner moves it from For Review to Completed')
  await as(JOHN_USER)
  const reorder = await supabaseBackend.moveTask(t.id, 'completed', 0)
  assert(!reorder.error, 'the worker can still re-order a reviewed card')
  const archive = await supabaseBackend.updateTask(t.id, { archived_at: new Date().toISOString() })
  assert(!archive.error && row(t.id)?.archived_at != null, 'and archive it')
  const restore = await supabaseBackend.updateTask(t.id, { archived_at: null })
  assert(!restore.error && row(t.id)?.archived_at == null && row(t.id)?.status === 'completed', 'and restore it to Completed')

  await as(ADMIN)
  const flip = (await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-H flip', status: 'in_progress' })).data!
  const toNo = await supabaseBackend.updateTask(flip.id, { qa_required: false })
  assert(!toNo.error && row(flip.id)?.qa_required === false, 'the Owner can switch Yes → No')
  await as(JOHN_USER)
  const opened = await supabaseBackend.moveTask(flip.id, 'completed', 0)
  assert(!opened.error && row(flip.id)?.status === 'completed', 'the worker completes it once it is No')
  await as(ADMIN)
  const flip2 = (await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-I flip back', status: 'in_progress', qa_required: false })).data!
  const toYes = await supabaseBackend.updateTask(flip2.id, { qa_required: true })
  assert(!toYes.error && row(flip2.id)?.qa_required === true, 'the Owner can switch No → Yes')
  await as(JOHN_USER)
  const locked = await supabaseBackend.moveTask(flip2.id, 'completed', 0)
  assert(locked.error === QA_COMPLETION_BLOCKED_MESSAGE, 'and the worker is locked out again')

  // ---------------------------------------------------------------- 4. KPI access
  console.log('\n--- 4. KPI access (team_kpi.view) ---')
  await as(SARAH_USER)
  const sarahMove = await supabaseBackend.moveTask(flip2.id, 'completed', 0)
  assert(sarahMove.error === QA_COMPLETION_BLOCKED_MESSAGE, "a Supervisor (tasks.manage_all, no KPI) cannot complete someone else's QA task")
  const sarahFlag = await supabaseBackend.updateTask(flip2.id, { qa_required: false })
  assert(sarahFlag.error === QA_SETTING_LOCKED_MESSAGE, 'nor change the flag')
  const sarahNo = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-J supervisor No', qa_required: false })
  assert(sarahNo.error === QA_SETTING_LOCKED_MESSAGE, 'nor create a No task')

  state.workers.find((w) => w.id === JOHN)!.permissions = ['team_kpi.view']
  const kpiJohn = await as(JOHN_USER)
  assert((kpiJohn.permissions ?? []).includes('team_kpi.view'), 'John is given KPI access')
  const kpiMove = await supabaseBackend.moveTask(flip2.id, 'completed', 0)
  assert(!kpiMove.error && row(flip2.id)?.status === 'completed', 'KPI access: can move a QA-required task to Completed')
  const kpiFlag = await supabaseBackend.updateTask(flip2.id, { qa_required: false })
  assert(!kpiFlag.error && row(flip2.id)?.qa_required === false, 'KPI access: can change the flag')
  const kpiNo = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-K kpi No', qa_required: false })
  assert(!kpiNo.error && row(kpiNo.data!.id)?.qa_required === false, 'KPI access: can create a No task')
  const kpiDone = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-L kpi done', status: 'completed', qa_required: true })
  assert(!kpiDone.error && kpiDone.data!.status === 'completed', 'KPI access: can create a QA-required task straight into Completed')

  state.workers.find((w) => w.id === JOHN)!.permissions = []
  await as(ADMIN)
  const again = (await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-M after revoke', status: 'in_progress' })).data!
  await as(JOHN_USER)
  const revoked = await supabaseBackend.moveTask(again.id, 'completed', 0)
  assert(revoked.error === QA_COMPLETION_BLOCKED_MESSAGE, 'revoking KPI access puts the gate back')

  // ---------------------------------------------------------------- 5. repeating tasks
  console.log('\n--- 5. repeating tasks keep their setting ---')
  await as(ADMIN)
  const weeklyNo = (await supabaseBackend.createTask({
    ...base, worker_id: JOHN, title: 'QA-N weekly No', status: 'in_progress', due_date: '2026-09-01', repeats: 'weekly', qa_required: false,
  })).data!
  const weeklyYes = (await supabaseBackend.createTask({
    ...base, worker_id: JOHN, title: 'QA-O weekly Yes', status: 'in_progress', due_date: '2026-09-01', repeats: 'weekly', qa_required: true,
  })).data!
  await as(JOHN_USER)
  const weeklyNoDone = await supabaseBackend.moveTask(weeklyNo.id, 'completed', 0)
  assert(!weeklyNoDone.error, 'the worker completes the No-QA weekly task')
  const nextNo = await supabaseBackend.createTask(planRecreate(weeklyNoDone.data!, [1, 2, 3, 4, 5])!.input)
  assert(!nextNo.error && row(nextNo.data!.id)?.qa_required === false && row(nextNo.data!.id)?.series_id === weeklyNo.id, '"Recreate next" keeps a No series at No')
  await as(ADMIN)
  const yesDone = await supabaseBackend.moveTask(weeklyYes.id, 'completed', 0)
  await as(JOHN_USER)
  const nextYes = await supabaseBackend.createTask(planRecreate(yesDone.data!, [1, 2, 3, 4, 5])!.input)
  assert(!nextYes.error && row(nextYes.data!.id)?.qa_required === true, '"Recreate next" of a Yes task stays Yes')
  assert((await supabaseBackend.moveTask(nextYes.data!.id, 'completed', 0)).error === QA_COMPLETION_BLOCKED_MESSAGE, 'and the worker still cannot complete it')
  // A worker claiming "No" without being part of a series is refused.
  const fakeSeries = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-P no series', qa_required: false })
  assert(fakeSeries.error === QA_SETTING_LOCKED_MESSAGE, 'a worker cannot claim No unless the task continues a series')

  await as(ADMIN)
  const shelfNo = (await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-Q shelf No', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly', qa_required: false })).data!
  const shelfYes = (await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-R shelf Yes', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly', qa_required: true })).data!
  await as(JOHN_USER)
  const startedNo = await supabaseBackend.startRecurringOccurrence(shelfNo.id)
  assert(!startedNo.error && row(startedNo.data!.id)?.qa_required === false, 'starting an occurrence of a No shelf card gives a No task')
  const startedYes = await supabaseBackend.startRecurringOccurrence(shelfYes.id)
  assert(!startedYes.error && row(startedYes.data!.id)?.qa_required === true, 'starting an occurrence of a Yes shelf card gives a Yes task')

  // A WORKER's own repeating task: repeating work defaults to No QA, so the
  // card is theirs to close.
  await as(JOHN_USER)
  const ownWeekly = (await supabaseBackend.createTask({
    ...base, worker_id: JOHN, title: 'QA-S1 worker weekly', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly',
  })).data!
  assert(ownWeekly.qa_required === false && row(ownWeekly.id)?.qa_required === false, 'a repeating task the worker creates defaults to No QA')
  const ownStart = await supabaseBackend.startRecurringOccurrence(ownWeekly.id)
  assert(!ownStart.error && row(ownStart.data!.id)?.qa_required === false, 'its occurrence carries No forward')
  const ownFinished = await supabaseBackend.moveTask(ownStart.data!.id, 'completed', 0)
  assert(!ownFinished.error && row(ownStart.data!.id)?.status === 'completed', 'and the worker moves it straight to Completed')
  const ownWeeklyNo = await supabaseBackend.createTask({
    ...base, worker_id: JOHN, title: 'QA-S2 worker weekly No', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly', qa_required: false,
  })
  assert(!ownWeeklyNo.error && row(ownWeeklyNo.data!.id)?.qa_required === false, 'stating No on a repeating task is accepted (it is the default)')
  // A one-off task from the same worker is unchanged: QA, gated.
  const ownOneOff = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-S3 worker one-off' })
  assert(!ownOneOff.error && row(ownOneOff.data!.id)?.qa_required === true, 'a one-off task the worker creates still requires QA')
  assert((await supabaseBackend.moveTask(ownOneOff.data!.id, 'completed', 0)).error === QA_COMPLETION_BLOCKED_MESSAGE, 'and the worker still cannot complete it')

  // The Owner can still opt a series in — Yes carries to its occurrence.
  await as(ADMIN)
  const ownerWeekly = (await supabaseBackend.createTask({
    ...base, worker_id: JOHN, title: 'QA-S4 owner weekly Yes', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly', qa_required: true,
  })).data!
  const ownerStart = await supabaseBackend.startRecurringOccurrence(ownerWeekly.id)
  assert(!ownerStart.error && row(ownerStart.data!.id)?.qa_required === true, 'an opted-in series hands the worker a QA task')
  await as(JOHN_USER)
  assert((await supabaseBackend.moveTask(ownerStart.data!.id, 'completed', 0)).error === QA_COMPLETION_BLOCKED_MESSAGE, 'which the worker cannot complete')

  // ---------------------------------------------------------------- 6. tasks that predate the field
  console.log('\n--- 6. tasks that predate the field ---')
  state.tasks.push({
    id: 'legacy-1', worker_id: JOHN, client_id: null, title: 'QA-S legacy row', description: null, status: 'in_progress', priority: 'medium',
    due_date: '2099-12-31', position: 0, completed_at: null, archived_at: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  })
  const legacy = await supabaseBackend.moveTask('legacy-1', 'completed', 0)
  assert(!legacy.error && legacy.data!.status === 'completed' && legacy.data!.qa_required === false, 'a row with no qa_required reads as No and the worker completes it')

  // ---------------------------------------------------------------- 7. a database that has not run the migration
  console.log('\n--- 7. a database without supabase/RUN-THIS-task-qa-required.sql ---')
  state.tasksQaColumnMissing = true
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args.map((a) => String(a)).join(' '))
  try {
    await as(ADMIN)
    const created = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-T un-migrated create', status: 'in_progress' })
    assert(!created.error && created.data!.title === 'QA-T un-migrated create', 'creating a task still works')
    assert(row(created.data!.id) && !('qa_required' in row(created.data!.id)!), 'it is saved without the column')
    assert(created.data!.qa_required === false, 'and reads as No (nothing can be enforced yet)')
    assert(warnings.some((w) => /RUN-THIS-task-qa-required\.sql/.test(w)), 'the operator is told which file to run')

    warnings.length = 0
    const edited = await supabaseBackend.updateTask(created.data!.id, { qa_required: true, title: 'QA-T renamed' })
    assert(!edited.error && row(created.data!.id)?.title === 'QA-T renamed', 'saving an edit that includes the flag still saves everything else')
    assert(warnings.some((w) => /RUN-THIS-task-qa-required\.sql/.test(w)), 'and warns again')

    await as(JOHN_USER)
    const moved = await supabaseBackend.moveTask(created.data!.id, 'completed', 0)
    assert(!moved.error && row(created.data!.id)?.status === 'completed', 'the worker can complete it (there is no flag to enforce)')
    const workerCreate = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-U worker un-migrated', status: 'in_progress' })
    assert(!workerCreate.error, "a worker's own create also works")
    const started = await supabaseBackend.startRecurringOccurrence(shelfYes.id)
    assert(!started.error, 'starting an occurrence works')
  } finally {
    console.warn = originalWarn
    state.tasksQaColumnMissing = false
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll QA Required (Supabase backend) checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
