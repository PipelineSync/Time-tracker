import type {
  Worker,
  TimeEntry,
  ActiveTimer,
  Settings,
  SlackSettings,
  AuthUser,
  TimeEntryComment,
  AppNotification,
  Payment,
  PaymentMethod,
  Role,
  WorkerAvatar,
  Task,
  TaskStatus,
  TaskPriority,
  Client,
  ClientColor,
  ClientStatus,
  ClientPriority,
  ClientPriorityLane,
  Meeting,
  Permission,
  FinanceItem,
  FinanceKind,
  FinanceStatus,
  BillingCycle,
} from './types'
import {
  CLIENT_COLORS,
  CLIENT_PRIORITY_LANES,
  DEFAULT_CLIENT_COLOR,
  DEFAULT_SLACK_SETTINGS,
  FINANCE_KINDS,
  PERMISSIONS,
  TEAM_VIEW_PERMISSIONS,
  ALL_ENTRIES_VIEW_PERMISSIONS,
  normalizePermissions,
  TASK_STATUSES,
  UNASSIGNED_CLIENT_NAME,
} from './types'
import type { DataBackend, CreateWorkerInput, CreateTaskInput, CreateClientInput, CreateFinanceItemInput, CreateMeetingInput } from './backend'
import { ACCOUNT_DEACTIVATED_MESSAGE } from './backend'
import { buildDemoSeed } from './demoSeed'
import { uid, computeEarnings, formatMinutes, formatDate } from './utils'
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
  /** Every timer currently running — one per worker, many at the same time. */
  activeTimers: ActiveTimer[]
  /** @deprecated legacy single-timer field, migrated into `activeTimers`. */
  activeTimer?: ActiveTimer | null
  settings: Settings | null
  comments: TimeEntryComment[]
  notifications: AppNotification[]
  payments: Payment[]
  /** Kanban tasks (see the Tasks page). */
  tasks: Task[]
  /** Client master list (admin-managed, see the Tasks page → Clients). */
  clients: Client[]
  /**
   * The client priority board's rows — which column + rank each ranked client
   * sits in. Clients without a row here are unranked (bottom of Low Priority).
   */
  clientPriorities: ClientPriority[]
  /** The meetings schedule (see the Meetings page). */
  meetings: Meeting[]
  /** Finance ledger: subscriptions, payroll runs and bills (see the Finance page). */
  financeItems: FinanceItem[]
}

const USERS_KEY = 'wt_users'
const SESSION_KEY = 'wt_session'
const dataKey = (userId: string) => `wt_data_${userId}`
const slackKey = (userId: string) => `wt_slack_${userId}`

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

function emptyData(): UserData {
  return { workers: [], entries: [], activeTimers: [], settings: null, comments: [], notifications: [], payments: [], tasks: [], clients: [], clientPriorities: [], meetings: [], financeItems: [] }
}

/** The method the admin paid a settlement with, or null when unknown/invalid. */
function normalizePaidMethod(method: unknown): PaymentMethod | null {
  return method === 'cash' || method === 'qr' ? method : null
}

function paymentMethodLabel(method: PaymentMethod): string {
  return method === 'cash' ? 'Cash' : 'QR Code'
}

/**
 * The reference / transaction number the admin typed when paying — trimmed,
 * capped (a GCash or bank reference is well under this) and null when blank,
 * so an empty box never saves an empty string.
 */
function normalizeReferenceNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, 64)
}

/** Payment methods a worker accepts — normalized for rows saved before this feature. */
function normalizePaymentMethods(methods: unknown): PaymentMethod[] {
  if (!Array.isArray(methods)) return []
  return methods.filter((m): m is PaymentMethod => m === 'cash' || m === 'qr')
}

/** Normalize a worker row loaded from storage (or the demo seed) to the current shape. */
function normalizeWorker(w: Worker): Worker {
  const payment_methods = normalizePaymentMethods(w.payment_methods)
  return {
    ...w,
    payment_methods,
    permissions: normalizePermissions(w.permissions),
    // A QR image only makes sense while the worker accepts QR payments.
    qr_code_url: payment_methods.includes('qr') ? (w.qr_code_url ?? null) : null,
  }
}

/** Valid board column, defaulting anything unknown/legacy to To Do. */
function normalizeTaskStatus(status: unknown): TaskStatus {
  return TASK_STATUSES.includes(status as TaskStatus) ? (status as TaskStatus) : 'todo'
}

function normalizeTaskPriority(priority: unknown): TaskPriority {
  return priority === 'low' || priority === 'high' ? priority : 'medium'
}

/** Normalize a task row loaded from storage to the current shape. */
function normalizeTask(t: Task): Task {
  const status = normalizeTaskStatus(t.status)
  return {
    ...t,
    status,
    priority: normalizeTaskPriority(t.priority),
    description: t.description ?? null,
    client_id: t.client_id ?? null,
    due_date: t.due_date ?? null,
    position: Number.isFinite(t.position) ? t.position : 0,
    created_by_role: t.created_by_role === 'admin' ? 'admin' : 'worker',
    completed_at: status === 'completed' ? (t.completed_at ?? t.updated_at ?? null) : null,
  }
}

/** Board order: by column position, then newest first as a tiebreaker. */
function sortTasks(rows: Task[]): Task[] {
  return [...rows].sort((a, b) => a.position - b.position || b.created_at.localeCompare(a.created_at))
}

/** Position that puts a task at the bottom of its worker's column. */
function nextTaskPosition(tasks: Task[], workerId: string, status: TaskStatus): number {
  const column = tasks.filter((t) => t.worker_id === workerId && t.status === status)
  return column.reduce((max, t) => Math.max(max, t.position), -1) + 1
}

/**
 * Re-number one worker's column so `movedId` sits at `index` and every other
 * card keeps its relative order with a gap-free position.
 */
function reindexTaskColumn(tasks: Task[], workerId: string, status: TaskStatus, movedId: string, index: number) {
  const column = sortTasks(tasks.filter((t) => t.worker_id === workerId && t.status === status && t.id !== movedId))
  const moved = tasks.find((t) => t.id === movedId)
  if (!moved) return
  const at = Math.max(0, Math.min(index, column.length))
  column.splice(at, 0, moved)
  column.forEach((t, i) => { t.position = i })
}

/** Valid colour tag, defaulting anything unknown to the first brand colour. */
function normalizeClientColor(color: unknown): ClientColor {
  return CLIENT_COLORS.includes(color as ClientColor) ? (color as ClientColor) : DEFAULT_CLIENT_COLOR
}

function normalizeClientStatus(status: unknown): ClientStatus {
  return status === 'inactive' ? 'inactive' : 'active'
}

function normalizeClient(c: Client): Client {
  return {
    ...c,
    name: (c.name ?? '').trim() || 'Client',
    color: normalizeClientColor(c.color),
    status: normalizeClientStatus(c.status),
  }
}

/** Clients A→Z with the inactive ones last — the order every list shows. */
function sortClients(rows: Client[]): Client[] {
  return [...rows].sort(
    (a, b) =>
      Number(a.status === 'inactive') - Number(b.status === 'inactive') ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )
}

/** The client's display name, or null when there is none / it is unknown. */
function clientName(d: UserData, clientId: string | null | undefined): string | null {
  if (!clientId) return null
  return d.clients.find((c) => c.id === clientId)?.name ?? null
}

// ---- Client priority board --------------------------------------------------
// One row per ranked client: which column (`lane`) and how high (`position`,
// smaller = higher). Clients without a row are unranked — the UI shows them at
// the bottom of Low Priority — so "reset the board" is just "delete every
// row", and brand-new clients appear on the board automatically.

/** Valid board column, defaulting anything unknown/legacy to Low Priority. */
function normalizeClientPriorityLane(lane: unknown): ClientPriorityLane {
  return CLIENT_PRIORITY_LANES.includes(lane as ClientPriorityLane) ? (lane as ClientPriorityLane) : 'low'
}

