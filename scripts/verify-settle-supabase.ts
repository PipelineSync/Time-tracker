/**
 * Verification of "Settle & reset" in Supabase mode. Runs the REAL
 * src/lib/supabaseDb.ts (rewritten in-memory to point at a mock Supabase client
 * that evaluates the same queries and applies the same RLS as the schema) and
 * checks that settling pays out unsettled time while KEEPING the time entries.
 *
 * Run: npx tsx scripts/verify-settle-supabase.ts
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { state, resetState } from './supabase-mock/mock-chat-supabase.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcFile = path.join(root, 'src', 'lib', 'supabaseDb.ts')
const tmpFile = path.join(root, 'src', 'lib', '__test_supabaseDb_tmp.ts')

let mod: typeof import('../src/lib/supabaseDb')
try {
  const source = readFileSync(srcFile, 'utf8')
    .replaceAll('import.meta.env', 'globalThis.__VITE_ENV__')
    .replaceAll(`from '@supabase/supabase-js'`, `from '../../scripts/supabase-mock/mock-chat-supabase.mjs'`)
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
const round2 = (n: number) => Math.round(n * 100) / 100

/** Hours starting at 08:00 UTC on day `dayOffset` from today. */
function hours(dayOffset: number, lengthHours: number, rate: number) {
  const start = new Date()
  start.setUTCHours(8, 0, 0, 0)
  start.setUTCDate(start.getUTCDate() + dayOffset)
  const end = new Date(start.getTime() + lengthHours * 3600_000)
  return {
    id: `e-${dayOffset}-${lengthHours}`,
    user_id: ADMIN.id,
    worker_id: 'w-john',
    project: 'Site A',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    break_minutes: 0,
    notes: null,
    hourly_rate: rate,
    total_minutes: lengthHours * 60,
    earnings: round2(lengthHours * rate),
    created_at: start.toISOString(),
    updated_at: start.toISOString(),
    settled_at: null,
  }
}

function seedWorkspace() {
  resetState()
  state.workers = [{ id: 'w-john', user_id: ADMIN.id, name: 'John Smith', position: 'Foreman', avatar_url: null, status: 'active' }]
  state.profiles = [
    { user_id: ADMIN.id, role: 'admin', worker_id: null },
    { user_id: JOHN.id, role: 'worker', worker_id: 'w-john' },
  ]
  state.settings = [{ id: 's-1', user_id: ADMIN.id, business_name: 'Acme', currency: 'USD', timezone: 'UTC', avatar_url: null }]
  state.timeEntries = [hours(-2, 4, 20), hours(-1, 6, 20), hours(0, 2, 20)]
}

const johnEntries = () => state.timeEntries.filter((e: any) => e.worker_id === 'w-john')

async function scenario1_settle_keeps_entries() {
  console.log('\n--- S1: settling pays the unsettled time and keeps the entries ---')
  seedWorkspace()
  state.authUser = ADMIN

  const before = johnEntries()
  const minutes = before.reduce((s: number, e: any) => s + e.total_minutes, 0)
  const earnings = round2(before.reduce((s: number, e: any) => s + e.earnings, 0))

  const payment = await supabaseBackend.settleWorker('w-john', 'Weekly settlement')
  assert(!payment.error && payment.data, 'settling creates a payment')
  assert(payment.data!.hours === round2(minutes / 60), `payment hours match the unsettled entries (${payment.data!.hours})`)
  assert(payment.data!.amount === earnings, `payment amount matches the unsettled entries (${payment.data!.amount})`)
  assert(payment.data!.status === 'unpaid', 'the payment starts as unpaid')
  assert(payment.data!.note === 'Weekly settlement', 'the settlement note is stored')
  assert(
    payment.data!.period_start === before[0].start_time && payment.data!.period_end === before.at(-1)!.end_time,
    'the payment records the period it covers'
  )

  assert(johnEntries().length === 3, `every entry survives the settlement (${johnEntries().length} of 3)`)
  assert(johnEntries().every((e: any) => Boolean(e.settled_at)), 'the settled entries are stamped with settled_at')
  assert(
    !state.calls.some((c: any) => c.table === 'time_entries' && c.op === 'delete'),
    'settling never deletes time entries'
  )
  const workerNotifs = state.notifications.filter((n: any) => n.user_id === JOHN.id && n.type === 'payment')
  assert(workerNotifs.length === 1, 'the worker is notified about the payment')
}

