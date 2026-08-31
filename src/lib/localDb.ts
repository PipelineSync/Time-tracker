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
  Role,
} from './types'
import type { BackendResult, DataBackend, CreateWorkerInput } from './backend'
import { buildDemoSeed } from './demoSeed'
import { uid, computeEarnings, computeTotalMinutes, formatMinutes, formatDate } from './utils'
import { storage } from './storage'

export const ADMIN_EMAIL = 'admin'
export const ADMIN_PASSWORD = 'admin.pipelinesync'

interface StoredUser {
  id: string
  email: string
  password: string
  role: Role
  workerId?: string | null
}

interface UserData {
  workers: Worker[]
  entries: TimeEntry[]
  activeTimer: ActiveTimer | null
  settings: Settings | null
  comments: TimeEntryComment[]
  notifications: AppNotification[]
  payments: Payment[]
}

const USERS_KEY = 'wt_users'
const SESSION_KEY = 'wt_session'
const dataKey = (userId: string) => `wt_data_${userId}`

function read<T>(key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  storage.setItem(key, JSON.stringify(value))
}

function readUsers(): StoredUser[] {
  return read<StoredUser[]>(USERS_KEY, [])
}

function writeUsers(users: StoredUser[]) {
  write(USERS_KEY, users)
}

function readData(userId: string): UserData {
  const empty: UserData = { workers: [], entries: [], activeTimer: null, settings: null, comments: [], notifications: [], payments: [] }
  const d = read<UserData>(dataKey(userId), empty)
  d.workers = d.workers || []
  d.entries = d.entries || []
  d.activeTimer = d.activeTimer || null
  d.settings = d.settings || null
  d.comments = d.comments || []
  d.notifications = d.notifications || []
  d.payments = d.payments || []
  return d
}

function writeData(userId: string, data: UserData) {
  write(dataKey(userId), data)
}

/** Ensure the single admin account exists (bootstrap). Returns the admin user. */
export function ensureAdmin(): StoredUser {
  const users = readUsers()
  const existing = users.find((u) => u.role === 'admin')
  if (existing) return existing
  const admin: StoredUser = {
    id: uid(),
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    role: 'admin',
  }
  users.push(admin)
  writeUsers(users)
  return admin
}

/** Workspace owner is always the admin. */
function getAdmin(): StoredUser {
  return ensureAdmin()
}

export function getSessionUser(): AuthUser | null {
  ensureAdmin()
  const session = read<{ userId: string } | null>(SESSION_KEY, null)
  if (!session) return null
  const users = readUsers()
  const u = users.find((x) => x.id === session.userId)
  if (!u) return null
  return { id: u.id, email: u.email, role: u.role, workerId: u.workerId ?? null }
}

/** Current user + admin workspace. All data lives in the admin's workspace. */
function ctx(): { user: AuthUser; admin: StoredUser; data: UserData } | null {
  const user = getSessionUser()
  if (!user) return null
  const admin = getAdmin()
  return { user, admin, data: readData(admin.id) }
}

function save(data: UserData) {
  const admin = getAdmin()
  writeData(admin.id, data)
}

function toAuth(u: StoredUser): AuthUser {
  return { id: u.id, email: u.email, role: u.role, workerId: u.workerId ?? null }
}

/** Auth user id for a worker row, or null if no account linked. */
function workerUserId(workerId: string): string | null {
  return readUsers().find((u) => u.workerId === workerId)?.id ?? null
}

function pushNotification(data: UserData, recipientUserId: string, n: Omit<AppNotification, 'id' | 'user_id' | 'read' | 'created_at'>) {
  data.notifications.push({
    id: uid(),
    user_id: recipientUserId,
    entry_id: n.entry_id,
    type: n.type,
    message: n.message,
    read: false,
    created_at: new Date().toISOString(),
  })
}

function workerName(data: UserData, workerId: string): string {
  return data.workers.find((w) => w.id === workerId)?.name || 'A worker'
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(amount)
  } catch {
    return `$${amount.toFixed(2)}`
  }
}

// Auto-seed the admin workspace on first login so the app isn't empty.
function maybeAutoSeed(data: UserData) {
  if (data.workers.length === 0 && data.entries.length === 0 && !data.settings) {
    const seed = buildDemoSeed()
    const users = readUsers()
    const seededWorkers: Worker[] = seed.workers.map((w) => ({ ...w, id: uid() }))
    const idMap = new Map(seed.workers.map((w, i) => [w.id, seededWorkers[i].id]))
    // Create a login account for each seeded worker so admin can demo worker logins.
    for (const w of seededWorkers) {
      if (!users.some((u) => u.email === w.email)) {
        users.push({
          id: uid(),
          email: w.email!,
          password: 'worker123',
          role: 'worker',
          workerId: w.id,
        })
      }
    }
    writeUsers(users)
    data.workers = seededWorkers
    data.entries = seed.entries.map((e) => ({ ...e, worker_id: idMap.get(e.worker_id) || e.worker_id, id: uid() }))
    data.settings = seed.settings
  }
}

