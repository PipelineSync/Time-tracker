import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type {
  Worker,
  TimeEntry,
  ActiveTimer,
  Settings,
  AuthUser,
  TimeEntryComment,
  ChatMessage,
  ChatMember,
  AppNotification,
  Payment,
  PaymentStatus,
  PaymentMethod,
} from './types'
import type { DataBackend, CreateWorkerInput, BackendResult } from './backend'
import { localBackend } from './localDb'
import { supabaseBackend, isSupabaseConfigured, ACCOUNT_DEACTIVATED_MESSAGE } from './supabaseDb'
import { toast } from 'sonner'

function pickBackend(): DataBackend {
  if (isSupabaseConfigured()) return supabaseBackend
  // Falling back to browser-local demo mode. If you expected Supabase (e.g. on a
  // deployed site), the VITE_SUPABASE_* environment variables were missing at build time.
  console.warn(
    '[work-tracker] Supabase is not configured — falling back to local demo mode. ' +
      'Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY at build time to connect Supabase.'
  )
  return localBackend
}

interface StoreValue {
  backend: DataBackend
  user: AuthUser | null
  isAdmin: boolean
  authLoading: boolean

  workers: Worker[]
  entries: TimeEntry[]
  settings: Settings | null
  /** The signed-in user's own running timer. */
  activeTimer: ActiveTimer | null
  /** Everyone currently on the clock (admin: all workers, worker: only self). */
  activeTimers: ActiveTimer[]
  notifications: AppNotification[]
  payments: Payment[]
  unreadCount: number
  dataLoading: boolean

  signIn: (email: string, password: string) => Promise<string | null>
  signOut: () => Promise<void>
  resetPassword: (email: string) => Promise<string | null>
  changePassword: (currentPassword: string, newPassword: string) => Promise<string | null>
  resetWorkerPassword: (workerId: string, newPassword: string) => Promise<string | null>
  /** Worker self-service: update the signed-in worker's own profile picture. */
  updateOwnProfile: (avatarUrl: string | null) => Promise<Worker | null>
  /** Worker self-service: choose accepted payment methods (+ QR code image). */
  updateOwnPaymentMethods: (paymentMethods: PaymentMethod[], qrCodeUrl?: string | null) => Promise<Worker | null>

  refreshData: (opts?: { background?: boolean; light?: boolean }) => Promise<void>

  createWorker: (input: CreateWorkerInput) => Promise<Worker | null>
  updateWorker: (id: string, patch: Partial<Worker> & { newPassword?: string }) => Promise<Worker | null>
  deleteWorker: (id: string) => Promise<boolean>
  getWorkerLogin: (id: string) => Promise<{ email: string | null; password: string | null } | null>

  createEntry: (input: Omit<TimeEntry, 'id' | 'created_at' | 'updated_at'>) => Promise<TimeEntry | null>
  updateEntry: (id: string, patch: Partial<TimeEntry>) => Promise<TimeEntry | null>
  deleteEntry: (id: string) => Promise<boolean>
  duplicateEntry: (entry: TimeEntry) => Promise<boolean>

  startTimer: (input: { worker_id: string; project?: string; notes?: string; hourly_rate?: number }) => Promise<BackendResult<ActiveTimer>>
  pauseTimer: (timerId?: string) => Promise<BackendResult<ActiveTimer>>
  resumeTimer: (timerId?: string) => Promise<BackendResult<ActiveTimer>>
  stopTimer: (note?: string) => Promise<BackendResult<TimeEntry>>
  cancelTimer: () => Promise<void>

  saveSettings: (patch: Partial<Settings>) => Promise<Settings | null>
  resetAllData: () => Promise<void>
  seedDemo: () => Promise<void>

  listEntryComments: (entryId: string) => Promise<TimeEntryComment[]>
  addEntryComment: (entryId: string, body: string) => Promise<TimeEntryComment | null>
  markNotificationsRead: () => Promise<void>

