import { lazy, Suspense } from 'react'
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useStore } from '@/lib/store'
import { isNativeShell } from '@/lib/platform'
import { AppLayout } from '@/components/AppLayout'
import { AuthPage } from '@/pages/AuthPage'
import { FullScreenLoader } from '@/components/FullScreenLoader'

// Route-level code splitting: each page downloads as its own chunk, so a
// worker opening the clock-in page on a phone doesn't also download the
// reports charts, the admin dashboard, etc. (Pages use named exports,
// so map them onto the default export React.lazy expects.)
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })))
const TrackerPage = lazy(() => import('@/pages/TrackerPage').then((m) => ({ default: m.TrackerPage })))
const EntriesPage = lazy(() => import('@/pages/EntriesPage').then((m) => ({ default: m.EntriesPage })))
const WorkersPage = lazy(() => import('@/pages/WorkersPage').then((m) => ({ default: m.WorkersPage })))
const ReportsPage = lazy(() => import('@/pages/ReportsPage').then((m) => ({ default: m.ReportsPage })))
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const TasksPage = lazy(() => import('@/pages/TasksPage').then((m) => ({ default: m.TasksPage })))
const PaymentsPage = lazy(() => import('@/pages/PaymentsPage').then((m) => ({ default: m.PaymentsPage })))
const FinancePage = lazy(() => import('@/pages/FinancePage').then((m) => ({ default: m.FinancePage })))

export function App() {
  const { user, authLoading, isAdmin, can } = useStore()

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
          {/* Kanban board — workers see their own tasks, the admin sees all. */}
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/settings" element={<SettingsPage />} />

          {/* Admin screens — also open to workers the admin granted them to.
              Anything not granted simply has no route, so a typed-in URL falls
              through to the redirect below (and the backend refuses too). */}
          {can('dashboard.view') && <Route path="/" element={<DashboardPage />} />}
          {can('workers.view') && <Route path="/workers" element={<WorkersPage />} />}
          {/* Finance is admin-only by default; `finance.view` turns worker access on. */}
          {can('finance.view') && <Route path="/finance" element={<FinancePage />} />}
          {can('reports.view') && <Route path="/reports" element={<ReportsPage />} />}

          {/* Redirects */}
          <Route path="*" element={<Navigate to={can('dashboard.view') ? '/' : '/tracker'} replace />} />
        </Route>
      </Routes>
      </Suspense>
    </Router>
  )
}
