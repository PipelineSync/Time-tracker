import type {
  Worker,
  TimeEntry,
  ActiveTimer,
  Settings,
  AuthUser,
  TimeEntryComment,
  AppNotification,
  Payment,
  PaymentStatus,
} from './types'
import type { BackendResult, DataBackend, CreateWorkerInput } from './backend'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { computeEarnings, computeTotalMinutes, formatMinutes, formatDate } from './utils'

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

async function getAuthUser(): Promise<AuthUser | null> {
  const sb = client()
  const { data } = await sb.auth.getUser()
  if (!data?.user) return null
  let { data: profile } = await sb.from('profiles').select('role, worker_id').eq('user_id', data.user.id).maybeSingle()

  // Older worker accounts may have been created before the worker/profile link
  // was added. Repair that link once, server-side, using the authenticated email.
  if (!profile || (profile.role === 'worker' && !profile.worker_id)) {
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
        // Keep the existing profile state; the UI can still report a missing link.
      }
    }
  }

  return {
    id: data.user.id,
    email: data.user.email ?? '',
    role: profile?.role ?? 'admin',
    workerId: profile?.worker_id ?? null,
  }
}

async function requireUser(): Promise<BackendResult<AuthUser>> {
  const u = await getAuthUser()
  if (!u) return fail('Not signed in.')
  return ok(u)
}

/** The workspace admin's auth user id (the profile with role 'admin'). */
async function getAdminUserId(): Promise<string | null> {
  const { data } = await client().from('profiles').select('user_id').eq('role', 'admin').maybeSingle()
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

async function pushNotification(recipientUserId: string, n: { entry_id: string | null; type: AppNotification['type']; message: string }) {
  await client().from('notifications').insert({
    user_id: recipientUserId,
    entry_id: n.entry_id,
    type: n.type,
    message: n.message,
  })
}

export const supabaseBackend: DataBackend = {
  kind: 'supabase',
  isAdminConfigured: () => true,

  async signIn(email, password) {
    const sb = client()
    const { data, error } = await sb.auth.signInWithPassword({ email, password })
    if (error) return fail(error.message)
    const authUser = await getAuthUser()
    return ok(authUser || { id: data.user.id, email: data.user.email ?? email, role: 'admin', workerId: null })
  },

  async signOut() {
    await client().auth.signOut()
  },

  async getSession() {
    const u = await getAuthUser()
    return ok(u)
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
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role === 'worker' && me.data!.workerId) {
      const { data, error } = await client().from('active_timers').select('*').eq('worker_id', me.data!.workerId).maybeSingle()
      if (error) return fail(error.message)
      return ok(data as ActiveTimer | null)
    }
    const { data, error } = await client().from('active_timers').select('*').maybeSingle()
    if (error) return fail(error.message)
    return ok(data as ActiveTimer | null)
  },

  async startTimer(input) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const existing = await this.getActiveTimer()
    if (existing.data) return fail('A timer is already running.')
    let workerId = input.worker_id
    let rate = input.hourly_rate
    if (me.data!.role === 'worker') {
      workerId = me.data!.workerId || ''
      const { data: w } = await client().from('workers').select('hourly_rate').eq('id', workerId).single()
      rate = w?.hourly_rate ?? 0
    } else {
      const { data: w } = await client().from('workers').select('hourly_rate').eq('id', workerId).single()
      rate = rate ?? w?.hourly_rate ?? 0
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
    if (error) return fail(error.message)
    // Notify the admin when a worker clocks in.
    if (me.data!.role === 'worker') {
      const adminId = await getAdminUserId()
      if (adminId) await pushNotification(adminId, { entry_id: null, type: 'time_in', message: `${await workerName(workerId)} clocked in` })
    }
    return ok(data as ActiveTimer)
  },

  async pauseTimer() {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const { data: t } = await this.getActiveTimer()
    if (!t) return fail('No active timer.')
    if (me.data!.role === 'worker' && t.worker_id !== me.data!.workerId) return fail('Not your timer.')
    if (t.paused) return ok(t)
    const { data, error } = await client().from('active_timers').update({ paused: true, pause_start: new Date().toISOString() }).eq('id', t.id).select().single()
    if (error) return fail(error.message)
    return ok(data as ActiveTimer)
  },

  async resumeTimer() {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const { data: t } = await this.getActiveTimer()
    if (!t) return fail('No active timer.')
    if (me.data!.role === 'worker' && t.worker_id !== me.data!.workerId) return fail('Not your timer.')
    if (!t.paused) return ok(t)
    const extra = t.pause_start ? new Date().getTime() - new Date(t.pause_start).getTime() : 0
    const { data, error } = await client().from('active_timers').update({ paused: false, pause_start: null, total_pause_ms: (t.total_pause_ms || 0) + extra }).eq('id', t.id).select().single()
    if (error) return fail(error.message)
    return ok(data as ActiveTimer)
  },

  async stopTimer(timerId) {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    const { data: timer } = await client().from('active_timers').select('*').eq('id', timerId).single()
    if (!timer) return fail('No active timer found.')
    if (me.data!.role === 'worker' && timer.worker_id !== me.data!.workerId) return fail('Not your timer.')
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
      notes: timer.notes || null,
      hourly_rate: timer.hourly_rate ?? 0,
      total_minutes: totalMinutes,
      earnings: computeEarnings(totalMinutes, timer.hourly_rate ?? 0),
    }
    const { data, error } = await client().from('time_entries').insert(entry).select().single()
    if (error) return fail(error.message)
    await client().from('active_timers').delete().eq('id', timerId)
    const created = data as TimeEntry
    // Notify the admin when a worker clocks out.
    if (me.data!.role === 'worker') {
      const adminId = await getAdminUserId()
      if (adminId) await pushNotification(adminId, { entry_id: created.id, type: 'time_out', message: `${await workerName(created.worker_id)} clocked out — ${formatMinutes(created.total_minutes)}` })
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
    const { data: entries } = await sb.from('time_entries').select('*').eq('worker_id', workerId)
    let totalMinutes = 0
    let earnings = 0
    for (const e of (entries as TimeEntry[]) || []) {
      totalMinutes += e.total_minutes
      earnings += e.earnings
    }
    const now = new Date()
    const { data, error } = await sb.from('payments').insert({
      worker_id: workerId,
      amount: Math.round(earnings * 100) / 100,
      hours: Math.round((totalMinutes / 60) * 100) / 100,
      status: 'unpaid',
      period_end: now.toISOString(),
      note: note || null,
    }).select().single()
    if (error) return fail(error.message)
    // Reset the worker's tracked time by clearing their entries.
    await sb.from('time_entries').delete().eq('worker_id', workerId)
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
    await client().from('time_entries').delete().neq('id', '')
    await client().from('active_timers').delete().neq('id', '')
    await client().from('workers').delete().neq('id', '')
    return ok(null)
  },

  async seedDemo() {
    const me = await requireUser()
    if (me.error) return fail(me.error)
    if (me.data!.role !== 'admin') return fail('Only the admin can load sample data.')
    const sb = client()
    const { workers, entries, settings } = (await import('./demoSeed')).buildDemoSeed()
    for (const w of workers) {
      const { data } = await sb.from('workers').insert({ name: w.name, email: w.email, hourly_rate: w.hourly_rate, status: w.status }).select().single()
      const wid = data?.id as string
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
    return ok(null)
  },
}
