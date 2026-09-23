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
import { type Args, dateOnly, limit, monthOnly, oneOf, str, uuid } from '../args'
import { list, money, type ListResult, workerNames, clientNames } from '../format'
import type { Tool } from './index'

const PAYMENT_STATUSES = ['unpaid', 'pending', 'paid'] as const
const PAYMENT_METHODS = ['cash', 'qr'] as const
const INVOICE_STAGES = ['pending', 'awaiting', 'paid'] as const
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
// ---------------------------------------------------------------------------

async function listInvoices(caller: Caller, args: Args): Promise<ListResult> {
  const page = limit(args, 'limit', 50, 200)
  const clientId = uuid(args, 'client_id')
  const stage = oneOf(args, 'stage', INVOICE_STAGES)

  let query = caller.sb
    .from('invoices')
    .select('id, client_id, basis, project_name, amount, due_date, stage, notes, created_at, updated_at')
    .order('due_date', { ascending: true })
    .limit(page + 1)

  if (clientId) query = query.eq('client_id', clientId)
  if (stage) query = query.eq('stage', stage)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const raw = (data ?? []) as Record<string, unknown>[]
  const clients = await clientNames(caller, raw.map((r) => r.client_id as string | null))
  const today = new Date().toISOString().slice(0, 10)

  const rows = raw.map((i) => ({
    id: i.id,
    billed: i.client_id ? (clients.get(i.client_id as string) ?? 'Unknown client') : (i.project_name ?? 'Project'),
    basis: i.basis,
    amount: money(Number(i.amount ?? 0)),
    dueDate: i.due_date,
    stage: i.stage,
    overdue: Boolean(i.due_date && (i.due_date as string) < today && i.stage !== 'paid'),
    notes: i.notes ?? null,
  }))

  return list(rows, { limit: page })
}

async function createInvoice(caller: Caller, args: Args): Promise<unknown> {
  requirePermission(caller, 'invoices.view')
  const dueDate = dateOnly(args, 'due_date')
  if (!dueDate) throw new ToolError('"due_date" is required (YYYY-MM-DD).')

  const clientId = uuid(args, 'client_id')
  const projectName = str(args, 'project_name')
  if (!clientId && !projectName) {
    throw new ToolError('Give either a "client_id" or a "project_name" to say what this invoice bills.')
  }

  const { data, error } = await caller.sb
    .from('invoices')
    .insert({
      client_id: clientId ?? null,
      basis: clientId ? 'client' : 'project',
      project_name: clientId ? null : (projectName ?? null),
      amount: Number(args.amount ?? 0),
      due_date: dueDate,
      stage: oneOf(args, 'stage', INVOICE_STAGES) ?? 'pending',
      notes: str(args, 'notes') ?? null,
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return { ok: true, invoiceId: (data as { id: string }).id, message: 'Invoice created.' }
}

async function updateInvoice(caller: Caller, args: Args): Promise<unknown> {
  requirePermission(caller, 'invoices.view')
  const invoiceId = uuid(args, 'invoice_id')
  if (!invoiceId) throw new ToolError('"invoice_id" is required.')

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (args.amount !== undefined) patch.amount = Number(args.amount)
  if (args.due_date !== undefined) patch.due_date = dateOnly(args, 'due_date')
  if (args.stage !== undefined) patch.stage = oneOf(args, 'stage', INVOICE_STAGES)
  if (args.notes !== undefined) patch.notes = str(args, 'notes') ?? null
  if (args.client_id !== undefined) patch.client_id = uuid(args, 'client_id') ?? null

  const { data, error } = await caller.sb
    .from('invoices')
    .update(patch)
    .eq('id', invoiceId)
    .select()
    .single()
  if (error) throw new Error(error.message)

  const updated = data as Record<string, unknown>
  return { ok: true, invoiceId: updated.id, stage: updated.stage, amount: money(Number(updated.amount ?? 0)) }
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
      'List client and project invoices: what is billed, how much, when it is due, and which board column it sits in (pending / awaiting / paid). Sorted by due date.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        client_id: { type: 'string' },
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
      'Add an invoice to the board, billing either a client (client_id) or a named project (project_name). Requires a due date. Zero is a valid amount for an invoice raised before its figure is known.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'Client id from list_clients.' },
        project_name: { type: 'string', description: 'Used when the invoice bills a project, not a client.' },
        amount: { type: 'number', description: 'Invoice amount. Default 0.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD.' },
        stage: { type: 'string', enum: [...INVOICE_STAGES], description: 'Default pending.' },
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
    description: 'Change an invoice\'s amount, due date, board column, client or notes.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: 'Invoice id from list_invoices.' },
        amount: { type: 'number' },
        due_date: { type: 'string', description: 'YYYY-MM-DD.' },
        stage: { type: 'string', enum: [...INVOICE_STAGES] },
        client_id: { type: 'string' },
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
