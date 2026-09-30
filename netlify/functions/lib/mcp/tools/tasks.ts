/**
 * Task board tools.
 *
 * Stage moves are the interesting part: the app records stage transitions in
 * `stage_history` (and stamps `completed_at` / `started_at`) because Team KPI
 * is computed from that history. A connector that only updated `status` would
 * silently corrupt the KPI numbers, so `update_task` maintains the same
 * bookkeeping.
 *
 * "QA Required?" is enforced here too, not only in the app: a task with it set
 * can only be moved to completed by the admin or an account holding
 * `team_kpi.view`, and only they can change the setting. (The database has a
 * trigger with the same rules, so this is the friendly version of the refusal.)
 */

import type { Caller } from '../session'
import { canDo, requirePermission, ToolError } from '../session'
import { type Args, bool, dateOnly, limit, oneOf, str, uuid } from '../args'
import { list, type ListResult, workerNames, clientNames } from '../format'
import type { Tool } from './index'

const STATUSES = ['todo', 'in_progress', 'waiting', 'for_review', 'rework', 'completed'] as const
const PRIORITIES = ['low', 'medium', 'high'] as const

/**
 * The QA Required? rule. Mirrors src/lib/taskWorkflow.ts (duplicated rather
 * than imported, like the permission list: the functions bundle stays
 * independent of the app source).
 */
const QA_COMPLETION_BLOCKED =
  'This task requires QA — only the admin or someone with KPI access (team_kpi.view) can move it to completed. Move it to for_review instead.'
const QA_SETTING_LOCKED =
  'Only the admin or someone with KPI access (team_kpi.view) can change whether a task requires QA.'

/** True when the database has no `qa_required` column yet (migration not run). */
function isMissingQaColumn(error: { message?: string } | null): boolean {
  const message = error?.message ?? ''
  return /qa_required/i.test(message) && /column/i.test(message)
}

/** The stage timestamps the app sets when a card enters each column. */
const STAGE_FIELDS: Partial<Record<(typeof STATUSES)[number], string>> = {
  in_progress: 'started_at',
  waiting: 'waiting_since',
  for_review: 'submitted_for_review_at',
  rework: 'rework_started_at',
}

