import type {
  Worker,
  TimeEntry,
  ActiveTimer,
  Settings,
  SlackSettings,
  AuthUser,
  TimeEntryComment,
  ChatMessage,
  ChatMember,
  ChatReaction,
  AppNotification,
  Payment,
  PaymentStatus,
  PaymentMethod,
  Role,
} from './types'

export interface BackendResult<T> {
  data: T | null
  error: string | null
}

/** Shown when an account that used to work is deleted by the admin. */
export const ACCOUNT_DEACTIVATED_MESSAGE =
  'This account is no longer active. If you believe this is a mistake, please contact the administrator.'

/** Longest single team-chat message the backends accept. */
export const CHAT_MAX_LENGTH = 2000
/** How many messages the chat page pulls by default (newest window). */
export const CHAT_PAGE_SIZE = 200

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
  // Worker self-service: the signed-in worker chooses which payment methods
  // they accept (cash and/or QR code), uploading their QR code image when QR
  // is enabled. Only touches these two fields on the worker's own row.
  updateOwnPaymentMethods(patch: { payment_methods: PaymentMethod[]; qr_code_url?: string | null }): Promise<BackendResult<Worker>>

  // Data (scoped to current user + role)
  listWorkers(): Promise<BackendResult<Worker[]>>
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
  startTimer(input: { worker_id: string; project?: string; notes?: string; start_time?: string; hourly_rate?: number }): Promise<BackendResult<ActiveTimer>>
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

  /**
   * Team chat (the Chat section). Every member of the workspace posts into one
   * shared room: the admin and all workers see the same messages.
   */
  listChatMessages(limit?: number): Promise<BackendResult<ChatMessage[]>>
  sendChatMessage(body: string): Promise<BackendResult<ChatMessage>>
  /** Everyone in the chat, including the admin — identical for every role. */
  listChatMembers(): Promise<BackendResult<ChatMember[]>>
  /**
   * Emoji reactions on the workspace's chat messages, oldest first. Reactions
   * are deliberately quiet: they never create a notification.
   */
  listChatReactions(): Promise<BackendResult<ChatReaction[]>>
  /**
   * Add the emoji to the message, or remove it if the caller already reacted
   * with it. Resolves with that message's reactions, so the caller can drop the
   * result straight into the row it toggled.
   */
  toggleChatReaction(messageId: string, emoji: string): Promise<BackendResult<ChatReaction[]>>

  // Notifications
  /** The most recent notifications for the signed-in user (`limit` caps the
   *  dropdown; the unread badge uses countUnreadNotifications instead). */
  listNotifications(limit?: number): Promise<BackendResult<AppNotification[]>>
  /** How many of the signed-in user's notifications are still unread. */
  countUnreadNotifications(): Promise<BackendResult<number>>
  markNotificationsRead(): Promise<BackendResult<null>>

  // Payments / settlements
  listPayments(limit?: number): Promise<BackendResult<Payment[]>>
  settleWorker(workerId: string, note?: string): Promise<BackendResult<Payment>>
  /**
   * Change a payment's status. When marking it `paid`, `paymentMethod` records
   * how the admin paid (cash or QR code); other statuses clear it.
   */
  updatePaymentStatus(id: string, status: PaymentStatus, paymentMethod?: PaymentMethod | null): Promise<BackendResult<Payment>>
  updatePaymentNote(id: string, note: string | null): Promise<BackendResult<Payment>>
  deletePayment(id: string): Promise<BackendResult<null>>

  resetAll(): Promise<BackendResult<null>>
  seedDemo(): Promise<BackendResult<null>>
}

export type { Role, PaymentStatus }

