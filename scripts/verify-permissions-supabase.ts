/**
 * Ad-hoc verification of the per-worker access round-trip against the
 * Supabase backend. Reproduces the published-app symptom of "I save the
 * worker's access and the switches snap back to off on refresh" by
 * asserting the column list that `listWorkers` actually asks for, and by
 * exercising `updateWorker` → `listWorkers` against an in-memory worker
 * table.
 *
 * Run: npx tsx scripts/verify-permissions-supabase.ts
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { state, resetState } from './supabase-mock/mock-supabase.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcFile = path.join(root, 'src', 'lib', 'supabaseDb.ts')
const tmpFile = path.join(root, 'src', 'lib', '__test_perm_supabaseDb_tmp.ts')

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
  mod = await import('../src/lib/__test_perm_supabaseDb_tmp')
} finally {
  rmSync(tmpFile, { force: true })
}
const { supabaseBackend } = mod

let failures = 0
const assert = (cond: unknown, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

function seedAdminWithWorker() {
  resetState()
  state.users = [{ id: 'user-admin', email: 'admin@x.com', password: 'admin123' }]
  state.profiles = [{ user_id: 'user-admin', role: 'admin', worker_id: null }]
  state.workers = [
    { id: 'worker-1', name: 'John', email: 'john@example.com', hourly_rate: 20, status: 'active', permissions: [] },
  ]
  state.authUser = { id: 'user-admin', email: 'admin@x.com' }
}

async function scenario1_selectIncludesPermissions() {
  console.log('\n--- S1: listWorkers asks the database for the permissions column ---')
  seedAdminWithWorker()
  await supabaseBackend.listWorkers()
  const cols = state.lastWorkersSelectColumns
  assert(
    typeof cols === 'string' && /\bpermissions\b/.test(cols),
    `listWorkers includes "permissions" in the SELECT (got: ${cols})`,
  )
  // Sanity: the previously-missing columns are also still requested.
  assert(typeof cols === 'string' && cols.includes('position'), 'listWorkers still asks for "position"')
  assert(typeof cols === 'string' && cols.includes('payment_methods'), 'listWorkers still asks for "payment_methods"')
}

async function scenario2_roundTrip() {
  console.log('\n--- S2: updateWorker permissions are visible on the very next listWorkers ---')
  seedAdminWithWorker()
  // Admin grants a view capability.
  const updated = await supabaseBackend.updateWorker('worker-1', { permissions: ['entries.view_all'] })
  assert(!updated.error && Array.isArray(updated.data?.permissions), `updateWorker accepted the patch (got: ${JSON.stringify(updated.data?.permissions)})`)
  assert(
    Array.isArray(updated.data?.permissions) && updated.data!.permissions.includes('entries.view_all'),
    'updateWorker returns the just-saved permissions',
  )

  // The next listWorkers — which is what `refreshData()` calls after every
  // save — must hand the admin back the row with permissions still attached.
  const list = await supabaseBackend.listWorkers()
  assert(!list.error, `listWorkers ok (got: ${list.error})`)
  const john = (list.data || []).find((w) => w.id === 'worker-1')
  assert(!!john, 'the worker is still in the list')
  assert(
    Array.isArray(john?.permissions) && john!.permissions.includes('entries.view_all'),
    `the row returned by listWorkers carries the saved permission (got: ${JSON.stringify(john?.permissions)})`,
  )
}

async function scenario3_revokeAllPersists() {
  console.log('\n--- S3: clearing all permissions round-trips as an empty array ---')
  seedAdminWithWorker()
  // First grant something, then clear it.
  await supabaseBackend.updateWorker('worker-1', { permissions: ['entries.view_all', 'tasks.view_all'] })
  const cleared = await supabaseBackend.updateWorker('worker-1', { permissions: [] })
  assert(!cleared.error, 'clearing the permissions is accepted')
  const list = await supabaseBackend.listWorkers()
  const john = (list.data || []).find((w) => w.id === 'worker-1')
  assert(
    Array.isArray(john?.permissions) && john!.permissions.length === 0,
    `listWorkers returns an empty permissions array after a clear (got: ${JSON.stringify(john?.permissions)})`,
  )
}

async function scenario4_missingColumnFallback() {
  console.log('\n--- S4: a database without the permissions column still lists workers ---')
  seedAdminWithWorker()
  // The migration hasn't been run: PostgREST rejects selects that mention
  // the `permissions` column. The backend should detect that, drop the
  // column, and warn (without breaking the page).
  state.workersPermissionsColumnMissing = true
  const consoleWarns: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    consoleWarns.push(args.map((a) => String(a)).join(' '))
  }
  try {
    const res = await supabaseBackend.listWorkers()
    assert(!res.error, `listWorkers still succeeds (got: ${res.error})`)
    const john = (res.data || []).find((w) => w.id === 'worker-1')
    assert(!!john, 'the worker row is still returned')
    assert(
      Array.isArray(john?.permissions) && john!.permissions.length === 0,
      `a worker on a database without the column reports no access (got: ${JSON.stringify(john?.permissions)})`,
    )
    assert(
      consoleWarns.some((w) => /worker-permissions\.sql/.test(w)),
      'the operator is told to run supabase/worker-permissions.sql',
    )
  } finally {
    console.warn = originalWarn
  }
}

async function scenario5_createTask_without_worker_id() {
  console.log('\n--- S5: a task manager who omits worker_id still gets a task on their own board ---')
  // Reproduces the published-app symptom where a worker with tasks.manage_all
  // (Supervisor / Manager / Full access) clicks "Add task" and the form
  // briefly omits a worker_id — the backend must fall back to their own id
  // instead of refusing with "Choose who the task is for."
  resetState()
  // Seed two users (admin + worker), one client, and the worker row with
  // Supervisor permissions. The admin signs in to grant those, then the
  // worker signs in to actually create the task — exactly the published-app
  // sequence.
  state.users = [
    { id: 'user-admin', email: 'admin@x.com', password: 'admin123' },
    { id: 'user-john', email: 'john@example.com', password: 'worker123' },
  ]
  state.profiles = [
    { user_id: 'user-admin', role: 'admin', worker_id: null },
    { user_id: 'user-john', role: 'worker', worker_id: 'worker-1' },
  ]
  state.workers = [
    {
      id: 'worker-1',
      name: 'John',
      email: 'john@example.com',
      hourly_rate: 20,
      status: 'active',
      permissions: ['tasks.view_all', 'tasks.manage_all', 'workers.view', 'dashboard.view', 'entries.view_all'],
    },
  ]
  state.clients = [{ id: 'client-1', name: 'Acme', color: 'blue', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]
  state.authUser = { id: 'user-john', email: 'john@example.com' }
  // signInWithPassword sets state.authUser and forces the auth cache to
  // re-resolve, so the backend's me.data!.workerId is correct.
  const session = await supabaseBackend.signIn('john@example.com', 'worker123')
  assert(!session.error, `the worker can sign in (got: ${session.error})`)
  assert(session.data?.workerId === 'worker-1', `the session carries the worker id (got: ${session.data?.workerId})`)

  // The form sends no worker_id (mirrors the buggy `worker_id: canAssign ? form.workerId : undefined`).
  const clients = (await supabaseBackend.listClients()).data || []
  const client = clients[0]
  const res = await supabaseBackend.createTask({ client_id: client.id, title: 'My own task' })
  assert(!res.error, `createTask without worker_id still succeeds (got: ${res.error})`)
  assert(
    res.data?.worker_id === 'worker-1',
    `the task lands on the worker's own board (got worker_id: ${res.data?.worker_id})`,
  )
}

async function main() {
  await scenario1_selectIncludesPermissions()
  await scenario2_roundTrip()
  await scenario3_revokeAllPersists()
  await scenario4_missingColumnFallback()
  await scenario5_createTask_without_worker_id()
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
