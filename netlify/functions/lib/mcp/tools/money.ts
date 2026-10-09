/**
 * Money tools: payments (settlements), invoices and the finance ledger.
 *
 * `settle_worker` reproduces the app's settle-and-reset: it pays out every
 * unsettled entry, creates one payment row, and stamps those entries with
 * `settled_at` so the next settlement only covers time worked since. It never
 * deletes an entry — the app guarantees that, and Claude must not break it.
 */

import type { Caller } from '../session'
import { canDo, requirePermission, ToolError } from '../session'
import { type Args, dateOnly, limit, monthOnly, num, oneOf, str, uuid } from '../args'
import { list, money, type ListResult, workerNames, clientNames } from '../format'
import {
  invoiceStatus,
  stampsForStage,
  successorOnBilling,
  sweepOps,
  type StoredInvoice,
} from '../invoice-rules'
import type { Tool } from './index'

const PAYMENT_STATUSES = ['unpaid', 'pending', 'paid'] as const
const PAYMENT_METHODS = ['cash', 'qr'] as const
const INVOICE_STAGES = ['pending', 'awaiting', 'paid'] as const
const INVOICE_BASES = ['client', 'project', 'upwork'] as const
const FINANCE_KINDS = ['subscription', 'payroll', 'bill'] as const

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

async function listPayments(caller: Caller, args: Args): Promise<ListResult> {
  const page = limit(args, 'limit', 50, 200)
  const workerId = uuid(args, 'worker_id')
  const status = oneOf(args, 'status', PAYMENT_STATUSES)

  let query = caller.sb
    .from('payments')
    .select('id, worker_id, amount, hours, status, period_start, period_end, paid_at, note, payment_method, reference_number, created_at')
    .order('created_at', { ascending: false })
    .limit(page + 1)

  if (workerId) query = query.eq('worker_id', workerId)
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const raw = (data ?? []) as Record<string, unknown>[]
  const names = await workerNames(caller, raw.map((r) => r.worker_id as string))

  const rows = raw.map((p) => ({
    id: p.id,
    worker: names.get(p.worker_id as string) ?? 'Unknown worker',
    workerId: p.worker_id,
    amount: money(Number(p.amount ?? 0)),
    hours: Number(p.hours ?? 0),
    status: p.status,
    period: { from: p.period_start, to: p.period_end },
    paidAt: p.paid_at ?? null,
    method: p.payment_method ?? null,
    reference: p.reference_number ?? null,
    note: p.note ?? null,
  }))

  return list(rows, { limit: page })
}

async function settleWorker(caller: Caller, args: Args): Promise<unknown> {
  requirePermission(caller, 'payments.manage')
  const workerId = uuid(args, 'worker_id')
  if (!workerId) throw new ToolError('"worker_id" is required — get it from list_workers.')

  const { data: unsettled, error } = await caller.sb
    .from('time_entries')
    .select('id, start_time, end_time, total_minutes, earnings')
    .eq('worker_id', workerId)
    .is('settled_at', null)

  if (error) throw new Error(error.message)
  const entries = (unsettled ?? []) as Record<string, unknown>[]
  if (entries.length === 0) {
    const names = await workerNames(caller, [workerId])
    return {
      ok: false,
      message: `${names.get(workerId) ?? 'That worker'} has no unsettled time to settle.`,
    }
  }

  let totalMinutes = 0
  let earnings = 0
  let periodStart = entries[0].start_time as string
  let periodEnd = entries[0].end_time as string
  for (const entry of entries) {
    totalMinutes += Number(entry.total_minutes ?? 0)
    earnings += Number(entry.earnings ?? 0)
    if ((entry.start_time as string) < periodStart) periodStart = entry.start_time as string
    if ((entry.end_time as string) > periodEnd) periodEnd = entry.end_time as string
  }

  const { data: payment, error: insertError } = await caller.sb
    .from('payments')
    .insert({
      worker_id: workerId,
      amount: Math.round(earnings * 100) / 100,
      hours: Math.round((totalMinutes / 60) * 100) / 100,
      status: 'unpaid',
      period_start: periodStart,
      period_end: periodEnd,
      note: str(args, 'note') ?? null,
    })
    .select()
    .single()

  if (insertError || !payment) throw new Error(insertError?.message ?? 'Could not create the payment.')

  // Stamp exactly the entries that were paid for, by id, so time recorded
  // while the settlement was running is left for next time.
  const stampResult = await caller.sb
    .from('time_entries')
    .update({ settled_at: (payment as { created_at: string }).created_at, updated_at: new Date().toISOString() })
    .in('id', entries.map((e) => e.id as string))

  const names = await workerNames(caller, [workerId])
  const name = names.get(workerId) ?? 'The worker'

  return {
    ok: true,
    paymentId: (payment as { id: string }).id,
    worker: name,
    amount: money(earnings),
    hours: Math.round((totalMinutes / 60) * 100) / 100,
    entriesSettled: entries.length,
    period: { from: periodStart, to: periodEnd },
    stamped: !stampResult.error,
    message:
      `Settled ${entries.length} entries for ${name}: ` +
      `${(Math.round((totalMinutes / 60) * 100) / 100).toFixed(2)}h / ${money(earnings)}. ` +
      `The payment is unpaid — use mark_payment_paid once it has been sent.` +
      (stampResult.error ? ' (Warning: the entries could not be stamped as settled — they may be paid twice.)' : ''),
  }
}

