/**
 * Task board tools.
 *
 * Stage moves are the interesting part: the app records stage transitions in
 * `stage_history` (and stamps `completed_at` / `started_at`) because Team KPI
 * is computed from that history. A connector that only updated `status` would
 * silently corrupt the KPI numbers, so `update_task` maintains the same
 * bookkeeping.
 */

import type { Caller } from '../session'
import { canDo, requirePermission, ToolError } from '../session'
import { type Args, dateOnly, limit, oneOf, str, uuid } from '../args'
import { list, type ListResult, workerNames, clientNames } from '../format'
import type { Tool } from './index'

const STATUSES = ['todo', 'in_progress', 'waiting', 'for_review', 'rework', 'completed'] as const
const PRIORITIES = ['low', 'medium', 'high'] as const

/** The stage timestamps the app sets when a card enters each column. */
const STAGE_FIELDS: Partial<Record<(typeof STATUSES)[number], string>> = {
  in_progress: 'started_at',
  waiting: 'waiting_since',
  for_review: 'submitted_for_review_at',
  rework: 'rework_started_at',
}

/** Columns of the row we project into results — the rest is KPI bookkeeping. */
const TASK_COLUMNS =
  'id, title, description, status, priority, due_date, worker_id, client_id, estimated_hours, completed_at, archived_at, created_at, updated_at, qa_score, rework_required'

async function listTasks(caller: Caller, args: Args): Promise<ListResult> {
  const page = limit(args, 'limit', 50, 200)
  const workerId = uuid(args, 'worker_id')
  const clientId = uuid(args, 'client_id')
  const status = oneOf(args, 'status', STATUSES)
  const priority = oneOf(args, 'priority', PRIORITIES)
  const overdue = args.overdue === true

  let query = caller.sb
    .from('tasks')
    .select(TASK_COLUMNS)
    .is('archived_at', null)
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(page + 1)

  if (workerId) query = query.eq('worker_id', workerId)
  if (clientId) query = query.eq('client_id', clientId)
  if (status) query = query.eq('status', status)
  if (priority) query = query.eq('priority', priority)
  if (overdue) {
    const today = new Date().toISOString().slice(0, 10)
    query = query.lt('due_date', today).not('status', 'eq', 'completed')
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const raw = (data ?? []) as Record<string, unknown>[]
  const names = await workerNames(caller, raw.map((r) => r.worker_id as string))
  const clients = await clientNames(caller, raw.map((r) => r.client_id as string | null))

  const today = new Date().toISOString().slice(0, 10)
  const rows = raw.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    assignedTo: t.worker_id ? (names.get(t.worker_id as string) ?? 'Unknown worker') : null,
    workerId: t.worker_id,
    client: t.client_id ? (clients.get(t.client_id as string) ?? null) : null,
    dueDate: t.due_date ?? null,
    overdue: Boolean(t.due_date && (t.due_date as string) < today && t.status !== 'completed'),
    estimatedHours: t.estimated_hours === null ? null : Number(t.estimated_hours),
    completedAt: t.completed_at ?? null,
    description: t.description ?? null,
  }))

  return list(rows, { limit: page, hint: 'Sorted by due date. Use "status" or "overdue" to narrow.' })
}

/**
 * Board write permission, mirroring the app: every signed-in member can add
 * and move cards **on their own board**, and only an account with
 * `tasks.manage_all` can touch someone else's.
 */
function requireBoardAccess(caller: Caller, targetWorkerId: string | null | undefined): void {
  const ownBoard = caller.role === 'worker' && targetWorkerId === caller.workerId
  if (ownBoard || canDo(caller, 'tasks.manage_all')) return

  if (caller.role === 'worker') {
    throw new ToolError(
      'You can only change tasks on your own board. Ask your administrator for the "Manage everyone\'s tasks" permission to work across the team.',
    )
  }
  requirePermission(caller, 'tasks.manage_all')
}

