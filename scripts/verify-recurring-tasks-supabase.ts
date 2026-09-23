/**
 * Verification of recurring tasks against the Supabase backend (the REAL
 * src/lib/supabaseDb.ts, pointed at the in-memory mock client):
 *  - create stores the recurring columns, and a PLAIN one-off task does not
 *    even send them (so unmigrated databases keep working)
 *  - editing the repeat settings round-trips through updateTask
 *  - "Recreate next" (plan + the existing create path) lands a fresh To Do
 *    clone in the assignee's column with the series carried forward
 * Run: npx tsx scripts/verify-recurring-tasks-supabase.ts
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { state, resetState } from './supabase-mock/mock-supabase.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcFile = path.join(root, 'src', 'lib', 'supabaseDb.ts')
const tmpFile = path.join(root, 'src', 'lib', '__test_supabaseDb_tmp.ts')

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
  mod = await import('../src/lib/__test_supabaseDb_tmp')
} finally {
  rmSync(tmpFile, { force: true })
}
const { supabaseBackend } = mod
const wf = await import('../src/lib/taskWorkflow')

globalThis.fetch = async (url) => {
  const entry = Object.entries(state.fetchHandlers).find(([k]) => String(url).includes(k))
  if (!entry) throw new Error(`No fetch handler for ${url}`)
  const { status = 200, body = {} } = entry[1](url)
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

const ADMIN = { id: 'user-admin', email: 'admin@x.com', password: 'admin123' }
const JOHN = 'worker-1'

function seedWorkspace() {
  resetState()
  state.users = [{ id: ADMIN.id, email: ADMIN.email, password: ADMIN.password }]
  state.profiles = [{ user_id: ADMIN.id, role: 'admin', worker_id: null }]
  state.workers = [
    { id: JOHN, name: 'John', email: 'john@example.com', workdays: [1, 2, 3, 4, 5] },
  ]
  state.fetchHandlers['sync-worker-profile'] = () => ({ status: 404, body: { error: 'no match' } })
}

async function main() {
  seedWorkspace()
  const me = await supabaseBackend.signIn(ADMIN.email, ADMIN.password)
  assert(!me.error && me.data?.role === 'admin', 'admin can sign in')

  // 1) Recurring columns are stored on create — and a plain task doesn't
  //    even send them, so a database that never ran recurring-tasks.sql
  //    keeps accepting one-off tasks.
  const recurring = await supabaseBackend.createTask({
    due_date: '2026-09-21', worker_id: JOHN, client_id: null, title: 'VR-Supabase-Weekly',
    status: 'todo', priority: 'high', estimated_hours: 4, repeats: 'weekly',
  })
  assert(!recurring.error, 'a recurring task is created')
  assert(recurring.data!.repeats === 'weekly', 'the row carries the interval')
  assert(recurring.data!.series_id === null && recurring.data!.occurrence === null, 'a fresh series has no id/occurrence yet')

  const plain = await supabaseBackend.createTask({
    due_date: '2099-12-31', worker_id: JOHN, client_id: null, title: 'VR-Supabase-Plain', status: 'todo',
  })
  assert(!plain.error, 'a plain task is created')
  const plainRow = state.tasks.find((t) => t.title === 'VR-Supabase-Plain')
  assert(plainRow && !('repeats' in plainRow) && !('series_id' in plainRow) && !('occurrence' in plainRow) && !('repeat_until' in plainRow),
    'a one-off task sends no recurring columns at all')

  // 2) Editing the repeat settings round-trips.
  const edited = await supabaseBackend.updateTask(plain.data!.id, { repeats: 'biweekly', repeat_until: '2027-06-30' })
  assert(!edited.error && edited.data!.repeats === 'biweekly' && edited.data!.repeat_until === '2027-06-30', 'the interval + end date save through updateTask')
  const cleared = await supabaseBackend.updateTask(plain.data!.id, { repeats: 'none', repeat_until: null })
  assert(!cleared.error && cleared.data!.repeats === 'none' && cleared.data!.repeat_until === null, 'clearing back to one-off saves')

  // 3) The recreate flow: complete the card, plan the next occurrence, and
  //    create it through the SAME create path the UI uses.
  const completed = await supabaseBackend.moveTask(recurring.data!.id, 'completed', 0)
  assert(!completed.error, 'the recurring card is completed')
  const plan = wf.planRecreate(completed.data!, [1, 2, 3, 4, 5])
  assert(plan !== null && plan.nextDue === '2026-09-28' && !plan.blockedByEnd, 'the plan advances the due date +7 days')
  const next = await supabaseBackend.createTask(plan!.input)
  assert(!next.error, 'the next occurrence is created')
  assert(next.data!.status === 'todo' && next.data!.due_date === '2026-09-28', 'the clone lands in To Do due next week')
  assert(next.data!.worker_id === JOHN && next.data!.title === 'VR-Supabase-Weekly' && next.data!.estimated_hours === 4,
    'the clone keeps worker, title and estimate')
  assert(next.data!.series_id === recurring.data!.id && next.data!.occurrence === 2, 'the clone inherits the series id and is occurrence #2')
  assert(next.data!.position === 0, 'the clone lands at the top of the To Do column')

  // 4) An end date that has been passed blocks the plan (the UI hides the
  //    button in that case) — the backend never sees a blocked recreate.
  const ending = await supabaseBackend.createTask({
    due_date: '2026-12-28', worker_id: JOHN, client_id: null, title: 'VR-Supabase-Ending',
    status: 'completed', repeats: 'weekly', repeat_until: '2026-12-30',
  })
  const endPlan = wf.planRecreate(ending.data!, [1, 2, 3, 4, 5])
  assert(endPlan !== null && endPlan.blockedByEnd === true, 'a next due date past the end date is blocked')

  // 5) The Recurring shelf: start an occurrence (flip + advance + top of
  //    To Do), return it, and the guards.
  const shelf = await supabaseBackend.createTask({
    due_date: '2026-09-28', worker_id: JOHN, client_id: null, title: 'VR-Supabase-Shelf',
    status: 'recurring', repeats: 'daily', estimated_hours: 2,
  })
  assert(!shelf.error && shelf.data!.status === 'recurring', 'a task can be created on the Recurring shelf')

  const started = await supabaseBackend.startRecurringOccurrence(shelf.data!.id)
  assert(!started.error, 'the occurrence starts')
  assert(started.data!.id !== shelf.data!.id, 'starting creates a NEW occurrence card — the template is not moved')
  assert(started.data!.status === 'todo' && started.data!.due_date === '2026-09-29',
    'the occurrence lands in To Do due the next interval (+1 day for daily)')
  assert(started.data!.occurrence === 1 && started.data!.series_id === shelf.data!.id,
    'the occurrence is #1, anchored on the template as its series')
  assert(started.data!.position === 0, 'the occurrence lands at the top of To Do')
  const shelfRow = state.tasks.find((t) => t.id === shelf.data!.id)
  assert(shelfRow.status === 'recurring' && shelfRow.due_date === '2026-09-29',
    'the template stays on the shelf with its anchor advanced')

  const started2 = await supabaseBackend.startRecurringOccurrence(shelf.data!.id)
  assert(started2.data!.due_date === '2026-09-30' && started2.data!.occurrence === 2, 'the next start schedules the following cycle (#2)')

  const guard = await supabaseBackend.startRecurringOccurrence(plain.data!.id)
  assert(!!guard.error, 'starting is refused for a card that is not on the shelf')

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll recurring-task (supabase) checks passed.')
  if (failures) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
