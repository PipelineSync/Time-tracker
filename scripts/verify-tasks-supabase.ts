/**
 * Verification of the Tasks board ordering rules against the Supabase backend
 * (the REAL src/lib/supabaseDb.ts, pointed at the in-memory mock client):
 * a NEW task lands at the very TOP of its column, and a task whose STAGE
 * (or assignee) changes lands at the top of the destination column — while
 * an explicit drag-drop position is still honoured.
 * Run: npx tsx scripts/verify-tasks-supabase.ts
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
const SARAH = 'worker-2'

/** The order the board renders a column in (position, then newest first). */
function columnOrder(workerId: string, status: string) {
  return state.tasks
    .filter((t) => t.worker_id === workerId && t.status === status)
    .sort((a, b) => a.position - b.position || b.created_at.localeCompare(a.created_at))
}

function seedWorkspace() {
  resetState()
  state.users = [{ id: ADMIN.id, email: ADMIN.email, password: ADMIN.password }]
  state.profiles = [{ user_id: ADMIN.id, role: 'admin', worker_id: null }]
  state.workers = [
    { id: JOHN, name: 'John', email: 'john@example.com' },
    { id: SARAH, name: 'Sarah', email: 'sarah@example.com' },
  ]
  // Not used on the healthy-admin path; keeps the global fetch stub from
  // throwing if anything probes the repair endpoint.
  state.fetchHandlers['sync-worker-profile'] = () => ({ status: 404, body: { error: 'no match' } })
}

async function main() {
  seedWorkspace()
  const me = await supabaseBackend.signIn(ADMIN.email, ADMIN.password)
  assert(!me.error && me.data?.role === 'admin', 'admin can sign in')

  // 1) Two tasks created one after another: the SECOND must be on top.
  const a = await supabaseBackend.createTask({ worker_id: JOHN, client_id: null, title: 'VT-A created first', status: 'todo' })
  const b = await supabaseBackend.createTask({ worker_id: JOHN, client_id: null, title: 'VT-B created second', status: 'todo' })
  assert(!a.error && !b.error, 'both test tasks created')
  assert(b.data!.position === 0, 'new task is inserted at position 0')
  const todo = columnOrder(JOHN, 'todo')
  assert(todo[0]?.title === 'VT-B created second', 'newest task sits at the very TOP of the column (not the bottom)')
  assert(todo[1]?.title === 'VT-A created first', 'the older of the two sits right below it')
  assert(todo[1]?.position === 1, 'previous top card was shifted down to position 1')
  assert(todo.every((t, i) => t.position === i), `column positions stay gap-free (got: ${todo.map((t) => t.position).join(',')})`)

  // 2) Stage change through updateTask (the edit-dialog path): lands on TOP
  //    of the destination column, above everything already there.
  const moved = await supabaseBackend.updateTask(a.data!.id, { status: 'in_progress' })
  assert(!moved.error, 'stage change saved')
  assert(moved.data!.position === 0, 'moved task takes position 0 in the new stage')
  let prog = columnOrder(JOHN, 'in_progress')
  assert(prog[0]?.id === a.data!.id, 'task that changed stage is at the TOP of the new column')

  // …and a second arrival is stacked above the first one, not below.
  const c = await supabaseBackend.createTask({ worker_id: JOHN, client_id: null, title: 'VT-C', status: 'in_progress' })
  assert(!c.error, 'task created straight into the destination stage')
  prog = columnOrder(JOHN, 'in_progress')
  assert(prog[0]?.id === c.data!.id && prog[1]?.id === a.data!.id, 'a later arrival stacks ABOVE earlier ones')
  assert(prog.every((t, i) => t.position === i), 'destination column stays gap-free')

  // 3) Assignee change (admin hands the card to another worker): TOP of the
  //    new worker's column there too.
  const reassigned = await supabaseBackend.updateTask(b.data!.id, { worker_id: SARAH })
  assert(!reassigned.error, 'assignee change saved')
  assert(reassigned.data!.position === 0, 'reassigned task takes position 0')
  const sarahTodo = columnOrder(SARAH, 'todo')
  assert(sarahTodo[0]?.id === b.data!.id, "reassigned task is at the TOP of the new worker's column")

  // 4) An explicit drag-drop position is still honoured (NOT forced to top).
  prog = columnOrder(JOHN, 'in_progress')
  const bottom = prog.length - 1
  const dropped = await supabaseBackend.moveTask(c.data!.id, 'in_progress', bottom)
  assert(!dropped.error, 'explicit move saved')
  prog = columnOrder(JOHN, 'in_progress')
  assert(prog[bottom]?.id === c.data!.id, 'explicit drop index is honoured (card dropped at the bottom stays at the bottom)')
  assert(prog.every((t, i) => t.position === i), 'positions stay gap-free after the explicit drop')

  // 5) Archiving & restoring completed tasks.
  const comp1 = await supabaseBackend.createTask({ worker_id: JOHN, client_id: null, title: 'VT-Supabase-Comp', status: 'completed' })
  assert(!comp1.error, 'completed task created')
  assert(comp1.data!.archived_at === null, 'task starts unarchived')

  const now = new Date().toISOString()
  const archived = await supabaseBackend.updateTask(comp1.data!.id, { archived_at: now })
  assert(!archived.error, 'archived task saved')
  assert(archived.data!.archived_at === now, 'task has archived_at timestamp')

  const restored = await supabaseBackend.updateTask(comp1.data!.id, { archived_at: null })
  assert(!restored.error, 'restored task saved')
  assert(restored.data!.archived_at === null, 'task archived_at cleared')
  assert(restored.data!.position === 0, 'restored task lands at position 0')

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.')
  if (failures) process.exitCode = 1
}

main()
