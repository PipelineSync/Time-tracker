import type { AttentionItem, EmployeeKpi, ReviewBacklog } from '@/lib/kpi'
import type { KpiDrillTarget } from '@/components/KpiDrillDialog'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AvatarBubble } from '@/components/AvatarBubble'
import { AlertTriangle, Clock3, Inbox, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

const SEVERITY_TINT: Record<string, string> = {
  critical: 'border-l-rose-500 bg-rose-50/60 dark:bg-rose-950/20',
  warning: 'border-l-amber-500 bg-amber-50/60 dark:bg-amber-950/20',
  info: 'border-l-sky-500 bg-sky-50/60 dark:bg-sky-950/20',
}

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
}

/**
 * Needs Attention (§12): the rule list — overload, aged waits, stale reviews,
 * QA/rework/goal behind target, available capacity. Every row is clickable
 * and drills into the tasks that caused it.
 */
export function NeedsAttentionCard({
  items,
  onDrill,
}: {
  items: AttentionItem[]
  onDrill: (target: KpiDrillTarget) => void
}) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-amber-500" /> Needs Attention
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="flex items-center gap-2 py-8 text-center text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
            Nothing needs attention — every employee is within targets this month.
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() =>
                    onDrill({
                      workerId: item.worker.id,
                      // "Available for more work" drills into the same open-work
                      // list the workload % is built from.
                      kind: item.drill.kind === 'available' ? 'workload' : item.drill.kind,
                      flag:
                        (item.drill.kind === 'overdue' && item.drill.highOnly) ||
                        ((item.drill.kind === 'blocked' || item.drill.kind === 'review') && item.drill.agedOnly)
                          ? true
                          : undefined,
                    })
                  }
                  className={cn(
                    'flex w-full items-start gap-3 rounded-xl border border-l-4 p-3 text-left transition hover:brightness-[0.98]',
                    SEVERITY_TINT[item.severity],
                  )}
                >
                  <AvatarBubble name={item.worker.name} avatarUrl={item.worker.avatar_url} className="mt-0.5 h-7 w-7 text-[10px]" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{item.message}</span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {item.drill.kind === 'available' ? 'Can take on more work this month' : 'Click to see the tasks behind this'}
                    </span>
                  </span>
                  <Badge
                    variant="muted"
                    className={cn(
                      'shrink-0 text-[10px]',
                      item.severity === 'critical' && 'bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300',
                      item.severity === 'warning' && 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
                      item.severity === 'info' && 'bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300',
                    )}
                  >
                    {SEVERITY_LABEL[item.severity]}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

/** Review backlog: tasks awaiting review, oldest age, reviewer responsible. */
export function ReviewBacklogCard({ backlog, onDrill }: { backlog: ReviewBacklog; onDrill: (t: KpiDrillTarget) => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Inbox className="h-4 w-4 text-violet-500" /> Review backlog
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <button
          type="button"
          onClick={() => onDrill({ kind: 'review', workerId: null })}
          className="flex w-full items-center justify-between rounded-xl border p-3 text-left transition hover:bg-muted/60"
        >
          <span className="text-sm text-muted-foreground">Tasks Awaiting Review</span>
          <span className="text-2xl font-bold tabular-nums">{backlog.count}</span>
        </button>
        <div className="flex items-center justify-between rounded-xl border p-3">
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Clock3 className="h-3.5 w-3.5" /> Oldest Review Age
          </span>
          <span className="text-lg font-semibold tabular-nums">
            {backlog.oldestDays === null ? '—' : `${backlog.oldestDays}d`}
          </span>
        </div>
        <div className="flex items-center justify-between rounded-xl border p-3">
          <span className="text-sm text-muted-foreground">Reviewer Responsible</span>
          <span className="text-sm font-medium">{backlog.reviewer ?? 'Owner / PM'}</span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Reviews over 2 business days raise a Needs Attention warning. QA scoring lives on the
          Tasks board — open a For Review card and press Review.
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * Monthly Goal Progress (§6 lower row): completed vs the planned target, with
 * the role-specific on-time target beside it. Targets are edited in the
 * Monthly targets card — never re-typed as KPI data.
 */
export function GoalProgressCard({
  employees,
  monthLabel,
}: {
  employees: EmployeeKpi[]
  monthLabel: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Monthly Goal Progress · {monthLabel}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {employees.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No employees in scope.</p>
        )}
        {employees.map((emp) => {
          const has = emp.goalTarget !== null
          const pct = emp.goalAchievement !== null ? Math.min(100, Math.round(emp.goalAchievement * 100)) : null
          const barColor = pct === null ? 'bg-muted' : pct >= 90 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-rose-500'
          return (
            <div key={emp.worker.id} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate font-medium">{emp.worker.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {has ? `${emp.goalAchieved} / ${emp.goalTarget} tasks` : 'no target set'}
                  {pct !== null ? ` · ${pct}%` : ''}
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full rounded-full transition-all', barColor)}
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
              <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                <span>On-time target: {emp.onTimeTarget}%</span>
                <span>· QA target: {emp.qaTarget}%</span>
                <span>· Score: {emp.score === null ? '—' : emp.score}</span>
              </div>
            </div>
          )
        })}
        <p className="text-[11px] text-muted-foreground">
          Goal achievement counts tasks completed against the planned target for {monthLabel} — edit
          targets in the card below. KPI weight: 25% (need 90%+ of plan).
        </p>
      </CardContent>
    </Card>
  )
}