async function scenario2_no_double_payment() {
  console.log('\n--- S2: settled time is not paid twice ---')
  seedWorkspace()
  state.authUser = ADMIN
  await supabaseBackend.settleWorker('w-john')

  const again = await supabaseBackend.settleWorker('w-john')
  assert(
    again.error === 'This worker has no unsettled time to settle.',
    `settling twice is refused (got: ${again.error})`
  )
  assert(state.payments.length === 1, `still a single payment (${state.payments.length})`)

  // New time is settled on its own, and the old entries are left alone.
  state.timeEntries.push(hours(1, 3, 20))
  const second = await supabaseBackend.settleWorker('w-john')
  assert(!second.error && second.data, 'the new time can be settled')
  assert(second.data!.hours === 3, `only the new entry is settled (${second.data!.hours}h)`)
  assert(johnEntries().length === 4, `entries keep accumulating (${johnEntries().length})`)

  const deleted = await supabaseBackend.deleteEntry(state.timeEntries.at(-1)!.id)
  assert(!deleted.error, 'the admin can still delete an entry by hand')
  assert(johnEntries().length === 3, 'only the deleted entry is gone')
  assert(johnEntries().every((e: any) => Boolean(e.settled_at)), 'the settled entries are all still there')
}

async function scenario3_worker_cannot_settle() {
  console.log('\n--- S3: only the admin settles ---')
  seedWorkspace()
  state.authUser = JOHN
  const res = await supabaseBackend.settleWorker('w-john')
  assert(res.error === 'Only the admin can settle worker time.', 'a worker cannot settle time')
  assert(johnEntries().length === 3, 'nothing was stamped or removed')
}

async function scenario4_database_without_settled_at() {
  console.log('\n--- S4: database without the settled_at column ---')
  seedWorkspace()
  state.missingColumns = ['settled_at']
  state.authUser = ADMIN

  // A settlement from before the migration: its period_end is the paid-up-to
  // boundary the fallback uses.
  const cutoff = state.timeEntries[1].end_time
  state.payments.push({
    id: 'p-old',
    user_id: ADMIN.id,
    worker_id: 'w-john',
    amount: 200,
    hours: 10,
    status: 'paid',
    period_start: state.timeEntries[0].start_time,
    period_end: cutoff,
    note: null,
    created_at: state.timeEntries[1].end_time,
  })

  const payment = await supabaseBackend.settleWorker('w-john')
  assert(!payment.error && payment.data, `settling still works without the column (got: ${payment.error})`)
  assert(payment.data!.hours === 2, `only the time after the last settlement is paid (${payment.data!.hours}h)`)
  assert(johnEntries().length === 3, `the entries are still kept (${johnEntries().length} of 3)`)
  assert(
    !state.calls.some((c: any) => c.table === 'time_entries' && c.op === 'delete'),
    'no entry is deleted on the fallback path either'
  )

  // With no settlement yet, everything counts as unsettled.
  state.payments = []
  const first = await supabaseBackend.settleWorker('w-john')
  assert(!first.error && first.data!.hours === 12, `without a boundary all time is settled (${first.data?.hours}h)`)
  assert(johnEntries().length === 3, 'and every entry is still there')
}

async function main() {
  await scenario1_settle_keeps_entries()
  await scenario2_no_double_payment()
  await scenario3_worker_cannot_settle()
  await scenario4_database_without_settled_at()
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall settle/supabase checks passed')
  if (failures) process.exit(1)
}

await main()
