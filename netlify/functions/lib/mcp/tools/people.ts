/**
 * Team, clients and workspace tools.
 */

import type { Caller } from '../session'
import { type Args, limit, oneOf, str } from '../args'
import { list, type ListResult } from '../format'
import type { Tool } from './index'

const WORKER_STATUSES = ['active', 'inactive'] as const

async function whoami(caller: Caller): Promise<unknown> {
  return {
    signedInAs: caller.displayName,
    email: caller.email,
    role: caller.role,
    workerId: caller.workerId,
    permissions:
      caller.role === 'admin'
        ? 'All — this is the workspace admin account.'
        : caller.permissions.length > 0
          ? caller.permissions
          : 'None — this is a standard worker account.',
    note:
      caller.role === 'admin'
        ? 'Claude can read and change every part of this workspace.'
        : 'Claude can only see and change what this account is allowed to. Workers see their own time and tasks unless the admin granted more.',
  }
}

async function listWorkers(caller: Caller, args: Args): Promise<ListResult> {
  const page = limit(args, 'limit', 100, 200)
  const status = oneOf(args, 'status', WORKER_STATUSES)

  let query = caller.sb
    .from('workers')
    .select('id, name, email, position, hourly_rate, status, workdays, weekly_capacity_hours, created_at')
    .order('name')
    .limit(page + 1)

  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const rows = ((data ?? []) as Record<string, unknown>[]).map((w) => ({
    id: w.id,
    name: w.name,
    position: w.position ?? null,
    email: w.email ?? null,
    hourlyRate: Number(w.hourly_rate ?? 0),
    status: w.status,
    workdays: w.workdays,
    weeklyCapacityHours: Number(w.weekly_capacity_hours ?? 40),
  }))

  return list(rows, {
    limit: page,
    hint: 'Narrow with "status" or ask for a specific worker by name to find their id.',
  })
}

async function listClients(caller: Caller, args: Args): Promise<ListResult> {
  const page = limit(args, 'limit', 100, 200)
  const status = oneOf(args, 'status', WORKER_STATUSES)
  const name = str(args, 'name')

  let query = caller.sb
    .from('clients')
    .select('id, name, color, status, created_at')
    .order('name')
    .limit(page + 1)

  if (status) query = query.eq('status', status)
  if (name) query = query.ilike('name', `%${name}%`)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const rows = ((data ?? []) as Record<string, unknown>[]).map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
  }))

  return list(rows, { limit: page })
}

async function getSettings(caller: Caller): Promise<unknown> {
  const { data, error } = await caller.sb
    .from('settings')
    .select('business_name, currency, timezone, default_hourly_rate, usd_php_rate, usd_php_rate_updated_at')
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) return { note: 'This account cannot read the workspace settings.' }

  const row = data as Record<string, unknown>
  return {
    businessName: row.business_name,
    currency: row.currency,
    timezone: row.timezone,
    defaultHourlyRate: Number(row.default_hourly_rate ?? 0),
    usdToPhpRate: row.usd_php_rate === null ? null : Number(row.usd_php_rate),
    usdToPhpRateUpdatedAt: row.usd_php_rate_updated_at ?? null,
    note: 'All money amounts in this workspace are in the currency above.',
  }
}

export const peopleTools: Tool[] = [
  {
    name: 'whoami',
    title: 'Who is connected',
    description:
      'Show which Work Tracker account the connector is signed in as, its role, and exactly what it is allowed to see and change. Call this first if you are unsure whether you have access to something.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (caller) => whoami(caller),
  },
  {
    name: 'list_workers',
    title: 'List workers',
    description:
      'List the team: every worker\'s id, name, position, hourly rate, status and weekly schedule. Use the ids when filtering other tools by worker. Workers without team-wide access only see themselves.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'inactive'], description: 'Filter by employment status.' },
        limit: { type: 'number', description: 'Maximum rows to return (default 100, max 200).' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => listWorkers(caller, args),
  },
  {
    name: 'list_clients',
    title: 'List clients',
    description:
      'List clients with their ids and status. Use the ids to filter time entries, tasks and invoices, or to bill time to a client.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Case-insensitive partial name match, e.g. "acme".' },
        status: { type: 'string', enum: ['active', 'inactive'] },
        limit: { type: 'number', description: 'Maximum rows to return (default 100, max 200).' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => listClients(caller, args),
  },
  {
    name: 'get_settings',
    title: 'Get workspace settings',
    description:
      'Read the workspace name, currency, timezone and default hourly rate. Call this before reporting amounts so you use the right currency.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (caller) => getSettings(caller),
  },
]