async function markPaymentPaid(caller: Caller, args: Args): Promise<unknown> {
  requirePermission(caller, 'payments.manage')
  const paymentId = uuid(args, 'payment_id')
  if (!paymentId) throw new ToolError('"payment_id" is required.')

  const status = oneOf(args, 'status', PAYMENT_STATUSES) ?? 'paid'
  if (status !== 'paid') {
    const { error } = await caller.sb
      .from('payments')
      .update({ status, paid_at: null, payment_method: null, reference_number: null })
      .eq('id', paymentId)
    if (error) throw new Error(error.message)
    return { ok: true, message: `Payment marked ${status}.` }
  }

  const method = oneOf(args, 'method', PAYMENT_METHODS)
  if (!method) throw new ToolError('"method" must be "cash" or "qr" when marking a payment paid.')

  const { error } = await caller.sb
    .from('payments')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      payment_method: method,
      reference_number: str(args, 'reference_number') ?? null,
    })
    .eq('id', paymentId)

  if (error) throw new Error(error.message)
  return { ok: true, message: `Payment marked paid by ${method}.` }
}

// ---------------------------------------------------------------------------
// Invoices
//
// The board's rules are applied here exactly as the app applies them: a stage
// change stamps the billed and paid dates, billing a regular invoice under
// auto-bill queues its next monthly cycle, and the due cycles of a client's
// chain are raised. The app runs the same sweep on every load; the connector
// runs it for the chain it has just written to.
// ---------------------------------------------------------------------------

const INVOICE_COLUMNS =
  'id, client_id, basis, project_name, amount, due_date, stage, notes, bill_on, auto_bill, auto_billed, billed_on, paid_on, created_at'

/** The connector's notion of today: the UTC date, as the rest of the connector uses. */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10)
}

/** A non-negative amount rounded to cents, or the fallback when none is given. */
function amountArg(args: Args, fallback: number): number {
  if (args.amount === undefined || args.amount === null || args.amount === '') return fallback
  const value = num(args, 'amount')
  if (value === undefined || value < 0) throw new ToolError('"amount" must be a number of zero or more.')
  return Math.round(value * 100) / 100
}

async function loadInvoice(caller: Caller, invoiceId: string): Promise<StoredInvoice> {
  const { data, error } = await caller.sb.from('invoices').select(INVOICE_COLUMNS).eq('id', invoiceId)
  if (error) throw new Error(error.message)
  const row = (data as StoredInvoice[] | null)?.[0]
  if (!row) throw new ToolError('No invoice has that id. Copy the id from list_invoices.')
  return row
}

/** Every regular-client row of one client: the chain its auto-bill rules read. */
async function regularChain(caller: Caller, clientId: string): Promise<StoredInvoice[]> {
  const { data, error } = await caller.sb
    .from('invoices')
    .select(INVOICE_COLUMNS)
    .eq('basis', 'client')
    .eq('client_id', clientId)
  if (error) throw new Error(error.message)
  return (data ?? []) as StoredInvoice[]
}

/**
 * Bring one client's regular chain up to date, as the app's sweep does: raise
 * each due cycle and queue the one after it, one step per pass. The cap only
 * stops a corrupt chain from looping; a long absence needs one pass per month.
 */
