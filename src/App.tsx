import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useStore } from '@/lib/store'
import { AppLayout } from '@/components/AppLayout'
import { AuthPage } from '@/pages/AuthPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { TrackerPage } from '@/pages/TrackerPage'
import { EntriesPage } from '@/pages/EntriesPage'
import { WorkersPage } from '@/pages/WorkersPage'
import { ReportsPage } from '@/pages/ReportsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { PaymentsPage } from '@/pages/PaymentsPage'
import { FullScreenLoader } from '@/components/FullScreenLoader'

export function App() {
  const { user, authLoading, isAdmin } = useStore()

  if (authLoading) {
    return <FullScreenLoader />
  }

  if (!user) {
    return <AuthPage />
  }

  return (
    <BrowserRouter>
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

          {/* Admin-only */}
          {isAdmin && (
            <>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/workers" element={<WorkersPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </>
          )}

          {/* Redirects */}
          <Route path="*" element={<Navigate to={isAdmin ? '/' : '/tracker'} replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