export const localBackend: DataBackend = {
  kind: 'local',
  isAdminConfigured: () => true,

  async signIn(email, password) {
    ensureAdmin()
    const users = readUsers()
    const normalized = email.trim().toLowerCase()
    const u = users.find((x) => x.email === normalized && x.password === password)
    if (!u) return { data: null, error: 'Invalid username or password.' }
    write(SESSION_KEY, { userId: u.id })
    if (u.role === 'admin') {
      const data = readData(getAdmin().id)
      maybeAutoSeed(data)
      save(data)
    }
    return { data: toAuth(u), error: null }
  },

  async signOut() {
    storage.removeItem(SESSION_KEY)
  },

  async getSession() {
    ensureAdmin()
    const u = getSessionUser()
    if (u?.role === 'admin') {
      const data = readData(getAdmin().id)
      maybeAutoSeed(data)
      save(data)
    }
    return { data: u, error: null }
  },

  async resetPassword() {
    return { data: null, error: null }
  },

  async changePassword(currentPassword, newPassword) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const users = readUsers()
    const me = users.find((u) => u.id === c.user.id)
    if (!me) return { data: null, error: 'Account not found.' }
    if (me.password !== currentPassword) return { data: null, error: 'Current password is incorrect.' }
    if (newPassword === currentPassword) return { data: null, error: 'New password must be different.' }
    if (!newPassword || newPassword.length < 6) return { data: null, error: 'New password must be at least 6 characters.' }
    me.password = newPassword
    writeUsers(users)
    return { data: null, error: null }
  },

  async resetWorkerPassword(workerId, newPassword) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can reset worker passwords.' }
    const users = readUsers()
    const acc = users.find((u) => u.workerId === workerId)
    if (!acc) return { data: null, error: 'No login account linked to this worker.' }
    if (!newPassword || newPassword.length < 6) return { data: null, error: 'New password must be at least 6 characters.' }
    acc.password = newPassword
    writeUsers(users)
    return { data: null, error: null }
  },

  async listWorkers() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role === 'worker') {
      const w = c.data.workers.find((x) => x.id === c.user.workerId)
      return { data: w ? [w] : [], error: null }
    }
    return { data: [...c.data.workers].sort((a, b) => a.name.localeCompare(b.name)), error: null }
  },

  async createWorker(input: CreateWorkerInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can add workers.' }
    const now = new Date().toISOString()
    const worker: Worker = {
      id: uid(),
      name: input.name,
      email: input.email || input.accountEmail || null,
      hourly_rate: input.hourly_rate,
      status: input.status || 'active',
      created_at: now,
      updated_at: now,
    }
    c.data.workers.push(worker)
    // Create the worker's login account.
    const accountEmail = (input.accountEmail || input.email || '').trim().toLowerCase()
    if (accountEmail) {
      const users = readUsers()
      if (users.some((u) => u.email === accountEmail)) {
        return { data: null, error: 'A login account with that email already exists.' }
      }
      users.push({
        id: uid(),
        email: accountEmail,
        password: input.accountPassword || 'worker123',
        role: 'worker',
        workerId: worker.id,
      })
      writeUsers(users)
    }
    save(c.data)
    return { data: worker, error: null }
  },

  async updateWorker(id, patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can edit workers.' }
    const idx = c.data.workers.findIndex((w) => w.id === id)
    if (idx === -1) return { data: null, error: 'Worker not found.' }
    c.data.workers[idx] = { ...c.data.workers[idx], ...patch, updated_at: new Date().toISOString() }
    // If admin set a new password, update the linked account.
    const newPassword = (patch as { newPassword?: string }).newPassword
    if (newPassword) {
      const users = readUsers()
      const acc = users.find((u) => u.workerId === id)
      if (acc) {
        acc.password = newPassword
        writeUsers(users)
      }
    }
    save(c.data)
    return { data: c.data.workers[idx], error: null }
  },

  async getWorkerLogin(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can view login details.' }
    const worker = c.data.workers.find((w) => w.id === id)
    if (!worker) return { data: null, error: 'Worker not found.' }
    const acc = readUsers().find((u) => u.workerId === id)
    return { data: { email: acc?.email ?? worker.email ?? null, password: acc?.password ?? null }, error: null }
  },

  async deleteWorker(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can delete workers.' }
    c.data.workers = c.data.workers.filter((w) => w.id !== id)
    c.data.entries = c.data.entries.filter((e) => e.worker_id !== id)
    if (c.data.activeTimer && c.data.activeTimer.worker_id === id) c.data.activeTimer = null
    const entryIds = new Set(c.data.entries.map((e) => e.id))
    c.data.comments = c.data.comments.filter((cm) => entryIds.has(cm.entry_id))
    // Delete the worker's login account.
    const users = readUsers()
    writeUsers(users.filter((u) => u.workerId !== id))
    save(c.data)
    return { data: null, error: null }
  },

  async listEntries() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role === 'worker') {
      const mine = c.data.entries.filter((e) => e.worker_id === c.user.workerId)
      return { data: [...mine].sort((a, b) => b.start_time.localeCompare(a.start_time)), error: null }
    }
    return { data: [...c.data.entries].sort((a, b) => b.start_time.localeCompare(a.start_time)), error: null }
  },

  async createEntry(input) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can add manual entries.' }
    const now = new Date().toISOString()
    const entry: TimeEntry = {
      id: uid(),
      worker_id: input.worker_id,
      project: input.project || null,
      start_time: input.start_time,
      end_time: input.end_time,
      break_minutes: input.break_minutes,
      notes: input.notes || null,
      hourly_rate: input.hourly_rate,
      total_minutes: input.total_minutes,
      earnings: input.earnings,
      created_at: now,
      updated_at: now,
    }
    c.data.entries.push(entry)
    // Notify the worker that the admin added time for them.
    const wid = workerUserId(entry.worker_id)
    if (wid) {
      pushNotification(c.data, wid, {
        entry_id: entry.id,
        type: 'time_added',
        message: `${workerName(c.data, entry.worker_id)} — the admin added time for you (${formatMinutes(entry.total_minutes)})`,
      })
    }
    save(c.data)
    return { data: entry, error: null }
  },

  async updateEntry(id, patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can edit entries.' }
    const idx = c.data.entries.findIndex((e) => e.id === id)
    if (idx === -1) return { data: null, error: 'Entry not found.' }
    c.data.entries[idx] = { ...c.data.entries[idx], ...patch, updated_at: new Date().toISOString() }
    save(c.data)
    return { data: c.data.entries[idx], error: null }
  },

  async deleteEntry(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can delete entries.' }
    c.data.entries = c.data.entries.filter((e) => e.id !== id)
    c.data.comments = c.data.comments.filter((cm) => cm.entry_id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  async getActiveTimer() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role === 'worker') {
      const t = c.data.activeTimer && c.data.activeTimer.worker_id === c.user.workerId ? c.data.activeTimer : null
      return { data: t, error: null }
    }
    return { data: c.data.activeTimer, error: null }
  },

  async startTimer(input) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.data.activeTimer) return { data: null, error: 'A timer is already running.' }
    let workerId = input.worker_id
    let rate = input.hourly_rate
    if (c.user.role === 'worker') {
      // Workers can only clock in for themselves, at their admin-set rate.
      workerId = c.user.workerId || ''
      const w = c.data.workers.find((x) => x.id === workerId)
      if (!w) return { data: null, error: 'No worker profile linked to this account.' }
      rate = w.hourly_rate
    } else {
      const w = c.data.workers.find((x) => x.id === workerId)
      if (!w) return { data: null, error: 'Select a worker.' }
      rate = rate ?? w.hourly_rate
    }
    const timer: ActiveTimer = {
      id: uid(),
      worker_id: workerId,
      project: input.project || null,
      start_time: input.start_time || new Date().toISOString(),
      notes: input.notes || null,
      hourly_rate: rate ?? 0,
      paused: false,
      pause_start: null,
      total_pause_ms: 0,
      created_at: new Date().toISOString(),
    }
    c.data.activeTimer = timer
    // Notify the admin when a worker clocks in.
    if (c.user.role === 'worker') {
      pushNotification(c.data, c.admin.id, {
        entry_id: null,
        type: 'time_in',
        message: `${workerName(c.data, workerId)} clocked in`,
      })
    }
    save(c.data)
    return { data: timer, error: null }
  },

  async pauseTimer() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const t = c.data.activeTimer
    if (!t) return { data: null, error: 'No active timer.' }
    if (c.user.role === 'worker' && t.worker_id !== c.user.workerId) return { data: null, error: 'Not your timer.' }
    if (t.paused) return { data: t, error: null }
    t.paused = true
    t.pause_start = new Date().toISOString()
    save(c.data)
    return { data: t, error: null }
  },

  async resumeTimer() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const t = c.data.activeTimer
    if (!t) return { data: null, error: 'No active timer.' }
    if (c.user.role === 'worker' && t.worker_id !== c.user.workerId) return { data: null, error: 'Not your timer.' }
    if (!t.paused) return { data: t, error: null }
    if (t.pause_start) {
      t.total_pause_ms += new Date().getTime() - new Date(t.pause_start).getTime()
    }
    t.paused = false
    t.pause_start = null
    save(c.data)
    return { data: t, error: null }
  },

  async stopTimer(timerId) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const timer = c.data.activeTimer
    if (!timer || timer.id !== timerId) return { data: null, error: 'No active timer found.' }
    if (c.user.role === 'worker' && timer.worker_id !== c.user.workerId) return { data: null, error: 'Not your timer.' }
    const end = new Date()
    let totalPause = timer.total_pause_ms || 0
    if (timer.paused && timer.pause_start) {
      totalPause += end.getTime() - new Date(timer.pause_start).getTime()
    }
    const workingMs = Math.max(0, end.getTime() - new Date(timer.start_time).getTime() - totalPause)
    const totalMinutes = Math.max(0, Math.round(workingMs / 60000))
    const breakMinutes = Math.max(0, Math.round(totalPause / 60000))
    const rate = timer.hourly_rate ?? 0
    const entry: TimeEntry = {
      id: uid(),
      worker_id: timer.worker_id,
      project: timer.project || null,
      start_time: timer.start_time,
      end_time: end.toISOString(),
      break_minutes: breakMinutes,
      notes: timer.notes || null,
      hourly_rate: rate,
      total_minutes: totalMinutes,
      earnings: computeEarnings(totalMinutes, rate),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    c.data.entries.push(entry)
    c.data.activeTimer = null
    // Notify the admin when a worker clocks out.
    if (c.user.role === 'worker') {
      pushNotification(c.data, c.admin.id, {
        entry_id: entry.id,
        type: 'time_out',
        message: `${workerName(c.data, entry.worker_id)} clocked out — ${formatMinutes(entry.total_minutes)}`,
      })
    }
    save(c.data)
    return { data: entry, error: null }
  },

  async deleteTimer(timerId) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.data.activeTimer && c.data.activeTimer.id === timerId) {
      c.data.activeTimer = null
      save(c.data)
    }
    return { data: null, error: null }
  },

  async getSettings() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!c.data.settings) {
      c.data.settings = {
        id: 'settings-1',
        business_name: 'My Business',
        currency: 'USD',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        default_hourly_rate: 20,
      }
      save(c.data)
    }
    return { data: c.data.settings, error: null }
  },

  async saveSettings(patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can change settings.' }
    if (!c.data.settings) c.data.settings = { id: 'settings-1', business_name: 'My Business', currency: 'USD', timezone: 'UTC', default_hourly_rate: 20 }
    c.data.settings = { ...c.data.settings, ...patch }
    save(c.data)
    return { data: c.data.settings, error: null }
  },

  async listEntryComments(entryId) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const entry = c.data.entries.find((e) => e.id === entryId)
    if (!entry) return { data: null, error: 'Entry not found.' }
    if (c.user.role === 'worker' && entry.worker_id !== c.user.workerId) return { data: null, error: 'Not your entry.' }
    const comments = c.data.comments
      .filter((cm) => cm.entry_id === entryId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
    return { data: comments, error: null }
  },

  async addEntryComment(entryId, body) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const entry = c.data.entries.find((e) => e.id === entryId)
    if (!entry) return { data: null, error: 'Entry not found.' }
    if (c.user.role === 'worker' && entry.worker_id !== c.user.workerId) return { data: null, error: 'Not your entry.' }
    const comment: TimeEntryComment = {
      id: uid(),
      entry_id: entryId,
      author_id: c.user.id,
      author_name: c.user.role === 'admin' ? 'Admin' : workerName(c.data, entry.worker_id),
      author_role: c.user.role,
      body,
      created_at: new Date().toISOString(),
    }
    c.data.comments.push(comment)
    // Notify the other party.
    if (c.user.role === 'admin') {
      const wid = workerUserId(entry.worker_id)
      if (wid) {
        pushNotification(c.data, wid, {
          entry_id: entry.id,
          type: 'note',
          message: `Admin replied to your note on ${formatDate(entry.start_time)}`,
        })
      }
    } else {
      pushNotification(c.data, c.admin.id, {
        entry_id: entry.id,
        type: 'note',
        message: `${workerName(c.data, entry.worker_id)} added a note on ${formatDate(entry.start_time)}`,
      })
    }
    save(c.data)
    return { data: comment, error: null }
  },

  async listNotifications() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const mine = c.data.notifications
      .filter((n) => n.user_id === c.user.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    return { data: mine, error: null }
  },

  async markNotificationsRead() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    for (const n of c.data.notifications) {
      if (n.user_id === c.user.id) n.read = true
    }
    save(c.data)
    return { data: null, error: null }
  },

  async listPayments() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role === 'worker') {
      const mine = c.data.payments.filter((p) => p.worker_id === c.user.workerId)
      return { data: [...mine].sort((a, b) => b.created_at.localeCompare(a.created_at)), error: null }
    }
    return { data: [...c.data.payments].sort((a, b) => b.created_at.localeCompare(a.created_at)), error: null }
  },

  async settleWorker(workerId, note) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can settle worker time.' }
    const worker = c.data.workers.find((w) => w.id === workerId)
    if (!worker) return { data: null, error: 'Worker not found.' }
    const workerEntries = c.data.entries.filter((e) => e.worker_id === workerId)
    let totalMinutes = 0
    let earnings = 0
    for (const e of workerEntries) {
      totalMinutes += e.total_minutes
      earnings += e.earnings
    }
    const now = new Date()
    const payment: Payment = {
      id: uid(),
      worker_id: workerId,
      amount: Math.round(earnings * 100) / 100,
      hours: Math.round((totalMinutes / 60) * 100) / 100,
      status: 'unpaid',
      period_start: new Date(now.getTime() - (workerEntries.length ? 0 : 0)).toISOString(),
      period_end: now.toISOString(),
      created_at: now.toISOString(),
      paid_at: null,
      note: note || null,
    }
    c.data.payments.push(payment)
    // Reset the worker's tracked time by clearing their entries.
    c.data.entries = c.data.entries.filter((e) => e.worker_id !== workerId)
    c.data.comments = c.data.comments.filter((cm) => !workerEntries.some((e) => e.id === cm.entry_id))
    // Notify the worker.
    const wid = workerUserId(workerId)
    if (wid) {
      pushNotification(c.data, wid, {
        entry_id: null,
        type: 'payment',
        message: `A payment of ${formatMoney(payment.amount, c.data.settings?.currency || 'USD')} has been created for you`,
      })
    }
    save(c.data)
    return { data: payment, error: null }
  },

  async updatePaymentStatus(id, status) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can update payment status.' }
    const p = c.data.payments.find((x) => x.id === id)
    if (!p) return { data: null, error: 'Payment not found.' }
    p.status = status
    p.paid_at = status === 'paid' ? new Date().toISOString() : null
    // Notify the worker on status change.
    const wid = workerUserId(p.worker_id)
    if (wid) {
      pushNotification(c.data, wid, {
        entry_id: null,
        type: 'payment',
        message: `Your payment of ${formatMoney(p.amount, c.data.settings?.currency || 'USD')} is now ${status}`,
      })
    }
    save(c.data)
    return { data: p, error: null }
  },

  async deletePayment(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can delete payments.' }
    c.data.payments = c.data.payments.filter((p) => p.id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  async resetAll() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can delete data.' }
    save({ workers: [], entries: [], activeTimer: null, settings: null, comments: [], notifications: [], payments: [] })
    return { data: null, error: null }
  },

  async seedDemo() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can load sample data.' }
    const seed = buildDemoSeed()
    const seededWorkers: Worker[] = seed.workers.map((w) => ({ ...w, id: uid() }))
    const idMap = new Map(seed.workers.map((w, i) => [w.id, seededWorkers[i].id]))
    const users = readUsers()
    for (const w of seededWorkers) {
      if (w.email && !users.some((u) => u.email === w.email)) {
        users.push({ id: uid(), email: w.email, password: 'worker123', role: 'worker', workerId: w.id })
      }
    }
    writeUsers(users)
    save({
      workers: seededWorkers,
      entries: seed.entries.map((e) => ({ ...e, worker_id: idMap.get(e.worker_id) || e.worker_id, id: uid() })),
      activeTimer: null,
      settings: seed.settings,
      comments: [],
      notifications: [],
      payments: [],
    })
    return { data: null, error: null }
  },
}
