/**
 * Verification of the client colour tag against the Supabase backend
 * (the REAL src/lib/supabaseDb.ts, pointed at the in-memory mock client):
 *  - a client can be re-coloured at any time — preset to preset, preset to
 *    a custom hex, custom hex to another hex — and the change survives a re-read
 *  - on a database that still enforces the ORIGINAL preset-only constraint
 *    (created before custom colours, migration not yet run), a custom hex is
 *    refused with the actionable "run client-custom-colors.sql" message — not
 *    the raw Postgres constraint error — while the eight built-in tags and
 *    plain renames / status toggles keep working
 * Run: npx tsx scripts/verify-clients-supabase.ts
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

function seedWorkspace() {
  resetState()
  state.users = [{ id: ADMIN.id, email: ADMIN.email, password: ADMIN.password }]
  state.profiles = [{ user_id: ADMIN.id, role: 'admin', worker_id: null }]
  state.workers = [{ id: 'worker-1', name: 'John', email: 'john@example.com' }]
  // Not used on the healthy-admin path; keeps the global fetch stub from
  // throwing if anything probes the repair endpoint.
  state.fetchHandlers['sync-worker-profile'] = () => ({ status: 404, body: { error: 'no match' } })
}

async function main() {
  // ---- 1) A database WITH the custom-colour migration -------------------
  seedWorkspace()
  const admin = await supabaseBackend.signIn(ADMIN.email, ADMIN.password)
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')

  const created = await supabaseBackend.createClient({ name: 'Umbrella Ltd', color: 'rose' })
  assert(!created.error && created.data?.color === 'rose', 'a client is created with a built-in colour tag')
  const id = created.data!.id

  const toPreset = await supabaseBackend.updateClient(id, { color: 'violet' })
  assert(!toPreset.error && toPreset.data?.color === 'violet', 'a client can be re-coloured to another built-in tag')

  const toHex = await supabaseBackend.updateClient(id, { color: '#ff6347' })
  assert(!toHex.error && toHex.data?.color === '#ff6347', 'a client can be re-coloured to a custom hex')

  const reRead = (await supabaseBackend.listClients()).data || []
  assert(reRead.find((c) => c.id === id)?.color === '#ff6347', 'the custom colour survives a re-read')

  const hexToHex = await supabaseBackend.updateClient(id, { color: '#1d4ed8' })
  assert(!hexToHex.error && hexToHex.data?.color === '#1d4ed8', 'a custom hex can be changed to another custom hex')

  await supabaseBackend.signOut()

  // ---- 2) A database WITHOUT the migration (legacy preset-only check) ---
  seedWorkspace()
  state.legacyClientColorConstraint = true
  const admin2 = await supabaseBackend.signIn(ADMIN.email, ADMIN.password)
  assert(!admin2.error, 'admin can sign in on the legacy database')

  const legacy = await supabaseBackend.createClient({ name: 'Acme Corp', color: 'blue' })
  assert(!legacy.error && legacy.data?.color === 'blue', 'the eight built-in tags still work on a legacy database')
  const legacyId = legacy.data!.id

  const legacyPreset = await supabaseBackend.updateClient(legacyId, { color: 'emerald' })
  assert(!legacyPreset.error && legacyPreset.data?.color === 'emerald', 'built-in tags can still be swapped on a legacy database')

  const legacyHex = await supabaseBackend.updateClient(legacyId, { color: '#ff6347' })
  assert(
    !!legacyHex.error && legacyHex.error!.includes('client-custom-colors.sql'),
    'a custom colour on a legacy database reports the one-time fix, not a raw constraint error'
  )
  assert(
    !(legacyHex.error && legacyHex.error.includes('violates check constraint')),
    'the legacy refusal never leaks the raw Postgres constraint error'
  )

  const legacyRename = await supabaseBackend.updateClient(legacyId, { name: 'Acme Corporation' })
  assert(!legacyRename.error && legacyRename.data?.name === 'Acme Corporation', 'renaming still works on a legacy database')

  const legacyStatus = await supabaseBackend.updateClient(legacyId, { status: 'inactive' })
  assert(!legacyStatus.error && legacyStatus.data?.status === 'inactive', 'marking a client inactive still works on a legacy database')

  const legacyCreateHex = await supabaseBackend.createClient({ name: 'Hexworks', color: '#123456' })
  assert(
    !!legacyCreateHex.error && legacyCreateHex.error!.includes('client-custom-colors.sql'),
    'adding a client with a custom colour on a legacy database reports the one-time fix'
  )

  const legacyCreatePreset = await supabaseBackend.createClient({ name: 'Globex', color: 'amber' })
  assert(!legacyCreatePreset.error && legacyCreatePreset.data?.color === 'amber', 'adding a client with a built-in tag still works on a legacy database')

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll supabase client checks passed.')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
