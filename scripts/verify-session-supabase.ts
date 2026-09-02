/**
 * Verification of the "stay signed in until the user logs out" session logic
 * in src/lib/supabaseDb.ts. Runs the REAL module (rewritten in-memory to point
 * at the mock Supabase client) through the states that previously caused
 * random auto-logouts:
 *
 *   1. healthy session                       → stays signed in
 *   2. network blip while validating         → NOT a sign-out, retried
 *   3. stored session disappears (storage wiped / cross-tab race) while the
 *      refresh token is still valid server-side → session restored silently
 *   4. restore attempt hits a network error  → NOT a sign-out, retried
 *   5. explicit sign-out                     → signed out for real (no zombie
 *      restore from memory)
 *   6. refresh token revoked server-side     → signed out (the only correct
 *      outcome)
 *   7. expired/invalid access token whose refresh token still works → restored
 *   8. admin deleted the worker (deactivated) → signed out with the specific
 *      notice; no zombie restore afterwards
 *
 * Run: npx tsx scripts/verify-session-supabase.ts
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { state, resetState, signInAs } from './supabase-mock/mock-session-supabase.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcFile = path.join(root, 'src', 'lib', 'supabaseDb.ts')
const tmpFile = path.join(root, 'src', 'lib', '__test_session_supabaseDb_tmp.ts')

let mod: typeof import('../src/lib/supabaseDb')
try {
  const source = readFileSync(srcFile, 'utf8')
    .replaceAll('import.meta.env', 'globalThis.__VITE_ENV__')
    .replaceAll(`from '@supabase/supabase-js'`, `from '../../scripts/supabase-mock/mock-session-supabase.mjs'`)
  writeFileSync(tmpFile, source)
  globalThis.__VITE_ENV__ = {
    VITE_SUPABASE_URL: 'https://mock.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'mock-pub-key',
  }
  mod = await import('../src/lib/__test_session_supabaseDb_tmp')
} finally {
  rmSync(tmpFile, { force: true })
}
const { supabaseBackend, ACCOUNT_DEACTIVATED_MESSAGE } = mod

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

const ADMIN = { id: 'user-admin', email: 'admin@x.com' }
const JOHN = { id: 'user-john', email: 'john@x.com' }

function seed() {
  resetState()
  state.users = [
    { ...ADMIN, password: 'pw' },
    { ...JOHN, password: 'pw' },
  ]
  state.profiles = [
    { user_id: ADMIN.id, role: 'admin', worker_id: null },
    { user_id: JOHN.id, role: 'worker', worker_id: 'w-john' },
  ]
  state.workers = [{ id: 'w-john' }]
}

const setSessionCalls = () => state.calls.setSession

// ---------------------------------------------------------------- 0. baseline
seed()
const p0 = await supabaseBackend.getSession()
assert(p0.data === null && p0.error === null, 'fresh page with no session is signed out (no error, no user)')

// ------------------------------------------------------ 1. healthy session
const healthy = signInAs(ADMIN)
const p1 = await supabaseBackend.getSession()
assert(p1.data !== null && p1.error === null, 'healthy session stays signed in')
assert(p1.data?.email === ADMIN.email && p1.data?.role === 'admin', 'authenticated user is the admin')
assert(setSessionCalls() === 0, 'healthy path performs no session restore')

// --------------------------------- 2. transient network error while checking
state.modes.getUser = 'network'
const p2 = await supabaseBackend.getSession()
assert(p2.data === null && p2.error !== null, 'network blip returns a transient error, not a sign-out')
assert(p2.error !== ACCOUNT_DEACTIVATED_MESSAGE, 'network blip is not reported as a deactivation')
assert(/fetch/i.test(p2.error ?? ''), `transient error is the network message ("${p2.error}")`)
state.modes.getUser = 'ok'
const p2b = await supabaseBackend.getSession()
assert(p2b.data !== null && p2b.error === null, 'session is still valid on the next check after the blip')

// --------------- 3. stored session disappears but refresh token is still good
state.storedSession = null // e.g. localStorage cleared under us
const p3 = await supabaseBackend.getSession()
assert(p3.data !== null && p3.error === null, 'wiped storage + valid refresh token → session restored, still signed in')
assert(p3.data?.email === ADMIN.email, 'restored session is the same account')
assert(setSessionCalls() >= 1, 'restore used setSession with the remembered tokens')

// -------------------------- 3b. restore attempt hits a network error → retry
state.storedSession = null
state.modes.setSession = 'network'
const p3b = await supabaseBackend.getSession()
assert(p3b.data === null && p3b.error !== null && p3b.error !== ACCOUNT_DEACTIVATED_MESSAGE, 'failed restore (network) is transient — user is NOT signed out')
state.modes.setSession = 'auto'
const p3c = await supabaseBackend.getSession()
assert(p3c.data !== null && p3c.error === null, 'restore succeeds on the next check once the network is back')

// ----------------------------------------------- 4. explicit sign-out sticks
await supabaseBackend.signOut()
assert(state.storedSession === null, 'sign-out cleared the stored session')
const before = setSessionCalls()
const p4 = await supabaseBackend.getSession()
assert(p4.data === null && p4.error === null, 'after sign-out the next check is a clean signed-out state')
assert(setSessionCalls() === before, 'sign-out forgets the in-page session — no zombie restore afterwards')

// --------------------------------------- 5. server revoked the session → out
signInAs(ADMIN)
const p5a = await supabaseBackend.getSession()
assert(p5a.data !== null, 'signed back in before revoking')
state.serverByRefresh.clear()
state.serverByAccess.clear()
state.storedSession = null // the wipe that would normally trigger a restore
const p5 = await supabaseBackend.getSession()
assert(p5.data === null && p5.error === null, 'revoked session (server rejected the restore) → genuinely signed out')

// -------------------------- 6. expired token + valid refresh token → healed
// The access token is rejected (the background refresh had failed while it was
// still running), but the refresh token is still valid server-side.
const old = signInAs(ADMIN, { expired: true })
state.modes.getUser = 'invalid'
const p6 = await supabaseBackend.getSession()
assert(p6.data !== null && p6.error === null, 'rejected access token with a valid refresh token → session refreshed, signed in')
assert(p6.data?.email === ADMIN.email, 'refreshed session is the same account')
assert(state.storedSession !== null && state.storedSession.refresh_token !== old.refresh_token, 'session was actually rotated (refresh token renewed)')

// ---------------------------------------------- 7. deactivated mid-session
await supabaseBackend.signOut()
state.workers = [] // admin deletes the worker row while signed in
signInAs(JOHN)
const p7 = await supabaseBackend.getSession()
assert(p7.data === null && p7.error === ACCOUNT_DEACTIVATED_MESSAGE, 'deleted worker account is signed out with the deactivation notice')
assert(state.storedSession === null, 'deactivation also cleared the stored session')
const before7 = setSessionCalls()
const p7b = await supabaseBackend.getSession()
assert(p7b.data === null && p7b.error === null, 'after deactivation the account stays signed out')
assert(setSessionCalls() === before7, 'deactivation forgets the session — no restore attempts afterwards')

// --------------------------------------------- 8. sign-in refused if deleted
state.workers = []
const p8 = await supabaseBackend.signIn(JOHN.email, 'pw')
assert(p8.error === ACCOUNT_DEACTIVATED_MESSAGE, 'signing in with a deleted worker account is refused with the deactivation notice')
assert(state.storedSession === null, 'the refused sign-in left no session behind')
const before8 = setSessionCalls()
const p8b = await supabaseBackend.getSession()
assert(p8b.data === null && p8b.error === null, 'no zombie session after the refused sign-in')
assert(setSessionCalls() === before8, 'no restore attempts after the refused sign-in')

console.log(failures === 0 ? '\nAll session checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
