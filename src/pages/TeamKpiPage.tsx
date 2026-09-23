import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/lib/store'
import type { KpiFilters } from '@/lib/kpi'
import {
  DEFAULT_KPI_FILTERS,
  applyKpiFilters,
  buildAttention,
  buildReviewBacklog,
  computeEmployeeKpi,
  computeTeamKpi,
  currentMonthKey,
  fmtHours,
  hoursByClient,
  isKpiSubject,
  lastNMonths,
  monthLabel,
  scopeEmployees,
  KPI_TARGETS,
} from '@/lib/kpi'
import { TASK_STATUSES, TaskStatusNames, UNASSIGNED_CLIENT_NAME } from '@/lib/types'
import { PageHeader } from '@/components/PageHeader'
import { FaqButton } from '@/components/FaqButton'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  KpiDrillDialog,
  type KpiDrillTarget,
} from '@/components/KpiDrillDialog'
import { EmployeePerformanceTable } from '@/components/EmployeePerformanceTable'
import {
  KpiScoreByEmployeeChart,
  WorkloadByEmployeeChart,
  HoursByClientChart,
  MonthlyKpiTrendChart,
} from '@/components/TeamKpiCharts'
import {
  NeedsAttentionCard,
  ReviewBacklogCard,
  GoalProgressCard,
} from '@/components/TeamKpiInsights'
import {
  MonthlyTargetsCard,
  BonusDecisionsCard,
  KpiAuditCard,
} from '@/components/TeamKpiManagement'

/** Top KPI card — soft accent, always clickable when it has a drill. */
function TopCard({
  label,
  value,
  sub,
  accent,
  onClick,
  disabled,
}: {
  label: string
  value: string
  sub?: string
  accent?: string
  onClick?: () => void
  disabled?: boolean
}) {
  const body = (
    <>
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums" style={accent ? { color: accent } : undefined}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </>
  )
  if (!onClick || disabled) {
    return <Card className="flex-1"><CardContent className="p-5">{body}</CardContent></Card>
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 rounded-xl border bg-card text-left transition hover:border-primary/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <CardContent className="p-5">{body}</CardContent>
    </button>
  )
}

/**
 * Team KPI dashboard (§6–§13): month/employee/client/status filters over
 * task-derived metrics — nothing is ever entered twice. Every number drills
 * into the tasks behind it; only targets, QA scores, rework classes and bonus
 * approvals are management inputs.
 */
