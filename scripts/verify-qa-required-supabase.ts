/**
 * Verification of "QA Required?" against the Supabase backend (the REAL
 * src/lib/supabaseDb.ts, pointed at the in-memory mock client).
 *
 * "QA Required?" is a REQUEST for review, not a lock:
 *
 *   Yes → the card carries a "QA required" chip and is scored by the Owner /
 *         `team_kpi.view` holders once it reaches For Review. Anyone who may
 *         edit the card can still complete it.
 *   No  → nothing to review.
 *
 * Anyone who may edit a card can tick or untick it; no stage move is refused
 * because of the flag. QA SCORING stays with the Owner / KPI access. The
 * database has no guard trigger any more (supabase/RUN-THIS-open-qa-toggle.sql
 * removes it from databases that installed one), so these app-side rules are
 * the whole story.
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
const { planRecreate } = await import('../src/lib/taskWorkflow')

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
  assert(!aDefault.error && aDefault.data!.qa_required === true, 'a new task asks for QA by default')
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
  assert(!own.error && own.data!.qa_required === true && row(own.data!.id)?.qa_required === true, 'a task the worker creates asks for QA (the default)')
  const askNo = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-E John asks No', qa_required: false })
  assert(!askNo.error && row(askNo.data!.id)?.qa_required === false, 'the worker CAN create a task with QA Required = No (the tick is open to everyone)')
  const askDone = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-F John completed', status: 'completed' })
  assert(!askDone.error && askDone.data!.status === 'completed' && row(askDone.data!.id)?.qa_required === true, 'the worker CAN create a QA-required task straight into Completed')
  assert(state.tasks.length === tasksBefore + 3, 'all three creates inserted a row')
  const review = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-G John review', status: 'for_review' })
  assert(!review.error && review.data!.status === 'for_review', 'the worker can create one in For Review')

  const t = own.data!
  const drag = await supabaseBackend.moveTask(t.id, 'completed', 0)
  assert(!drag.error && row(t.id)?.status === 'completed' && !!row(t.id)?.completed_at, 'moveTask into Completed works with QA Yes')
  const back = await supabaseBackend.moveTask(t.id, 'in_progress', 0)
  assert(!back.error && row(t.id)?.status === 'in_progress' && row(t.id)?.completed_at == null, 'and back out of Completed')
  const edit = await supabaseBackend.updateTask(t.id, { status: 'completed' })
  assert(!edit.error && row(t.id)?.status === 'completed', 'updateTask with status Completed works too')
  const toReview = await supabaseBackend.moveTask(t.id, 'for_review', 0)
  assert(!toReview.error && row(t.id)?.status === 'for_review', 'For Review stays open')
  const reviewDone = await supabaseBackend.moveTask(t.id, 'completed', 0)
  assert(!reviewDone.error && row(t.id)?.status === 'completed', 'For Review → Completed is the worker’s to make as well')

  const untick = await supabaseBackend.updateTask(t.id, { qa_required: false })
  assert(!untick.error && row(t.id)?.qa_required === false, 'the worker CAN untick QA Required on their own task')
  const retick = await supabaseBackend.updateTask(t.id, { qa_required: true })
  assert(!retick.error && row(t.id)?.qa_required === true, 'and tick it back on')
  const untickDone = await supabaseBackend.updateTask(t.id, { qa_required: false, status: 'in_progress' })
  assert(!untickDone.error && row(t.id)?.qa_required === false && row(t.id)?.status === 'in_progress', 'untick and change stage in one save')
  const same = await supabaseBackend.updateTask(t.id, { qa_required: false, title: 'QA-D John own (renamed)' })
  assert(!same.error && row(t.id)?.title === 'QA-D John own (renamed)' && row(t.id)?.qa_required === false, 're-sending the value while editing is fine')

  // Scoring stays the reviewers' call.
  const scoreByWorker = await supabaseBackend.updateTask(t.id, { qa_score: 5 })
  assert(!!scoreByWorker.error && /score QA/.test(scoreByWorker.error), 'the worker still cannot SCORE QA')

  // No QA → the worker moves it themselves, exactly as before.
  const noQa = { ...aNo.data! }
  const noQaDone = await supabaseBackend.moveTask(noQa.id, 'completed', 0)
  assert(!noQaDone.error && row(noQa.id)?.status === 'completed' && !!row(noQa.id)?.completed_at, 'QA No: the worker moves the task to Completed')

  // "Any task they can edit" is decided by the database's RLS policies on
  // `tasks` (own cards, or every card with tasks.manage_all) — supabaseDb does
  // not re-check ownership, so there is nothing to assert here against the
  // mock, which does not model RLS. See supabase/tasks.sql.

  // ---------------------------------------------------------------- 3. the Owner decides
  console.log('\n--- 3. the Owner decides ---')
  await as(ADMIN)
  const ownerDone = await supabaseBackend.moveTask(t.id, 'completed', 0)
  assert(!ownerDone.error && row(t.id)?.status === 'completed', 'the Owner completes a QA-required task')
  await as(JOHN_USER)
  const reorder = await supabaseBackend.moveTask(t.id, 'completed', 0)
  assert(!reorder.error, 'the worker can still re-order a completed card')
  const archive = await supabaseBackend.updateTask(t.id, { archived_at: new Date().toISOString() })
  assert(!archive.error && row(t.id)?.archived_at != null, 'and archive it')
  const restore = await supabaseBackend.updateTask(t.id, { archived_at: null })
  assert(!restore.error && row(t.id)?.archived_at == null && row(t.id)?.status === 'completed', 'and restore it to Completed')

  await as(ADMIN)
  const flip = (await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-H flip', status: 'in_progress' })).data!
  const toNo = await supabaseBackend.updateTask(flip.id, { qa_required: false })
  assert(!toNo.error && row(flip.id)?.qa_required === false, 'the Owner can switch Yes → No')
  const toYes = await supabaseBackend.updateTask(flip.id, { qa_required: true })
  assert(!toYes.error && row(flip.id)?.qa_required === true, 'the Owner can switch No → Yes')
  await as(JOHN_USER)
  const stillCompletable = await supabaseBackend.moveTask(flip.id, 'completed', 0)
  assert(!stillCompletable.error && row(flip.id)?.status === 'completed', 'and the worker completes it with the tick set (nothing is locked)')

  // ---------------------------------------------------------------- 4. Supervisor and KPI access
  console.log('\n--- 4. Supervisor / KPI access ---')
  await as(SARAH_USER)
  assert((state.workers.find((w) => w.id === SARAH)?.permissions ?? []).includes('tasks.manage_all'), 'Sarah is a Supervisor (runs the board, no KPI access)')
  const sarahFlip = (await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-J supervisor flip', status: 'in_progress' })).data!
  assert(row(sarahFlip.id)?.qa_required === true, 'the Supervisor creates a task for John — QA on by default')
  const sarahFlag = await supabaseBackend.updateTask(sarahFlip.id, { qa_required: false })
  assert(!sarahFlag.error && row(sarahFlip.id)?.qa_required === false, "the Supervisor CAN switch the flag on someone else's card")
  const sarahNo = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-K supervisor No', qa_required: false })
  assert(!sarahNo.error && row(sarahNo.data!.id)?.qa_required === false, 'nor is creating a No task refused')
  const sarahDone = await supabaseBackend.moveTask(sarahFlip.id, 'completed', 0)
  assert(!sarahDone.error && row(sarahFlip.id)?.status === 'completed', 'and completing it is allowed')
  const sarahScore = await supabaseBackend.updateTask(sarahFlip.id, { qa_score: 4 })
  assert(!!sarahScore.error && /score QA/.test(sarahScore.error), 'but the Supervisor still cannot SCORE QA')

  state.workers.find((w) => w.id === JOHN)!.permissions = ['team_kpi.view']
  const kpiJohn = await as(JOHN_USER)
  assert((kpiJohn.permissions ?? []).includes('team_kpi.view'), 'John is given KPI access')
  const kpiScore = await supabaseBackend.updateTask(sarahFlip.id, { qa_score: 5 })
  assert(!kpiScore.error && row(sarahFlip.id)?.qa_score === 5, 'KPI access: can score QA')
  const kpiFlag = await supabaseBackend.updateTask(sarahFlip.id, { qa_required: true })
  assert(!kpiFlag.error && row(sarahFlip.id)?.qa_required === true, 'KPI access: can change the flag')
  const kpiNo = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-L kpi No', qa_required: false })
  assert(!kpiNo.error && row(kpiNo.data!.id)?.qa_required === false, 'KPI access: can create a No task')

  state.workers.find((w) => w.id === JOHN)!.permissions = []
  await as(ADMIN)
  const again = (await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-M after revoke', status: 'in_progress' })).data!
  await as(JOHN_USER)
  const revoked = await supabaseBackend.moveTask(again.id, 'completed', 0)
  assert(!revoked.error && row(again.id)?.status === 'completed', 'revoking KPI access changes nothing: the card was never gated')
  const revokedScore = await supabaseBackend.updateTask(again.id, { qa_score: 3 })
  assert(!!revokedScore.error && /score QA/.test(revokedScore.error), 'but scoring is refused again without it')

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
  const yesDone = await supabaseBackend.moveTask(weeklyYes.id, 'completed', 0)
  assert(!yesDone.error, 'the worker completes the Yes weekly task too — the tick does not gate anything')
  const nextYes = await supabaseBackend.createTask(planRecreate(yesDone.data!, [1, 2, 3, 4, 5])!.input)
  assert(!nextYes.error && row(nextYes.data!.id)?.qa_required === true, '"Recreate next" of a Yes task stays Yes')
  const nextYesDone = await supabaseBackend.moveTask(nextYes.data!.id, 'completed', 0)
  assert(!nextYesDone.error && row(nextYes.data!.id)?.status === 'completed', 'and the worker completes that one as well')
  // Anyone may ask for No, series or not.
  const noSeries = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-P no series', qa_required: false })
  assert(!noSeries.error && row(noSeries.data!.id)?.qa_required === false, 'a worker may set No on a one-off task, series or not')

  await as(ADMIN)
  const shelfNo = (await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-Q shelf No', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly', qa_required: false })).data!
  const shelfYes = (await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-R shelf Yes', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly', qa_required: true })).data!
  await as(JOHN_USER)
  const startedNo = await supabaseBackend.startRecurringOccurrence(shelfNo.id)
  assert(!startedNo.error && row(startedNo.data!.id)?.qa_required === false, 'starting an occurrence of a No shelf card gives a No task')
  const startedYes = await supabaseBackend.startRecurringOccurrence(shelfYes.id)
  assert(!startedYes.error && row(startedYes.data!.id)?.qa_required === true, 'starting an occurrence of a Yes shelf card gives a Yes task')
  const startedDone = await supabaseBackend.moveTask(startedYes.data!.id, 'completed', 0)
  assert(!startedDone.error, 'and that Yes occurrence completes like any other')

  // A WORKER's own repeating task defaults to No QA (routine work).
  await as(JOHN_USER)
  const ownWeekly = (await supabaseBackend.createTask({
    ...base, worker_id: JOHN, title: 'QA-S1 worker weekly', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly',
  })).data!
  assert(ownWeekly.qa_required === false && row(ownWeekly.id)?.qa_required === false, 'a repeating task the worker creates defaults to No QA')
  const ownStart = await supabaseBackend.startRecurringOccurrence(ownWeekly.id)
  assert(!ownStart.error && row(ownStart.data!.id)?.qa_required === false, 'its occurrence carries No forward')
  const ownFinished = await supabaseBackend.moveTask(ownStart.data!.id, 'completed', 0)
  assert(!ownFinished.error && row(ownStart.data!.id)?.status === 'completed', 'and the worker moves it straight to Completed')
  const ownWeeklyYes = await supabaseBackend.createTask({
    ...base, worker_id: JOHN, title: 'QA-S2 worker weekly Yes', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly', qa_required: true,
  })
  assert(!ownWeeklyYes.error && row(ownWeeklyYes.data!.id)?.qa_required === true, 'and can ask for QA on their own repeating card')
  // A one-off task from the same worker asks for QA by default.
  const ownOneOff = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-S3 worker one-off' })
  assert(!ownOneOff.error && row(ownOneOff.data!.id)?.qa_required === true, 'a one-off task the worker creates still asks for QA')
  const ownOneOffDone = await supabaseBackend.moveTask(ownOneOff.data!.id, 'completed', 0)
  assert(!ownOneOffDone.error && row(ownOneOff.data!.id)?.status === 'completed', 'and the worker completes it with the chip still on')

  // The Owner can still opt a series in — Yes carries to its occurrence.
  await as(ADMIN)
  const ownerWeekly = (await supabaseBackend.createTask({
    ...base, worker_id: JOHN, title: 'QA-S4 owner weekly Yes', status: 'recurring', due_date: '2026-09-01', repeats: 'weekly', qa_required: true,
  })).data!
  const ownerStart = await supabaseBackend.startRecurringOccurrence(ownerWeekly.id)
  assert(!ownerStart.error && row(ownerStart.data!.id)?.qa_required === true, 'an opted-in series hands the worker a QA task')

  // ---------------------------------------------------------------- 6. tasks that predate the field
  console.log('\n--- 6. tasks that predate the field ---')
  state.tasks.push({
    id: 'legacy-1', worker_id: JOHN, client_id: null, title: 'QA-S legacy row', description: null, status: 'in_progress', priority: 'medium',
    due_date: '2099-12-31', position: 0, completed_at: null, archived_at: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  })
  const legacy = await supabaseBackend.moveTask('legacy-1', 'completed', 0)
  assert(!legacy.error && legacy.data!.status === 'completed' && legacy.data!.qa_required === false, 'a row with no qa_required reads as No and completes')

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
    assert(created.data!.qa_required === false, 'and reads as No (the flag cannot be stored yet)')
    assert(warnings.some((w) => /RUN-THIS-task-qa-required\.sql/.test(w)), 'the operator is told which file to run')

    warnings.length = 0
    const edited = await supabaseBackend.updateTask(created.data!.id, { qa_required: true, title: 'QA-T renamed' })
    assert(!edited.error && row(created.data!.id)?.title === 'QA-T renamed', 'saving an edit that includes the flag still saves everything else')
    assert(warnings.some((w) => /RUN-THIS-task-qa-required\.sql/.test(w)), 'and warns again')

    await as(JOHN_USER)
    const moved = await supabaseBackend.moveTask(created.data!.id, 'completed', 0)
    assert(!moved.error && row(created.data!.id)?.status === 'completed', 'the worker can complete it')
    const workerCreate = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-U worker un-migrated', status: 'in_progress' })
    assert(!workerCreate.error, "a worker's own create also works")
    const workerNo = await supabaseBackend.createTask({ ...base, worker_id: JOHN, title: 'QA-U2 worker un-migrated No', qa_required: false })
    assert(!workerNo.error, 'and a worker asking for No is accepted as well')
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
