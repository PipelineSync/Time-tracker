/**
 * Verification of the client invoicing section in demo mode (local storage):
 *  - the rules (src/lib/invoiceCycles), with fixed dates: statuses, billing
 *    dates, cycle dates, write validation and the auto-bill planner
 *  - the demo seed raises every kind of invoice in every lane
 *  - regular clients recur: auto-bill raises the cycle that has come due and
 *    queues the next one behind it; the switch is shared along the chain;
 *    undoing a raised cycle sticks; a deleted queued cycle stays deleted;
 *    a long absence catches up; switching back on never back-bills
 *  - project-based and Upwork invoices are raised by hand and share the totals
 *  - billing and payment dates are stamped, and undo clears them
 *  - a deleted client takes its regular and Upwork invoices with it
 *  - the board's basis switch, its lanes and the monthly totals
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

const DAY = 86_400_000
const near = (a: number, b: number) => Math.abs(a - b) < 0.005

async function main() {
  const { localBackend, ADMIN_EMAIL, ADMIN_PASSWORD } = await import('../src/lib/localDb')
  const { toISODate, advanceCycle } = await import('../src/lib/finance')
  const rules = await import('../src/lib/invoiceCycles')
  const board = await import('../src/lib/invoices')
  const { invoiceStatus, nextCycle, planAutoBill, resolveInvoiceWrite, stampsForStage } = rules
  type Inv = import('../src/lib/types').Invoice

  const today = toISODate(new Date())
  const at = (offset: number) => toISODate(new Date(Date.now() + offset * DAY))
  const plus = (iso: string) => advanceCycle(iso, 'monthly')

  // ---- 1. the rules, with fixed dates --------------------------------------
  const T = '2026-10-08'
  const row = (over: Partial<Inv>): Inv => ({
    id: 'r',
    client_id: 'c1',
    basis: 'client',
    project_name: null,
    amount: 100,
    due_date: '2026-10-15',
    stage: 'pending',
    notes: null,
    bill_on: '2026-10-01',
    auto_bill: true,
    auto_billed: false,
    billed_on: null,
    paid_on: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  })
  const ctx = (over: Partial<{ chainAutoBill: boolean | null; clientHasPendingRegular: boolean }> = {}) => ({
    today: T,
    chainAutoBill: null,
    clientHasPendingRegular: false,
    ...over,
  })

  assert(invoiceStatus('paid', '2026-01-01', T) === 'paid', 'a paid invoice is never overdue')
  assert(invoiceStatus('awaiting', '2026-10-07', T) === 'overdue', 'an awaiting invoice past its due date is overdue')
  assert(invoiceStatus('awaiting', T, T) === 'awaiting', 'an invoice due today is not overdue yet')
  assert(invoiceStatus('pending', '2026-10-07', T) === 'overdue', 'an unbilled invoice past its due date is overdue too')
  assert(invoiceStatus('pending', '2026-10-20', T) === 'pending', 'an invoice before its due date stays pending')

  const fresh = { stage: 'pending' as const, billed_on: null, paid_on: null }
  assert(JSON.stringify(stampsForStage(fresh, 'awaiting', T)) === JSON.stringify({ billed_on: T, paid_on: null }), 'billing stamps the billed date')
  assert(
    JSON.stringify(stampsForStage({ stage: 'awaiting', billed_on: '2026-10-01', paid_on: null }, 'paid', T)) ===
      JSON.stringify({ billed_on: '2026-10-01', paid_on: T }),
    'paying keeps the billed date and stamps the paid date',
  )
  assert(
    JSON.stringify(stampsForStage({ stage: 'paid', billed_on: '2026-10-01', paid_on: '2026-10-05' }, 'awaiting', T)) ===
      JSON.stringify({ billed_on: '2026-10-01', paid_on: null }),
    'undoing a payment clears the paid date only',
  )
  assert(
    JSON.stringify(stampsForStage(fresh, 'paid', T)) === JSON.stringify({ billed_on: T, paid_on: T }),
    'paying straight from Pending stamps both dates',
  )
  assert(
    JSON.stringify(stampsForStage({ stage: 'awaiting', billed_on: '2026-10-01', paid_on: null }, 'pending', T)) ===
      JSON.stringify({ billed_on: null, paid_on: null }),
    'moving back to Pending clears both dates',
  )

  assert(
    JSON.stringify(nextCycle({ bill_on: '2026-10-01', due_date: '2026-10-15' }, null)) ===
      JSON.stringify({ bill_on: '2026-11-01', due_date: '2026-11-15' }),
    'the next cycle is a month on, with its due date',
  )
  assert(nextCycle({ bill_on: '2026-01-31', due_date: '2026-02-28' }, null).bill_on === '2026-02-28', 'a cycle on the 31st clamps to the end of February')
  assert(
    JSON.stringify(nextCycle({ bill_on: '2026-10-01', due_date: '2026-10-15' }, '2026-12-05')) ===
      JSON.stringify({ bill_on: '2027-01-01', due_date: '2027-01-15' }),
    'picking up after a date steps past every cycle that has already come',
  )

  // Writes: what a create or edit may store.
  const createBase = { client_id: 'c1', amount: 100, due_date: '2026-10-20' }
  const createdRegular = resolveInvoiceWrite(null, { ...createBase, basis: 'client' }, ctx())
  assert(createdRegular.ok && createdRegular.row.bill_on === T && createdRegular.row.auto_bill, 'a new regular invoice defaults to auto-bill on, billed today')
  assert(createdRegular.ok && createdRegular.mirrorAutoBill === null, 'a new regular invoice that states no switch leaves its client’s switch as it is')
  assert(!resolveInvoiceWrite(null, { client_id: null, basis: 'client', amount: 1, due_date: '2026-10-20' }, ctx()).ok, 'a regular invoice without a client is refused')
  assert(!resolveInvoiceWrite(null, { client_id: null, basis: 'upwork', amount: 1, due_date: '2026-10-20' }, ctx()).ok, 'an Upwork invoice without a client is refused')
  assert(!resolveInvoiceWrite(null, { client_id: null, basis: 'project', amount: 1, due_date: '2026-10-20' }, ctx()).ok, 'a project-based invoice without a project name is refused')
  const standaloneProject = resolveInvoiceWrite(null, { client_id: null, basis: 'project', project_name: ' Landing ', amount: 1, due_date: '2026-10-20' }, ctx())
  assert(standaloneProject.ok && standaloneProject.row.project_name === 'Landing' && standaloneProject.row.bill_on === null && !standaloneProject.row.auto_bill, 'a project-based invoice bills its project on its own, with no cycle or switch')
  assert(!resolveInvoiceWrite(null, { ...createBase, basis: 'client', stage: 'pending' }, ctx({ clientHasPendingRegular: true })).ok, 'a second pending regular invoice for the same client is refused')
  assert(resolveInvoiceWrite(null, { ...createBase, basis: 'client', stage: 'awaiting' }, ctx({ clientHasPendingRegular: true })).ok, 'a regular invoice already billed does not wait behind a pending one')
  assert(resolveInvoiceWrite(null, { ...createBase, basis: 'client' }, ctx({ chainAutoBill: false })).ok && !(resolveInvoiceWrite(null, { ...createBase, basis: 'client' }, ctx({ chainAutoBill: false })) as any).row.auto_bill, 'a new regular invoice takes the switch its client already has')
  assert(!resolveInvoiceWrite(null, { ...createBase, basis: 'client', bill_on: '2026-13-45' }, ctx()).ok, 'an impossible bill-on date is refused')
  assert(!resolveInvoiceWrite(null, { ...createBase, basis: 'upwork', amount: -5 }, ctx()).ok, 'a negative amount is refused')
  const billedAtCreate = resolveInvoiceWrite(null, { ...createBase, basis: 'client', stage: 'awaiting', bill_on: '2026-10-01' }, ctx())
  assert(billedAtCreate.ok && billedAtCreate.row.billed_on === T && billedAtCreate.billed, 'a regular invoice created already billed is stamped and starts the chain')

  const billedRow = row({ stage: 'awaiting', billed_on: '2026-10-01', auto_billed: true })
  const undone = resolveInvoiceWrite(billedRow, { stage: 'pending' }, ctx())
  assert(undone.ok && undone.row.billed_on === null && undone.row.auto_billed === true && !undone.billed, 'undoing a billed cycle clears the billed date and stays handled')
  const billedAgain = resolveInvoiceWrite(row({ stage: 'pending', auto_billed: false }), { stage: 'awaiting' }, ctx())
  assert(billedAgain.ok && billedAgain.billed, 'billing a pending regular invoice under auto-bill starts the next cycle')
  assert(billedAgain.ok && billedAgain.row.auto_billed === true, 'billing a cycle by hand under auto-bill marks it handled')
  const handUndone = billedAgain.ok ? resolveInvoiceWrite({ ...row({}), ...billedAgain.row, id: 'r' }, { stage: 'pending' }, ctx()) : null
  assert(handUndone !== null && handUndone.ok && handUndone.row.auto_billed === true, 'undoing a hand-billed cycle keeps it handled')
  assert(
    handUndone !== null && handUndone.ok && planAutoBill([{ ...row({}), ...handUndone.row, id: 'r' }], '2026-10-20', { kind: 'sweep' }).length === 0,
    'a hand-billed cycle undone after its bill-on date is not raised again',
  )
  const billedOffSwitch = resolveInvoiceWrite(row({ stage: 'pending', auto_bill: false }), { stage: 'awaiting' }, ctx())
  assert(billedOffSwitch.ok && billedOffSwitch.row.auto_billed === false && !billedOffSwitch.billed, 'billing a cycle on a client with auto-bill off leaves it unhandled')
  const moved = resolveInvoiceWrite(billedRow, { bill_on: '2026-11-01' }, ctx())
  assert(moved.ok && moved.row.auto_billed === false, 'moving a cycle to another bill-on date makes it unhandled again')
  const switchedOn = resolveInvoiceWrite(row({ auto_bill: false }), { auto_bill: true }, ctx())
  assert(switchedOn.ok && switchedOn.resumed && switchedOn.mirrorAutoBill === true, 'switching auto-bill on resumes the client’s chain')
  const toProject = resolveInvoiceWrite(billedRow, { basis: 'project', project_name: 'Build' }, ctx())
  assert(toProject.ok && toProject.row.bill_on === null && !toProject.row.auto_bill && !toProject.row.auto_billed, 'turning a regular invoice into a project one takes it off the chain')

  // The planner: what auto-bill does next.
  const due = row({ id: 'due', stage: 'pending', bill_on: '2026-10-01', due_date: '2026-10-15', amount: 850 })
  const sweep = planAutoBill([due], T, { kind: 'sweep' })
  assert(sweep.length === 2, 'a due cycle is raised and its successor queued')
  const queuedOp = sweep.find((op) => op.kind === 'insert')
  const raiseOp = sweep.find((op) => op.kind === 'update')
  assert(
    !!queuedOp && queuedOp.kind === 'insert' && queuedOp.row.bill_on === '2026-11-01' && queuedOp.row.due_date === '2026-11-15' && queuedOp.row.amount === 850 && queuedOp.row.auto_bill && queuedOp.row.notes === null,
    'the successor is next month, same amount and switch, with no notes',
  )
  assert(
    !!raiseOp && raiseOp.kind === 'update' && raiseOp.id === 'due' && raiseOp.patch.stage === 'awaiting' && raiseOp.patch.billed_on === '2026-10-01' && raiseOp.patch.auto_billed === true,
    'the raised cycle is awaiting, billed on its bill-on date, and handled',
  )
  assert(planAutoBill([row({ bill_on: '2026-10-20' })], T, { kind: 'sweep' }).length === 0, 'a cycle that has not come round is left alone')
  assert(planAutoBill([row({ auto_bill: false })], T, { kind: 'sweep' }).length === 0, 'a cycle on a client with auto-bill off is left alone')
  assert(planAutoBill([row({ auto_billed: true })], T, { kind: 'sweep' }).length === 0, 'a cycle auto-bill has handled is never raised again')
  const withOpen = planAutoBill([due, row({ id: 'next', bill_on: '2026-11-01', due_date: '2026-11-15' })], T, { kind: 'sweep' })
  assert(withOpen.length === 1 && withOpen[0].kind === 'update', 'a client with a cycle already open gets no second successor')
  const withQueued = planAutoBill([due, row({ id: 'skipped', bill_on: '2026-11-01', due_date: '2026-11-15', auto_billed: true })], T, { kind: 'sweep' })
  assert(withQueued.length === 1 && withQueued[0].kind === 'update', 'a cycle already queued on the same day is never queued twice')

  const billedPast = row({ id: 'billed', stage: 'awaiting', bill_on: '2026-09-01', billed_on: '2026-09-01', auto_billed: true, due_date: '2026-09-15' })
  const afterBilling = planAutoBill([billedPast, row({ id: 'billed-now', stage: 'pending', bill_on: '2026-10-01', auto_billed: true })], T, { kind: 'billed', id: 'billed' })
  const queuedAfterBilling = afterBilling.find((op) => op.kind === 'insert')
  assert(
    !!queuedAfterBilling && queuedAfterBilling.kind === 'insert' && queuedAfterBilling.row.bill_on === '2026-11-01',
    'billing a cycle late queues the first cycle after today, never a back-dated one',
  )
  assert(planAutoBill([billedPast], T, { kind: 'billed', id: 'billed' }).length === 1, 'billing under auto-bill queues the next cycle')
  assert(planAutoBill([{ ...billedPast, auto_bill: false }], T, { kind: 'billed', id: 'billed' }).length === 0, 'billing with auto-bill off queues nothing')

  // Resuming: cycles already past are handled by hand, the chain picks up after today.
  const pastDue = row({ id: 'past', stage: 'pending', bill_on: '2026-09-01', due_date: '2026-09-15' })
  const resumeWithHead = planAutoBill([pastDue, billedPast], T, { kind: 'resumed', clientId: 'c1' })
  assert(resumeWithHead.some((op) => op.kind === 'update' && op.id === 'past' && op.patch.auto_billed === true), 'switching on leaves a past cycle for a hand bill')
  assert(!resumeWithHead.some((op) => op.kind === 'update' && op.patch.stage === 'awaiting'), 'switching on raises nothing')
  assert(resumeWithHead.some((op) => op.kind === 'insert' && op.row.bill_on === '2026-11-01'), 'switching on picks the chain up at the first cycle after today')
  const resumeNoHead = planAutoBill([pastDue], T, { kind: 'resumed', clientId: 'c1' })
  assert(resumeNoHead.length === 1 && resumeNoHead[0].kind === 'update', 'switching on with no billed cycle only settles the past one')

  // A long absence: every cycle that came round is raised, one at a time, and one
  // cycle stays queued for the future.
  let catchUp: Inv[] = [row({ id: 'long', stage: 'pending', bill_on: '2026-07-01', due_date: '2026-07-15' })]
  for (let pass = 0; pass < 50; pass++) {
    const ops = planAutoBill(catchUp, T, { kind: 'sweep' })
    if (ops.length === 0) break
    catchUp = catchUp.map((r) => r)
    for (const op of ops) {
      if (op.kind === 'insert') catchUp.push({ ...row({}), ...op.row, id: `q${pass}`, created_at: `2026-10-08T00:0${pass}:00.000Z`, updated_at: '' })
      else catchUp = catchUp.map((r) => (r.id === op.id ? { ...r, ...op.patch } : r))
    }
  }
  const raisedCount = catchUp.filter((r) => r.stage === 'awaiting').length
  const openNow = catchUp.filter((r) => r.stage === 'pending')
  assert(raisedCount === 4, 'a long absence raises every cycle that came round (July to October)')
  assert(openNow.length === 1 && openNow[0].bill_on === '2026-11-01', 'one cycle stays queued after the catch-up, for next month')

  // ---- 2. the demo seed ----------------------------------------------------
  const admin = await localBackend.signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')
  const autoSeeded = (await localBackend.listInvoices()).data || []
  assert(autoSeeded.length > 0, 'the first sign-in auto-seeds a populated board')
  await localBackend.seedDemo()

  const seeded = (await localBackend.listInvoices()).data || []
  const clients = (await localBackend.listClients()).data || []
  const statuses = new Set(seeded.map((i) => invoiceStatus(i.stage, i.due_date, today)))
  assert(statuses.has('pending') && statuses.has('awaiting') && statuses.has('overdue') && statuses.has('paid'), 'the seed fills all four lanes, Overdue included')
  assert(seeded.some((i) => i.basis === 'client') && seeded.some((i) => i.basis === 'project') && seeded.some((i) => i.basis === 'upwork'), 'the seed has regular, project-based and Upwork invoices')
  assert(seeded.filter((i) => i.basis === 'client').every((i) => i.bill_on !== null), 'every regular invoice carries its bill-on date')
  assert(seeded.filter((i) => i.basis !== 'client').every((i) => i.bill_on === null && !i.auto_bill), 'only regular invoices carry a bill-on date and the switch')
  assert(seeded.some((i) => i.basis === 'client' && i.auto_bill) && seeded.some((i) => i.basis === 'client' && !i.auto_bill), 'the seed shows auto-bill both on and off')
  assert(seeded.every((i) => i.stage !== 'paid' || i.paid_on !== null), 'every paid invoice has its paid date')
  assert(seeded.every((i) => i.stage === 'pending' || i.billed_on !== null), 'every billed invoice has its billed date')
  assert(
    !seeded.some((i) => i.basis === 'client' && i.stage === 'pending' && i.auto_bill && !i.auto_billed && (i.bill_on ?? '') <= today),
    'the seed leaves no auto-bill cycle due, so the board is at rest',
  )
  const northwind = clients.find((c) => c.name === 'Northwind Traders')!
  const acme = clients.find((c) => c.name === 'Acme Corp')!
  const nextMonthFirst = toISODate(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1))
  const nw = board.regularChain(seeded, northwind.id)
  assert(nw.autoBill && nw.nextAutoBill === nextMonthFirst, 'Northwind is on auto-bill, with next month already queued')
  assert(nw.lastBilled !== null, 'Northwind shows when it was last billed')
  const ac = board.regularChain(seeded, acme.id)
  assert(!ac.autoBill && ac.nextAutoBill === null, 'Acme is billed by hand: auto-bill off, nothing queued')

  // ---- 3. a regular client's chain -----------------------------------------
  const retainer = (await localBackend.createClient({ name: 'Verify Retainer Co', color: 'blue' })).data!
  const first = (await localBackend.createInvoice({ client_id: retainer.id, basis: 'client', amount: 500, due_date: at(14), bill_on: at(3) })).data!
  assert(first.basis === 'client' && first.auto_bill && first.bill_on === at(3), 'a new regular invoice starts on auto-bill, billed on its bill-on date')
  assert(!!(await localBackend.createInvoice({ client_id: retainer.id, basis: 'client', amount: 1, due_date: at(14), bill_on: at(9) })).error, 'a second pending regular invoice for the same client is refused')

  const billedByHand = (await localBackend.updateInvoice(first.id, { stage: 'awaiting' })).data!
  assert(billedByHand.stage === 'awaiting' && billedByHand.billed_on === today, 'billing by hand stamps today as the billed date')
  const chainAfterBilling = ((await localBackend.listInvoices()).data || []).filter((i) => i.client_id === retainer.id)
  const queued = chainAfterBilling.find((i) => i.stage === 'pending')
  assert(
    !!queued && queued.bill_on === plus(first.bill_on!) && queued.due_date === plus(first.due_date) && queued.amount === 500 && queued.auto_bill && queued.notes === null,
    'billing a regular invoice queues next month: same amount and switch, due a month on',
  )
  const chainNow = board.regularChain((await localBackend.listInvoices()).data || [], retainer.id)
  assert(chainNow.lastBilled === today && chainNow.nextAutoBill === queued!.bill_on, 'the chain shows last billed today and the next auto-bill')

  const off = (await localBackend.updateInvoice(queued!.id, { auto_bill: false })).data!
  const chainOff = ((await localBackend.listInvoices()).data || []).filter((i) => i.client_id === retainer.id)
  assert(!off.auto_bill && chainOff.every((i) => !i.auto_bill), 'the auto-bill switch is shared along the client’s regular invoices')
  assert(board.regularChain(chainOff, retainer.id).nextAutoBill === null, 'with auto-bill off nothing is shown as next to bill')
  const back = (await localBackend.updateInvoice(queued!.id, { auto_bill: true })).data!
  const chainBack = ((await localBackend.listInvoices()).data || []).filter((i) => i.client_id === retainer.id)
  assert(back.auto_bill && chainBack.every((i) => i.auto_bill), 'switching it back on turns it on along the chain too')
  assert(chainBack.filter((i) => i.stage === 'pending').length === 1, 'switching back on keeps a single queued cycle')

  // Deleting the queued cycle keeps it deleted: nothing queues it again.
  assert(!(await localBackend.deleteInvoice(queued!.id)).error, 'a queued cycle can be deleted')
  const afterDelete = ((await localBackend.listInvoices()).data || []).filter((i) => i.client_id === retainer.id)
  assert(!afterDelete.some((i) => i.stage === 'pending'), 'deleting a queued cycle does not bring it straight back')

  // A cycle that comes due is raised on the spot; moving it back by hand sticks.
  const dueClient = (await localBackend.createClient({ name: 'Verify Due Co', color: 'amber' })).data!
  const raisedOnCreate = (await localBackend.createInvoice({ client_id: dueClient.id, amount: 300, due_date: at(10), bill_on: at(-1) })).data!
  assert(raisedOnCreate.stage === 'awaiting' && raisedOnCreate.billed_on === at(-1) && raisedOnCreate.auto_billed, 'a cycle whose bill-on date has come is raised straight away, billed on that date')
  const dueChain = ((await localBackend.listInvoices()).data || []).filter((i) => i.client_id === dueClient.id)
  assert(dueChain.some((i) => i.stage === 'pending' && i.bill_on === plus(at(-1))), 'the next cycle is queued behind a raised one')
  const undoneRaise = (await localBackend.updateInvoice(raisedOnCreate.id, { stage: 'pending' })).data!
  assert(undoneRaise.stage === 'pending' && undoneRaise.billed_on === null, 'moving a raised cycle back to Pending clears its billed date')
  const afterUndo = ((await localBackend.listInvoices()).data || []).find((i) => i.id === raisedOnCreate.id)!
  assert(afterUndo.stage === 'pending' && afterUndo.billed_on === null, 'auto-bill does not raise the undone cycle again')

  // A long absence: a chain whose cycles lapsed while the app was shut is caught up.
  const lapsed = (await localBackend.createClient({ name: 'Verify Catch-up Ltd', color: 'violet' })).data!
  await localBackend.createInvoice({ client_id: lapsed.id, amount: 200, due_date: at(-26), bill_on: at(-40) })
  const lapsedChain = ((await localBackend.listInvoices()).data || []).filter((i) => i.client_id === lapsed.id)
  assert(lapsedChain.filter((i) => i.stage === 'awaiting').length === 2, 'a lapsed chain catches up: every cycle that came round is raised')
  assert(lapsedChain.filter((i) => i.stage === 'pending').length === 1 && lapsedChain.find((i) => i.stage === 'pending')!.bill_on! > today, 'and one cycle stays queued for the future')

  // Switching auto-bill back on never back-bills a cycle that has passed.
  const parked = (await localBackend.createClient({ name: 'Verify Paused Ltd', color: 'rose' })).data!
  const pausedCycle = (await localBackend.createInvoice({ client_id: parked.id, amount: 90, due_date: at(9), bill_on: at(-5), auto_bill: false })).data!
  assert(pausedCycle.stage === 'pending' && !pausedCycle.auto_bill, 'a cycle created with auto-bill off waits for a hand bill')
  const resumed = (await localBackend.updateInvoice(pausedCycle.id, { auto_bill: true })).data!
  assert(resumed.stage === 'pending' && resumed.auto_billed && resumed.billed_on === null, 'switching auto-bill on leaves the passed cycle pending for a hand bill')
  const parkedChain = ((await localBackend.listInvoices()).data || []).filter((i) => i.client_id === parked.id)
  assert(parkedChain.length === 1, 'and does not queue anything new behind it')

  // ---- 4. project-based and Upwork invoices --------------------------------
  assert(!!(await localBackend.createInvoice({ client_id: null, basis: 'upwork', amount: 10, due_date: at(5) })).error, 'an Upwork invoice needs a client')
  const upwork = (await localBackend.createInvoice({ client_id: retainer.id, basis: 'upwork', amount: 640, due_date: at(12), stage: 'awaiting' })).data!
  assert(upwork.basis === 'upwork' && upwork.bill_on === null && !upwork.auto_bill && upwork.billed_on === today, 'an Upwork invoice is raised by hand and stamped billed today')
  const retainerRegular = ((await localBackend.listInvoices()).data || []).filter((i) => i.client_id === retainer.id && i.basis === 'client')
  assert(retainerRegular.filter((i) => i.stage === 'pending').length === 0 && retainerRegular.some((i) => i.stage === 'awaiting'), 'an Upwork invoice for a client does not join its regular chain')
  assert(!!(await localBackend.createInvoice({ client_id: null, basis: 'project', amount: 1, due_date: at(5) })).error, 'a project-based invoice needs a project name')
  const project = (await localBackend.createInvoice({ client_id: null, basis: 'project', project_name: '  Website redesign  ', amount: 0, due_date: at(6) })).data!
  assert(project.basis === 'project' && project.client_id === null && project.project_name === 'Website redesign', 'a project-based invoice bills its named project on its own')
  const paidNow = (await localBackend.updateInvoice(project.id, { stage: 'paid' })).data!
  assert(paidNow.paid_on === today && paidNow.billed_on === today, 'confirming payment stamps the paid date, and the billed date if it was missing')
  const reopened = (await localBackend.updateInvoice(project.id, { stage: 'awaiting' })).data!
  assert(reopened.paid_on === null && reopened.billed_on === today, 'undoing a payment clears the paid date and keeps the billed date')
  const reset = (await localBackend.updateInvoice(project.id, { stage: 'pending' })).data!
  assert(reset.billed_on === null && reset.paid_on === null, 'moving back to Pending clears both dates')
  const badStage = (await localBackend.updateInvoice(project.id, { stage: 'bogus' as 'pending' })).data!
  assert(badStage.stage === 'pending', 'an unknown column falls back to Pending')
  assert(!!(await localBackend.updateInvoice(project.id, { amount: -5 })).error === true, 'a negative amount is refused')
  assert(!!(await localBackend.updateInvoice(project.id, { bill_on: 'not-a-date' })).error === false, 'a bill-on date on a project-based invoice is ignored, not stored')
  assert((await localBackend.listInvoices()).data!.find((i) => i.id === project.id)!.bill_on === null, 'and no bill-on date sticks to a project-based invoice')

  // Changing what a regular invoice bills keeps the books straight.
  const changedKind = (await localBackend.updateInvoice(upwork.id, { basis: 'client', bill_on: at(20), auto_bill: false })).data!
  assert(changedKind.basis === 'client' && changedKind.bill_on === at(20) && !changedKind.auto_bill, 'an Upwork invoice can be re-filed as a regular one, switch and all')

  // ---- 5. a deleted client ---------------------------------------------------
  const tempClient = (await localBackend.createClient({ name: 'Verify Basis Ltd', color: 'blue' })).data!
  const tempRegular = (await localBackend.createInvoice({ client_id: tempClient.id, amount: 10, due_date: at(3), bill_on: at(3) })).data!
  const tempUpwork = (await localBackend.createInvoice({ client_id: tempClient.id, basis: 'upwork', amount: 20, due_date: at(3) })).data!
  const tempProject = (await localBackend.createInvoice({ client_id: tempClient.id, basis: 'project', project_name: 'Verify build', amount: 20, due_date: at(3) })).data!
  assert(!(await localBackend.deleteClient(tempClient.id)).error, 'a client used only by invoices can still be deleted')
  const afterClientDelete = (await localBackend.listInvoices()).data || []
  assert(!afterClientDelete.some((i) => i.id === tempRegular.id), 'deleting a client takes its regular invoices off the board')
  assert(!afterClientDelete.some((i) => i.id === tempUpwork.id), 'deleting a client takes its Upwork invoices off the board')
  const survivor = afterClientDelete.find((i) => i.id === tempProject.id)
  assert(!!survivor && survivor.basis === 'project' && survivor.client_id === null && survivor.project_name === 'Verify build', 'a project-based invoice keeps billing its project after the client is deleted')

  // ---- 6. the board: its switch, its lanes and the totals -------------------
  const everything = (await localBackend.listInvoices()).data || []
  const kinds = (['client', 'project', 'upwork'] as const)
  assert(kinds.reduce((sum, k) => sum + board.countInvoicesByBasis(everything, k), 0) === everything.length, 'the three kinds add up to the whole board')
  assert(kinds.every((k) => board.filterInvoicesByBasis(everything, k).every((i) => i.basis === k)), 'each switch position shows only its kind')
  assert(board.filterInvoicesByBasis(everything, 'project').every((i) => !!i.project_name), 'every project-based invoice names its project')
  assert(board.filterInvoicesByBasis(everything, 'client').every((i) => !!i.client_id), 'every regular invoice carries its client')
  mem.delete('wt_invoice_basis_filter')
  assert(board.readInvoiceBasis() === 'client', 'the board opens on regular clients')
  board.writeInvoiceBasis('upwork')
  assert(board.readInvoiceBasis() === 'upwork', 'the chosen kind is remembered for the next visit')
  board.writeInvoiceBasis('all' as 'client')
  assert(board.readInvoiceBasis() === 'client', 'the retired “all” view opens on regular clients')

  const lanes = board.groupInvoicesByStatus(everything, today)
  assert(
    lanes.pending.length + lanes.awaiting.length + lanes.overdue.length + lanes.paid.length === everything.length,
    'every invoice lands in exactly one lane',
  )
  assert(lanes.overdue.every((i) => i.stage !== 'paid' && i.due_date < today), 'the Overdue lane holds only unpaid invoices past their due date')
  assert(lanes.paid.every((i) => i.stage === 'paid'), 'the Paid lane holds only paid invoices')
  const monthOf = today.slice(0, 7)
  const totals = board.monthlyInvoiceTotals(everything, monthOf, today)
  const billedThisMonth = everything.filter((i) => i.billed_on?.startsWith(monthOf)).reduce((sum, i) => sum + i.amount, 0)
  assert(near(totals.billed, billedThisMonth), 'billed this month adds up every kind of invoice')
  assert(near(totals.billedBy.client + totals.billedBy.project + totals.billedBy.upwork, totals.billed), 'the billed breakdown adds up to the total')
  const outstanding = everything.filter((i) => i.stage === 'awaiting' || lanes.overdue.includes(i))
  assert(totals.outstandingCount === outstanding.length && near(totals.outstanding, outstanding.reduce((s, i) => s + i.amount, 0)), 'outstanding is every invoice awaiting payment, overdue ones included')
  assert(totals.overdueCount === lanes.overdue.length, 'the overdue count matches the Overdue lane')
  const paidThisMonth = everything.filter((i) => i.stage === 'paid' && i.paid_on?.startsWith(monthOf))
  assert(totals.paidCount === paidThisMonth.length && near(totals.paid, paidThisMonth.reduce((s, i) => s + i.amount, 0)), 'paid this month counts the payments confirmed in it')
  assert(board.shiftMonth('2026-01', -1) === '2025-12' && board.shiftMonth('2026-12', 1) === '2027-01', 'the month stepper rolls over the year')

  // ---- 6b. the board by month: each month starts from zero ---------------
  const inv = (over: Record<string, unknown>) =>
    ({
      id: `m-${Math.random().toString(36).slice(2, 8)}`, basis: 'upwork', client_id: null, project_name: null,
      amount: 100, due_date: '2026-10-15', stage: 'pending', notes: null, bill_on: null, auto_bill: false,
      auto_billed: false, billed_on: null, paid_on: null, created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
      ...over,
    }) as unknown as import('../src/lib/types').Invoice
  const dueNextMonth = inv({ due_date: '2026-11-15', stage: 'pending' })
  const carriedFromAugust = inv({ due_date: '2026-08-15', stage: 'awaiting', billed_on: '2026-08-01' })
  const paidInSeptember = inv({ due_date: '2026-08-20', stage: 'paid', billed_on: '2026-08-01', paid_on: '2026-09-04' })
  const dueThisMonthPaid = inv({ due_date: '2026-10-20', stage: 'paid', billed_on: '2026-10-01', paid_on: '2026-10-03' })
  const dueThisMonthOpen = inv({ due_date: '2026-10-25', stage: 'awaiting', billed_on: '2026-10-02' })
  const lot = [dueNextMonth, carriedFromAugust, paidInSeptember, dueThisMonthPaid, dueThisMonthOpen]
  const onOct = board.invoicesOnMonthBoard(lot, '2026-10').map((i) => i.id)
  const onSep = board.invoicesOnMonthBoard(lot, '2026-09').map((i) => i.id)
  const onNov = board.invoicesOnMonthBoard(lot, '2026-11').map((i) => i.id)
  assert(!onOct.includes(dueNextMonth.id) && onNov.includes(dueNextMonth.id), 'an invoice due next month is on next month\'s board, not this one')
  assert(onOct.includes(carriedFromAugust.id) && onNov.includes(carriedFromAugust.id), 'an invoice still owed from August is carried onto October and November')
  assert(!onOct.includes(paidInSeptember.id) && onSep.includes(paidInSeptember.id), 'an invoice paid in September belongs to September\'s board')
  assert(onOct.includes(dueThisMonthPaid.id) && onOct.includes(dueThisMonthOpen.id), 'October\'s own invoices, paid or open, are on October\'s board')
  assert(board.invoiceOnMonthBoard(dueNextMonth, 'all'), 'all months keeps every invoice')

  const octTotals = board.monthlyInvoiceTotals(lot, '2026-10', '2026-10-09')
  assert(octTotals.dueCount === 2 && octTotals.dueSettledCount === 1, 'October: two invoices fall due, one of them settled')
  assert(octTotals.paidCount === 1 && near(octTotals.paid, 100), 'October: one payment confirmed in October')
  assert(octTotals.billedCount === 2 && near(octTotals.billed, 200), 'October: two invoices billed in October')
  assert(octTotals.outstandingCount === 2 && octTotals.carriedCount === 1, 'October: two still owed by month end, one of them carried over from August')
  const novTotals = board.monthlyInvoiceTotals(lot, '2026-11', '2026-10-09')
  assert(novTotals.billedCount === 0 && novTotals.paidCount === 0 && novTotals.dueCount === 1, 'a new month starts at zero for billing and payments')
  assert(novTotals.outstandingCount === 2 && novTotals.carriedCount === 2, 'November still carries what is owed from before it (the pending invoice due in November is not owed yet)')
  assert(
    board.monthlyInvoiceTotals(lot, '2026-09', '2026-10-09').paidCount === 1 && board.monthlyInvoiceTotals(lot, '2026-09', '2026-10-09').outstandingCount === 1,
    'September, looked at afterwards: the invoice paid that month is counted as paid and the one still owed is counted',
  )
  assert(board.invoiceMonthOptions(lot, '2026-10-09').join(',') === '2026-11,2026-10,2026-09,2026-08', 'the month chooser covers every month from the first record to the latest')

  // The seeded board, by month: every invoice belongs to a month it was due in or
  // was settled in, and every open invoice due by a month is on that month's board.
  const months = board.invoiceMonthOptions(everything, today)
  assert(months.length > 0 && months[0] >= monthOf && months.includes(monthOf), 'the chooser offers this month and every month with invoices')
  const carryMismatches = months.filter((m) => {
    const openShown = board.invoicesOnMonthBoard(everything, m).filter((i) => i.stage !== 'paid').length
    const openDueBy = everything.filter((i) => i.stage !== 'paid' && i.due_date.slice(0, 7) <= m).length
    return openShown !== openDueBy
  })
  assert(carryMismatches.length === 0, 'each month\'s board carries every open invoice due by then')
  const everyMonthSum = months.reduce((sum, m) => sum + board.monthlyInvoiceTotals(everything, m, today).dueCount, 0)
  assert(everyMonthSum === everything.filter((i) => months.includes(i.due_date.slice(0, 7))).length, 'every invoice is due in exactly one month of the chooser')

  // ---- 7. a plain worker is refused at the backend ------------------------
  const plain = (await localBackend.createWorker({
    name: 'Invoice Ida',
    hourly_rate: 16,
    accountEmail: 'ida@example.com',
    accountPassword: 'worker123',
  })).data!
  await localBackend.signOut()
  await localBackend.signIn('ida@example.com', 'worker123')
  assert(!!(await localBackend.listInvoices()).error, 'an ungranted worker cannot read the board')
  assert(!!(await localBackend.createInvoice({ client_id: retainer.id, amount: 10, due_date: at(1) })).error, 'an ungranted worker cannot raise an invoice')
  assert(!!(await localBackend.updateInvoice(everything[0].id, { stage: 'paid' })).error, 'an ungranted worker cannot drag an invoice')
  assert(!!(await localBackend.deleteInvoice(everything[0].id)).error, 'an ungranted worker cannot delete an invoice')

  // ---- 8. a granted worker shares the admin's board ------------------------
  await localBackend.signOut()
  await localBackend.signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  const adminCount = ((await localBackend.listInvoices()).data || []).length
  await localBackend.updateWorker(plain.id, { permissions: ['invoices.view'] })
  await localBackend.signOut()
  await localBackend.signIn('ida@example.com', 'worker123')
  const granted = (await localBackend.listInvoices()).data || []
  assert(granted.length === adminCount, 'a granted worker reads the same board')
  const workerCreated = (await localBackend.createInvoice({ client_id: retainer.id, basis: 'upwork', amount: 77, due_date: at(2) })).data!
  assert(!!workerCreated, 'a granted worker can raise invoices')
  const workerMoved = (await localBackend.updateInvoice(workerCreated.id, { stage: 'paid' })).data!
  assert(workerMoved.stage === 'paid' && workerMoved.paid_on === today, 'a granted worker can move invoices between columns, and the dates follow')
  assert(!(await localBackend.deleteInvoice(workerCreated.id)).error, 'a granted worker can delete invoices')

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
