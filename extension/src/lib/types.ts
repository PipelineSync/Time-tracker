/**
 * The slice of the Work Tracker database the extension touches. Field-for-field
 * identical to `src/lib/types.ts` in the web app, so both clients read and
 * write the same rows the same way.
 */

export interface ActiveTimer {
  id: string
  worker_id: string
  project: string | null
  start_time: string // ISO
  notes: string | null
  hourly_rate: number
  paused: boolean
  pause_start: string | null // ISO, when the current break began
  total_pause_ms: number // break time accumulated before the current break
  created_at: string
}

export interface TimeEntry {
  id: string
  worker_id: string
  project: string | null
  start_time: string
  end_time: string
  break_minutes: number
  notes: string | null
  hourly_rate: number
  total_minutes: number
  earnings: number
}

export interface WorkerRow {
  id: string
  name: string
  hourly_rate: number
  status: 'active' | 'inactive'
  position: string | null
}

export type NotificationType =
  | 'note'
  | 'time_in'
  | 'time_out'
  | 'time_added'
  | 'payment'
  | 'break_start'
  | 'break_end'
  | 'chat'
