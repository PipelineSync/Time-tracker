/**
 * Ad-hoc verification of the client priority board in demo mode (local storage):
 *  - demo seed ranks a few clients, the rest stay unranked
 *  - the admin can move clients between columns and ranks (rows created on demand)
 *  - positions re-index gap-free within a lane
 *  - reset deletes every row (clients themselves untouched)
 *  - a worker without `priority_board.view` is refused at the backend, not just the UI
 *  - a granted worker sees and moves the very same board
 *  - deleting a client removes its place on the board
 *
 * Run: npx tsx scripts/verify-priority-board-local.ts
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
  const { localBackend, ADMIN_EMAIL, ADMIN_PASSWORD } = await import('../src/lib/localDb')
  const { CLIENT_PRIORITY_LANES } = await import('../src/lib/types')

  // ---- 1. the admin signs in and loads the demo workspace -----------------
  const admin = await localBackend.signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')
  await localBackend.seedDemo()

  const clients = (await localBackend.listClients()).data || []
  const active = clients.filter((c) => c.status === 'active')
  assert(active.length >= 4, 'demo workspace has active clients')

  // ---- 2. the seeded board ------------------------------------------------
  const seeded = (await localBackend.listClientPriorities()).data || []
  assert(seeded.length > 0, 'the demo seed ranks some clients')
  assert(
    seeded.every((p) => CLIENT_PRIORITY_LANES.includes(p.lane)),
    'every seeded row names a real column'
  )
  const rankedIds = new Set(seeded.map((p) => p.client_id))
  assert(
    active.some((c) => !rankedIds.has(c.id)),
    'some active clients stay unranked (they show at the bottom of Low Priority)'
  )

  // ---- 3. moving: drag an unranked client to the top of Priority (Me) -----
  const unranked = active.find((c) => !rankedIds.has(c.id))!
  const moved = (await localBackend.moveClientPriority(unranked.id, 'me', 0)).data!
  assert(moved.lane === 'me' && moved.position === 0, 'dragging creates a row exactly where the card was dropped')
  const afterMove = ((await localBackend.listClientPriorities()).data || []).filter((p) => p.lane === 'me')
  assert(
    afterMove.map((p) => p.position).join(',') === afterMove.map((_, i) => String(i)).join(','),
    'the destination column re-indexes gap-free'
  )

  // Moving between lanes leaves exactly one row per client.
  const again = (await localBackend.moveClientPriority(unranked.id, 'waiting', 0)).data!
  const rowsForClient = ((await localBackend.listClientPriorities()).data || []).filter((p) => p.client_id === unranked.id)
  assert(again.lane === 'waiting' && rowsForClient.length === 1, 'moving a client updates its single row, never duplicates')

  // ---- 4. a plain worker is refused at the backend ------------------------
  const plain = (await localBackend.createWorker({
    name: 'Board Bea',
    hourly_rate: 16,
    accountEmail: 'bea@example.com',
    accountPassword: 'worker123',
  })).data!
  await localBackend.signOut()
  await localBackend.signIn('bea@example.com', 'worker123')
  const refusedList = await localBackend.listClientPriorities()
  assert(!!refusedList.error, 'an ungranted worker cannot read the board')
  const refusedMove = await localBackend.moveClientPriority(unranked.id, 'low', 0)
  assert(!!refusedMove.error, 'an ungranted worker cannot move a client')
  const refusedReset = await localBackend.resetClientPriorities()
  assert(!!refusedReset.error, 'an ungranted worker cannot reset the board')

  // ---- 5. a granted worker shares the admin's board -----------------------
  await localBackend.signOut()
  await localBackend.signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  await localBackend.updateWorker(plain.id, { permissions: ['priority_board.view'] })
  await localBackend.signOut()
  await localBackend.signIn('bea@example.com', 'worker123')
  const granted = (await localBackend.listClientPriorities()).data || []
  assert(granted.length > 0, 'a granted worker reads the same board')
  const workerMove = (await localBackend.moveClientPriority(unranked.id, 'delegated', 0)).data!
  assert(workerMove.lane === 'delegated' && workerMove.position === 0, 'a granted worker can move clients')
  const clientsForWorker = (await localBackend.listClients()).data || []
  assert(clientsForWorker.length > 0, 'a granted worker still reads the client list the board shows')

  // ---- 6. reset: every row goes, every client stays -----------------------
  await localBackend.signOut()
  await localBackend.signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  const reset = await localBackend.resetClientPriorities()
  assert(!reset.error, 'the admin can reset the board')
  const afterReset = (await localBackend.listClientPriorities()).data || []
  assert(afterReset.length === 0, 'reset deletes every priority row')
  assert(((await localBackend.listClients()).data || []).length === clients.length, 'reset leaves the clients themselves untouched')

  // ---- 7. deleting a client removes its place on the board ----------------
  const scratch = (await localBackend.createClient({ name: 'Scratch Client' })).data!
  await localBackend.moveClientPriority(scratch.id, 'me', 0)
  assert(((await localBackend.listClientPriorities()).data || []).some((p) => p.client_id === scratch.id), 'a new client can be ranked')
  await localBackend.deleteClient(scratch.id)
  assert(!((await localBackend.listClientPriorities()).data || []).some((p) => p.client_id === scratch.id), 'deleting the client deletes its board row')

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