  /** Team chat: the shared room for the admin and every worker. Reads report the
   * backend error (not just an empty list) so the page can explain, for example,
   * that a Supabase database still needs the chat migration. */
  listChatMessages: (limit?: number) => Promise<{ messages: ChatMessage[]; error: string | null }>
  sendChatMessage: (body: string) => Promise<{ message: ChatMessage | null; error: string | null }>
  listChatMembers: () => Promise<{ members: ChatMember[]; error: string | null }>

  settleWorker: (workerId: string, note?: string) => Promise<Payment | null>
  updatePaymentStatus: (id: string, status: PaymentStatus) => Promise<Payment | null>
  updatePaymentNote: (id: string, note: string | null) => Promise<Payment | null>
  deletePayment: (id: string) => Promise<boolean>
}

const StoreContext = createContext<StoreValue | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const backend = useMemo(pickBackend, [])
  const [user, setUser] = useState<AuthUser | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [workers, setWorkers] = useState<Worker[]>([])
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [activeTimer, setActiveTimer] = useState<ActiveTimer | null>(null)
  const [activeTimers, setActiveTimers] = useState<ActiveTimer[]>([])
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [dataLoading, setDataLoading] = useState(false)
  const dataVersion = useRef(0)
  // Suppress stacking background refreshes (see refreshData).
  const refreshInFlight = useRef(false)
  const userRef = useRef(user)
  useEffect(() => { userRef.current = user }, [user])

  const isAdmin = user?.role === 'admin'

  /** A BackendResult-shaped "don't refetch this" placeholder for light refreshes. */
  function skipped<T>(): { data: T | null; error: null } {
    return { data: null, error: null }
  }

  // What a refresh refetches. Timers and notifications need to stay near
  // real-time (who is on the clock, the unread badge); the heavy lists
  // (workers, entries, payments, settings) change rarely but are the bulk of
  // the database traffic, so background polls fetch them far less often.
  // `background` marks opportunistic refreshes (poll tick / tab focus) which
  // must never stack on a refresh that is already running — focus and
  // visibilitychange fire as a burst, and letting each of them fire the whole
  // query set multiplied database load for every open tab. Refreshes triggered
  // by the user's own actions always run.
  const refreshData = useCallback(async (opts?: { background?: boolean; light?: boolean }) => {
    const uid = userRef.current
    if (!uid) return
    if (opts?.background && refreshInFlight.current) return
    refreshInFlight.current = true
    const light = !!opts?.light
    const token = ++dataVersion.current
    setDataLoading(true)
    try {
      const [w, e, s, at, n, p] = await Promise.all([
        light ? skipped<Worker[]>() : backend.listWorkers(),
        light ? skipped<TimeEntry[]>() : backend.listEntries(),
        light ? skipped<Settings>() : backend.getSettings(),
        // One query covers both "everyone on the clock" and the signed-in
        // worker's own timer — getActiveTimer() re-runs this exact query.
        backend.listActiveTimers(),
        backend.listNotifications(),
        light ? skipped<Payment[]>() : backend.listPayments(),
      ])
      if (token !== dataVersion.current) return
      if (w.data) setWorkers(w.data)
      if (e.data) setEntries(e.data)
      if (s.data) setSettings(s.data)
      // Clear on a clean empty result (someone clocked out elsewhere); keep the
      // previous value when the backend errored so a blip doesn't hide a timer.
      if (!at.error) {
        const timers = at.data ?? []
        setActiveTimers(timers)
        // The backend scopes the list to the signed-in worker (self-healing
        // stale rows), so their own timer is the first row. The admin has no
        // personal timer.
        setActiveTimer(userRef.current?.role === 'worker' ? timers[0] ?? null : null)
      }
      if (n.data) setNotifications(n.data)
      if (p.data) setPayments(p.data)
    } finally {
      refreshInFlight.current = false
      if (token === dataVersion.current) setDataLoading(false)
    }
  }, [backend])

  // Load initial session. The Supabase backend restores/refreshes the stored
  // session here, so a reload keeps the user signed in.
  useEffect(() => {
    let cancelled = false
    backend
      .getSession()
      .then((res) => {
        if (cancelled) return
        if (res.data) setUser(res.data)
      })
      .catch((err) => {
        // Never let a session hiccup block the app on the loading screen.
        console.warn('[work-tracker] could not load the session:', err)
      })
      .finally(() => {
        if (!cancelled) setAuthLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [backend])

  // Load data when user changes
  useEffect(() => {
    if (user) {
      refreshData()
    } else {
      setWorkers([]); setEntries([]); setSettings(null); setActiveTimer(null); setActiveTimers([]); setNotifications([]); setPayments([])
    }
  }, [user, refreshData])

  // Keep cross-account updates fresh. Worker/admin actions happen in different
  // browser sessions, so poll lightly and refresh on focus to pick up new
  // entries, notes, and unread notifications without requiring a reload. The
  // session is re-validated on each tick so an account that the admin deletes
  // (or a token that stops being valid) is signed out without a reload. A
  // transient network error must NOT sign the user out — it just retries, and
  // the backend restores a valid session (via its refresh token) whenever the
  // stored session briefly disappears.
  //
  // Tick budget: every 15s tick fetches only timers + notifications (cheap,
  // near-real-time). The heavy lists (workers, entries, payments, settings)
  // refetch on every 4th tick (~once a minute) and on any full refresh
  // triggered by the user's own actions or on returning to the tab. This keeps
  // per-tab database load roughly constant as the workspace grows instead of
  // scaling with the entry history.
  useEffect(() => {
    if (!user) return
    let stopped = false
    let ticks = 0
    const tick = (full: boolean) => {
      if (document.visibilityState === 'hidden' || stopped) return
      void (async () => {
        try {
          const session = await backend.getSession()
          if (stopped) return
          if (!userRef.current) return
          if (session.data) {
            if (session.data.id !== userRef.current.id) setUser(session.data)
            void refreshData({ background: true, light: !full && ++ticks % 4 !== 0 })
            return
          }
          // No user data. Distinguish why:
          if (session.error === ACCOUNT_DEACTIVATED_MESSAGE) {
            // The admin deleted this account — sign out with a specific notice.
            toast.error('You were signed out because your account is no longer active. If this was unexpected, please contact the administrator.')
            setUser(null)
            return
          }
          if (!session.error) {
            // A real sign-out: the user logged out, or the backend confirmed the
            // session can no longer be refreshed (revoked/expired for good).
            setUser(null)
            return
          }
          // Transient error — keep the session and let the next tick retry.
          void refreshData({ background: true, light: true })
        } catch (err) {
          // A thrown error must never be treated as a sign-out.
          console.warn('[work-tracker] session check failed; will retry:', err)
        }
      })()
    }
    const interval = window.setInterval(() => tick(false), 15000)
    const onFocus = () => tick(true)
    const onVisibility = () => tick(true)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [user, refreshData, backend])

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await backend.signIn(email, password)
    if (res.error) return res.error
    setUser(res.data)
    return null
  }, [backend])

  const signOut = useCallback(async () => {
    await backend.signOut()
    setUser(null)
  }, [backend])

  const resetPassword = useCallback(async (email: string) => {
    const res = await backend.resetPassword(email)
    return res.error
  }, [backend])

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await backend.changePassword(currentPassword, newPassword)
    return res.error
  }, [backend])

  const resetWorkerPassword = useCallback(async (workerId: string, newPassword: string) => {
    const res = await backend.resetWorkerPassword(workerId, newPassword)
    return res.error
  }, [backend])

  const updateOwnProfile = useCallback(async (avatarUrl: string | null) => {
    const res = await backend.updateOwnProfile({ avatar_url: avatarUrl })
    if (res.error || !res.data) return null
    await refreshData()
    return res.data
  }, [backend, refreshData])

  const updateOwnPaymentMethods = useCallback(async (paymentMethods: PaymentMethod[], qrCodeUrl?: string | null) => {
    const res = await backend.updateOwnPaymentMethods({ payment_methods: paymentMethods, qr_code_url: qrCodeUrl })
    if (res.error || !res.data) return null
    await refreshData()
    return res.data
  }, [backend, refreshData])

  const createWorker = useCallback(async (input: CreateWorkerInput) => {
    const res = await backend.createWorker(input)
    if (res.error || !res.data) return null
    await refreshData()
    return res.data
  }, [backend, refreshData])

  const updateWorker = useCallback(async (id: string, patch: Partial<Worker> & { newPassword?: string }) => {
    const res = await backend.updateWorker(id, patch)
    if (res.error || !res.data) return null
    await refreshData()
    return res.data
  }, [backend, refreshData])

  const deleteWorker = useCallback(async (id: string) => {
    const res = await backend.deleteWorker(id)
    if (res.error) return false
    await refreshData()
    return true
  }, [backend, refreshData])

  const getWorkerLogin = useCallback(async (id: string) => {
    const res = await backend.getWorkerLogin(id)
    if (res.error || !res.data) return null
    return res.data
  }, [backend])

  const createEntry = useCallback(async (input: Omit<TimeEntry, 'id' | 'created_at' | 'updated_at'>) => {
    const res = await backend.createEntry(input)
    if (res.error || !res.data) return null
    await refreshData()
    return res.data
  }, [backend, refreshData])

  const updateEntry = useCallback(async (id: string, patch: Partial<TimeEntry>) => {
    const res = await backend.updateEntry(id, patch)
    if (res.error || !res.data) return null
    await refreshData()
    return res.data
  }, [backend, refreshData])

  const deleteEntry = useCallback(async (id: string) => {
    const res = await backend.deleteEntry(id)
    if (res.error) return false
    await refreshData()
    return true
  }, [backend, refreshData])

  const duplicateEntry = useCallback(async (entry: TimeEntry) => {
    const res = await backend.createEntry({
      worker_id: entry.worker_id,
      project: entry.project,
      start_time: entry.start_time,
      end_time: entry.end_time,
      break_minutes: entry.break_minutes,
      notes: entry.notes,
      hourly_rate: entry.hourly_rate,
      total_minutes: entry.total_minutes,
      earnings: entry.earnings,
    })
    if (res.error || !res.data) return false
    await refreshData()
    return true
  }, [backend, refreshData])

  async function refreshTimer() {
    // One query for both lists — getActiveTimer() re-runs listActiveTimers().
    const at = await backend.listActiveTimers()
    if (!at.error) {
      const timers = at.data ?? []
      setActiveTimers(timers)
      setActiveTimer(userRef.current?.role === 'worker' ? timers[0] ?? null : null)
    }
  }

  /** Keep the running-timer list in sync after a local timer change. */
  const upsertActiveTimer = useCallback((timer: ActiveTimer) => {
    setActiveTimers((prev) => {
      const idx = prev.findIndex((t) => t.id === timer.id)
      if (idx === -1) return [timer, ...prev]
      const next = [...prev]
      next[idx] = timer
      return next
    })
  }, [])

  const startTimer = useCallback(async (input: { worker_id: string; project?: string; notes?: string; hourly_rate?: number }) => {
    const res = await backend.startTimer(input)
    if (res.error || !res.data) return { data: null, error: res.error }
    if (!userRef.current || userRef.current.role === 'worker') setActiveTimer(res.data)
    upsertActiveTimer(res.data)
    return { data: res.data, error: null }
  }, [backend, upsertActiveTimer])

  const pauseTimer = useCallback(async (timerId?: string) => {
    const res = await backend.pauseTimer(timerId)
    if (res.error || !res.data) return { data: null, error: res.error }
    setActiveTimer((prev) => (prev && prev.id === res.data!.id ? res.data : prev))
    upsertActiveTimer(res.data)
    return { data: res.data, error: null }
  }, [backend, upsertActiveTimer])

  const resumeTimer = useCallback(async (timerId?: string) => {
    const res = await backend.resumeTimer(timerId)
    if (res.error || !res.data) return { data: null, error: res.error }
    setActiveTimer((prev) => (prev && prev.id === res.data!.id ? res.data : prev))
    upsertActiveTimer(res.data)
    return { data: res.data, error: null }
  }, [backend, upsertActiveTimer])

  const stopTimer = useCallback(async (note?: string) => {
    const current = activeTimer
    if (!current) return { data: null, error: 'No timer is running.' }
    const res = await backend.stopTimer(current.id, note?.trim() ? note.trim() : undefined)
    if (res.error || !res.data) return { data: null, error: res.error }
    setActiveTimer(null)
    setActiveTimers((prev) => prev.filter((t) => t.id !== current.id))
    await refreshTimer()
    await refreshData()
    return { data: res.data, error: null }
  }, [backend, activeTimer, refreshData])

  const cancelTimer = useCallback(async () => {
    const current = activeTimer
    if (current) {
      await backend.deleteTimer(current.id)
      setActiveTimer(null)
      setActiveTimers((prev) => prev.filter((t) => t.id !== current.id))
    }
  }, [backend, activeTimer])

  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    const res = await backend.saveSettings(patch)
    if (res.error || !res.data) return null
    setSettings(res.data)
    return res.data
  }, [backend])

  const resetAllData = useCallback(async () => {
    await backend.resetAll()
    await refreshData()
  }, [backend, refreshData])

  const seedDemo = useCallback(async () => {
    await backend.seedDemo()
    await refreshData()
  }, [backend, refreshData])

  const listEntryComments = useCallback(async (entryId: string) => {
    const res = await backend.listEntryComments(entryId)
    return res.data || []
  }, [backend])

  const addEntryComment = useCallback(async (entryId: string, body: string) => {
    const res = await backend.addEntryComment(entryId, body)
    if (res.error || !res.data) return null
    await refreshData()
    return res.data
  }, [backend, refreshData])

  const markNotificationsRead = useCallback(async () => {
    await backend.markNotificationsRead()
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
  }, [backend])

  const listChatMessages = useCallback(async (limit?: number) => {
    const res = await backend.listChatMessages(limit)
    return { messages: res.data || [], error: res.error }
  }, [backend])

  const sendChatMessage = useCallback(async (body: string) => {
    const res = await backend.sendChatMessage(body)
    if (res.error || !res.data) return { message: null, error: res.error || 'Failed to send message.' }
    return { message: res.data, error: null }
  }, [backend])

  const listChatMembers = useCallback(async () => {
    const res = await backend.listChatMembers()
    return { members: res.data || [], error: res.error }
  }, [backend])

  const settleWorker = useCallback(async (workerId: string, note?: string) => {
    const res = await backend.settleWorker(workerId, note)
    if (res.error || !res.data) return null
    await refreshData()
    return res.data
  }, [backend, refreshData])

  const updatePaymentStatus = useCallback(async (id: string, status: PaymentStatus) => {
    const res = await backend.updatePaymentStatus(id, status)
    if (res.error || !res.data) return null
    await refreshData()
    return res.data
  }, [backend, refreshData])

  const updatePaymentNote = useCallback(async (id: string, note: string | null) => {
    const res = await backend.updatePaymentNote(id, note)
    if (res.error || !res.data) return null
    await refreshData()
    return res.data
  }, [backend, refreshData])

  const deletePayment = useCallback(async (id: string) => {
    const res = await backend.deletePayment(id)
    if (res.error) return false
    await refreshData()
    return true
  }, [backend, refreshData])

  const unreadCount = notifications.filter((n) => !n.read).length

  const value: StoreValue = {
    backend,
    user,
    isAdmin,
    authLoading,
    workers,
    entries,
    settings,
    activeTimer,
    activeTimers,
    notifications,
    payments,
    unreadCount,
    dataLoading,
    signIn,
    signOut,
    resetPassword,
    changePassword,
    resetWorkerPassword,
    updateOwnProfile,
    updateOwnPaymentMethods,
    refreshData,
    createWorker,
    updateWorker,
    deleteWorker,
    getWorkerLogin,
    createEntry,
    updateEntry,
    deleteEntry,
    duplicateEntry,
    startTimer,
    pauseTimer,
    resumeTimer,
    stopTimer,
    cancelTimer,
    saveSettings,
    resetAllData,
    seedDemo,
    listEntryComments,
    addEntryComment,
    markNotificationsRead,
    listChatMessages,
    sendChatMessage,
    listChatMembers,
    settleWorker,
    updatePaymentStatus,
    updatePaymentNote,
    deletePayment,
  }

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
