/**
 * The client invoicing rules the connector applies to a write.
 *
 * A copy of the parts of src/lib/invoiceCycles.ts and src/lib/finance.ts
 * (advanceCycle, monthly) that a create or an update needs: the dates a stage
 * change stamps, the successor a billed regular invoice queues, the auto-bill
 * sweep that raises a due cycle, and the status the board shows. Duplicated
 * rather than imported so the functions bundle stays independent of the app
 * source, the same arrangement as time.ts and computeTotalMinutes().
 *
 * scripts/verify-mcp-connector.ts drives these through the real handlers, so
 * keep the two in step: a change to the app's rules needs the same change here.
 */

export type InvoiceBasis = 'client' | 'project' | 'upwork'
export type InvoiceStage = 'pending' | 'awaiting' | 'paid'
export type InvoiceStatus = InvoiceStage | 'overdue'

/** One invoice row as the connector reads it. */
export interface StoredInvoice {
  id: string
  client_id: string | null
  basis: InvoiceBasis
  project_name: string | null
  amount: number
  due_date: string
  stage: InvoiceStage
  notes: string | null
  bill_on: string | null
  auto_bill: boolean
  auto_billed: boolean
  billed_on: string | null
  paid_on: string | null
  created_at: string
}

/** The columns an insert stores. */
export type InvoiceInsert = Omit<StoredInvoice, 'id' | 'created_at'>

/**
 * One calendar month on, the day clamped to that month's end (Jan 31 → Feb 28).
 * Pure calendar arithmetic on the date string, so the server's timezone does
 * not move it.
 */
export function addMonth(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  // Date.UTC takes a 0-based month, so `month` here is the month after the
  // date's own month; day 0 of the month after that is the last day of it.
  const next = new Date(Date.UTC(year, month, 1))
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  next.setUTCDate(Math.min(day, lastDay))
  return next.toISOString().slice(0, 10)
}

/** Overdue is derived: an unpaid invoice past its due date. A paid one never is. */
export function invoiceStatus(stage: InvoiceStage, dueDate: string, today: string): InvoiceStatus {
  if (stage === 'paid') return 'paid'
  if (dueDate < today) return 'overdue'
  return stage
}

/**
 * The billed and paid dates a stage change leaves behind. First billing stamps
 * the billed day; confirming payment stamps the paid day and the billed day if
 * it is still missing; moving back to Pending clears both.
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

/**
 * The cycle one month after a regular invoice's: its bill-on date and its due
 * date both move on a month. With `after`, keeps stepping until the bill-on
 * date is later than that day.
 */
function nextCycle(from: { bill_on: string | null; due_date: string }, after: string | null) {
  let billOn = addMonth(from.bill_on ?? from.due_date)
  let dueDate = addMonth(from.due_date)
  if (after !== null) {
    while (billOn <= after) {
      billOn = addMonth(billOn)
      dueDate = addMonth(dueDate)
    }
  }
  return { bill_on: billOn, due_date: dueDate }
}

/** A regular invoice whose cycle is still open: pending, and auto-bill has not handled it. */
function isOpenCycle(row: StoredInvoice): boolean {
  return row.basis === 'client' && row.stage === 'pending' && !row.auto_billed
}

function byCycle(a: StoredInvoice, b: StoredInvoice): number {
  return (a.bill_on ?? '').localeCompare(b.bill_on ?? '') || a.created_at.localeCompare(b.created_at)
}

/**
 * The successor to a regular invoice that was just billed or paid under
 * auto-bill: the next monthly cycle, Pending, same amount and switch, no notes.
 * Nothing is queued while the client already has an open cycle, or when that
 * cycle is already queued. `after` picks the first cycle later than that day.
 */
function successorFor(from: StoredInvoice, rows: StoredInvoice[], after: string | null): InvoiceInsert | null {
  const chain = rows.filter((r) => r.basis === 'client' && r.client_id === from.client_id && r.id !== from.id)
  if (chain.some(isOpenCycle)) return null
  const cycle = nextCycle(from, after)
  // The database refuses two pending cycles on the same day; never ask for one.
  if (chain.some((r) => r.stage === 'pending' && r.bill_on === cycle.bill_on)) return null
  return {
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
}

/** The successor a regular invoice queues when it is billed or paid under auto-bill. */
export function successorOnBilling(billed: StoredInvoice, chainRows: StoredInvoice[], today: string): InvoiceInsert | null {
  if (billed.basis !== 'client' || !billed.auto_bill || billed.stage === 'pending' || billed.client_id === null) return null
  return successorFor(billed, chainRows, today)
}

/** One write the sweep asks for. Inserts come before the update they belong to. */
export type SweepOp =
  | { kind: 'insert'; row: InvoiceInsert }
  | { kind: 'update'; id: string; patch: { stage: 'awaiting'; billed_on: string; auto_billed: true } }

/**
 * What auto-bill does next for one client's regular chain: raise the earliest
 * open cycle that has come due (it goes out on its bill-on date) and queue the
 * cycle one month after it. The connector calls this after a write to a client's
 * chain, the way the app's sweep runs on every load; the caller repeats it until
 * it returns nothing.
 */
export function sweepOps(chainRows: StoredInvoice[], today: string): SweepOp[] {
  const due = chainRows
    .filter((r) => isOpenCycle(r) && r.auto_bill && r.bill_on !== null && r.bill_on <= today)
    .sort(byCycle)[0]
  if (!due) return []
  // Queued first: a write that stops halfway leaves the cycle still due, never queued twice.
  const queue = successorFor(due, chainRows, null)
  const raise: SweepOp = { kind: 'update', id: due.id, patch: { stage: 'awaiting', billed_on: due.bill_on as string, auto_billed: true } }
  return queue ? [{ kind: 'insert', row: queue }, raise] : [raise]
}
