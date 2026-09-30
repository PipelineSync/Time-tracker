/**
 * Verification of the KPI role (which Monthly Goal formula a worker gets) on the
 * Supabase side:
 *
 *   1. the REAL src/lib/supabaseDb.ts, pointed at the in-memory mock client —
 *      listWorkers reads the role, updateWorker writes it, createWorker sends it,
 *      and a database that has not run supabase/RUN-THIS-kpi-role.sql keeps
 *      working (it says which file to run, and saves everything else);
 *   2. the REAL netlify/functions/create-worker.ts with its Supabase helper
 *      replaced by a mock — the row it inserts, and what it does when the
 *      column is missing.
 *
 * Run: npx tsx scripts/verify-kpi-role-supabase.ts
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { state, resetState } from './supabase-mock/mock-supabase.mjs'
import * as fnMock from './supabase-mock/mock-create-worker.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const assert = (cond: unknown, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

// ---- load the REAL supabaseDb.ts against the mock client --------------------
const srcFile = path.join(root, 'src', 'lib', 'supabaseDb.ts')
const tmpFile = path.join(root, 'src', 'lib', '__test_kpi_role_supabaseDb_tmp.ts')
let mod: typeof import('../src/lib/supabaseDb')
try {
  const source = readFileSync(srcFile, 'utf8')
    .replaceAll('import.meta.env', 'globalThis.__VITE_ENV__')
    .replaceAll(`from '@supabase/supabase-js'`, `from '../../scripts/supabase-mock/mock-supabase.mjs'`)
  writeFileSync(tmpFile, source)
  ;(globalThis as any).__VITE_ENV__ = {
    VITE_SUPABASE_URL: 'https://mock.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'mock-pub-key',
  }
  mod = await import('../src/lib/__test_kpi_role_supabaseDb_tmp')
} finally {
  rmSync(tmpFile, { force: true })
}
const { supabaseBackend } = mod

// Capture what createWorker posts to the Netlify function.
const posted: Array<{ url: string; body: any }> = []
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url)
  if (u.includes('create-worker')) {
    posted.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
    return new Response(JSON.stringify({ worker: { id: 'w-new', name: 'New Hire', kpi_role: posted[posted.length - 1].body?.kpi_role ?? null } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (u.includes('sync-worker-profile')) {
    return new Response(JSON.stringify({ error: 'no match' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  }
  throw new Error(`No fetch handler for ${u}`)
}) as typeof fetch

const nowIso = () => new Date().toISOString()
const aliceRow = (over: Record<string, unknown> = {}) => ({
  id: 'w-1', user_id: 'user-admin', name: 'Alice', email: 'alice@example.com', hourly_rate: 30,
  status: 'active', position: 'Developer', color: 'blue', kpi_role: 'maintenance_outreach',
  payment_methods: ['cash'], permissions: [], workdays: [1, 2, 3, 4, 5], weekly_capacity_hours: 40,
  created_at: nowIso(), updated_at: nowIso(), ...over,
})

async function testSupabaseBackend() {
  console.log('\n--- 1. Supabase backend (src/lib/supabaseDb.ts) ---')
  resetState()
  state.authUser = { id: 'user-admin', email: 'admin@x.com' }
  state.users = [{ id: 'user-admin', email: 'admin@x.com', password: 'password' }]
  state.profiles = [{ user_id: 'user-admin', role: 'admin', worker_id: null }]
  state.workers = [aliceRow()]

  // S1 — a migrated database
  const list1 = await supabaseBackend.listWorkers()
  assert(!list1.error, 'listWorkers succeeds')
  assert(state.lastWorkersSelectColumns?.includes('kpi_role'), 'listWorkers asks for the kpi_role column')
  assert(list1.data?.[0]?.kpi_role === 'maintenance_outreach', 'the stored KPI role comes back on the worker')

  const set1 = await supabaseBackend.updateWorker('w-1', { kpi_role: 'social_media' })
  assert(!set1.error && set1.data?.kpi_role === 'social_media' && state.workers[0].kpi_role === 'social_media', 'updateWorker saves a KPI role')
  const junk = await supabaseBackend.updateWorker('w-1', { kpi_role: 'wizard' as any })
  assert(!junk.error && state.workers[0].kpi_role === null, 'an unknown role is stored as "no role", never as junk')
  const back = await supabaseBackend.updateWorker('w-1', { kpi_role: 'project' })
  assert(!back.error && state.workers[0].kpi_role === 'project', 'the role can be set again…')
  const clear = await supabaseBackend.updateWorker('w-1', { kpi_role: null })
  assert(!clear.error && state.workers[0].kpi_role === null, '…and cleared')
  const other = await supabaseBackend.updateWorker('w-1', { hourly_rate: 31 })
  assert(!other.error && state.lastWorkersUpdatePayload && !('kpi_role' in state.lastWorkersUpdatePayload), 'an edit that does not mention the role never sends the column')

  // createWorker posts the role to the function.
  const made = await supabaseBackend.createWorker({
    name: 'New Hire', hourly_rate: 12, accountEmail: 'new@example.com', accountPassword: 'secret1', kpi_role: 'project',
  })
  assert(!made.error && posted.at(-1)?.body?.kpi_role === 'project', 'createWorker sends the KPI role to the create-worker function')
  await supabaseBackend.createWorker({ name: 'No Role', hourly_rate: 12, accountEmail: 'nr@example.com', accountPassword: 'secret1' })
  assert(posted.at(-1)?.body?.kpi_role === null, 'and sends null when none was chosen')
  await supabaseBackend.createWorker({ name: 'Junk', hourly_rate: 12, accountEmail: 'j@example.com', accountPassword: 'secret1', kpi_role: 'wizard' as any })
  assert(posted.at(-1)?.body?.kpi_role === null, 'an unknown role is cleaned before it is sent')

  // S2 — a database that has not run RUN-THIS-kpi-role.sql
  state.workers = [aliceRow()]
  state.workersKpiRoleColumnMissing = true
  const warns: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '))
  }
  const list2 = await supabaseBackend.listWorkers()
  console.warn = origWarn
  assert(!list2.error && list2.data?.length === 1, 'listWorkers still works when the column is missing')
  assert(list2.data?.[0]?.kpi_role === null, 'every worker reads as "no role" there')
  assert(list2.data?.[0]?.name === 'Alice' && list2.data?.[0]?.hourly_rate === 30, 'the rest of the worker row is intact')
  assert(warns.some((w) => w.includes('kpi_role') && w.includes('RUN-THIS-kpi-role.sql')), 'a console warning names supabase/RUN-THIS-kpi-role.sql')
  assert(!!state.lastWorkersSelectColumns && !state.lastWorkersSelectColumns.includes('kpi_role'), 'the retry asked for the columns without kpi_role')

  // S3 — saving a role there: everything else is saved, and the admin is told what to run
  const save3 = await supabaseBackend.updateWorker('w-1', { kpi_role: 'project', hourly_rate: 35 })
  assert(!!save3.error && save3.error.includes('RUN-THIS-kpi-role.sql'), 'saving a role names supabase/RUN-THIS-kpi-role.sql')
  assert(save3.error?.includes('Everything else was saved'), '…and says everything else was saved')
  assert(state.workers[0].hourly_rate === 35, 'the other field (hourly rate) really was saved')
  assert(!('kpi_role' in state.workers[0]) || state.workers[0].kpi_role === 'maintenance_outreach', 'the role itself was not written')

  // S4 — an ordinary edit there is not turned into an error
  const save4 = await supabaseBackend.updateWorker('w-1', { hourly_rate: 36, position: 'Lead' })
  assert(!save4.error && state.workers[0].hourly_rate === 36, 'editing someone who has no role change works as before on an old database')

  // S5 — both the colour and the role column missing (an older database still)
  state.workersColorColumnMissing = true
  const list5 = await supabaseBackend.listWorkers()
  assert(!list5.error && list5.data?.length === 1 && list5.data[0].kpi_role === null && list5.data[0].color === null, 'with BOTH columns missing the worker list still loads')
  const save5 = await supabaseBackend.updateWorker('w-1', { kpi_role: 'project', color: 'rose', hourly_rate: 37 })
  assert(!!save5.error && state.workers[0].hourly_rate === 37, 'saving both on such a database still saves the rest and reports a migration message')
  state.workersColorColumnMissing = false
  state.workersKpiRoleColumnMissing = false
}

async function testCreateWorkerFunction() {
  console.log('\n--- 2. netlify/functions/create-worker.ts ---')
  const fnFile = path.join(root, 'netlify', 'functions', 'create-worker.ts')
  const fnTmp = path.join(root, 'netlify', 'functions', '__test_create_worker_tmp.ts')
  let handler: (req: Request) => Promise<Response>
  try {
    const source = readFileSync(fnFile, 'utf8').replaceAll(`from './lib/supabase'`, `from '../../scripts/supabase-mock/mock-create-worker.mjs'`)
    writeFileSync(fnTmp, source)
    handler = (await import('../netlify/functions/__test_create_worker_tmp')).default
  } finally {
    rmSync(fnTmp, { force: true })
  }
  const call = async (body: Record<string, unknown>) => {
    const res = await handler(new Request('http://localhost/.netlify/functions/create-worker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ name: 'Hire', hourly_rate: 10, accountEmail: `h${fnMock.state.authUsers.length}@example.com`, accountPassword: 'secret1', ...body }),
    }))
    return { status: res.status, body: (await res.json()) as any }
  }

  fnMock.resetState()
  const withRole = await call({ kpi_role: 'maintenance_outreach' })
  assert(withRole.status === 200 && fnMock.state.workerInserts[0]?.kpi_role === 'maintenance_outreach', 'a chosen KPI role is written on the new worker row')
  assert(withRole.body.worker?.kpi_role === 'maintenance_outreach' && !withRole.body.warning, '…and comes back without a warning')

  fnMock.resetState()
  const noRole = await call({})
  assert(noRole.status === 200 && !('kpi_role' in fnMock.state.workerInserts[0]), 'with no role the column is not touched at all')
  fnMock.resetState()
  const junkRole = await call({ kpi_role: 'wizard' })
  assert(junkRole.status === 200 && !('kpi_role' in fnMock.state.workerInserts[0]), 'an unknown role is dropped before the insert')

  // A database without the column:
  fnMock.resetState()
  fnMock.state.kpiRoleColumnMissing = true
  const old = await call({ kpi_role: 'social_media' })
  assert(old.status === 200 && fnMock.state.workers.length === 1, 'the worker is still created on a database without the column')
  assert(fnMock.state.workerInserts.length === 2 && 'kpi_role' in fnMock.state.workerInserts[0] && !('kpi_role' in fnMock.state.workerInserts[1]), 'the function retried without the role')
  assert(typeof old.body.warning === 'string' && old.body.warning.includes('RUN-THIS-kpi-role.sql'), 'and the response tells the admin to run supabase/RUN-THIS-kpi-role.sql')
  assert(fnMock.state.deletedAuthUsers.length === 0, 'the login account was kept')
  fnMock.resetState()
  fnMock.state.kpiRoleColumnMissing = true
  const oldNoRole = await call({})
  assert(oldNoRole.status === 200 && !oldNoRole.body.warning && fnMock.state.workerInserts.length === 1, 'adding a worker with no role on an un-migrated database is unchanged (no warning, one insert)')
  assert(fnMock.state.capabilityChecked === 'workers.manage', 'the function still requires the workers.manage capability')
}

async function main() {
  await testSupabaseBackend()
  await testCreateWorkerFunction()
  if (failures) {
    console.error(`\n${failures} check(s) FAILED`)
    process.exit(1)
  }
  console.log('\nAll KPI role (Supabase) checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