async function createTask(caller: Caller, args: Args): Promise<unknown> {
  const title = str(args, 'title')
  if (!title) throw new ToolError('"title" is required.')

  const workerId = uuid(args, 'worker_id') ?? (caller.role === 'worker' ? caller.workerId : null)
  if (!workerId) throw new ToolError('"worker_id" is required — get it from list_workers.')

  requireBoardAccess(caller, workerId)

  const status = oneOf(args, 'status', STATUSES) ?? 'todo'
  const now = new Date().toISOString()

  const row: Record<string, unknown> = {
    worker_id: workerId,
    title,
    description: str(args, 'description') ?? null,
    status,
    priority: oneOf(args, 'priority', PRIORITIES) ?? 'medium',
    due_date: dateOnly(args, 'due_date') ?? null,
    created_by_role: caller.role,
  }

  const clientId = uuid(args, 'client_id')
  if (clientId) row.client_id = clientId

  const estimated = args.estimated_hours
  if (estimated !== undefined) row.estimated_hours = Number(estimated)

  if (status === 'in_progress') row.started_at = now
  if (status === 'completed') row.completed_at = now
  row.stage_history = [{ from: null, to: status, at: now, by: caller.displayName }]

  const { data, error } = await caller.sb.from('tasks').insert(row).select().single()
  if (error) throw new Error(error.message)

  const created = data as Record<string, unknown>
  const names = await workerNames(caller, [workerId])
  return {
    ok: true,
    taskId: created.id,
    title: created.title,
    assignedTo: names.get(workerId) ?? 'Unknown worker',
    status: created.status,
    message: `Task "${created.title}" created for ${names.get(workerId) ?? 'the worker'}.`,
  }
}

async function updateTask(caller: Caller, args: Args): Promise<unknown> {
  const taskId = uuid(args, 'task_id')
  if (!taskId) throw new ToolError('"task_id" is required.')

  const { data: current, error: readError } = await caller.sb
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .maybeSingle()
  if (readError) throw new Error(readError.message)
  if (!current) throw new ToolError('No task found with that id (or you cannot see it).')

  const row = current as Record<string, unknown>
  requireBoardAccess(caller, row.worker_id as string | null)
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (args.title !== undefined) {
    const title = str(args, 'title')
    if (!title) throw new ToolError('"title" cannot be empty.')
    patch.title = title
  }
  if (args.description !== undefined) patch.description = str(args, 'description') ?? null
  if (args.priority !== undefined) patch.priority = oneOf(args, 'priority', PRIORITIES)
  if (args.due_date !== undefined) patch.due_date = dateOnly(args, 'due_date') ?? null
  if (args.estimated_hours !== undefined) {
    patch.estimated_hours = args.estimated_hours === null ? null : Number(args.estimated_hours)
  }
  if (args.client_id !== undefined) patch.client_id = uuid(args, 'client_id') ?? null

  if (args.worker_id !== undefined) {
    const newWorker = uuid(args, 'worker_id') ?? null
    // Reassigning moves the card onto another person's board, which is a
    // manage-all action even when the card started on your own.
    if (newWorker !== (row.worker_id ?? null)) requireBoardAccess(caller, newWorker)
    patch.worker_id = newWorker
  }

  // A stage move carries bookkeeping: the timestamp for the new column, the
  // completed stamp, and an append-only history entry.
  const nextStatus = oneOf(args, 'status', STATUSES)
  if (nextStatus && nextStatus !== row.status) {
    const now = new Date().toISOString()
    patch.status = nextStatus

    for (const [status, field] of Object.entries(STAGE_FIELDS)) {
      if (status === nextStatus) patch[field] = now
    }
    if (nextStatus === 'completed') patch.completed_at = now
    if (row.status === 'completed' && nextStatus !== 'completed') patch.completed_at = null
    if (nextStatus !== 'waiting') patch.waiting_since = null

    const history = Array.isArray(row.stage_history) ? (row.stage_history as unknown[]) : []
    patch.stage_history = [
      ...history.slice(-49),
      { from: row.status, to: nextStatus, at: now, by: caller.displayName },
    ]
  }

  if (Object.keys(patch).length <= 1) {
    return { ok: true, message: 'Nothing to change — no supported fields were supplied.' }
  }

  const { data, error } = await caller.sb.from('tasks').update(patch).eq('id', taskId).select().single()
  if (error) throw new Error(error.message)

  const updated = data as Record<string, unknown>
  return {
    ok: true,
    taskId: updated.id,
    title: updated.title,
    status: updated.status,
    dueDate: updated.due_date ?? null,
    message: nextStatus && nextStatus !== row.status
      ? `Task moved from ${row.status} to ${nextStatus}.`
      : 'Task updated.',
  }
}