/** Normalize a priority row loaded from storage (or the demo seed). */
function normalizeClientPriority(p: ClientPriority): ClientPriority {
  return {
    ...p,
    lane: normalizeClientPriorityLane(p.lane),
    position: Number.isFinite(p.position) ? p.position : 0,
  }
}

/** Board order within a lane: by position, then newest first as a tiebreaker. */
function sortClientPriorities(rows: ClientPriority[]): ClientPriority[] {
  return [...rows].sort((a, b) => a.position - b.position || b.updated_at.localeCompare(a.updated_at))
}

/**
 * Re-number one lane so `clientId` sits at `index` and every other ranked
 * client keeps its relative order with a gap-free position.
 */
function reindexClientPriorityLane(rows: ClientPriority[], lane: ClientPriorityLane, clientId: string, index: number) {
  const laneRows = sortClientPriorities(rows.filter((p) => p.lane === lane && p.client_id !== clientId))
  const moved = rows.find((p) => p.client_id === clientId)
  if (!moved) return
  const at = Math.max(0, Math.min(index, laneRows.length))
  laneRows.splice(at, 0, moved)
  laneRows.forEach((p, i) => { p.position = i })
}

// ---- Meetings ---------------------------------------------------------------
// The schedule is one workspace-wide list. `meetings.view` opens it — the
// admin holds it by definition, a worker only when the admin ticks it.

/** Normalize a meeting loaded from storage (or the demo seed). */
function normalizeMeeting(m: Meeting): Meeting {
  // An invalid/missing start falls back to "now" rather than NaN-ing every
  // sort; the title is trimmed so blank rows cannot render as empty cards.
  const start = Number.isFinite(new Date(m.start_time).getTime()) ? m.start_time : new Date().toISOString()
  return {
    ...m,
    title: (m.title ?? '').trim() || 'Meeting',
    start_time: start,
    notes: m.notes ?? null,
  }
}

/** Upcoming ascending (soonest first); past descending (newest first). */
function sortMeetings(rows: Meeting[], now: number): Meeting[] {
  const upcoming = rows.filter((m) => new Date(m.start_time).getTime() >= now)
  const past = rows.filter((m) => new Date(m.start_time).getTime() < now)
  upcoming.sort((a, b) => a.start_time.localeCompare(b.start_time))
  past.sort((a, b) => b.start_time.localeCompare(a.start_time))
  return [...upcoming, ...past]
}

// ---- Finance ledger ---------------------------------------------------------
// One list of due-dated lines (subscription / payroll / bill). Rows are owned
// by the admin workspace like everything else; `finance.view` opens the read,
// `finance.manage` the writes — both admin-only until the admin grants them.

function normalizeFinanceKind(kind: unknown): FinanceKind | null {
  return FINANCE_KINDS.includes(kind as FinanceKind) ? (kind as FinanceKind) : null
}

function normalizeFinanceCycle(cycle: unknown): BillingCycle {
  return cycle === 'yearly' ? 'yearly' : 'monthly'
}

/** A status that fits the row's kind; anything else falls back to the default. */
function normalizeFinanceStatus(kind: FinanceKind, status: unknown): FinanceStatus {
  if (kind === 'subscription') return status === 'paused' ? 'paused' : 'active'
  return status === 'paid' ? 'paid' : 'unpaid'
}

/** 'YYYY-MM-DD' calendar date, or null when unparseable. */
function normalizeFinanceDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  return value
}

/** 'YYYY-MM' month bucket, or null. */
function normalizeFinanceMonth(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return null
  return value
}

/** Normalize a finance row loaded from storage to the current shape. */
function normalizeFinanceItem(f: FinanceItem): FinanceItem {
  const kind = normalizeFinanceKind(f.kind) ?? 'bill'
  const status = normalizeFinanceStatus(kind, f.status)
  // Only subscriptions carry an occurrence limit; a whole number of 1+.
  const max = kind === 'subscription' && Number.isFinite(f.max_occurrences) ? Math.floor(f.max_occurrences!) : null
  return {
    ...f,
    kind,
    name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : null,
    worker_id: kind === 'payroll' ? f.worker_id : null,
    amount: Number.isFinite(f.amount) ? Math.max(0, Math.round(f.amount * 100) / 100) : 0,
    cycle: kind === 'subscription' ? normalizeFinanceCycle(f.cycle) : null,
    period_month: kind === 'payroll' ? (normalizeFinanceMonth(f.period_month) ?? null) : null,
    due_date: normalizeFinanceDate(f.due_date) ?? new Date().toISOString().slice(0, 10),
    status,
    // The paid stamp only describes a completed payment.
    paid_at: status === 'paid' ? (f.paid_at ?? f.updated_at ?? new Date().toISOString()) : null,
    note: typeof f.note === 'string' && f.note.trim() ? f.note.trim() : null,
    max_occurrences: max !== null && max > 0 ? max : null,
    billed_count: Number.isFinite(f.billed_count) && f.billed_count > 0 ? Math.floor(f.billed_count) : 0,
  }
}

/**
 * A subscription whose due date was rolled forward has been billed once more.
 * Moving the date back (a correction) never counts, and when the count
 * reaches the limit the subscription pauses by itself.
 */
function applyBillingCount(current: FinanceItem, patch: Partial<FinanceItem>, next: FinanceItem): FinanceItem {
  if (current.kind !== 'subscription') return next
  const moved = patch.due_date !== undefined && (normalizeFinanceDate(patch.due_date) ?? '') > current.due_date
  if (!moved) return next
  const billedCount = current.billed_count + 1
  return {
    ...next,
    billed_count: billedCount,
    // The last bill on the counter ends the subscription — no one has to
    // remember to come back and switch it off.
    status: next.max_occurrences !== null && billedCount >= next.max_occurrences ? 'paused' : next.status,
  }
}

/** Oldest due dates first — the order of the ledger's agenda; tabs re-sort. */
function sortFinanceItems(rows: FinanceItem[]): FinanceItem[] {
  return [...rows].sort((a, b) => a.due_date.localeCompare(b.due_date) || b.created_at.localeCompare(a.created_at))
}

/** Keep a client reference only when it actually points at a known client. */
function resolveClientId(d: UserData, clientId: string | null | undefined): string | null {
  if (!clientId) return null
  return d.clients.some((c) => c.id === clientId) ? clientId : null
}

/**
 * One-time migration for workspaces that predate clients: everything without a
 * client is attached to a single "Unassigned" client so no task or entry is
 * left dangling (the admin can rename it, re-tag the work, or retire it).
 * Returns true when something changed and the workspace needs saving.
 */
function backfillClients(d: UserData): boolean {
  const orphanTasks = d.tasks.filter((t) => !t.client_id)
  const orphanEntries = d.entries.filter((e) => !e.client_id)
  if (orphanTasks.length === 0 && orphanEntries.length === 0) return false
  const now = new Date().toISOString()
  let fallback = d.clients.find((c) => c.name.trim().toLowerCase() === UNASSIGNED_CLIENT_NAME.toLowerCase())
  if (!fallback) {
    fallback = {
      id: uid(),
      name: UNASSIGNED_CLIENT_NAME,
      color: 'slate',
      status: 'active',
      created_at: now,
      updated_at: now,
    }
    d.clients.push(fallback)
  }
  for (const t of orphanTasks) t.client_id = fallback.id
  for (const e of orphanEntries) e.client_id = fallback.id
  return true
}

