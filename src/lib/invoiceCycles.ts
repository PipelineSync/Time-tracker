/**
 * The client invoicing rules, shared by both backends and the board.
 *
 * Pure functions only — no storage, no network — so the local and the Supabase
 * backends apply exactly the same rules, and the verification script can drive
 * them with fixed dates. Dates are local 'YYYY-MM-DD' strings; plain string
 * comparison orders them correctly.
 *
 * Regular clients (basis 'client') are the only recurring invoices:
 *  - each carries a bill-on date (its monthly cycle) and the client's auto-bill
 *    switch, which every regular invoice of that client shares;
 *  - while the switch is on, a pending cycle whose bill-on date has arrived is
 *    raised: it goes out (Awaiting, billed on that date) and the next monthly
 *    cycle is queued behind it as Pending;
 *  - a cycle is queued only when the client has no open cycle, so deleting a
 *    queued invoice does not bring it straight back;
 *  - nothing is back-billed: switching auto-bill on skips the cycles that have
 *    already passed. They stay Pending for you to bill by hand.
 */
import { advanceCycle } from './finance'
import type { Invoice, InvoiceBasis, InvoiceStage, InvoiceStatus } from './types'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** True for a real calendar date written 'YYYY-MM-DD'. */
export function isISODate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  return !Number.isNaN(new Date(`${value}T00:00:00`).getTime())
}

/** The value when it is a calendar date, otherwise null. */
export function dateOrNull(value: unknown): string | null {
  return isISODate(value) ? value : null
}

/** Unknown stages (legacy or hand-edited rows) fall back to Pending. */
export function normalizeInvoiceStage(stage: unknown): InvoiceStage {
  return stage === 'awaiting' || stage === 'paid' ? stage : 'pending'
}

/** Unknown bases fall back to a regular client — what every invoice was before the choice existed. */
export function normalizeInvoiceBasis(basis: unknown): InvoiceBasis {
  return basis === 'project' || basis === 'upwork' ? basis : 'client'
}

/**
 * The board lane an invoice shows in: its stage, except that an invoice still
 * unpaid past its due date is Overdue. Paid invoices are never overdue.
 */
export function invoiceStatus(stage: InvoiceStage, dueDate: string, today: string): InvoiceStatus {
  if (stage === 'paid') return 'paid'
  if (dueDate < today) return 'overdue'
  return stage
}

/**
 * The dates a stage change stamps. First billing stamps the billed day (today
 * unless the caller already knows it); confirming payment stamps the paid day
 * and also the billed day if it is still missing; moving back to Pending
 * clears both. Moving back one column (undoing a payment) keeps the billed day.
 */
export function stampsForStage(
  current: { stage: InvoiceStage; billed_on: string | null; paid_on: string | null },
  stage: InvoiceStage,
  today: string,
): { billed_on: string | null; paid_on: string | null } {
  if (stage === current.stage) return { billed_on: current.billed_on, paid_on: current.paid_on }
  if (stage === 'pending') return { billed_on: null, paid_on: null }
  if (stage === 'awaiting') return { billed_on: current.billed_on ?? today, paid_on: null }
  return { billed_on: current.billed_on ?? today, paid_on: today }
}

/** A regular invoice's cycle dates. */
export interface CycleDates {
  bill_on: string
  due_date: string
}

/**
 * The cycle one month after a regular invoice's — its bill-on date and its due
 * date both move on a month (the day is clamped to the month's end). With
 * `after`, keeps stepping until the bill-on date is later than that day, which
 * is how a cycle is picked up once the time has passed.
 */
export function nextCycle(from: { bill_on: string | null; due_date: string }, after: string | null): CycleDates {
  let bill_on = advanceCycle(from.bill_on ?? from.due_date, 'monthly')
  let due_date = advanceCycle(from.due_date, 'monthly')
  if (after !== null) {
    while (bill_on <= after) {
      bill_on = advanceCycle(bill_on, 'monthly')
      due_date = advanceCycle(due_date, 'monthly')
    }
  }
  return { bill_on, due_date }
}

/** The columns a create or edit stores — a row without its id and timestamps. */
export type InvoiceRowValues = Omit<Invoice, 'id' | 'created_at' | 'updated_at'>

/** What a create or edit asks for. On an edit an absent field keeps its stored value. */
export interface InvoiceWriteInput {
  client_id?: string | null
  basis?: string
  project_name?: string | null
  amount?: number | string
  due_date?: string
  stage?: string
  notes?: string | null
  bill_on?: string | null
  auto_bill?: boolean
}

/** What the rules need to know about the client's other regular invoices. */
export interface InvoiceWriteContext {
  /** The day the write happens, local 'YYYY-MM-DD'. */
  today: string
  /** The auto-bill switch the client's other regular invoices carry; null when there are none. */
  chainAutoBill: boolean | null
  /** The client already has a regular invoice waiting to be billed (Pending). */
  clientHasPendingRegular: boolean
}

