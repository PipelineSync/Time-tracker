import type {
  Worker,
  TimeEntry,
  ActiveTimer,
  Settings,
  AuthUser,
  TimeEntryComment,
  ChatMessage,
  ChatMember,
  AppNotification,
  Payment,
  PaymentStatus,
  Role,
} from './types'
import type { BackendResult, DataBackend, CreateWorkerInput } from './backend'
import { ACCOUNT_DEACTIVATED_MESSAGE, CHAT_MAX_LENGTH } from './backend'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { computeEarnings, computeTotalMinutes, formatMinutes, formatDate } from './utils'
import { chatNotificationText } from './chat'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined

export function isSupabaseConfigured(): boolean {
  return Boolean(url && anonKey)
}

function client(): SupabaseClient {
  if (!url || !anonKey) throw new Error('Supabase is not configured.')
  return createClient(url, anonKey)
}

function mapErr(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: string }).message)
  return 'Something went wrong.'
}

const ok = <T,>(data: T | null): BackendResult<T> => ({ data, error: null })
const fail = <T,>(error: string): BackendResult<T> => ({ data: null, error })

type AuthLookup =
  | { status: 'authenticated'; user: AuthUser }
  | { status: 'signed-out' }
  /** The auth user exists but no longer has a valid account in this workspace
   * (e.g. the admin deleted the worker). Login must be refused and any open
   * session signed out. */
  | { status: 'deactivated' }
  /** Could not verify the account (e.g. transient network error). Callers
   * should treat this as "keep the current state and retry later", never as
   * a deactivation. */
  | { status: 'unknown'; error: string }

export { ACCOUNT_DEACTIVATED_MESSAGE }

