/**
 * Verification of the recurring carry-over against the Supabase backend (the
 * REAL src/lib/supabaseDb.ts, pointed at the in-memory mock client):
 *  - the first read in a new month puts the Recurring-shelf template's cycle on
 *    the board (To Do, top of the column, same series), and moves the anchor
 *  - later reads add nothing; a deleted carried card does not come back
 *  - two reads that overlap create the cycle once (reads run one at a time)
 *  - a worker's read carries only their own templates; an admin's read carries
 *    everyone's
 *  - nothing is created for a series whose cycle is already on the board
 * Run: npx tsx scripts/verify-task-carryover-supabase.ts
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { state, resetState } from './supabase-mock/mock-supabase.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcFile = path.join(root, 'src', 'lib', 'supabaseDb.ts')
const tmpFile = path.join(root, 'src', 'lib', '__test_supabaseDb_carryover_tmp.ts')

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
  mod = await import('../src/lib/__test_supabaseDb_carryover_tmp')
} finally {
  rmSync(tmpFile, { force: true })
}
const { supabaseBackend } = mod

const { toISODate } = await import('../src/lib/finance')
const now = new Date()
const pad = (n: number) => String(n).padStart(2, '0')
const today = toISODate(now)
const thisMonth = today.slice(0, 7)
// The anchor is the 15th of the previous month, so this month's 15th is the cycle.
const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15)
const anchor = `${lastMonth.getFullYear()}-${pad(lastMonth.getMonth() + 1)}-15`
const expectedDue = `${thisMonth}-15`

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

const PASSWORD = 'pass123'
const ADMIN = { id: 'user-admin', email: 'admin@x.com', password: 'admin123' }
const JOHN = { id: 'user-john', worker: 'worker-1', email: 'john@example.com' }
const SARAH = { id: 'user-sarah', worker: 'worker-2', email: 'sarah@example.com' }

function seedWorkspace() {
  resetState()
  state.users = [
    { id: ADMIN.id, email: ADMIN.email, password: ADMIN.password },
    { id: JOHN.id, email: JOHN.email, password: PASSWORD },
    { id: SARAH.id, email: SARAH.email, password: PASSWORD },
  ]
  state.profiles = [
    { user_id: ADMIN.id, role: 'admin', worker_id: null },
    { user_id: JOHN.id, role: 'worker', worker_id: JOHN.worker },
    { user_id: SARAH.id, role: 'worker', worker_id: SARAH.worker },
  ]
  state.workers = [
    { id: JOHN.worker, name: 'John', email: JOHN.email },
    { id: SARAH.worker, name: 'Sarah', email: SARAH.email },
  ]
  state.fetchHandlers['sync-worker-profile'] = () => ({ status: 404, body: { error: 'no match' } })
}

/** The cards in a series that sit in To Do. */
const todoCards = (seriesId: string) =>
  state.tasks.filter((t) => t.series_id === seriesId && t.status === 'todo')
const row = (id: string) => state.tasks.find((t) => t.id === id)

async function main() {
  seedWorkspace()

  const admin = await supabaseBackend.signIn(ADMIN.email, ADMIN.password)
  assert(!admin.error && admin.data?.role === 'admin', 'admin signs in')

  const template = (
    await supabaseBackend.createTask({
      worker_id: JOHN.worker, client_id: null, title: 'CO monthly close', status: 'recurring',
      due_date: anchor, priority: 'medium', estimated_hours: 1, repeats: 'monthly',
    })
  ).data!
  assert(template.status === 'recurring', 'a monthly template is parked on the Recurring shelf')

  // ---- the first read this month carries the cycle --------------------------
  const first = await supabaseBackend.listTasks()
  assert(!first.error, 'the admin\'s read succeeds')
  const cards = todoCards(template.id)
  assert(cards.length === 1, 'the first read this month puts one card on the board')
  assert(cards[0].due_date === expectedDue && cards[0].occurrence === 1, 'the card is due on this month\'s cycle date, occurrence #1')
  assert(cards[0].worker_id === JOHN.worker && cards[0].title === 'CO monthly close', 'the card is John\'s, with the template\'s title')
  assert(cards[0].position === 0, 'the card sits at the top of John\'s To Do')
  assert(row(template.id)!.status === 'recurring' && row(template.id)!.due_date === expectedDue, 'the template stays on the shelf, its anchor moved to the cycle')
  assert(row(template.id)!.occurrence === 1, 'the template records the occurrence it carried')
  assert(JSON.stringify(cards[0].stage_history).includes('Recurring carry-over'), 'the card\'s history says it was carried over')
  assert((first.data ?? []).some((t) => t.id === cards[0].id), 'the read returns the carried card with the rest of the board')

  // ---- later reads add nothing; a deleted card stays deleted ----------------
  await supabaseBackend.listTasks()
  assert(todoCards(template.id).length === 1, 'a later read finds the cycle already there: no duplicate')
  const removed = await supabaseBackend.deleteTask(cards[0].id)
  assert(!removed.error, 'the carried card can be deleted')
  await supabaseBackend.listTasks()
  assert(todoCards(template.id).length === 0, 'the deleted card does not come back on the next read')

  // ---- two overlapping reads create the cycle once --------------------------
  const racing = (
    await supabaseBackend.createTask({
      worker_id: JOHN.worker, client_id: null, title: 'CO racing close', status: 'recurring',
      due_date: anchor, priority: 'medium', estimated_hours: 1, repeats: 'monthly',
    })
  ).data!
  await Promise.all([supabaseBackend.listTasks(), supabaseBackend.listTasks(), supabaseBackend.listTasks()])
  assert(todoCards(racing.id).length === 1, 'three overlapping reads still create one card for the cycle')

  // ---- a worker carries only their own templates ----------------------------
  const sarahTemplate = (
    await supabaseBackend.createTask({
      worker_id: SARAH.worker, client_id: null, title: 'CO sarah close', status: 'recurring',
      due_date: anchor, priority: 'medium', estimated_hours: 1, repeats: 'monthly',
    })
  ).data!
  await supabaseBackend.signIn(JOHN.email, PASSWORD)
  const asJohn = await supabaseBackend.listTasks()
  assert(!asJohn.error, 'John\'s read succeeds')
  assert(todoCards(sarahTemplate.id).length === 0, 'a worker\'s read does not carry someone else\'s template')
  assert(row(sarahTemplate.id)!.due_date === anchor, 'and leaves that template\'s anchor where it was')

  await supabaseBackend.signIn(ADMIN.email, ADMIN.password)
  await supabaseBackend.listTasks()
  assert(todoCards(sarahTemplate.id).length === 1, 'the admin\'s read carries Sarah\'s template into this month')
  assert(row(sarahTemplate.id)!.due_date === expectedDue, 'and moves her anchor the same way')

  // ---- a series that already has this month's card gets no second one ------
  const before = todoCards(sarahTemplate.id).length
  row(sarahTemplate.id)!.due_date = anchor // a stale anchor: the card for this month is already there
  await supabaseBackend.listTasks()
  assert(todoCards(sarahTemplate.id).length === before, 'a series that already has a card due this month gets no second card')

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll Supabase recurring carry-over checks passed.')
  process.exitCode = failures ? 1 : 0
}

await main()
