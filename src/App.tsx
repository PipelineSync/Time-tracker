import { lazy, Suspense } from 'react'
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useStore } from '@/lib/store'
import { isNativeShell } from '@/lib/platform'
import { AppLayout } from '@/components/AppLayout'
import { AuthPage } from '@/pages/AuthPage'
import { FullScreenLoader } from '@/components/FullScreenLoader'

// Route-level code splitting: each page downloads as its own chunk, so a
// worker opening the clock-in page on a phone doesn't also download the
// reports charts, the admin dashboard, chat, etc. (Pages use named exports,
// so map them onto the default export React.lazy expects.)
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })))
const TrackerPage = lazy(() => import('@/pages/TrackerPage').then((m) => ({ default: m.TrackerPage })))
const EntriesPage = lazy(() => import('@/pages/EntriesPage').then((m) => ({ default: m.EntriesPage })))
const WorkersPage = lazy(() => import('@/pages/WorkersPage').then((m) => ({ default: m.WorkersPage })))
const ReportsPage = lazy(() => import('@/pages/ReportsPage').then((m) => ({ default: m.ReportsPage })))
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const ChatPage = lazy(() => import('@/pages/ChatPage').then((m) => ({ default: m.ChatPage })))
const PaymentsPage = lazy(() => import('@/pages/PaymentsPage').then((m) => ({ default: m.PaymentsPage })))

export function App() {
  const { user, authLoading, isAdmin } = useStore()

  if (authLoading) {
    return <FullScreenLoader />
  }

  if (!user) {
    return <AuthPage />
  }

  // Native shells (Capacitor WebView, Tauri webview) resolve URLs against the
  // packaged bundle: "/entries" is not a real file there, so a reload or a
  // deep link would 404 under BrowserRouter. Hash routing keeps every route
  // resolvable in those shells while the hosted web app keeps clean URLs.
  const Router = isNativeShell() ? HashRouter : BrowserRouter

  return (
    <Router>
      <Suspense fallback={<FullScreenLoader />}>
        <Routes>
        <Route element={<AppLayout />}>
          {/* Workers clock in/out */}
          {!isAdmin && <Route path="/tracker" element={<TrackerPage />} />}

          {/* Admin: no start-timer; add time via manual entries */}
          {isAdmin && (
            <>
              <Route path="/tracker" element={<Navigate to="/entries" replace />} />
            </>
          )}

          {/* Shared */}
          <Route path="/entries" element={<EntriesPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/settings" element={<SettingsPage />} />

          {/* Admin-only */}
          {isAdmin && (
            <>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/workers" element={<WorkersPage />} />
              <Route path="/reports" element={<ReportsPage />} />
            </>
          )}

          {/* Redirects */}
          <Route path="*" element={<Navigate to={isAdmin ? '/' : '/tracker'} replace />} />
        </Route>
      </Routes>
      </Suspense>
    </Router>
  )
}
