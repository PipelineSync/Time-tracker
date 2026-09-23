import type { CSSProperties } from 'react'

export type WorkerStatus = 'active' | 'inactive'

export type Role = 'admin' | 'worker'

/**
 * How a worker can be paid. Workers enable the methods they accept in their
 * Settings: cash always works, and enabling QR code requires uploading the
 * image of their QR code so the admin can scan it when settling up.
 */
export type PaymentMethod = 'cash' | 'qr'

/** Keep payment methods usable: 'cash' and/or 'qr', default ['cash']. */
export function normalizePaymentMethods(methods: unknown): PaymentMethod[] {
  if (!Array.isArray(methods)) return ['cash']
  const valid = methods.filter((m): m is PaymentMethod => m === 'cash' || m === 'qr')
  return valid.length > 0 ? valid : ['cash']
}

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
  /**
   * The days this worker actually works — 0=Sun … 6=Sat. Workload capacity,
   * due-date aging and every business-day calculation respect this instead of
   * assuming a Mon–Fri week (e.g. Tue–Sat staff have no Monday, but do have a
   * Saturday). Defaults to `DEFAULT_WORKDAYS` when a row predates the column.
   */
  workdays: number[]
  /**
   * Planned hours per week on those days (the budget behind the workload
   * percentage). Defaults to `DEFAULT_WEEKLY_CAPACITY_HOURS`.
   */
  weekly_capacity_hours: number
  /**
   * Optional colour tag (one of the 8 built-in tags or custom #hex), same
   * vocabulary as client colour tags. Default null.
   */
  color: string | null
  created_at: string
  updated_at: string
}

/** Mon–Fri — the default workweek when nobody has set one yet. */
export const DEFAULT_WORKDAYS: number[] = [1, 2, 3, 4, 5]

/** 40 hours/week — the default capacity behind workload percentages. */
export const DEFAULT_WEEKLY_CAPACITY_HOURS = 40

