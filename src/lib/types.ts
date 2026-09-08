export type WorkerStatus = 'active' | 'inactive'

export type Role = 'admin' | 'worker'

/**
 * How a worker can be paid. Workers enable the methods they accept in their
 * Settings: cash always works, and enabling QR code requires uploading the
 * image of their QR code so the admin can scan it when settling up.
 */
export type PaymentMethod = 'cash' | 'qr'

export interface Worker {
  id: string
  name: string
  email: string | null
  hourly_rate: number
  status: WorkerStatus
  /**
   * The worker's assigned **Project Scope** — the work they are on. Set by the
   * admin, and used to pre-fill the project on their time entries when they
   * clock in. (The column is still named `position` for backwards
   * compatibility with existing databases.)
   */
  position: string | null
  avatar_url: string | null
  /** Payment methods the worker accepts (cash and/or QR code). */
  payment_methods: PaymentMethod[]
  /** Uploaded QR code image (data URL), required while 'qr' is enabled. */
  qr_code_url: string | null
  created_at: string
  updated_at: string
}

export interface TimeEntry {
  id: string
  worker_id: string
  /** The client this time was worked for (see the Clients master list). */
  client_id: string | null
  /**
   * Legacy free-text scope, replaced by `client_id`. Entries logged before
   * clients existed keep their text so nothing is lost; new entries leave it
   * null and the UI shows the client instead.
   */
  project: string | null
  start_time: string // ISO
  end_time: string // ISO
  break_minutes: number
  notes: string | null
  hourly_rate: number
  total_minutes: number
  earnings: number
  created_at: string
  updated_at: string
  /**
   * When this entry was included in a settlement ("Settle & reset"), or null
   * while it is still waiting to be settled. Settling never deletes time
   * entries — it stamps the ones it paid for, so the next settlement only
   * covers time worked since. An entry disappears only when someone deletes it
   * by hand.
   */
  settled_at?: string | null
}

export interface ActiveTimer {
  id: string
  worker_id: string
  /** The client picked at clock-in; copied onto the entry at clock-out. */
  client_id: string | null
  /** @deprecated legacy free-text scope, kept for timers started before clients. */
  project: string | null
  start_time: string // ISO
  notes: string | null
  hourly_rate: number
  paused: boolean
  pause_start: string | null // ISO, when the current break began
  total_pause_ms: number // accumulated break/pause time before the current pause
  created_at: string
}

export interface Settings {
  id: string
  business_name: string
  currency: string
  timezone: string
  default_hourly_rate: number
  avatar_url: string | null
}

export interface AuthUser {
  id: string
  email: string
  role: Role
  workerId?: string | null
}

export type Theme = 'light' | 'dark' | 'system'

/** Live clock state of a worker, derived from their running timer. */
export type LiveStatus = 'working' | 'break'

export interface ActiveWorker {
  timer: ActiveTimer
  worker: Worker | null
  status: LiveStatus
  /** Worked milliseconds so far (breaks excluded). */
  workedMs: number
  /** Total break milliseconds so far (including any break in progress). */
  breakMs: number
}

export interface WorkerStats {
  worker: Worker
  hours: number
  earnings: number
  sessions: number
}

export interface TimeEntryComment {
  id: string
  entry_id: string
  author_id: string
  author_name: string
  author_role: Role
  body: string
  created_at: string
}

/**
 * A worker's image columns, fetched once per sign-in and cached — never
 * polled. Profile pictures and QR codes are the heaviest columns in the
 * workers table (base64 data URLs), so the minute-by-minute `listWorkers`
 * poll deliberately excludes them and the UI merges this snapshot back in.
 */
export interface WorkerAvatar {
  id: string
  avatar_url: string | null
  qr_code_url: string | null
}

export type NotificationType =
  | 'note'
  | 'time_in'
  | 'time_out'
  | 'time_added'
  | 'payment'
  | 'break_start'
  | 'break_end'

export interface AppNotification {
  id: string
  user_id: string // recipient
  entry_id: string | null
  type: NotificationType
  message: string
  read: boolean
  created_at: string
}

export type PaymentStatus = 'unpaid' | 'pending' | 'paid'

/**
 * A workspace event that can be mirrored into a Slack channel. Fired
 * fire-and-forget from the store after the underlying action succeeded; the
 * slack-notify Netlify Function turns each one into a formatted Slack message.
 */
export type SlackEvent =
  | 'clock_in'
  | 'clock_out'
  | 'break_start'
  | 'break_end'
  | 'payment_paid'

/** Human label for each Slack event (used by demo-mode fallback texts). */
export const SlackEventNames: Record<SlackEvent, string> = {
  clock_in: 'Clock in',
  clock_out: 'Clock out',
  break_start: 'Break started',
  break_end: 'Back from break',
  payment_paid: 'Payment paid',
}

