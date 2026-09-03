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

  const reacted = await localBackend.toggleChatReaction(posted.data!.id, '👍')
  assert(!reacted.error && reacted.data?.length === 1, 'the worker can react to a message')
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

  // 5b) A message notifies everyone else in the room — never the sender.
  const adminNotifs = await localBackend.listNotifications()
  assert(
    adminNotifs.data?.some((n) => n.type === 'chat' && n.message === 'John Smith: On my way to the site.'),
    `the admin is notified about the worker's message`
  )
  assert(
    (adminNotifs.data ?? []).every((n) => n.type !== 'chat' || !n.message.startsWith('Admin:')),
    'the admin is not notified about their own messages'
  )
  assert(
    (adminNotifs.data ?? []).some((n) => n.type === 'chat' && !n.read),
    'the chat notification arrives unread'
  )

  // 6) A new profile picture shows up on the member list (and therefore the chat).
  await localBackend.signIn('john@example.com', 'worker123')
  const johnNotifs = await localBackend.listNotifications()
  assert(
    johnNotifs.data?.some((n) => n.type === 'chat' && n.message === 'Admin: Thanks John — clock out when the site is done.'),
    'the worker is notified about the admin message'
  )
  assert(
    (johnNotifs.data ?? []).every((n) => n.type !== 'chat' || !n.message.startsWith('John Smith:')),
    'a worker is not notified about their own messages'
  )
  const avatared = await localBackend.updateOwnProfile({ avatar_url: 'data:image/png;base64,johnpic' })
  assert(!avatared.error && avatared.data?.avatar_url === 'data:image/png;base64,johnpic', 'worker can set their profile picture')
  const membersNow = await localBackend.listChatMembers()
  assert(
    membersNow.data?.some((m) => m.worker_id === workerLogin.data?.workerId && m.avatar_url === 'data:image/png;base64,johnpic'),
    'the member list shows the worker profile picture'
  )
  const withPic = await localBackend.sendChatMessage('Picture updated.')
  assert(withPic.data?.author_avatar_url === 'data:image/png;base64,johnpic', 'new messages carry the new picture')

  // 7) A demo workspace seeded before the Chat section existed gets the starter
  //    conversation once — but only while it is still the untouched sample team.
  const adminDataKey = [...mem.keys()].find((k) => k.startsWith('wt_data_'))
  if (!adminDataKey) throw new Error(`no wt_data_ key in demo storage: ${JSON.stringify([...mem.keys()])}`)
  const wipeChat = () => {
    const workspace = JSON.parse(mem.get(adminDataKey)!)
    workspace.chat = []
    mem.set(adminDataKey, JSON.stringify(workspace))
  }
  wipeChat()
  // The check runs while the admin's session is read (that is what seeds demo data).
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const backfilled = await localBackend.listChatMessages(500)
  assert(
    (backfilled.data?.length ?? 0) >= 5,
    `an older demo workspace is backfilled with the starter chat (${backfilled.data?.length} messages)`
  )
  assert(
    (backfilled.data ?? []).every((m) => m.author_name && m.author_role),
    'backfilled messages still carry a name and role'
  )

  // 8) Chronological order and a bounded window.
  const tail = await localBackend.listChatMessages(3)
  assert(tail.data?.length === 3, 'limit returns the newest window')
  const times = (tail.data ?? []).map((m) => m.created_at)
  assert(
    times.every((t, i) => i === 0 || times[i - 1] <= t),
    'messages come back oldest first'
  )

  // A workspace the admin has edited is no longer the sample team: leave it alone.
  const someWorker = (await localBackend.listWorkers()).data![0]
  await localBackend.updateWorker(someWorker.id, { name: 'Renamed Worker' })
  wipeChat()
  await localBackend.getSession()
  const afterEdit = (await localBackend.listChatMessages(500)).data?.length ?? 0
  assert(afterEdit === 0, `a customized workspace is not stuffed with demo messages (${afterEdit})`)
  const postedAfterWipe = await localBackend.sendChatMessage('Our own first message.')
  assert(!postedAfterWipe.error, 'posting works normally in a customized workspace')

  // 9) Deleting a worker removes their messages and their member row.
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const johnId = workerLogin.data!.workerId!
  const deleted = await localBackend.deleteWorker(johnId)
  assert(!deleted.error, 'admin can delete the worker')
  const afterDelete = await localBackend.listChatMessages(500)
  assert(!afterDelete.data?.some((m) => m.worker_id === johnId), 'the deleted worker\u2019s chat messages are gone')
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
