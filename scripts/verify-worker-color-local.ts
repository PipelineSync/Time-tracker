/**
 * Verification of worker colour tags (Requirement 2):
 *  - Seed workers carry distinct colour tags (Jasper blue, Matthew violet, etc.)
 *  - createWorker and updateWorker persist colour tags (built-in tags + custom hex)
 *  - Invalid colours fall back to null without erroring
 *  - normalizeWorker on a row without the field returns null
 *  - Supabase listWorkers strip-and-retry ladder succeeds when color column is missing
 *  - Supabase updateWorker strip-and-retry ladder when color column is missing
 *
 * Run: npx tsx scripts/verify-worker-color-local.ts
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { state, resetState } from './supabase-mock/mock-supabase.mjs'

// Minimal browser stub so storage.ts works in Node.
const mem = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  },
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

async function testLocalBackend() {
  console.log('\n--- Local backend & helpers ---')
  const { localBackend, normalizeWorker: localNormalizeWorker } = await import('../src/lib/localDb')
  const {
    normalizeWorker,
    normalizeWorkerColor,
    isValidWorkerColor,
    isWorkerColorPreset,
    workerColorStyles,
    WORKER_COLORS,
    WORKER_COLOR_NAMES,
  } = await import('../src/lib/types')

  // 1. Tag vocabulary constants
  assert(WORKER_COLORS.length === 8, '8 built-in worker colours are exported')
  assert(WORKER_COLORS.includes('blue') && WORKER_COLORS.includes('rose'), 'built-in colours include blue and rose')
  assert(WORKER_COLOR_NAMES['blue'] === 'Blue', 'WORKER_COLOR_NAMES maps presets')

  // 2. Validation & normalization helpers
  assert(isWorkerColorPreset('blue') === true, 'blue is a preset')
  assert(isWorkerColorPreset('#123456') === false, '#123456 is not a preset')
  assert(isValidWorkerColor('blue') === true, 'blue is a valid worker colour')
  assert(isValidWorkerColor('#123456') === true, '#123456 is a valid worker colour')
  assert(isValidWorkerColor('#abc') === true, '#abc is a valid worker colour')
  assert(isValidWorkerColor('not-a-color') === false, 'invalid tag rejected')
  assert(isValidWorkerColor(null) === false, 'null is not valid')
  assert(isValidWorkerColor(123) === false, 'number is not valid')

  assert(normalizeWorkerColor('blue') === 'blue', 'normalizeWorkerColor preserves valid preset')
  assert(normalizeWorkerColor('  #10B981  ') === '#10B981', 'normalizeWorkerColor trims valid hex')
  assert(normalizeWorkerColor('bad-color') === null, 'normalizeWorkerColor returns null for invalid tag')
  assert(normalizeWorkerColor(null) === null, 'normalizeWorkerColor returns null for null')
  assert(normalizeWorkerColor(undefined) === null, 'normalizeWorkerColor returns null for undefined')

  // 3. workerColorStyles
  assert(workerColorStyles('blue')?.chart === '#0868D9', 'workerColorStyles resolves blue chart hex')
  assert(workerColorStyles('#123456')?.chart === '#123456', 'workerColorStyles resolves custom hex')
  assert(workerColorStyles(null) === null, 'workerColorStyles returns null for unset')
  assert(workerColorStyles('bad-tag') === null, 'workerColorStyles returns null for bad tag')

  // 4. normalizeWorker on row without field
  const bareRow: any = { id: 'w-test', name: 'Test Worker', hourly_rate: 20 }
  const normalized = normalizeWorker(bareRow)
  assert(normalized.color === null, 'normalizeWorker on row without color returns null')
  assert(localNormalizeWorker(bareRow).color === null, 'localDb.normalizeWorker on row without color returns null')

  const rowWithUndefined = normalizeWorker({ ...bareRow, color: undefined })
  assert(rowWithUndefined.color === null, 'normalizeWorker with color:undefined returns null')

  const rowWithInvalid = normalizeWorker({ ...bareRow, color: 'nonexistent-color' })
  assert(rowWithInvalid.color === null, 'normalizeWorker with invalid color returns null')

  const rowWithValidPreset = normalizeWorker({ ...bareRow, color: 'violet' })
  assert(rowWithValidPreset.color === 'violet', 'normalizeWorker with valid preset keeps violet')

  const rowWithValidHex = normalizeWorker({ ...bareRow, color: '#36B7C9' })
  assert(rowWithValidHex.color === '#36B7C9', 'normalizeWorker with valid hex keeps #36B7C9')

  // 5. Admin signs in & seed check
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')

  const workers = (await localBackend.listWorkers()).data!
  const byName = (name: string) => workers.find((w) => w.name === name)
  const jasper = byName('Jasper Maristela')
  const matthew = byName('Matthew Luzung')
  const jea = byName('Jea Crizel Pineda')
  const april = byName('April Joy Manabat')
  const mary = byName('Mary Gracelyn')
  const sarah = byName('Sarah Johnson')
  const john = byName('John Smith')

  assert(jasper?.color === 'blue', 'Jasper has seeded blue colour')
  assert(matthew?.color === 'violet', 'Matthew has seeded violet colour')
  assert(jea?.color === 'aqua', 'Jea has seeded aqua colour')
  assert(april?.color === 'amber', 'April has seeded amber colour')
  assert(mary?.color === 'rose', 'Mary has seeded rose colour')
  assert(sarah?.color === 'emerald', 'Sarah has seeded emerald colour')
  assert(john?.color === null, 'John has null colour by default')

  // 6. createWorker with built-in colour
  const createdOrange = await localBackend.createWorker({
    name: 'Orange Member',
    hourly_rate: 22,
    color: 'orange',
    accountEmail: 'orange@example.com',
    accountPassword: 'password123',
  })
  assert(!createdOrange.error && createdOrange.data?.color === 'orange', 'createWorker saves built-in colour')
  const reReadOrange = (await localBackend.listWorkers()).data!.find((w) => w.id === createdOrange.data!.id)
  assert(reReadOrange?.color === 'orange', 'created worker colour survives re-read')

  // 7. createWorker with custom hex
  const createdHex = await localBackend.createWorker({
    name: 'Pink Member',
    hourly_rate: 25,
    color: '#ff1493',
    accountEmail: 'pink@example.com',
    accountPassword: 'password123',
  })
  assert(!createdHex.error && createdHex.data?.color === '#ff1493', 'createWorker saves custom hex colour')
  const reReadHex = (await localBackend.listWorkers()).data!.find((w) => w.id === createdHex.data!.id)
  assert(reReadHex?.color === '#ff1493', 'created custom hex survives re-read')

  // 8. updateWorker persists colour change
  const updatedToSlate = await localBackend.updateWorker(createdOrange.data!.id, { color: 'slate' })
  assert(!updatedToSlate.error && updatedToSlate.data?.color === 'slate', 'updateWorker changes colour to slate')
  const reReadSlate = (await localBackend.listWorkers()).data!.find((w) => w.id === createdOrange.data!.id)
  assert(reReadSlate?.color === 'slate', 'updated colour survives re-read')

  // 9. updateWorker clears colour to null
  const cleared = await localBackend.updateWorker(createdOrange.data!.id, { color: null })
  assert(!cleared.error && cleared.data?.color === null, 'updateWorker clears colour to null')
  const reReadCleared = (await localBackend.listWorkers()).data!.find((w) => w.id === createdOrange.data!.id)
  assert(reReadCleared?.color === null, 'cleared colour survives re-read as null')

  // 10. invalid colour falls back to null without erroring
  const invalidCreate = await localBackend.createWorker({
    name: 'Invalid Color Worker',
    hourly_rate: 20,
    color: 'invalid-tag-123' as any,
    accountEmail: 'invalid@example.com',
    accountPassword: 'password123',
  })
  assert(!invalidCreate.error && invalidCreate.data?.color === null, 'createWorker with invalid colour falls back to null without erroring')

  const invalidUpdate = await localBackend.updateWorker(createdHex.data!.id, { color: 'not-a-hex' as any })
  assert(!invalidUpdate.error && invalidUpdate.data?.color === null, 'updateWorker with invalid colour falls back to null without erroring')

  await localBackend.deleteWorker(createdOrange.data!.id)
  await localBackend.deleteWorker(createdHex.data!.id)
  await localBackend.deleteWorker(invalidCreate.data!.id)
}

async function testSupabaseBackend() {
  console.log('\n--- Supabase backend & strip-retry ladders ---')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const srcFile = path.join(root, 'src', 'lib', 'supabaseDb.ts')
  const tmpFile = path.join(root, 'src', 'lib', '__test_worker_color_supabaseDb_tmp.ts')

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
    mod = await import('../src/lib/__test_worker_color_supabaseDb_tmp')
  } finally {
    rmSync(tmpFile, { force: true })
  }
  const { supabaseBackend } = mod

  resetState()
  state.authUser = { id: 'user-admin', email: 'admin@x.com' }
  state.users = [{ id: 'user-admin', email: 'admin@x.com', password: 'password' }]
  state.profiles = [{ user_id: 'user-admin', role: 'admin', worker_id: null }]
  state.workers = [
    {
      id: 'w-1',
      user_id: 'user-admin',
      name: 'Alice',
      email: 'alice@example.com',
      hourly_rate: 30,
      status: 'active',
      position: 'Developer',
      color: 'blue',
      payment_methods: ['cash'],
      permissions: [],
      workdays: [1, 2, 3, 4, 5],
      weekly_capacity_hours: 40,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ]

  // S1: Normal listWorkers includes color in query and returns it
  const list1 = await supabaseBackend.listWorkers()
  assert(!list1.error, 'listWorkers succeeds')
  assert(state.lastWorkersSelectColumns?.includes('color'), 'listWorkers selects the color column')
  assert(list1.data?.[0]?.color === 'blue', 'worker color is returned by listWorkers')

  // S2: Database without color column triggers strip-and-retry ladder
  state.workersColorColumnMissing = true
  const consoleWarns: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => {
    consoleWarns.push(args.map(String).join(' '))
    origWarn(...args)
  }

  const listWithoutColor = await supabaseBackend.listWorkers()
  console.warn = origWarn

  assert(!listWithoutColor.error, 'listWorkers succeeds when color column is missing')
  assert(listWithoutColor.data?.[0]?.color === null, 'worker color falls back to null when column is missing')
  assert(
    consoleWarns.some((msg) => msg.includes('workers.color column is missing') && msg.includes('RUN-THIS-worker-color.sql')),
    'a console warning naming RUN-THIS-worker-color.sql is emitted',
  )
  assert(
    state.lastWorkersSelectColumns !== null && !state.lastWorkersSelectColumns.includes('color'),
    'the retry query stripped the color column',
  )

  // S3: updateWorker on database without color column warns and retries without color
  const updRes = await supabaseBackend.updateWorker('w-1', { color: 'violet', hourly_rate: 35 })
  assert(!!updRes.error && updRes.error.includes('RUN-THIS-worker-color.sql'), 'updateWorker surfaces migration message when color column missing')
  assert(state.workers[0].hourly_rate === 35, 'other fields (hourly_rate) were still saved')

  state.workersColorColumnMissing = false
}

async function main() {
  await testLocalBackend()
  await testSupabaseBackend()
  if (failures) {
    console.error(`\n${failures} check(s) FAILED`)
    process.exit(1)
  } else {
    console.log('\nAll worker color checks passed.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