async function settleChain(caller: Caller, clientId: string, today: string): Promise<void> {
  for (let pass = 0; pass < 120; pass += 1) {
    const ops = sweepOps(await regularChain(caller, clientId), today)
    if (ops.length === 0) return
    for (const op of ops) {
      if (op.kind === 'insert') {
        const { error } = await caller.sb.from('invoices').insert(op.row)
        if (error) throw new Error(error.message)
      } else {
        const { error } = await caller.sb.from('invoices').update(op.patch).eq('id', op.id)
        if (error) throw new Error(error.message)
      }
    }
  }
}

/** The successor of a regular invoice that was just billed or paid under auto-bill. */
async function queueSuccessor(caller: Caller, billed: StoredInvoice, today: string): Promise<void> {
  if (billed.client_id === null) return
  const successor = successorOnBilling(billed, await regularChain(caller, billed.client_id), today)
  if (!successor) return
  const { error } = await caller.sb.from('invoices').insert(successor)
  if (error) throw new Error(error.message)
}

async function listInvoices(caller: Caller, args: Args): Promise<ListResult> {
  const page = limit(args, 'limit', 50, 200)
  const clientId = uuid(args, 'client_id')
  const stage = oneOf(args, 'stage', INVOICE_STAGES)
  const basis = oneOf(args, 'basis', INVOICE_BASES)

  let query = caller.sb
    .from('invoices')
    .select(INVOICE_COLUMNS)
    .order('due_date', { ascending: true })
    .limit(page + 1)

  if (clientId) query = query.eq('client_id', clientId)
  if (stage) query = query.eq('stage', stage)
  if (basis) query = query.eq('basis', basis)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const raw = (data ?? []) as StoredInvoice[]
  const clients = await clientNames(caller, raw.map((r) => r.client_id))
  const today = todayUTC()

  const rows = raw.map((i) => {
    const status = invoiceStatus(i.stage, i.due_date, today)
    return {
      id: i.id,
      billed: i.client_id ? (clients.get(i.client_id) ?? 'Unknown client') : (i.project_name ?? 'Project'),
      basis: i.basis,
      amount: money(Number(i.amount ?? 0)),
      dueDate: i.due_date,
      stage: i.stage,
      status,
      overdue: status === 'overdue',
      billOn: i.bill_on,
      autoBill: i.basis === 'client' ? i.auto_bill : null,
      autoBilled: i.basis === 'client' ? i.auto_billed : null,
      billedOn: i.billed_on,
      paidOn: i.paid_on,
      notes: i.notes ?? null,
    }
  })

  return list(rows, { limit: page })
}

async function createInvoice(caller: Caller, args: Args): Promise<unknown> {
  requirePermission(caller, 'invoices.view')
  const dueDate = dateOnly(args, 'due_date')
  if (!dueDate) throw new ToolError('"due_date" is required (YYYY-MM-DD).')

  const clientId = uuid(args, 'client_id') ?? null
  const projectName = str(args, 'project_name') ?? null
  const basis = oneOf(args, 'basis', INVOICE_BASES) ?? (clientId ? 'client' : 'project')
  const stage = oneOf(args, 'stage', INVOICE_STAGES) ?? 'pending'
  const amount = amountArg(args, 0)
  const notes = str(args, 'notes') ?? null
  const billOnInput = dateOnly(args, 'bill_on') ?? null
  const today = todayUTC()

  if (basis === 'project') {
    if (!projectName) throw new ToolError('Name the project this invoice bills ("project_name"). A client can also be given.')
  } else if (!clientId) {
    throw new ToolError(`Give the client this ${basis === 'upwork' ? 'Upwork' : 'regular'} invoice bills ("client_id").`)
  }
  if (billOnInput && basis !== 'client') throw new ToolError('"bill_on" only applies to a regular client invoice.')

  let autoBill = false
  let billOn: string | null = null
  if (basis === 'client' && clientId) {
    const chain = await regularChain(caller, clientId)
    // One pending regular invoice per client: the next cycle is queued only once this one is billed.
    if (stage === 'pending' && chain.some((r) => r.stage === 'pending')) {
      throw new ToolError('This client already has a regular invoice waiting to be billed. Bill or edit that one first.')
    }
    // A new regular invoice takes the switch its client already has; otherwise auto-bill is on.
    autoBill = chain.length > 0 ? chain[0].auto_bill : true
    billOn = billOnInput ?? today
  }
  const billed = basis === 'client' && autoBill && stage !== 'pending'
  const stamps = stampsForStage({ stage: 'pending', billed_on: null, paid_on: null }, stage, today)

  const { data, error } = await caller.sb
    .from('invoices')
    .insert({
      client_id: clientId,
      basis,
      project_name: basis === 'project' ? projectName : null,
      amount,
      due_date: dueDate,
      stage,
      notes,
      bill_on: billOn,
      auto_bill: autoBill,
      auto_billed: billed,
      billed_on: stamps.billed_on,
      paid_on: stamps.paid_on,
    })
    .select(INVOICE_COLUMNS)
    .single()
  if (error) throw new Error(error.message)

  const created = data as StoredInvoice | null
  if (!created) throw new Error('The invoice was not saved.')
  if (billed) await queueSuccessor(caller, created, today)
  if (basis === 'client' && clientId) await settleChain(caller, clientId, today)

  const final = await loadInvoice(caller, created.id)
  return {
    ok: true,
    invoiceId: final.id,
    basis: final.basis,
    stage: final.stage,
    status: invoiceStatus(final.stage, final.due_date, today),
    billOn: final.bill_on,
    message: 'Invoice created.',
  }
}

