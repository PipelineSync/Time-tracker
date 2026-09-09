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
  PaymentStatus,
  PaymentMethod,
  Role,
  WorkerAvatar,
  Task,
  TaskStatus,
  Client,
  Permission,
  FinanceItem,
  FinanceKind,
  BillingCycle,
  FinanceStatus,
} from './types'

export interface BackendResult<T> {
  data: T | null
  error: string | null
}

/** Shown when an account that used to work is deleted by the admin. */
export const ACCOUNT_DEACTIVATED_MESSAGE =
  'This account is no longer active. If you believe this is a mistake, please contact the administrator.'

export interface CreateWorkerInput {
  name: string
  email?: string
  hourly_rate: number
  status?: Worker['status']
  position?: string
  /** Admin capabilities to grant this worker (default: none). */
  permissions?: Permission[]
  // Login details for the worker's account (admin-created).
  accountEmail?: string
  accountPassword?: string
}

/** Fields the admin may set when adding a client to the master list. */
export interface CreateClientInput {
  name: string
  color?: Client['color']
  status?: Client['status']
}

/** Fields callers may set when creating a task. */
export interface CreateTaskInput {
  /** Admin only — defaults to the signed-in worker's own id. */
  worker_id?: string
  /** The client the task is for (required by the UI for both roles). */
  client_id?: string | null
  title: string
  description?: string | null
  status?: TaskStatus
  priority?: Task['priority']
  due_date?: string | null
}

/**
 * Fields the caller may set when adding a finance line. Which ones are
 * required depends on `kind` (validated by the backends):
 * subscriptions need a `name` + `cycle`, payroll needs a `worker_id` +
 * `period_month`, bills need a `name`. `due_date` is always required.
 */
export interface CreateFinanceItemInput {
  kind: FinanceKind
  name?: string | null
  worker_id?: string | null
  amount: number
  cycle?: BillingCycle | null
  /** 'YYYY-MM' (payroll only). */
  period_month?: string | null
  /** 'YYYY-MM-DD'. */
  due_date: string
  status?: FinanceStatus
  note?: string | null
}

export interface DataBackend {
  kind: 'local' | 'supabase'

  // Auth (role-based)
  signIn(email: string, password: string): Promise<BackendResult<AuthUser>>
  signOut(): Promise<void>
  getSession(): Promise<BackendResult<AuthUser>>
  resetPassword(email: string): Promise<BackendResult<null>>
  isAdminConfigured(): boolean

  // Change the signed-in user's own password (both roles, verifies current).
  changePassword(currentPassword: string, newPassword: string): Promise<BackendResult<null>>
  // Admin-only: reset a worker's account password.
  resetWorkerPassword(workerId: string, newPassword: string): Promise<BackendResult<null>>

  // Worker self-service: the signed-in worker updates their own public profile
  // (their profile picture). Only ever touches the worker's own row and only
  // profile fields — never their rate, status, or other admin-managed data.
  updateOwnProfile(patch: { avatar_url?: string | null }): Promise<BackendResult<Worker>>
  // Worker self-service: the signed-in worker chooses which payment methods
  // they accept (cash and/or QR code), uploading their QR code image when QR
  // is enabled. Only touches these two fields on the worker's own row.
  updateOwnPaymentMethods(patch: { payment_methods: PaymentMethod[]; qr_code_url?: string | null }): Promise<BackendResult<Worker>>

  // Data (scoped to current user + role)
  listWorkers(): Promise<BackendResult<Worker[]>>
  /**
   * The image columns of the workers the caller may see (same scope as
   * `listWorkers`), fetched once per sign-in. `listWorkers` deliberately
   * excludes these heavy base64 columns so the background poll stays small;
   * the store merges this snapshot back into the worker list.
   */
  listWorkerAvatars(): Promise<BackendResult<WorkerAvatar[]>>
  createWorker(input: CreateWorkerInput): Promise<BackendResult<Worker>>
  updateWorker(id: string, patch: Partial<Worker> & { newPassword?: string }): Promise<BackendResult<Worker>>
  deleteWorker(id: string): Promise<BackendResult<null>>
  getWorkerLogin(id: string): Promise<BackendResult<{ email: string | null; password: string | null }>>

  /**
   * List time entries, newest first.
   * - `limit` bounds how many rows come back (the app polls with a bounded
   *   window so a tab's bandwidth stays flat as history grows).
   * - `since` returns only entries created or updated at/after that instant
   *   (the incremental "what changed?" sync between full loads).
   */
  listEntries(opts?: { since?: string; limit?: number }): Promise<BackendResult<TimeEntry[]>>
  /**
   * A page of entries strictly older than `before` (the oldest start_time the
   * caller already has), newest first — "load older" pagination for the
   * entries list and for reports over older ranges.
   */
  listOlderEntries(before: string, limit?: number): Promise<BackendResult<TimeEntry[]>>
  createEntry(input: Omit<TimeEntry, 'id' | 'created_at' | 'updated_at'>): Promise<BackendResult<TimeEntry>>
  updateEntry(id: string, patch: Partial<TimeEntry>): Promise<BackendResult<TimeEntry>>
  deleteEntry(id: string): Promise<BackendResult<null>>

