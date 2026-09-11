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
const ClientPriorityBoardPage = lazy(() => import('@/pages/ClientPriorityBoardPage').then((m) => ({ default: m.ClientPriorityBoardPage })))
const MeetingsPage = lazy(() => import('@/pages/MeetingsPage').then((m) => ({ default: m.MeetingsPage })))
const ClientInvoicingPage = lazy(() => import('@/pages/ClientInvoicingPage').then((m) => ({ default: m.ClientInvoicingPage })))
const FinancePage = lazy(() => import('@/pages/FinancePage').then((m) => ({ default: m.FinancePage })))
const PersonalFinancePage = lazy(() => import('@/pages/PersonalFinancePage').then((m) => ({ default: m.PersonalFinancePage })))

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
        {/* Every signed-in admin and worker has a separate, owner-only personal tracker. */}
        <Route path="/personal" element={<PersonalFinancePage />} />
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
          {/* The client priority board — admin-only until the admin grants
              `priority_board.view` to a worker, exactly like the screens above. */}
          {can('priority_board.view') && <Route path="/priority-board" element={<ClientPriorityBoardPage />} />}
          {/* The meetings schedule — same grant pattern (`meetings.view`). */}
          {can('meetings.view') && <Route path="/meetings" element={<MeetingsPage />} />}
          {/* The client invoicing board — same grant pattern (`invoices.view`). */}
          {can('invoices.view') && <Route path="/invoices" element={<ClientInvoicingPage />} />}
          <Route path="/settings" element={<SettingsPage />} />

          {/* The standalone Payments section now lives inside Finance → Payroll;
              old links and PWA shortcuts follow it there. */}
          <Route path="/payments" element={<Navigate to="/finance?tab=payroll" replace />} />

          {/* Admin screens — also open to workers the admin granted them to.
              Anything not granted simply has no route, so a typed-in URL falls
              through to the redirect below (and the backend refuses too). */}
          {can('dashboard.view') && <Route path="/" element={<DashboardPage />} />}
          {can('workers.view') && <Route path="/workers" element={<WorkersPage />} />}
          {/* Everyone can open Finance — a worker without `finance.view` simply
              lands on the Payroll tab and sees only their own payments there;
              the ledger tabs, the summary and every write follow the grants. */}
          <Route path="/finance" element={<FinancePage />} />
          {can('reports.view') && <Route path="/reports" element={<ReportsPage />} />}

          {/* Redirects */}
          <Route path="*" element={<Navigate to={can('dashboard.view') ? '/' : '/tracker'} replace />} />
        </Route>
      </Routes>
      </Suspense>
    </Router>
  )
}
