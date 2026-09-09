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
   * The worker's **Position/Role** — the position or role they hold, set by
   * the admin and shown on their profile and worker card. (The column is
   * still named `position` for backwards compatibility with existing
   * databases.)
   */
  position: string | null
  avatar_url: string | null
  /** Payment methods the worker accepts (cash and/or QR code). */
  payment_methods: PaymentMethod[]
  /** Uploaded QR code image (data URL), required while 'qr' is enabled. */
  qr_code_url: string | null
  /**
   * Admin capabilities granted to this worker (empty for a plain worker).
   * Enforced in the app, in both backends and — with Supabase — in RLS.
   */
  permissions: Permission[]
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

// ---- Worker permissions ----------------------------------------------------

/**
 * An admin capability that can be handed to an individual worker.
 *
 * By default a worker has NONE of these: they clock in, see their own time and
 * their own board, and that is it. The admin grants extra access per worker
 * when creating (or editing) them — a `.view` key opens the team-wide read,
 * a `.manage` key adds the admin's write actions in that area.
 *
 * The keys are the single source of truth: the app gates nav, routes and
 * buttons on them, both backends check them, and (with Supabase) the RLS
 * policies in supabase/worker-permissions.sql check the very same list, so a
 * granted worker really can read the rows — and an ungranted one cannot, even
 * if they call the API directly.
 */
export type Permission =
  | 'dashboard.view'
  | 'workers.view'
  | 'workers.manage'
  | 'entries.view_all'
  | 'entries.manage'
  | 'tasks.view_all'
  | 'tasks.manage_all'
  | 'payments.view_all'
  | 'payments.manage'
  | 'finance.view'
  | 'finance.manage'
  | 'reports.view'
  | 'clients.manage'
  | 'settings.manage'

export const PERMISSIONS: Permission[] = [
  'dashboard.view',
  'workers.view',
  'workers.manage',
  'entries.view_all',
  'entries.manage',
  'tasks.view_all',
  'tasks.manage_all',
  'payments.view_all',
  'payments.manage',
  'finance.view',
  'finance.manage',
  'reports.view',
  'clients.manage',
  'settings.manage',
]

/**
 * Capabilities that put other people's data on the screen. Anyone holding one
 * of them can also read the worker list — team-wide rows are useless without
 * the names to go with them — even if the Workers page itself is not open to
 * them. (The `workers` RLS policy checks the same set.)
 */
export const TEAM_VIEW_PERMISSIONS: Permission[] = [
  'workers.view',
  'dashboard.view',
  'entries.view_all',
  'tasks.view_all',
  'payments.view_all',
  'finance.view',
  'reports.view',
]

