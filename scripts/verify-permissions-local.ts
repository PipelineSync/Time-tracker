/**
 * Ad-hoc verification of per-worker permissions in demo mode (local storage):
 *  - a worker with nothing ticked behaves exactly as before (own time, own board)
 *  - every capability the admin grants really opens that area, and nothing else
 *  - the backend refuses ungranted actions, not just the UI
 *  - taking a capability away closes the door again
 *  - the permission list is normalized (unknown keys dropped, parents implied)
 *
 * Run: npx tsx scripts/verify-permissions-local.ts
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
  const { PERMISSIONS, PERMISSION_PRESETS, normalizePermissions, presetFor } = await import('../src/lib/types')

  // ---- 1. the permission list itself -------------------------------------
  assert(
    normalizePermissions(['tasks.manage_all', 'nonsense', 42]).join(',') === 'tasks.view_all,tasks.manage_all',
    'unknown keys are dropped and a "manage" grant implies its "view" parent'
  )
  assert(normalizePermissions(undefined).length === 0, 'a missing permission list means no extra access')
  assert(PERMISSION_PRESETS.worker.permissions.length === 0, 'the Worker preset grants nothing')
  assert(
    PERMISSION_PRESETS.full.permissions.length === PERMISSIONS.length,
    'the Full access preset covers every capability'
  )
  assert(presetFor([...PERMISSION_PRESETS.manager.permissions]) === 'manager', 'a preset is recognised when re-opened')

  // ---- 2. the admin creates two workers ----------------------------------
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')
  assert(
    normalizePermissions(admin.data!.permissions).length === PERMISSIONS.length,
    'the admin implicitly holds every capability'
  )

  const plain = (await localBackend.createWorker({
    name: 'Plain Pat',
    hourly_rate: 15,
    accountEmail: 'pat@example.com',
    accountPassword: 'worker123',
  })).data!
  assert(plain.permissions.length === 0, 'a new worker gets no extra access by default')

  const lead = (await localBackend.createWorker({
    name: 'Lead Lena',
    hourly_rate: 30,
    permissions: [...PERMISSION_PRESETS.supervisor.permissions],
    accountEmail: 'lena@example.com',
    accountPassword: 'worker123',
  })).data!
  assert(
    presetFor(lead.permissions) === 'supervisor',
    'the admin can grant a preset while creating the worker'
  )

  const clients = (await localBackend.listClients()).data || []
  const client = clients.find((c) => c.status === 'active')!
  const patTask = (await localBackend.createTask({
    worker_id: plain.id,
    client_id: client.id,
    title: "Pat's own job",
  })).data!
  const allWorkers = (await localBackend.listWorkers()).data || []
  const other = allWorkers.find((w) => w.id !== plain.id && w.id !== lead.id)!
  await localBackend.createEntry({
    worker_id: other.id,
    client_id: client.id,
    start_time: new Date(Date.now() - 3 * 3600_000).toISOString(),
    end_time: new Date(Date.now() - 2 * 3600_000).toISOString(),
    break_minutes: 0,
    notes: null,
    hourly_rate: other.hourly_rate,
  })

  // ---- 3. a plain worker is unchanged ------------------------------------
  const patSession = await localBackend.signIn('pat@example.com', 'worker123')
  assert(!patSession.error, 'the new worker can sign in')
  assert((patSession.data!.permissions ?? []).length === 0, 'their session carries no capabilities')

  assert(((await localBackend.listWorkers()).data || []).length === 1, 'they only see their own worker row')
  assert(
    ((await localBackend.listEntries()).data || []).every((e) => e.worker_id === plain.id),
    'they only see their own time entries'
  )
  assert(
    ((await localBackend.listTasks()).data || []).every((t) => t.worker_id === plain.id),
    'they only see their own tasks'
  )
  assert(
    ((await localBackend.listPayments()).data || []).every((p) => p.worker_id === plain.id),
    'they only see their own payments'
  )

  const stolenTask = await localBackend.createTask({ worker_id: other.id, client_id: client.id, title: 'Not mine' })
  assert(stolenTask.data?.worker_id === plain.id, 'a task they create is forced onto their own board')
  const patAddsWorker = await localBackend.createWorker({ name: 'Ghost', hourly_rate: 1 })
  assert(!!patAddsWorker.error && patAddsWorker.error.includes('permission'), 'they cannot add workers')
  const patAddsEntry = await localBackend.createEntry({
    worker_id: plain.id,
    client_id: client.id,
    start_time: new Date().toISOString(),
    end_time: new Date().toISOString(),
    break_minutes: 0,
    notes: null,
    hourly_rate: 15,
  })
  assert(!!patAddsEntry.error && patAddsEntry.error.includes('permission'), 'they cannot add manual time entries')
  const patAddsClient = await localBackend.createClient({ name: 'Sneaky Ltd' })
  assert(!!patAddsClient.error && patAddsClient.error.includes('permission'), 'they cannot manage clients')
  const patSettles = await localBackend.settleWorker(plain.id)
  assert(!!patSettles.error && patSettles.error.includes('permission'), 'they cannot settle payments')
  const patSaves = await localBackend.saveSettings({ business_name: 'Pat Inc' })
  assert(!!patSaves.error && patSaves.error.includes('permission'), 'they cannot change business settings')

  // ---- 4. a supervisor sees and runs the whole board ---------------------
  const lenaSession = await localBackend.signIn('lena@example.com', 'worker123')
  assert(
    presetFor(normalizePermissions(lenaSession.data!.permissions)) === 'supervisor',
    'the granted capabilities come back with the session'
  )
  assert(((await localBackend.listWorkers()).data || []).length === allWorkers.length, 'they see the whole team')
  const lenaEntries = (await localBackend.listEntries()).data || []
  assert(lenaEntries.some((e) => e.worker_id === other.id), "they see other workers' time")
  const lenaTasks = (await localBackend.listTasks()).data || []
  assert(lenaTasks.some((t) => t.id === patTask.id), "they see other workers' tasks")
  const assigned = await localBackend.createTask({ worker_id: plain.id, client_id: client.id, title: 'For Pat' })
  assert(assigned.data?.worker_id === plain.id, 'they can assign work to someone else')
  const moved = await localBackend.updateTask(patTask.id, { status: 'in_progress' })
  assert(!moved.error, "they can move another worker's card")

  // …but the money and the accounts stay shut.
  const lenaEntry = await localBackend.createEntry({
    worker_id: plain.id,
    client_id: client.id,
    start_time: new Date().toISOString(),
    end_time: new Date().toISOString(),
    break_minutes: 0,
    notes: null,
    hourly_rate: 15,
  })
  assert(!!lenaEntry.error, 'a supervisor still cannot add manual time entries')
  assert(
    ((await localBackend.listPayments()).data || []).every((p) => p.worker_id === lead.id),
    'a supervisor still only sees their own payments'
  )
  const lenaSettles = await localBackend.settleWorker(plain.id)
  assert(!!lenaSettles.error, 'a supervisor still cannot settle')
  const lenaEditsWorker = await localBackend.updateWorker(plain.id, { hourly_rate: 999 })
  assert(!!lenaEditsWorker.error, 'a supervisor still cannot change a worker (or their rate)')

  // A team-wide view opens the worker list even without workers.view, because
  // rows about other people are useless without the names.
  await localBackend.signIn('admin', 'admin.pipelinesync')
  await localBackend.updateWorker(lead.id, { permissions: ['entries.view_all'] })
  await localBackend.signIn('lena@example.com', 'worker123')
  assert(
    ((await localBackend.listWorkers()).data || []).length === allWorkers.length,
    'entries.view_all alone still resolves the team names'
  )

  // ---- 5. granting more, then taking it away -----------------------------
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const promoted = (await localBackend.updateWorker(lead.id, {
    permissions: [...PERMISSION_PRESETS.manager.permissions],
  })).data!
  assert(presetFor(promoted.permissions) === 'manager', 'the admin can change access on an existing worker')

  await localBackend.signIn('lena@example.com', 'worker123')
  const nowAllowed = await localBackend.createEntry({
    worker_id: plain.id,
    client_id: client.id,
    start_time: new Date(Date.now() - 3600_000).toISOString(),
    end_time: new Date().toISOString(),
    break_minutes: 0,
    notes: 'Added by the manager',
    hourly_rate: 15,
  })
  assert(!nowAllowed.error && nowAllowed.data?.worker_id === plain.id, 'the new capability takes effect immediately')
  assert(
    ((await localBackend.listPayments()).data || []).length >= 0 && !(await localBackend.settleWorker(plain.id)).error,
    'a manager can settle worker time'
  )
  assert(!(await localBackend.createClient({ name: 'Manager Ltd' })).error, 'a manager can add clients')
  const stillNoSettings = await localBackend.saveSettings({ business_name: 'Lena Inc' })
  assert(!!stillNoSettings.error, 'a manager still cannot change business settings')

  await localBackend.signIn('admin', 'admin.pipelinesync')
  await localBackend.updateWorker(lead.id, { permissions: [] })
  await localBackend.signIn('lena@example.com', 'worker123')
  assert(((await localBackend.listWorkers()).data || []).length === 1, 'revoking access closes the team list again')
  assert(
    ((await localBackend.listTasks()).data || []).every((t) => t.worker_id === lead.id),
    'revoking access closes the team board again'
  )

  console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll permission checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
