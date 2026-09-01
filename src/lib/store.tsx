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
  AppNotification,
  Payment,
  PaymentStatus,
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
  activeTimer: ActiveTimer | null
  notifications: AppNotification[]
  payments: Payment[]
  unreadCount: number
  dataLoading: boolean

  signIn: (email: string, password: string) => Promise<string | null>
  signOut: () => Promise<void>
  resetPassword: (email: string) => Promise<string | null>
  changePassword: (currentPassword: string, newPassword: string) => Promise<string | null>
  resetWorkerPassword: (workerId: string, newPassword: string) => Promise<string | null>

  refreshData: () => Promise<void>

  createWorker: (input: CreateWorkerInput) => Promise<Worker | null>
  updateWorker: (id: string, patch: Partial<Worker> & { newPassword?: string }) => Promise<Worker | null>
  deleteWorker: (id: string) => Promise<boolean>
  getWorkerLogin: (id: string) => Promise<{ email: string | null; password: string | null } | null>

  createEntry: (input: Omit<TimeEntry, 'id' | 'created_at' | 'updated_at'>) => Promise<TimeEntry | null>
  updateEntry: (id: string, patch: Partial<TimeEntry>) => Promise<TimeEntry | null>
  deleteEntry: (id: string) => Promise<boolean>
  duplicateEntry: (entry: TimeEntry) => Promise<boolean>

  startTimer: (input: { worker_id: string; project?: string; notes?: string; hourly_rate?: number }) => Promise<BackendResult<ActiveTimer>>
  pauseTimer: () => Promise<BackendResult<ActiveTimer>>
  resumeTimer: () => Promise<BackendResult<ActiveTimer>>
  stopTimer: (note?: string) => Promise<BackendResult<TimeEntry>>
  cancelTimer: () => Promise<void>

  saveSettings: (patch: Partial<Settings>) => Promise<Settings | null>
  resetAllData: () => Promise<void>
  seedDemo: () => Promise<void>

  listEntryComments: (entryId: string) => Promise<TimeEntryComment[]>
  addEntryComment: (entryId: string, body: string) => Promise<TimeEntryComment | null>
  markNotificationsRead: () => Promise<void>

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
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [dataLoading, setDataLoading] = useState(false)
  const dataVersion = useRef(0)
  const userRef = useRef(user)
  useEffect(() => { userRef.current = user }, [user])

  const isAdmin = user?.role === 'admin'

  const refreshData = useCallback(async () => {
    const uid = userRef.current
    if (!uid) return
    const token = ++dataVersion.current
    setDataLoading(true)
    try {
      const [w, e, s, t, n, p] = await Promise.all([
        backend.listWorkers(),
        backend.listEntries(),
        backend.getSettings(),
        backend.getActiveTimer(),
        backend.listNotifications(),
        backend.listPayments(),
      ])
      if (token !== dataVersion.current) return
      if (w.data) setWorkers(w.data)
      if (e.data) setEntries(e.data)
      if (s.data) setSettings(s.data)
      if (t.data) setActiveTimer(t.data)
      if (n.data) setNotifications(n.data)
      if (p.data) setPayments(p.data)
    } finally {
      if (token === dataVersion.current) setDataLoading(false)
    }
  }, [backend])

  // Load initial session
  useEffect(() => {
    backend.getSession().then(async (res) => {
      if (res.data) {
        setUser(res.data)
      }
      setAuthLoading(false)
    })
  }, [backend])

  // Load data when user changes
  useEffect(() => {
    if (user) {
      refreshData()
    } else {
      setWorkers([]); setEntries([]); setSettings(null); setActiveTimer(null); setNotifications([]); setPayments([])
    }
  }, [user, refreshData])

  // Keep cross-account updates fresh. Worker/admin actions happen in different
  // browser sessions, so poll lightly and refresh on focus to pick up new
  // entries, notes, and unread notifications without requiring a reload. The
  // session is re-validated on each tick so an account that the admin deletes
  // (or a token that stops being valid) is signed out without a reload. A
  // transient network error must NOT sign the user out — it just retries.
  useEffect(() => {
    if (!user) return
    let stopped = false
    const tick = async () => {
      if (document.visibilityState === 'hidden' || stopped) return
      const session = await backend.getSession()
      if (stopped) return
      if (!userRef.current) return
      if (session.data) {
        if (session.data.id !== userRef.current.id) setUser(session.data)
        void refreshData()
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
        // Clean sign-out (e.g. an expired token that could not refresh).
        setUser(null)
        return
      }
      // Transient error — keep the session and let the next tick retry.
      void refreshData()
    }
    const interval = window.setInterval(tick, 15000)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => {
      stopped = true
      window.clearInterval(interval)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', tick)
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
    const t = await backend.getActiveTimer()
    if (t.data) setActiveTimer(t.data)
  }

  const startTimer = useCallback(async (input: { worker_id: string; project?: string; notes?: string; hourly_rate?: number }) => {
    const res = await backend.startTimer(input)
    if (res.error || !res.data) return { data: null, error: res.error }
    setActiveTimer(res.data)
    return { data: res.data, error: null }
  }, [backend])

  const pauseTimer = useCallback(async () => {
    const res = await backend.pauseTimer()
    if (res.error || !res.data) return { data: null, error: res.error }
    setActiveTimer(res.data)
    return { data: res.data, error: null }
  }, [backend])

  const resumeTimer = useCallback(async () => {
    const res = await backend.resumeTimer()
    if (res.error || !res.data) return { data: null, error: res.error }
    setActiveTimer(res.data)
    return { data: res.data, error: null }
  }, [backend])

  const stopTimer = useCallback(async (note?: string) => {
    const current = activeTimer
    if (!current) return { data: null, error: 'No timer is running.' }
    const res = await backend.stopTimer(current.id, note?.trim() ? note.trim() : undefined)
    if (res.error || !res.data) return { data: null, error: res.error }
    setActiveTimer(null)
    await refreshTimer()
    await refreshData()
    return { data: res.data, error: null }
  }, [backend, activeTimer, refreshData])

  const cancelTimer = useCallback(async () => {
    const current = activeTimer
    if (current) {
      await backend.deleteTimer(current.id)
      setActiveTimer(null)
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
    notifications,
    payments,
    unreadCount,
    dataLoading,
    signIn,
    signOut,
    resetPassword,
    changePassword,
    resetWorkerPassword,
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