export function TeamKpiPage() {
  const {
    workers,
    tasks,
    clients,
    entries,
    monthlyGoals,
    bonusDecisions,
    kpiAudit,
    dataLoading,
    saveMonthlyGoal,
    saveBonusDecision,
    user,
  } = useStore()

  const [filters, setFilters] = useState<KpiFilters>(DEFAULT_KPI_FILTERS)
  const [drill, setDrill] = useState<KpiDrillTarget | null>(null)

  const workerName = useMemo(
    () => (id: string) => workers.find((w) => w.id === id)?.name ?? 'Unknown',
    [workers],
  )

  const kpiSubjects = useMemo(
    () => workers.filter((w) => w.status === 'active' && isKpiSubject(w)),
    [workers],
  )

  useEffect(() => {
    if (filters.employee !== 'all' && !kpiSubjects.some((w) => w.id === filters.employee)) {
      setFilters((f) => ({ ...f, employee: 'all' }))
    }
  }, [filters.employee, kpiSubjects])

  // Header scope (employee/client/status) — the month is applied per-metric.
  const scopedTasks = useMemo(() => applyKpiFilters(tasks, filters), [tasks, filters])
  const employees = useMemo(() => scopeEmployees(workers, filters), [workers, filters])

  const employeeRows = useMemo(
    () =>
      employees.map((worker) =>
        computeEmployeeKpi({
          worker,
          tasks: scopedTasks,
          month: filters.month,
          goal: monthlyGoals.find((g) => g.worker_id === worker.id && g.month === filters.month) ?? null,
        }),
      ),
    [employees, scopedTasks, filters.month, monthlyGoals],
  )

  const team = useMemo(() => computeTeamKpi(employeeRows), [employeeRows])
  const attention = useMemo(
    () => buildAttention(employeeRows, scopedTasks, filters.month),
    [employeeRows, scopedTasks, filters.month],
  )
  const backlog = useMemo(() => buildReviewBacklog(scopedTasks), [scopedTasks])

  // Hours by client — ALL hours in scope (open + completed tasks, logged time
  // of the scoped employees); the month filter deliberately does not apply.
  const employeeIds = useMemo(() => employees.map((w) => w.id), [employees])
  const clientRows = useMemo(
    () =>
      hoursByClient({
        tasks: scopedTasks,
        entries,
        clients,
        employeeIds,
        clientFilter: filters.client,
      }),
    [scopedTasks, entries, clients, employeeIds, filters.client],
  )
  const clientHoursTotal = useMemo(
    () => ({
      estimated: clientRows.reduce((s, r) => s + r.estimated, 0),
      actual: clientRows.reduce((s, r) => s + r.actual, 0),
    }),
    [clientRows],
  )

  // Monthly trend: last 6 months with the same header scope.
  const trendMonths = useMemo(() => lastNMonths(filters.month, 6), [filters.month])
  const trendPoints = useMemo(
    () =>
      trendMonths.map((m) => {
        const rows = employees.map((worker) =>
          computeEmployeeKpi({
            worker,
            tasks: scopedTasks,
            month: m,
            goal: monthlyGoals.find((g) => g.worker_id === worker.id && g.month === m) ?? null,
          }),
        )
        const agg = computeTeamKpi(rows)
        return { month: m, score: agg.score, onTime: agg.onTimePct }
      }),
    [trendMonths, employees, scopedTasks, monthlyGoals],
  )

  const monthOptions = useMemo(() => {
    const list = lastNMonths(currentMonthKey(), 7)
    return [...list].reverse() // newest first
  }, [])

  const set = <K extends keyof KpiFilters>(key: K, value: KpiFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }))

  const selectCls = 'h-9 w-[150px] bg-background sm:w-[170px]'

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team KPI"
        leading={<FaqButton />}
        description={`Task-derived performance for ${monthLabel(filters.month)} — on-time, QA, goals and rework, weighted ${KPI_TARGETS.onTime ? '30 / 30 / 25 / 15' : ''}.`}
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Month</Label>
            <Select value={filters.month} onValueChange={(v) => set('month', v)}>
              <SelectTrigger className={selectCls}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {monthOptions.map((m) => (
                  <SelectItem key={m} value={m}>{monthLabel(m)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Employee</Label>
            <Select value={filters.employee} onValueChange={(v) => set('employee', v)}>
              <SelectTrigger className={selectCls}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {kpiSubjects.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Client</Label>
            <Select value={filters.client} onValueChange={(v) => set('client', v)}>
              <SelectTrigger className={selectCls}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label className="text-[11px] text-muted-foreground">Task status</Label>
            <Select value={filters.status} onValueChange={(v) => set('status', v as KpiFilters['status'])}>
              <SelectTrigger className={selectCls}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {TASK_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{TaskStatusNames[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </PageHeader>

      {dataLoading && employeeRows.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : (
        /* ---- Top cards (§6) ---- */
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <TopCard
            label="Team KPI Score"
            value={team.score === null ? '—' : String(team.score)}
            sub={`On-time ${team.onTimePct === null ? '—' : team.onTimePct + '%'} · QA ${team.qaPct === null ? '—' : team.qaPct + '%'}`}
            accent={team.score !== null && team.score >= 90 ? '#10b981' : team.score !== null && team.score < 75 ? '#ef4444' : undefined}
            onClick={() => setDrill({ kind: 'score', workerId: null })}
          />
          <TopCard
            label="On-Time Completion"
            value={team.onTimePct === null ? '—' : `${team.onTimePct}%`}
            sub={`${team.completedCount} completed this month`}
            onClick={() => setDrill({ kind: 'onTime', workerId: null })}
          />
          <TopCard
            label="Overdue"
            value={String(team.overdueCount)}
            sub="Open tasks past due"
            accent={team.overdueCount > 0 ? '#ef4444' : undefined}
            onClick={() => setDrill({ kind: 'overdue', workerId: null })}
          />
          <TopCard
            label="Blocked / Waiting"
            value={String(team.blockedCount)}
            sub={`${backlog.count} awaiting review`}
            onClick={() => setDrill({ kind: 'blocked', workerId: null })}
          />
          <TopCard
            label="Team Workload"
            value={team.workloadPct === null ? '—' : `${team.workloadPct}%`}
            sub="Open est. hours ÷ available"
            onClick={() => setDrill({ kind: 'workload', workerId: null })}
          />
          <TopCard
            label="Hours by Client"
            value={
              clientHoursTotal.actual > 0
                ? fmtHours(clientHoursTotal.actual)
                : clientHoursTotal.estimated > 0
                  ? fmtHours(clientHoursTotal.estimated)
                  : '—'
            }
            sub={
              clientRows.length === 0
                ? 'No hours in scope yet'
                : clientHoursTotal.actual > 0
                  ? `Est. ${fmtHours(clientHoursTotal.estimated)} · ${clientRows.length} client${clientRows.length === 1 ? '' : 's'}`
                  : `Est. ${fmtHours(clientHoursTotal.estimated)} · no logged time yet`
            }
            onClick={() => setDrill({ kind: 'clientHours', workerId: null })}
          />
        </div>
      )}

      {/* ---- Charts ---- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <KpiScoreByEmployeeChart employees={employeeRows} />
        <WorkloadByEmployeeChart employees={employeeRows} />
        <HoursByClientChart
          className="lg:col-span-2"
          rows={clientRows}
          onDrill={(clientId) => setDrill({ kind: 'clientHours', workerId: null, clientId })}
        />
      </div>

      {/* ---- Full-width performance table ---- */}
      <EmployeePerformanceTable
        employees={employeeRows}
        onDrill={(t) => setDrill(t)}
        loading={dataLoading}
      />

      {/* ---- Lower row: trend + goal progress ---- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <MonthlyKpiTrendChart points={trendPoints} />
        <GoalProgressCard employees={employeeRows} monthLabel={monthLabel(filters.month)} />
      </div>

      {/* ---- Needs Attention + review backlog ---- */}
      <div className="grid gap-6 lg:grid-cols-3">
        <NeedsAttentionCard items={attention} onDrill={(t) => setDrill(t)} />
        <ReviewBacklogCard backlog={backlog} onDrill={(t) => setDrill(t)} />
      </div>

      {/* ---- Management inputs: targets, bonus, audit ---- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <MonthlyTargetsCard
          employees={employees}
          month={filters.month}
          goals={monthlyGoals}
          onSave={saveMonthlyGoal}
        />
        <BonusDecisionsCard
          employees={employees}
          month={filters.month}
          decisions={bonusDecisions}
          onSave={saveBonusDecision}
        />
      </div>

      <KpiAuditCard events={kpiAudit} />

      <p className="pb-4 text-center text-xs text-muted-foreground">
        Signed in as {user?.email} · KPI data is computed from the task board automatically — only
        targets, QA scores, rework classification and bonus approvals are entered by hand.
      </p>

      <KpiDrillDialog
        open={drill !== null}
        onOpenChange={(v) => { if (!v) setDrill(null) }}
        target={drill}
        tasks={scopedTasks}
        month={filters.month}
        workerName={workerName}
        clientName={(id) => (id ? clients.find((c) => c.id === id)?.name ?? 'Unknown' : UNASSIGNED_CLIENT_NAME)}
      />
    </div>
  )
}
