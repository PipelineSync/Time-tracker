/**
 * End-to-end check of the extension's clock logic against a mock Supabase.
 *
 * This drives the real modules in `src/lib` (no UI), so what it proves is what
 * matters: a worker can sign in, clock in, take a break, come back and clock
 * out — the rows land in the same shape the web app writes, the admin gets the
 * same notifications, and the break time is excluded from the hours.
 *
 * Run with:  npm run verify   (from the extension folder)
 */

import { startMockSupabase } from './mock-supabase.mjs'

// ---------------------------------------------------------------------------
// chrome.storage stub — the extension keeps its session and config here.
// ---------------------------------------------------------------------------
const store = new Map<string, unknown>()

;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      async get(key: string | string[] | null) {
        if (key === null) return Object.fromEntries(store)
        const keys = Array.isArray(key) ? key : [key]
        const out: Record<string, unknown> = {}
        for (const k of keys) if (store.has(k)) out[k] = store.get(k)
        return out
      },
      async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) store.set(k, JSON.parse(JSON.stringify(v)))
      },
      async remove(key: string) {
        store.delete(key)
      },
    },
  },
  runtime: { openOptionsPage() {}, lastError: null },
  permissions: {
    async contains() {
      return true
    },
    async request() {
      return true
    },
  },
}

const { saveConfig } = await import('../src/lib/config')
const { computeEarnings } = await import('../src/lib/format')
const api = await import('../src/lib/api')

// ---------------------------------------------------------------------------
// tiny test harness
// ---------------------------------------------------------------------------
let passed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failures.push(label)
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
  }
}

function near(actual: number, expected: number, tolerance: number) {
  return Math.abs(actual - expected) <= tolerance
}

function section(name: string) {
  console.log(`\n${name}`)
}

