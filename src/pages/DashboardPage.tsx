import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, BadgeCheck, CalendarDays, ChevronDown, Flag, Hourglass, Plus, Timer } from 'lucide-react'
import { useStore } from '@/lib/store'
import type { TaskStatus } from '@/lib/types'
import { PageHeader } from '@/components/PageHeader'
import { FaqButton } from '@/components/FaqButton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ActiveWorkersPanel } from '@/components/ActiveWorkersPanel'
import { DashboardStatCard } from '@/components/DashboardStatCard'
import { TodayFocusPanel, type FocusItem } from '@/components/TodayFocusPanel'
import { WorkloadOverviewTable, type WorkloadOverviewRow } from '@/components/WorkloadOverviewTable'
import { TaskFormDialog } from '@/components/TaskFormDialog'
import {
  applyTaskFilters,
  boardFiltersToParams,
  dateOffsetISO,
  DEFAULT_BOARD_FILTERS,
  type BoardFilters,
  type DueRange,
} from '@/lib/taskFilters'
import { daysUntilDue, formatDateTime, isOverdueDate } from '@/lib/utils'
import { cn } from '@/lib/utils'

type Period = 'all' | 'week' | 'month' | 'custom'

/**
 * The team task tracker: the team's command centre. Five big summary cards
 * (overdue, due today, high priority, waiting/blocked, needs approval) plus
 * an auto-generated "Today's focus" on top, a collapsible "on the clock"
 * strip, and the Team Workload Overview table.
 *
 * The board itself lives on the Tasks page — every stat card, focus row and
 * workload row navigates there with the matching filter pre-applied via the
 * query string, so a tap on "Overdue" lands on exactly the overdue pile.
 */
