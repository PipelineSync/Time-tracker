import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, History } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ClientDot } from '@/components/ClientBadge'
import { EmptyState } from '@/components/EmptyState'
import { MonthPicker } from '@/components/MonthPicker'
import type { Client, Task, Worker } from '@/lib/types'
import { TaskPriorityNames, normalizeTaskStage } from '@/lib/types'
import {
  DEFAULT_COMPLETED_HISTORY_FILTERS,
  completedAtMs,
  completedHistory,
  completionMonth,
  isCompletedHistoryFilterActive,
  type CompletedHistoryFilters,
} from '@/lib/completedTasks'
import { todayISO } from '@/lib/finance'
import { monthKeyOfISO, monthOptions } from '@/lib/monthScope'
import { formatDateTime } from '@/lib/utils'

interface CompletedTasksDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Every task the viewer may see, archived ones included. */
  tasks: Task[]
  workers: Worker[]
  clients: Client[]
  /** Whether the viewer sees everyone's tasks. Without it the employee filter is not offered. */
  canViewAll: boolean
  /** The month the board was showing ('YYYY-MM', or 'all'): the history opens on it. */
  initialMonth?: string
}

/**
 * The full history of completed tasks, grouped by the month each was finished
 * in. The board shows the newest few for its month; everything else is listed
 * here, filterable by month, employee, client and the day it was finished. It
 * only reads: nothing here changes a task.
 */
export function CompletedTasksDialog({
  open,
  onOpenChange,
  tasks,
  workers,
  clients,
  canViewAll,
  initialMonth = 'all',
}: CompletedTasksDialogProps) {
  const today = todayISO()
  const currentMonth = monthKeyOfISO(today)
  const [filters, setFilters] = useState<CompletedHistoryFilters>(DEFAULT_COMPLETED_HISTORY_FILTERS)

  // Each time the history opens it starts on the month the board was showing.
  useEffect(() => {
    if (open) setFilters({ ...DEFAULT_COMPLETED_HISTORY_FILTERS, month: initialMonth })
  }, [open, initialMonth])

  const completed = useMemo(() => tasks.filter((t) => normalizeTaskStage(t.status) === 'completed'), [tasks])
  const rows = useMemo(() => completedHistory(completed, filters), [completed, filters])
  const monthChoices = useMemo(
    () => monthOptions(completed.map((t) => completionMonth(t)), today),
    [completed, today],
  )

  // Only the people and clients that appear in the history are offered as filters.
  const workerOptions = useMemo(
    () =>
      workers
        .filter((w) => completed.some((t) => t.worker_id === w.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [workers, completed]
  )
  const clientOptions = useMemo(
    () =>
      clients
        .filter((c) => completed.some((t) => t.client_id === c.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [clients, completed]
  )
  const hasTasksWithoutClient = completed.some((t) => !t.client_id)

  const workerName = (id: string) => workers.find((w) => w.id === id)?.name || 'Worker'
  const clientOf = (id: string | null) => (id ? clients.find((c) => c.id === id) ?? null : null)

  const set = (patch: Partial<CompletedHistoryFilters>) => setFilters((f) => ({ ...f, ...patch }))
  const filtersActive = isCompletedHistoryFilterActive(filters)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="space-y-1 border-b px-5 py-4 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> Completed tasks
          </DialogTitle>
          <DialogDescription>
            Every completed task, newest first, by the month it was finished in. Narrow it to one month, employee,
            client or date range. Nothing here changes a task.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
          <MonthPicker
            label="Finished in month"
            value={filters.month}
            current={currentMonth}
            options={monthChoices}
            allowAll
            onChange={(month) => set({ month })}
          />
          {canViewAll && (
            <Select value={filters.worker} onValueChange={(worker) => set({ worker })}>
              <SelectTrigger className="h-9 w-44" aria-label="Filter by employee">
                <SelectValue placeholder="Employee" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone</SelectItem>
                {workerOptions.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={filters.client} onValueChange={(client) => set({ client })}>
            <SelectTrigger className="h-9 w-44" aria-label="Filter by client">
              <SelectValue placeholder="Client" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All clients</SelectItem>
              {hasTasksWithoutClient && <SelectItem value="none">No client</SelectItem>}
              {clientOptions.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            From
            <Input
              type="date"
              className="h-9 w-40"
              value={filters.from ?? ''}
              max={filters.to ?? undefined}
              onChange={(e) => set({ from: e.target.value || null })}
              aria-label="Completed from"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            To
            <Input
              type="date"
              className="h-9 w-40"
              value={filters.to ?? ''}
              min={filters.from ?? undefined}
              onChange={(e) => set({ to: e.target.value || null })}
              aria-label="Completed to"
            />
          </label>
          {filtersActive && (
            <Button variant="ghost" size="sm" onClick={() => setFilters(DEFAULT_COMPLETED_HISTORY_FILTERS)}>
              Clear filters
            </Button>
          )}
          <p className="ml-auto text-xs text-muted-foreground">
            Showing {rows.length} of {completed.length}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5">
          {completed.length === 0 ? (
            <EmptyState icon={CheckCircle2} title="Nothing completed yet" description="Finished tasks will be listed here, newest first." />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={History}
              title="No completed tasks match these filters"
              description="Try another employee, client or date range."
              action={
                <Button variant="outline" onClick={() => setFilters(DEFAULT_COMPLETED_HISTORY_FILTERS)}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <ul className="divide-y">
              {rows.map((task) => {
                const client = clientOf(task.client_id)
                return (
                  <li key={task.id} className="flex items-start gap-3 py-3">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ClientDot client={client} className="h-2 w-2" />
                        <span className="text-xs font-medium text-muted-foreground">{client ? client.name : 'No client'}</span>
                        {task.archived_at && (
                          <Badge variant="muted" className="text-[10px]">
                            Archived
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-sm font-medium" title={task.title}>
                        {task.title}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {workerName(task.worker_id)} · finished {formatDateTime(new Date(completedAtMs(task)))} · {TaskPriorityNames[task.priority]} priority
                      </p>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
