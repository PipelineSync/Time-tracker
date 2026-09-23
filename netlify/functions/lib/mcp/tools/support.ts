/**
 * Meetings and the IT support desk.
 *
 * The ticket tools follow the app's unusual rule: the ticket queue belongs to
 * whoever holds the IT Support grant, and the **admin cannot read it**. RLS
 * enforces that, so `list_tickets` simply returns whatever the signed-in
 * account is allowed to see — for the admin that is nothing.
 */

import type { Caller } from '../session'
import { ToolError } from '../session'
import { type Args, limit, oneOf, str, timestamp, timestampEnd, uuid } from '../args'
import { list, type ListResult } from '../format'
import type { Tool } from './index'

const TICKET_STATUSES = ['open', 'in_progress', 'resolved'] as const
const TICKET_PRIORITIES = ['low', 'medium', 'high'] as const
const TICKET_CATEGORIES = ['hardware', 'software', 'account', 'other'] as const

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

async function listMeetings(caller: Caller, args: Args): Promise<ListResult> {
  const page = limit(args, 'limit', 50, 200)
  const from = timestamp(args, 'from')
  const to = timestampEnd(args, 'to')

  let query = caller.sb
    .from('meetings')
    .select('id, title, start_time, notes, created_at')
    .order('start_time', { ascending: true })
    .limit(page + 1)

  if (from) query = query.gte('start_time', from)
  if (to) query = query.lte('start_time', to)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const rows = ((data ?? []) as Record<string, unknown>[]).map((m) => ({
    id: m.id,
    title: m.title,
    startTime: m.start_time,
    notes: m.notes ?? null,
  }))

  return list(rows, { limit: page })
}

async function createMeeting(caller: Caller, args: Args): Promise<unknown> {
  const title = str(args, 'title')
  if (!title) throw new ToolError('"title" is required.')
  const start = timestamp(args, 'start_time')
  if (!start) throw new ToolError('"start_time" is required (ISO timestamp or YYYY-MM-DD).')

  const { data, error } = await caller.sb
    .from('meetings')
    .insert({ title, start_time: start, notes: str(args, 'notes') ?? null })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return { ok: true, meetingId: (data as { id: string }).id, message: `Meeting "${title}" scheduled.` }
}

// ---------------------------------------------------------------------------
// IT support tickets
// ---------------------------------------------------------------------------

async function listTickets(caller: Caller, args: Args): Promise<ListResult> {
  const page = limit(args, 'limit', 50, 200)
  const status = oneOf(args, 'status', TICKET_STATUSES)
  const priority = oneOf(args, 'priority', TICKET_PRIORITIES)

  let query = caller.sb
    .from('tickets')
    .select('id, number, subject, description, category, priority, status, requester_name, assignee_name, reply_count, created_at, updated_at, resolved_at')
    .order('created_at', { ascending: false })
    .limit(page + 1)

  if (status) query = query.eq('status', status)
  if (priority) query = query.eq('priority', priority)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const raw = (data ?? []) as Record<string, unknown>[]
  const rows = raw.map((t) => ({
    id: t.id,
    number: t.number,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    category: t.category,
    requestedBy: t.requester_name,
    assignedTo: t.assignee_name ?? null,
    replies: t.reply_count,
    createdAt: t.created_at,
    resolvedAt: t.resolved_at ?? null,
  }))

  return list(rows, {
    limit: page,
    hint: rows.length === 0
      ? 'No tickets are visible to this account. The IT Support queue is only readable by accounts holding the IT Support permission.'
      : undefined,
  })
}

async function getTicket(caller: Caller, args: Args): Promise<unknown> {
  const ticketId = uuid(args, 'ticket_id')
  if (!ticketId) throw new ToolError('"ticket_id" is required.')

  const { data: ticket, error } = await caller.sb
    .from('tickets')
    .select('id, number, subject, description, category, priority, status, requester_name, assignee_name, created_at, resolved_at')
    .eq('id', ticketId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!ticket) throw new ToolError('No ticket found with that id (or you cannot see it).')

  const { data: replies } = await caller.sb
    .from('ticket_replies')
    .select('id, author_name, author_role, body, created_at')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true })

  return {
    ticket: ticket as Record<string, unknown>,
    replies: ((replies ?? []) as Record<string, unknown>[]).map((r) => ({
      author: r.author_name,
      role: r.author_role,
      body: r.body,
      at: r.created_at,
    })),
  }
}