async function getAuthUser(): Promise<AuthLookup> {
  const sb = client()
  const { data, error } = await sb.auth.getUser()
  if (!data?.user) {
    return error ? { status: 'unknown', error: error.message } : { status: 'signed-out' }
  }
  const { data: profileData, error: profileError } = await sb
    .from('profiles')
    .select('role, worker_id')
    .eq('user_id', data.user.id)
    .maybeSingle()
  if (profileError) return { status: 'unknown', error: profileError.message }
  let profile = profileData

  // Older worker accounts may have been created before the worker/profile link
  // was added. Repair that link once, server-side, using the authenticated email.
  if (profile?.role === 'worker' && !profile.worker_id) {
    const session = await sb.auth.getSession()
    const accessToken = session.data.session?.access_token
    if (accessToken) {
      try {
        const response = await fetch('/.netlify/functions/sync-worker-profile', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (response.ok) {
          const repaired = await sb.from('profiles').select('role, worker_id').eq('user_id', data.user.id).maybeSingle()
          profile = repaired.data ?? profile
        }
      } catch {
        // Keep the existing profile state; the check below decides what to do.
      }
    }
  }

  if (!profile) {
    // No profile row: no confirmed role in this workspace. Both admin and
    // worker accounts are provisioned with a profile, so an account without
    // one is not a member (never fall back to 'admin').
    return { status: 'deactivated' }
  }
  if (profile.role === 'worker') {
    if (!profile.worker_id) {
      // The link could not be repaired — the worker was deleted or never
      // existed. This account must not be able to sign in.
      return { status: 'deactivated' }
    }
    // The profile points at a worker row that no longer exists → deleted.
    const { data: workerRow, error: workerError } = await sb
      .from('workers')
      .select('id')
      .eq('id', profile.worker_id)
      .maybeSingle()
    if (workerError) return { status: 'unknown', error: workerError.message }
    if (!workerRow) return { status: 'deactivated' }
  }

  return {
    status: 'authenticated',
    user: {
      id: data.user.id,
      email: data.user.email ?? '',
      role: profile.role === 'admin' ? 'admin' : 'worker',
      workerId: profile.worker_id ?? null,
    },
  }
}

async function requireUser(): Promise<BackendResult<AuthUser>> {
  const lookup = await getAuthUser()
  if (lookup.status !== 'authenticated') return fail('Not signed in.')
  return ok(lookup.user)
}

/** The workspace admin's auth user id for the signed-in user's workspace. */
async function getAdminUserId(): Promise<string | null> {
  const sb = client()
  // Workers cannot read the admin profile directly under RLS, so use the
  // SECURITY DEFINER helper from the schema/migration. Keep the old profile
  // lookup as a fallback for databases that have not applied the helper yet.
  const rpc = await sb.rpc('workspace_owner_id')
  if (!rpc.error && rpc.data) return rpc.data as string
  const { data } = await sb.from('profiles').select('user_id').eq('role', 'admin').maybeSingle()
  return data?.user_id ?? null
}

/** Auth user id linked to a worker row. */
async function getWorkerUserId(workerId: string): Promise<string | null> {
  const { data } = await client().from('profiles').select('user_id').eq('worker_id', workerId).maybeSingle()
  return data?.user_id ?? null
}

async function workerName(workerId: string): Promise<string> {
  const { data } = await client().from('workers').select('name').eq('id', workerId).single()
  return data?.name ?? 'A worker'
}

/** How the admin is identified in the team chat (picture comes from settings). */
const ADMIN_CHAT_NAME = 'Admin'
const ADMIN_CHAT_POSITION = 'Owner'

/** True when PostgREST says a database function is missing (schema not migrated). */
function isMissingDbFunction(error: { code?: string; message?: string } | null, fn: string): boolean {
  if (!error) return false
  return error.code === 'PGRST202' || new RegExp(`function ${fn}`, 'i').test(error.message ?? '')
}

/** True when PostgREST says a column is missing (schema not migrated). */
function isMissingColumn(error: { code?: string; message?: string } | null, column: string): boolean {
  if (!error) return false
  const message = error.message ?? ''
  if (!new RegExp(column, 'i').test(message)) return false
  // 42703 = undefined_column, PGRST204 = column not found in the schema cache.
  return error.code === '42703' || error.code === 'PGRST204' || /column/i.test(message)
}

/**
 * The worker's time that has not been settled yet, on a database that predates
 * `time_entries.settled_at` (supabase/settle-keeps-entries.sql not applied).
 * The newest settlement's period_end is the "already paid up to" boundary, so
 * settled time is not paid out twice even without the column.
 */
async function unsettledWithoutStampColumn(workerId: string): Promise<BackendResult<TimeEntry[]>> {
  const sb = client()
  const { data: entries, error } = await sb.from('time_entries').select('*').eq('worker_id', workerId)
  if (error) return fail(error.message)
  const rows = (entries as TimeEntry[]) ?? []
  const { data: lastPayment } = await sb
    .from('payments')
    .select('period_end')
    .eq('worker_id', workerId)
    .order('created_at', { ascending: false })
    .limit(1)
  const boundary = ((lastPayment as Array<{ period_end: string }> | null) ?? [])[0]?.period_end ?? null
  return ok(boundary ? rows.filter((e) => e.end_time > boundary) : rows)
}

/** Chat errors, with a readable hint when the chat tables have not been created. */
function chatTableHint(error: { code?: string; message?: string } | null): string {
  const message = error?.message ?? 'Something went wrong.'
  const missingTable = error?.code === '42P01' || (/chat_messages/i.test(message) && /does not exist|not find|relation/i.test(message))
  if (missingTable) {
    return 'The team chat is not set up in this database yet. Run supabase/chat-messages.sql once in the Supabase SQL editor to create it.'
  }
  return message
}

/** Identity a chat message is stamped with when the RPC is unavailable. */
async function chatAuthor(
  user: AuthUser
): Promise<{ name: string; role: Role; workerId: string | null; position: string | null; avatarUrl: string | null } | null> {
  const sb = client()
  if (user.role === 'admin') {
    const { data } = await sb.from('settings').select('avatar_url').maybeSingle()
    return {
      name: ADMIN_CHAT_NAME,
      role: 'admin',
      workerId: null,
      position: ADMIN_CHAT_POSITION,
      avatarUrl: (data as { avatar_url: string | null } | null)?.avatar_url ?? null,
    }
  }
  if (!user.workerId) return null
  const { data } = await sb
    .from('workers')
    .select('name, position, avatar_url')
    .eq('id', user.workerId)
    .maybeSingle()
  if (!data) return null
  const w = data as { name: string; position: string | null; avatar_url: string | null }
  return { name: w.name, role: 'worker', workerId: user.workerId, position: w.position ?? null, avatarUrl: w.avatar_url ?? null }
}

async function pushNotification(recipientUserId: string, n: { entry_id: string | null; type: AppNotification['type']; message: string }) {
  const insert = (row: { entry_id: string | null; type: AppNotification['type']; message: string }) =>
    client().from('notifications').insert({
      user_id: recipientUserId,
      entry_id: row.entry_id,
      type: row.type,
      message: row.message,
    })

  let { error } = await insert(n)

  // 23514 = check violation: the database predates this notification type
  // (e.g. break notifications before running supabase/add-break-notifications.sql).
  // Still deliver the message rather than silently dropping it.
  if (error && (error as { code?: string }).code === '23514' && n.type !== 'note') {
    ({ error } = await insert({ ...n, type: 'note' }))
  }

  // The entry reference is only a convenience link. If it is what the database
  // rejects (missing/unreadable row, FK violation), deliver the notification
  // without it instead of losing the alert entirely.
  if (error && n.entry_id) {
    ({ error } = await insert({ ...n, entry_id: null }))
  }

  if (error) console.warn('[notifications] could not deliver notification:', error.message)
}

/**
 * Notify everyone else in the workspace about a new team-chat message.
 *
 * Preferred path is one SECURITY DEFINER call (supabase/chat-notifications.sql)
 * that writes a row per recipient: under RLS a worker may only insert
 * notifications for themselves and the admin, so the function is what lets a
 * worker's message reach the rest of the team. On a database without it, the
 * client inserts what RLS allows — always the admin — and warns about the rest.
 */
async function notifyChatMessage(message: ChatMessage) {
  const sb = client()
  const rpc = await sb.rpc('notify_chat_message', { p_chat_id: message.id })
  if (!rpc.error) return
  const rpcError = rpc.error as { code?: string; message?: string }
  if (!isMissingDbFunction(rpcError, 'notify_chat_message')) {
    console.warn('[chat] could not notify the team:', rpcError.message)
    return
  }
  const members = await supabaseBackend.listChatMembers()
  for (const m of members.data ?? []) {
    if (!m.user_id || m.user_id === message.author_id) continue
    await pushNotification(m.user_id, { entry_id: null, type: 'chat', message: chatNotificationText(message) })
  }
}

/** Timer targeted by a pause/resume call: an explicit id, else the caller's own. */
async function resolveTimer(backend: DataBackend, timerId?: string): Promise<ActiveTimer | null> {
  if (timerId) {
    const { data } = await client().from('active_timers').select('*').eq('id', timerId).maybeSingle()
    return (data as ActiveTimer) ?? null
  }
  const { data } = await backend.getActiveTimer()
  return data ?? null
}

export const supabaseBackend: DataBackend = {
  kind: 'supabase',
  isAdminConfigured: () => true,

  async signIn(email, password) {
    const sb = client()
    const { error } = await sb.auth.signInWithPassword({ email, password })
    if (error) return fail(error.message)
    const lookup = await getAuthUser()
    if (lookup.status === 'deactivated') {
      // The credentials are valid in Supabase Auth, but the account no longer
      // exists in this workspace (e.g. the admin deleted the worker). Refuse
      // entry and drop the just-created session.
      await sb.auth.signOut()
      return fail(ACCOUNT_DEACTIVATED_MESSAGE)
    }
    if (lookup.status === 'authenticated') return ok(lookup.user)
    // signed-out / transient error — never fall back to a role guess.
    await sb.auth.signOut()
    return fail('Could not verify this account. Please try again.')
  },

  async signOut() {
    await client().auth.signOut()
  },

  async getSession() {
    const lookup = await getAuthUser()
    if (lookup.status === 'deactivated') {
      // Account was deleted (or otherwise deactivated) while signed in —
      // invalidate the local session. The ACCOUNT_DEACTIVATED_MESSAGE error
      // tells the store to sign the user out with a specific notice.
      await client().auth.signOut()
      return fail(ACCOUNT_DEACTIVATED_MESSAGE)
    }
    if (lookup.status === 'authenticated') return ok(lookup.user)
    if (lookup.status === 'signed-out') return ok<AuthUser>(null)
    // Transient error: keep the current session; the next tick will retry.
    return fail(lookup.error)
  },

  async resetPassword(email) {
    const sb = client()
    const { error } = await sb.auth.resetPasswordForEmail(email)
    if (error) return fail(error.message)
    return ok(null)
  },

  async changePassword(currentPassword, newPassword) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const sb = client()
    // Verify the current password before allowing a change.
    const email = me.data!.email
    const { error: verifyErr } = await sb.auth.signInWithPassword({ email, password: currentPassword })
    if (verifyErr) return fail('Current password is incorrect.')
    if (!newPassword || newPassword.length < 6) return fail('New password must be at least 6 characters.')
    const { error } = await sb.auth.updateUser({ password: newPassword })
    if (error) return fail(error.message)
    return ok(null)
  },

  async resetWorkerPassword(workerId, newPassword) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can reset worker passwords.')
    const { data: worker } = await client().from('workers').select('email').eq('id', workerId).single()
    if (!worker?.email) return fail('This worker has no email linked. Add an email to send a password reset.')
    // With the anon key only we cannot set another user's password directly;
    // send the worker a password reset email instead.
    const { error } = await client().auth.resetPasswordForEmail(worker.email)
    if (error) return fail(error.message)
    return ok(null)
  },

  async updateOwnProfile(patch) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'worker') return fail('Only workers can update their own profile here.')
    if (!me.data!.workerId) return fail('No worker account is linked to this user.')
    const avatarUrl = patch.avatar_url === undefined ? null : patch.avatar_url
    // The worker cannot UPDATE their own workers row under RLS (that would let
    // them change their hourly rate/status). Instead a SECURITY DEFINER RPC
    // (see supabase/worker-profile-picture.sql) updates only the profile
    // picture on the worker's own row.
    const { error: rpcErr } = await client().rpc('update_own_avatar', { new_avatar: avatarUrl })
    if (rpcErr) {
      // Give a friendly hint when the RPC is missing (database not migrated).
      if (/function update_own_avatar/.test(rpcErr.message) || rpcErr.code === 'PGRST202') {
        return fail('Saving your profile picture requires the database migration supabase/worker-profile-picture.sql to be applied.')
      }
      return fail(rpcErr.message)
    }
    const { data, error } = await client().from('workers').select('*').eq('id', me.data!.workerId).single()
    if (error) return fail(error.message)
    return ok(data as Worker)
  },

  async listWorkers() {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role === 'worker' && me.data!.workerId) {
      const { data, error } = await client().from('workers').select('*').eq('id', me.data!.workerId)
      if (error) return fail(error.message)
      return ok(data as Worker[])
    }
    const { data, error } = await client().from('workers').select('*').order('name')
    if (error) return fail(error.message)
    return ok(data as Worker[])
  },

  async createWorker(input: CreateWorkerInput) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can add workers.')

    const accountEmail = (input.accountEmail || input.email || '').trim().toLowerCase()
    if (!accountEmail) return fail('A login email is required.')
    if (!input.accountPassword || input.accountPassword.length < 6) return fail('Worker password must be at least 6 characters.')

    const auth = await client().auth.getSession()
    const accessToken = auth.data.session?.access_token
    if (!accessToken) return fail('Your session has expired. Please sign in again.')

    try {
      const response = await fetch('/.netlify/functions/create-worker', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          name: input.name.trim(),
          email: input.email?.trim() || accountEmail,
          hourly_rate: input.hourly_rate,
          status: input.status || 'active',
          position: input.position?.trim() || null,
          accountEmail,
          accountPassword: input.accountPassword,
        }),
      })
      const payload = await response.json().catch(() => ({})) as { worker?: Worker; error?: string }
      if (!response.ok) return fail(payload.error || 'Failed to create worker account.')
      return ok(payload.worker ?? null)
    } catch (e) {
      return fail(mapErr(e))
    }
  },

  async updateWorker(id, patch) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can edit workers.')
    const { newPassword, ...rest } = patch as { newPassword?: string } & Partial<Worker>
    const { data, error } = await client().from('workers').update(rest).eq('id', id).select().single()
    if (error) return fail(error.message)
    if (newPassword) {
      if (newPassword.length < 6) return fail('New password must be at least 6 characters.')
      const auth = await client().auth.getSession()
      const accessToken = auth.data.session?.access_token
      if (!accessToken) return fail('Your session has expired. Please sign in again.')
      try {
        const response = await fetch('/.netlify/functions/update-worker-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ workerId: id, newPassword }),
        })
        const payload = await response.json().catch(() => ({})) as { error?: string }
        if (!response.ok) return fail(payload.error || 'Failed to update worker password.')
      } catch (e) {
        return fail(mapErr(e))
      }
    }
    return ok(data as Worker)
  },

  async getWorkerLogin(id) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can view login details.')
    const { data: worker } = await client().from('workers').select('email').eq('id', id).single()
    if (!worker) return fail('Worker not found.')
    // Passwords are hashed in Supabase Auth and can never be read back.
    return ok({ email: worker.email ?? null, password: null })
  },

  async deleteWorker(id) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can delete workers.')

    // Preferred path: the privileged function also deletes the worker's
    // Supabase Auth account, which permanently disables their login and
    // invalidates every session they hold.
    const auth = await client().auth.getSession()
    const accessToken = auth.data.session?.access_token
    if (accessToken) {
      try {
        const response = await fetch('/.netlify/functions/delete-worker', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ workerId: id }),
        })
        const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string }
        // Only trust a real function response — an undeployed function falls
        // through to the SPA index.html (status 200, non-JSON), which must not
        // be treated as success.
        if (response.ok && payload && payload.ok === true) return ok(null)
        if (payload?.error) return fail(payload.error)
        throw new Error('The server did not confirm the deletion.')
      } catch (e) {
        // Fall through to the direct (data-only) fallback below.
        console.warn('[work-tracker] delete-worker function unavailable; using fallback.', e)
      }
    }

    // Fallback (older deployments without the function, e.g. Vercel): remove
    // the data rows directly. The deleted account is still blocked from
    // signing in by the deactivated-account check in getAuthUser().
    const { data: prof } = await client().from('profiles').select('user_id').eq('worker_id', id).maybeSingle()
    if (prof?.user_id) {
      await client().from('profiles').delete().eq('user_id', prof.user_id)
    }
    const { error } = await client().from('workers').delete().eq('id', id)
    if (error) return fail(error.message)
    return ok(null)
  },

  async listEntries() {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role === 'worker' && me.data!.workerId) {
      const { data, error } = await client().from('time_entries').select('*').eq('worker_id', me.data!.workerId).order('start_time', { ascending: false })
      if (error) return fail(error.message)
      return ok(data as TimeEntry[])
    }
    const { data, error } = await client().from('time_entries').select('*').order('start_time', { ascending: false })
    if (error) return fail(error.message)
    return ok(data as TimeEntry[])
  },

  async createEntry(input) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can add manual entries.')
    const totalMinutes = Math.max(0, Math.round(computeTotalMinutes(new Date(input.start_time), new Date(input.end_time), input.break_minutes)))
    const earnings = computeEarnings(totalMinutes, input.hourly_rate)
    const { data, error } = await client().from('time_entries').insert({ ...input, total_minutes: totalMinutes, earnings }).select().single()
    if (error) return fail(error.message)
    const entry = data as TimeEntry
    const wid = await getWorkerUserId(entry.worker_id)
    if (wid) {
      await pushNotification(wid, { entry_id: entry.id, type: 'time_added', message: `${await workerName(entry.worker_id)} — the admin added time for you (${formatMinutes(entry.total_minutes)})` })
    }
    return ok(entry)
  },

  async updateEntry(id, patch) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can edit entries.')
    let p: Partial<TimeEntry> = { ...patch }
    if (patch.start_time && patch.end_time && patch.break_minutes !== undefined && patch.hourly_rate !== undefined) {
      const totalMinutes = Math.max(0, Math.round(computeTotalMinutes(new Date(patch.start_time), new Date(patch.end_time), patch.break_minutes)))
      p = { ...p, total_minutes: totalMinutes, earnings: computeEarnings(totalMinutes, patch.hourly_rate) }
    }
    const { data, error } = await client().from('time_entries').update(p).eq('id', id).select().single()
    if (error) return fail(error.message)
    return ok(data as TimeEntry)
  },

  async deleteEntry(id) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can delete entries.')
    const { error } = await client().from('time_entries').delete().eq('id', id)
    if (error) return fail(error.message)
    return ok(null)
  },

  async getActiveTimer() {
    const res = await this.listActiveTimers()
    if (res.error) return fail(res.error)
    return ok((res.data || [])[0] ?? null)
  },

  async listActiveTimers() {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const sb = client()
    if (me.data!.role === 'worker' && me.data!.workerId) {
      const wid = me.data!.workerId
      // Fetch timers that belong to this worker OR occupy this auth user's
      // single-timer slot (unique index on user_id). A stale row whose
      // worker_id no longer matches the profile link would otherwise block
      // new clock-ins with an invisible "duplicate key" error.
      const { data, error } = await sb
        .from('active_timers')
        .select('*')
        .or(`worker_id.eq.${wid},user_id.eq.${me.data!.id}`)
        .order('start_time', { ascending: false })
        .limit(10)
      if (error) return fail(error.message)
      const rows = (data as ActiveTimer[]) || []
      if (rows.length === 0) return ok([])
      const [survivor, ...stale] = rows
      // Point the surviving timer at the worker's current row (the link may
      // have been repaired/re-created since it was started) and drop the rest.
      if (survivor.worker_id !== wid) {
        const upd = await sb.from('active_timers').update({ worker_id: wid }).eq('id', survivor.id).select().single()
        if (!upd.error && upd.data) survivor.worker_id = wid
      }
      for (const s of stale) await sb.from('active_timers').delete().eq('id', s.id)
      return ok([survivor])
    }
    // Admin: every worker currently on the clock, working or on break.
    const { data, error } = await sb.from('active_timers').select('*').order('start_time', { ascending: false })
    if (error) return fail(error.message)
    return ok((data as ActiveTimer[]) || [])
  },

  async startTimer(input) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    let workerId = input.worker_id
    let rate = input.hourly_rate
    if (me.data!.role === 'worker') {
      if (!me.data!.workerId) return fail('Your account is not linked to a worker profile yet. Please ask your administrator to fix this.')
      workerId = me.data!.workerId
      const { data: w } = await client().from('workers').select('hourly_rate').eq('id', workerId).single()
      rate = w?.hourly_rate ?? 0
    } else {
      const { data: w } = await client().from('workers').select('hourly_rate').eq('id', workerId).single()
      rate = rate ?? w?.hourly_rate ?? 0
    }
    // Only one timer per worker — but any number of workers can be clocked in
    // at the same time.
    const { data: running } = await client().from('active_timers').select('*').eq('worker_id', workerId).limit(1)
    const existing = ((running as ActiveTimer[]) || [])[0]
    if (existing) {
      // Workers clocking in again simply pick up their unfinished timer
      // instead of dead-ending on "already running".
      if (me.data!.role === 'worker') return ok(existing)
      return fail('That worker already has a running timer.')
    }
    const { data, error } = await client().from('active_timers').insert({
      worker_id: workerId,
      project: input.project || null,
      start_time: input.start_time || new Date().toISOString(),
      notes: input.notes || null,
      hourly_rate: rate ?? 0,
      paused: false,
      pause_start: null,
      total_pause_ms: 0,
    }).select().single()
    if (error) {
      // 23505 = unique violation on active_timers_one_per_worker: this
      // worker already has an unfinished timer row.
      if ((error as { code?: string }).code === '23505') {
        return fail('You have an unfinished timer from a previous session. Refresh the page to load it, then clock out before starting a new one.')
      }
      return fail(error.message)
    }
    // Notify the admin when a worker clocks in.
    if (me.data!.role === 'worker') {
      const adminId = await getAdminUserId()
      if (adminId) {
        const t = data as ActiveTimer
        const detail = [t.project ? t.project : null, t.notes ? t.notes.replace(/\s+/g, ' ').slice(0, 140) : null].filter(Boolean).join(' · ')
        await pushNotification(adminId, { entry_id: null, type: 'time_in', message: `${await workerName(workerId)} clocked in${detail ? ` — ${detail}` : ''}` })
      }
    }
    return ok(data as ActiveTimer)
  },

  async pauseTimer(timerId) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const t = await resolveTimer(this, timerId)
    if (!t) return fail('No active timer.')
    if (me.data!.role === 'worker' && t.worker_id !== me.data!.workerId) return fail('Not your timer.')
    if (t.paused) return ok(t)
    const { data, error } = await client().from('active_timers').update({ paused: true, pause_start: new Date().toISOString() }).eq('id', t.id).select().single()
    if (error) return fail(error.message)
    // Let the admin know the worker went on break.
    if (me.data!.role === 'worker') {
      const adminId = await getAdminUserId()
      if (adminId) await pushNotification(adminId, { entry_id: null, type: 'break_start', message: `${await workerName(t.worker_id)} started a break` })
    }
    return ok(data as ActiveTimer)
  },

  async resumeTimer(timerId) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const t = await resolveTimer(this, timerId)
    if (!t) return fail('No active timer.')
    if (me.data!.role === 'worker' && t.worker_id !== me.data!.workerId) return fail('Not your timer.')
    if (!t.paused) return ok(t)
    const extra = t.pause_start ? new Date().getTime() - new Date(t.pause_start).getTime() : 0
    const { data, error } = await client().from('active_timers').update({ paused: false, pause_start: null, total_pause_ms: (t.total_pause_ms || 0) + extra }).eq('id', t.id).select().single()
    if (error) return fail(error.message)
    if (me.data!.role === 'worker') {
      const adminId = await getAdminUserId()
      if (adminId) await pushNotification(adminId, { entry_id: null, type: 'break_end', message: `${await workerName(t.worker_id)} is back from break` })
    }
    return ok(data as ActiveTimer)
  },

  async stopTimer(timerId, note) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const { data: timer } = await client().from('active_timers').select('*').eq('id', timerId).single()
    if (!timer) return fail('No active timer found.')
    if (me.data!.role === 'worker' && timer.worker_id !== me.data!.workerId) return fail('Not your timer.')
    const clockOutNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : null
    const end = new Date()
    let totalPause = timer.total_pause_ms || 0
    if (timer.paused && timer.pause_start) totalPause += end.getTime() - new Date(timer.pause_start).getTime()
    const workingMs = Math.max(0, end.getTime() - new Date(timer.start_time).getTime() - totalPause)
    const totalMinutes = Math.max(0, Math.round(workingMs / 60000))
    const breakMinutes = Math.max(0, Math.round(totalPause / 60000))
    const entry = {
      worker_id: timer.worker_id,
      project: timer.project || null,
      start_time: timer.start_time,
      end_time: end.toISOString(),
      break_minutes: breakMinutes,
      notes: [timer.notes, clockOutNote].filter(Boolean).join('\n') || null,
      hourly_rate: timer.hourly_rate ?? 0,
      total_minutes: totalMinutes,
      earnings: computeEarnings(totalMinutes, timer.hourly_rate ?? 0),
    }
    const { data, error } = await client().from('time_entries').insert(entry).select().single()
    if (error) return fail(error.message)
    await client().from('active_timers').delete().eq('id', timerId)
    const created = data as TimeEntry
    // Notify the admin when a worker clocks out. This must happen whether or
    // not the worker left a note — the note only changes the wording.
    if (me.data!.role === 'worker') {
      try {
        const adminId = await getAdminUserId()
        if (adminId) {
          const parts = [formatMinutes(created.total_minutes)]
          if (created.project) parts.push(created.project)
          parts.push(clockOutNote ? 'added a note' : 'no note')
          await pushNotification(adminId, {
            entry_id: created.id,
            type: 'time_out',
            message: `${await workerName(created.worker_id)} clocked out — ${parts.join(' · ')}`,
          })
        } else {
          console.warn('[notifications] no admin account found for the clock-out notification')
        }
      } catch (err) {
        console.warn('[notifications] clock-out notification failed:', err)
      }
    }
    return ok(created)
  },

  async deleteTimer(timerId) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    await client().from('active_timers').delete().eq('id', timerId)
    return ok(null)
  },

  async getSettings() {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const { data, error } = await client().from('settings').select('*').maybeSingle()
    if (error) return fail(error.message)
    if (!data) {
      const def = { business_name: 'My Business', currency: 'USD', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', default_hourly_rate: 20 }
      const ins = await client().from('settings').insert(def).select().single()
      if (ins.error) return fail(ins.error.message)
      return ok(ins.data as Settings)
    }
    return ok(data as Settings)
  },

  async saveSettings(patch) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can change settings.')
    const cur = await this.getSettings()
    if (!cur.data) return fail('Settings not found.')
    const { data, error } = await client().from('settings').update(patch).eq('id', cur.data.id).select().single()
    if (error) return fail(error.message)
    return ok(data as Settings)
  },

  async listEntryComments(entryId) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const sb = client()
    const { data: entry } = await sb.from('time_entries').select('worker_id').eq('id', entryId).single()
    if (!entry) return fail('Entry not found.')
    if (me.data!.role === 'worker' && entry.worker_id !== me.data!.workerId) return fail('Not your entry.')
    const { data, error } = await sb.from('time_entry_comments').select('*').eq('entry_id', entryId).order('created_at', { ascending: true })
    if (error) return fail(error.message)
    return ok(data as TimeEntryComment[])
  },

  async addEntryComment(entryId, body) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const sb = client()
    const { data: entry } = await sb.from('time_entries').select('worker_id, start_time').eq('id', entryId).single()
    if (!entry) return fail('Entry not found.')
    if (me.data!.role === 'worker' && entry.worker_id !== me.data!.workerId) return fail('Not your entry.')
    const authorName = me.data!.role === 'admin' ? 'Admin' : await workerName(entry.worker_id)
    const { data, error } = await sb.from('time_entry_comments').insert({
      entry_id: entryId,
      author_id: me.data!.id,
      author_name: authorName,
      author_role: me.data!.role,
      body,
    }).select().single()
    if (error) return fail(error.message)
    // Notify the other party.
    if (me.data!.role === 'admin') {
      const wid = await getWorkerUserId(entry.worker_id)
      if (wid) await pushNotification(wid, { entry_id: entryId, type: 'note', message: `Admin replied to your note on ${formatDate(entry.start_time)}` })
    } else {
      const adminId = await getAdminUserId()
      if (adminId) await pushNotification(adminId, { entry_id: entryId, type: 'note', message: `${authorName} added a note on ${formatDate(entry.start_time)}` })
    }
    return ok(data as TimeEntryComment)
  },

  async listChatMessages(limit) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const max = Math.max(1, Math.min(Math.floor(limit ?? 200), 500))
    // RLS keeps this to the caller's workspace; everyone in it reads the same
    // timeline (the chat is not scoped per worker the way entries are).
    const { data, error } = await client()
      .from('chat_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(max)
    if (error) return fail(chatTableHint(error as { code?: string; message?: string }))
    // Asked for newest-first (so a limit keeps the tail), presented oldest-first.
    return ok([...((data as ChatMessage[]) ?? [])].reverse())
  },

  async sendChatMessage(body) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const text = body.trim()
    if (!text) return fail('Write a message first.')
    if (text.length > CHAT_MAX_LENGTH) return fail(`Message is too long (${CHAT_MAX_LENGTH} characters max).`)
    // Preferred path: an RPC that derives the author (name, role, picture) from
    // the authenticated user, so nobody can post as someone else.
    const rpc = await client().rpc('post_chat_message', { message_body: text })
    if (!rpc.error) {
      const message = rpc.data as ChatMessage
      await notifyChatMessage(message)
      return ok(message)
    }
    if (!isMissingDbFunction(rpc.error as { code?: string; message?: string }, 'post_chat_message')) {
      return fail(chatTableHint(rpc.error as { code?: string; message?: string }))
    }
    // Older database without the function. Only the admin may insert under the
    // chat RLS policies, so a worker is told to apply the migration instead of
    // being shown a raw row-level-security error.
    const migrationNeeded =
      'The team chat needs the supabase/chat-messages.sql migration on this database. Ask the workspace admin to run it once in the Supabase SQL editor.'
    if (me.data!.role !== 'admin') return fail(migrationNeeded)
    const author = await chatAuthor(me.data!)
    if (!author) return fail('No worker profile linked to this account.')
    const { data, error } = await client()
      .from('chat_messages')
      .insert({
        user_id: me.data!.id,
        author_id: me.data!.id,
        worker_id: author.workerId,
        author_name: author.name,
        author_role: author.role,
        author_position: author.position,
        author_avatar_url: author.avatarUrl,
        body: text,
      })
      .select()
      .single()
    if (error) return fail(`${chatTableHint(error as { code?: string; message?: string })} ${migrationNeeded}`)
    const posted = data as ChatMessage
    await notifyChatMessage(posted)
    return ok(posted)
  },

  async listChatMembers() {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    // A worker may not read other members' rows under RLS, so the authoritative
    // member list comes from a SECURITY DEFINER function that is limited to the
    // caller's own workspace and always includes the admin.
    const rpc = await client().rpc('workspace_members')
    if (!rpc.error && Array.isArray(rpc.data)) {
      const rows = rpc.data as Array<{
        worker_id: string | null
        user_id: string | null
        full_name: string
        member_role: Role
        member_position: string | null
        avatar_url: string | null
        worker_status: Worker['status'] | null
      }>
      const members: ChatMember[] = rows.map((r) => ({
        id: r.worker_id ?? `admin:${r.user_id}`,
        user_id: r.user_id,
        worker_id: r.worker_id,
        name: r.full_name,
        role: r.member_role === 'admin' ? 'admin' : 'worker',
        position: r.member_position ?? null,
        avatar_url: r.avatar_url ?? null,
        worker_status: r.member_role === 'admin' ? null : r.worker_status ?? 'active',
      }))
      // Admin first, then everyone else A→Z.
      return ok(members.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'admin' ? -1 : 1)))
    }
    if (rpc.error && !isMissingDbFunction(rpc.error as { code?: string; message?: string }, 'workspace_members')) {
      return fail((rpc.error as { code?: string; message?: string }).message ?? 'Could not load the member list.')
    }
    // Fallback for databases that have not applied supabase/chat-messages.sql:
    // build the list from what this role is allowed to read.
    const [workers, settingsRes, adminId] = await Promise.all([
      this.listWorkers(),
      client().from('settings').select('avatar_url').maybeSingle(),
      getAdminUserId(),
    ])
    const adminMember: ChatMember = {
      id: `admin:${adminId ?? 'workspace'}`,
      user_id: adminId,
      worker_id: null,
      name: ADMIN_CHAT_NAME,
      role: 'admin',
      position: ADMIN_CHAT_POSITION,
      avatar_url: (settingsRes.data as { avatar_url: string | null } | null)?.avatar_url ?? null,
      worker_status: null,
    }
    const workerMembers: ChatMember[] = (workers.data ?? []).map((w) => ({
      id: w.id,
      user_id: null,
      worker_id: w.id,
      name: w.name,
      role: 'worker' as Role,
      position: w.position ?? null,
      avatar_url: w.avatar_url ?? null,
      worker_status: w.status,
    }))
    return ok([adminMember, ...workerMembers])
  },

  async listNotifications() {

    const me = await requireUser()
    if (me.error) return fail(me.error)
    const { data, error } = await client().from('notifications').select('*').eq('user_id', me.data!.id).order('created_at', { ascending: false })
    if (error) return fail(error.message)
    return ok(data as AppNotification[])
  },

  async markNotificationsRead() {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const { error } = await client().from('notifications').update({ read: true }).eq('user_id', me.data!.id).eq('read', false)
    if (error) return fail(error.message)
    return ok(null)
  },

  async listPayments() {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role === 'worker' && me.data!.workerId) {
      const { data, error } = await client().from('payments').select('*').eq('worker_id', me.data!.workerId).order('created_at', { ascending: false })
      if (error) return fail(error.message)
      return ok(data as Payment[])
    }
    const { data, error } = await client().from('payments').select('*').order('created_at', { ascending: false })
    if (error) return fail(error.message)
    return ok(data as Payment[])
  },

  async settleWorker(workerId, note) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can settle worker time.')
    const sb = client()

    // Settling never deletes time entries: it pays out the worker's unsettled
    // entries and stamps them with settled_at, so they stay in Time Entries
    // (notes included) until someone deletes one by hand and the next
    // settlement only covers time worked since.
    //
    // `settled_at` needs supabase/settle-keeps-entries.sql. A database without
    // it is detected below and falls back to the previous settlement's
    // period_end as the "already paid" boundary — entries are still kept.
    const unsettledRes = await sb
      .from('time_entries')
      .select('*')
      .eq('worker_id', workerId)
      .is('settled_at', null)
    let entries: TimeEntry[]
    let canStamp = true
    if (!unsettledRes.error) {
      entries = (unsettledRes.data as TimeEntry[]) ?? []
    } else if (isMissingColumn(unsettledRes.error as { code?: string; message?: string }, 'settled_at')) {
      canStamp = false
      const legacy = await unsettledWithoutStampColumn(workerId)
      if (legacy.error) return fail(legacy.error)
      entries = legacy.data ?? []
    } else {
      return fail(unsettledRes.error.message)
    }
    if (entries.length === 0) return fail('This worker has no unsettled time to settle.')

    let totalMinutes = 0
    let earnings = 0
    let periodStart = entries[0].start_time
    let periodEnd = entries[0].end_time
    for (const e of entries) {
      totalMinutes += e.total_minutes
      earnings += e.earnings
      if (e.start_time < periodStart) periodStart = e.start_time
      if (e.end_time > periodEnd) periodEnd = e.end_time
    }
    const now = new Date()
    const { data, error } = await sb.from('payments').insert({
      user_id: me.data!.id,
      worker_id: workerId,
      amount: Math.round(earnings * 100) / 100,
      hours: Math.round((totalMinutes / 60) * 100) / 100,
      status: 'unpaid',
      period_start: periodStart,
      period_end: periodEnd,
      note: note || null,
    }).select().single()
    if (error) return fail(error.message)

    if (canStamp) {
      // Stamp exactly the entries that were paid for (by id, so time recorded
      // in the meantime is left for the next settlement).
      const { error: stampError } = await sb
        .from('time_entries')
        .update({ settled_at: (data as Payment).created_at ?? now.toISOString(), updated_at: now.toISOString() })
        .in('id', entries.map((e) => e.id))
      if (stampError) {
        console.warn('[settle] could not mark the settled entries:', stampError.message)
      }
    } else {
      console.warn(
        '[settle] time_entries.settled_at is missing — run supabase/settle-keeps-entries.sql ' +
          'so already-settled time is not paid out twice.'
      )
    }

    const wid = await getWorkerUserId(workerId)
    if (wid) await pushNotification(wid, { entry_id: null, type: 'payment', message: `A payment has been created for you` })
    return ok(data as Payment)
  },

  async updatePaymentStatus(id, status: PaymentStatus) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can update payment status.')
    const { data, error } = await client().from('payments').update({ status, paid_at: status === 'paid' ? new Date().toISOString() : null }).eq('id', id).select().single()
    if (error) return fail(error.message)
    const p = data as Payment
    const wid = await getWorkerUserId(p.worker_id)
    if (wid) await pushNotification(wid, { entry_id: null, type: 'payment', message: `Your payment is now ${status}` })
    return ok(p)
  },

  async updatePaymentNote(id, note: string | null) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can update payment notes.')
    const { data, error } = await client().from('payments').update({ note }).eq('id', id).select().single()
    if (error) return fail(error.message)
    return ok(data as Payment)
  },

  async deletePayment(id) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can delete payments.')
    const { error } = await client().from('payments').delete().eq('id', id)
    if (error) return fail(error.message)
    return ok(null)
  },

  async resetAll() {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can delete data.')

    // Preferred path: the privileged function also deletes every worker's
    // login account, so reset workers cannot sign in afterwards either.
    const auth = await client().auth.getSession()
    const accessToken = auth.data.session?.access_token
    if (accessToken) {
      try {
        const response = await fetch('/.netlify/functions/delete-worker', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ all: true }),
        })
        const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string }
        if (response.ok && payload && payload.ok === true) return ok(null)
        if (payload?.error) return fail(payload.error)
        throw new Error('The server did not confirm the reset.')
      } catch (e) {
        // Fall through to the direct (data-only) fallback below.
        console.warn('[work-tracker] delete-worker function unavailable; using fallback.', e)
      }
    }

    await client().from('time_entries').delete().neq('id', '')
    await client().from('active_timers').delete().neq('id', '')
    // Worker rows (and their chat messages, via the FK) go with the data. The
    // admin's own chat lines are cleared here, matching demo mode's reset.
    const chat = await client().from('chat_messages').delete().neq('id', '')
    if (chat.error) console.warn('[chat] could not clear chat messages on reset:', chat.error.message)
    await client().from('workers').delete().neq('id', '')
    return ok(null)
  },

  async seedDemo() {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can load sample data.')
    const sb = client()
    const { workers, entries, settings } = (await import('./demoSeed')).buildDemoSeed()
    const realIdBySeedId = new Map<string, string>()
    for (const w of workers) {
      const { data } = await sb.from('workers').insert({ name: w.name, email: w.email, hourly_rate: w.hourly_rate, status: w.status }).select().single()
      const wid = data?.id as string
      if (wid) realIdBySeedId.set(w.id, wid)
      for (const e of entries) {
        if (e.worker_id === w.id) {
          await sb.from('time_entries').insert({
            worker_id: wid, project: e.project, start_time: e.start_time, end_time: e.end_time,
            break_minutes: e.break_minutes, notes: e.notes, hourly_rate: e.hourly_rate,
            total_minutes: e.total_minutes, earnings: e.earnings,
          })
        }
      }
    }
    await sb.from('settings').insert({ business_name: settings.business_name, currency: settings.currency, timezone: settings.timezone, default_hourly_rate: settings.default_hourly_rate })
    // A short starter conversation in the team chat, credited to the seeded
    // workers (the sample data has no login accounts to author it otherwise).
    const { data: sampleWorkers } = await sb.from('workers').select('id, name, position, avatar_url')
    const byId = new Map<string, { id: string; name: string; position: string | null; avatar_url: string | null }>()
    for (const w of (sampleWorkers as Array<{ id: string; name: string; position: string | null; avatar_url: string | null }>) ?? []) byId.set(w.id, w)
    for (const line of (await import('./demoSeed')).buildDemoChat()) {
      const worker = line.worker_id ? byId.get(realIdBySeedId.get(line.worker_id) ?? '') ?? null : null
      await sb.from('chat_messages').insert({
        user_id: me.data!.id,
        author_id: me.data!.id,
        worker_id: worker?.id ?? null,
        author_name: worker?.name ?? ADMIN_CHAT_NAME,
        author_role: worker ? 'worker' : 'admin',
        author_position: worker ? worker.position ?? null : ADMIN_CHAT_POSITION,
        author_avatar_url: worker?.avatar_url ?? null,
        body: line.body,
        created_at: new Date(Date.now() - line.minutes_ago * 60_000).toISOString(),
      })
    }
    return ok(null)
  },
}