/** Grouped for the "Access" section of the worker form. */
export interface PermissionGroup {
  key: string
  label: string
  description: string
  items: { key: Permission; label: string; hint: string; /** Needs this one ticked first. */ requires?: Permission }[]
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    description: "The admin's overview of the whole team.",
    items: [
      { key: 'dashboard.view', label: 'View the team dashboard', hint: 'Totals, who is on the clock, recent activity across every worker.' },
    ],
  },
  {
    key: 'workers',
    label: 'Workers',
    description: 'The team list and worker accounts.',
    items: [
      { key: 'workers.view', label: 'View all workers', hint: 'See the team list, rates and live clock status.' },
      { key: 'workers.manage', label: 'Add, edit and remove workers', hint: 'Create logins, change rates, reset passwords, delete workers — and change what other workers can access.', requires: 'workers.view' },
    ],
  },
  {
    key: 'entries',
    label: 'Time entries',
    description: "Everyone's recorded time.",
    items: [
      { key: 'entries.view_all', label: "View the whole team's time", hint: 'Otherwise they only ever see their own entries.' },
      { key: 'entries.manage', label: 'Add, edit and delete time entries', hint: 'Manual entries for any worker, and editing or deleting existing ones.', requires: 'entries.view_all' },
    ],
  },
  {
    key: 'tasks',
    label: 'Tasks',
    description: 'The kanban board.',
    items: [
      { key: 'tasks.view_all', label: "View everyone's board", hint: 'Otherwise they only see the tasks assigned to them.' },
      { key: 'tasks.manage_all', label: "Assign and edit anyone's tasks", hint: 'Create tasks for other workers, move, edit and delete their cards.', requires: 'tasks.view_all' },
    ],
  },
  {
    key: 'payments',
    label: 'Payments',
    description: 'Settlements and payouts.',
    items: [
      { key: 'payments.view_all', label: "View the team's payments", hint: 'Otherwise they only see their own payslips.' },
      { key: 'payments.manage', label: 'Settle and mark payments paid', hint: 'Run settlements, change payment status, delete payments.', requires: 'payments.view_all' },
    ],
  },
  {
    key: 'finance',
    label: 'Finance',
    description: 'Subscriptions, worker payroll and bill due dates.',
    items: [
      { key: 'finance.view', label: 'View the finance section', hint: "The business's subscriptions, worker payroll and due dates — plus the finance part of Reports. Off by default: Finance is admin-only until this is ticked." },
      { key: 'finance.manage', label: 'Manage finance', hint: 'Add and edit subscriptions, payroll runs and bills, mark items paid, advance billing dates.', requires: 'finance.view' },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    description: 'Charts and CSV export.',
    items: [
      { key: 'reports.view', label: 'View reports and export CSV', hint: 'Hours and earnings across the team, per worker and per client.' },
    ],
  },
  {
    key: 'clients',
    label: 'Clients',
    description: 'The client master list.',
    items: [
      { key: 'clients.manage', label: 'Manage clients', hint: 'Add clients, rename them, and mark them active or inactive.' },
    ],
  },
  {
    key: 'settings',
    label: 'Business settings',
    description: 'Workspace-wide configuration.',
    items: [
      { key: 'settings.manage', label: 'Change business settings', hint: 'Business name, currency, timezone, default rate and the Slack integration.' },
    ],
  },
]

/** Ready-made sets, so the common cases are one click in the worker form. */
export type PermissionPreset = 'worker' | 'supervisor' | 'manager' | 'full'

export const PERMISSION_PRESETS: Record<PermissionPreset, { label: string; description: string; permissions: Permission[] }> = {
  worker: {
    label: 'Worker',
    description: 'Their own time and their own tasks. The default.',
    permissions: [],
  },
  supervisor: {
    label: 'Supervisor',
    description: "Sees the team and runs everyone's board, but no money.",
    permissions: ['dashboard.view', 'workers.view', 'entries.view_all', 'tasks.view_all', 'tasks.manage_all'],
  },
  manager: {
    label: 'Manager',
    description: 'Supervisor plus time entries, clients, payments, finance (read) and reports.',
    permissions: [
      'dashboard.view',
      'workers.view',
      'entries.view_all',
      'entries.manage',
      'tasks.view_all',
      'tasks.manage_all',
      'payments.view_all',
      'payments.manage',
      'finance.view',
      'reports.view',
      'clients.manage',
    ],
  },
  full: {
    label: 'Full access',
    description: 'Everything the admin can do, including worker accounts and settings.',
    permissions: [...PERMISSIONS],
  },
}

/** Keep only real permission keys (rows can be edited outside the app). */
export function normalizePermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<Permission>()
  for (const v of value) if (PERMISSIONS.includes(v as Permission)) seen.add(v as Permission)
  // A `.manage` key without its `.view` parent would be meaningless — the UI
  // hides the section entirely — so imply the parent instead of dropping it.
  for (const group of PERMISSION_GROUPS) {
    for (const item of group.items) {
      if (item.requires && seen.has(item.key)) seen.add(item.requires)
    }
  }
  return PERMISSIONS.filter((p) => seen.has(p))
}

/** Which preset (if any) a permission set matches exactly. */
export function presetFor(permissions: Permission[]): PermissionPreset | null {
  const sorted = [...permissions].sort().join('|')
  for (const [name, preset] of Object.entries(PERMISSION_PRESETS)) {
    if ([...preset.permissions].sort().join('|') === sorted) return name as PermissionPreset
  }
  return null
}

