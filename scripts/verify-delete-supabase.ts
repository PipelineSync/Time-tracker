/**
 * Verification of the Supabase-mode "deleted worker can no longer log in" fix.
 * Runs the REAL src/lib/supabaseDb.ts (rewritten in-memory to point at a mock
 * Supabase client) against scripted backend states.
 *
 * Run: npx tsx scripts/verify-delete-supabase.ts
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
const { supabaseBackend, isSupabaseConfigured, ACCOUNT_DEACTIVATED_MESSAGE } = mod

globalThis.fetch = async (url) => {
  const entry = Object.entries(state.fetchHandlers).find(([k]) => String(url).includes(k))
  if (!entry) throw new Error(`No fetch handler for ${url}`)
  const { status = 200, body = {} } = entry[1](url)
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let failures = 0
const assert = (cond, msg) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

const JOHN_ID = 'user-john'
const JOHN_EMAIL = 'john@example.com'
const ADMIN = { id: 'user-admin', email: 'admin@x.com', password: 'admin123' }

function seedDeletedWorkerOrphan() {
  resetState()
  state.users = [{ id: JOHN_ID, email: JOHN_EMAIL, password: 'worker123' }]
  // Profile survived with the worker link nulled (pre-fix deletion state).
  state.profiles = [{ user_id: JOHN_ID, role: 'worker', worker_id: null }]
  state.workers = []
  // The profile-repair endpoint finds no matching worker row.
  state.fetchHandlers['sync-worker-profile'] = () => ({ status: 404, body: { error: 'no match' } })
}

async function scenario1_signIn_deletedWorker_isRefused() {
  console.log('\n--- S1: deleted worker (orphaned profile, no worker row) ---')
  seedDeletedWorkerOrphan()
  const res = await supabaseBackend.signIn(JOHN_EMAIL, 'worker123')
  assert(res.error === ACCOUNT_DEACTIVATED_MESSAGE, `login refused with deactivated message (got: ${res.error})`)
  assert(res.data === null, 'no user returned')
  assert(state.signOutCalls >= 1, 'just-created session was signed out')
  assert(state.authUser === null, 'no active session remains')
}

async function scenario2_signIn_deletedWorkerRow_isRefused() {
  console.log('\n--- S2: profile points at a missing worker row ---')
  resetState()
  state.users = [{ id: JOHN_ID, email: JOHN_EMAIL, password: 'worker123' }]
  state.profiles = [{ user_id: JOHN_ID, role: 'worker', worker_id: 'worker-gone' }]
  state.workers = []
  const res = await supabaseBackend.signIn(JOHN_EMAIL, 'worker123')
  assert(res.error === ACCOUNT_DEACTIVATED_MESSAGE, `login refused (got: ${res.error})`)
  assert(state.authUser === null, 'session dropped')
}

async function scenario3_getSession_activeDeletedWorker_signsOut() {
  console.log('\n--- S3: already-signed-in deleted worker → getSession deactivates ---')
  seedDeletedWorkerOrphan()
  state.authUser = { id: JOHN_ID, email: JOHN_EMAIL } // existing open session
  const res = await supabaseBackend.getSession()
  assert(res.data === null, 'no user in session result')
  assert(res.error === ACCOUNT_DEACTIVATED_MESSAGE, `store gets the deactivated sentinel (got: ${res.error})`)
  assert(state.authUser === null, 'local Supabase session signed out')
  const list = await supabaseBackend.listWorkers()
  assert(list.error === 'Not signed in.', `data ops now fail safely (got: ${list.error})`)
}

async function scenario4_getSession_validWorker_ok() {
  console.log('\n--- S4: valid worker still works ---')
  resetState()
  state.users = [{ id: JOHN_ID, email: JOHN_EMAIL, password: 'worker123' }]
  state.profiles = [{ user_id: JOHN_ID, role: 'worker', worker_id: 'worker-1' }]
  state.workers = [{ id: 'worker-1', name: 'John', email: JOHN_EMAIL }]
  state.authUser = { id: JOHN_ID, email: JOHN_EMAIL }
  const res = await supabaseBackend.getSession()
  assert(!res.error && res.data?.role === 'worker' && res.data?.workerId === 'worker-1', `valid worker resolves (got: ${JSON.stringify(res.data)})`)
}

async function scenario5_getSession_validAdmin_ok() {
  console.log('\n--- S5: valid admin still works ---')
  resetState()
  state.users = [{ id: ADMIN.id, email: ADMIN.email, password: ADMIN.password }]
  state.profiles = [{ user_id: ADMIN.id, role: 'admin', worker_id: null }]
  state.workers = []
  state.authUser = { id: ADMIN.id, email: ADMIN.email }
  const res = await supabaseBackend.getSession()
  assert(!res.error && res.data?.role === 'admin', `admin resolves (got: ${JSON.stringify(res.data)})`)
}

async function scenario6_transientError_doesNotDeactivate() {
  console.log('\n--- S6: transient profile-query error keeps the session ---')
  resetState()
  state.users = [{ id: JOHN_ID, email: JOHN_EMAIL, password: 'worker123' }]
  state.profiles = [{ user_id: JOHN_ID, role: 'worker', worker_id: 'worker-1' }]
  state.workers = [{ id: 'worker-1', name: 'John', email: JOHN_EMAIL }]
  state.authUser = { id: JOHN_ID, email: JOHN_EMAIL }
  state.profileQueryError = 'network hiccup'
  const res = await supabaseBackend.getSession()
  assert(res.data === null && res.error && res.error !== ACCOUNT_DEACTIVATED_MESSAGE, `transient error is a generic failure (got: ${res.error})`)
  assert(state.authUser !== null, 'session was NOT signed out on a transient error')

  // …and once the network recovers the session resolves normally.
  state.profileQueryError = null
  const res2 = await supabaseBackend.getSession()
  assert(!res2.error && res2.data?.role === 'worker', 'recovers on the next tick')
}

async function scenario7_legacyRepairStillWorks() {
  console.log('\n--- S7: legacy unlinked worker is re-linked by the repair endpoint ---')
  resetState()
  state.users = [{ id: JOHN_ID, email: JOHN_EMAIL, password: 'worker123' }]
  state.profiles = [{ user_id: JOHN_ID, role: 'worker', worker_id: null }]
  state.workers = [{ id: 'worker-1', name: 'John', email: JOHN_EMAIL }]
  // Repair endpoint finds the worker by email and re-links the profile.
  state.fetchHandlers['sync-worker-profile'] = () => {
    const p = state.profiles.find((x) => x.user_id === JOHN_ID)
    p.worker_id = 'worker-1'
    return { status: 200, body: { role: 'worker', workerId: 'worker-1', repaired: true } }
  }
  const res = await supabaseBackend.signIn(JOHN_EMAIL, 'worker123')
  assert(!res.error && res.data?.role === 'worker' && res.data?.workerId === 'worker-1', `legacy account repaired (got: ${JSON.stringify(res.data)})`)
}

async function scenario8_noProfile_neverBecomesAdmin() {
  console.log('\n--- S8: account with no profile row is blocked (not defaulted to admin) ---')
  resetState()
  state.users = [{ id: 'user-stranger', email: 'stranger@x.com', password: 'stranger123' }]
  state.profiles = []
  state.workers = []
  state.fetchHandlers['sync-worker-profile'] = () => ({ status: 404, body: { error: 'no match' } })
  const res = await supabaseBackend.signIn('stranger@x.com', 'stranger123')
  assert(res.error === ACCOUNT_DEACTIVATED_MESSAGE, `stranger blocked (got: ${res.error})`)
  assert(res.data?.role !== 'admin', 'never falls back to the admin role')
}

async function scenario9_deleteWorker_viaFunction() {
  console.log('\n--- S9: deleteWorker uses the privileged function ---')
  resetState()
  state.users = [{ id: ADMIN.id, email: ADMIN.email, password: ADMIN.password }, { id: JOHN_ID, email: JOHN_EMAIL, password: 'worker123' }]
  state.profiles = [{ user_id: ADMIN.id, role: 'admin', worker_id: null }, { user_id: JOHN_ID, role: 'worker', worker_id: 'worker-1' }]
  state.workers = [{ id: 'worker-1', name: 'John', email: JOHN_EMAIL }]
  state.authUser = { id: ADMIN.id, email: ADMIN.email }
  let fnCalled = 0
  state.fetchHandlers['delete-worker'] = () => {
    fnCalled += 1
    return { status: 200, body: { ok: true } }
  }
  const res = await supabaseBackend.deleteWorker('worker-1')
  assert(!res.error, `delete succeeds (got: ${res.error})`)
  assert(fnCalled === 1, 'delete-worker function was called')
  assert(state.workers.length === 1, 'direct DB delete NOT attempted (function handles everything)')
}

async function scenario10_deleteWorker_fallbackWhenFunctionMissing() {
  console.log('\n--- S10: undeployed function (SPA index.html 200) → data-only fallback ---')
  resetState()
  state.users = [{ id: ADMIN.id, email: ADMIN.email, password: ADMIN.password }, { id: JOHN_ID, email: JOHN_EMAIL, password: 'worker123' }]
  state.profiles = [{ user_id: ADMIN.id, role: 'admin', worker_id: null }, { user_id: JOHN_ID, role: 'worker', worker_id: 'worker-1' }]
  state.workers = [{ id: 'worker-1', name: 'John', email: JOHN_EMAIL }]
  state.authUser = { id: ADMIN.id, email: ADMIN.email }
  // Netlify SPA fallback: status 200 with non-JSON body.
  state.fetchHandlers['delete-worker'] = () => ({ status: 200, body: 'HTML_PAGE' })
  const res = await supabaseBackend.deleteWorker('worker-1')
  assert(!res.error, `delete still succeeds via fallback (got: ${res.error})`)
  assert(state.deletedWorkers.includes('worker-1'), 'worker row deleted directly')
  assert(state.deletedProfiles.includes(JOHN_ID), 'profile row deleted directly')

  // And the deleted worker's login is now refused client-side.
  state.authUser = null
  const login = await supabaseBackend.signIn(JOHN_EMAIL, 'worker123')
  assert(login.error === ACCOUNT_DEACTIVATED_MESSAGE, `orphaned login blocked client-side (got: ${login.error})`)
}

async function scenario11_deleteWorker_functionErrorSurfaces() {
  console.log('\n--- S11: function error is surfaced, not papered over ---')
  resetState()
  state.users = [{ id: ADMIN.id, email: ADMIN.email, password: ADMIN.password }]
  state.profiles = [{ user_id: ADMIN.id, role: 'admin', worker_id: null }]
  state.workers = [{ id: 'worker-1', name: 'John', email: JOHN_EMAIL }]
  state.authUser = { id: ADMIN.id, email: ADMIN.email }
  state.fetchHandlers['delete-worker'] = () => ({ status: 500, body: { error: 'supabase is down' } })
  const res = await supabaseBackend.deleteWorker('worker-1')
  assert(res.error === 'supabase is down', `function error surfaced (got: ${res.error})`)
  assert(state.workers.length === 1, 'worker row NOT half-deleted when the function errors')
}

async function main() {
  assert(isSupabaseConfigured(), 'supabase mode is active in this test')
  await scenario1_signIn_deletedWorker_isRefused()
  await scenario2_signIn_deletedWorkerRow_isRefused()
  await scenario3_getSession_activeDeletedWorker_signsOut()
  await scenario4_getSession_validWorker_ok()
  await scenario5_getSession_validAdmin_ok()
  await scenario6_transientError_doesNotDeactivate()
  await scenario7_legacyRepairStillWorks()
  await scenario8_noProfile_neverBecomesAdmin()
  await scenario9_deleteWorker_viaFunction()
  await scenario10_deleteWorker_fallbackWhenFunctionMissing()
  await scenario11_deleteWorker_functionErrorSurfaces()
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
