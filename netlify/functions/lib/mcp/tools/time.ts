/**
 * Time tracking tools: entries, live timers and the clock.
 *
 * The write paths deliberately reuse the same arithmetic as the web app
 * (src/lib/supabaseDb.ts) — `computeTotalMinutes` / `computeEarnings` — so a
 * shift Claude clocks out is indistinguishable from one a worker clocks out in
 * the browser: same totals, same break handling, same midnight-crossing rule.
 */

import type { Caller, Permission } from '../session'
import { requirePermission, ToolError } from '../session'
import { type Args, limit, str, timestamp, timestampEnd, uuid } from '../args'
import { hours, list, money, type ListResult, workerNames, clientNames } from '../format'
import type { Tool } from './index'

/** Mirrors computeTotalMinutes() in src/lib/utils.ts (handles midnight). */
function computeTotalMinutes(start: Date, end: Date, breakMinutes: number): number {
  let diffMs = end.getTime() - start.getTime()
  if (diffMs < 0) diffMs += 24 * 60 * 60 * 1000
  const minutes = diffMs / 60000 - Math.max(0, breakMinutes)
  return Math.max(0, minutes)
}

function computeEarnings(totalMinutes: number, hourlyRate: number): number {
  return Math.round((totalMinutes / 60) * hourlyRate * 100) / 100
}

function fmtMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Elapsed working ms on a running timer, identical to timerElapsedMs(). */
function timerElapsedMs(timer: Record<string, unknown>, now: Date): number {
  const start = new Date(timer.start_time as string).getTime()
  const totalPause = Number(timer.total_pause_ms ?? 0)
  const prior = Number(timer.prior_worked_ms ?? 0)
  let segment = now.getTime() - start - totalPause
  if (timer.paused && timer.pause_start) {
    segment = new Date(timer.pause_start as string).getTime() - start - totalPause
  }
  return Math.max(0, prior + Math.max(0, segment))
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function listTimeEntries(caller: Caller, args: Args): Promise<ListResult> {
  const page = limit(args, 'limit', 50, 200)
  const workerId = uuid(args, 'worker_id')
  const clientId = uuid(args, 'client_id')
  const from = timestamp(args, 'from')
  const to = timestampEnd(args, 'to')
  const settled = args.settled

  let query = caller.sb
    .from('time_entries')
    .select(
      'id, worker_id, client_id, project, start_time, end_time, break_minutes, notes, hourly_rate, total_minutes, earnings, settled_at',
    )
    .order('start_time', { ascending: false })
    .limit(page + 1)

  if (workerId) query = query.eq('worker_id', workerId)
  if (clientId) query = query.eq('client_id', clientId)
  if (from) query = query.gte('start_time', from)
  if (to) query = query.lte('start_time', to)
  if (settled === true) query = query.not('settled_at', 'is', null)
  if (settled === false) query = query.is('settled_at', null)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const raw = (data ?? []) as Record<string, unknown>[]
  const names = await workerNames(caller, raw.map((r) => r.worker_id as string))
  const clients = await clientNames(caller, raw.map((r) => r.client_id as string | null))

  const rows = raw.map((e) => ({
    id: e.id,
    worker: names.get(e.worker_id as string) ?? 'Unknown worker',
    workerId: e.worker_id,
    client: e.client_id ? (clients.get(e.client_id as string) ?? null) : (e.project ?? null),
    startTime: e.start_time,
    endTime: e.end_time,
    hours: hours(Number(e.total_minutes ?? 0)),
    breakMinutes: Number(e.break_minutes ?? 0),
    hourlyRate: Number(e.hourly_rate ?? 0),
    earnings: money(Number(e.earnings ?? 0)),
    settled: Boolean(e.settled_at),
    notes: e.notes ?? null,
  }))

  return list(rows, {
    limit: page,
    hint: 'Results are newest first. Pass "from"/"to" (YYYY-MM-DD) to narrow the range.',
  })
}

async function listActiveTimers(caller: Caller): Promise<ListResult> {
  const { data, error } = await caller.sb
    .from('active_timers')
    .select('id, worker_id, client_id, project, start_time, session_start, prior_worked_ms, notes, hourly_rate, paused, pause_start, total_pause_ms')

  if (error) throw new Error(error.message)

  const raw = (data ?? []) as Record<string, unknown>[]
  const now = new Date()
  const names = await workerNames(caller, raw.map((r) => r.worker_id as string))
  const clients = await clientNames(caller, raw.map((r) => r.client_id as string | null))

  const rows = raw.map((t) => {
    const elapsedMs = timerElapsedMs(t, now)
    const elapsedMinutes = Math.round(elapsedMs / 60000)
    return {
      timerId: t.id,
      worker: names.get(t.worker_id as string) ?? 'Unknown worker',
      workerId: t.worker_id,
      client: t.client_id ? (clients.get(t.client_id as string) ?? null) : (t.project ?? null),
      clockedInAt: t.session_start ?? t.start_time,
      status: t.paused ? 'on break' : 'working',
      onBreakSince: t.paused ? (t.pause_start ?? null) : null,
      elapsed: fmtMinutes(elapsedMinutes),
      elapsedHours: hours(elapsedMinutes),
      earningsSoFar: money(computeEarnings(elapsedMinutes, Number(t.hourly_rate ?? 0))),
      notes: t.notes ?? null,
    }
  })

  return list(rows, { limit: 200, hint: 'Nobody else is on the clock.' })
}

async function summarizeTime(caller: Caller, args: Args): Promise<unknown> {
  const workerId = uuid(args, 'worker_id')
  const clientId = uuid(args, 'client_id')
  const from = timestamp(args, 'from')
  const to = timestampEnd(args, 'to')

  let query = caller.sb
    .from('time_entries')
    .select('worker_id, client_id, total_minutes, earnings, start_time')

  if (workerId) query = query.eq('worker_id', workerId)
  if (clientId) query = query.eq('client_id', clientId)
  if (from) query = query.gte('start_time', from)
  if (to) query = query.lte('start_time', to)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as Record<string, unknown>[]
  const names = await workerNames(caller, rows.map((r) => r.worker_id as string))
  const clients = await clientNames(caller, rows.map((r) => r.client_id as string | null))

  const byWorker = new Map<string, { worker: string; minutes: number; earnings: number; entries: number }>()
  const byClient = new Map<string, { client: string; minutes: number; earnings: number }>()
  let totalMinutes = 0
  let totalEarnings = 0

  for (const row of rows) {
    const minutes = Number(row.total_minutes ?? 0)
    const earnings = Number(row.earnings ?? 0)
    totalMinutes += minutes
    totalEarnings += earnings

    const wid = row.worker_id as string
    const workerName = names.get(wid) ?? 'Unknown worker'
    const workerEntry = byWorker.get(wid) ?? { worker: workerName, minutes: 0, earnings: 0, entries: 0 }
    workerEntry.minutes += minutes
    workerEntry.earnings += earnings
    workerEntry.entries += 1
    byWorker.set(wid, workerEntry)

    const cid = row.client_id as string | null
    const clientKey = cid ?? '__none__'
    const clientName = cid ? (clients.get(cid) ?? 'Unknown client') : 'No client'
    const clientEntry = byClient.get(clientKey) ?? { client: clientName, minutes: 0, earnings: 0 }
    clientEntry.minutes += minutes
    clientEntry.earnings += earnings
    byClient.set(clientKey, clientEntry)
  }

  return {
    range: { from: from ?? 'all time', to: to ?? 'now' },
    entries: rows.length,
    totalHours: hours(totalMinutes),
    totalEarnings: money(totalEarnings),
    byWorker: [...byWorker.values()]
      .map((w) => ({ worker: w.worker, hours: hours(w.minutes), earnings: money(w.earnings), entries: w.entries }))
      .sort((a, b) => b.hours - a.hours),
    byClient: [...byClient.values()]
      .map((c) => ({ client: c.client, hours: hours(c.minutes), earnings: money(c.earnings) }))
      .sort((a, b) => b.hours - a.hours),
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** The worker a write should act on: explicit id, or the caller's own record. */
async function targetWorker(caller: Caller, args: Args, permission: Permission): Promise<string> {
  const explicit = uuid(args, 'worker_id')
  if (!explicit) {
    if (caller.role === 'worker') {
      if (!caller.workerId) {
        throw new ToolError('This account is not linked to a worker record yet.')
      }
      return caller.workerId
    }
    throw new ToolError('Name the worker with "worker_id" (get it from list_workers).')
  }

  // An admin (or a granted worker) may act on someone else; a plain worker may
  // only ever act on themselves. RLS would reject the write anyway — this just
  // produces a clearer message.
  if (caller.role === 'worker' && explicit !== caller.workerId) {
    requirePermission(caller, permission)
  } else {
    requirePermission(caller, permission)
  }
  return explicit
}

async function clockIn(caller: Caller, args: Args): Promise<unknown> {
  const workerId = await targetWorker(caller, args, 'entries.manage')
  const clientId = uuid(args, 'client_id')
  const notes = str(args, 'notes')
  const startedAt = timestamp(args, 'start_time') ?? new Date().toISOString()

  // Every shift is booked to a client — the app refuses a clock-in without
  // one so no hours land in the ledger unattributed.
  if (!clientId) {
    const { count } = await caller.sb.from('clients').select('id', { count: 'exact', head: true })
    if ((count ?? 0) > 0) {
      throw new ToolError('"client_id" is required to clock in. Call list_clients to find the id.')
    }
  }

  const { data: existing } = await caller.sb
    .from('active_timers')
    .select('id, start_time')
    .eq('worker_id', workerId)
    .limit(1)

  if ((existing ?? []).length > 0) {
    throw new ToolError('This worker is already clocked in. Clock them out before starting a new shift.')
  }

  const { data: worker } = await caller.sb
    .from('workers')
    .select('hourly_rate')
    .eq('id', workerId)
    .maybeSingle()

  const row: Record<string, unknown> = {
    worker_id: workerId,
    start_time: startedAt,
    session_start: startedAt,
    prior_worked_ms: 0,
    notes: notes ?? null,
    hourly_rate: Number((worker as { hourly_rate?: number } | null)?.hourly_rate ?? 0),
    paused: false,
    pause_start: null,
    total_pause_ms: 0,
  }
  if (clientId) row.client_id = clientId

  const { data, error } = await caller.sb.from('active_timers').insert(row).select().single()
  if (error) throw new Error(error.message)

  const timer = data as Record<string, unknown>
  return {
    ok: true,
    timerId: timer.id,
    workerId,
    clockedInAt: timer.start_time,
    message: 'Clocked in. The timer is running — call clock_out to end the shift and save the entry.',
  }
}

async function clockOut(caller: Caller, args: Args): Promise<unknown> {
  const explicitTimer = uuid(args, 'timer_id')

  let query = caller.sb.from('active_timers').select('*')
  if (explicitTimer) query = query.eq('id', explicitTimer)
  else if (caller.role === 'worker' && caller.workerId) query = query.eq('worker_id', caller.workerId)
  else if (uuid(args, 'worker_id')) query = query.eq('worker_id', uuid(args, 'worker_id') as string)
  else throw new ToolError('Pass "timer_id" from list_active_timers, or a "worker_id".')

  const { data, error } = await query.limit(1)
  if (error) throw new Error(error.message)
  const timer = ((data ?? []) as Record<string, unknown>[])[0]
  if (!timer) throw new ToolError('No running timer found for that worker.')

  // Only an account that may manage entries can end a shift.
  requirePermission(caller, 'entries.manage')
  if (caller.role === 'worker' && timer.worker_id !== caller.workerId) {
    throw new ToolError('You can only clock out your own timer.')
  }

  const note = str(args, 'notes')
  const end = new Date()
  let totalPause = Number(timer.total_pause_ms ?? 0)
  if (timer.paused && timer.pause_start) {
    totalPause += end.getTime() - new Date(timer.pause_start as string).getTime()
  }
  const workingMs = Math.max(0, end.getTime() - new Date(timer.start_time as string).getTime() - totalPause)
  const totalMinutes = Math.max(0, Math.round(workingMs / 60000))
  const breakMinutes = Math.max(0, Math.round(totalPause / 60000))
  const rate = Number(timer.hourly_rate ?? 0)

  const entry: Record<string, unknown> = {
    worker_id: timer.worker_id,
    client_id: timer.client_id ?? null,
    project: timer.project ?? null,
    start_time: timer.start_time,
    end_time: end.toISOString(),
    break_minutes: breakMinutes,
    notes: [timer.notes ?? null, note ?? null].filter(Boolean).join('\n') || null,
    hourly_rate: rate,
    total_minutes: totalMinutes,
    earnings: computeEarnings(totalMinutes, rate),
  }

  const { data: inserted, error: insertError } = await caller.sb
    .from('time_entries')
    .insert(entry)
    .select()
    .single()
  if (insertError || !inserted) throw new Error(insertError?.message ?? 'Could not save the entry.')

  const { error: deleteError } = await caller.sb.from('active_timers').delete().eq('id', timer.id as string)
  if (deleteError) throw new Error(deleteError.message)

  const created = inserted as Record<string, unknown>
  const names = await workerNames(caller, [created.worker_id as string])
  return {
    ok: true,
    entryId: created.id,
    worker: names.get(created.worker_id as string) ?? 'Unknown worker',
    clockedInAt: created.start_time,
    clockedOutAt: created.end_time,
    hours: hours(Number(created.total_minutes ?? 0)),
    breakMinutes: Number(created.break_minutes ?? 0),
    earnings: money(Number(created.earnings ?? 0)),
    message: `Clocked out after ${fmtMinutes(Number(created.total_minutes ?? 0))}.`,
  }
}

async function setBreak(caller: Caller, args: Args, paused: boolean): Promise<unknown> {
  const explicitTimer = uuid(args, 'timer_id')
  let query = caller.sb.from('active_timers').select('*')
  if (explicitTimer) query = query.eq('id', explicitTimer)
  else if (caller.role === 'worker' && caller.workerId) query = query.eq('worker_id', caller.workerId)
  else if (uuid(args, 'worker_id')) query = query.eq('worker_id', uuid(args, 'worker_id') as string)
  else throw new ToolError('Pass "timer_id" from list_active_timers, or a "worker_id".')

  const { data, error } = await query.limit(1)
  if (error) throw new Error(error.message)
  const timer = ((data ?? []) as Record<string, unknown>[])[0]
  if (!timer) throw new ToolError('No running timer found for that worker.')

  if (caller.role === 'worker' && timer.worker_id !== caller.workerId) {
    throw new ToolError('You can only change your own break.')
  }
  requirePermission(caller, 'entries.manage')

  if (Boolean(timer.paused) === paused) {
    return { ok: true, message: paused ? 'Already on a break.' : 'Not on a break.' }
  }

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = paused
    ? { paused: true, pause_start: now }
    : {
        paused: false,
        pause_start: null,
        total_pause_ms:
          Number(timer.total_pause_ms ?? 0) +
          (timer.pause_start ? Date.now() - new Date(timer.pause_start as string).getTime() : 0),
      }

  const { error: updateError } = await caller.sb
    .from('active_timers')
    .update(patch)
    .eq('id', timer.id as string)
  if (updateError) throw new Error(updateError.message)

  return { ok: true, message: paused ? 'Break started.' : 'Break ended — the timer is running again.' }
}

async function createTimeEntry(caller: Caller, args: Args): Promise<unknown> {
  requirePermission(caller, 'entries.manage')
  const workerId = await targetWorker(caller, args, 'entries.manage')

  const start = timestamp(args, 'start_time')
  const end = timestamp(args, 'end_time')
  if (!start || !end) throw new ToolError('Both "start_time" and "end_time" are required.')

  const clientId = uuid(args, 'client_id')
  const notes = str(args, 'notes')
  const breakMinutes = Number(args.break_minutes ?? 0)

  const { data: worker } = await caller.sb
    .from('workers')
    .select('hourly_rate')
    .eq('id', workerId)
    .maybeSingle()

  const rate = Number(args.hourly_rate ?? (worker as { hourly_rate?: number } | null)?.hourly_rate ?? 0)
  const totalMinutes = Math.round(computeTotalMinutes(new Date(start), new Date(end), breakMinutes))
  if (totalMinutes <= 0) throw new ToolError('The end time must be after the start time.')

  const row: Record<string, unknown> = {
    worker_id: workerId,
    client_id: clientId ?? null,
    start_time: start,
    end_time: end,
    break_minutes: breakMinutes,
    notes: notes ?? null,
    hourly_rate: rate,
    total_minutes: totalMinutes,
    earnings: computeEarnings(totalMinutes, rate),
  }

  const { data, error } = await caller.sb.from('time_entries').insert(row).select().single()
  if (error) throw new Error(error.message)

  const created = data as Record<string, unknown>
  const names = await workerNames(caller, [workerId])
  return {
    ok: true,
    entryId: created.id,
    worker: names.get(workerId) ?? 'Unknown worker',
    hours: hours(Number(created.total_minutes ?? 0)),
    earnings: money(Number(created.earnings ?? 0)),
    message: `Added ${fmtMinutes(Number(created.total_minutes ?? 0))} for ${names.get(workerId) ?? 'the worker'}.`,
  }
}

async function updateTimeEntry(caller: Caller, args: Args): Promise<unknown> {
  requirePermission(caller, 'entries.manage')
  const entryId = uuid(args, 'entry_id')
  if (!entryId) throw new ToolError('"entry_id" is required.')

  const { data: current, error: readError } = await caller.sb
    .from('time_entries')
    .select('*')
    .eq('id', entryId)
    .maybeSingle()
  if (readError) throw new Error(readError.message)
  if (!current) throw new ToolError('No time entry found with that id (or you cannot see it).')

  const row = current as Record<string, unknown>
  const start = timestamp(args, 'start_time') ?? (row.start_time as string)
  const end = timestamp(args, 'end_time') ?? (row.end_time as string)
  const breakMinutes = args.break_minutes === undefined ? Number(row.break_minutes ?? 0) : Number(args.break_minutes)
  const rate = args.hourly_rate === undefined ? Number(row.hourly_rate ?? 0) : Number(args.hourly_rate)

  // Recompute totals whenever the numbers behind them change, so the ledger
  // never disagrees with the clock.
  const totalsTouched =
    args.start_time !== undefined || args.end_time !== undefined ||
    args.break_minutes !== undefined || args.hourly_rate !== undefined

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (args.start_time !== undefined) patch.start_time = start
  if (args.end_time !== undefined) patch.end_time = end
  if (args.break_minutes !== undefined) patch.break_minutes = breakMinutes
  if (args.hourly_rate !== undefined) patch.hourly_rate = rate
  if (args.client_id !== undefined) patch.client_id = uuid(args, 'client_id') ?? null
  if (args.notes !== undefined) patch.notes = str(args, 'notes') ?? null

  if (totalsTouched) {
    const totalMinutes = Math.round(computeTotalMinutes(new Date(start), new Date(end), breakMinutes))
    patch.total_minutes = totalMinutes
    patch.earnings = computeEarnings(totalMinutes, rate)
  }

  const { data, error } = await caller.sb
    .from('time_entries')
    .update(patch)
    .eq('id', entryId)
    .select()
    .single()
  if (error) throw new Error(error.message)

  const updated = data as Record<string, unknown>
  return {
    ok: true,
    entryId: updated.id,
    hours: hours(Number(updated.total_minutes ?? 0)),
    earnings: money(Number(updated.earnings ?? 0)),
    message: 'Time entry updated.',
  }
}

async function deleteTimeEntry(caller: Caller, args: Args): Promise<unknown> {
  requirePermission(caller, 'entries.manage')
  const entryId = uuid(args, 'entry_id')
  if (!entryId) throw new ToolError('"entry_id" is required.')

  const { error } = await caller.sb.from('time_entries').delete().eq('id', entryId)
  if (error) throw new Error(error.message)
  return { ok: true, message: 'Time entry deleted. This cannot be undone.' }
}

async function addEntryNote(caller: Caller, args: Args): Promise<unknown> {
  const entryId = uuid(args, 'entry_id')
  const body = str(args, 'body')
  if (!entryId) throw new ToolError('"entry_id" is required.')
  if (!body) throw new ToolError('"body" is required — the text of the note.')

  const { error } = await caller.sb.from('time_entry_comments').insert({
    entry_id: entryId,
    author_id: caller.userId,
    author_name: caller.displayName,
    author_role: caller.role,
    body,
  })
  if (error) throw new Error(error.message)
  return { ok: true, message: `Note added to the entry as ${caller.displayName}.` }
}

export const timeTools: Tool[] = [
  {
    name: 'list_time_entries',
    title: 'List time entries',
    description:
      'List recorded time: who worked, for which client, when, how long, and what it earned. Newest first. Filter by worker, client, date range, or whether the time has been settled (paid out).',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'Worker id from list_workers.' },
        client_id: { type: 'string', description: 'Client id from list_clients.' },
        from: { type: 'string', description: 'Start of range, YYYY-MM-DD or ISO timestamp.' },
        to: { type: 'string', description: 'End of range inclusive, YYYY-MM-DD or ISO timestamp.' },
        settled: { type: 'boolean', description: 'true = already paid out, false = still owed.' },
        limit: { type: 'number', description: 'Maximum rows (default 50, max 200).' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => listTimeEntries(caller, args),
  },
  {
    name: 'list_active_timers',
    title: "Who's on the clock",
    description:
      'Show every worker currently clocked in, what they are working on, how long they have been at it, and whether they are on a break. Use this to answer "who is working right now?".',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (caller) => listActiveTimers(caller),
  },
  {
    name: 'summarize_time',
    title: 'Summarize hours and earnings',
    description:
      'Aggregate recorded time into totals, with a breakdown per worker and per client. Use this for questions like "how many hours did everyone work last week?" instead of adding up raw entries.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'Restrict to one worker.' },
        client_id: { type: 'string', description: 'Restrict to one client.' },
        from: { type: 'string', description: 'Start of range, YYYY-MM-DD.' },
        to: { type: 'string', description: 'End of range inclusive, YYYY-MM-DD.' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => summarizeTime(caller, args),
  },
  {
    name: 'clock_in',
    title: 'Clock a worker in',
    description:
      'Start a worker\'s timer. Requires a client_id when the workspace has clients. A worker can only clock themselves in; managing entries is needed to clock someone else in.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'Worker id. Omit to clock in yourself.' },
        client_id: { type: 'string', description: 'Client id from list_clients.' },
        notes: { type: 'string', description: 'What the shift is for.' },
        start_time: { type: 'string', description: 'Backdate the clock-in (ISO). Defaults to now.' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => clockIn(caller, args),
  },
  {
    name: 'clock_out',
    title: 'Clock a worker out',
    description:
      'End a running shift: the elapsed time (minus breaks) is saved as a time entry and the timer is cleared. Requires the timer_id from list_active_timers, or a worker_id.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        timer_id: { type: 'string', description: 'Timer id from list_active_timers.' },
        worker_id: { type: 'string', description: 'Alternative to timer_id.' },
        notes: { type: 'string', description: 'Clock-out note added to the entry.' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => clockOut(caller, args),
  },
  {
    name: 'start_break',
    title: 'Start a break',
    description: 'Pause a running timer. The break stops counting toward worked hours.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        timer_id: { type: 'string', description: 'Timer id from list_active_timers.' },
        worker_id: { type: 'string', description: 'Alternative to timer_id.' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => setBreak(caller, args, true),
  },
  {
    name: 'end_break',
    title: 'End a break',
    description: 'Resume a paused timer. Time spent on the break is recorded and excluded from worked hours.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        timer_id: { type: 'string', description: 'Timer id from list_active_timers.' },
        worker_id: { type: 'string', description: 'Alternative to timer_id.' },
      },
      additionalProperties: false,
    },
    handler: (caller, args) => setBreak(caller, args, false),
  },
  {
    name: 'create_time_entry',
    title: 'Add a manual time entry',
    description:
      'Record time that was not tracked with the clock (a forgotten shift, a correction). Hours and earnings are computed from the start/end times minus breaks. Requires the entries.manage permission.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: 'Worker id from list_workers.' },
        start_time: { type: 'string', description: 'ISO timestamp or YYYY-MM-DD.' },
        end_time: { type: 'string', description: 'ISO timestamp or YYYY-MM-DD.' },
        client_id: { type: 'string', description: 'Client id from list_clients.' },
        break_minutes: { type: 'number', description: 'Break minutes to subtract. Default 0.' },
        hourly_rate: { type: 'number', description: 'Override the worker\'s rate.' },
        notes: { type: 'string' },
      },
      required: ['start_time', 'end_time'],
      additionalProperties: false,
    },
    handler: (caller, args) => createTimeEntry(caller, args),
  },
  {
    name: 'update_time_entry',
    title: 'Edit a time entry',
    description:
      'Change a time entry\'s times, break, client, rate or notes. Hours and earnings are recalculated automatically whenever the underlying numbers change. Requires the entries.manage permission.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'Entry id from list_time_entries.' },
        start_time: { type: 'string' },
        end_time: { type: 'string' },
        break_minutes: { type: 'number' },
        hourly_rate: { type: 'number' },
        client_id: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['entry_id'],
      additionalProperties: false,
    },
    handler: (caller, args) => updateTimeEntry(caller, args),
  },
  {
    name: 'delete_time_entry',
    title: 'Delete a time entry',
    description:
      'Permanently delete a recorded time entry. This cannot be undone and the time disappears from every report. Requires the entries.manage permission.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'Entry id from list_time_entries.' },
      },
      required: ['entry_id'],
      additionalProperties: false,
    },
    handler: (caller, args) => deleteTimeEntry(caller, args),
  },
  {
    name: 'add_entry_note',
    title: 'Add a note to a time entry',
    description:
      'Post a note onto a time entry — the same conversation workers and the admin use in the app. Visible to everyone who can see that entry.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'Entry id from list_time_entries.' },
        body: { type: 'string', description: 'The note text.' },
      },
      required: ['entry_id', 'body'],
      additionalProperties: false,
    },
    handler: (caller, args) => addEntryNote(caller, args),
  },
]
