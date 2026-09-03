/**
 * Ad-hoc verification of the entries sync budget in demo mode (local storage).
 *
 * The app polls every 15 s with a BOUNDED query so a tab's bandwidth stays
 * flat as history grows: a newest-entries window on full syncs, and a
 * "what changed since?" delta on the cheap ticks. This script checks both
 * backends' contract for that: window limits, delta (since) syncs, the
 * "load older" page, and the capped notifications/payments lists.
 *
 * Run: npx tsx scripts/verify-entries-sync-local.ts
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

  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')

  const workers = (await localBackend.listWorkers()).data || []
  const john = workers.find((w) => w.email === 'john@example.com')!
  assert(Boolean(john), 'john@example.com exists in the seed')

  // ---- Window: bounded, newest first -------------------------------------
  const all = (await localBackend.listEntries()).data || []
  assert(all.length > 5, `the demo seed has more than 5 entries (${all.length})`)

  const window = (await localBackend.listEntries({ limit: 5 })).data || []
  assert(window.length === 5, 'limit bounds the window to 5 rows')
  const isDesc = window.every((e, i) => i === 0 || e.start_time <= window[i - 1].start_time)
  assert(isDesc, 'the window is newest-first')
  assert(window.every((e) => all.some((a) => a.id === e.id)), 'window rows are real entries')

  // ---- Delta: nothing changed since "now" ---------------------------------
  const marker = new Date(Date.now() - 60_000).toISOString()
  const quiet = (await localBackend.listEntries({ since: marker })).data || []
  assert(quiet.length === 0, 'a delta sync right after the marker is empty')

  // ---- Delta picks up a new entry ------------------------------------------
  const created = await localBackend.createEntry({
    worker_id: john.id,
    project: 'Sync test',
    start_time: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    end_time: new Date(Date.now() - 1 * 3_600_000).toISOString(),
    break_minutes: 0,
    notes: 'delta test',
    hourly_rate: john.hourly_rate,
    total_minutes: 60,
    earnings: john.hourly_rate,
  })
  assert(!created.error && created.data, 'admin adds a manual entry')
  const afterCreate = (await localBackend.listEntries({ since: marker, limit: 200 })).data || []
  assert(afterCreate.some((e) => e.id === created.data!.id), 'the delta sync returns the new entry')
  assert(afterCreate.every((e) => e.created_at >= marker || e.updated_at >= marker),
    'the delta sync returns ONLY rows changed since the marker')

  // ---- Delta picks up an edit (updated_at) ---------------------------------
  const edited = await localBackend.updateEntry(created.data!.id, { notes: 'delta test edited' })
  assert(!edited.error && edited.data, 'admin edits the entry')
  const afterEdit = (await localBackend.listEntries({ since: marker, limit: 200 })).data || []
  const editedRow = afterEdit.find((e) => e.id === created.data!.id)
  assert(editedRow?.notes === 'delta test edited', 'the delta sync returns the edited row with its new value')

  // A marker moved past everything is quiet again (small sleep so the marker
  // lands in a strictly later millisecond than the edit's updated_at).
  await new Promise((r) => setTimeout(r, 10))
  const marker2 = new Date().toISOString()
  const quiet2 = (await localBackend.listEntries({ since: marker2 })).data || []
  assert(quiet2.length === 0, 'no changes after the new marker -> empty delta')

  // ---- "Load older" page ----------------------------------------------------
  const boundary = window[window.length - 1].start_time // oldest start_time in the window
  const older = (await localBackend.listOlderEntries(boundary, 3)).data || []
  assert(older.length > 0, 'load-older finds rows before the window boundary')
  assert(older.every((e) => e.start_time <= boundary), 'load-older rows are all at/older than the boundary')
  const olderDesc = older.every((e, i) => i === 0 || e.start_time <= older[i - 1].start_time)
  assert(olderDesc, 'load-older page is newest-first')
  // Window + older page cover distinct rows (boundary ties may repeat).
  const windowIds = new Set(window.map((e) => e.id))
  const freshCount = older.filter((e) => !windowIds.has(e.id)).length
  assert(freshCount > 0, `load-older page brings rows the window does not have (${freshCount})`)

  // ---- Payments: capped list -------------------------------------------------
  await localBackend.settleWorker(john.id, 'sync test settlement')
  const allPayments = (await localBackend.listPayments()).data || []
  assert(allPayments.length >= 1, 'the settlement created a payment')
  const payCapped = (await localBackend.listPayments(1)).data || []
  assert(payCapped.length === 1, 'payment list honours the limit')

  // ---- Notifications: capped list + exact unread count ----------------------
  // The settlement notified john (not the admin), so check the count on his side.
  await localBackend.signOut()
  const worker = await localBackend.signIn('john@example.com', 'worker123')
  assert(!worker.error && worker.data?.role === 'worker', 'john can sign in')

  const johnNotifs = (await localBackend.listNotifications()).data || []
  const johnUnread = johnNotifs.filter((n) => !n.read).length
  assert(johnUnread > 0, 'the settlement raised a notification for john')
  const capped = (await localBackend.listNotifications(1)).data || []
  assert(capped.length === Math.min(1, johnNotifs.length), 'notification list honours the limit')
  const capDesc = capped.every((n, i) => i === 0 || n.created_at <= capped[i - 1].created_at)
  assert(capDesc, 'capped notifications are newest-first')
  const count = await localBackend.countUnreadNotifications()
  assert(!count.error && count.data === johnUnread,
    `unread count matches the full list (${count.data} of ${johnUnread})`)

  // ---- Worker scope: windows/deltas cover the worker's own rows only --------
  const wWindow = (await localBackend.listEntries({ limit: 5 })).data || []
  assert(wWindow.every((e) => e.worker_id === john.id), 'the worker window is scoped to the worker')
  const wDelta = (await localBackend.listEntries({ since: marker, limit: 200 })).data || []
  assert(wDelta.some((e) => e.id === created.data!.id), 'the worker delta sees their own new entry')
  assert(wDelta.every((e) => e.worker_id === john.id), 'the worker delta is scoped to the worker')
  const wOlder = (await localBackend.listOlderEntries(wWindow[wWindow.length - 1].start_time, 3)).data || []
  assert(wOlder.every((e) => e.worker_id === john.id), 'worker load-older is scoped to the worker')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
