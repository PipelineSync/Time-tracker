/**
 * Ad-hoc verification of the Clients feature in demo mode (local storage):
 *  - the admin owns the master list: add, rename, re-colour, activate/deactivate
 *  - only ACTIVE clients are offered for new work (the UI reads that list)
 *  - a client that labels existing work cannot be deleted, only deactivated
 *  - tasks carry a client; a timer carries one and passes it to the entry
 *  - workers may READ the list (for their filters) but never change it
 *  - a workspace saved before clients existed is backfilled to "Unassigned"
 *
 * Run: npx tsx scripts/verify-clients-local.ts
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

  // 1) Admin signs in — the demo workspace is seeded with a small client list.
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')

  const seeded = (await localBackend.listClients()).data || []
  assert(seeded.length > 0, 'the demo seed ships a client master list')
  assert(
    seeded.filter((c) => c.status === 'active').length === seeded.length - 1,
    'the seed includes one retired client, to exercise the inactive state'
  )
  assert(
    seeded.every((c, i) => i === 0 || Number(seeded[i - 1].status === 'inactive') <= Number(c.status === 'inactive')),
    'the list sorts active clients before inactive ones'
  )

  // 2) The admin maintains the list.
  const created = (await localBackend.createClient({ name: 'Umbrella Ltd', color: 'rose' })).data!
  assert(created?.name === 'Umbrella Ltd' && created.color === 'rose', 'admin adds a client with a colour tag')
  const dupe = await localBackend.createClient({ name: '  umbrella ltd ' })
  assert(!!dupe.error && dupe.error.includes('already on the list'), 'duplicate names (any case) are refused')
  const blank = await localBackend.createClient({ name: '   ' })
  assert(!!blank.error, 'a blank client name is refused')
  const renamed = (await localBackend.updateClient(created.id, { name: 'Umbrella Group', color: 'violet' })).data!
  assert(renamed.name === 'Umbrella Group' && renamed.color === 'violet', 'admin renames and re-colours a client')

  // 3) Tasks are tagged with a client.
  const workers = (await localBackend.listWorkers()).data || []
  const worker = workers.find((w) => w.email === 'john@example.com')!
  const task = (await localBackend.createTask({
    worker_id: worker.id,
    client_id: created.id,
    title: 'Replace the pump seal',
    priority: 'high',
  })).data!
  assert(task.client_id === created.id, 'a new task carries its client')
  const retagged = (await localBackend.updateTask(task.id, { client_id: seeded[0].id })).data!
  assert(retagged.client_id === seeded[0].id, 'a task can be re-tagged to another client')
  await localBackend.updateTask(task.id, { client_id: created.id })

  // 4) Retiring vs deleting.
  const blockedDelete = await localBackend.deleteClient(created.id)
  assert(
    !!blockedDelete.error && blockedDelete.error.includes('Mark it inactive instead'),
    'a client used by real work cannot be deleted'
  )
  const deactivated = (await localBackend.updateClient(created.id, { status: 'inactive' })).data!
  assert(deactivated.status === 'inactive', 'a client can be marked inactive at any time')
  const afterOff = (await localBackend.listClients()).data || []
  assert(
    afterOff.some((c) => c.id === created.id),
    'an inactive client stays in the list so existing work keeps its label'
  )
  assert(
    (await localBackend.listTasks()).data!.find((t) => t.id === task.id)!.client_id === created.id,
    'the task it labels is untouched by the deactivation'
  )
  const unused = (await localBackend.createClient({ name: 'Typo Inc' })).data!
  assert((await localBackend.deleteClient(unused.id)).error === null, 'an unused client can be deleted outright')

  // 5) Clock in against a client — the entry inherits it at clock-out.
  const login = (await localBackend.getWorkerLogin(worker.id)).data!
  await localBackend.signOut()
  await localBackend.signIn(login.email!, login.password!)
  const timer = (await localBackend.startTimer({ worker_id: worker.id, client_id: seeded[1].id })).data!
  assert(timer.client_id === seeded[1].id, 'the running timer carries the client picked at clock-in')
  const entry = (await localBackend.stopTimer(timer.id, 'done for today')).data!
  assert(entry.client_id === seeded[1].id, 'the time entry inherits the client at clock-out')

  // 6) Worker permissions: read yes, write no.
  const workerView = (await localBackend.listClients()).data || []
  assert(workerView.length > 0, 'a worker can read the client list (their filters need the names)')
  const rogue = await localBackend.createClient({ name: 'Rogue Co' })
  assert(!!rogue.error && rogue.error.includes('permission'), 'a worker cannot add a client')
  assert(
    !!(await localBackend.updateClient(seeded[0].id, { status: 'inactive' })).error,
    'a worker cannot deactivate a client'
  )
  assert(!!(await localBackend.deleteClient(seeded[0].id)).error, 'a worker cannot delete a client')

  // 7) A workspace saved before clients existed is backfilled on first read.
  await localBackend.signOut()
  mem.clear()
  const legacyUserId = 'legacy-admin'
  mem.set(
    'wt_users',
    JSON.stringify([{ id: legacyUserId, email: 'admin', password: 'admin.pipelinesync', role: 'admin' }])
  )
  const now = new Date().toISOString()
  mem.set(
    `wt_data_${legacyUserId}`,
    JSON.stringify({
      workers: [{ id: 'w1', name: 'Old Worker', email: null, hourly_rate: 10, status: 'active', position: '', avatar_url: null, payment_methods: [], qr_code_url: null, created_at: now, updated_at: now }],
      entries: [{ id: 'e1', worker_id: 'w1', project: 'Legacy job', start_time: now, end_time: now, break_minutes: 0, notes: null, hourly_rate: 10, total_minutes: 60, earnings: 10, created_at: now, updated_at: now }],
      activeTimers: [],
      settings: null,
      comments: [],
      notifications: [],
      payments: [],
      tasks: [{ id: 't1', worker_id: 'w1', title: 'Old task', description: null, status: 'todo', priority: 'medium', due_date: null, position: 0, created_by_role: 'admin', completed_at: null, created_at: now, updated_at: now }],
    })
  )
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const migrated = (await localBackend.listClients()).data || []
  const fallback = migrated.find((c) => c.name === 'Unassigned')
  assert(!!fallback, 'a pre-clients workspace gains an "Unassigned" client')
  assert(
    (await localBackend.listTasks()).data!.every((t) => t.client_id === fallback!.id),
    'existing tasks are backfilled to it'
  )
  assert(
    ((await localBackend.listEntries()).data || []).every((e) => e.client_id === fallback!.id),
    'existing time entries are backfilled to it'
  )
  assert(
    ((await localBackend.listEntries()).data || []).every((e) => e.project === 'Legacy job'),
    'their original free-text scope is preserved, not overwritten'
  )

  console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll client checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