export function DashboardPage() {
  const { tasks, workers, user, can, dataLoading, activeTimers } = useStore()
  const canViewAll = can('tasks.view_all')
  const navigate = useNavigate()

  // ---- Date scope (All dates / This week / This month / Custom) -------------
  const [period, setPeriod] = useState<Period>('all')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  const dueRange = useMemo<DueRange | null>(() => {
    if (period === 'week') return { from: null, to: dateOffsetISO(7) }
    if (period === 'month') return { from: null, to: dateOffsetISO(30) }
    if (period === 'custom' && (customFrom || customTo)) return { from: customFrom || null, to: customTo || null }
    return null
  }, [period, customFrom, customTo])

  // The dashboard only scopes by due-date; everything else is applied on the
  // Tasks page via the navigation filters below.
  const filters = useMemo<BoardFilters>(() => ({ ...DEFAULT_BOARD_FILTERS, dueRange }), [dueRange])

  // Leave the dashboard and land on the board with one filter (plus the
  // current date scope) already applied.
  function goToBoard(patch: Partial<BoardFilters>) {
    const next: BoardFilters = { ...filters, ...patch }
    const qs = boardFiltersToParams(next).toString()
    navigate(qs ? `/tasks?${qs}` : '/tasks')
  }

  // The same filter-scoped rows the board would render — the stats, focus
  // list and workload table all count from this, so they agree with it.
  const scoped = useMemo(
    () => applyTaskFilters(tasks, canViewAll ? null : (user?.workerId ?? null), filters),
    [tasks, canViewAll, user?.workerId, filters]
  )
  const activeTasks = useMemo(() => scoped.filter((t) => !t.archived_at), [scoped])

  const stats = useMemo(() => {
    let overdue = 0
    let dueToday = 0
    let high = 0
    let waiting = 0
    let approval = 0
    for (const t of activeTasks) {
      if (t.status !== 'completed' && isOverdueDate(t.due_date)) overdue++
      if (t.status !== 'completed' && daysUntilDue(t.due_date) === 0) dueToday++
      if (t.priority === 'high') high++
      if (t.status === 'waiting') waiting++
      if (t.status === 'approval') approval++
    }
    return { overdue, dueToday, high, waiting, approval }
  }, [activeTasks])

  /** When the newest visible task last changed — the "Last updated" stamp. */
  const lastUpdated = useMemo(() => scoped.reduce((max, t) => (t.updated_at > max ? t.updated_at : max), ''), [scoped])

  /** Who is carrying what — one row per active team member (admin view). */
  const workloadRows = useMemo<WorkloadOverviewRow[]>(() => {
    if (!canViewAll) return []
    const countsFor = new Map<
      string,
      { todo: number; in_progress: number; waiting: number; approval: number; overdue: number; lastUpdated: string }
    >()
    for (const w of workers)
      countsFor.set(w.id, { todo: 0, in_progress: 0, waiting: 0, approval: 0, overdue: 0, lastUpdated: '' })
    for (const t of activeTasks) {
      const row = countsFor.get(t.worker_id)
      if (!row) continue
      if (t.status === 'todo') row.todo++
      else if (t.status === 'in_progress') row.in_progress++
      else if (t.status === 'waiting') row.waiting++
      else if (t.status === 'approval') row.approval++
      if (t.status !== 'completed' && isOverdueDate(t.due_date)) row.overdue++
      if (t.updated_at > row.lastUpdated) row.lastUpdated = t.updated_at
    }
    return workers
      .map((w) => {
        const c = countsFor.get(w.id) ?? { todo: 0, in_progress: 0, waiting: 0, approval: 0, overdue: 0, lastUpdated: '' }
        const total = c.todo + c.in_progress + c.waiting + c.approval
        return { worker: w, counts: c, total, overdue: c.overdue, lastUpdated: c.lastUpdated || undefined }
      })
      // Inactive members stay off the panel unless they still carry tasks.
      .filter((r) => r.worker.status === 'active' || r.total > 0)
      .sort(
        (a, b) => b.total - a.total || a.worker.name.localeCompare(b.worker.name, undefined, { sensitivity: 'base' })
      )
  }, [canViewAll, workers, activeTasks])

  /**
   * "Today's focus" — the numbered checklist, generated from live data
   * instead of static text. Worst-first, capped at four; each row lands on
   * the board filtered to that pile.
   */
  const focusItems = useMemo<FocusItem[]>(() => {
    const items: FocusItem[] = []
    if (stats.overdue > 0)
      items.push({
        id: 'overdue',
        label: `Review ${stats.overdue} overdue task${stats.overdue === 1 ? '' : 's'}`,
        onClick: () => goToBoard({ overdueOnly: true }),
      })
    if (stats.dueToday > 0)
      items.push({
        id: 'due-today',
        label: `Follow up on ${stats.dueToday} due today`,
        onClick: () => goToBoard({ dueTodayOnly: true }),
      })
    if (stats.waiting > 0)
      items.push({
        id: 'blocked',
        label: `Check ${stats.waiting} blocked item${stats.waiting === 1 ? '' : 's'}`,
        onClick: () => goToBoard({ stage: 'waiting' }),
      })
    if (stats.approval > 0)
      items.push({
        id: 'approvals',
        label: `Approve ${stats.approval} pending task${stats.approval === 1 ? '' : 's'}`,
        onClick: () => goToBoard({ stage: 'approval' }),
      })
    // Workload balance: one member heavy while another has room.
    if (canViewAll) {
      const heavy = workloadRows.find((r) => r.total >= 9)
      const light = workloadRows.find((r) => r.total <= 2)
      if (heavy && light)
        items.push({
          id: 'balance',
          label: `Rebalance: ${heavy.worker.name} is heavy, ${light.worker.name} has room`,
          onClick: () => goToBoard({ worker: heavy.worker.id }),
        })
    }
    return items.slice(0, 4)
    // goToBoard closes over navigate (stable) and the current date scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, canViewAll, workloadRows, dueRange])

  // ---- "On the clock" strip (collapsed behind a button) ----------------------
  const [clockedOpen, setClockedOpen] = useState(false)

  // ---- New task dialog --------------------------------------------------------
  const [formOpen, setFormOpen] = useState(false)
  const [newTaskStatus, setNewTaskStatus] = useState<TaskStatus>('todo')

  const loading = dataLoading && tasks.length === 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team Task Tracker"
        description="Manage tasks. Balance workload. Deliver results."
        leading={<FaqButton />}
      >
        {lastUpdated && (
          <span className="hidden text-xs text-muted-foreground lg:inline">
            Last updated: {formatDateTime(lastUpdated)}
          </span>
        )}

        {/* Date scope: preset windows or a custom from/to range. */}
        <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Date range" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All dates</SelectItem>
            <SelectItem value="week">This week</SelectItem>
            <SelectItem value="month">This month</SelectItem>
            <SelectItem value="custom">Custom dates</SelectItem>
          </SelectContent>
        </Select>

        {period === 'custom' && (
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="dash-date-from" className="text-[11px] text-muted-foreground">
                From
              </Label>
              <Input
                id="dash-date-from"
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="h-9 w-[140px]"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dash-date-to" className="text-[11px] text-muted-foreground">
                To
              </Label>
              <Input
                id="dash-date-to"
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => setCustomTo(e.target.value)}
                className="h-9 w-[140px]"
              />
            </div>
          </div>
        )}

        <Button
          onClick={() => {
            setNewTaskStatus('todo')
            setFormOpen(true)
          }}
        >
          <Plus className="mr-2 h-4 w-4" /> New task
        </Button>
      </PageHeader>

      {/* Who is on the clock right now — collapsed behind a button so the
          dashboard stays clean. */}
      <div className="space-y-3">
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          aria-expanded={clockedOpen}
          onClick={() => setClockedOpen((v) => !v)}
        >
          <Timer className="h-4 w-4" aria-hidden />
          {activeTimers.length > 0 ? (
            <span>
              <span className="font-semibold tabular-nums">{activeTimers.length}</span> on the clock
            </span>
          ) : (
            'On the clock'
          )}
          <ChevronDown className={cn('h-4 w-4 transition-transform', clockedOpen && 'rotate-180')} aria-hidden />
        </Button>
        {clockedOpen && <ActiveWorkersPanel />}
      </div>

      {/* Summary row: five stat cards + today's focus. Every card lands on
          the Tasks board filtered to that pile. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <DashboardStatCard
          icon={AlertCircle}
          iconCls="bg-red-500/10 text-red-600 dark:text-red-400"
          value={stats.overdue}
          label="Overdue"
          sub={stats.overdue > 0 ? 'Needs attention' : 'All caught up'}
          subCls={stats.overdue > 0 ? 'text-red-600 dark:text-red-400' : undefined}
          valueCls={stats.overdue > 0 ? 'text-red-600 dark:text-red-400' : undefined}
          onClick={() => goToBoard({ overdueOnly: true })}
          hint="Open the board filtered to overdue tasks"
          loading={loading}
        />
        <DashboardStatCard
          icon={CalendarDays}
          iconCls="bg-sky-500/10 text-sky-600 dark:text-sky-400"
          value={stats.dueToday}
          label="Due Today"
          sub={canViewAll ? 'Across all team members' : 'On your board'}
          onClick={() => goToBoard({ dueTodayOnly: true })}
          hint="Open the board filtered to tasks due today"
          loading={loading}
        />
        <DashboardStatCard
          icon={Flag}
          iconCls="bg-rose-500/10 text-rose-600 dark:text-rose-400"
          value={stats.high}
          label="High Priority"
          sub="Active tasks"
          onClick={() => goToBoard({ priority: 'high' })}
          hint="Open the board filtered to high-priority tasks"
          loading={loading}
        />
        <DashboardStatCard
          icon={Hourglass}
          iconCls="bg-amber-500/10 text-amber-600 dark:text-amber-400"
          value={stats.waiting}
          label="Waiting / Blocked"
          sub="Needs follow-up"
          onClick={() => goToBoard({ stage: 'waiting' })}
          hint="Open the board filtered to the Waiting column"
          loading={loading}
        />
        <DashboardStatCard
          icon={BadgeCheck}
          iconCls="bg-violet-500/10 text-violet-600 dark:text-violet-400"
          value={stats.approval}
          label="Needs Approval"
          sub={stats.approval > 0 ? 'Awaiting review' : 'Queue is clear'}
          onClick={() => goToBoard({ stage: 'approval' })}
          hint="Open the board filtered to the Approval column"
          loading={loading}
        />
        <div className="min-w-0 sm:col-span-2 md:col-span-3 xl:col-span-1">
          {loading ? (
            <div className="h-full rounded-2xl border p-4">
              <Skeleton className="h-4 w-28" />
              <div className="mt-3 space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-3/5" />
              </div>
            </div>
          ) : (
            <TodayFocusPanel items={focusItems} />
          )}
        </div>
      </div>

      {canViewAll && !loading && workloadRows.length > 0 && (
        <WorkloadOverviewTable rows={workloadRows} onRowClick={(id) => goToBoard({ worker: id })} />
      )}

      <TaskFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        task={null}
        defaultStatus={newTaskStatus}
      />
    </div>
  )
}
