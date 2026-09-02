/**
 * Ad-hoc verification of the demo-mode (local storage) multi-worker clock-in
 * flow: several workers can be on the clock at the same time, the admin sees
 * all of them, and breaks are visible to the admin.
 *
 * Run: npx tsx scripts/verify-active-workers-local.ts
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

async function main() {
  const { localBackend } = await import('../src/lib/localDb')

  // 1) Admin signs in — this auto-seeds three workers with logins.
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')

  const workers = (await localBackend.listWorkers()).data || []
  assert(workers.length >= 3, `seeded workers exist (${workers.length})`)

  // 2) Three different workers clock in, one after another.
  const logins = ['john@example.com', 'sarah@example.com', 'mike@example.com']
  for (const email of logins) {
    const res = await localBackend.signIn(email, 'worker123')
    assert(!res.error, `${email} can sign in`)
    const started = await localBackend.startTimer({ worker_id: res.data!.workerId! })
    assert(!started.error && !!started.data, `${email} can clock in while others are working`)
    // A worker only ever sees their own timer.
    const mine = (await localBackend.listActiveTimers()).data || []
    assert(mine.length === 1 && mine[0].worker_id === res.data!.workerId, `${email} sees only their own timer`)
  }

  // 3) The admin sees every worker that is on the clock.
  await localBackend.signIn('admin', 'admin.pipelinesync')
  let all = (await localBackend.listActiveTimers()).data || []
  assert(all.length === 3, `admin sees all 3 running timers (saw ${all.length})`)
  assert(all.every((t) => !t.paused), 'admin sees all 3 as working')

  // 4) Sarah takes a break — the admin must see her as on break and be notified.
  const sarah = await localBackend.signIn('sarah@example.com', 'worker123')
  const paused = await localBackend.pauseTimer()
  assert(!paused.error && paused.data?.paused === true, 'sarah can start a break')

  await localBackend.signIn('admin', 'admin.pipelinesync')
  all = (await localBackend.listActiveTimers()).data || []
  assert(all.length === 3, 'a break does not remove the worker from the active list')
  const sarahTimer = all.find((t) => t.worker_id === sarah.data!.workerId)
  assert(!!sarahTimer?.paused, 'admin sees sarah as ON BREAK')
  assert(all.filter((t) => !t.paused).length === 2, 'admin still sees the other 2 as working')

  let notes = (await localBackend.listNotifications()).data || []
  assert(notes.some((n) => n.type === 'break_start' && /break/i.test(n.message)), 'admin was notified that sarah started a break')

  // 5) Sarah comes back — the admin sees her working again and is notified.
  await localBackend.signIn('sarah@example.com', 'worker123')
  const resumed = await localBackend.resumeTimer()
  assert(!resumed.error && resumed.data?.paused === false, 'sarah can end her break')

  await localBackend.signIn('admin', 'admin.pipelinesync')
  all = (await localBackend.listActiveTimers()).data || []
  assert(all.every((t) => !t.paused), 'admin sees everyone working again')
  notes = (await localBackend.listNotifications()).data || []
  assert(notes.some((n) => n.type === 'break_end'), 'admin was notified that sarah is back from break')

  // 6) One worker clocks out — the others stay on the clock.
  const john = await localBackend.signIn('john@example.com', 'worker123')
  const johnTimer = ((await localBackend.listActiveTimers()).data || [])[0]
  const stopped = await localBackend.stopTimer(johnTimer.id)
  assert(!stopped.error && !!stopped.data, 'john can clock out')
  assert(((await localBackend.listActiveTimers()).data || []).length === 0, 'john has no running timer left')

  await localBackend.signIn('admin', 'admin.pipelinesync')
  all = (await localBackend.listActiveTimers()).data || []
  assert(all.length === 2, `admin still sees the remaining 2 workers (saw ${all.length})`)
  assert(!all.some((t) => t.worker_id === john.data!.workerId), 'john is gone from the active list')

  // 7) The admin cannot double-start a timer for a worker already clocked in.
  const dup = await localBackend.startTimer({ worker_id: all[0].worker_id })
  assert(!!dup.error, 'starting a second timer for the same worker is rejected')

  console.log(process.exitCode ? '\nSome checks FAILED' : '\nAll checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