  /** The signed-in user's own running timer (admin: the most recent one). */
  getActiveTimer(): Promise<BackendResult<ActiveTimer | null>>
  /**
   * Every timer currently running: the admin gets all workers that are on the
   * clock (working or on break), a worker only gets their own.
   */
  listActiveTimers(): Promise<BackendResult<ActiveTimer[]>>
  startTimer(input: { worker_id: string; client_id?: string | null; project?: string; notes?: string; start_time?: string; hourly_rate?: number }): Promise<BackendResult<ActiveTimer>>
  /** Start a break. Without `timerId` the caller's own timer is used. */
  pauseTimer(timerId?: string): Promise<BackendResult<ActiveTimer>>
  /** End a break. Without `timerId` the caller's own timer is used. */
  resumeTimer(timerId?: string): Promise<BackendResult<ActiveTimer>>
  stopTimer(timerId: string, note?: string): Promise<BackendResult<TimeEntry>>
  deleteTimer(timerId: string): Promise<BackendResult<null>>

  getSettings(): Promise<BackendResult<Settings>>
  saveSettings(patch: Partial<Settings>): Promise<BackendResult<Settings>>

  /**
   * Slack integration config (Settings → Slack, admin only). The webhook URL
   * lives in a row workers cannot read; notifications themselves are posted
   * server-side by the slack-notify Netlify Function.
   */
  getSlackSettings(): Promise<BackendResult<SlackSettings>>
  saveSlackSettings(patch: Partial<SlackSettings>): Promise<BackendResult<SlackSettings>>

  // Notes / chat on entries
  listEntryComments(entryId: string): Promise<BackendResult<TimeEntryComment[]>>
  addEntryComment(entryId: string, body: string): Promise<BackendResult<TimeEntryComment>>

  // Notifications
  /** The most recent notifications for the signed-in user (`limit` caps the
   *  dropdown; the unread badge uses countUnreadNotifications instead). */
  listNotifications(limit?: number): Promise<BackendResult<AppNotification[]>>
  /** How many of the signed-in user's notifications are still unread. */
  countUnreadNotifications(): Promise<BackendResult<number>>
  markNotificationsRead(): Promise<BackendResult<null>>

  // Payments / settlements
  listPayments(limit?: number): Promise<BackendResult<Payment[]>>
  /**
   * The Finance ledger — subscriptions, worker payroll and one-off bills, all
   * carrying a due date. Readable by the admin and by workers the admin
   * granted `finance.view`; changeable only with `finance.manage`. Workers
   * without either get an empty list rather than an error, so background syncs
   * never toast.
   */
  listFinanceItems(): Promise<BackendResult<FinanceItem[]>>
  createFinanceItem(input: CreateFinanceItemInput): Promise<BackendResult<FinanceItem>>
  /**
   * Patch a finance line. Marking `status: 'paid'` stamps `paid_at`; moving a
   * paid line back to unpaid clears it. Advancing a subscription's billing
   * date is done by patching `due_date` (the backend keeps `updated_at`).
   */
  updateFinanceItem(id: string, patch: Partial<Omit<FinanceItem, 'id' | 'created_at' | 'updated_at'>>): Promise<BackendResult<FinanceItem>>
  deleteFinanceItem(id: string): Promise<BackendResult<null>>
  settleWorker(workerId: string, note?: string): Promise<BackendResult<Payment>>
  /**
   * Change a payment's status. When marking it `paid`, `paymentMethod` records
   * how the admin paid (cash or QR code); other statuses clear it.
   */
  updatePaymentStatus(id: string, status: PaymentStatus, paymentMethod?: PaymentMethod | null): Promise<BackendResult<Payment>>
  updatePaymentNote(id: string, note: string | null): Promise<BackendResult<Payment>>
  deletePayment(id: string): Promise<BackendResult<null>>

  /**
   * The client master list. Both roles read it (a worker needs the names and
   * colours of the clients on their own board); only the admin may change it.
   * Inactive clients are returned too — they still label existing work — and
   * the UI offers only the active ones when assigning new work.
   */
  listClients(): Promise<BackendResult<Client[]>>
  createClient(input: CreateClientInput): Promise<BackendResult<Client>>
  updateClient(id: string, patch: Partial<Pick<Client, 'name' | 'color' | 'status'>>): Promise<BackendResult<Client>>
  /** Remove a client outright. Refused while tasks or entries still use it. */
  deleteClient(id: string): Promise<BackendResult<null>>

  /**
   * Tasks on the kanban board. Scoped by role: the admin gets every worker's
   * tasks, a worker only gets their own.
   */
  listTasks(): Promise<BackendResult<Task[]>>
  createTask(input: CreateTaskInput): Promise<BackendResult<Task>>
  updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'created_at' | 'updated_at'>>): Promise<BackendResult<Task>>
  /**
   * Drag & drop: move a task into `status` at index `position` of that column.
   * Kept separate from updateTask so the backend owns the re-indexing.
   */
  moveTask(id: string, status: TaskStatus, position: number): Promise<BackendResult<Task>>
  deleteTask(id: string): Promise<BackendResult<null>>

  resetAll(): Promise<BackendResult<null>>
  seedDemo(): Promise<BackendResult<null>>
}

export type { Role, PaymentStatus }

