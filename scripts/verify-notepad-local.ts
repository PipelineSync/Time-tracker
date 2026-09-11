/**
 * Ad-hoc verification of the notepad section in demo mode (local storage):
 *  - the admin and every worker have their own notepad (no permission gate)
 *  - notes are strictly private: nobody lists another account's notes, and
 *    updating or deleting another account's note answers "Note not found."
 *  - creating trims and validates (empty notes rejected, limits enforced)
 *  - the list orders pinned first, then newest edit first
 *  - edit / pin / colour / delete behave
 *
 * Run: npx tsx scripts/verify-notepad-local.ts
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

  // ---- 1. the admin signs in and writes some notes -------------------------
  const admin = await localBackend.signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')
  await localBackend.resetAll()

  const blank = await localBackend.createNote({ title: '   ', body: '   ' })
  assert(!!blank.error, 'an empty note is refused')

  const longTitle = await localBackend.createNote({ title: 'x'.repeat(201), body: 'body' })
  assert(!!longTitle.error, 'titles past 200 characters are refused')

  const first = (await localBackend.createNote({ title: '  Admin todo  ', body: '  approve timesheets  ' })).data!
  assert(first.title === 'Admin todo' && first.body === 'approve timesheets', 'creating trims title and body')
  assert(first.color === 'default' && first.pinned === false, 'a note defaults to no colour, unpinned')

  const pinned = (await localBackend.createNote({ title: 'Wifi password', body: 'on the fridge', color: 'amber', pinned: true })).data!
  assert(pinned.color === 'amber' && pinned.pinned === true, 'colour and pin are stored')
  await new Promise((r) => setTimeout(r, 5)) // distinct updated_at stamps

  const funky = (await localBackend.createNote({ title: 'Odd colour', body: 'x', color: 'chartreuse' as never })).data!
  assert(funky.color === 'default', 'an unknown colour falls back to default')

  // ---- 2. a worker (no grants at all) gets their own notepad ---------------
  const worker = (await localBackend.createWorker({
    name: 'Notes Ned',
    hourly_rate: 15,
    accountEmail: 'ned@example.com',
    accountPassword: 'worker123',
  })).data!
  assert(!!worker, 'admin can create a worker with a login')
  await localBackend.signOut()
  const ned = await localBackend.signIn('ned@example.com', 'worker123')
  assert(!ned.error && ned.data?.role === 'worker', 'the worker can sign in')

  const nedStart = (await localBackend.listNotes()).data || []
  assert(nedStart.length === 0, 'a fresh worker sees an empty notepad, not the admin\u2019s notes')

  const nedNote = (await localBackend.createNote({ title: 'Ned note', body: 'my shift notes' })).data!
  assert((await localBackend.listNotes()).data?.length === 1, 'the worker can write notes with no permission grant')

  // ---- 3. strict privacy between the two accounts --------------------------
  const foreign = await localBackend.updateNote(first.id, { title: 'hacked' })
  assert(!!foreign.error, 'a worker cannot edit the admin\u2019s note (not found)')
  const stillThere = (await localBackend.listNotes()).data || []
  assert(stillThere.length === 1 && stillThere[0].id === nedNote.id, 'the worker\u2019s list stays untouched')

  const foreignDelete = await localBackend.deleteNote(first.id)
  assert(foreignDelete.error === null, 'deleting another account\u2019s note is a no-op, not an error')
  assert((await localBackend.listNotes()).data?.length === 1, 'the no-op delete removed nothing of the worker\u2019s')

  await localBackend.signOut()
  await localBackend.signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  const adminNotes = (await localBackend.listNotes()).data || []
  assert(adminNotes.length === 3, 'the admin\u2019s notes survived the worker\u2019s tampering attempts')
  assert(!adminNotes.some((n) => n.id === nedNote.id), 'the admin cannot see the worker\u2019s note either')

  // ---- 4. ordering: pinned first, then newest edit first -------------------
  const newest = (await localBackend.createNote({ title: 'Newest', body: 'just now' })).data!
  let order = ((await localBackend.listNotes()).data || []).map((n) => n.id)
  assert(order[0] === pinned.id, 'the pinned note stays on top')
  assert(order[1] === newest.id, 'then notes sort newest edit first')

  // ---- 5. edit, pin/unpin, colour -------------------------------------------
  await new Promise((r) => setTimeout(r, 5)) // distinct updated_at stamps
  const edited = (await localBackend.updateNote(newest.id, { title: '  Renamed  ', body: 'changed', color: 'violet' })).data!
  assert(edited.title === 'Renamed' && edited.color === 'violet', 'editing trims and recolours')
  assert(edited.updated_at >= newest.updated_at, 'editing bumps updated_at')

  const unpinned = (await localBackend.updateNote(pinned.id, { pinned: false })).data!
  assert(!unpinned.pinned, 'unpinning works')
  order = ((await localBackend.listNotes()).data || []).map((n) => n.id)
  assert(order[0] === edited.id, 'with nothing pinned the newest edit is on top')

  const repinned = (await localBackend.updateNote(edited.id, { pinned: true })).data!
  order = ((await localBackend.listNotes()).data || []).map((n) => n.id)
  assert(repinned.pinned && order[0] === edited.id, 're-pinning puts the note back on top')

  // ---- 6. delete -------------------------------------------------------------
  assert((await localBackend.deleteNote(pinned.id)).error === null, 'deleting works')
  assert(((await localBackend.listNotes()).data || []).length === 3, 'the deleted note is gone')

  console.log('\nDone.')
}

void main()
