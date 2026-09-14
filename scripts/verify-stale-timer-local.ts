/**
 * Ad-hoc verification of the "Not your timer." fix (stale worker link).
 *
 * Scenario: a project-manager-style worker (granted `entries.view_all`) is
 * clocked in when the admin re-creates her worker record — the login is
 * re-linked to a NEW worker row while her running timer stays on the OLD one.
 * Before the fix every timer action then died on "Not your timer." and the
 * shift could never be closed. Now the backend re-adopts the stale timer onto
 * the current worker row (only when it is provably hers) and clock-in, break,
 * resume, switch client and clock-out all work again.
 *
 * Run: npx tsx scripts/verify-stale-timer-local.ts
 */
// Minimal browser stub so storage.ts works in Node.
const mem = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  },
}

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`ok: ${msg}`)
  }
}

type Row = Record<string, unknown>

/** Read/write the raw local storage the same way localDb does. */
const loadUsers = (): Row[] => JSON.parse(mem.get('wt_users') || '[]')
const saveUsers = (users: Row[]) => mem.set('wt_users', JSON.stringify(users))
const loadData = (adminId: string) => {
  const key = `wt_data_${adminId}`
  return { key, data: JSON.parse(mem.get(key) || 'null') }
}
const saveData = (key: string, data: unknown) => mem.set(key, JSON.stringify(data))

async function main() {
  const { localBackend } = await import('../src/lib/localDb')
  const { PERMISSION_PRESETS } = await import('../src/lib/types')

  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')

  const clients = (await localBackend.listClients()).data || []
  assert(clients.length >= 2, `need two clients (have ${clients.length})`)
  const [clientA, clientB] = clients

  // A "project manager" worker with team-wide access clocks in.
  const pm = await localBackend.signIn('sarah@example.com', 'worker123')
  assert(!pm.error && !!pm.data?.workerId, 'sarah (PM) can sign in')
  const started = await localBackend.startTimer({ worker_id: pm.data!.workerId!, client_id: clientA.id })
  assert(!started.error && !!started.data, 'sarah can clock in')
  const timerId = started.data!.id
  const staleWorkerId = pm.data!.workerId!

  // --- Simulate the admin re-creating her worker record mid-shift ---------
  // New worker row (same login email), Sarah's account re-linked to it; the
  // OLD row keeps her running timer and is no longer claimed by anybody.
  const users = loadUsers()
  const sarahUser = users.find((u) => u.email === 'sarah@example.com')!
  const { key, data } = loadData(admin.data!.id)
  const staleRow = data.workers.find((w: Row) => w.id === staleWorkerId)
  assert(!!staleRow, 'stale worker row still exists with the running timer')
  const freshRow = { ...staleRow, id: 'w-' + Math.random().toString(36).slice(2), permissions: PERMISSION_PRESETS.manager.permissions }
  data.workers.push(freshRow)
  sarahUser.workerId = freshRow.id
  saveUsers(users)
  saveData(key, data)

  // With the old code every action below fails on "Not your timer."
  await localBackend.signIn('sarah@example.com', 'worker123')
  const before = await localBackend.getActiveTimer()
  assert(!before.error && !!before.data && before.data.id === timerId, 'the stale timer is re-adopted by the current link')
  assert(before.data!.worker_id === freshRow.id, 'the reclaimed timer now sits on the CURRENT worker row')

  // --- Every timer action works again -------------------------------------
  const paused = await localBackend.pauseTimer()
  assert(!paused.error && paused.data?.paused === true, 'she can start a break on her reclaimed timer')
  const resumed = await localBackend.resumeTimer()
  assert(!resumed.error && resumed.data?.paused === false, 'she can end the break')
  const switched = await localBackend.switchClient({ timerId: timerId, client_id: clientB.id })
  assert(!switched.error && !!switched.data, 'she can switch client')
  const stopped = await localBackend.stopTimer(switched.data!.id)
  assert(!stopped.error && !!stopped.data, 'she can clock out')
  const entries = (await localBackend.listEntries()).data || []
  assert(entries.some((e) => e.worker_id === freshRow.id), 'the clocked-out time is booked to her current worker row')
  assert((await localBackend.listActiveTimers()).data!.length === 0, 'no running timer left behind')

  // --- Coworker safety: a timer on a row somebody else claims is NOT moved -
  const { key: key2, data: data2 } = loadData(admin.data!.id)
  const johnRow = data2.workers.find((w: Row) => w.email === 'john@example.com')
  const sarahRow2 = data2.workers.find((w: Row) => w.id === freshRow.id)
  // Sarah's login email now matches John's row too (duplicate email in the DB)
  // — but John CLAIMS that row, so reclaiming must skip it.
  const johnTimer = {
    id: 't-john',
    worker_id: johnRow.id,
    client_id: clientA.id,
    project: null,
    start_time: new Date().toISOString(),
    session_start: new Date().toISOString(),
    prior_worked_ms: 0,
    notes: null,
    hourly_rate: sarahRow2.hourly_rate,
    paused: false,
    pause_start: null,
    total_pause_ms: 0,
    created_at: new Date().toISOString(),
  }
  void sarahRow2 // (row kept only for the rate)
  data2.activeTimers.push(johnTimer)
  saveData(key2, data2)

  await localBackend.signIn('sarah@example.com', 'worker123')
  const crossStop = await localBackend.stopTimer('t-john')
  assert(!!crossStop.error && /not your timer/i.test(crossStop.error || ''), 'she still cannot clock out a coworker\'s timer')
  const crossCancel = await localBackend.deleteTimer('t-john')
  assert(!!crossCancel.error, 'she still cannot cancel a coworker\'s timer')
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const stillRunning = (await localBackend.listActiveTimers()).data || []
  const johnTimerNow = stillRunning.find((t) => t.id === 't-john')
  assert(!!johnTimerNow && johnTimerNow.worker_id === johnRow.id, "the coworker's timer is untouched")

  console.log(process.exitCode ? '\nSome checks FAILED' : '\nAll checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
