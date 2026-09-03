/**
 * Clock in / break / clock out against the Work Tracker Supabase workspace.
 *
 * Every write here mirrors `src/lib/supabaseDb.ts` in the web app on purpose:
 * the same rows, the same rounding, the same notification wording. The admin
 * dashboard cannot tell whether a punch came from the web app, the phone app or
 * this extension — which is the whole point.
 *
 * Nothing here needs a service-role key. The schema's Row Level Security
 * already lets a signed-in worker insert their own `active_timers` row
 * (`active_timers_insert_worker`), update it for breaks, insert their own
 * `time_entries`, and post a notification to the workspace owner.
 */

import { isAuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js'
import type { ActiveTimer, NotificationType, TimeEntry, WorkerRow } from './types'
import { getClient, resetClient } from './supabase'
import { computeEarnings } from './format'

/** An error worth showing to the worker in the popup. */
export class ApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface Snapshot {
  worker: WorkerRow
  timer: ActiveTimer | null
  /** Completed entries logged since midnight. */
  todayMinutes: number
  todayEarnings: number
  currency: string
  businessName: string | null
}

export type ClockState =
  | { kind: 'not-configured' }
  | { kind: 'signed-out' }
  | { kind: 'ready'; snapshot: Snapshot }

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function friendlyError(error: unknown, fallback: string): ApiError {
  const raw = error && typeof error === 'object' && 'message' in error ? String((error as { message: string }).message) : ''

  if (/invalid login credentials/i.test(raw)) return new ApiError('Wrong email or password.')
  if (/email not confirmed/i.test(raw)) return new ApiError('This account has not confirmed its email address yet.')
  if (/failed to fetch|networkerror|fetch failed/i.test(raw)) {
    return new ApiError('Could not reach Supabase. Check your connection and the Project URL in Options.')
  }
  if (/row-level security/i.test(raw)) {
    return new ApiError(
      'Your workspace rejected that. Ask your administrator to re-run supabase/schema.sql in the Supabase SQL editor.',
    )
  }
  if (/JWT expired|token has expired/i.test(raw)) return new ApiError('Your session expired. Please sign in again.')

  return new ApiError(raw || fallback)
}

/**
 * Only ever store a client the caller can use; if the workspace has not been
 * configured yet this resolves to null and the popup shows the setup screen.
 */
async function requireClient(): Promise<SupabaseClient> {
  const client = await getClient()
  if (!client) throw new ApiError('Not connected. Open Options and add your Supabase URL and key.')
  return client
}

interface Identity {
  userId: string
  worker: WorkerRow
}

/**
 * Resolve the signed-in worker. Returns null when nobody is signed in (or the
 * session has expired), which the popup treats as "show the login form".
 */
async function identity(client: SupabaseClient): Promise<Identity | null> {
  const { data, error } = await client.auth.getUser()
  if (error) {
    // A dead network is not a sign-out. Surface it, so a worker who is offline
    // sees "could not reach Supabase" instead of a login form that makes them
    // think their shift was lost.
    if (isAuthRetryableFetchError(error)) throw friendlyError(error, 'Could not reach Supabase.')
    return null
  }
  if (!data?.user) return null
  const userId = data.user.id

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('user_id, role, worker_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (profileError) throw friendlyError(profileError, 'Could not load your account.')

  if (!profile) {
    throw new ApiError('This account is not part of a Work Tracker workspace.')
  }
  if (profile.role !== 'worker') {
    throw new ApiError('The Chrome extension is for worker accounts. Admins clock workers in from the web app.')
  }
  if (!profile.worker_id) {
    throw new ApiError('Your account is not linked to a worker profile yet. Ask your administrator to fix this.')
  }

  // RLS lets a worker read their own row (workers_select).
  const { data: worker, error: workerError } = await client
    .from('workers')
    .select('id, name, hourly_rate, status, position')
    .eq('id', profile.worker_id)
    .maybeSingle()

  if (workerError) throw friendlyError(workerError, 'Could not load your worker profile.')
  if (!worker) throw new ApiError('Your worker profile no longer exists. Please contact your administrator.')

  return { userId, worker: worker as WorkerRow }
}

/**
 * The worker's running timer, or null.
 *
 * A timer row is owned by the workspace admin (`user_id`) but points at the
 * worker (`worker_id`), so the web app looks for rows matching *either* — and
 * cleans up stale duplicates left by an interrupted session. Same self-heal
 * here, otherwise a leftover row would block clocking in forever.
 */
async function fetchTimer(client: SupabaseClient, identity: Identity): Promise<ActiveTimer | null> {
  const { data, error } = await client
    .from('active_timers')
    .select('*')
    .or(`worker_id.eq.${identity.worker.id},user_id.eq.${identity.userId}`)
    .order('start_time', { ascending: false })
    .limit(10)

  if (error) throw friendlyError(error, 'Could not load your timer.')

  const rows = (data as ActiveTimer[]) || []
  if (rows.length === 0) return null

  const [survivor, ...stale] = rows
  if (survivor.worker_id !== identity.worker.id) {
    const updated = await client
      .from('active_timers')
      .update({ worker_id: identity.worker.id })
      .eq('id', survivor.id)
      .select()
      .single()
    if (!updated.error && updated.data) survivor.worker_id = identity.worker.id
  }
  for (const row of stale) await client.from('active_timers').delete().eq('id', row.id)

  return survivor
}

/** Resolve the timer a break/clock-out call should act on. */
async function requireTimer(client: SupabaseClient, identity: Identity): Promise<ActiveTimer> {
  const timer = await fetchTimer(client, identity)
  if (!timer) throw new ApiError('You are not clocked in.')
  if (timer.worker_id !== identity.worker.id) throw new ApiError('That timer belongs to somebody else.')
  return timer
}

/**
 * Post a notification to the workspace admin so the bell in the web app shows
 * the punch. Best-effort only: a missing helper function or an old database
 * that predates a notification type must never fail the punch itself.
 */
async function notifyAdmin(
  client: SupabaseClient,
  row: { type: NotificationType; message: string; entry_id?: string | null },
): Promise<void> {
  const insert = async (payload: { type: NotificationType; entry_id: string | null; message: string }) =>
    client.from('notifications').insert({ user_id: await workspaceOwnerId(client), ...payload })

  try {
    // 23514 = the database predates this notification type (older workspaces
    // reject 'break_start' / 'break_end'). Deliver it as a plain note instead.
    let { error } = await insert({ type: row.type, message: row.message, entry_id: row.entry_id ?? null })
    if (error && (error as { code?: string }).code === '23514' && row.type !== 'note') {
      ;({ error } = await insert({ type: 'note', message: row.message, entry_id: row.entry_id ?? null }))
    }
    // The entry link is only a convenience. If it is what the database rejects,
    // deliver the notification without it rather than losing the alert.
    if (error && row.entry_id) {
      await insert({ type: row.type, message: row.message, entry_id: null })
    }
  } catch (err) {
    console.warn('[work-tracker] admin notification failed:', err)
  }
}

let cachedOwnerId: string | null = null

/** The admin user id that owns this workspace (SECURITY DEFINER helper). */
async function workspaceOwnerId(client: SupabaseClient): Promise<string | null> {
  if (cachedOwnerId) return cachedOwnerId
  // Workers cannot read the admin's profile row under RLS, so go through the
  // helper — exactly as the web app does. Falls back to the profile lookup for
  // databases that have not applied it.
  const { data, error } = await client.rpc('workspace_owner_id')
  if (!error && data) {
    cachedOwnerId = data as string
    return cachedOwnerId
  }
  const { data: profile } = await client.from('profiles').select('user_id').eq('role', 'admin').maybeSingle()
  cachedOwnerId = profile?.user_id ?? null
  return cachedOwnerId
}

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/** Everything the popup needs in one round of queries. */
export async function loadState(): Promise<ClockState> {
  const client = await getClient()
  if (!client) return { kind: 'not-configured' }

  const me = await identity(client)
  if (!me) return { kind: 'signed-out' }

  const [timer, today] = await Promise.all([fetchTimer(client, me), loadToday(client, me.worker)])

  return {
    kind: 'ready',
    snapshot: {
      worker: me.worker,
      timer,
      todayMinutes: today.minutes,
      todayEarnings: today.earnings,
      currency: today.currency,
      businessName: today.businessName,
    },
  }
}

async function loadToday(
  client: SupabaseClient,
  worker: WorkerRow,
): Promise<{ minutes: number; earnings: number; currency: string; businessName: string | null }> {
  const [{ data: entries }, { data: settings }] = await Promise.all([
    client
      .from('time_entries')
      .select('total_minutes, earnings')
      .eq('worker_id', worker.id)
      .gte('start_time', startOfToday().toISOString()),
    client.from('settings').select('currency, business_name').maybeSingle(),
  ])

  let minutes = 0
  let earnings = 0
  for (const entry of (entries || []) as Pick<TimeEntry, 'total_minutes' | 'earnings'>[]) {
    minutes += entry.total_minutes || 0
    earnings += entry.earnings || 0
  }

  return {
    minutes,
    earnings,
    currency: (settings as { currency?: string } | null)?.currency || 'USD',
    businessName: (settings as { business_name?: string } | null)?.business_name ?? null,
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  const client = await requireClient()
  const { error } = await client.auth.signInWithPassword({ email: email.trim(), password })
  if (error) throw friendlyError(error, 'Could not sign in.')
  cachedOwnerId = null
}

export async function signOut(): Promise<void> {
  cachedOwnerId = null
  const client = await getClient()
  if (client) await client.auth.signOut()
  resetClient()
}

/** Start the shift. Optional project / note, same as the web app's dialog. */
export async function clockIn(input: { project?: string; notes?: string }): Promise<ActiveTimer> {
  const client = await requireClient()
  const me = await requireIdentity(client)

  // Re-clocking in simply resumes an unfinished timer rather than dead-ending
  // on "already running" — same behaviour as the web app.
  const running = await fetchTimer(client, me)
  if (running) return running

  const project = input.project?.trim() || null
  const notes = input.notes?.trim() || null

  const { data, error } = await client
    .from('active_timers')
    .insert({
      worker_id: me.worker.id,
      project,
      start_time: new Date().toISOString(),
      notes,
      hourly_rate: me.worker.hourly_rate ?? 0,
      paused: false,
      pause_start: null,
      total_pause_ms: 0,
    })
    .select()
    .single()

  if (error) throw friendlyError(error, 'Could not clock in.')

  const timer = data as ActiveTimer
  const detail = [timer.project, timer.notes ? timer.notes.replace(/\s+/g, ' ').slice(0, 140) : null]
    .filter(Boolean)
    .join(' · ')
  await notifyAdmin(client, {
    type: 'time_in',
    message: `${me.worker.name} clocked in${detail ? ` — ${detail}` : ''}`,
  })

  return timer
}

/** Start a break (the timer freezes; the break counter starts). */
export async function startBreak(): Promise<ActiveTimer> {
  const client = await requireClient()
  const me = await requireIdentity(client)
  const timer = await requireTimer(client, me)
  if (timer.paused) return timer

  const { data, error } = await client
    .from('active_timers')
    .update({ paused: true, pause_start: new Date().toISOString() })
    .eq('id', timer.id)
    .select()
    .single()

  if (error) throw friendlyError(error, 'Could not start your break.')
  await notifyAdmin(client, { type: 'break_start', message: `${me.worker.name} started a break` })
  return data as ActiveTimer
}

/** Come back from a break (banked break time keeps accumulating). */
export async function endBreak(): Promise<ActiveTimer> {
  const client = await requireClient()
  const me = await requireIdentity(client)
  const timer = await requireTimer(client, me)
  if (!timer.paused) return timer

  const extra = timer.pause_start ? Date.now() - new Date(timer.pause_start).getTime() : 0
  const { data, error } = await client
    .from('active_timers')
    .update({
      paused: false,
      pause_start: null,
      total_pause_ms: (timer.total_pause_ms || 0) + extra,
    })
    .eq('id', timer.id)
    .select()
    .single()

  if (error) throw friendlyError(error, 'Could not end your break.')
  await notifyAdmin(client, { type: 'break_end', message: `${me.worker.name} is back from break` })
  return data as ActiveTimer
}

/** End the shift: write the time entry, clear the timer, tell the admin. */
export async function clockOut(note?: string): Promise<{ entry: TimeEntry; earnings: number }> {
  const client = await requireClient()
  const me = await requireIdentity(client)
  const timer = await requireTimer(client, me)

  const clockOutNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : null
  const end = new Date()

  let totalPause = timer.total_pause_ms || 0
  if (timer.paused && timer.pause_start) totalPause += end.getTime() - new Date(timer.pause_start).getTime()

  const workingMs = Math.max(0, end.getTime() - new Date(timer.start_time).getTime() - totalPause)
  const totalMinutes = Math.max(0, Math.round(workingMs / 60000))
  const breakMinutes = Math.max(0, Math.round(totalPause / 60000))
  const earnings = computeEarnings(totalMinutes, timer.hourly_rate ?? 0)

  const { data, error } = await client
    .from('time_entries')
    .insert({
      worker_id: timer.worker_id,
      project: timer.project || null,
      start_time: timer.start_time,
      end_time: end.toISOString(),
      break_minutes: breakMinutes,
      notes: [timer.notes, clockOutNote].filter(Boolean).join('\n') || null,
      hourly_rate: timer.hourly_rate ?? 0,
      total_minutes: totalMinutes,
      earnings,
    })
    .select()
    .single()

  if (error) throw friendlyError(error, 'Could not clock out. Your timer is still running.')

  await client.from('active_timers').delete().eq('id', timer.id)

  const entry = data as TimeEntry
  const parts = [formatMinutesShort(totalMinutes)]
  if (entry.project) parts.push(entry.project)
  parts.push(clockOutNote ? 'added a note' : 'no note')
  await notifyAdmin(client, {
    type: 'time_out',
    entry_id: entry.id,
    message: `${me.worker.name} clocked out — ${parts.join(' · ')}`,
  })

  return { entry, earnings }
}

function formatMinutesShort(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

async function requireIdentity(client: SupabaseClient): Promise<Identity> {
  const me = await identity(client)
  if (!me) throw new ApiError('Your session expired. Please sign in again.')
  return me
}