export type InvoiceWriteResult =
  | { ok: false; error: string }
  | {
      ok: true
      row: InvoiceRowValues
      /** Set when the write states the client's auto-bill switch: every regular invoice of the client takes it. */
      mirrorAutoBill: boolean | null
      /** Auto-bill was just switched on for this invoice's client. */
      resumed: boolean
      /** A regular invoice under auto-bill just went from Pending to billed or paid. */
      billed: boolean
    }

/**
 * Validate and resolve a create or edit into the values to store. `current`
 * is the stored invoice for an edit, or null for a new one.
 */
export function resolveInvoiceWrite(
  current: Invoice | null,
  input: InvoiceWriteInput,
  ctx: InvoiceWriteContext,
): InvoiceWriteResult {
  const basis = normalizeInvoiceBasis(input.basis ?? current?.basis)
  const regular = basis === 'client'
  const clientId = (input.client_id !== undefined ? input.client_id : current?.client_id) || null
  if (basis !== 'project' && !clientId) return { ok: false, error: 'Pick a client to bill.' }

  const projectInput = input.project_name !== undefined ? input.project_name : current?.project_name
  const projectName = basis === 'project' && typeof projectInput === 'string' && projectInput.trim() ? projectInput.trim() : null
  if (basis === 'project' && !projectName) return { ok: false, error: 'Name the project this invoice bills.' }

  const amountInput = input.amount !== undefined ? Number(input.amount) : (current?.amount ?? 0)
  if (!Number.isFinite(amountInput) || amountInput < 0) {
    return { ok: false, error: 'Give the invoice a valid amount — or leave it at zero while the figure is unknown.' }
  }
  const amount = Math.round(amountInput * 100) / 100

  const dueDate = input.due_date !== undefined ? input.due_date : current?.due_date
  if (!isISODate(dueDate)) return { ok: false, error: 'Pick the date payment is due.' }

  const stage = normalizeInvoiceStage(input.stage !== undefined ? input.stage : current?.stage)
  const notesInput = input.notes !== undefined ? input.notes : current?.notes
  const notes = typeof notesInput === 'string' && notesInput.trim() ? notesInput.trim() : null

  // Moving an invoice to another client, or into a regular chain, makes it a
  // new cycle of that chain: it starts unhandled and takes the chain's switch.
  const joinsChain = regular && (current === null || current.basis !== 'client' || clientId !== current.client_id)

  if (regular && current === null && ctx.clientHasPendingRegular && stage === 'pending') {
    return { ok: false, error: 'This client already has a regular invoice waiting to be billed. Bill or edit that one first.' }
  }

  let billOn: string | null = null
  let autoBill = false
  let mirrorAutoBill: boolean | null = null
  if (regular) {
    if (input.bill_on !== undefined && input.bill_on !== null && !isISODate(input.bill_on)) {
      return { ok: false, error: 'Pick the day this invoice is billed.' }
    }
    const explicitBillOn = dateOrNull(input.bill_on)
    if (explicitBillOn) billOn = explicitBillOn
    else if (current !== null && !joinsChain) billOn = dateOrNull(current.bill_on) ?? ctx.today
    else billOn = ctx.today

    if (input.auto_bill !== undefined) {
      autoBill = input.auto_bill === true
      mirrorAutoBill = autoBill
    } else if (current !== null && !joinsChain) {
      autoBill = current.auto_bill
    } else {
      autoBill = ctx.chainAutoBill ?? true
    }
  }

  const wasPending = current === null || current.stage === 'pending'
  const billed = regular && autoBill && wasPending && stage !== 'pending'
  // Handled means auto-bill is done with this cycle: it raised it, skipped it,
  // or it was billed while the switch was on. A handled cycle is never raised
  // again, so undoing it to Pending stays a manual call.
  const autoBilled = regular && (billed || (current !== null && !joinsChain && billOn === current.bill_on && current.auto_billed))

  const stamps = stampsForStage(current ?? { stage: 'pending', billed_on: null, paid_on: null }, stage, ctx.today)
  const row: InvoiceRowValues = {
    client_id: clientId,
    basis,
    project_name: projectName,
    amount,
    due_date: dueDate,
    stage,
    notes,
    bill_on: billOn,
    auto_bill: autoBill,
    auto_billed: autoBilled,
    billed_on: stamps.billed_on,
    paid_on: stamps.paid_on,
  }

  const wasAutoOnHere = current !== null && current.basis === 'client' && current.client_id === clientId && current.auto_bill
  const resumed = current !== null && regular && autoBill && !wasAutoOnHere
  return { ok: true, row, mirrorAutoBill, resumed, billed }
}

/** The rows with every regular invoice of one client carrying the same auto-bill switch. */
export function withChainAutoBill(rows: Invoice[], clientId: string, autoBill: boolean): Invoice[] {
  return rows.map((r) => (r.basis === 'client' && r.client_id === clientId && r.auto_bill !== autoBill ? { ...r, auto_bill: autoBill } : r))
}

