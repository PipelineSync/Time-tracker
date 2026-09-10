/**
 * Ad-hoc verification of the meetings section in demo mode (local storage):
 *  - demo seed schedules upcoming and past meetings
 *  - the admin can schedule, reschedule and delete meetings
 *  - the list splits upcoming (soonest first) / past (newest first)
 *  - a worker without `meetings.view` is refused at the backend, not just the UI
 *  - a granted worker sees and manages the very same schedule
 *
 * Run: npx tsx scripts/verify-meetings-local.ts
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

  // ---- 1. the admin signs in and loads the demo workspace -----------------
  const admin = await localBackend.signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')
  await localBackend.seedDemo()

  // ---- 2. the seeded schedule ---------------------------------------------
  const seeded = (await localBackend.listMeetings()).data || []
  assert(seeded.length > 0, 'the demo seed schedules some meetings')
  const now = Date.now()
  const seededUpcoming = seeded.filter((m) => new Date(m.start_time).getTime() >= now)
  const seededPast = seeded.filter((m) => new Date(m.start_time).getTime() < now)
  assert(seededUpcoming.length > 0 && seededPast.length > 0, 'the seed has both upcoming and past meetings')

  // ---- 3. schedule / reschedule / delete ----------------------------------
  const created = (await localBackend.createMeeting({
    title: '  Verify standup  ',
    start_time: new Date(now + 60 * 60 * 1000).toISOString(),
    notes: '  check the agenda  ',
  })).data!
  assert(created.title === 'Verify standup', 'creating trims the title')
  assert(created.notes === 'check the agenda', 'creating trims the notes')

  const list = (await localBackend.listMeetings()).data || []
  const upcoming = list.filter((m) => new Date(m.start_time).getTime() >= now)
  assert(upcoming[0]?.id === created.id, 'the soonest upcoming meeting sorts first')
  assert(upcoming.every((m, i) => i === 0 || m.start_time.localeCompare(upcoming[i - 1].start_time) >= 0), 'upcoming sorts ascending')

  const rescheduled = (await localBackend.updateMeeting(created.id, {
    start_time: new Date(now - 30 * 60 * 1000).toISOString(),
  })).data!
  assert(new Date(rescheduled.start_time).getTime() < now, 'rescheduling into the past moves it to the past half')
  const afterReschedule = (await localBackend.listMeetings()).data || []
  const past = afterReschedule.filter((m) => new Date(m.start_time).getTime() < now)
  assert(past[0]?.id === created.id, 'the most recently past meeting sorts first in the past half')

  const invalid = await localBackend.createMeeting({ title: 'Bad', start_time: 'not-a-date' })
  assert(!!invalid.error, 'an invalid start time is refused')

  assert(!!(await localBackend.deleteMeeting(created.id)).error === false, 'the meeting can be deleted')
  assert(!((await localBackend.listMeetings()).data || []).some((m) => m.id === created.id), 'the deleted meeting is gone')

  // ---- 4. a plain worker is refused at the backend ------------------------
  const plain = (await localBackend.createWorker({
    name: 'Meeting Mina',
    hourly_rate: 16,
    accountEmail: 'mina@example.com',
    accountPassword: 'worker123',
  })).data!
  await localBackend.signOut()
  await localBackend.signIn('mina@example.com', 'worker123')
  assert(!!(await localBackend.listMeetings()).error, 'an ungranted worker cannot read the schedule')
  assert(!!(await localBackend.createMeeting({ title: 'Sneaky', start_time: new Date().toISOString() })).error, 'an ungranted worker cannot schedule a meeting')
  assert(!!(await localBackend.deleteMeeting(seeded[0].id)).error, 'an ungranted worker cannot delete a meeting')

  // ---- 5. a granted worker shares the admin's schedule --------------------
  await localBackend.signOut()
  await localBackend.signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  await localBackend.updateWorker(plain.id, { permissions: ['meetings.view'] })
  await localBackend.signOut()
  await localBackend.signIn('mina@example.com', 'worker123')
  const granted = (await localBackend.listMeetings()).data || []
  assert(granted.length === seeded.length, 'a granted worker reads the same schedule')
  const workerCreated = (await localBackend.createMeeting({ title: 'Worker-scheduled 1:1', start_time: new Date(now + 2 * 60 * 60 * 1000).toISOString() })).data!
  assert(!!workerCreated, 'a granted worker can schedule meetings')
  const workerEdited = (await localBackend.updateMeeting(workerCreated.id, { notes: 'moved' })).data!
  assert(workerEdited.notes === 'moved', 'a granted worker can edit meetings')
  assert(!(await localBackend.deleteMeeting(workerCreated.id)).error, 'a granted worker can delete meetings')

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
