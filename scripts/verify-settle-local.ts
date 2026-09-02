/**
 * Ad-hoc verification of "Settle & reset" in demo mode (local storage).
 *
 * Settling must pay out a worker's unsettled time and KEEP their time entries:
 * the rows are stamped with settled_at instead of being deleted, so they stay in
 * Time Entries (notes included) until someone deletes one by hand, and the next
 * settlement only covers time worked since.
 *
 * Run: npx tsx scripts/verify-settle-local.ts
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

const round2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  const { localBackend } = await import('../src/lib/localDb')

  // 1) Admin signs in — the demo workspace is seeded.
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')

  const workers = (await localBackend.listWorkers()).data || []
  const john = workers.find((w) => w.email === 'john@example.com')!
  assert(Boolean(john), 'john@example.com exists in the seed')

  const entriesFor = async (workerId: string) =>
    ((await localBackend.listEntries()).data || []).filter((e) => e.worker_id === workerId)

  const before = await entriesFor(john.id)
  assert(before.length > 0, `john has seeded time entries (${before.length})`)
  assert(before.every((e) => !e.settled_at), 'nothing is settled yet')
  const beforeMinutes = before.reduce((s, e) => s + e.total_minutes, 0)
  const beforeEarnings = round2(before.reduce((s, e) => s + e.earnings, 0))

  // A note on one of the entries — it has to survive the settlement too.
  const comment = await localBackend.addEntryComment(before[0].id, 'Kept for the record')
  assert(!comment.error, 'the admin can add a note to an entry')

  // 2) Settle: the payment covers exactly the unsettled time.
  const payment = await localBackend.settleWorker(john.id, 'Weekly settlement')
  assert(!payment.error && payment.data, 'settling creates a payment')
  assert(payment.data!.status === 'unpaid', 'the payment starts as unpaid')
  assert(payment.data!.hours === round2(beforeMinutes / 60), `payment hours match the unsettled entries (${payment.data!.hours})`)
  assert(payment.data!.amount === beforeEarnings, `payment amount matches the unsettled entries (${payment.data!.amount})`)
  assert(payment.data!.note === 'Weekly settlement', 'the settlement note is stored')

  // 3) THE POINT: the entries are still there, and their notes with them.
  const after = await entriesFor(john.id)
  assert(after.length === before.length, `every entry survives the settlement (${after.length} of ${before.length})`)
  assert(
    JSON.stringify(after.map((e) => e.id).sort()) === JSON.stringify(before.map((e) => e.id).sort()),
    'the very same entries are still there'
  )
  assert(after.every((e) => Boolean(e.settled_at)), 'the settled entries are stamped with settled_at')
  const comments = (await localBackend.listEntryComments(before[0].id)).data || []
  assert(comments.some((c) => c.body === 'Kept for the record'), 'the note on a settled entry is kept')
  assert(
    after.every((e) => e.total_minutes === before.find((b) => b.id === e.id)!.total_minutes),
    'settling does not alter the recorded hours'
  )

  // 4) Settling again immediately pays nothing — settled time is not paid twice.
  const again = await localBackend.settleWorker(john.id)
  assert(
    again.error === 'This worker has no unsettled time to settle.',
    `settling twice is refused (got: ${again.error})`
  )
  const paymentsAfterRetry = (await localBackend.listPayments()).data || []
  assert(
    paymentsAfterRetry.filter((p) => p.worker_id === john.id).length === 1,
    'no second payment was created'
  )

  // 5) New time after the settlement is settled on its own.
  const start = new Date()
  start.setHours(8, 0, 0, 0)
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000)
  const created = await localBackend.createEntry({
    worker_id: john.id,
    project: 'Site B',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    break_minutes: 0,
    notes: 'After the first settlement',
    hourly_rate: john.hourly_rate,
    total_minutes: 120,
    earnings: round2(2 * john.hourly_rate),
  })
  assert(!created.error && created.data, 'the admin can add a manual entry')
  assert(!created.data!.settled_at, 'a new entry starts unsettled')

  const second = await localBackend.settleWorker(john.id)
  assert(!second.error && second.data, 'the new time can be settled')
  assert(second.data!.hours === 2, `the second settlement only covers the new entry (${second.data!.hours}h)`)
  assert(second.data!.amount === round2(2 * john.hourly_rate), 'and only its earnings')
  const afterSecond = await entriesFor(john.id)
  assert(afterSecond.length === before.length + 1, `entries keep accumulating (${afterSecond.length})`)
  assert(afterSecond.every((e) => Boolean(e.settled_at)), 'everything is settled again')

  // 6) Manual deletion is the only way an entry goes away.
  const deleted = await localBackend.deleteEntry(created.data!.id)
  assert(!deleted.error, 'the admin can still delete an entry by hand')
  const finalEntries = await entriesFor(john.id)
  assert(finalEntries.length === before.length, 'the deleted entry is gone, the settled ones remain')
  assert(
    !finalEntries.some((e) => e.id === created.data!.id),
    'the deleted entry is the one that disappeared'
  )

  // 7) Deleting a payment does not resurrect or remove any entry.
  const delPayment = await localBackend.deletePayment(payment.data!.id)
  assert(!delPayment.error, 'the admin can delete a payment')
  assert((await entriesFor(john.id)).length === before.length, 'entries are untouched by deleting a payment')

  // 8) The worker still sees their settled history and was told about the payment.
  await localBackend.signOut()
  const johnIn = await localBackend.signIn('john@example.com', 'worker123')
  assert(!johnIn.error && johnIn.data?.role === 'worker', 'john can sign in')
  const seenByWorker = await entriesFor(john.id)
  assert(seenByWorker.length === before.length, `john still sees his settled entries (${seenByWorker.length})`)
  const notifs = await localBackend.listNotifications()
  assert(
    (notifs.data || []).filter((n) => n.type === 'payment').length === 2,
    'john was notified about both payments'
  )

  // 9) A worker cannot settle anybody.
  const workerSettle = await localBackend.settleWorker(john.id)
  assert(workerSettle.error === 'Only the admin can settle worker time.', 'a worker cannot settle time')
}

main().then(
  () => (process.exitCode ? process.exit(process.exitCode) : undefined),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
