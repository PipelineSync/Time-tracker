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
  // Login details for the worker's account (admin-created).
  accountEmail?: string
  accountPassword?: string
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

  // Data (scoped to current user + role)
  listWorkers(): Promise<BackendResult<Worker[]>>
  createWorker(input: CreateWorkerInput): Promise<BackendResult<Worker>>
  updateWorker(id: string, patch: Partial<Worker> & { newPassword?: string }): Promise<BackendResult<Worker>>
  deleteWorker(id: string): Promise<BackendResult<null>>
  getWorkerLogin(id: string): Promise<BackendResult<{ email: string | null; password: string | null }>>

  listEntries(): Promise<BackendResult<TimeEntry[]>>
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
  startTimer(input: { worker_id: string; project?: string; notes?: string; start_time?: string; hourly_rate?: number }): Promise<BackendResult<ActiveTimer>>
  /** Start a break. Without `timerId` the caller's own timer is used. */
  pauseTimer(timerId?: string): Promise<BackendResult<ActiveTimer>>
  /** End a break. Without `timerId` the caller's own timer is used. */
  resumeTimer(timerId?: string): Promise<BackendResult<ActiveTimer>>
  stopTimer(timerId: string, note?: string): Promise<BackendResult<TimeEntry>>
  deleteTimer(timerId: string): Promise<BackendResult<null>>

  getSettings(): Promise<BackendResult<Settings>>
  saveSettings(patch: Partial<Settings>): Promise<BackendResult<Settings>>

  // Notes / chat on entries
  listEntryComments(entryId: string): Promise<BackendResult<TimeEntryComment[]>>
  addEntryComment(entryId: string, body: string): Promise<BackendResult<TimeEntryComment>>

  // Notifications
  listNotifications(): Promise<BackendResult<AppNotification[]>>
  markNotificationsRead(): Promise<BackendResult<null>>

  // Payments / settlements
  listPayments(): Promise<BackendResult<Payment[]>>
  settleWorker(workerId: string, note?: string): Promise<BackendResult<Payment>>
  updatePaymentStatus(id: string, status: PaymentStatus): Promise<BackendResult<Payment>>
  updatePaymentNote(id: string, note: string | null): Promise<BackendResult<Payment>>
  deletePayment(id: string): Promise<BackendResult<null>>

  resetAll(): Promise<BackendResult<null>>
  seedDemo(): Promise<BackendResult<null>>
}

export type { Role, PaymentStatus }

