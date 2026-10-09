/**
 * Verification of the client invoicing section against the Supabase backend
 * (the REAL src/lib/supabaseDb.ts, pointed at the in-memory mock client):
 *  - a regular client's cycle is raised by auto-bill and the next month queued
 *  - the auto-bill switch is shared along the client's regular invoices
 *  - a raised cycle moved back by hand stays where it was put; a deleted
 *    queued cycle stays deleted
 *  - a lapsed chain catches up; switching auto-bill back on never back-bills
 *  - Upwork and project-based invoices are raised by hand; dates are stamped
 *  - a deleted client takes its regular and Upwork invoices, not its projects
 *  - a database without the newest migration says what to run, plainly
 * Run: npx tsx scripts/verify-invoices-supabase.ts
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { state, resetState } from './supabase-mock/mock-supabase.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcFile = path.join(root, 'src', 'lib', 'supabaseDb.ts')
const tmpFile = path.join(root, 'src', 'lib', '__test_supabaseDb_invoices_tmp.ts')

// Load the REAL module source with two substitutions:
//  - Vite's import.meta.env → a global we control
//  - @supabase/supabase-js  → our mock client
let mod: typeof import('../src/lib/supabaseDb')
try {
  const source = readFileSync(srcFile, 'utf8')
    .replaceAll('import.meta.env', 'globalThis.__VITE_ENV__')
    .replaceAll(`from '@supabase/supabase-js'`, `from '../../scripts/supabase-mock/mock-supabase.mjs'`)
  writeFileSync(tmpFile, source)
  globalThis.__VITE_ENV__ = {
    VITE_SUPABASE_URL: 'https://mock.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'mock-pub-key',
  }
  mod = await import('../src/lib/__test_supabaseDb_invoices_tmp')
} finally {
  rmSync(tmpFile, { force: true })
}
const { supabaseBackend } = mod

const DAY = 86_400_000
const { toISODate, advanceCycle } = await import('../src/lib/finance')
const at = (offset: number) => toISODate(new Date(Date.now() + offset * DAY))
const today = at(0)
const plus = (iso: string) => advanceCycle(iso, 'monthly')

globalThis.fetch = async (url) => {
  const entry = Object.entries(state.fetchHandlers).find(([k]) => String(url).includes(k))
  if (!entry) throw new Error(`No fetch handler for ${url}`)
  const { status = 200, body = {} } = entry[1](url)
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

const ADMIN = { id: 'user-admin', email: 'admin@x.com', password: 'admin123' }

function seedWorkspace() {
  resetState()
  state.users = [{ id: ADMIN.id, email: ADMIN.email, password: ADMIN.password }]
  state.profiles = [{ user_id: ADMIN.id, role: 'admin', worker_id: null }]
  state.workers = []
  state.fetchHandlers['sync-worker-profile'] = () => ({ status: 404, body: { error: 'no match' } })
}

async function main() {
  seedWorkspace()
  const admin = await supabaseBackend.signIn(ADMIN.email, ADMIN.password)
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')
  assert(((await supabaseBackend.listInvoices()).data || []).length === 0, 'the board starts empty')

  const retainer = (await supabaseBackend.createClient({ name: 'Retainer Co', color: 'blue' })).data!

  // ---- a regular client's chain --------------------------------------------
  const first = await supabaseBackend.createInvoice({ client_id: retainer.id, basis: 'client', amount: 500, due_date: at(14), bill_on: at(3) })
  assert(!first.error && first.data!.auto_bill && first.data!.bill_on === at(3), 'a new regular invoice starts on auto-bill, billed on its bill-on date')
  assert(!!(await supabaseBackend.createInvoice({ client_id: retainer.id, basis: 'client', amount: 1, due_date: at(14), bill_on: at(9) })).error, 'a second pending regular invoice for the same client is refused')

  const billed = await supabaseBackend.updateInvoice(first.data!.id, { stage: 'awaiting' })
  assert(!billed.error && billed.data!.stage === 'awaiting' && billed.data!.billed_on === today, 'billing by hand stamps the billed date')
  let chain = ((await supabaseBackend.listInvoices()).data || []).filter((i) => i.client_id === retainer.id)
  const queued = chain.find((i) => i.stage === 'pending')
  assert(
    !!queued && queued.bill_on === plus(at(3)) && queued.due_date === plus(at(14)) && queued.amount === 500 && queued.auto_bill && queued.notes === null,
    'billing queues next month, with the same amount and switch',
  )

  const off = await supabaseBackend.updateInvoice(queued!.id, { auto_bill: false })
  chain = ((await supabaseBackend.listInvoices()).data || []).filter((i) => i.client_id === retainer.id)
  assert(!off.error && !off.data!.auto_bill && chain.every((i) => !i.auto_bill), 'the auto-bill switch is shared along the client’s regular invoices')
  const on = await supabaseBackend.updateInvoice(queued!.id, { auto_bill: true })
  chain = ((await supabaseBackend.listInvoices()).data || []).filter((i) => i.client_id === retainer.id)
  assert(!on.error && chain.every((i) => i.auto_bill) && chain.filter((i) => i.stage === 'pending').length === 1, 'switching back on keeps one queued cycle')

  assert(!(await supabaseBackend.deleteInvoice(queued!.id)).error, 'a queued cycle can be deleted')
  chain = ((await supabaseBackend.listInvoices()).data || []).filter((i) => i.client_id === retainer.id)
  assert(!chain.some((i) => i.stage === 'pending'), 'deleting a queued cycle does not bring it straight back')

  // ---- a cycle that comes due is raised; moving it back by hand sticks -----
  const dueClient = (await supabaseBackend.createClient({ name: 'Due Co', color: 'amber' })).data!
  const raised = await supabaseBackend.createInvoice({ client_id: dueClient.id, amount: 300, due_date: at(10), bill_on: at(-1) })
  assert(!raised.error && raised.data!.stage === 'awaiting' && raised.data!.billed_on === at(-1) && raised.data!.auto_billed, 'a cycle whose bill-on date has come is raised on the spot, billed on that date')
  let dueChain = ((await supabaseBackend.listInvoices()).data || []).filter((i) => i.client_id === dueClient.id)
  assert(dueChain.some((i) => i.stage === 'pending' && i.bill_on === plus(at(-1))), 'the next cycle is queued behind it')
  const undone = await supabaseBackend.updateInvoice(raised.data!.id, { stage: 'pending' })
  assert(!undone.error && undone.data!.stage === 'pending' && undone.data!.billed_on === null, 'moving it back to Pending clears its billed date')
  dueChain = ((await supabaseBackend.listInvoices()).data || []).filter((i) => i.client_id === dueClient.id)
  assert(dueChain.find((i) => i.id === raised.data!.id)?.stage === 'pending', 'auto-bill does not raise the undone cycle again')

  // ---- a lapsed chain catches up -------------------------------------------
  const lapsed = (await supabaseBackend.createClient({ name: 'Catch-up Ltd', color: 'violet' })).data!
  const lapsedFirst = await supabaseBackend.createInvoice({ client_id: lapsed.id, amount: 200, due_date: at(-26), bill_on: at(-40) })
  assert(!lapsedFirst.error, 'a lapsed chain can be started')
  const lapsedChain = ((await supabaseBackend.listInvoices()).data || []).filter((i) => i.client_id === lapsed.id)
  assert(lapsedChain.filter((i) => i.stage === 'awaiting').length === 2, 'every cycle that came round while the app was away is raised')
  assert(lapsedChain.filter((i) => i.stage === 'pending').length === 1 && lapsedChain.find((i) => i.stage === 'pending')!.bill_on! > today, 'and one cycle stays queued for the future')

  // ---- switching on never back-bills --------------------------------------
  const parked = (await supabaseBackend.createClient({ name: 'Paused Ltd', color: 'rose' })).data!
  const parkedCycle = await supabaseBackend.createInvoice({ client_id: parked.id, amount: 90, due_date: at(9), bill_on: at(-5), auto_bill: false })
  assert(!parkedCycle.error && parkedCycle.data!.stage === 'pending' && !parkedCycle.data!.auto_bill, 'a cycle created with auto-bill off waits for a hand bill')
  const resumed = await supabaseBackend.updateInvoice(parkedCycle.data!.id, { auto_bill: true })
  assert(!resumed.error && resumed.data!.stage === 'pending' && resumed.data!.auto_billed && resumed.data!.billed_on === null, 'switching auto-bill on leaves the passed cycle for a hand bill')
  assert(((await supabaseBackend.listInvoices()).data || []).filter((i) => i.client_id === parked.id).length === 1, 'and queues nothing behind it')

  // ---- Upwork and project-based invoices -----------------------------------
  assert(!!(await supabaseBackend.createInvoice({ client_id: null, basis: 'upwork', amount: 10, due_date: at(5) })).error, 'an Upwork invoice needs a client')
  const upwork = await supabaseBackend.createInvoice({ client_id: retainer.id, basis: 'upwork', amount: 640, due_date: at(12), stage: 'awaiting' })
  assert(!upwork.error && upwork.data!.basis === 'upwork' && upwork.data!.bill_on === null && !upwork.data!.auto_bill && upwork.data!.billed_on === today, 'an Upwork invoice is raised by hand and stamped billed today')
  assert(!!(await supabaseBackend.createInvoice({ client_id: null, basis: 'project', amount: 1, due_date: at(5) })).error, 'a project-based invoice needs a project name')
  const project = await supabaseBackend.createInvoice({ client_id: null, basis: 'project', project_name: ' Website redesign ', amount: 0, due_date: at(6) })
  assert(!project.error && project.data!.project_name === 'Website redesign' && project.data!.client_id === null, 'a project-based invoice bills its named project on its own')
  const paid = await supabaseBackend.updateInvoice(project.data!.id, { stage: 'paid' })
  assert(!paid.error && paid.data!.paid_on === today && paid.data!.billed_on === today, 'confirming payment stamps the paid date, and the billed date if it was missing')
  const reopened = await supabaseBackend.updateInvoice(project.data!.id, { stage: 'awaiting' })
  assert(!reopened.error && reopened.data!.paid_on === null && reopened.data!.billed_on === today, 'undoing a payment clears the paid date and keeps the billed date')
  const reset = await supabaseBackend.updateInvoice(project.data!.id, { stage: 'pending' })
  assert(!reset.error && reset.data!.billed_on === null && reset.data!.paid_on === null, 'moving back to Pending clears both dates')
  const billOnIgnored = await supabaseBackend.updateInvoice(project.data!.id, { bill_on: at(3) })
  assert(!billOnIgnored.error && billOnIgnored.data!.bill_on === null, 'a project-based invoice carries no bill-on date')

  // ---- a deleted client ----------------------------------------------------
  const temp = (await supabaseBackend.createClient({ name: 'Basis Ltd', color: 'blue' })).data!
  const tempRegular = await supabaseBackend.createInvoice({ client_id: temp.id, amount: 10, due_date: at(3), bill_on: at(3) })
  const tempUpwork = await supabaseBackend.createInvoice({ client_id: temp.id, basis: 'upwork', amount: 20, due_date: at(3) })
  const tempProject = await supabaseBackend.createInvoice({ client_id: temp.id, basis: 'project', project_name: 'Verify build', amount: 20, due_date: at(3) })
  assert(!tempRegular.error && !tempUpwork.error && !tempProject.error, 'invoices for a client to be deleted are raised')
  assert(!(await supabaseBackend.deleteClient(temp.id)).error, 'the client is deleted')
  const afterDelete = ((await supabaseBackend.listInvoices()).data || [])
  assert(!afterDelete.some((i) => i.id === tempRegular.data!.id) && !afterDelete.some((i) => i.id === tempUpwork.data!.id), 'deleting a client takes its regular and Upwork invoices off the board')
  const survivor = afterDelete.find((i) => i.id === tempProject.data!.id)
  assert(!!survivor && survivor.basis === 'project' && survivor.client_id === null && survivor.project_name === 'Verify build', 'a project-based invoice keeps billing its project')

  // ---- a database without the newest migration ----------------------------
  state.invoiceAutoBillColumnsMissing = true
  const stale = await supabaseBackend.listInvoices()
  assert(!!stale.error && /newest supabase\/client-invoicing\.sql/.test(stale.error), 'an older database is told to run the newest client-invoicing.sql')
  state.invoiceAutoBillColumnsMissing = false
  assert(!(await supabaseBackend.listInvoices()).error, 'and the board reads again once the migration is in')

  await supabaseBackend.signOut()
  console.log(failures === 0 ? '\nDone.' : `\n${failures} check(s) failed.`)
  if (failures > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
