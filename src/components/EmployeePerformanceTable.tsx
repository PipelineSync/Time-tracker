import type { EmployeeKpi } from '@/lib/kpi'
import { fmtPct, WORKLOAD_LABELS } from '@/lib/kpi'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AvatarBubble } from '@/components/AvatarBubble'
import { cn } from '@/lib/utils'
import type { KpiDrillKind, KpiDrillTarget } from '@/components/KpiDrillDialog'

/** Health chip for the row's Status column (soft tracker colours). */
function statusChip(emp: EmployeeKpi): { label: string; className: string } {
  if (emp.score === null) return { label: 'No data', className: 'bg-muted text-muted-foreground' }
  if (emp.score >= 90) return { label: 'On track', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' }
  if (emp.score >= 75) return { label: 'Watch', className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' }
  return { label: 'At risk', className: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300' }
}

const WORKLOAD_HEX: Record<string, string> = {
  available: '#10b981',
  normal: '#3b82f6',
  high: '#f59e0b',
  overloaded: '#ef4444',
}

/**
 * The full-width Employee Performance table (§7): every number is a button
 * that drills into the source tasks behind it — no metric on this page is a
 * dead end.
 */
export function EmployeePerformanceTable({
  employees,
  onDrill,
  loading,
}: {
  employees: EmployeeKpi[]
  onDrill: (target: KpiDrillTarget) => void
  loading?: boolean
}) {
  const cellCls =
    'rounded-md px-2 py-1 text-sm font-medium tabular-nums transition hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50'

  function num(value: React.ReactNode, kind: KpiDrillKind, workerId: string, title: string) {
    return (
      <button
        type="button"
        title={title}
        onClick={() => onDrill({ kind, workerId })}
        className={cellCls}
      >
        {value}
      </button>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Employee performance
          <span className="font-normal text-muted-foreground">— click any number to see the tasks behind it</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead>
            <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Employee</th>
              <th className="px-2 py-2.5 text-center font-medium">Active</th>
              <th className="px-2 py-2.5 text-center font-medium">Completed</th>
              <th className="px-2 py-2.5 text-center font-medium">On-Time</th>
              <th className="px-2 py-2.5 text-center font-medium">Overdue</th>
              <th className="px-2 py-2.5 text-center font-medium">Blocked</th>
              <th className="px-2 py-2.5 text-center font-medium">QA</th>
              <th className="px-2 py-2.5 text-center font-medium">Rework</th>
              <th className="px-2 py-2.5 text-center font-medium">Workload</th>
              <th className="px-2 py-2.5 text-center font-medium">KPI</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && employees.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Loading performance…
                </td>
              </tr>
            )}
            {!loading && employees.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No employees match the current filters.
                </td>
              </tr>
            )}
            {employees.map((emp) => {
              const chip = statusChip(emp)
              const wl = emp.workload
              const wlLabel = wl.pct === null ? '—' : `${wl.pct}%`
              const wlColor = wl.pct === null ? undefined : WORKLOAD_HEX[wl.level]
              return (
                <tr key={emp.worker.id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <AvatarBubble name={emp.worker.name} avatarUrl={emp.worker.avatar_url} color={emp.worker.color} className="h-7 w-7 text-[10px]" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{emp.worker.name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">{emp.worker.position || 'Team member'}</p>
                      </div>
                    </div>
                  </td>
                  <td className="text-center">{num(emp.activeCount, 'active', emp.worker.id, 'Open tasks right now')}</td>
                  <td className="text-center">{num(emp.completedCount, 'completed', emp.worker.id, 'Completed this month')}</td>
                  <td className="text-center">
                    {num(fmtPct(emp.onTimePct), 'onTime', emp.worker.id, emp.lateCount ? `${emp.lateCount} late this month — click to see which` : 'On-time completion')}
                  </td>
                  <td className="text-center">
                    {num(
                      <span className={emp.overdueCount > 0 ? 'text-rose-600 dark:text-rose-400' : undefined}>{emp.overdueCount}</span>,
                      'overdue',
                      emp.worker.id,
                      'Open overdue tasks',
                    )}
                  </td>
                  <td className="text-center">{num(emp.blockedCount, 'blocked', emp.worker.id, 'Waiting / blocked tasks')}</td>
                  <td className="text-center">{num(fmtPct(emp.qaPct), 'qa', emp.worker.id, `QA average over ${emp.qaReviewed} reviews`)}</td>
                  <td className="text-center">
                    {num(
                      <span className={emp.reworkRatePct !== null && emp.reworkRatePct > 5 ? 'text-rose-600 dark:text-rose-400' : undefined}>
                        {fmtPct(emp.reworkRatePct, 1)}
                      </span>,
                      'rework',
                      emp.worker.id,
                      `${emp.reworkEmployeeCount} employee-caused rework${emp.reworkEmployeeCount === 1 ? '' : 's'} (target ≤5%)`,
                    )}
                  </td>
                  <td className="text-center">
                    {num(
                      <span style={{ color: wlColor }} title={WORKLOAD_LABELS[wl.level].label}>
                        {wlLabel}
                      </span>,
                      'workload',
                      emp.worker.id,
                      `${wl.openHours.toFixed(1)}h open of ~${wl.availableHours.toFixed(0)}h available · ${WORKLOAD_LABELS[wl.level].label}`,
                    )}
                  </td>
                  <td className="text-center">
                    {num(
                      <span className={cn('font-bold', emp.score !== null && emp.score >= 90 ? 'text-emerald-600 dark:text-emerald-400' : emp.score !== null && emp.score < 75 ? 'text-rose-600 dark:text-rose-400' : undefined)}>
                        {emp.score === null ? '—' : emp.score}
                      </span>,
                      'score',
                      emp.worker.id,
                      emp.score === null ? 'No scored components yet' : `On-time ${fmtPct(emp.scoreParts.onTime)} · QA ${fmtPct(emp.scoreParts.qa)} · Goal ${fmtPct(emp.scoreParts.goal)} · Rework ${fmtPct(emp.scoreParts.rework)}`,
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant="muted" className={cn('text-[11px]', chip.className)}>{chip.label}</Badge>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}