async function updateInvoice(caller: Caller, args: Args): Promise<unknown> {
  requirePermission(caller, 'invoices.view')
  const invoiceId = uuid(args, 'invoice_id')
  if (!invoiceId) throw new ToolError('"invoice_id" is required.')
  const current = await loadInvoice(caller, invoiceId)
  const today = todayUTC()

  const patch: Record<string, unknown> = {}
  if (args.amount !== undefined) patch.amount = amountArg(args, current.amount)
  if (args.due_date !== undefined) {
    const dueDate = dateOnly(args, 'due_date')
    if (!dueDate) throw new ToolError('"due_date" must be a date in YYYY-MM-DD format.')
    patch.due_date = dueDate
  }
  if (args.notes !== undefined) patch.notes = str(args, 'notes') ?? null
  if (args.client_id !== undefined) {
    // A regular invoice keeps its client: its cycle and switch belong to that client's chain.
    if (current.basis === 'client') {
      throw new ToolError('A regular client invoice stays with its client. Create a new invoice for the other client instead.')
    }
    const clientId = uuid(args, 'client_id') ?? null
    if (current.basis === 'upwork' && clientId === null) throw new ToolError('An Upwork invoice needs its client ("client_id").')
    patch.client_id = clientId
  }

  const stage = oneOf(args, 'stage', INVOICE_STAGES)
  const billedNow = current.basis === 'client' && current.auto_bill && current.stage === 'pending' && stage !== undefined && stage !== 'pending'
  if (stage !== undefined) {
    const stamps = stampsForStage(current, stage, today)
    patch.stage = stage
    patch.billed_on = stamps.billed_on
    patch.paid_on = stamps.paid_on
    // Billed by hand while auto-bill is on: the cycle is handled, so undoing it later never re-raises it.
    if (billedNow) patch.auto_billed = true
  }
  if (Object.keys(patch).length === 0) {
    throw new ToolError('Nothing to change. Give amount, due_date, stage, notes or client_id.')
  }

  const { error } = await caller.sb.from('invoices').update(patch).eq('id', invoiceId)
  if (error) throw new Error(error.message)

  if (current.basis === 'client' && current.client_id !== null) {
    if (billedNow) await queueSuccessor(caller, { ...current, ...patch } as StoredInvoice, today)
    await settleChain(caller, current.client_id, today)
  }

  const updated = await loadInvoice(caller, invoiceId)
  return {
    ok: true,
    invoiceId: updated.id,
    stage: updated.stage,
    status: invoiceStatus(updated.stage, updated.due_date, today),
    amount: money(Number(updated.amount ?? 0)),
  }
}

// ---------------------------------------------------------------------------
// Finance ledger
// ---------------------------------------------------------------------------