async function deleteTask(caller: Caller, args: Args): Promise<unknown> {
  const taskId = uuid(args, 'task_id')
  if (!taskId) throw new ToolError('"task_id" is required.')

  const { data: current, error: readError } = await caller.sb
    .from('tasks')
    .select('id, worker_id, title')
    .eq('id', taskId)
    .maybeSingle()
  if (readError) throw new Error(readError.message)
  if (!current) throw new ToolError('No task found with that id (or you cannot see it).')

  requireBoardAccess(caller, (current as { worker_id: string | null }).worker_id)

  const { error } = await caller.sb.from('tasks').delete().eq('id', taskId)
  if (error) throw new Error(error.message)
  return { ok: true, message: 'Task deleted. This cannot be undone.' }
}

export const taskTools: Tool[] = [
  {
    name: 'list_tasks',
    title: 'List tasks',
    description:
      "List tasks on the team's kanban board: title, stage, priority, who it is assigned to, client and due date. Sorted by due date. Use overdue=true to find late work.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'Only this worker\'s board.' },
        client_id: { type: 'string', description: 'Only tasks for this client.' },
        status: { type: 'string', enum: [...STATUSES], description: 'Column filter.' },
        priority: { type: 'string', enum: [...PRIORITIES] },
        overdue: { type: 'boolean', description: 'Only tasks past due and not completed.' },
        limit: { type: 'number', description: 'Maximum rows (default 50, max 200).' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => listTasks(caller, args),
  },
  {
    name: 'create_task',
    title: 'Create a task',
    description:
      'Add a card to a worker\'s board with a title, optional description, priority, due date, client and estimate. Every member can add cards to their own board; creating one for somebody else needs the tasks.manage_all permission.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What needs doing.' },
        description: { type: 'string' },
        worker_id: { type: 'string', description: 'Who it is for. Defaults to you.' },
        client_id: { type: 'string' },
        status: { type: 'string', enum: [...STATUSES], description: 'Starting column. Default todo.' },
        priority: { type: 'string', enum: [...PRIORITIES], description: 'Default medium.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD.' },
        estimated_hours: { type: 'number' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    handler: (caller, args) => createTask(caller, args),
  },
  {
    name: 'update_task',
    title: 'Update or move a task',
    description:
      'Change a task\'s title, description, priority, due date, client, assignee or estimate — or move it between board columns (todo → in_progress → waiting → for_review → rework → completed). Stage moves are recorded in the task history so Team KPI stays accurate.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task id from list_tasks.' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: [...STATUSES] },
        priority: { type: 'string', enum: [...PRIORITIES] },
        due_date: { type: 'string', description: 'YYYY-MM-DD.' },
        worker_id: { type: 'string', description: 'Reassign to this worker.' },
        client_id: { type: 'string' },
        estimated_hours: { type: 'number' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    handler: (caller, args) => updateTask(caller, args),
  },
  {
    name: 'delete_task',
    title: 'Delete a task',
    description:
      "Permanently delete a task. This cannot be undone. You can delete your own tasks; deleting someone else's needs the tasks.manage_all permission.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'Task id from list_tasks.' } },
      required: ['task_id'],
      additionalProperties: false,
    },
    handler: (caller, args) => deleteTask(caller, args),
  },
]