/**
 * Admin-configured Slack integration (Settings → Slack). Stored one row per
 * workspace in `slack_settings` (admin-only RLS), so the webhook URL is never
 * readable by workers — notifications are posted server-side by the
 * slack-notify function instead. All fields optional on purpose: when no row
 * exists every event is enabled by default and the webhook URL falls back to
 * the SLACK_WEBHOOK_URL environment variable, if the deployer set one.
 */
export interface SlackSettings {
  webhook_url: string | null
  notify_clock_in: boolean
  notify_clock_out: boolean
  notify_break_start: boolean
  notify_break_end: boolean
  notify_payment_paid: boolean
}

/** Defaults used whenever no Slack settings row exists yet. */
export const DEFAULT_SLACK_SETTINGS: SlackSettings = {
  webhook_url: null,
  notify_clock_in: true,
  notify_clock_out: true,
  notify_break_start: true,
  notify_break_end: true,
  notify_payment_paid: true,
}


// ---- Clients ---------------------------------------------------------------

export type ClientStatus = 'active' | 'inactive'

/**
 * Colour tag on a client, used for its badge on kanban cards / entries and for
 * its slice of the "Hours by client" chart. Deliberately a small fixed set so
 * the board stays legible and the palette survives a theme switch.
 */
export type ClientColor = 'blue' | 'aqua' | 'violet' | 'emerald' | 'amber' | 'orange' | 'rose' | 'slate'

export const CLIENT_COLORS: ClientColor[] = ['blue', 'aqua', 'violet', 'emerald', 'amber', 'orange', 'rose', 'slate']

export const DEFAULT_CLIENT_COLOR: ClientColor = 'blue'

/** Badge / dot classes plus the hex recharts needs for the client charts. */
export const ClientColorStyles: Record<ClientColor, { badge: string; dot: string; chart: string }> = {
  blue: { badge: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300', dot: 'bg-blue-500', chart: '#0868D9' },
  aqua: { badge: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300', dot: 'bg-cyan-500', chart: '#36B7C9' },
  violet: { badge: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300', dot: 'bg-violet-500', chart: '#8B5CF6' },
  emerald: { badge: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500', chart: '#10B981' },
  amber: { badge: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300', dot: 'bg-amber-500', chart: '#F59E0B' },
  orange: { badge: 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300', dot: 'bg-orange-500', chart: '#F77A0A' },
  rose: { badge: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300', dot: 'bg-rose-500', chart: '#F43F5E' },
  slate: { badge: 'border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300', dot: 'bg-slate-500', chart: '#64748B' },
}

/**
 * The client rows created by the migration/backfill for work logged before
 * clients existed. Kept by name so both backends agree on it.
 */
export const UNASSIGNED_CLIENT_NAME = 'Unassigned'

/**
 * A customer the team does work for. The admin keeps the master list: any
 * number of clients, each active or inactive. Only ACTIVE clients are offered
 * when assigning a task or clocking in; inactive ones stay on their existing
 * tasks and entries (and in reports) so history never loses its label.
 */
export interface Client {
  id: string
  name: string
  color: ClientColor
  status: ClientStatus
  created_at: string
  updated_at: string
}

/**
 * Columns of the task board. Tasks move between them by drag & drop (or the
 * "Move to" menu on touch devices); the order is the order they appear in.
 */
export type TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'approval' | 'completed'

export const TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'waiting', 'approval', 'completed']

export const TaskStatusNames: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  waiting: 'Waiting',
  approval: 'Approval',
  completed: 'Completed',
}

export type TaskPriority = 'low' | 'medium' | 'high'

export const TaskPriorityNames: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

/**
 * A unit of work assigned to a worker, shown on the Tasks kanban board.
 *
 * Visibility mirrors the rest of the app: the admin sees and manages every
 * worker's tasks, while a worker only ever sees the tasks assigned to them
 * (both in the UI and — with Supabase — at the RLS level). Workers can add
 * tasks too, but only for themselves.
 */
export interface Task {
  id: string
  /** The worker the task belongs to. */
  worker_id: string
  /**
   * The client the task is for. Required on everything created from the app;
   * nullable only so rows written before clients existed still load (the
   * migration backfills those to the "Unassigned" client).
   */
  client_id: string | null
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  /** Optional deadline (ISO date, no time component needed). */
  due_date: string | null
  /** Manual ordering inside a column (smaller sorts first). */
  position: number
  /** Who created the task — used for the "Added by admin" hint. */
  created_by_role: Role
  /** When the task first landed in the Completed column. */
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface Payment {
  id: string
  worker_id: string
  amount: number
  hours: number
  status: PaymentStatus
  period_start: string
  period_end: string
  created_at: string
  paid_at: string | null
  note: string | null
  /**
   * How the admin paid this settlement (chosen from the worker's accepted
   * methods when marking it paid). Null until the payment is marked paid.
   */
  payment_method?: PaymentMethod | null
}