async function listFinanceItems(caller: Caller, args: Args): Promise<ListResult> {
  const page = limit(args, 'limit', 50, 200)
  const kind = oneOf(args, 'kind', FINANCE_KINDS)
  const status = oneOf(args, 'status', ['active', 'paused', 'unpaid', 'paid'] as const)

  let query = caller.sb
    .from('finance_items')
    .select('id, kind, name, worker_id, amount, cycle, period_month, due_date, status, paid_at, note')
    .order('due_date', { ascending: true })
    .limit(page + 1)

  if (kind) query = query.eq('kind', kind)
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const raw = (data ?? []) as Record<string, unknown>[]
  const names = await workerNames(caller, raw.map((r) => r.worker_id as string | null))
  const today = new Date().toISOString().slice(0, 10)

  const rows = raw.map((f) => ({
    id: f.id,
    kind: f.kind,
    name: f.name ?? (f.worker_id ? (names.get(f.worker_id as string) ?? 'Payroll') : null),
    amount: money(Number(f.amount ?? 0)),
    cycle: f.cycle ?? null,
    periodMonth: f.period_month ?? null,
    dueDate: f.due_date,
    status: f.status,
    overdue: Boolean(f.due_date && (f.due_date as string) < today && f.status === 'unpaid'),
    paidAt: f.paid_at ?? null,
    note: f.note ?? null,
  }))

  return list(rows, { limit: page })
}

async function createFinanceItem(caller: Caller, args: Args): Promise<unknown> {
  requirePermission(caller, 'finance.manage')
  const kind = oneOf(args, 'kind', FINANCE_KINDS)
  if (!kind) throw new ToolError('"kind" must be subscription, payroll or bill.')
  const dueDate = dateOnly(args, 'due_date')
  if (!dueDate) throw new ToolError('"due_date" is required (YYYY-MM-DD).')

  const row: Record<string, unknown> = {
    kind,
    amount: Number(args.amount ?? 0),
    due_date: dueDate,
    note: str(args, 'note') ?? null,
  }

  if (kind === 'subscription') {
    const name = str(args, 'name')
    if (!name) throw new ToolError('A subscription needs a "name".')
    row.name = name
    row.cycle = oneOf(args, 'cycle', ['monthly', 'yearly'] as const) ?? 'monthly'
    row.status = oneOf(args, 'status', ['active', 'paused'] as const) ?? 'active'
  } else if (kind === 'payroll') {
    const workerId = uuid(args, 'worker_id')
    if (!workerId) throw new ToolError('A payroll run needs a "worker_id".')
    const periodMonth = monthOnly(args, 'period_month')
    if (!periodMonth) throw new ToolError('A payroll run needs a "period_month" (YYYY-MM).')
    row.worker_id = workerId
    row.period_month = periodMonth
    row.status = oneOf(args, 'status', ['unpaid', 'paid'] as const) ?? 'unpaid'
  } else {
    const name = str(args, 'name')
    if (!name) throw new ToolError('A bill needs a "name".')
    row.name = name
    row.status = oneOf(args, 'status', ['unpaid', 'paid'] as const) ?? 'unpaid'
  }

  const { data, error } = await caller.sb.from('finance_items').insert(row).select().single()
  if (error) throw new Error(error.message)
  return { ok: true, financeItemId: (data as { id: string }).id, message: `${kind} added to the ledger.` }
}

