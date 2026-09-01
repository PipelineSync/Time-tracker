/**
 * Ad-hoc verification of the demo-mode (local storage) delete-worker flow.
 * Run: npx tsx scripts/verify-delete-local.ts
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

  // 1) Admin signs in (auto-seeds workers on first login).
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')

  const workers = await localBackend.listWorkers()
  assert(workers.data && workers.data.length > 0, `admin sees seeded workers (${workers.data?.length})`)
  const john = workers.data!.find((w) => w.email === 'john@example.com')!
  assert(Boolean(john), 'john@example.com exists in seed')

  // 2) John signs out of the shared demo session and signs back in as himself.
  await localBackend.signOut()
  const johnIn = await localBackend.signIn('john@example.com', 'worker123')
  assert(!johnIn.error && johnIn.data?.role === 'worker', 'john can sign in before deletion')

  // 3) Admin signs back in and deletes john.
  await localBackend.signOut()
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const del = await localBackend.deleteWorker(john.id)
  assert(!del.error, 'admin can delete john')

  // 4) John can no longer sign in (same browser / shared demo storage).
  await localBackend.signOut()
  const johnAfter = await localBackend.signIn('john@example.com', 'worker123')
  assert(johnAfter.error === 'Invalid username or password.', `john cannot sign in after deletion (got: ${johnAfter.error})`)

  // 5) A session that still pointed at john resolves to no user.
  const session = await localBackend.getSession()
  assert(!session.data, 'no stale session resolves for the deleted account')

  // 6) Other seeded workers are unaffected.
  await localBackend.signOut()
  const sarah = await localBackend.signIn('sarah@example.com', 'worker123')
  assert(!sarah.error && sarah.data?.role === 'worker', 'other workers can still sign in')

  // 7) Admin can recreate a worker with the same email — fresh login works.
  await localBackend.signOut()
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const recreated = await localBackend.createWorker({
    name: 'John Doe',
    email: 'john@example.com',
    hourly_rate: 20,
    accountEmail: 'john@example.com',
    accountPassword: 'newpass123',
  })
  assert(!recreated.error && recreated.data, 'admin can recreate a worker with the same email')
  await localBackend.signOut()
  const johnRe = await localBackend.signIn('john@example.com', 'newpass123')
  assert(!johnRe.error, 'recreated worker signs in with the NEW password')
  const johnOld = await localBackend.signIn('john@example.com', 'worker123')
  assert(johnOld.error === 'Invalid username or password.', 'old password no longer works after recreation')

  // 8) "Delete all data" (reset) also disables every worker login.
  await localBackend.signOut()
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const reset = await localBackend.resetAll()
  assert(!reset.error, 'admin can reset all data')
  const afterReset = await localBackend.signIn('sarah@example.com', 'worker123')
  assert(afterReset.error !== null, `worker cannot sign in after full reset (got: ${afterReset.error})`)

  console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
