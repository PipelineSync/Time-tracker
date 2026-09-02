/**
 * Ad-hoc verification of the demo-mode (local storage) team chat: one shared
 * room where every message carries the sender's profile picture, name and role,
 * and a member list that is the same for everyone and always includes the admin.
 *
 * Run: npx tsx scripts/verify-chat-local.ts
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

  // 1) Admin signs in — the demo workspace is seeded, chat included.
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')

  const seeded = await localBackend.listChatMessages(500)
  assert(!seeded.error && (seeded.data?.length ?? 0) > 0, `demo chat is seeded (${seeded.data?.length} messages)`)
  assert(
    (seeded.data ?? []).some((m) => m.author_role === 'admin' && m.author_name === 'Admin'),
    'seeded chat includes a message from the admin'
  )
  assert(
    (seeded.data ?? []).every((m) => m.author_name && m.author_role && m.created_at),
    'every message carries an author name and role'
  )

  // 2) The member list includes the admin plus every worker.
  const adminMembers = await localBackend.listChatMembers()
  const workers = (await localBackend.listWorkers()).data || []
  assert(!adminMembers.error && (adminMembers.data?.length ?? 0) === workers.length + 1, 'admin sees the admin + all workers as members')
  assert(adminMembers.data?.[0]?.role === 'admin', 'the admin is listed first')
  assert(
    adminMembers.data?.some((m) => m.role === 'admin' && m.avatar_url === null && m.name === 'Admin'),
    'the admin member row is labelled Admin'
  )

  // 3) A worker sees the very same timeline and the very same member list.
  const workerLogin = await localBackend.signIn('john@example.com', 'worker123')
  assert(!workerLogin.error && workerLogin.data?.role === 'worker', 'worker can sign in')
  const workerMessages = await localBackend.listChatMessages(500)
  assert(
    JSON.stringify(workerMessages.data?.map((m) => m.id)) === JSON.stringify(seeded.data?.map((m) => m.id)),
    'worker reads the same chat as the admin'
  )
  const workerMembers = await localBackend.listChatMembers()
  assert(
    JSON.stringify(workerMembers.data) === JSON.stringify(adminMembers.data),
    'worker sees all members, including the admin'
  )
  assert(
    workerMembers.data?.some((m) => m.role === 'worker' && m.user_id === workerLogin.data?.id),
    'the worker finds themselves in the member list'
  )
  assert(
    (await localBackend.listWorkers()).data?.length === 1,
    'a worker still cannot list all workers outside the chat'
  )

  // 4) Posting stamps the sender's identity on the message.
  const posted = await localBackend.sendChatMessage('  On my way to the site.  ')
  assert(!posted.error && posted.data?.body === 'On my way to the site.', 'worker message is trimmed and saved')
  assert(posted.data?.author_role === 'worker' && posted.data?.author_name === 'John Smith', 'worker message carries the worker name and role')
  assert(posted.data?.author_position != null, 'worker message carries the role/position')
  assert(posted.data?.author_avatar_url === null, 'no profile picture yet')
  assert(posted.data?.worker_id === workerLogin.data?.workerId, 'worker message is linked to the worker row')

  assert((await localBackend.sendChatMessage('   ')).error !== null, 'empty messages are rejected')
  assert((await localBackend.sendChatMessage('x'.repeat(2001))).error !== null, 'over-long messages are rejected')

  // 5) The admin reads it and posts back as Admin.
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const afterPost = await localBackend.listChatMessages(500)
  assert(
    afterPost.data?.some((m) => m.id === posted.data?.id && m.author_name === 'John Smith'),
    'the admin reads the worker message'
  )
  const adminPost = await localBackend.sendChatMessage('Thanks John — clock out when the site is done.')
  assert(adminPost.data?.author_role === 'admin' && adminPost.data?.worker_id === null, 'admin posts as Admin with no worker link')
  await localBackend.saveSettings({ avatar_url: 'data:image/png;base64,adminpic' })
  const adminPost2 = await localBackend.sendChatMessage('My picture comes from settings.')
  assert(adminPost2.data?.author_avatar_url === 'data:image/png;base64,adminpic', 'admin picture comes from the business/settings avatar')

  // 6) A new profile picture shows up on the member list (and therefore the chat).
  await localBackend.signIn('john@example.com', 'worker123')
  const avatared = await localBackend.updateOwnProfile({ avatar_url: 'data:image/png;base64,johnpic' })
  assert(!avatared.error && avatared.data?.avatar_url === 'data:image/png;base64,johnpic', 'worker can set their profile picture')
  const membersNow = await localBackend.listChatMembers()
  assert(
    membersNow.data?.some((m) => m.worker_id === workerLogin.data?.workerId && m.avatar_url === 'data:image/png;base64,johnpic'),
    'the member list shows the worker profile picture'
  )
  const withPic = await localBackend.sendChatMessage('Picture updated.')
  assert(withPic.data?.author_avatar_url === 'data:image/png;base64,johnpic', 'new messages carry the new picture')

  // 7) Chronological order and a bounded window.
  const tail = await localBackend.listChatMessages(3)
  assert(tail.data?.length === 3, 'limit returns the newest window')
  const times = (tail.data ?? []).map((m) => m.created_at)
  assert(
    times.every((t, i) => i === 0 || times[i - 1] <= t),
    'messages come back oldest first'
  )

  // 8) Deleting a worker removes their messages and their member row.
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const johnId = workerLogin.data!.workerId!
  const deleted = await localBackend.deleteWorker(johnId)
  assert(!deleted.error, 'admin can delete the worker')
  const afterDelete = await localBackend.listChatMessages(500)
  assert(!afterDelete.data?.some((m) => m.worker_id === johnId), 'the deleted worker’s chat messages are gone')
  const membersAfter = await localBackend.listChatMembers()
  assert(!membersAfter.data?.some((m) => m.worker_id === johnId), 'the deleted worker is no longer a member')
  assert(membersAfter.data?.some((m) => m.role === 'admin'), 'the admin is still a member')
}

main().then(
  () => (process.exitCode ? process.exit(process.exitCode) : undefined),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
