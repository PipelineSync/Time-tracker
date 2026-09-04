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
