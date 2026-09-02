export type WorkerStatus = 'active' | 'inactive'

export type Role = 'admin' | 'worker'

export interface Worker {
  id: string
  name: string
  email: string | null
  hourly_rate: number
  status: WorkerStatus
  position: string | null
  avatar_url: string | null
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
 * A message in the workspace-wide team chat (the Chat section in the sidebar).
 * Author details are snapshotted on the row so a message always shows who wrote
 * it, even if their profile changes or their account is later removed. The UI
 * prefers the live member record when it is still available, so a new profile
 * picture shows up on older messages too.
 */
export interface ChatMessage {
  id: string
  author_id: string // auth user id of the sender
  worker_id: string | null // worker row for workers, null for the admin
  author_name: string
  author_role: Role
  author_position: string | null
  author_avatar_url: string | null
  body: string
  created_at: string
}

/**
 * One entry in the team chat member list (admin + every worker). Unlike
 * `listWorkers`, this is never scoped down for workers — the chat member list is
 * the same for everyone so a worker can see the whole team, including the admin.
 */
export interface ChatMember {
  /** Stable row key: the worker id for workers, the auth user id for the admin. */
  id: string
  user_id: string | null
  worker_id: string | null
  name: string
  role: Role
  position: string | null
  avatar_url: string | null
  /** Worker account status; null for the admin, who is always a member. */
  worker_status: WorkerStatus | null
}

export type NotificationType =
  | 'note'
  | 'time_in'
  | 'time_out'
  | 'time_added'
  | 'payment'
  | 'break_start'
  | 'break_end'
  /** A teammate posted in the team chat. */
  | 'chat'

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
}
