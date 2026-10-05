/**
 * Ad-hoc verification of the client invoicing section in demo mode (local
 * storage):
 *  - the demo seed raises invoices across all three board columns
 *  - the admin can create, edit, move (free drag) and delete invoices
 *  - cards sort by due date, so the soonest-due invoice is on top
 *  - the amount is optional — blank/zero is allowed until the figure is known
 *  - an invoice is client based or project based — different billing
 *    targets: a project-based one names its project (required) and may name
 *    the client the project belongs to, a client-based one picks a client
 *    (required) and has no project
 *  - the board's basis filter narrows it to one billing target, or shows both
 *  - invalid invoices (no client, negative amount, bad due date) are refused
 *  - a worker without `invoices.view` is refused at the backend, not just the UI
 *  - a granted worker sees and manages the very same board
 *
 * Run: npx tsx scripts/verify-invoices-local.ts
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
  const autoSeeded = (await localBackend.listInvoices()).data || []
  assert(autoSeeded.length > 0, 'the first sign-in auto-seeds a populated board')
  await localBackend.seedDemo()

  // ---- 2. the seeded board -------------------------------------------------
  const seeded = (await localBackend.listInvoices()).data || []
  assert(seeded.length > 0, 'the demo seed raises some invoices')
  const stages = new Set(seeded.map((i) => i.stage))
  assert(stages.has('pending') && stages.has('awaiting') && stages.has('paid'), 'the seed fills all three columns')
  const dueTodayOrFuture = seeded.filter((i) => i.due_date >= new Date().toISOString().slice(0, 10))
  const duePast = seeded.filter((i) => i.due_date < new Date().toISOString().slice(0, 10))
  assert(dueTodayOrFuture.length > 0 && duePast.length > 0, 'the seed has both upcoming and past due dates')
  assert(seeded.every((i) => i.basis === 'client' || (i.basis === 'project' && !!i.project_name)), 'every seeded invoice is client based or a named project')
  assert(seeded.some((i) => i.basis === 'project' && !!i.project_name), 'the seed includes a project-based invoice')
  assert(seeded.every((i) => (i.basis === 'client' ? !!i.client_id : !!i.project_name)), 'every invoice bills a client or names the project it bills')
  assert(seeded.some((i) => i.basis === 'project' && !!i.client_id), 'the seed includes a project-based invoice that names the client it belongs to')
  assert(seeded.some((i) => i.basis === 'project' && !i.client_id), 'the seed includes a project-based invoice billed on its own')

  // ---- 3. create / edit / move / delete ------------------------------------
  const clients = (await localBackend.listClients()).data || []
  const clientId = clients[0].id
  const due = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

  const created = (await localBackend.createInvoice({
    client_id: clientId,
    amount: 321.456,
    due_date: due(5),
    notes: '  verify  ',
  })).data!
  assert(created.amount === 321.46, 'creating rounds the amount to cents')
  assert(created.stage === 'pending', 'a new invoice starts in Pending')
  assert(created.notes === 'verify', 'creating trims the notes')
  assert(created.basis === 'client' && created.project_name === null, 'a new invoice defaults to client based')
  assert(!!(await localBackend.createInvoice({ client_id: null, amount: 10, due_date: due(5) })).error, 'a client-based invoice without a client is refused')
  assert(!!(await localBackend.createInvoice({ client_id: 'no-such-client', amount: 10, due_date: due(5) })).error, 'an unknown client is refused')
  assert(!!(await localBackend.createInvoice({ client_id: clientId, amount: -5, due_date: due(5) })).error, 'a negative amount is refused')
  assert(!!(await localBackend.createInvoice({ client_id: clientId, amount: 10, due_date: 'not-a-date' })).error, 'an invalid due date is refused')

  // The amount is optional: an invoice can go on the board before its figure
  // is known, and the number filled in later.
  const noAmount = (await localBackend.createInvoice({ client_id: clientId, amount: 0, due_date: due(4) })).data!
  assert(noAmount.amount === 0, 'a zero amount is accepted — the figure can be filled in later')

  // Client or project based — different billing targets. A project-based
  // invoice names the project and may bill it on its own…
  const projectBased = (await localBackend.createInvoice({
    client_id: null,
    basis: 'project',
    project_name: '  Website redesign  ',
    amount: 0, // optional amount and project basis together
    due_date: due(6),
  })).data!
  assert(projectBased.basis === 'project' && projectBased.client_id === null, 'a project-based invoice can bill a named project on its own')
  assert(projectBased.project_name === 'Website redesign', 'a project-based invoice keeps its trimmed project name')
  assert(!!(await localBackend.createInvoice({ client_id: null, basis: 'project', due_date: due(6) })).error, 'a project-based invoice without a project name is refused')
  assert(!!(await localBackend.createInvoice({ client_id: null, basis: 'project', project_name: '   ', due_date: due(6) })).error, 'a blank project name is refused')
  assert(!!(await localBackend.createInvoice({ client_id: 'no-such-client', basis: 'project', project_name: 'Website redesign', due_date: due(6) })).error, 'an unknown client is refused on a project-based invoice too')

  // …or name the client the project belongs to — the link is optional, not
  // the billing target.
  const projectForClient = (await localBackend.createInvoice({
    client_id: clientId,
    basis: 'project',
    project_name: 'Components build',
    amount: 500,
    due_date: due(7),
  })).data!
  assert(projectForClient.basis === 'project' && projectForClient.client_id === clientId, 'a project-based invoice may name the client the project belongs to')
  assert(projectForClient.project_name === 'Components build', 'the project name survives alongside the client')
  const detached = (await localBackend.updateInvoice(projectForClient.id, { client_id: null })).data!
  assert(detached.basis === 'project' && detached.client_id === null && detached.project_name === 'Components build', 'the client can be cleared again — the project is still what is billed')

  // The board's order: due soonest first within a column.
  const pending = ((await localBackend.listInvoices()).data || []).filter((i) => i.stage === 'pending')
  assert(pending[0]?.id === noAmount.id, 'the soonest-due invoice sorts to the top of its column')

  // Free drag: backwards too, not just forwards.
  const moved = (await localBackend.updateInvoice(created.id, { stage: 'awaiting' })).data!
  assert(moved.stage === 'awaiting', 'dragging forwards moves the invoice to Awaiting')
  const movedBack = (await localBackend.updateInvoice(created.id, { stage: 'pending' })).data!
  assert(movedBack.stage === 'pending', 'dragging backwards moves the invoice back to Pending')
  assert(!!(await localBackend.updateInvoice(created.id, { amount: -5 })).error, 'a negative amount is refused')
  assert(!!(await localBackend.updateInvoice(created.id, { stage: 'bogus' as 'pending' })).error === false, 'an unknown stage falls back to Pending rather than erroring')
  const afterBadStage = ((await localBackend.listInvoices()).data || []).find((i) => i.id === created.id)!
  assert(afterBadStage.stage === 'pending', 'the unknown stage landed in Pending')

  // A drag must not disturb what the invoice bills.
  const draggedProject = (await localBackend.updateInvoice(projectBased.id, { stage: 'awaiting' })).data!
  assert(draggedProject.basis === 'project' && draggedProject.project_name === 'Website redesign', 'dragging a project-based invoice keeps its basis and project name')

  // Editing can switch the billing target: to project (project name
  // required, the client stays as the project's home) and back to client
  // (project cleared, client required again).
  assert(!!(await localBackend.updateInvoice(projectBased.id, { basis: 'client', client_id: null })).error, 'switching to client based without picking a client is refused')
  const nowClient = (await localBackend.updateInvoice(projectBased.id, { basis: 'client', client_id: clientId })).data!
  assert(nowClient.basis === 'client' && nowClient.client_id === clientId && nowClient.project_name === null, 'switching to client based bills the client and clears the project')
  assert(!!(await localBackend.updateInvoice(projectBased.id, { client_id: null })).error, 'clearing the client on a client-based invoice is refused')
  assert(!!(await localBackend.updateInvoice(projectBased.id, { basis: 'project', project_name: null })).error, 'switching back to project based without a name is refused')
  const nowProject = (await localBackend.updateInvoice(projectBased.id, { basis: 'project', project_name: ' Components ' })).data!
  assert(nowProject.basis === 'project' && nowProject.project_name === 'Components', 'switching back to project based names the project')
  assert(nowProject.client_id === clientId, 'switching to project based keeps the client — it is the project’s home, not the billing target')
  const amountFilled = (await localBackend.updateInvoice(projectBased.id, { amount: 450 })).data!
  assert(amountFilled.amount === 450, 'the amount can be filled in after the fact')

  // A deleted client takes its client-based invoices off the board — nobody
  // is left to bill — but a project-based one keeps billing its project and
  // only loses the link.
  const tempClient = (await localBackend.createClient({ name: 'Verify Basis Ltd', color: 'blue' })).data!
  const tempClientInvoice = (await localBackend.createInvoice({ client_id: tempClient.id, amount: 10, due_date: due(3) })).data!
  const tempProjectInvoice = (await localBackend.createInvoice({ client_id: tempClient.id, basis: 'project', project_name: 'Verify build', amount: 20, due_date: due(3) })).data!
  assert(!(await localBackend.deleteClient(tempClient.id)).error, 'a client used only by invoices can still be deleted')
  const afterClientDelete = (await localBackend.listInvoices()).data || []
  assert(!afterClientDelete.some((i) => i.id === tempClientInvoice.id), 'deleting a client takes its client-based invoices off the board')
  const survivor = afterClientDelete.find((i) => i.id === tempProjectInvoice.id)
  assert(!!survivor && survivor.basis === 'project' && survivor.client_id === null && survivor.project_name === 'Verify build', 'a project-based invoice keeps billing its project after the client is deleted')

  assert(!(await localBackend.deleteInvoice(created.id)).error, 'the invoice can be deleted')
  assert(!(await localBackend.deleteInvoice(noAmount.id)).error, 'the zero-amount invoice can be deleted')
  assert(!(await localBackend.deleteInvoice(projectBased.id)).error, 'the project-based invoice can be deleted')
  assert(!(await localBackend.deleteInvoice(detached.id)).error, 'the project-based invoice with a client can be deleted')
  assert(!(await localBackend.deleteInvoice(tempProjectInvoice.id)).error, 'the invoice left behind by the deleted client can be deleted')
  assert(!((await localBackend.listInvoices()).data || []).some((i) => [created.id, noAmount.id, projectBased.id, detached.id].includes(i.id)), 'the deleted invoices are gone')

  // ---- 3b. the board's basis filter ---------------------------------------
  // The page narrows the board with one switch; these are the rules it uses.
  const { filterInvoicesByBasis, countInvoicesByBasis, readInvoiceBasisFilter, writeInvoiceBasisFilter } = await import('../src/lib/invoices')
  const board = (await localBackend.listInvoices()).data || []
  assert(filterInvoicesByBasis(board, 'all').length === board.length, '"all" leaves every invoice on the board')
  assert(filterInvoicesByBasis(board, 'client').every((i) => i.basis === 'client'), 'the client filter leaves only client-based invoices')
  assert(filterInvoicesByBasis(board, 'project').every((i) => i.basis === 'project'), 'the project filter leaves only project-based invoices')
  assert(countInvoicesByBasis(board, 'client') + countInvoicesByBasis(board, 'project') === board.length, 'the two billing targets add up to the whole board')
  assert(filterInvoicesByBasis(board, 'project').every((i) => !!i.project_name), 'every project-based invoice names the project it bills')
  assert(filterInvoicesByBasis(board, 'client').every((i) => !!i.client_id), 'every client-based invoice carries the client it bills')
  assert(readInvoiceBasisFilter() === 'all', 'the board opens on the unfiltered view')
  writeInvoiceBasisFilter('project')
  assert(readInvoiceBasisFilter() === 'project', 'the chosen basis is remembered for the next visit')
  writeInvoiceBasisFilter('bogus' as 'all')
  assert(readInvoiceBasisFilter() === 'all', 'an unreadable saved choice falls back to showing everything')

  // ---- 4. a plain worker is refused at the backend ------------------------
  const plain = (await localBackend.createWorker({
    name: 'Invoice Ida',
    hourly_rate: 16,
    accountEmail: 'ida@example.com',
    accountPassword: 'worker123',
  })).data!
  await localBackend.signOut()
  await localBackend.signIn('ida@example.com', 'worker123')
  assert(!!(await localBackend.listInvoices()).error, 'an ungranted worker cannot read the board')
  assert(!!(await localBackend.createInvoice({ client_id: clientId, amount: 10, due_date: due(1) })).error, 'an ungranted worker cannot raise an invoice')
  assert(!!(await localBackend.updateInvoice(seeded[0].id, { stage: 'paid' })).error, 'an ungranted worker cannot drag an invoice')
  assert(!!(await localBackend.deleteInvoice(seeded[0].id)).error, 'an ungranted worker cannot delete an invoice')

  // ---- 5. a granted worker shares the admin's board ------------------------
  await localBackend.signOut()
  await localBackend.signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  await localBackend.updateWorker(plain.id, { permissions: ['invoices.view'] })
  await localBackend.signOut()
  await localBackend.signIn('ida@example.com', 'worker123')
  const granted = (await localBackend.listInvoices()).data || []
  assert(granted.length === seeded.length, 'a granted worker reads the same board')
  const workerCreated = (await localBackend.createInvoice({ client_id: clientId, amount: 77, due_date: due(2) })).data!
  assert(!!workerCreated, 'a granted worker can raise invoices')
  const workerMoved = (await localBackend.updateInvoice(workerCreated.id, { stage: 'paid' })).data!
  assert(workerMoved.stage === 'paid', 'a granted worker can drag invoices between columns')
  assert(!(await localBackend.deleteInvoice(workerCreated.id)).error, 'a granted worker can delete invoices')

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