async function createTicket(caller: Caller, args: Args): Promise<unknown> {
  const subject = str(args, 'subject')
  const description = str(args, 'description')
  if (!subject) throw new ToolError('"subject" is required.')
  if (!description) throw new ToolError('"description" is required.')

  const { data, error } = await caller.sb
    .from('tickets')
    .insert({
      subject,
      description,
      category: oneOf(args, 'category', TICKET_CATEGORIES) ?? 'other',
      priority: oneOf(args, 'priority', TICKET_PRIORITIES) ?? 'medium',
      requester_user_id: caller.userId,
      requester_name: caller.displayName,
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  const created = data as Record<string, unknown>
  return {
    ok: true,
    ticketId: created.id,
    ticketNumber: created.number,
    message: `Ticket #${created.number} submitted. IT Support will pick it up.`,
  }
}

async function replyToTicket(caller: Caller, args: Args): Promise<unknown> {
  const ticketId = uuid(args, 'ticket_id')
  const body = str(args, 'body')
  if (!ticketId) throw new ToolError('"ticket_id" is required.')
  if (!body) throw new ToolError('"body" is required — the reply text.')

  const { error } = await caller.sb.from('ticket_replies').insert({
    ticket_id: ticketId,
    author_id: caller.userId,
    author_name: caller.displayName,
    author_role: caller.role,
    body,
  })
  if (error) throw new Error(error.message)
  return { ok: true, message: `Reply added to the ticket as ${caller.displayName}.` }
}

async function updateTicket(caller: Caller, args: Args): Promise<unknown> {
  const ticketId = uuid(args, 'ticket_id')
  if (!ticketId) throw new ToolError('"ticket_id" is required.')

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  const status = oneOf(args, 'status', TICKET_STATUSES)
  if (status) {
    patch.status = status
    patch.resolved_at = status === 'resolved' ? new Date().toISOString() : null
  }
  if (args.priority !== undefined) patch.priority = oneOf(args, 'priority', TICKET_PRIORITIES)

  const { error } = await caller.sb.from('tickets').update(patch).eq('id', ticketId)
  if (error) throw new Error(error.message)
  return { ok: true, message: 'Ticket updated.' }
}

export const supportTools: Tool[] = [
  {
    name: 'list_meetings',
    title: 'List meetings',
    description: 'List scheduled meetings with their titles, times and notes, soonest first.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Only meetings from this date (YYYY-MM-DD or ISO).' },
        to: { type: 'string', description: 'Only meetings up to this date inclusive.' },
        limit: { type: 'number', description: 'Maximum rows (default 50, max 200).' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => listMeetings(caller, args),
  },
  {
    name: 'create_meeting',
    title: 'Schedule a meeting',
    description: 'Add a meeting with a title, start time and optional notes.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start_time: { type: 'string', description: 'ISO timestamp or YYYY-MM-DD.' },
        notes: { type: 'string' },
      },
      required: ['title', 'start_time'],
      additionalProperties: false,
    },
    handler: (caller, args) => createMeeting(caller, args),
  },
  {
    name: 'list_tickets',
    title: 'List IT support tickets',
    description:
      'List IT support tickets: subject, status, priority, who raised it and who is handling it. Only accounts holding the IT Support permission can read the queue — for any other account this returns just the tickets they submitted.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...TICKET_STATUSES] },
        priority: { type: 'string', enum: [...TICKET_PRIORITIES] },
        limit: { type: 'number', description: 'Maximum rows (default 50, max 200).' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => listTickets(caller, args),
  },
  {
    name: 'get_ticket',
    title: 'Get a ticket with its replies',
    description: 'Read one IT support ticket in full, including every reply in the conversation.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'Ticket id from list_tickets.' },
      },
      required: ['ticket_id'],
      additionalProperties: false,
    },
    handler: (caller, args) => getTicket(caller, args),
  },
  {
    name: 'create_ticket',
    title: 'Raise an IT support ticket',
    description:
      'Submit an IT support ticket (subject, description, category, priority). Anyone signed in can raise one.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        description: { type: 'string' },
        category: { type: 'string', enum: [...TICKET_CATEGORIES], description: 'Default other.' },
        priority: { type: 'string', enum: [...TICKET_PRIORITIES], description: 'Default medium.' },
      },
      required: ['subject', 'description'],
      additionalProperties: false,
    },
    handler: (caller, args) => createTicket(caller, args),
  },
  {
    name: 'reply_to_ticket',
    title: 'Reply to a ticket',
    description: 'Add a reply to an IT support ticket conversation. Visible to IT Support and the requester.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string' },
        body: { type: 'string', description: 'The reply text.' },
      },
      required: ['ticket_id', 'body'],
      additionalProperties: false,
    },
    handler: (caller, args) => replyToTicket(caller, args),
  },
  {
    name: 'update_ticket',
    title: 'Update a ticket',
    description:
      'Change a ticket\'s status (open / in_progress / resolved) or priority. Resolving stamps the resolved time. Requires the IT Support permission.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string' },
        status: { type: 'string', enum: [...TICKET_STATUSES] },
        priority: { type: 'string', enum: [...TICKET_PRIORITIES] },
      },
      required: ['ticket_id'],
      additionalProperties: false,
    },
    handler: (caller, args) => updateTicket(caller, args),
  },
]