export interface AuthUser {
  id: string
  email: string
  role: Role
  workerId?: string | null
  /**
   * The signed-in worker's granted capabilities, resolved at sign-in so the
   * nav and routes are correct on the very first render. The admin implicitly
   * has all of them. Refreshed from the worker row on every data sync, so a
   * change by the admin lands without the worker signing out.
   */
  permissions?: Permission[]
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
  | 'task_created'
  | 'task_moved'
  // Approval-stage automation (posted to the dedicated Approval webhook): a
  // task that lands on the Approval column, whether it was created there or
  // moved onto it — a heads-up for the admin to review, whoever triggered it.
  | 'task_approval_created'
  | 'task_approval_moved'

/** Human label for each Slack event (used by demo-mode fallback texts). */
export const SlackEventNames: Record<SlackEvent, string> = {
  clock_in: 'Clock in',
  clock_out: 'Clock out',
  break_start: 'Break started',
  break_end: 'Back from break',
  payment_paid: 'Payment paid',
  task_created: 'Task created',
  task_moved: 'Task stage changed',
  task_approval_created: 'Task created in Approval',
  task_approval_moved: 'Task moved to Approval',
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
  task_webhook_url: string | null
  notify_task_created: boolean
  notify_task_moved: boolean
  /** Dedicated channel for tasks that land on the Approval stage. */
  approval_webhook_url: string | null
  notify_task_approval_created: boolean
  notify_task_approval_moved: boolean
}

/** Defaults used whenever no Slack settings row exists yet. */
export const DEFAULT_SLACK_SETTINGS: SlackSettings = {
  webhook_url: null,
  notify_clock_in: true,
  notify_clock_out: true,
  notify_break_start: true,
  notify_break_end: true,
  notify_payment_paid: true,
  task_webhook_url: null,
  notify_task_created: true,
  notify_task_moved: true,
  approval_webhook_url: null,
  notify_task_approval_created: true,
  notify_task_approval_moved: true,
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

// ---- Finance ----------------------------------------------------------------

/**
 * What a finance row describes. The Finance section is a single ledger with
 * three kinds of line:
 *  - `subscription` — recurring business software/services (Adobe, QuickBooks…),
 *    billed on a cycle; "paying" one simply rolls its next due date forward.
 *  - `payroll` — a worker's pay for one month (amount entered by the admin,
 *    suggested from that worker's tracked earnings for the month).
 *  - `bill` — a one-off amount that is due on a date (rent, tax, insurance…).
 */
export type FinanceKind = 'subscription' | 'payroll' | 'bill'

export const FINANCE_KINDS: FinanceKind[] = ['subscription', 'payroll', 'bill']

export const FinanceKindNames: Record<FinanceKind, string> = {
  subscription: 'Subscription',
  payroll: 'Payroll',
  bill: 'Bill',
}

/** How often a subscription is billed. */
export type BillingCycle = 'monthly' | 'yearly'

export const BillingCycleNames: Record<BillingCycle, string> = {
  monthly: 'Monthly',
  yearly: 'Yearly',
}

/**
 * `active`/`paused` are the subscription states; `unpaid`/`paid` are the
 * states a payroll run or a bill moves through. Kept in one column because all
 * three kinds share the same ledger and due-date list.
 */
export type FinanceStatus = 'active' | 'paused' | 'unpaid' | 'paid'

export interface FinanceItem {
  id: string
  kind: FinanceKind
  /** Label — required for subscriptions and bills; payroll rows use the worker's name. */
  name: string | null
  /** The worker being paid (payroll rows only). */
  worker_id: string | null
  amount: number
  /** Billing cycle (subscriptions only). */
  cycle: BillingCycle | null
  /** The month a payroll run covers, 'YYYY-MM' (payroll only). */
  period_month: string | null
  /**
   * The date this line is due — next billing date (subscription), pay day
   * (payroll) or the deadline (bill). A plain calendar date ('YYYY-MM-DD'),
   * like task due dates: no time component, interpreted locally.
   */
  due_date: string
  status: FinanceStatus
  /** When a payroll run or bill was marked paid (subscriptions never use it). */
  paid_at: string | null
  note: string | null
  created_at: string
  updated_at: string
}
