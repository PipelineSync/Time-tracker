/**
 * Ad-hoc verification of Switch client:
 *  - the on-screen shift clock does NOT reset (session_start + prior_worked_ms)
 *  - each client still gets a finished entry with only the minutes worked for them
 *
 * Run: npx tsx scripts/verify-switch-client-local.ts
 */
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
  const { timerElapsedMs, timerSessionStart } = await import('../src/lib/utils')

  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')

  const clients = (await localBackend.listClients()).data || []
  assert(clients.length >= 2, `need at least 2 clients (have ${clients.length})`)
  const [clientA, clientB] = clients

  // Fresh worker session.
  const john = await localBackend.signIn('john@example.com', 'worker123')
  assert(!john.error && !!john.data?.workerId, 'john can sign in')

  // Drop any leftover timer from a previous run.
  const existing = (await localBackend.listActiveTimers()).data || []
  for (const t of existing) await localBackend.deleteTimer(t.id)

  // Clock in on client A at a known past time so we can assert minutes.
  const clockInAt = new Date(Date.now() - 25 * 60 * 1000).toISOString() // 25 min ago
  const started = await localBackend.startTimer({
    worker_id: john.data!.workerId!,
    client_id: clientA.id,
    start_time: clockInAt,
  })
  assert(!started.error && !!started.data, 'john clocks in on client A')
  assert(started.data!.client_id === clientA.id, 'timer is booked to client A')
  assert(started.data!.session_start === clockInAt, 'session_start = original clock-in')
  assert((started.data!.prior_worked_ms || 0) === 0, 'prior_worked_ms starts at 0')

  const beforeSwitch = started.data!
  const elapsedBefore = timerElapsedMs(beforeSwitch, new Date())
  assert(elapsedBefore >= 24 * 60 * 1000 && elapsedBefore <= 26 * 60 * 1000, `elapsed ~25m before switch (got ${Math.round(elapsedBefore / 60000)}m)`)

  // Switch to client B.
  const switched = await localBackend.switchClient({
    timerId: beforeSwitch.id,
    client_id: clientB.id,
    notes: 'moving to B',
  })
  assert(!switched.error && !!switched.data, 'switch client succeeds')
  const next = switched.data!

  assert(next.client_id === clientB.id, 'new timer is booked to client B')
  assert(timerSessionStart(next) === clockInAt, 'session_start survives the switch (clock does not reset)')
  assert((next.prior_worked_ms || 0) >= 24 * 60 * 1000, `prior_worked_ms carries ~25m of A (got ${Math.round((next.prior_worked_ms || 0) / 60000)}m)`)
  assert(next.notes === 'moving to B', 'optional note lands on the new segment')

  // Displayed elapsed should still be ~25m (not ~0).
  const elapsedAfter = timerElapsedMs(next, new Date())
  assert(
    elapsedAfter >= 24 * 60 * 1000 && elapsedAfter <= 27 * 60 * 1000,
    `elapsed stays ~25m after switch (got ${Math.round(elapsedAfter / 60000)}m) — clock did not reset`
  )

  // Client A should have a finished entry with ~25 minutes.
  const entries = (await localBackend.listEntries({ limit: 50 })).data || []
  const splitA = entries.find((e) => e.client_id === clientA.id && e.worker_id === john.data!.workerId && e.end_time)
  assert(!!splitA, 'client A got a finished split entry')
  assert(
    !!splitA && splitA.total_minutes >= 24 && splitA.total_minutes <= 26,
    `client A entry is ~25m (got ${splitA?.total_minutes}m)`
  )

  // Work a couple more minutes on B, then clock out — B should only get the B segment.
  // Nudge the new timer's start_time back so the B segment is measurable without sleeping.
  // (We can't mutate storage directly through the backend, so just stop immediately and
  // accept 0 minutes on B — the important assert is that A already has its minutes and
  // the display clock stayed continuous.)
  const stopped = await localBackend.stopTimer(next.id)
  assert(!stopped.error && !!stopped.data, 'clock out after switch succeeds')
  assert(stopped.data!.client_id === clientB.id, 'final entry is booked to client B')
  // B's entry only covers the short B segment (near 0 minutes here).
  assert(
    !!stopped.data && stopped.data.total_minutes <= 1,
    `client B entry is only the B segment (got ${stopped.data?.total_minutes}m), not the whole shift`
  )

  // Re-check A still has its own entry (not overwritten / merged).
  const after = (await localBackend.listEntries({ limit: 50 })).data || []
  const aStill = after.find((e) => e.id === splitA!.id)
  assert(!!aStill && aStill.total_minutes === splitA!.total_minutes, 'client A entry is unchanged after clock-out')

  if (process.exitCode) {
    console.error('\nSwitch-client verification FAILED')
    process.exit(1)
  }
  console.log('\nSwitch-client verification passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