async function markFinanceItemPaid(caller: Caller, args: Args): Promise<unknown> {
  requirePermission(caller, 'finance.manage')
  const itemId = uuid(args, 'item_id')
  if (!itemId) throw new ToolError('"item_id" is required.')

  // Subscriptions cycle rather than get "paid"; their only external statuses
  // are active/paused.
  const status = oneOf(args, 'status', ['active', 'paused', 'unpaid', 'paid'] as const) ?? 'paid'
  const isSubscriptionState = status === 'active' || status === 'paused'

  const { error } = await caller.sb
    .from('finance_items')
    .update({
      status,
      paid_at: status === 'paid' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId)

  if (error) throw new Error(error.message)
  return {
    ok: true,
    message: isSubscriptionState ? `Subscription set to ${status}.` : `Item marked ${status}.`,
  }
}

// ---------------------------------------------------------------------------
// KPI goals
// ---------------------------------------------------------------------------

async function listMonthlyGoals(caller: Caller, args: Args): Promise<ListResult> {
  // Team KPI is Owner-or-grant, exactly as in the app.
  if (!canDo(caller, 'team_kpi.view')) {
    throw new ToolError(
      caller.role === 'admin'
        ? 'Team KPI data is unavailable on this account.'
        : 'Your account does not have Team KPI access. Ask your administrator for the "Team KPI" tick.',
    )
  }

  const month = monthOnly(args, 'month')
  const workerId = uuid(args, 'worker_id')

  let query = caller.sb
    .from('monthly_goals')
    .select('id, worker_id, month, target, on_time_target, qa_target, note')
    .order('month', { ascending: false })
    .limit(200)

  if (month) query = query.eq('month', month)
  if (workerId) query = query.eq('worker_id', workerId)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const raw = (data ?? []) as Record<string, unknown>[]
  const names = await workerNames(caller, raw.map((r) => r.worker_id as string))

  const rows = raw.map((g) => ({
    id: g.id,
    worker: names.get(g.worker_id as string) ?? 'Unknown worker',
    workerId: g.worker_id,
    month: g.month,
    targetTasks: g.target ?? null,
    onTimeTargetPercent: g.on_time_target === null ? null : Number(g.on_time_target),
    qaTargetPercent: g.qa_target === null ? null : Number(g.qa_target),
    note: g.note ?? null,
  }))

  return list(rows, { limit: 200 })
}

export const moneyTools: Tool[] = [
  {
    name: 'list_payments',
    title: 'List payments',
    description:
      'List worker payments (settlements): amount, hours covered, the period it covers, and whether it has been paid. Use this to answer "who still needs paying?".',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string' },
        status: { type: 'string', enum: [...PAYMENT_STATUSES] },
        limit: { type: 'number', description: 'Maximum rows (default 50, max 200).' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => listPayments(caller, args),
  },
  {
    name: 'settle_worker',
    title: 'Settle a worker\'s time',
    description:
      'Pay out a worker\'s unsettled time: creates one payment for every entry that has not been settled yet, and marks those entries settled so the next settlement only covers new time. Time entries are never deleted. Requires the payments.manage permission.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'Worker id from list_workers.' },
        note: { type: 'string', description: 'Optional note stored on the payment.' },
      },
      required: ['worker_id'],
      additionalProperties: false,
    },
    handler: (caller, args) => settleWorker(caller, args),
  },
  {
    name: 'mark_payment_paid',
    title: 'Mark a payment paid',
    description:
      'Record that a payment was sent. Requires a method (cash or QR) and optionally a transfer reference number. Setting a status other than "paid" clears the paid date. Requires the payments.manage permission.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        payment_id: { type: 'string', description: 'Payment id from list_payments.' },
        status: { type: 'string', enum: [...PAYMENT_STATUSES], description: 'Default "paid".' },
        method: { type: 'string', enum: [...PAYMENT_METHODS], description: 'Required when status is "paid".' },
        reference_number: { type: 'string', description: 'GCash / Maya / bank reference.' },
      },
      required: ['payment_id'],
      additionalProperties: false,
    },
    handler: (caller, args) => markPaymentPaid(caller, args),
  },
  {
    name: 'list_invoices',
    title: 'List invoices',
    description:
      'List the invoice board, sorted by due date. Each invoice bills a regular client (basis "client": recurring, with a bill-on date and an auto-bill switch), a named project (basis "project", one-time or milestone), or an Upwork client (basis "upwork"). Shows the amount, due date, board column (stage: pending / awaiting / paid), status (the same, plus "overdue" when unpaid past its due date), when it was billed and paid, and for a regular invoice its bill-on date, auto-bill switch and whether auto-bill has already handled it. Due regular invoices under auto-bill are raised when the board next loads in the app or when that client\'s invoices are changed here.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        client_id: { type: 'string' },
        basis: { type: 'string', enum: [...INVOICE_BASES], description: 'client = regular, project, or upwork.' },
        stage: { type: 'string', enum: [...INVOICE_STAGES] },
        limit: { type: 'number', description: 'Maximum rows (default 50, max 200).' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => listInvoices(caller, args),
  },
  {
    name: 'create_invoice',
    title: 'Create an invoice',
    description:
      'Add an invoice to the board. basis "client" bills a regular client (client_id): a recurring invoice, which gets bill_on (default today) and takes the auto-bill switch its client already has (otherwise on). When it is billed or paid under auto-bill, the next monthly cycle is queued. basis "project" bills a named project (project_name; client_id optional). basis "upwork" bills an Upwork client (client_id). Defaults to "client" when client_id is given and "project" when only project_name is. Requires a due date. Zero is a valid amount for an invoice raised before its figure is known. A regular invoice cannot be created while its client already has one waiting to be billed (Pending). The auto-bill switch itself is set in the app.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        basis: { type: 'string', enum: [...INVOICE_BASES], description: 'Default: client when client_id is given, otherwise project.' },
        client_id: { type: 'string', description: 'Client id from list_clients. Required for client and upwork.' },
        project_name: { type: 'string', description: 'Required for project.' },
        amount: { type: 'number', description: 'Invoice amount. Default 0.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD.' },
        bill_on: { type: 'string', description: 'Regular client only: the day this cycle is billed, YYYY-MM-DD. Default today.' },
        stage: { type: 'string', enum: [...INVOICE_STAGES], description: 'Default pending. Awaiting or paid stamps the billed (and paid) date today.' },
        notes: { type: 'string' },
      },
      required: ['due_date'],
      additionalProperties: false,
    },
    handler: (caller, args) => createInvoice(caller, args),
  },
  {
    name: 'update_invoice',
    title: 'Update an invoice',
    description:
      'Change an invoice\'s amount, due date, board column, notes, or — for project and Upwork invoices — its client. Moving to awaiting stamps the billed date (today); moving to paid stamps the paid date, and the billed date if it is still missing; moving back to pending clears both dates. Billing a regular invoice while its client\'s auto-bill is on queues the next monthly cycle. A regular invoice keeps its client, bill-on date and auto-bill switch; those are changed in the app.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: 'Invoice id from list_invoices.' },
        amount: { type: 'number' },
        due_date: { type: 'string', description: 'YYYY-MM-DD.' },
        stage: { type: 'string', enum: [...INVOICE_STAGES] },
        client_id: { type: 'string', description: 'Project and Upwork invoices only.' },
        notes: { type: 'string' },
      },
      required: ['invoice_id'],
      additionalProperties: false,
    },
    handler: (caller, args) => updateInvoice(caller, args),
  },
  {
    name: 'list_finance_items',
    title: 'List finance items',
    description:
      'List the finance ledger: subscriptions, payroll runs and bills, with amounts, due dates and paid status. Sorted by due date so upcoming money is first.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...FINANCE_KINDS] },
        status: { type: 'string', enum: ['active', 'paused', 'unpaid', 'paid'] },
        limit: { type: 'number', description: 'Maximum rows (default 50, max 200).' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => listFinanceItems(caller, args),
  },
  {
    name: 'create_finance_item',
    title: 'Add a finance item',
    description:
      'Add a subscription (needs a name and a monthly/yearly cycle), a payroll run (needs a worker and a YYYY-MM period) or a bill (needs a name). Requires the finance.manage permission.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...FINANCE_KINDS] },
        name: { type: 'string', description: 'Required for subscriptions and bills.' },
        amount: { type: 'number' },
        due_date: { type: 'string', description: 'YYYY-MM-DD.' },
        cycle: { type: 'string', enum: ['monthly', 'yearly'], description: 'Subscriptions only.' },
        worker_id: { type: 'string', description: 'Payroll only.' },
        period_month: { type: 'string', description: 'Payroll only, YYYY-MM.' },
        note: { type: 'string' },
      },
      required: ['kind', 'due_date'],
      additionalProperties: false,
    },
    handler: (caller, args) => createFinanceItem(caller, args),
  },
  {
    name: 'mark_finance_item_paid',
    title: 'Mark a finance item paid',
    description:
      'Mark a bill or payroll run paid (or unpaid again). Subscriptions do not get paid — set them active or paused instead. Requires the finance.manage permission.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'Item id from list_finance_items.' },
        status: { type: 'string', enum: ['active', 'paused', 'unpaid', 'paid'], description: 'Default "paid".' },
      },
      required: ['item_id'],
      additionalProperties: false,
    },
    handler: (caller, args) => markFinanceItemPaid(caller, args),
  },
  {
    name: 'list_monthly_goals',
    title: 'List monthly KPI goals',
    description:
      'List each worker\'s monthly targets: task count, on-time percentage and QA percentage. Requires the team_kpi.view permission (the workspace owner always has it).',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'YYYY-MM, e.g. 2026-09.' },
        worker_id: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => listMonthlyGoals(caller, args),
  },
]