/** Columns of the row we project into results — the rest is KPI bookkeeping. */
const TASK_COLUMNS =
  'id, title, description, status, priority, start_date, due_date, worker_id, client_id, estimated_hours, completed_at, archived_at, created_at, updated_at, qa_score, rework_required'

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
    startDate: t.start_date ?? null,
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

  // QA Required? defaults to Yes. Only the admin / KPI access may ask for No,
  // and nobody else can create a QA-required task straight into completed.
  const reviewer = canDo(caller, 'team_kpi.view')
  if (args.qa_required !== undefined && bool(args, 'qa_required') === undefined) {
    throw new ToolError('"qa_required" must be true or false.')
  }
  const qaRequired = bool(args, 'qa_required') ?? true
  if (!qaRequired && !reviewer) throw new ToolError(QA_SETTING_LOCKED)
  if (qaRequired && status === 'completed' && !reviewer) throw new ToolError(QA_COMPLETION_BLOCKED)

  const row: Record<string, unknown> = {
    worker_id: workerId,
    title,
    description: str(args, 'description') ?? null,
    status,
    priority: oneOf(args, 'priority', PRIORITIES) ?? 'medium',
    // Every task carries a date started (default: today).
    start_date: dateOnly(args, 'start_date') ?? now.slice(0, 10),
    due_date: dateOnly(args, 'due_date') ?? null,
    qa_required: qaRequired,
    created_by_role: caller.role,
  }

  const clientId = uuid(args, 'client_id')
  if (clientId) row.client_id = clientId

  const estimated = args.estimated_hours
  if (estimated !== undefined) row.estimated_hours = Number(estimated)

  if (status === 'in_progress') row.started_at = now
  if (status === 'completed') row.completed_at = now
  row.stage_history = [{ from: null, to: status, at: now, by: caller.displayName }]

  let { data, error } = await caller.sb.from('tasks').insert(row).select().single()
  if (error && isMissingQaColumn(error)) {
    // A database that has not run supabase/RUN-THIS-task-qa-required.sql: the
    // task is still created, it just cannot carry the flag.
    delete row.qa_required
    ;({ data, error } = await caller.sb.from('tasks').insert(row).select().single())
  }
  if (error) throw new Error(error.message)

  const created = data as Record<string, unknown>
  const names = await workerNames(caller, [workerId])
  return {
    ok: true,
    taskId: created.id,
    title: created.title,
    assignedTo: names.get(workerId) ?? 'Unknown worker',
    status: created.status,
    qaRequired: created.qa_required === true,
    message: `Task "${created.title}" created for ${names.get(workerId) ?? 'the worker'}${created.qa_required === true ? ' (QA required)' : ''}.`,
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

  // QA Required?: rows without the value (older tasks, or a database that has
  // not run the migration) count as No.
  const reviewer = canDo(caller, 'team_kpi.view')
  const qaRequiredNow = row.qa_required === true
  if (args.qa_required !== undefined) {
    const next = bool(args, 'qa_required')
    if (next === undefined) throw new ToolError('"qa_required" must be true or false.')
    if (next !== qaRequiredNow) {
      if (!reviewer) throw new ToolError(QA_SETTING_LOCKED)
      patch.qa_required = next
    }
  }

  if (args.title !== undefined) {
    const title = str(args, 'title')
    if (!title) throw new ToolError('"title" cannot be empty.')
    patch.title = title
  }
  if (args.description !== undefined) patch.description = str(args, 'description') ?? null
  if (args.priority !== undefined) patch.priority = oneOf(args, 'priority', PRIORITIES)
  if (args.start_date !== undefined) {
    const startDate = dateOnly(args, 'start_date')
    // A blank start date is ignored: every task keeps a date started.
    if (startDate) patch.start_date = startDate
  }
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
    // A QA-required task only reaches completed through the admin / KPI access.
    if (nextStatus === 'completed' && qaRequiredNow && !reviewer) throw new ToolError(QA_COMPLETION_BLOCKED)
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

  let { data, error } = await caller.sb.from('tasks').update(patch).eq('id', taskId).select().single()
  if (error && 'qa_required' in patch && isMissingQaColumn(error)) {
    // Database without supabase/RUN-THIS-task-qa-required.sql: save the rest.
    delete patch.qa_required
    ;({ data, error } = await caller.sb.from('tasks').update(patch).eq('id', taskId).select().single())
  }
  if (error) throw new Error(error.message)

  const updated = data as Record<string, unknown>
  return {
    ok: true,
    taskId: updated.id,
    title: updated.title,
    status: updated.status,
    startDate: updated.start_date ?? null,
    dueDate: updated.due_date ?? null,
    qaRequired: updated.qa_required === true,
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
      "List tasks on the team's kanban board: title, stage, priority, who it is assigned to, client, start date and due date. Sorted by due date. Use overdue=true to find late work.",
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
      'Add a card to a worker\'s board with a title, optional description, priority, start date, due date, client and estimate. Every member can add cards to their own board; creating one for somebody else needs the tasks.manage_all permission. New cards require QA by default (qa_required=true): a plain worker cannot move them to completed — only the admin or someone with the team_kpi.view permission can, and only they may create a card with qa_required=false.',
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
        start_date: { type: 'string', description: 'YYYY-MM-DD. The date the task starts. Defaults to today.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD.' },
        estimated_hours: { type: 'number' },
        qa_required: {
          type: 'boolean',
          description:
            'QA Required? Default true: the worker cannot complete the task themselves — the admin or someone with team_kpi.view does, after review. Passing false needs the admin or team_kpi.view.',
        },
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
      'Change a task\'s title, description, priority, start date, due date, client, assignee or estimate — or move it between board columns (todo → in_progress → waiting → for_review → rework → completed). Stage moves are recorded in the task history so Team KPI stays accurate. A task with qa_required=true can only be moved to completed by the admin or someone with the team_kpi.view permission, and only they can change qa_required.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task id from list_tasks.' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: [...STATUSES] },
        priority: { type: 'string', enum: [...PRIORITIES] },
        start_date: { type: 'string', description: 'YYYY-MM-DD. When the task starts / started.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD.' },
        worker_id: { type: 'string', description: 'Reassign to this worker.' },
        client_id: { type: 'string' },
        estimated_hours: { type: 'number' },
        qa_required: {
          type: 'boolean',
          description: 'QA Required? Only the admin or someone with team_kpi.view can change it.',
        },
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