/** Every weekday label, in calendar order, for the schedule editor. */
export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Keep a workday list usable: known weekday numbers only, sorted, at least one day. */
export function normalizeWorkdays(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_WORKDAYS]
  const days = [...new Set(value.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
  return days.length > 0 ? days : [...DEFAULT_WORKDAYS]
}

/** Keep a weekly capacity usable: a positive finite number of hours. */
export function normalizeWeeklyCapacity(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WEEKLY_CAPACITY_HOURS
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
  /**
   * Start of the *current client segment*. Reset when the worker switches
   * clients so each client is billed only for the minutes worked for them.
   * Wall-clock display uses `session_start` + `prior_worked_ms` instead, so
   * switching does not zero the on-screen timer.
   */
  start_time: string // ISO
  /**
   * Original clock-in for this whole shift. Stays put across client switches
   * so the UI can show "Clocked in at …" for the full session. Falls back to
   * `start_time` on timers that predate this field.
   */
  session_start?: string | null
  /**
   * Working milliseconds already split off into finished entries earlier in
   * this shift (previous clients). Added to the live segment so the displayed
   * clock keeps counting up across switches instead of resetting.
   */
  prior_worked_ms?: number
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
  | 'priority_board.view'
  | 'meetings.view'
  | 'invoices.view'
  | 'payments.view_all'
  | 'payments.manage'
  | 'finance.view'
  | 'finance.manage'
  | 'finance.subscription'
  | 'finance.payroll'
  | 'reports.view'
  | 'clients.manage'
  | 'settings.manage'
  | 'it_support.manage'
  | 'team_kpi.view'

export const PERMISSIONS: Permission[] = [
  'dashboard.view',
  'workers.view',
  'workers.manage',
  'entries.view_all',
  'entries.manage',
  'tasks.view_all',
  'tasks.manage_all',
  'priority_board.view',
  'meetings.view',
  'invoices.view',
  'payments.view_all',
  'payments.manage',
  'finance.view',
  'finance.manage',
  'finance.subscription',
  'finance.payroll',
  'reports.view',
  'clients.manage',
  'settings.manage',
  // IT Support is a worker's job, not a slice of the admin's power — see the
  // long note in ./tickets. It lives in this list because the admin may hand
  // it to a worker, and because it is a key the worker's row may carry; every
  // IT Support gate uses `isItSupport()` instead of `can()`.
  'it_support.manage',
  // The Team KPI dashboard: the admin (Owner) always holds it, and it is what
  // the Project Manager gets ticked. Bonus approval stays admin-only on top
  // of this — see saveBonusDecision in the backends.
  'team_kpi.view',
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
  'finance.subscription',
  'finance.payroll',
  'reports.view',
  // A KPI dashboard without the team list to go with the names would be
  // numbers with nobody attached — same rule as the other team-wide screens.
  'team_kpi.view',
]

/**
 * Capabilities that let an account read *every* worker's time entries rather
 * than only its own. `reports.view` is one of them: a report is built out of
 * the team's entries, so a report access that only ever reported on yourself
 * would be a self-report, not the team report the admin meant to hand out.
 * (Both backends and — with Supabase — the `time_entries` RLS policy check
 * the same pair.)
 */
export const ALL_ENTRIES_VIEW_PERMISSIONS: Permission[] = ['entries.view_all', 'reports.view']

/** Does this permission set read every worker's time entries? */
export function canViewAllEntries(permissions: Permission[] | null | undefined): boolean {
  return ALL_ENTRIES_VIEW_PERMISSIONS.some((p) => (permissions ?? []).includes(p))
}

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
    key: 'team_kpi',
    label: 'Team KPI',
    description: 'The management dashboard for performance, workload and quality.',
    items: [
      {
        key: 'team_kpi.view',
        label: 'Use the Team KPI dashboard',
        hint: 'See the whole team’s KPI scores, on-time %, workload, QA, rework, goals and Needs Attention — plus QA scoring and monthly targets. For the Project Manager. Bonus approval stays admin-only.',
      },
    ],
  },
  {
    key: 'priority_board',
    label: 'Client priority board',
    description: "The admin's board for ranking clients.",
    items: [
      { key: 'priority_board.view', label: 'Use the client priority board', hint: 'See every active client on the priority board and drag them between columns and ranks. The board is admin-only until this is ticked.' },
    ],
  },
  {
    key: 'meetings',
    label: 'Meetings',
    description: "The admin's meeting schedule.",
    items: [
      { key: 'meetings.view', label: 'Use the meetings section', hint: 'See every scheduled and past meeting, and add, edit or delete them. The section is admin-only until this is ticked.' },
    ],
  },
  {
    key: 'invoices',
    label: 'Client invoicing',
    description: "The admin's invoice board.",
    items: [
      { key: 'invoices.view', label: 'Use the client invoicing board', hint: 'See every invoice on the board, drag it between Pending, Awaiting and Paid, and add, edit or delete invoices. The section is admin-only until this is ticked.' },
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
      { key: 'finance.subscription', label: 'View subscriptions', hint: 'Worker can view subscriptions but not manage them.' },
      { key: 'finance.payroll', label: 'View payroll', hint: 'Worker can view payroll runs but not manage them.' },
      { key: 'finance.manage', label: 'Manage finance', hint: 'Add and edit subscriptions, payroll runs and bills, mark items paid, advance billing dates.', requires: 'finance.view' },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    description: 'Charts and CSV export.',
    items: [
      {
        key: 'reports.view',
        label: 'View reports and export CSV',
        hint: 'Hours and earnings across the whole team, per worker and per client — not just their own. Reports are built from everyone’s time, so this also opens the team-wide time entries read.',
        // A report of the team is only possible if the team's entries can be
        // read; without this the Reports page would just be their own numbers
        // again. Ticking Reports therefore ticks the team-wide time read too,
        // and unticking that one takes Reports with it.
        requires: 'entries.view_all',
      },
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
  {
    key: 'it_support',
    label: 'IT Support',
    description:
      'The support desk. Unusual on purpose: the admin does NOT hold this one, so the ticket queue stays with whoever is actually running support. Ticking it here is the only way in.',
    items: [
      {
        key: 'it_support.manage',
        label: 'Run IT Support',
        hint: 'See every submitted ticket, triage it (category, priority, status), assign it, reply to the requester and attach screenshots. Workers without it can still submit a ticket — they just never see the queue.',
      },
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
    description: 'Supervisor plus time entries, clients, payments, finance (read), reports and Team KPI.',
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
      'team_kpi.view',
    ],
  },
  full: {
    label: 'Full access',
    description: 'Everything the admin hands over, the IT Support desk included: worker accounts and settings too.',
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
  /** An IT Support ticket was submitted, replied to, or moved. */
  | 'ticket'

export interface AppNotification {
  id: string
  user_id: string // recipient
  entry_id: string | null
  /** The ticket this notification is about, when it is an IT Support one. */
  ticket_id: string | null
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
  // task that lands on the For Review column, whether it was created there or
  // moved onto it — a heads-up for the Owner/PM to run QA, whoever triggered
  // it. (Event keys keep their historical `approval` name so stored Slack
  // settings stay valid; the stage is now "For Review".)
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
  task_approval_created: 'Task created in For Review',
  task_approval_moved: 'Task moved to For Review',
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
/**
 * The eight colour tags that ship out of the box — a row of swatches on the
 * Clients dialog.
 */
export type ClientColorPreset = 'blue' | 'aqua' | 'violet' | 'emerald' | 'amber' | 'orange' | 'rose' | 'slate'

export const CLIENT_COLORS: ClientColorPreset[] = ['blue', 'aqua', 'violet', 'emerald', 'amber', 'orange', 'rose', 'slate']

export const DEFAULT_CLIENT_COLOR: ClientColorPreset = 'blue'

/**
 * Colour tag on a client, used for its badge on kanban cards / entries and for
 * its slice of the "Hours by client" chart. One of the eight presets above, or
 * a custom `#RGB` / `#RRGGBB` hex picked with the custom swatch when adding a
 * client, so the palette is not capped at eight. The `string & {}` arm keeps
 * autocomplete for the presets while still accepting a hex string.
 */
export type ClientColor = ClientColorPreset | (string & {})

/** True for one of the eight built-in tags (anything else is a custom hex). */
export function isClientColorPreset(color: ClientColor): color is ClientColorPreset {
  return (CLIENT_COLORS as string[]).includes(color)
}

/** True when a stored value is a usable tag: a preset name, or a #RGB / #RRGGBB hex. */
export function isValidClientColor(value: unknown): value is ClientColor {
  if (typeof value !== 'string' || !value) return false
  if (isClientColorPreset(value)) return true
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
}

/**
 * Everything a badge, dot or chart needs to render a client's colour: the
 * Tailwind classes for a preset, and inline styles for a custom hex — Tailwind
 * cannot know a dynamic hex at build time, so those travel as `style` props.
 * `chart` is the hex the "Hours by client" charts paint that slice with.
 */
export interface ClientColorStyle {
  /** Tailwind badge classes — empty for a custom colour (see `badgeStyle`). */
  badge: string
  /** Tailwind dot classes — empty for a custom colour (see `dotStyle`). */
  dot: string
  /** Inline badge styles — set for custom colours only. */
  badgeStyle?: CSSProperties
  /** Inline dot styles — set for custom colours only. */
  dotStyle?: CSSProperties
  /** Hex for recharts. */
  chart: string
}

/** Badge / dot classes plus the hex recharts needs, for the eight presets. */
export const ClientColorStyles: Record<ClientColorPreset, ClientColorStyle> = {
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
 * Resolves any client colour — preset or custom hex — to renderable classes
 * and styles. A custom hex gets a 10% tint behind the badge name, a 30% border
 * and the colour itself as the text (which reads on light and dark surfaces
 * alike); a malformed value falls back to the default tag rather than
 * rendering grey.
 */
export function clientColorStyles(color: ClientColor): ClientColorStyle {
  if (isClientColorPreset(color)) return ClientColorStyles[color]
  if (!isValidClientColor(color)) return ClientColorStyles[DEFAULT_CLIENT_COLOR]
  // Expand #abc to #aabbcc so the alpha suffixes below stay 6-digit.
  const hex = color.toLowerCase().replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, '#$1$1$2$2$3$3')
  return {
    badge: '',
    dot: '',
    badgeStyle: { backgroundColor: `${hex}1a`, borderColor: `${hex}4d`, color: hex },
    dotStyle: { backgroundColor: hex },
    chart: hex,
  }
}

/**
 * Worker colour tags (§Requirement 2): same vocabulary and styling as client
 * colour tags (8 built-in tags + custom #hex).
 */
export type WorkerColorPreset = ClientColorPreset
export const WORKER_COLORS: WorkerColorPreset[] = [...CLIENT_COLORS]
export type WorkerColor = ClientColor
export const WORKER_COLOR_NAMES: Record<WorkerColorPreset, string> = {
  blue: 'Blue',
  aqua: 'Aqua',
  violet: 'Violet',
  emerald: 'Emerald',
  amber: 'Amber',
  orange: 'Orange',
  rose: 'Rose',
  slate: 'Slate',
}

export function isWorkerColorPreset(color: string): color is WorkerColorPreset {
  return isClientColorPreset(color as ClientColor)
}

/** True when a value is a valid worker colour tag: 8 presets or #RGB / #RRGGBB hex. */
export function isValidWorkerColor(value: unknown): value is string {
  return isValidClientColor(value)
}

/** Normalizes a worker colour value, falling back to null on empty/invalid input. */
export function normalizeWorkerColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return isValidWorkerColor(trimmed) ? trimmed : null
}

/** Styles for rendering a worker's colour ring, dot or badge. Returns null when unset. */
export function workerColorStyles(color: string | null | undefined): ClientColorStyle | null {
  if (!color) return null
  const norm = normalizeWorkerColor(color)
  if (!norm) return null
  return clientColorStyles(norm)
}

/** Normalize a worker row to the current schema shape, filling defaults for missing fields. */
export function normalizeWorker(w: Partial<Worker> & Record<string, any>): Worker {
  const payment_methods = normalizePaymentMethods(w.payment_methods)
  return {
    id: String(w.id ?? ''),
    name: String(w.name ?? ''),
    email: w.email ? String(w.email) : null,
    hourly_rate: Number.isFinite(Number(w.hourly_rate)) ? Number(w.hourly_rate) : 0,
    status: w.status === 'inactive' ? 'inactive' : 'active',
    position: w.position ? String(w.position) : null,
    avatar_url: w.avatar_url ? String(w.avatar_url) : null,
    payment_methods,
    qr_code_url: payment_methods.includes('qr') ? (w.qr_code_url ?? null) : null,
    permissions: normalizePermissions(w.permissions),
    workdays: normalizeWorkdays(w.workdays),
    weekly_capacity_hours: normalizeWeeklyCapacity(w.weekly_capacity_hours),
    color: normalizeWorkerColor(w.color),
    created_at: w.created_at ? String(w.created_at) : new Date().toISOString(),
    updated_at: w.updated_at ? String(w.updated_at) : new Date().toISOString(),
  }
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

// ---- Client priority board --------------------------------------------------

/**
 * The fixed columns of the client priority board. A client sits in exactly one
 * of them; within a column, smaller position = higher priority (top of the
 * column).
 */
export type ClientPriorityLane = 'me' | 'delegated' | 'waiting' | 'low'

export const CLIENT_PRIORITY_LANES: ClientPriorityLane[] = ['me', 'delegated', 'waiting', 'low']

export const ClientPriorityLaneNames: Record<ClientPriorityLane, string> = {
  me: 'Priority (Me)',
  delegated: 'Priority (Delegated)',
  waiting: 'Waiting for Update',
  low: 'Low Priority',
}

/** Column accent classes — mirrors the TaskStatus column dots. */
export const ClientPriorityLaneStyles: Record<ClientPriorityLane, { dot: string; accent: string; ring: string }> = {
  me: { dot: 'bg-red-500', accent: 'border-l-red-500', ring: 'ring-red-400/40' },
  delegated: { dot: 'bg-amber-500', accent: 'border-l-amber-500', ring: 'ring-amber-500/40' },
  waiting: { dot: 'bg-blue-500', accent: 'border-l-blue-500', ring: 'ring-blue-500/40' },
  low: { dot: 'bg-emerald-500', accent: 'border-l-emerald-500', ring: 'ring-emerald-500/40' },
}

/**
 * One client's place on the priority board: which column and how highly ranked
 * inside it. A client with no row is simply unranked — it renders at the
 * bottom of "Low Priority" (A→Z) until someone drags it, so brand-new clients
 * land on the board automatically and "Reset board" is just "delete every
 * row". One row per client, owned by the workspace like everything else.
 */
export interface ClientPriority {
  id: string
  client_id: string
  lane: ClientPriorityLane
  /** Manual ordering inside the column (smaller sorts first, 0 = top). */
  position: number
  created_at: string
  updated_at: string
}

// ---- Meetings ---------------------------------------------------------------

/**
 * A scheduled meeting on the workspace's Meetings page: a title, when it
 * starts and optional notes. Deliberately basic — no attendees, clients or
 * video links — the page simply splits the list into upcoming (soonest first)
 * and past (newest first).
 */
export interface Meeting {
  id: string
  title: string
  /** Scheduled start (ISO instant). */
  start_time: string
  notes: string | null
  created_at: string
  updated_at: string
}

// ---- Notepad -----------------------------------------------------------------

/** The background tint of a notepad card. `default` is the plain card look. */
export type NoteColor = 'default' | 'amber' | 'emerald' | 'blue' | 'violet' | 'rose'

export const NOTE_COLORS: NoteColor[] = ['default', 'amber', 'emerald', 'blue', 'violet', 'rose']

export const DEFAULT_NOTE_COLOR: NoteColor = 'default'

/**
 * Soft card tints (dark-mode friendly) plus the solid swatch the colour
 * picker shows for each choice.
 */
export const NoteColorStyles: Record<NoteColor, { card: string; swatch: string; label: string }> = {
  default: { card: '', swatch: 'bg-muted-foreground/30', label: 'None' },
  amber: { card: 'border-amber-500/40 bg-amber-500/10', swatch: 'bg-amber-500', label: 'Amber' },
  emerald: { card: 'border-emerald-500/40 bg-emerald-500/10', swatch: 'bg-emerald-500', label: 'Green' },
  blue: { card: 'border-blue-500/40 bg-blue-500/10', swatch: 'bg-blue-500', label: 'Blue' },
  violet: { card: 'border-violet-500/40 bg-violet-500/10', swatch: 'bg-violet-500', label: 'Violet' },
  rose: { card: 'border-rose-500/40 bg-rose-500/10', swatch: 'bg-rose-500', label: 'Rose' },
}

/**
 * A notepad note: a title plus a free-text body, optionally pinned and
 * colour-tinted. STRICTLY PRIVATE — `owner_id` is the account (admin or
 * worker) that wrote it and nobody else can read or change it, not even
 * the admin. The admin and every worker get their own notepad; there is no
 * permission to grant because nothing is ever shared.
 */
export interface Note {
  id: string
  /** The owning account (AuthUser.id). Never rendered — notes have one reader. */
  owner_id: string
  title: string
  body: string
  color: NoteColor
  /** Pinned notes float above the rest, then everything sorts newest edit first. */
  pinned: boolean
  created_at: string
  updated_at: string
}

// ---- Client invoicing -------------------------------------------------------

/**
 * The fixed columns of the client invoicing board. An invoice sits in exactly
 * one of them and dragging is free — forwards to progress it, backwards to
 * undo a mistake. There is no ranking inside a column: the cards sort by due
 * date, so the invoice that needs attention first is always on top.
 */
export type InvoiceStage = 'pending' | 'awaiting' | 'paid'

export const INVOICE_STAGES: InvoiceStage[] = ['pending', 'awaiting', 'paid']

export const InvoiceStageNames: Record<InvoiceStage, string> = {
  pending: 'Pending',
  awaiting: 'Awaiting',
  paid: 'Paid',
}

/**
 * What an invoice bills: the client as a whole, or one named project of that
 * client. Projects are free text here (like time entries carried before
 * clients existed) — there is no projects master list to attach to.
 */
export type InvoiceBasis = 'client' | 'project'

export const INVOICE_BASES: InvoiceBasis[] = ['client', 'project']

export const InvoiceBasisNames: Record<InvoiceBasis, string> = {
  client: 'Client',
  project: 'Project',
}

/** Column accent classes — mirrors the priority board's column dots. */
export const InvoiceStageStyles: Record<InvoiceStage, { dot: string; accent: string; ring: string }> = {
  pending: { dot: 'bg-sky-500', accent: 'border-l-sky-500', ring: 'ring-sky-500/40' },
  awaiting: { dot: 'bg-amber-500', accent: 'border-l-amber-500', ring: 'ring-amber-500/40' },
  paid: { dot: 'bg-emerald-500', accent: 'border-l-emerald-500', ring: 'ring-emerald-500/40' },
}

/**
 * One invoice on the client invoicing board: a client, an amount, when
 * payment is due and optional notes. The kanban stage is the whole status
 * model — there is no invoice numbering, line items or tax here (an invoice
 * raised in the team's real invoicing tool is tracked, not reproduced).
 * Deliberately minimal, like Meetings: whoever can open the board can run it.
 */
export interface Invoice {
  id: string
  /**
   * The client billed — the whole of a client-based invoice. A project-based
   * invoice bills a named project instead and has no client here (null):
   * client and project are different billing targets, never both.
   */
  client_id: string | null
  /** Whether the invoice bills a client ('client') or a named project ('project'). */
  basis: InvoiceBasis
  /** The project billed — required when `basis` is 'project', null otherwise. */
  project_name: string | null
  /** Amount in the workspace's currency; zero while the figure is still unknown. */
  amount: number
  /** 'YYYY-MM-DD' — the day payment is due (a date, not an instant, so timezones cannot move it). */
  due_date: string
  stage: InvoiceStage
  notes: string | null
  created_at: string
  updated_at: string
}

// ---- IT Support tickets ----------------------------------------------------

/** What kind of problem it is, so the queue can be scanned at a glance. */
export type TicketCategory = 'hardware' | 'software' | 'account' | 'other'

/** How urgent it is. Set by the requester, changeable by IT Support. */
export type TicketPriority = 'low' | 'medium' | 'high'

/** Open → In progress → Resolved. A resolved ticket can be reopened. */
export type TicketStatus = 'open' | 'in_progress' | 'resolved'

/**
 * One IT Support ticket.
 *
 * Submitted by **anyone** (a plain worker, the admin, or IT Support itself);
 * readable by **IT Support only** — plus the requester themselves, who reaches
 * their own ticket from the notification it produces rather than from a list.
 * See `isItSupport()` in `./tickets` for why the admin is not IT Support by
 * default: the grant is worker-only.
 *
 * `requester_name` / `assignee_name` are snapshots taken when the row was
 * written. A support queue is read by someone who may not have `workers.view`,
 * so the names travel with the ticket instead of needing the team list.
 */
export interface Ticket {
  id: string
  /** Human-facing ticket number, unique per workspace — shown as `#12`. */
  number: number
  subject: string
  description: string
  category: TicketCategory
  priority: TicketPriority
  status: TicketStatus
  /** The account that submitted it (AuthUser.id) — the only other reader. */
  requester_user_id: string
  requester_name: string
  /** Who is handling it (AuthUser.id + name), or null while unclaimed. */
  assignee_user_id: string | null
  assignee_name: string | null
  /** Screenshots, as data URLs. Only sent with the single-ticket read. */
  attachments: string[]
  /** Number of replies — carried on the list read so a row can show a count. */
  reply_count: number
  created_at: string
  updated_at: string
  resolved_at: string | null
}

/** A message on a ticket, from the requester or from IT Support. */
export interface TicketReply {
  id: string
  ticket_id: string
  author_user_id: string
  author_name: string
  /** True when the author was holding the IT Support grant when they wrote it. */
  from_support: boolean
  body: string
  created_at: string
}

/** Someone a ticket can be assigned to — an account holding the IT Support grant. */
export interface TicketAssignee {
  user_id: string
  name: string
}

/** Everything the detail view needs, in one read. */
export interface TicketThread {
  ticket: Ticket
  replies: TicketReply[]
}

export interface CreateTicketInput {
  subject: string
  description: string
  category: TicketCategory
  priority: TicketPriority
  /** Data URLs from `imageFileToDataUrl` — already downscaled by the caller. */
  attachments?: string[]
}

export interface UpdateTicketInput {
  status?: TicketStatus
  /** Assign to this account, or null to unassign. */
  assignee_user_id?: string | null
  assignee_name?: string | null
}

/**
 * Columns of the task board. Tasks move between them by drag & drop (or the
 * "Move to" menu on touch devices); the order is the order they appear in.
 *
 * The workflow these encode:
 *   TO DO → IN PROGRESS → WAITING → FOR REVIEW → REWORK → COMPLETED
 * Waiting is a side-pile (blocked on someone/something) and Rework is a loop
 * back to the employee after QA — the linear order here is the board's column
 * order, not a strict state machine (drag & drop stays free).
 */
export type TaskStatus = 'recurring' | 'todo' | 'in_progress' | 'waiting' | 'for_review' | 'rework' | 'completed'

/** How often a task repeats — drives the "Recreate next" action. */
export type TaskRepeats = 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly'

export const TASK_REPEATS: TaskRepeats[] = ['daily', 'weekly', 'biweekly', 'monthly']

export const TaskRepeatNames: Record<TaskRepeats, string> = {
  none: 'Does not repeat',
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
}

/**
 * Board stages in display order. `recurring` is the LEFTMOST shelf: a
 * repeating task lives there as its template, and "starting an occurrence"
 * flips it into To Do with the due date advanced one interval.
 */
export const TASK_STATUSES: TaskStatus[] = ['recurring', 'todo', 'in_progress', 'waiting', 'for_review', 'rework', 'completed']

export const TaskStatusNames: Record<TaskStatus, string> = {
  recurring: 'Recurring',
  todo: 'To Do',
  in_progress: 'In Progress',
  waiting: 'Waiting',
  for_review: 'For Review',
  rework: 'Rework',
  completed: 'Completed',
}

/**
 * Map a stored status onto the current stage vocabulary. The pre-KPI board
 * called the QA column `approval`; those rows keep working by reading as
 * `for_review`. Anything unrecognised falls back to To Do (same rule both
 * backends already applied for unknown values).
 */
export function normalizeTaskStage(value: unknown): TaskStatus {
  if (value === 'approval') return 'for_review'
  return TASK_STATUSES.includes(value as TaskStatus) ? (value as TaskStatus) : 'todo'
}

/** Why a task sits in Waiting — kept on the card so blocked aging is explainable. */
export type WaitingReason =
  | 'client'
  | 'manager'
  | 'teammate'
  | 'access'
  | 'approval'
  | 'external'
  | 'other'

export const WAITING_REASONS: WaitingReason[] = ['client', 'manager', 'teammate', 'access', 'approval', 'external', 'other']

export const WaitingReasonNames: Record<WaitingReason, string> = {
  client: 'Waiting on Client',
  manager: 'Waiting on Manager',
  teammate: 'Waiting on Teammate',
  access: 'Waiting on Access',
  approval: 'Waiting on Approval',
  external: 'External Dependency',
  other: 'Other',
}

/** Reasons a reviewer can pick when sending work back — split by whose fault. */
export type ReworkType =
  // Counts against the employee's KPI:
  | 'incorrect_work'
  | 'missing_requirement'
  | 'incomplete_work'
  | 'did_not_follow_instructions'
  | 'qa_correction'
  // Does NOT count against the employee:
  | 'client_requested_change'
  | 'scope_changed'
  | 'new_requirement'
  | 'missing_client_info'
  | 'access_issue'

export const REWORK_TYPES: ReworkType[] = [
  'incorrect_work',
  'missing_requirement',
  'incomplete_work',
  'did_not_follow_instructions',
  'qa_correction',
  'client_requested_change',
  'scope_changed',
  'new_requirement',
  'missing_client_info',
  'access_issue',
]

export const ReworkTypeNames: Record<ReworkType, string> = {
  incorrect_work: 'Incorrect work',
  missing_requirement: 'Missing requirement',
  incomplete_work: 'Incomplete work',
  did_not_follow_instructions: 'Did not follow instructions',
  qa_correction: 'QA correction',
  client_requested_change: 'Client requested change',
  scope_changed: 'Scope changed',
  new_requirement: 'New requirement',
  missing_client_info: 'Missing client information',
  access_issue: 'Access/system issue',
}

/** The rework reasons that are the employee's responsibility (see §11). */
export const EMPLOYEE_CAUSED_REWORK: ReworkType[] = [
  'incorrect_work',
  'missing_requirement',
  'incomplete_work',
  'did_not_follow_instructions',
  'qa_correction',
]

/** True when a rework reason counts against the employee's KPI. */
export function isEmployeeCausedRework(type: ReworkType | null | undefined): boolean {
  return !!type && EMPLOYEE_CAUSED_REWORK.includes(type)
}

/** QA scale: 5 Excellent → 1 Major rework. */
export type QaScore = 1 | 2 | 3 | 4 | 5

export const QA_SCORE_NAMES: Record<QaScore, string> = {
  5: 'Excellent — no corrections',
  4: 'Good — minor correction',
  3: 'Acceptable — several corrections',
  2: 'Significant correction',
  1: 'Major rework',
}

/** One hop on a task's stage history — the audit trail behind every KPI number. */
export interface TaskStageEvent {
  /** Stage the task came from (null when the task was created into `to`). */
  from: TaskStatus | null
  to: TaskStatus
  /** ISO instant of the hop. */
  at: string
  /** Who moved it (display name), best-effort. */
  by: string | null
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
  /** Optional deadline (ISO date, no time component needed). Required on new
   *  tasks; null only on legacy rows predating the rule — those are marked
   *  "Legacy / No Due Date" and excluded from on-time KPI math. */
  due_date: string | null
  /**
   * The due date the task first MISSED, preserved when a deadline is pushed
   * after it has already passed — so KPI history can't be silently rewritten
   * by extending a date the task was already late against.
   */
  original_due_date: string | null
  /** Estimated hours — the primary workload input (see Team KPI). */
  estimated_hours: number | null
  /**
   * Recurrence: how often this task repeats. 'none' = one-off. A repeating
   * COMPLETED card gets a "Recreate next" action that clones it into a new
   * Todo card with the due date advanced by one interval — nothing happens
   * on its own, the series only continues when someone recreates it.
   */
  repeats: TaskRepeats
  /**
   * Optional end date ('YYYY-MM-DD') for the series: once the computed next
   * due date passes it, "Recreate next" is no longer offered. null = no end.
   */
  repeat_until: string | null
  /**
   * The id the series started from. The original task's series_id is its own
   * id; every "Recreate next" clone inherits it, so a chain is traceable.
   */
  series_id: string | null
  /** 1 = the original, 2+ = created by "Recreate next". null = not in a series. */
  occurrence: number | null
  /** Stage timestamps, stamped automatically on the transitions below. */
  assigned_at: string | null
  started_at: string | null
  waiting_since: string | null
  submitted_for_review_at: string | null
  rework_started_at: string | null
  // completed_at is declared below with the rest of the row metadata.
  /** Why the task is Waiting (set while it sits in that column). */
  waiting_reason: WaitingReason | null
  /** QA score 1–5 left by the Owner/PM when the review finished. */
  qa_score: QaScore | null
  qa_reviewed_at: string | null
  /** Display name of whoever scored it (reviewer responsible). */
  qa_reviewed_by: string | null
  /** Did the reviewer send it back? null = not reviewed yet. */
  rework_required: boolean | null
  /** Why it went back — drives whether the rework counts against the employee. */
  rework_type: ReworkType | null
  rework_notes: string | null
  /** Every stage hop since creation (created → … → current). */
  stage_history: TaskStageEvent[]
  /** Manual ordering inside a column (smaller sorts first). */
  position: number
  /** Who created the task — used for the "Added by admin" hint. */
  created_by_role: Role
  /** When the task first landed in the Completed column. */
  completed_at: string | null
  /** When the completed task was archived (null for active board tasks). */
  archived_at: string | null
  created_at: string
  updated_at: string
}

// ---- Team KPI: monthly goals, bonus decisions, audit trail -----------------

/**
 * One employee's targets for one month ('YYYY-MM'). The management inputs on
 * the Team KPI dashboard are exactly these (plus QA scores and bonus
 * approval) — no employee ever types a KPI number. A missing row means the
 * defaults: 90% on-time, 90% QA, and no output target yet (the goal component
 * stays out of the KPI score until a target exists).
 */
export interface MonthlyGoal {
  id: string
  worker_id: string
  /** 'YYYY-MM'. */
  month: string
  /** Planned output for the month (deliverables/tasks, role-specific). */
  target: number | null
  /** On-time % target — 90 by default, 95 for e.g. the Social Media Manager. */
  on_time_target: number | null
  /** QA % target (90 by default). */
  qa_target: number | null
  note: string | null
  created_at: string
  updated_at: string
}

/** Bonus review state. NEVER auto-set from the KPI score — manual only. */
export type BonusEligibility = 'pending' | 'yes' | 'no'

/**
 * The Owner's manual bonus decision for one employee for one month. Defaults
 * to 'pending' when no row exists yet. Editing requires the admin role — a
 * Project Manager with `team_kpi.view` may read but not change it.
 */
export interface BonusDecision {
  id: string
  worker_id: string
  /** 'YYYY-MM'. */
  month: string
  eligible: BonusEligibility
  /** Optional approved amount in the workspace currency. */
  approved_amount: number | null
  /** Display name of who approved (audit). */
  approved_by: string | null
  note: string | null
  created_at: string
  updated_at: string
}

/** Append-only audit entries for everything KPI-sensitive (QA, rework, due
 *  dates, bonus) — the history that stops KPI records being rewritten quietly. */
export interface KpiAuditEvent {
  id: string
  entity_type: 'task' | 'bonus' | 'goal'
  entity_id: string
  /** The employee the event is about, for per-person filtering. */
  worker_id: string | null
  /** Short machine action: 'qa_scored' | 'rework_classified' | 'due_date_changed' | 'bonus_decided' | … */
  action: string
  /** Human-readable line for the audit list. */
  detail: string
  /** Display name of the actor. */
  actor: string
  created_at: string
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
   * How the admin paid this settlement (chosen when marking it paid — Cash or
   * QR Code). Null until the payment is marked paid.
   */
  payment_method?: PaymentMethod | null
  /**
   * The payment's reference / transaction number (GCash, Maya, bank ref…) that
   * the admin typed when marking it paid. Optional; null until then, and
   * cleared when a payment goes back to unpaid or pending.
   */
  reference_number?: string | null
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
  /** How a payroll run was paid. */
  payment_method?: PaymentMethod | null
  note: string | null
  /**
   * Subscriptions only: how many times the subscription bills before it
   * pauses by itself — "for a set number of bills". Null means it runs until
   * someone switches it off (the classic behavior). Other kinds: null.
   */
  max_occurrences: number | null
  /**
   * Subscriptions only: how many of those bills have happened. Counted by
   * the backends — every time the next due date is rolled forward, this goes
   * up by one, and reaching `max_occurrences` pauses the subscription.
   */
  billed_count: number
  created_at: string
  updated_at: string
}
