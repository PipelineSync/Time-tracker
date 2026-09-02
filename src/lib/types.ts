export type WorkerStatus = 'active' | 'inactive'

export type Role = 'admin' | 'worker'

export interface Worker {
  id: string
  name: string
  email: string | null
  hourly_rate: number
  status: WorkerStatus
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
