/**
 * Ad-hoc verification of the IT Support section in demo mode (local storage):
 *
 * The feature's whole point is *who* gets to see the queue, so that is most of
 * what is checked here:
 *  - a fresh workspace has no tickets, and only the grant holder's submission
 *    loop is what fills the queue
 *  - **everyone can submit** a ticket — a plain worker and the admin included
 *  - submitting notifies **only the accounts holding the IT Support grant**
 *    (in-app bell rows of type 'ticket', pointing at the ticket)
 *  - a plain worker sees **only their own** tickets and cannot triage, assign
 *    or list the desk — refused by the backend, not just hidden in the UI
 *  - **the admin has no access at all**: the owner is not IT Support, so the
 *    queue, the triage controls and the assignee list are all refused
 *  - granting it in the worker form is what opens the desk, and the grant can
 *    be taken away again quietly
 *  - the desk can triage (status/assignee) and reply; replies and status moves
 *    notify the requester; reply_count/updated_at follow along
 *  - the requester can read and answer their own ticket, but not someone
 *    else's
 *  - attachments are capped at three
 *
 * Run: npx tsx scripts/verify-it-support-local.ts
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

  // ---- 1. the desk starts empty -------------------------------------------
  const admin = await localBackend.signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')
  await localBackend.seedDemo()
  assert(((await localBackend.listTickets()).data || []).length === 0, 'a fresh workspace has an empty ticket queue')

  // A plain worker account, and one the admin will put on the desk.
  const plain = (await localBackend.createWorker({
    name: 'Ticket Tara',
    hourly_rate: 16,
    accountEmail: 'tara@example.com',
    accountPassword: 'worker123',
  })).data!
  const desk = (await localBackend.createWorker({
    name: 'Desk Dana',
    hourly_rate: 18,
    accountEmail: 'dana@example.com',
    accountPassword: 'worker123',
  })).data!
  assert((plain.permissions || []).length === 0, 'a new worker starts with no access at all')

  // ---- 2. the admin has no access either ----------------------------------
  // This is the requirement that shapes the whole feature: the owner grants the
  // desk, and does not get to sit at it.
  const adminSubmits = (await localBackend.createTicket({
    subject: 'Office Wi-Fi keeps dropping',
    description: 'The connection drops every few minutes in the meeting room.',
    category: 'hardware',
    priority: 'medium',
  })).data!
  assert(!!adminSubmits.id, 'the admin can submit a ticket like anyone else')
  assert(adminSubmits.number === 1, 'the first ticket is #1')
  assert(adminSubmits.status === 'open' && adminSubmits.requester_name === 'Admin', 'a new ticket starts Open and records who reported it')
  assert(!!(await localBackend.updateTicket(adminSubmits.id, { status: 'in_progress' })).error, 'the admin cannot triage a ticket')
  assert(!!(await localBackend.listItSupportAssignees()).error, 'the admin cannot list the support desk')

  const adminQueue = (await localBackend.listTickets()).data || []
  assert(adminQueue.length === 1, 'the admin sees only their own submission, never the queue')

  // Nobody holds the grant yet, so the submission alerted nobody.
  const adminBell = (await localBackend.listNotifications(50)).data || []
  assert(!adminBell.some((n) => n.type === 'ticket'), 'a submission by the admin notifies nobody while no one runs support')

  // ---- 3. a plain worker submits; still nobody to tell --------------------
  await localBackend.signOut()
  await localBackend.signIn('tara@example.com', 'worker123')
  const taraTicket = (await localBackend.createTicket({
    subject: 'Cannot sign in to the dashboard',
    description: 'My password works on my phone but not on the office desktop.',
    category: 'account',
    priority: 'high',
    attachments: ['data:image/png;base64,aaaa', 'data:image/png;base64,bbbb', 'data:image/png;base64,cccc', 'data:image/png;base64,dddd'],
  })).data!
  assert(taraTicket.attachments.length === 3, 'a ticket keeps at most three screenshots')
  assert((await localBackend.listTickets()).data!.length === 1, 'a plain worker sees only their own ticket')
  assert(!!(await localBackend.updateTicket(taraTicket.id, { status: 'resolved' })).error, 'a plain worker cannot move a ticket to Resolved')
  assert(!!(await localBackend.listItSupportAssignees()).error, 'a plain worker cannot list the support desk')

  // ---- 4. the admin grants IT Support -------------------------------------
  // The grant is the switch the whole feature hangs on: nothing else in the
  // app opens the desk.
  await localBackend.signOut()
  await localBackend.signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  const granted = (await localBackend.updateWorker(desk.id, { permissions: ['it_support.manage'] })).data!
  assert(granted.permissions.includes('it_support.manage'), 'the admin can grant IT Support from the worker form')

  // ---- 5. the desk: queue, triage, reply ---------------------------------
  await localBackend.signOut()
  await localBackend.signIn('dana@example.com', 'worker123')
  const queue = (await localBackend.listTickets()).data || []
  assert(queue.length === 2, 'the grant holder sees every submitted ticket')
  assert(queue[0].priority === 'high', 'the queue puts the urgent ticket first')
  assert(queue.every((t) => t.attachments.length === 0), 'the queue read leaves the screenshots behind')

  const holders = (await localBackend.listItSupportAssignees()).data || []
  assert(holders.length === 1 && holders[0].name === 'Desk Dana', 'the desk is the only assignable person')

  // Tickets filed before anyone was on the desk are in the queue, and were not
  // retro-notified — the alert is for the moment a ticket arrives.
  const preGrantBell = (await localBackend.listNotifications(50)).data || []
  assert(preGrantBell.filter((n) => n.type === 'ticket').length === 0, 'tickets filed while nobody ran support are found in the queue, not back-dated alerts')

  // A ticket submitted *now* does alert the desk.
  await localBackend.signOut()
  await localBackend.signIn('tara@example.com', 'worker123')
  const secondTicket = (await localBackend.createTicket({
    subject: 'The printer on the 2nd floor jams',
    description: 'It jams on every second page since this morning.',
    category: 'hardware',
    priority: 'low',
  })).data!
  await localBackend.signOut()
  await localBackend.signIn('dana@example.com', 'worker123')
  const bell = (await localBackend.listNotifications(50)).data || []
  const ticketAlerts = bell.filter((n) => n.type === 'ticket')
  assert(ticketAlerts.length === 1, 'a submission alerts the desk, and only the desk')
  assert(ticketAlerts.every((n) => !!n.ticket_id), 'each ticket alert points at its ticket')
  assert(ticketAlerts[0].message.includes(`#${secondTicket.number}`) && ticketAlerts[0].message.includes('Ticket Tara'), 'the alert names the requester and the ticket number')
  assert(!ticketAlerts.some((n) => n.message.includes('#1')), 'the desk is not asked to re-read tickets it already has')

  const opened = (await localBackend.getTicket(taraTicket.id)).data!
  assert(opened.ticket.attachments.length === 3, 'opening the ticket brings its screenshots')
  assert(opened.replies.length === 0, 'the conversation starts empty')

  const assigned = (await localBackend.updateTicket(taraTicket.id, {
    status: 'in_progress',
    assignee_user_id: desk ? holders[0].user_id : null,
    assignee_name: 'Desk Dana',
  })).data!
  assert(assigned.status === 'in_progress' && assigned.assignee_name === 'Desk Dana', 'the desk can claim a ticket and move it to In progress')

  const reply = (await localBackend.addTicketReply(taraTicket.id, 'Try clearing the saved password and signing in again.')).data!
  assert(reply.from_support, 'a reply by the desk is marked as from IT Support')
  const afterReply = (await localBackend.getTicket(taraTicket.id)).data!
  assert(afterReply.ticket.reply_count === 1, 'a reply bumps the ticket reply count')
  assert(afterReply.ticket.updated_at >= reply.created_at || afterReply.ticket.updated_at === reply.created_at, 'a reply touches the ticket updated_at')
  assert(afterReply.replies.length === 1, 'the reply is in the thread')

  // ---- 6. the requester hears back and can answer -------------------------
  await localBackend.signOut()
  await localBackend.signIn('tara@example.com', 'worker123')
  const taraBell = (await localBackend.listNotifications(50)).data || []
  assert(taraBell.some((n) => n.type === 'ticket' && n.ticket_id === taraTicket.id && n.message.startsWith('IT Support replied')), 'the requester is notified when the desk replies')
  assert(taraBell.some((n) => n.type === 'ticket' && n.message.includes('In progress')), 'the requester is notified when the status moves')

  const ownThread = (await localBackend.getTicket(taraTicket.id)).data!
  assert(ownThread.replies.length === 1, 'the requester can open their own ticket and read the reply')
  const answered = (await localBackend.addTicketReply(taraTicket.id, 'That worked, thank you.')).data!
  assert(!answered.from_support, 'a reply by the requester is not marked as IT Support')
  assert(!!(await localBackend.getTicket(adminSubmits.id)).error, "the requester cannot open someone else's ticket")
  assert(!!(await localBackend.updateTicket(taraTicket.id, { status: 'resolved' })).error, 'the requester cannot resolve their own ticket')

  // The desk hears the requester's answer.
  await localBackend.signOut()
  await localBackend.signIn('dana@example.com', 'worker123')
  const deskBell = (await localBackend.listNotifications(50)).data || []
  assert(deskBell.some((n) => n.type === 'ticket' && n.message.includes('Ticket Tara replied')), 'the desk is notified when the requester replies back')

  const closed = (await localBackend.updateTicket(taraTicket.id, { status: 'resolved' })).data!
  assert(closed.status === 'resolved' && !!closed.resolved_at, 'resolving stamps the ticket')
  assert(!!(await localBackend.updateTicket(taraTicket.id, { assignee_user_id: taraTicket.requester_user_id })).error, 'a ticket cannot be assigned to someone with no IT Support access')

  // ---- 7. the grant is the only way in, and can be taken back -------------
  await localBackend.signOut()
  await localBackend.signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  await localBackend.updateWorker(desk.id, { permissions: [] })
  await localBackend.signOut()
  await localBackend.signIn('dana@example.com', 'worker123')
  assert(!!(await localBackend.listItSupportAssignees()).error, 'taking the grant away closes the desk again')
  const afterRevoke = (await localBackend.listTickets()).data || []
  assert(afterRevoke.length === 0, 'and the queue is not theirs to read any more')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