async function expectError(label: string, fn: () => Promise<unknown>, match: RegExp) {
  try {
    await fn()
    check(label, false, 'no error thrown')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(`${label} → ${message}`, match.test(message))
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const mock = await startMockSupabase()
const { db, ids } = mock
await saveConfig({ supabaseUrl: mock.url, anonKey: mock.anonKey })

const MINUTE = 60_000

console.log(`Running at ${new Date().toString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`)

try {
  section('Connection')
  const before = await api.loadState()
  check('signed out before signing in', before.kind === 'signed-out', before)

  await expectError('wrong password is refused', () => api.signIn('ana@example.com', 'nope'), /Wrong email or password/)
  await expectError(
    'admin accounts are refused',
    async () => {
      await api.signIn('boss@example.com', 'admin123')
      await api.loadState()
    },
    /extension is for worker accounts/,
  )
  await api.signOut()

  section('Sign in')
  await api.signIn('ana@example.com', 'worker123')
  const signedIn = await api.loadState()
  check('state is ready', signedIn.kind === 'ready', signedIn)
  if (signedIn.kind !== 'ready') throw new Error('cannot continue without a ready state')
  check('worker profile is loaded', signedIn.snapshot.worker.name === 'Ana Reyes', signedIn.snapshot.worker)
  check('no timer yet', signedIn.snapshot.timer === null)
  check('workspace settings are read', signedIn.snapshot.businessName === 'PipelineSync' && signedIn.snapshot.currency === 'USD')

  section('Clock in')
  await expectError('cannot break while clocked out', () => api.startBreak(), /not clocked in/)
  const timer = await api.clockIn({ project: 'Site A', notes: 'early  shift' })
  check('timer row created', db.active_timers.length === 1)
  check('timer points at the worker', timer.worker_id === ids.WORKER_ID)
  check('rate snapshotted from the worker row', timer.hourly_rate === 25)
  check('project saved', timer.project === 'Site A')
  check('not paused on clock in', timer.paused === false && timer.pause_start === null)
  check('admin notified of clock in', db.notifications.some((n) => n.type === 'time_in' && n.user_id === ids.ADMIN_ID))
  check(
    'clock-in notification reads like the web app',
    db.notifications.some((n) => n.message === 'Ana Reyes clocked in — Site A · early shift'),
    db.notifications.map((n) => n.message),
  )

  const again = await api.clockIn({ project: 'ignored' })
  check('clocking in twice resumes the open timer', again.id === timer.id && db.active_timers.length === 1)

  section('Break')
  await api.startBreak()
  const paused = db.active_timers[0]
  check('timer paused', paused.paused === true && typeof paused.pause_start === 'string')
  check(
    'admin notified of break start',
    db.notifications.some((n) => n.type === 'break_start' && n.message === 'Ana Reyes started a break'),
  )

  // Pretend the break has lasted 30 minutes.
  paused.pause_start = new Date(Date.now() - 30 * MINUTE).toISOString()
  await api.endBreak()
  const resumed = db.active_timers[0]
  check('timer resumed', resumed.paused === false && resumed.pause_start === null)
  check('30 minutes banked as break time', near(resumed.total_pause_ms, 30 * MINUTE, 5_000), resumed.total_pause_ms)
  check(
    'admin notified of break end',
    db.notifications.some((n) => n.type === 'break_end' && n.message === 'Ana Reyes is back from break'),
  )

  section('Clock out')
  // Backdate the shift to two hours ago — 2h on the clock minus the 30m break.
  // Never backdate past local midnight: the entry would stop counting as
  // "today" and the totals below would depend on the wall clock. (A CI run at
  // 00:05 failed exactly this way before the clamp existed.)
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const twoHoursAgo = new Date(Date.now() - 120 * MINUTE)
  const shiftStart = twoHoursAgo >= startOfDay ? twoHoursAgo : startOfDay
  const backdatedFully = shiftStart === twoHoursAgo

  resumed.start_time = shiftStart.toISOString()
  const { entry } = await api.clockOut('Wrap up')
  check('time entry written', db.time_entries.length === 1)
  check('timer cleared', db.active_timers.length === 0)

  // Worked = time on the clock minus the break, whatever the clock says.
  const workedMs = new Date(entry.end_time).getTime() - shiftStart.getTime() - 30 * MINUTE
  const expectedWorked = Math.max(0, Math.round(workedMs / 60000))
  check('worked time = time on the clock minus the break', Math.abs(entry.total_minutes - expectedWorked) <= 1, {
    actual: entry.total_minutes,
    expected: expectedWorked,
  })
  check('30 minutes of break', entry.break_minutes === 30, entry.break_minutes)
  check('earnings = hours × $25/hr', entry.earnings === computeEarnings(entry.total_minutes, 25), entry.earnings)
  if (backdatedFully) {
    check('90 minutes worked', entry.total_minutes === 90, entry.total_minutes)
    check('earnings = 1.5h × $25', entry.earnings === 37.5, entry.earnings)
  } else {
    console.log('  · within two hours of local midnight: skipped the fixed 90-minute assertion')
  }
  check('rate snapshotted on the entry', entry.hourly_rate === 25)
  check('clock-in note and clock-out note both kept', entry.notes === 'early  shift\nWrap up', entry.notes)
  check('entry owned by the workspace admin', (entry as unknown as { user_id: string }).user_id === ids.ADMIN_ID)
  const humanMinutes = `${Math.floor(entry.total_minutes / 60)}h ${entry.total_minutes % 60}m`
  check(
    'admin notified of clock out',
    db.notifications.some(
      (n) =>
        n.type === 'time_out' &&
        n.message === `Ana Reyes clocked out — ${humanMinutes} · Site A · added a note`,
    ),
    db.notifications.map((n) => n.message),
  )

  const afterOut = await api.loadState()
  if (afterOut.kind !== 'ready') throw new Error('expected a ready state')
  check('no timer after clock out', afterOut.snapshot.timer === null)
  check(
    "today's minutes include the finished shift",
    afterOut.snapshot.todayMinutes === entry.total_minutes,
    afterOut.snapshot,
  )
  check(
    "today's earnings include the finished shift",
    afterOut.snapshot.todayEarnings === entry.earnings,
    afterOut.snapshot,
  )

  section('Resilience')
  // Two timer rows for one worker cannot happen in Postgres (unique index), but
  // a half-finished write or an older database can leave one behind.
  db.active_timers.push(
    {
      id: 'stale-timer',
      user_id: ids.ADMIN_ID,
      worker_id: ids.WORKER_ID,
      project: null,
      start_time: new Date(Date.now() - 5 * MINUTE).toISOString(),
      notes: null,
      hourly_rate: 25,
      paused: false,
      pause_start: null,
      total_pause_ms: 0,
      created_at: new Date().toISOString(),
    } as never,
  )
  const stale = await api.loadState()
  if (stale.kind !== 'ready') throw new Error('expected a ready state')
  check('stale duplicate timers are cleaned up', db.active_timers.length === 1, db.active_timers.length)
  check('the running timer is the one kept', stale.snapshot.timer?.id === 'stale-timer')

  await api.clockOut()
  check('second shift closes cleanly', db.time_entries.length === 2 && db.active_timers.length === 0)

  section('Session')
  await api.signOut()
  const afterSignOut = await api.loadState()
  check('signing out clears the session', afterSignOut.kind === 'signed-out', afterSignOut.kind)

  await api.signIn('ana@example.com', 'worker123')
  const reloaded = await api.loadState()
  check('signing back in works', reloaded.kind === 'ready')

  section('Unreachable workspace')
  await saveConfig({ supabaseUrl: 'http://127.0.0.1:1', anonKey: mock.anonKey })
  await expectError('dead host is reported clearly', () => api.loadState(), /Could not reach Supabase/)
} finally {
  await mock.close()
}

console.log(`\n${failures.length === 0 ? '✅' : '❌'} ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exit(1)
}