/** What the backends must do with the auto-bill rules next. */
export type AutoBillTrigger =
  /** Every load and refresh: raise whatever cycle has come due. */
  | { kind: 'sweep' }
  /** A regular invoice under auto-bill was just billed or paid by hand. */
  | { kind: 'billed'; id: string }
  /** Auto-bill was just switched on for a client. */
  | { kind: 'resumed'; clientId: string }

/** One write the planner asks for. Inserts come before updates within a step. */
export type AutoBillOp =
  | { kind: 'insert'; row: InvoiceRowValues }
  | { kind: 'update'; id: string; patch: Partial<Pick<Invoice, 'stage' | 'billed_on' | 'auto_billed'>> }

/** A regular invoice whose cycle is still open: pending, and auto-bill has not handled it yet. */
function isOpenCycle(r: Invoice): boolean {
  return r.basis === 'client' && r.stage === 'pending' && !r.auto_billed
}

/** An open cycle that auto-bill should raise today or earlier. */
function isDueForAutoBill(r: Invoice, today: string): boolean {
  return isOpenCycle(r) && r.auto_bill && r.bill_on !== null && r.bill_on <= today
}

function byCycle(a: Invoice, b: Invoice): number {
  return (a.bill_on ?? '').localeCompare(b.bill_on ?? '') || a.created_at.localeCompare(b.created_at)
}

/** The client's newest billed (Awaiting or Paid) regular invoice, if any. */
function newestBilled(rows: Invoice[], clientId: string): Invoice | null {
  let best: Invoice | null = null
  for (const r of rows) {
    if (r.basis !== 'client' || r.client_id !== clientId || r.stage === 'pending' || r.bill_on === null) continue
    if (best === null || r.bill_on > (best.bill_on ?? '') || (r.bill_on === best.bill_on && r.created_at > best.created_at)) best = r
  }
  return best
}

/**
 * Queue the cycle after `from` as Pending — unless the client already has an
 * open cycle, or that cycle is already queued. `after` picks the first cycle
 * strictly later than that day; null steps exactly one month on.
 */
function queueNext(from: Invoice, rows: Invoice[], after: string | null): AutoBillOp[] {
  const chain = rows.filter((r) => r.basis === 'client' && r.client_id === from.client_id && r.id !== from.id)
  if (chain.some(isOpenCycle)) return []
  const cycle = nextCycle(from, after)
  // The database refuses two pending cycles on the same day; never ask for one.
  if (chain.some((r) => r.stage === 'pending' && r.bill_on === cycle.bill_on)) return []
  const row: InvoiceRowValues = {
    client_id: from.client_id,
    basis: 'client',
    project_name: null,
    amount: from.amount,
    due_date: cycle.due_date,
    stage: 'pending',
    notes: null,
    bill_on: cycle.bill_on,
    auto_bill: true,
    auto_billed: false,
    billed_on: null,
    paid_on: null,
  }
  return [{ kind: 'insert', row }]
}

/**
 * The writes one trigger needs, given the rows as they stand. Backends apply
 * the returned writes, then ask again until nothing is returned — each pass
 * settles one step, so a catch-up after a long absence takes several passes.
 */
export function planAutoBill(rows: Invoice[], today: string, trigger: AutoBillTrigger): AutoBillOp[] {
  if (trigger.kind === 'sweep') {
    const due = rows.filter((r) => isDueForAutoBill(r, today)).sort(byCycle)[0]
    if (!due) return []
    // Catch-up: the next cycle is one month on, even if that is still due —
    // the next pass raises it in turn. Queued first, so a write that stops
    // halfway leaves the cycle still due and never queued twice.
    const queue = queueNext(due, rows, null)
    const raise: AutoBillOp = { kind: 'update', id: due.id, patch: { stage: 'awaiting', billed_on: due.bill_on, auto_billed: true } }
    return [...queue, raise]
  }

  if (trigger.kind === 'billed') {
    const row = rows.find((r) => r.id === trigger.id)
    if (!row || row.basis !== 'client' || !row.auto_bill || row.stage === 'pending') return []
    return queueNext(row, rows, today)
  }

  // Switched on: nothing back-bills. Cycles already past are marked handled
  // (left Pending for a hand bill), and the chain picks up from the first
  // cycle after today.
  const skip = rows.filter(
    (r) => r.basis === 'client' && r.client_id === trigger.clientId && isOpenCycle(r) && r.bill_on !== null && r.bill_on <= today,
  )
  const skipIds = new Set(skip.map((r) => r.id))
  const after = rows.map((r) => (skipIds.has(r.id) ? { ...r, auto_billed: true } : r))
  const ops: AutoBillOp[] = skip.map((r) => ({ kind: 'update', id: r.id, patch: { auto_billed: true } }))
  const head = newestBilled(after, trigger.clientId)
  if (head && head.auto_bill) ops.push(...queueNext(head, after, today))
  return ops
}