function readData(userId: string): UserData {
  const d = read<UserData>(dataKey(userId), emptyData())
  d.workers = (d.workers || []).map(normalizeWorker)
  d.entries = d.entries || []
  d.activeTimers = d.activeTimers || []
  // Migrate workspaces saved before multi-worker timers existed.
  if (d.activeTimer) {
    if (!d.activeTimers.some((t) => t.id === d.activeTimer!.id)) d.activeTimers.push(d.activeTimer)
    d.activeTimer = null
  }
  d.settings = d.settings || null
  d.comments = d.comments || []
  d.notifications = d.notifications || []
  d.payments = d.payments || []
  d.tasks = (d.tasks || []).map(normalizeTask)
  d.clients = (d.clients || []).map(normalizeClient)
  // Workspaces saved before the priority board simply load with no client
  // ranked — everything sits unranked at the bottom of Low Priority.
  d.clientPriorities = (d.clientPriorities || []).map(normalizeClientPriority)
  // Workspaces saved before the Meetings section simply load an empty schedule.
  d.meetings = (d.meetings || []).map(normalizeMeeting)
  // A client that was deleted should not keep a phantom place on the board.
  const clientIds = new Set(d.clients.map((c) => c.id))
  const beforePrune = d.clientPriorities.length
  d.clientPriorities = d.clientPriorities.filter((p) => clientIds.has(p.client_id))
  if (d.clientPriorities.length !== beforePrune) d.clientPriorities = d.clientPriorities.map((p) => ({ ...p }))
  // Workspaces saved before the Finance section simply load an empty ledger.
  d.financeItems = (d.financeItems || []).map(normalizeFinanceItem)
  d.entries = d.entries.map((e) => ({ ...e, client_id: e.client_id ?? null }))
  // Workspaces saved before clients existed get their work attached to the
  // "Unassigned" client the first time they are read.
  if (backfillClients(d)) write(dataKey(userId), d)
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

/** True while the worker row behind a login account still exists. */
function workerAccountStillValid(userId: string): boolean {
  const u = readUsers().find((x) => x.id === userId)
  if (!u) return false
  if (u.role !== 'worker') return true
  return readData(getAdmin().id).workers.some((w) => w.id === u.workerId)
}

export function getSessionUser(): AuthUser | null {
  ensureAdmin()
  const session = read<{ userId: string } | null>(SESSION_KEY, null)
  if (!session) return null
  const users = readUsers()
  const u = users.find((x) => x.id === session.userId)
  if (!u) return null
  if (!workerAccountStillValid(u.id)) return null
  return { id: u.id, email: u.email, role: u.role, workerId: u.workerId ?? null, permissions: permissionsOf(u) }
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
  return { id: u.id, email: u.email, role: u.role, workerId: u.workerId ?? null, permissions: permissionsOf(u) }
}

/**
 * Capabilities this account has. The admin owns the workspace and therefore
 * holds all of them; a worker holds exactly what the admin ticked on their row.
 */
function permissionsOf(u: { role: Role; workerId?: string | null }): Permission[] {
  if (u.role === 'admin') return [...PERMISSIONS]
  if (!u.workerId) return []
  const w = readData(getAdmin().id).workers.find((x) => x.id === u.workerId)
  return w ? normalizePermissions(w.permissions) : []
}

/** Does the signed-in account hold this capability? */
function can(c: { user: AuthUser }, permission: Permission): boolean {
  if (c.user.role === 'admin') return true
  return (c.user.permissions ?? []).includes(permission)
}

/** Anyone who sees team-wide data also needs the names behind it. */
function canSeeTeam(c: { user: AuthUser }): boolean {
  return TEAM_VIEW_PERMISSIONS.some((p) => can(c, p))
}

/**
 * Can this account read every worker's time entries? `reports.view` counts as
 * well as `entries.view_all`: a report is drawn from the team's entries, so
 * handing someone Reports means handing them the team's time (read-only).
 */
function canSeeAllEntries(c: { user: AuthUser }): boolean {
  return ALL_ENTRIES_VIEW_PERMISSIONS.some((p) => can(c, p))
}

/** Standard refusal, phrased for a worker who was not granted the capability. */
function denied(what: string) {
  return { data: null, error: `You do not have permission to ${what}.` }
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

/** The signed-in user's own timer (admin: the most recently started one). */
function ownTimer(c: { user: AuthUser; data: UserData }): ActiveTimer | null {
  if (c.user.role === 'worker') {
    return c.data.activeTimers.find((t) => t.worker_id === c.user.workerId) || null
  }
  return [...c.data.activeTimers].sort((a, b) => b.start_time.localeCompare(a.start_time))[0] || null
}

/** Resolve a timer by id, falling back to the caller's own timer. */
function findTimer(c: { user: AuthUser; data: UserData }, timerId?: string): ActiveTimer | null {
  if (timerId) return c.data.activeTimers.find((t) => t.id === timerId) || null
  return ownTimer(c)
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
    const seededClients: Client[] = seed.clients.map((cl) => ({ ...cl, id: uid() }))
    const clientMap = new Map(seed.clients.map((cl, i) => [cl.id, seededClients[i].id]))
    data.workers = seededWorkers
    data.clients = seededClients
    data.entries = seed.entries.map((e) => ({
      ...e,
      worker_id: idMap.get(e.worker_id) || e.worker_id,
      client_id: e.client_id ? clientMap.get(e.client_id) ?? null : null,
      id: uid(),
    }))
    data.tasks = seed.tasks.map((t) => ({
      ...t,
      worker_id: idMap.get(t.worker_id) || t.worker_id,
      client_id: t.client_id ? clientMap.get(t.client_id) ?? null : null,
      id: uid(),
    }))
    data.financeItems = seed.financeItems.map((f) => ({
      ...f,
      worker_id: f.worker_id ? idMap.get(f.worker_id) ?? null : null,
      id: uid(),
    }))
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
    if (!workerAccountStillValid(u.id)) {
      // The worker row was deleted (or data was reset) — the login must no
      // longer work.
      return { data: null, error: ACCOUNT_DEACTIVATED_MESSAGE }
    }
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
    if (!can(c, 'workers.manage')) return denied('reset worker passwords')
    const users = readUsers()
    const acc = users.find((u) => u.workerId === workerId)
    if (!acc) return { data: null, error: 'No login account linked to this worker.' }
    if (!newPassword || newPassword.length < 6) return { data: null, error: 'New password must be at least 6 characters.' }
    acc.password = newPassword
    writeUsers(users)
    return { data: null, error: null }
  },

  async updateOwnProfile(patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'worker') return { data: null, error: 'Only workers can update their own profile here.' }
    if (!c.user.workerId) return { data: null, error: 'No worker account is linked to this user.' }
    const idx = c.data.workers.findIndex((w) => w.id === c.user.workerId)
    if (idx === -1) return { data: null, error: 'Worker not found.' }
    const next: Worker = {
      ...c.data.workers[idx],
      // Only ever touch the profile picture — never the worker's rate, status,
      // name, etc., which are managed by the admin.
      avatar_url: patch.avatar_url === undefined ? c.data.workers[idx].avatar_url : patch.avatar_url,
      updated_at: new Date().toISOString(),
    }
    c.data.workers[idx] = next
    save(c.data)
    return { data: next, error: null }
  },

  async updateOwnPaymentMethods(patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'worker') return { data: null, error: 'Only workers can update their payment methods here.' }
    if (!c.user.workerId) return { data: null, error: 'No worker account is linked to this user.' }
    const idx = c.data.workers.findIndex((w) => w.id === c.user.workerId)
    if (idx === -1) return { data: null, error: 'Worker not found.' }
    // Only ever touch payment fields — never the worker's rate, status,
    // name, avatar, etc., which are managed by the admin.
    const methods = normalizePaymentMethods(patch.payment_methods)
    if (methods.length === 0) return { data: null, error: 'Choose at least one payment method.' }
    const qrEnabled = methods.includes('qr')
    const qrCodeUrl = qrEnabled ? (patch.qr_code_url === undefined ? c.data.workers[idx].qr_code_url : patch.qr_code_url) : null
    if (qrEnabled && !qrCodeUrl) {
      return { data: null, error: 'Upload your QR code image to accept QR Code payments.' }
    }
    const next: Worker = {
      ...c.data.workers[idx],
      payment_methods: methods,
      qr_code_url: qrCodeUrl,
      updated_at: new Date().toISOString(),
    }
    c.data.workers[idx] = next
    save(c.data)
    return { data: normalizeWorker(next), error: null }
  },

  async listWorkers() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    // The background poll excludes the image columns (avatar + QR data URLs
    // are the heaviest fields on the row). The UI merges the separately
    // fetched snapshot from listWorkerAvatars() back in.
    const stripImages = (w: Worker): Worker => ({ ...w, avatar_url: null, qr_code_url: null })
    // A worker with no team-wide capability only ever sees their own row.
    if (!canSeeTeam(c)) {
      const w = c.data.workers.find((x) => x.id === c.user.workerId)
      return { data: w ? [stripImages(w)] : [], error: null }
    }
    return { data: [...c.data.workers].sort((a, b) => a.name.localeCompare(b.name)).map(stripImages), error: null }
  },

  async listWorkerAvatars() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const rows: WorkerAvatar[] = canSeeTeam(c)
      ? c.data.workers
      : c.data.workers.filter((w) => w.id === c.user.workerId)
    return {
      data: rows.map((w) => ({ id: w.id, avatar_url: w.avatar_url ?? null, qr_code_url: w.qr_code_url ?? null })),
      error: null,
    }
  },

  async createWorker(input: CreateWorkerInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'workers.manage')) return denied('add workers')
    const now = new Date().toISOString()
    const worker: Worker = {
      id: uid(),
      name: input.name,
      email: input.email || input.accountEmail || null,
      hourly_rate: input.hourly_rate,
      status: input.status || 'active',
      position: input.position || null,
      avatar_url: null,
      payment_methods: [],
      qr_code_url: null,
      permissions: normalizePermissions(input.permissions),
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
    if (!can(c, 'workers.manage')) return denied('edit workers')
    const idx = c.data.workers.findIndex((w) => w.id === id)
    if (idx === -1) return { data: null, error: 'Worker not found.' }
    c.data.workers[idx] = { ...c.data.workers[idx], ...patch, updated_at: new Date().toISOString() }
    if (patch.permissions) c.data.workers[idx].permissions = normalizePermissions(patch.permissions)
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
    if (!can(c, 'workers.manage')) return denied('view login details')
    const worker = c.data.workers.find((w) => w.id === id)
    if (!worker) return { data: null, error: 'Worker not found.' }
    const acc = readUsers().find((u) => u.workerId === id)
    return { data: { email: acc?.email ?? worker.email ?? null, password: acc?.password ?? null }, error: null }
  },

  async deleteWorker(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'workers.manage')) return denied('delete workers')
    c.data.workers = c.data.workers.filter((w) => w.id !== id)
    c.data.entries = c.data.entries.filter((e) => e.worker_id !== id)
    c.data.activeTimers = c.data.activeTimers.filter((t) => t.worker_id !== id)
    c.data.tasks = c.data.tasks.filter((t) => t.worker_id !== id)
    // Payroll lines die with the worker (mirrors the Supabase FK cascade).
    c.data.financeItems = c.data.financeItems.filter((f) => !(f.kind === 'payroll' && f.worker_id === id))
    const entryIds = new Set(c.data.entries.map((e) => e.id))
    c.data.comments = c.data.comments.filter((cm) => entryIds.has(cm.entry_id))
    // Delete the worker's login account.
    const users = readUsers()
    writeUsers(users.filter((u) => u.workerId !== id))
    save(c.data)
    return { data: null, error: null }
  },

  async listEntries(opts) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    // Scoped to the worker's own rows unless they read the whole team's time
    // — either outright (`entries.view_all`) or because they were granted
    // Reports, which is built out of everyone's entries (`reports.view`).
    let rows = !canSeeAllEntries(c)
      ? c.data.entries.filter((e) => e.worker_id === c.user.workerId)
      : c.data.entries
    // Incremental sync: rows created or updated since the last sync.
    if (opts?.since) {
      const since = opts.since
      rows = rows.filter((e) => e.created_at >= since || e.updated_at >= since)
    }
    rows = [...rows].sort((a, b) => b.start_time.localeCompare(a.start_time))
    if (opts?.limit) rows = rows.slice(0, opts.limit)
    return { data: rows, error: null }
  },

  async listOlderEntries(before, limit = 500) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    let rows = c.data.entries.filter((e) => e.start_time <= before)
    if (!canSeeAllEntries(c)) rows = rows.filter((e) => e.worker_id === c.user.workerId)
    rows = [...rows].sort((a, b) => b.start_time.localeCompare(a.start_time))
    return { data: rows.slice(0, limit), error: null }
  },

  async createEntry(input) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'entries.manage')) return denied('add manual entries')
    const now = new Date().toISOString()
    const entry: TimeEntry = {
      id: uid(),
      worker_id: input.worker_id,
      client_id: resolveClientId(c.data, input.client_id),
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
    if (!can(c, 'entries.manage')) return denied('edit time entries')
    const idx = c.data.entries.findIndex((e) => e.id === id)
    if (idx === -1) return { data: null, error: 'Entry not found.' }
    c.data.entries[idx] = { ...c.data.entries[idx], ...patch, updated_at: new Date().toISOString() }
    save(c.data)
    return { data: c.data.entries[idx], error: null }
  },

  async deleteEntry(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'entries.manage')) return denied('delete time entries')
    c.data.entries = c.data.entries.filter((e) => e.id !== id)
    c.data.comments = c.data.comments.filter((cm) => cm.entry_id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  async getActiveTimer() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    return { data: ownTimer(c), error: null }
  },

  async listActiveTimers() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role === 'worker') {
      const mine = c.data.activeTimers.filter((t) => t.worker_id === c.user.workerId)
      return { data: mine, error: null }
    }
    // The admin sees everyone that is currently on the clock.
    const all = [...c.data.activeTimers].sort((a, b) => b.start_time.localeCompare(a.start_time))
    return { data: all, error: null }
  },

  async startTimer(input) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    let workerId = input.worker_id
    let rate = input.hourly_rate
    if (c.user.role === 'worker') {
      // Workers can only clock in for themselves, at their admin-set rate.
      workerId = c.user.workerId || ''
      const w = c.data.workers.find((x) => x.id === workerId)
      if (!w) return { data: null, error: 'No worker profile linked to this account.' }
      rate = w.hourly_rate
      // Every shift is booked to a client. A worker calling startTimer without
      // a client_id means the UI skipped the dialog — refuse the clock-in so
      // untagged hours never land in the ledger.
      if (!input.client_id) {
        return { data: null, error: 'Choose a client before clocking in.' }
      }
    } else {
      const w = c.data.workers.find((x) => x.id === workerId)
      if (!w) return { data: null, error: 'Select a worker.' }
      rate = rate ?? w.hourly_rate
    }
    // Only one timer per worker — other workers may be clocked in at the same time.
    const existing = c.data.activeTimers.find((t) => t.worker_id === workerId)
    if (existing) {
      if (c.user.role === 'worker') return { data: existing, error: null }
      return { data: null, error: 'That worker already has a running timer.' }
    }
    const startedAt = input.start_time || new Date().toISOString()
    const timer: ActiveTimer = {
      id: uid(),
      worker_id: workerId,
      client_id: resolveClientId(c.data, input.client_id),
      project: input.project || null,
      start_time: startedAt,
      // Whole-shift anchors — stay put across client switches so the UI clock
      // does not reset while each client still gets its own allocated minutes.
      session_start: startedAt,
      prior_worked_ms: 0,
      notes: input.notes || null,
      hourly_rate: rate ?? 0,
      paused: false,
      pause_start: null,
      total_pause_ms: 0,
      created_at: new Date().toISOString(),
    }
    c.data.activeTimers.push(timer)
    // Notify the admin when a worker clocks in.
    if (c.user.role === 'worker') {
      const detail = [
        clientName(c.data, timer.client_id) || timer.project,
        timer.notes ? timer.notes.replace(/\s+/g, ' ').slice(0, 140) : null,
      ].filter(Boolean).join(' · ')
      pushNotification(c.data, c.admin.id, {
        entry_id: null,
        type: 'time_in',
        message: `${workerName(c.data, workerId)} clocked in${detail ? ` — ${detail}` : ''}`,
      })
    }
    save(c.data)
    return { data: timer, error: null }
  },

  async pauseTimer(timerId) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const t = findTimer(c, timerId)
    if (!t) return { data: null, error: 'No active timer.' }
    if (c.user.role === 'worker' && t.worker_id !== c.user.workerId) return { data: null, error: 'Not your timer.' }
    if (t.paused) return { data: t, error: null }
    t.paused = true
    t.pause_start = new Date().toISOString()
    // Let the admin know the worker went on break.
    if (c.user.role === 'worker') {
      pushNotification(c.data, c.admin.id, {
        entry_id: null,
        type: 'break_start',
        message: `${workerName(c.data, t.worker_id)} started a break`,
      })
    }
    save(c.data)
    return { data: t, error: null }
  },

  async resumeTimer(timerId) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const t = findTimer(c, timerId)
    if (!t) return { data: null, error: 'No active timer.' }
    if (c.user.role === 'worker' && t.worker_id !== c.user.workerId) return { data: null, error: 'Not your timer.' }
    if (!t.paused) return { data: t, error: null }
    if (t.pause_start) {
      t.total_pause_ms += new Date().getTime() - new Date(t.pause_start).getTime()
    }
    t.paused = false
    t.pause_start = null
    if (c.user.role === 'worker') {
      pushNotification(c.data, c.admin.id, {
        entry_id: null,
        type: 'break_end',
        message: `${workerName(c.data, t.worker_id)} is back from break`,
      })
    }
    save(c.data)
    return { data: t, error: null }
  },

  async stopTimer(timerId, note) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const timer = c.data.activeTimers.find((t) => t.id === timerId)
    if (!timer) return { data: null, error: 'No active timer found.' }
    if (c.user.role === 'worker' && timer.worker_id !== c.user.workerId) return { data: null, error: 'Not your timer.' }
    const clockOutNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : null
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
      client_id: timer.client_id ?? null,
      project: timer.project || null,
      start_time: timer.start_time,
      end_time: end.toISOString(),
      break_minutes: breakMinutes,
      notes: [timer.notes, clockOutNote].filter(Boolean).join('\n') || null,
      hourly_rate: rate,
      total_minutes: totalMinutes,
      earnings: computeEarnings(totalMinutes, rate),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    c.data.entries.push(entry)
    c.data.activeTimers = c.data.activeTimers.filter((t) => t.id !== timer.id)
    // Notify the admin when a worker clocks out.
    // Always notify on clock out — with or without a note.
    if (c.user.role === 'worker') {
      const parts = [formatMinutes(entry.total_minutes)]
      const scope = clientName(c.data, entry.client_id) || entry.project
      if (scope) parts.push(scope)
      parts.push(clockOutNote ? 'added a note' : 'no note')
      pushNotification(c.data, c.admin.id, {
        entry_id: entry.id,
        type: 'time_out',
        message: `${workerName(c.data, entry.worker_id)} clocked out — ${parts.join(' · ')}`,
      })
    }
    save(c.data)
    return { data: entry, error: null }
  },

  async switchClient(input) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'worker') return { data: null, error: 'Only workers can switch the client they are working for.' }
    const workerId = c.user.workerId
    if (!workerId) return { data: null, error: 'No worker profile linked to this account.' }
    const timer = c.data.activeTimers.find((t) => t.worker_id === workerId)
    if (!timer) return { data: null, error: 'No active timer.' }
    const newClientId = resolveClientId(c.data, input.client_id)
    if (!newClientId) return { data: null, error: 'Choose a client.' }
    if (timer.client_id === newClientId) {
      return { data: null, error: "You're already working for that client." }
    }
    const now = new Date()
    // Close the old segment exactly like a clock-out would (an in-progress
    // break is folded in, so a switch while paused ends the break).
    let totalPause = timer.total_pause_ms || 0
    if (timer.paused && timer.pause_start) {
      totalPause += now.getTime() - new Date(timer.pause_start).getTime()
    }
    // Minutes for THIS client only (from the current segment start).
    const workingMs = Math.max(0, now.getTime() - new Date(timer.start_time).getTime() - totalPause)
    const totalMinutes = Math.max(0, Math.round(workingMs / 60000))
    const breakMinutes = Math.max(0, Math.round(totalPause / 60000))
    // The finished stretch is booked to the client the worker was on before
    // the switch; it carries the shift's original note.
    const entry: TimeEntry = {
      id: uid(),
      worker_id: timer.worker_id,
      client_id: timer.client_id ?? null,
      project: timer.project || null,
      start_time: timer.start_time,
      end_time: now.toISOString(),
      break_minutes: breakMinutes,
      notes: timer.notes || null,
      hourly_rate: timer.hourly_rate ?? 0,
      total_minutes: totalMinutes,
      earnings: computeEarnings(totalMinutes, timer.hourly_rate ?? 0),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }
    c.data.entries.push(entry)
    c.data.activeTimers = c.data.activeTimers.filter((t) => t.id !== timer.id)
    // Keep the on-screen shift clock continuous: carry forward the original
    // clock-in and the worked ms already saved to previous clients.
    const sessionStart = timer.session_start || timer.start_time
    const priorWorkedMs = Math.max(0, (timer.prior_worked_ms || 0) + workingMs)
    const next: ActiveTimer = {
      id: uid(),
      worker_id: timer.worker_id,
      client_id: newClientId,
      project: null,
      start_time: now.toISOString(),
      session_start: sessionStart,
      prior_worked_ms: priorWorkedMs,
      notes: typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : null,
      hourly_rate: timer.hourly_rate ?? 0,
      paused: false,
      pause_start: null,
      total_pause_ms: 0,
      created_at: now.toISOString(),
    }
    c.data.activeTimers.push(next)
    save(c.data)
    return { data: next, error: null }
  },

  async deleteTimer(timerId) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const t = c.data.activeTimers.find((x) => x.id === timerId)
    if (!t) return { data: null, error: null }
    if (c.user.role === 'worker' && t.worker_id !== c.user.workerId) return { data: null, error: 'Not your timer.' }
    c.data.activeTimers = c.data.activeTimers.filter((x) => x.id !== timerId)
    save(c.data)
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
        avatar_url: null,
      }
      save(c.data)
    }
    return { data: c.data.settings, error: null }
  },

  async saveSettings(patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'settings.manage')) return denied('change business settings')
    if (!c.data.settings) c.data.settings = { id: 'settings-1', business_name: 'My Business', currency: 'USD', timezone: 'UTC', default_hourly_rate: 20, avatar_url: null }
    c.data.settings = { ...c.data.settings, ...patch }
    save(c.data)
    return { data: c.data.settings, error: null }
  },

  // Slack integration config. Kept in its own storage slot (keyed by the
  // workspace admin) so it survives "Delete all data", which wipes the main
  // blob. In demo mode there is no server, so notifySlack() posts to Slack
  // straight from the browser using this webhook URL.
  async getSlackSettings() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'settings.manage')) return denied('view the Slack settings')
    // Merge over the defaults so rows saved before a field existed (e.g. the
    // approval webhook) still read back with every toggle set.
    return { data: { ...DEFAULT_SLACK_SETTINGS, ...read<SlackSettings>(slackKey(c.admin.id), { ...DEFAULT_SLACK_SETTINGS }) }, error: null }
  },

  async saveSlackSettings(patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'settings.manage')) return denied('change the Slack settings')
    const next: SlackSettings = { ...DEFAULT_SLACK_SETTINGS, ...read<SlackSettings>(slackKey(c.admin.id), { ...DEFAULT_SLACK_SETTINGS }), ...patch }
    next.webhook_url = next.webhook_url?.trim() ? next.webhook_url.trim() : null
    next.task_webhook_url = next.task_webhook_url?.trim() ? next.task_webhook_url.trim() : null
    next.approval_webhook_url = next.approval_webhook_url?.trim() ? next.approval_webhook_url.trim() : null
    write(slackKey(c.admin.id), next)
    return { data: next, error: null }
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

  async listNotifications(limit) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const mine = c.data.notifications
      .filter((n) => n.user_id === c.user.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    return { data: limit ? mine.slice(0, limit) : mine, error: null }
  },

  async countUnreadNotifications() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    return { data: c.data.notifications.filter((n) => n.user_id === c.user.id && !n.read).length, error: null }
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

  async listPayments(limit) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    let rows = !can(c, 'payments.view_all')
      ? c.data.payments.filter((p) => p.worker_id === c.user.workerId)
      : c.data.payments
    rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))
    return { data: limit ? rows.slice(0, limit) : rows, error: null }
  },

  async settleWorker(workerId, note) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'payments.manage')) return denied('settle worker time')
    const worker = c.data.workers.find((w) => w.id === workerId)
    if (!worker) return { data: null, error: 'Worker not found.' }
    // Settling never deletes time entries. It pays out the worker's unsettled
    // entries and stamps them, so they stay in Time Entries (with their notes)
    // until someone deletes one by hand, and the next settlement only covers
    // time worked since.
    const unsettled = c.data.entries.filter((e) => e.worker_id === workerId && !e.settled_at)
    if (unsettled.length === 0) {
      return { data: null, error: 'This worker has no unsettled time to settle.' }
    }
    let totalMinutes = 0
    let earnings = 0
    let periodStart = unsettled[0].start_time
    let periodEnd = unsettled[0].end_time
    for (const e of unsettled) {
      totalMinutes += e.total_minutes
      earnings += e.earnings
      if (e.start_time < periodStart) periodStart = e.start_time
      if (e.end_time > periodEnd) periodEnd = e.end_time
    }
    const now = new Date()
    const payment: Payment = {
      id: uid(),
      worker_id: workerId,
      amount: Math.round(earnings * 100) / 100,
      hours: Math.round((totalMinutes / 60) * 100) / 100,
      status: 'unpaid',
      period_start: periodStart,
      period_end: periodEnd,
      created_at: now.toISOString(),
      paid_at: null,
      note: note || null,
      // Filled in when the admin marks the payment as paid.
      payment_method: null,
      reference_number: null,
    }
    c.data.payments.push(payment)
    // Mark the paid-for time as settled — the rows themselves are kept.
    const settledAt = now.toISOString()
    for (const e of unsettled) {
      e.settled_at = settledAt
      e.updated_at = settledAt
    }
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

  async updatePaymentStatus(id, status, paymentMethod, referenceNumber) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'payments.manage')) return denied('update payment status')
    const p = c.data.payments.find((x) => x.id === id)
    if (!p) return { data: null, error: 'Payment not found.' }
    const method = normalizePaidMethod(paymentMethod)
    if (status === 'paid' && paymentMethod && !method) {
      return { data: null, error: 'Choose Cash or QR Code as the payment method.' }
    }
    const reference = normalizeReferenceNumber(referenceNumber)
    p.status = status
    p.paid_at = status === 'paid' ? new Date().toISOString() : null
    // The method and reference only describe a completed payment.
    p.payment_method = status === 'paid' ? method : null
    p.reference_number = status === 'paid' ? reference : null
    // Notify the worker on status change.
    const wid = workerUserId(p.worker_id)
    if (wid) {
      pushNotification(c.data, wid, {
        entry_id: null,
        type: 'payment',
        message:
          `Your payment of ${formatMoney(p.amount, c.data.settings?.currency || 'USD')} is now ${status}` +
          (status === 'paid' && method ? ` (${paymentMethodLabel(method)})` : '') +
          (status === 'paid' && reference ? ` · Ref ${reference}` : ''),
      })
    }
    save(c.data)
    return { data: p, error: null }
  },

  async updatePaymentNote(id, note) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'payments.manage')) return denied('edit payment notes')
    const p = c.data.payments.find((x) => x.id === id)
    if (!p) return { data: null, error: 'Payment not found.' }
    p.note = note
    save(c.data)
    return { data: p, error: null }
  },

  async deletePayment(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'payments.manage')) return denied('delete payments')
    c.data.payments = c.data.payments.filter((p) => p.id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  // ---- Finance (subscriptions, payroll, bills) ------------------------------
  // The ledger belongs to the whole workspace, so a worker without
  // `finance.view` simply gets an empty list (never an error — the store
  // fetches it on every sync). `finance.manage` gates the writes.

  async listFinanceItems() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'finance.view')) return { data: [] as FinanceItem[], error: null }
    return { data: sortFinanceItems(c.data.financeItems), error: null }
  },

  async createFinanceItem(input: CreateFinanceItemInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'finance.manage')) return denied('add finance lines')
    const kind = normalizeFinanceKind(input.kind)
    if (!kind) return { data: null, error: 'Choose what kind of finance line this is.' }
    const amount = Number(input.amount)
    if (!Number.isFinite(amount) || amount < 0) return { data: null, error: 'Enter an amount of 0 or more.' }
    const dueDate = normalizeFinanceDate(input.due_date)
    if (!dueDate) return { data: null, error: 'Pick a due date.' }
    const name = input.name?.trim() || null
    const workerId = input.worker_id || null
    const periodMonth = normalizeFinanceMonth(input.period_month)
    if (kind === 'subscription' || kind === 'bill') {
      if (!name) return { data: null, error: kind === 'subscription' ? 'Give the subscription a name.' : 'Give the bill a label.' }
      if (name.length > 80) return { data: null, error: 'Names are limited to 80 characters.' }
    }
    if (kind === 'payroll') {
      if (!workerId) return { data: null, error: 'Choose the worker being paid.' }
      if (!c.data.workers.some((w) => w.id === workerId)) return { data: null, error: 'Worker not found.' }
      if (!periodMonth) return { data: null, error: 'Choose the month this pay covers.' }
      // One run per worker per month — settle it, or edit the existing line.
      const dupe = c.data.financeItems.some(
        (f) => f.kind === 'payroll' && f.worker_id === workerId && f.period_month === periodMonth
      )
      if (dupe) return { data: null, error: 'That worker already has a payroll line for this month — edit it instead.' }
    }
    const now = new Date().toISOString()
    const status = normalizeFinanceStatus(kind, input.status)
    if (input.max_occurrences != null && (kind !== 'subscription' || !Number.isFinite(input.max_occurrences) || input.max_occurrences < 1 || Math.floor(input.max_occurrences) !== input.max_occurrences)) {
      return { data: null, error: 'The number of times a subscription bills must be a whole number of 1 or more.' }
    }
    const item: FinanceItem = normalizeFinanceItem({
      id: uid(),
      kind,
      name: kind === 'payroll' ? null : name,
      worker_id: workerId,
      amount,
      cycle: input.cycle ?? null,
      period_month: periodMonth,
      due_date: dueDate,
      status,
      paid_at: status === 'paid' ? now : null,
      note: input.note ?? null,
      max_occurrences: kind === 'subscription' ? (input.max_occurrences ?? null) : null,
      billed_count: 0,
      created_at: now,
      updated_at: now,
    })
    c.data.financeItems.push(item)
    save(c.data)
    return { data: item, error: null }
  },

  async updateFinanceItem(id, patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'finance.manage')) return denied('edit finance lines')
    const idx = c.data.financeItems.findIndex((f) => f.id === id)
    if (idx === -1) return { data: null, error: 'Finance line not found.' }
    const current = c.data.financeItems[idx]
    if (patch.worker_id && !c.data.workers.some((w) => w.id === patch.worker_id)) {
      return { data: null, error: 'Worker not found.' }
    }
    if (patch.due_date !== undefined && !normalizeFinanceDate(patch.due_date)) {
      return { data: null, error: 'Pick a due date.' }
    }
    if (patch.amount !== undefined && (!Number.isFinite(Number(patch.amount)) || Number(patch.amount) < 0)) {
      return { data: null, error: 'Enter an amount of 0 or more.' }
    }
    if (patch.period_month !== undefined && current.kind === 'payroll') {
      const pm = normalizeFinanceMonth(patch.period_month)
      const dupe = pm && c.data.financeItems.some(
        (f) => f.id !== id && f.kind === 'payroll' && f.worker_id === (patch.worker_id ?? current.worker_id) && f.period_month === pm
      )
      if (dupe) return { data: null, error: 'That worker already has a payroll line for this month — edit it instead.' }
    }
    if (patch.max_occurrences !== undefined && patch.max_occurrences !== null && (current.kind !== 'subscription' || !Number.isFinite(patch.max_occurrences) || patch.max_occurrences < 1 || Math.floor(patch.max_occurrences) !== patch.max_occurrences)) {
      return { data: null, error: 'The number of times a subscription bills must be a whole number of 1 or more.' }
    }
    const at = new Date().toISOString()
    // Marking paid stamps the time (keeping an existing stamp); moving back
    // to unpaid clears it. normalizeFinanceItem enforces the same invariant.
    // Rolling a subscription's due date forward is a billing: the counter
    // goes up and a reached limit pauses the subscription by itself.
    const next = applyBillingCount(current, patch, normalizeFinanceItem({
      ...current,
      ...patch,
      // The kind is fixed once created — it decides the row's shape.
      kind: current.kind,
      id: current.id,
      created_at: current.created_at,
      updated_at: at,
      paid_at: patch.status === 'paid' ? (current.paid_at ?? at) : patch.status ? null : current.paid_at,
    }))
    c.data.financeItems[idx] = next
    save(c.data)
    return { data: next, error: null }
  },

  async deleteFinanceItem(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'finance.manage')) return denied('delete finance lines')
    c.data.financeItems = c.data.financeItems.filter((f) => f.id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  // ---- Clients (master list) ----------------------------------------------
  // Both roles read the list (a worker needs the name/colour of the clients on
  // their own board and in their filters); only the admin may change it.
  // Inactive clients stay in the list so historical work keeps its label — the
  // UI is what limits new work to the active ones.

  async listClients() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    return { data: sortClients(c.data.clients), error: null }
  },

  async createClient(input: CreateClientInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'clients.manage')) return denied('manage clients')
    const name = input.name.trim()
    if (!name) return { data: null, error: 'Give the client a name.' }
    if (name.length > 80) return { data: null, error: 'Client names are limited to 80 characters.' }
    if (c.data.clients.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      return { data: null, error: `"${name}" is already on the list.` }
    }
    const now = new Date().toISOString()
    const client: Client = {
      id: uid(),
      name,
      color: normalizeClientColor(input.color),
      status: normalizeClientStatus(input.status),
      created_at: now,
      updated_at: now,
    }
    c.data.clients.push(client)
    save(c.data)
    return { data: client, error: null }
  },

  async updateClient(id, patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'clients.manage')) return denied('manage clients')
    const idx = c.data.clients.findIndex((x) => x.id === id)
    if (idx === -1) return { data: null, error: 'Client not found.' }
    const current = c.data.clients[idx]
    const name = patch.name !== undefined ? patch.name.trim() : current.name
    if (!name) return { data: null, error: 'Give the client a name.' }
    if (c.data.clients.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) {
      return { data: null, error: `"${name}" is already on the list.` }
    }
    const next: Client = normalizeClient({
      ...current,
      ...patch,
      name,
      id: current.id,
      created_at: current.created_at,
      updated_at: new Date().toISOString(),
    })
    c.data.clients[idx] = next
    save(c.data)
    return { data: next, error: null }
  },

  async deleteClient(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'clients.manage')) return denied('manage clients')
    // Deleting would strip the label off work that has already happened, so a
    // client in use can only be marked inactive.
    const usedByTasks = c.data.tasks.some((t) => t.client_id === id)
    const usedByEntries = c.data.entries.some((e) => e.client_id === id)
    if (usedByTasks || usedByEntries) {
      return { data: null, error: 'This client is used by existing tasks or time entries. Mark it inactive instead.' }
    }
    c.data.clients = c.data.clients.filter((x) => x.id !== id)
    // The board is derived from the master list — a deleted client loses its place.
    c.data.clientPriorities = c.data.clientPriorities.filter((p) => p.client_id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  // ---- Client priority board ----------------------------------------------
  // One board for the whole workspace. The admin runs it by default; a worker
  // the admin granted `priority_board.view` sees and drags the very same
  // board. Clients without a row are unranked (bottom of Low Priority), so
  // new clients land on the board by themselves and reset = delete all rows.

  async listClientPriorities() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'priority_board.view')) return denied('use the client priority board')
    return { data: sortClientPriorities(c.data.clientPriorities), error: null }
  },

  async moveClientPriority(clientId, lane, position) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'priority_board.view')) return denied('use the client priority board')
    if (!c.data.clients.some((x) => x.id === clientId)) return { data: null, error: 'Client not found.' }
    const target = normalizeClientPriorityLane(lane)
    const now = new Date().toISOString()
    let row = c.data.clientPriorities.find((p) => p.client_id === clientId)
    if (!row) {
      row = { id: uid(), client_id: clientId, lane: target, position: 0, created_at: now, updated_at: now }
      c.data.clientPriorities.push(row)
    }
    row.lane = target
    row.updated_at = now
    reindexClientPriorityLane(c.data.clientPriorities, target, clientId, position)
    save(c.data)
    return { data: row, error: null }
  },

  async resetClientPriorities() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'priority_board.view')) return denied('use the client priority board')
    c.data.clientPriorities = []
    save(c.data)
    return { data: null, error: null }
  },

  // ---- Meetings -------------------------------------------------------------
  // One schedule for the whole workspace. The admin runs it by default; a
  // worker the admin granted `meetings.view` sees and manages the very same
  // list. No attendees or invites — whoever can open the page can run it.

  async listMeetings() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'meetings.view')) return denied('use the meetings section')
    return { data: sortMeetings(c.data.meetings, Date.now()), error: null }
  },

  async createMeeting(input: CreateMeetingInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'meetings.view')) return denied('use the meetings section')
    const title = input.title.trim()
    if (!title) return { data: null, error: 'Give the meeting a title.' }
    if (title.length > 200) return { data: null, error: 'Meeting titles are limited to 200 characters.' }
    const start = new Date(input.start_time)
    if (!Number.isFinite(start.getTime())) return { data: null, error: 'Pick a valid date and time.' }
    const now = new Date().toISOString()
    const meeting: Meeting = {
      id: uid(),
      title,
      start_time: start.toISOString(),
      notes: input.notes?.trim() || null,
      created_at: now,
      updated_at: now,
    }
    c.data.meetings.push(meeting)
    save(c.data)
    return { data: meeting, error: null }
  },

  async updateMeeting(id, patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'meetings.view')) return denied('use the meetings section')
    const idx = c.data.meetings.findIndex((m) => m.id === id)
    if (idx === -1) return { data: null, error: 'Meeting not found.' }
    const current = c.data.meetings[idx]
    const title = patch.title !== undefined ? patch.title.trim() : current.title
    if (!title) return { data: null, error: 'Give the meeting a title.' }
    const start = patch.start_time !== undefined ? new Date(patch.start_time) : new Date(current.start_time)
    if (!Number.isFinite(start.getTime())) return { data: null, error: 'Pick a valid date and time.' }
    const next: Meeting = normalizeMeeting({
      ...current,
      ...patch,
      title,
      start_time: start.toISOString(),
      notes: patch.notes !== undefined ? patch.notes?.trim() || null : current.notes,
      id: current.id,
      created_at: current.created_at,
      updated_at: new Date().toISOString(),
    })
    c.data.meetings[idx] = next
    save(c.data)
    return { data: next, error: null }
  },

  async deleteMeeting(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'meetings.view')) return denied('use the meetings section')
    c.data.meetings = c.data.meetings.filter((m) => m.id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  // ---- Tasks (kanban board) ----------------------------------------------
  // A worker only ever sees and touches their own tasks; the admin sees and
  // manages every worker's. Both roles can add tasks — a worker's new task is
  // always assigned to themselves, whatever the caller passes.

  async listTasks() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const rows = !can(c, 'tasks.view_all')
      ? c.data.tasks.filter((t) => t.worker_id === c.user.workerId)
      : c.data.tasks
    return { data: sortTasks(rows), error: null }
  },

  async createTask(input: CreateTaskInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const title = input.title.trim()
    if (!title) return { data: null, error: 'Give the task a title.' }
    // Workers can only ever create tasks for themselves.
    // Only a task manager may put a card on someone else's board. A manager
    // who doesn't pass a worker_id is treated as creating a task for
    // themselves — same end result as a regular worker, just without the
    // assignment UI step.
    const workerId = can(c, 'tasks.manage_all')
      ? (input.worker_id || c.user.workerId || '')
      : c.user.workerId
    if (!workerId) return { data: null, error: 'Choose who the task is for.' }
    if (!c.data.workers.some((w) => w.id === workerId)) return { data: null, error: 'Worker not found.' }
    const status = normalizeTaskStatus(input.status)
    const now = new Date().toISOString()
    const task: Task = {
      id: uid(),
      worker_id: workerId,
      client_id: resolveClientId(c.data, input.client_id),
      title,
      description: input.description?.trim() || null,
      status,
      priority: normalizeTaskPriority(input.priority),
      due_date: input.due_date || null,
      // New tasks land at the bottom of their column.
      position: nextTaskPosition(c.data.tasks, workerId, status),
      created_by_role: c.user.role,
      completed_at: status === 'completed' ? now : null,
      created_at: now,
      updated_at: now,
    }
    c.data.tasks.push(task)
    // Tell the worker when the admin assigns them something.
    if (c.user.role === 'admin') {
      const recipient = workerUserId(workerId)
      if (recipient) {
        pushNotification(c.data, recipient, { entry_id: null, type: 'note', message: `New task assigned: "${title}"` })
      }
    }
    save(c.data)
    return { data: task, error: null }
  },

  async updateTask(id, patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const idx = c.data.tasks.findIndex((t) => t.id === id)
    if (idx === -1) return { data: null, error: 'Task not found.' }
    const current = c.data.tasks[idx]
    if (!can(c, 'tasks.manage_all') && current.worker_id !== c.user.workerId) {
      return { data: null, error: 'You can only change your own tasks.' }
    }
    // Only a task manager may hand a task to a different worker.
    const workerId = can(c, 'tasks.manage_all') && patch.worker_id ? patch.worker_id : current.worker_id
    const status = patch.status ? normalizeTaskStatus(patch.status) : current.status
    const now = new Date().toISOString()
    const next: Task = normalizeTask({
      ...current,
      ...patch,
      worker_id: workerId,
      client_id: patch.client_id !== undefined ? resolveClientId(c.data, patch.client_id) : current.client_id,
      status,
      title: patch.title !== undefined ? String(patch.title).trim() || current.title : current.title,
      // Stamp the first time it reaches Completed; clear it when it moves back.
      completed_at: status === 'completed' ? (current.completed_at ?? now) : null,
      id: current.id,
      created_at: current.created_at,
      updated_at: now,
    })
    // Moving column (or worker) puts it at the bottom of the new one.
    if (status !== current.status || workerId !== current.worker_id) {
      next.position = nextTaskPosition(c.data.tasks.filter((t) => t.id !== id), workerId, status)
    }
    c.data.tasks[idx] = next
    save(c.data)
    return { data: next, error: null }
  },

  async moveTask(id, status, position) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const task = c.data.tasks.find((t) => t.id === id)
    if (!task) return { data: null, error: 'Task not found.' }
    if (!can(c, 'tasks.manage_all') && task.worker_id !== c.user.workerId) {
      return { data: null, error: 'You can only move your own tasks.' }
    }
    const target = normalizeTaskStatus(status)
    const now = new Date().toISOString()
    task.status = target
    task.completed_at = target === 'completed' ? (task.completed_at ?? now) : null
    task.updated_at = now
    reindexTaskColumn(c.data.tasks, task.worker_id, target, id, position)
    save(c.data)
    return { data: task, error: null }
  },

  async deleteTask(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const task = c.data.tasks.find((t) => t.id === id)
    if (!task) return { data: null, error: null }
    if (!can(c, 'tasks.manage_all') && task.worker_id !== c.user.workerId) {
      return { data: null, error: 'You can only delete your own tasks.' }
    }
    c.data.tasks = c.data.tasks.filter((t) => t.id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  async resetAll() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can delete data.' }
    save(emptyData())
    // Worker login accounts are gone along with their worker rows — drop them
    // so reset workers cannot sign in again. The admin account is kept.
    writeUsers(readUsers().filter((u) => u.role !== 'worker'))
    return { data: null, error: null }
  },

  async seedDemo() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can load sample data.' }
    const seed = buildDemoSeed()
    const seededWorkers: Worker[] = seed.workers.map((w) => ({ ...w, id: uid() }))
    const idMap = new Map(seed.workers.map((w, i) => [w.id, seededWorkers[i].id]))
    const seedClients: Client[] = seed.clients.map((cl) => ({ ...cl, id: uid() }))
    const seedClientMap = new Map(seed.clients.map((cl, i) => [cl.id, seedClients[i].id]))
    const users = readUsers()
    for (const w of seededWorkers) {
      if (w.email && !users.some((u) => u.email === w.email)) {
        users.push({ id: uid(), email: w.email, password: 'worker123', role: 'worker', workerId: w.id })
      }
    }
    writeUsers(users)
    const next: UserData = {
      workers: seededWorkers,
      entries: seed.entries.map((e) => ({
        ...e,
        worker_id: idMap.get(e.worker_id) || e.worker_id,
        client_id: e.client_id ? seedClientMap.get(e.client_id) ?? null : null,
        id: uid(),
      })),
      activeTimers: [],
      settings: seed.settings,
      comments: [],
      notifications: [],
      payments: [],
      tasks: [],
      clients: seedClients,
      clientPriorities: (seed.clientPriorities ?? []).map((p) => ({
        ...p,
        client_id: seedClientMap.get(p.client_id) ?? p.client_id,
        id: uid(),
      })),
      meetings: (seed.meetings ?? []).map((m) => ({ ...m, id: uid() })),
      financeItems: seed.financeItems.map((f) => ({
        ...f,
        worker_id: f.worker_id ? idMap.get(f.worker_id) ?? null : null,
        id: uid(),
      })),
    }
    save(next)
    return { data: null, error: null }
  },
}
