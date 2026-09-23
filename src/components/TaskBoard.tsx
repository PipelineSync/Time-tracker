import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Pencil,
  Trash2,
  CalendarDays,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  CheckCircle2,
  Circle,
  Loader2,
  PauseCircle,
  BadgeCheck,
  KanbanSquare,
  Search,
  SearchCheck,
  X,
  Archive,
  ArchiveRestore,
  RotateCcw,
  Repeat2,
  Timer,
} from 'lucide-react'
import { useStore } from '@/lib/store'
import type { Task, TaskPriority, TaskStatus } from '@/lib/types'
import { TASK_STATUSES, TaskPriorityNames, TaskRepeatNames, TaskStatusNames } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/EmptyState'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TaskFormDialog } from '@/components/TaskFormDialog'
import { QaReviewDialog } from '@/components/QaReviewDialog'
import { ClientDot } from '@/components/ClientBadge'
import { ClientSelect } from '@/components/ClientSelect'
import { AvatarBubble } from '@/components/AvatarBubble'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { cn, formatDate, isOverdueDate } from '@/lib/utils'
import { applyTaskFilters, isAnyBoardFilterActive, DEFAULT_BOARD_FILTERS, type BoardFilters } from '@/lib/taskFilters'
import { taskHealthBadges } from '@/lib/kpi'
import { planRecreate } from '@/lib/taskWorkflow'
import { toast } from 'sonner'

/** Column accents — the board reads at a glance without a legend. */
const columnStyles: Record<TaskStatus, { icon: typeof Circle; dot: string; ring: string }> = {
  recurring: { icon: Repeat2, dot: 'bg-cyan-500', ring: 'ring-cyan-500/40' },
  todo: { icon: Circle, dot: 'bg-slate-400', ring: 'ring-slate-400/40' },
  in_progress: { icon: Loader2, dot: 'bg-amber-500', ring: 'ring-amber-500/40' },
  waiting: { icon: PauseCircle, dot: 'bg-orange-500', ring: 'ring-orange-500/40' },
  for_review: { icon: BadgeCheck, dot: 'bg-violet-500', ring: 'ring-violet-500/40' },
  rework: { icon: RotateCcw, dot: 'bg-rose-500', ring: 'ring-rose-500/40' },
  completed: { icon: CheckCircle2, dot: 'bg-emerald-500', ring: 'ring-emerald-500/40' },
}

/**
 * Soft column tints — each stage sits in its own gently coloured lane, so the
 * seven columns read as seven piles at a glance.
 */
const columnTint: Record<TaskStatus, string> = {
  recurring: 'bg-cyan-100/80 dark:bg-cyan-400/10',
  todo: 'bg-slate-100/80 dark:bg-slate-400/10',
  in_progress: 'bg-sky-100/80 dark:bg-sky-400/10',
  waiting: 'bg-amber-100/80 dark:bg-amber-400/10',
  for_review: 'bg-violet-100/80 dark:bg-violet-400/10',
  rework: 'bg-rose-100/80 dark:bg-rose-400/10',
  completed: 'bg-emerald-100/80 dark:bg-emerald-400/10',
}

const priorityBadge: Record<TaskPriority, { variant: 'muted' | 'outline' | 'destructive'; label: string }> = {
  low: { variant: 'muted', label: TaskPriorityNames.low },
  medium: { variant: 'outline', label: TaskPriorityNames.medium },
  high: { variant: 'destructive', label: TaskPriorityNames.high },
}

/** True when a not-yet-completed task's due date has passed. */
function isOverdue(task: Task): boolean {
  // Shelf cards keep their anchor date (often in the past) — never overdue.
  if (!task.due_date || task.status === 'completed' || task.status === 'recurring') return false
  return isOverdueDate(task.due_date)
}

/**
 * The shared kanban board: its own framed section with a title, the filter
 * row, the stage columns and all of the card dialogs. The Tasks page embeds
 * it with the archive tab, the Dashboard embeds it plain — and because its
 * filters are controlled by the parent, the dashboard's stat cards and
 * workload rows can drive the same board from a distance.
 */
export function TaskBoard({
  filters,
  onFiltersChange,
  showArchive = false,
}: {
  filters: BoardFilters
  onFiltersChange: (next: BoardFilters) => void
  showArchive?: boolean
}) {
  const {
    tasks,
    workers,
    clients,
    user,
    can,
    dataLoading,
    createTask,
    moveTask,
    startRecurringOccurrence,
    deleteTask,
    archiveTask,
    restoreTask,
    archiveTasks,
  } = useStore()
  // Seeing everyone's board and running it are separate grants; the admin has
  // both, a worker has whatever was ticked on their row.
  const canViewAll = can('tasks.view_all')
  const canManageAll = can('tasks.manage_all')
  // QA is the Owner's and the Project Manager's job (§10): anyone who can run
  // the KPI dashboard can also score the cards waiting in For Review.
  const canReview = can('team_kpi.view')

  const [activeTab, setActiveTab] = useState<'board' | 'archive'>('board')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Task | null>(null)
  const [formStatus, setFormStatus] = useState<TaskStatus>('todo')
  const [deleting, setDeleting] = useState<Task | null>(null)
  const [confirmArchiveAll, setConfirmArchiveAll] = useState(false)
  const [confirmRestoreAll, setConfirmRestoreAll] = useState(false)
  /** The card whose QA review dialog is open (the For Review pile's action). */
  const [reviewing, setReviewing] = useState<Task | null>(null)

  const patch = (p: Partial<BoardFilters>) => onFiltersChange({ ...filters, ...p })

  /** The original "Clear filters" behaviour: reset every board filter. */
  const clearAllFilters = () => onFiltersChange({ ...DEFAULT_BOARD_FILTERS })

  // Drag state. `dragging` is the card under the pointer; `dropTarget` is the
  // column (and index) it would land in — used to draw the placeholder.
  // The ref mirrors `dragging` synchronously: dragover fires before React has
  // re-rendered with the new state, and a poll landing mid-drag must not make
  // the handlers think nothing is being dragged.
  const draggingRef = useRef<Task | null>(null)
  const [dragging, setDragging] = useState<Task | null>(null)
  const [dropTarget, setDropTarget] = useState<{ status: TaskStatus; index: number } | null>(null)

  function startDrag(task: Task) {
    draggingRef.current = task
    setDragging(task)
  }

  function endDrag() {
    draggingRef.current = null
    setDragging(null)
    setDropTarget(null)
  }

  // The lane row scrolls sideways when the stages do not all fit; dragging a
  // card to either edge nudges it along so cross-board drops stay possible.
  const rowRef = useRef<HTMLDivElement | null>(null)
  function edgeScroll(e: React.DragEvent<HTMLDivElement>) {
    const row = rowRef.current
    if (!row || !draggingRef.current) return
    const box = row.getBoundingClientRect()
    const edge = 72
    if (e.clientX < box.left + edge) row.scrollLeft -= 18
    else if (e.clientX > box.right - edge) row.scrollLeft += 18
  }

  const workerName = (id: string) => workers.find((w) => w.id === id)?.name || 'Worker'
  const workerAvatar = (id: string) => workers.find((w) => w.id === id)?.avatar_url ?? null
  const workerColor = (id: string) => workers.find((w) => w.id === id)?.color ?? null
  const workerById = (id: string) => workers.find((w) => w.id === id)
  const clientOf = (id: string | null) => (id ? clients.find((c) => c.id === id) ?? null : null)

  const searchActive = filters.search.trim().length > 0
  const isArchived = (t: Task) => Boolean(t.archived_at)

  // Unfiltered total counts for tabs (scoped to the user's role)
  const totalActiveCount = useMemo(() => {
    const rows = canViewAll ? tasks : tasks.filter((t) => t.worker_id === user?.workerId)
    return rows.filter((t) => !isArchived(t)).length
  }, [tasks, canViewAll, user?.workerId])

  const totalArchivedCount = useMemo(() => {
    const rows = canViewAll ? tasks : tasks.filter((t) => t.worker_id === user?.workerId)
    return rows.filter((t) => isArchived(t)).length
  }, [tasks, canViewAll, user?.workerId])

  // Without tasks.view_all the backend only ever returns the signed-in
  // worker's own tasks; this keeps the UI honest if a stale row is cached.
  const visible = useMemo(
    () => applyTaskFilters(tasks, canViewAll ? null : (user?.workerId ?? null), filters),
    [tasks, canViewAll, user?.workerId, filters]
  )

  // Active tasks for the kanban board
  const activeTasks = useMemo(() => visible.filter((t) => !isArchived(t)), [visible])

  // Archived tasks for the archive view, newest archived first
  const archivedTasks = useMemo(() => {
    return visible
      .filter((t) => isArchived(t))
      .sort((a, b) => (b.archived_at || b.updated_at).localeCompare(a.archived_at || a.updated_at))
  }, [visible])

  // Cards stay compact boxes: the title clamps to two lines and the
  // description to three, and "See more" expands a card on demand instead of
  // letting one long task stretch its whole lane. `expandedIds` holds the
  // currently expanded cards; `overflowIds` holds the ones whose title or
  // description is actually clipped (measured from the rendered elements once
  // the board settles), so the toggle only appears when there is more to see.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [overflowIds, setOverflowIds] = useState<Set<string>>(new Set())
  const clampRefs = useRef(new Map<string, HTMLElement>())

  useEffect(() => {
    setOverflowIds((prev) => {
      const next = new Set(prev)
      let changed = false
      clampRefs.current.forEach((el, key) => {
        const id = key.split('|')[0]
        // Expanded cards are unclamped, so their boxes would always read as
        // "not clipped" — keep the last measured flag until they collapse.
        if (expandedIds.has(id)) return
        const clipped = el.scrollHeight > el.clientHeight + 1
        if (clipped === next.has(id)) return
        changed = true
        if (clipped) next.add(id)
        else next.delete(id)
      })
      return changed ? next : prev
    })
  }, [visible, expandedIds, activeTab])

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const filtersActive = isAnyBoardFilterActive(filters)

  const columns = useMemo(() => {
    // Derived from TASK_STATUSES so adding a stage never needs a change here.
    const grouped = Object.fromEntries(TASK_STATUSES.map((s) => [s, [] as Task[]])) as Record<TaskStatus, Task[]>
    for (const t of activeTasks) grouped[t.status]?.push(t)
    for (const status of TASK_STATUSES) {
      grouped[status].sort((a, b) => a.position - b.position || b.created_at.localeCompare(a.created_at))
    }
    return grouped
  }, [activeTasks])

  const workersWithTasks = useMemo(
    () => workers.filter((w) => tasks.some((t) => t.worker_id === w.id)),
    [workers, tasks]
  )

  // Which lanes to render on the board. Filtering by stage hides the other lanes
  // entirely rather than emptying them, so the board stays a board.
  const shownStages = filters.stage === 'all' ? TASK_STATUSES : [filters.stage]
  const shownTaskCount = filters.stage === 'all' ? activeTasks.length : columns[filters.stage].length

  function openNew(status: TaskStatus) {
    setEditing(null)
    setFormStatus(status)
    setFormOpen(true)
  }

  function openEdit(task: Task) {
    setEditing(task)
    setFormStatus(task.status)
    setFormOpen(true)
  }

  /** Commit a drop: the card goes into `status` at `index`. */
  async function commitDrop(status: TaskStatus, index: number) {
    const task = draggingRef.current
    endDrag()
    if (!task) return
    const items = columns[status]
    const from = items.findIndex((t) => t.id === task.id)
    const others = items.filter((t) => t.id !== task.id)
    // `index` counts the dragged card itself when the drop is in its own
    // column; once the card is taken out, every drop point after its old slot
    // shifts up by one — otherwise a downward move lands one spot too low.
    const target = Math.max(0, Math.min(from !== -1 && from < index ? index - 1 : index, others.length))
    // Dropping a card exactly where it already sits is a no-op.
    if (task.status === status && from === target) return
    await moveTask(task.id, status, target)
  }

  /** Keyboard / touch fallback for dragging: nudge a card one column over. */
  async function shiftTask(task: Task, direction: -1 | 1) {
    const i = TASK_STATUSES.indexOf(task.status)
    const next = TASK_STATUSES[i + direction]
    if (!next) return
    // Same rule as a drop into the column: the moved card lands on top.
    await moveTask(task.id, next, 0)
  }

  /** Archive a single completed task */
  async function handleArchiveSingle(task: Task) {
    const res = await archiveTask(task.id)
    if (res) toast.success(`Task "${task.title}" archived.`)
  }

  /**
   * "Recreate next" on a completed recurring card: clones the task into a
   * fresh To Do card with the due date advanced by one interval (rolled to
   * the assignee's workday). The card itself is left exactly as completed.
   */
  const [recreatingId, setRecreatingId] = useState<string | null>(null)
  async function handleRecreate(task: Task) {
    const plan = planRecreate(task, workerById(task.worker_id)?.workdays ?? [1, 2, 3, 4, 5])
    if (!plan || plan.blockedByEnd) return
    setRecreatingId(task.id)
    try {
      const created = await createTask(plan.input)
      if (created) {
        toast.success(
          created.occurrence && created.occurrence > 1
            ? `Occurrence #${created.occurrence} added to To Do — due ${formatDate(created.due_date ?? plan.nextDue)}.`
            : `Next occurrence added to To Do — due ${formatDate(created.due_date ?? plan.nextDue)}.`,
        )
      }
    } finally {
      setRecreatingId(null)
    }
  }

  /**
   * "Start an occurrence" on a shelf card: the card itself flips into To Do
   * with its due date advanced one interval — the everyday one-click dup.
   */
  const [startingId, setStartingId] = useState<string | null>(null)
  async function handleStartOccurrence(task: Task) {
    setStartingId(task.id)
    try {
      const started = await startRecurringOccurrence(task.id)
      if (started) {
        toast.success(`Occurrence started — due ${started.due_date ? formatDate(started.due_date) : 'no date'}.`)
      }
    } finally {
      setStartingId(null)
    }
  }

  /** "Return to Recurring": send the card back to the shelf (anchor unchanged). */
  async function handleReturnToRecurring(task: Task) {
    const res = await moveTask(task.id, 'recurring', 0)
    if (res) toast.success(`"${task.title}" returned to the Recurring shelf.`)
  }

  /** Restore an archived task back to the completed column */
  async function handleRestoreTask(task: Task) {
    const res = await restoreTask(task.id)
    if (res) toast.success(`"${task.title}" restored to Completed.`)
  }

  /** Archive all completed tasks currently on the board */
  async function handleArchiveAllCompleted() {
    const items = columns.completed
    if (items.length === 0) return
    const ids = items.map((t) => t.id)
    const count = await archiveTasks(ids)
    toast.success(`Archived ${count} completed task${count === 1 ? '' : 's'}.`)
    setConfirmArchiveAll(false)
  }

  /** Restore all visible archived tasks back to the completed column */
  async function handleRestoreAllArchived() {
    if (archivedTasks.length === 0) return
    let count = 0
    for (const t of archivedTasks) {
      const res = await restoreTask(t.id)
      if (res) count++
    }
    toast.success(`Restored ${count} task${count === 1 ? '' : 's'} to the board.`)
    setConfirmRestoreAll(false)
  }

  /**
   * A card, rendered as a plain function call rather than a nested component
   * (a nested component type would be re-created every render and unmount
   * the very node the browser is dragging, killing the drag on the first
   * attempt).
   */
  function renderTaskCard({ task, index, status }: { task: Task; index: number; status: TaskStatus }) {
    const overdue = isOverdue(task)
    const priority = priorityBadge[task.priority]
    const stageIndex = TASK_STATUSES.indexOf(task.status)
    const isExpanded = expandedIds.has(task.id)
    const isClipped = overflowIds.has(task.id)
    const client = clientOf(task.client_id)
    return (
      <div
        draggable
        onDragStart={(e) => {
          startDrag(task)
          e.dataTransfer.effectAllowed = 'move'
          // Firefox refuses to start a drag without data on the transfer.
          e.dataTransfer.setData('text/plain', task.id)
        }}
        onDragEnd={endDrag}
        onDragOver={(e) => {
          if (!draggingRef.current) return
          e.preventDefault()
          e.stopPropagation()
          // Drop above or below this card depending on which half we are over.
          const box = e.currentTarget.getBoundingClientRect()
          const after = e.clientY - box.top > box.height / 2
          setDropTarget({ status, index: after ? index + 1 : index })
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void commitDrop(status, dropTarget?.status === status ? dropTarget.index : index)
        }}
        className={cn(
          'group cursor-grab select-none rounded-xl border bg-card p-3 shadow-sm transition active:cursor-grabbing',
          'hover:border-primary/40 hover:shadow-md',
          dragging?.id === task.id && 'opacity-40',
          overdue && 'border-destructive/40'
        )}
      >
        <div className="min-w-0">
          {/* The client names the card: client title on top, task below. */}
          <div className="flex items-center gap-1.5">
            <ClientDot client={client} className="h-2 w-2" />
            <span
              className="truncate text-xs font-semibold"
              title={client ? client.name : 'No client'}
            >
              {client ? client.name : 'No client'}
              {client?.status === 'inactive' && (
                <span className="text-muted-foreground"> (inactive)</span>
              )}
            </span>
          </div>
          <p
            ref={(el) => {
              if (el) clampRefs.current.set(`${task.id}|title`, el)
              else clampRefs.current.delete(`${task.id}|title`)
            }}
            className={cn(
              'mt-0.5 break-words text-sm font-medium',
              !isExpanded && 'line-clamp-2',
              task.status === 'completed' && 'text-muted-foreground line-through'
            )}
          >
            {task.title}
          </p>
          {task.description && (
            <p
              ref={(el) => {
                if (el) clampRefs.current.set(`${task.id}|desc`, el)
                else clampRefs.current.delete(`${task.id}|desc`)
              }}
              className={cn('mt-1 break-words text-xs text-muted-foreground', !isExpanded && 'line-clamp-3')}
            >
              {task.description}
            </p>
          )}
          {isClipped && (
            <button
              type="button"
              aria-expanded={isExpanded}
              onClick={() => toggleExpand(task.id)}
              className="mt-1 inline-flex items-center gap-0.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              {isExpanded ? 'Show less' : 'See more'}
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-180')} aria-hidden />
            </button>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant={priority.variant} className="text-[10px]">{priority.label}</Badge>
            {task.due_date && (
              <Badge variant={overdue ? 'destructive' : 'muted'} className="gap-1 text-[10px]">
                <CalendarDays className="h-3 w-3" />
                {formatDate(task.due_date)}
              </Badge>
            )}
            {/* Estimated hours ride the card — they feed the workload %. */}
            {task.estimated_hours != null && task.estimated_hours > 0 && (
              <Badge variant="muted" className="gap-1 text-[10px]">
                <Timer className="h-3 w-3" />
                {task.estimated_hours}h
              </Badge>
            )}
            {/* Recurrence: the card is one occurrence of a series. */}
            {task.repeats !== 'none' && (
              <Badge variant="outline" className="gap-1 border-violet-400/50 text-violet-700 text-[10px] dark:text-violet-300">
                <Repeat2 className="h-3 w-3" />
                {TaskRepeatNames[task.repeats]}
                {task.occurrence != null && task.occurrence > 1 ? ` · #${task.occurrence}` : ''}
                {task.repeat_until ? ` · until ${formatDate(task.repeat_until)}` : ''}
              </Badge>
            )}
            {/* On a team-wide board every card names its owner. */}
            {canViewAll && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <AvatarBubble name={workerName(task.worker_id)} avatarUrl={workerAvatar(task.worker_id)} color={workerColor(task.worker_id)} size="sm" className="h-5 w-5 text-[9px]" />
                {workerName(task.worker_id)}
              </span>
            )}
            {!canViewAll && task.created_by_role === 'admin' && (
              <span className="text-[11px] text-muted-foreground">Assigned by admin</span>
            )}
          </div>

          {/* Compact health chips: Due Today / 2 Days Overdue / Waiting 4 Days / … */}
          {(() => {
            const health = taskHealthBadges(task, workerById(task.worker_id)?.workdays ?? [1, 2, 3, 4, 5])
            return health.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {health.map((b) => (
                  <span key={b.label} className={cn('rounded-full border px-1.5 py-0.5 text-[10px] font-semibold', b.tone)}>
                    {b.label}
                  </span>
                ))}
              </div>
            ) : null
          })()}
        </div>

        {/* The shelf's whole point is the one-click dup — always visible,
            not hidden behind a hover. */}
        {task.status === 'recurring' && (
          <Button
            type="button"
            size="sm"
            className="mt-2 w-full gap-1 bg-cyan-600 text-xs font-semibold text-white hover:bg-cyan-700 dark:bg-cyan-600/80 dark:hover:bg-cyan-500/80"
            disabled={startingId === task.id}
            onClick={() => void handleStartOccurrence(task)}
          >
            {startingId === task.id
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <ChevronRight className="h-3.5 w-3.5" />}
            Start occurrence → To Do
          </Button>
        )}

        {/* Card actions stay out of sight until the card is hovered — the
            board reads clean at a glance. Touch pointers always see them. */}
        <div className="mt-2 flex items-center justify-between gap-1 border-t pt-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100">
          {/* Touch-friendly alternative to dragging. */}
          <div className="flex items-center gap-0.5">
            {/* A recurring card off the shelf can go back — the anchor is
                unchanged, so the next start re-uses the same schedule. */}
            {task.repeats !== 'none' && task.status !== 'recurring' && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-cyan-600 hover:text-cyan-700 dark:text-cyan-400"
                aria-label={`Return "${task.title}" to the Recurring shelf`}
                title="Return to the Recurring shelf (reset the template)"
                onClick={() => void handleReturnToRecurring(task)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            )}
            {task.status === 'for_review' && canReview && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs font-semibold text-violet-600 hover:text-violet-700 dark:text-violet-400"
                aria-label={`Review "${task.title}"`}
                onClick={() => setReviewing(task)}
              >
                <SearchCheck className="h-3.5 w-3.5" /> Review
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={stageIndex === 0}
              aria-label={`Move "${task.title}" to the previous stage`}
              onClick={() => void shiftTask(task, -1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={stageIndex === TASK_STATUSES.length - 1}
              aria-label={`Move "${task.title}" to the next stage`}
              onClick={() => void shiftTask(task, 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center gap-0.5">
            {/* A completed recurring card offers its next occurrence. */}
            {task.status === 'completed' && task.repeats !== 'none' && (() => {
              const plan = planRecreate(task, workerById(task.worker_id)?.workdays ?? [1, 2, 3, 4, 5])
              if (!plan) return null
              if (plan.blockedByEnd) {
                return (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    disabled
                    aria-label={`"${task.title}" has reached its end date`}
                    title={`Ends ${formatDate(task.repeat_until ?? plan.nextDue)} — the series is complete`}
                  >
                    <Repeat2 className="h-3.5 w-3.5" />
                  </Button>
                )
              }
              return (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-violet-600 hover:text-violet-700 dark:text-violet-400"
                  aria-label={`Recreate "${task.title}" as the next occurrence`}
                  title={`Next occurrence due ${formatDate(plan.nextDue)}`}
                  disabled={recreatingId === task.id}
                  onClick={() => void handleRecreate(task)}
                >
                  {recreatingId === task.id
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Repeat2 className="h-3.5 w-3.5" />}
                </Button>
              )
            })()}
            {task.status === 'completed' && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                aria-label={`Archive "${task.title}"`}
                title="Archive task"
                onClick={() => void handleArchiveSingle(task)}
              >
                <Archive className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Edit "${task.title}"`} onClick={() => openEdit(task)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive"
              aria-label={`Delete "${task.title}"`}
              onClick={() => setDeleting(task)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    )
  }

  function renderColumn(status: TaskStatus) {
    const style = columnStyles[status]
    const items = columns[status]
    const isTarget = dropTarget?.status === status
    return (
      <div
        key={status}
        onDragOver={(e) => {
          if (!draggingRef.current) return
          e.preventDefault()
          // Empty space drops at the TOP of the column: a freshly dragged
          // card is the newest thing on the stack, so it lands first, not
          // buried at the bottom.
          if (!isTarget) setDropTarget({ status, index: 0 })
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDropTarget((prev) => (prev?.status === status ? null : prev))
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          void commitDrop(status, isTarget ? dropTarget.index : 0)
        }}
        className={cn(
          // One lane of the row. `flex: 1 0 15.5rem` lets the lanes share the
          // board evenly when there is room and keeps them readable (scrolling
          // the row sideways, one snapped lane at a time) when there is not.
          'flex min-h-[14rem] flex-[1_0_15.5rem] snap-start flex-col rounded-xl px-2.5 py-2 transition',
          columnTint[status],
          dragging && 'opacity-80',
          isTarget && cn('bg-muted ring-2', style.ring)
        )}
      >
        <div className={cn('relative mb-3 flex items-center justify-center gap-2', status === 'completed' ? 'pl-4 pr-16' : 'px-7')}>
          <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', style.dot)} aria-hidden />
          <h2 className="truncate text-sm font-semibold">{TaskStatusNames[status]}</h2>
          <Badge variant="muted" className="text-[10px]">{items.length}</Badge>
          <div className="absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            {status === 'completed' && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                aria-label="Archive all completed tasks"
                title="Archive all completed tasks"
                disabled={items.length === 0}
                onClick={() => setConfirmArchiveAll(true)}
              >
                <Archive className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={`Add a task to ${TaskStatusNames[status]}`}
              onClick={() => openNew(status)}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-2">
          {items.map((task, index) => (
            <div key={task.id}>
              {isTarget && dropTarget.index === index && (
                <div className="mb-2 h-1.5 rounded-full bg-primary/60" aria-hidden />
              )}
              {renderTaskCard({ task, index, status })}
            </div>
          ))}
          {isTarget && dropTarget.index >= items.length && (
            <div className="h-1.5 rounded-full bg-primary/60" aria-hidden />
          )}

          {items.length === 0 && !isTarget && (
            <button
              type="button"
              onClick={() => openNew(status)}
              className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
            >
              <Plus className="h-4 w-4" />
              {status === 'todo' ? 'Add a task' : `Drag a task here`}
            </button>
            )}
        </div>
      </div>
    )
  }

  /** Render a card in the archived tasks list */
  function renderArchivedCard(task: Task) {
    const priority = priorityBadge[task.priority]
    const isExpanded = expandedIds.has(task.id)
    const isClipped = overflowIds.has(task.id)
    return (
      <div
        key={task.id}
        className="flex flex-col justify-between rounded-xl border bg-card p-3.5 shadow-sm transition hover:border-primary/40 hover:shadow-md"
      >
        <div>
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
            <div className="min-w-0 flex-1">
              {/* Same rule as the board: client title on top, task below. */}
              <div className="flex items-center gap-1.5">
                <ClientDot client={clientOf(task.client_id)} className="h-2 w-2" />
                <span
                  className="truncate text-xs font-semibold"
                  title={clientOf(task.client_id) ? clientOf(task.client_id)!.name : 'No client'}
                >
                  {clientOf(task.client_id) ? clientOf(task.client_id)!.name : 'No client'}
                  {clientOf(task.client_id)?.status === 'inactive' && (
                    <span className="text-muted-foreground"> (inactive)</span>
                  )}
                </span>
              </div>
              <p
                ref={(el) => {
                  if (el) clampRefs.current.set(`${task.id}|title`, el)
                  else clampRefs.current.delete(`${task.id}|title`)
                }}
                className={cn(
                  'mt-0.5 break-words text-sm font-medium text-muted-foreground line-through',
                  !isExpanded && 'line-clamp-2'
                )}
              >
                {task.title}
              </p>
              {task.description && (
                <p
                  ref={(el) => {
                    if (el) clampRefs.current.set(`${task.id}|desc`, el)
                    else clampRefs.current.delete(`${task.id}|desc`)
                  }}
                  className={cn('mt-1.5 break-words text-xs text-muted-foreground', !isExpanded && 'line-clamp-3')}
                >
                  {task.description}
                </p>
              )}
              {isClipped && (
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() => toggleExpand(task.id)}
                  className="mt-1 inline-flex items-center gap-0.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
                >
                  {isExpanded ? 'Show less' : 'See more'}
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-180')} aria-hidden />
                </button>
              )}

              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <Badge variant={priority.variant} className="text-[10px]">{priority.label}</Badge>
                {task.due_date && (
                  <Badge variant="muted" className="gap-1 text-[10px]">
                    <CalendarDays className="h-3 w-3" />
                    Due {formatDate(task.due_date)}
                  </Badge>
                )}
                {task.completed_at && (
                  <Badge variant="muted" className="gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" />
                    Completed {formatDate(task.completed_at)}
                  </Badge>
                )}
                {task.archived_at && (
                  <Badge variant="muted" className="gap-1 text-[10px]">
                    <Archive className="h-3 w-3" />
                    Archived {formatDate(task.archived_at)}
                  </Badge>
                )}
                {canViewAll && (
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <AvatarBubble name={workerName(task.worker_id)} avatarUrl={workerAvatar(task.worker_id)} color={workerColor(task.worker_id)} size="sm" className="h-5 w-5 text-[9px]" />
                    {workerName(task.worker_id)}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-1 border-t pt-2.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => void handleRestoreTask(task)}
          >
            <ArchiveRestore className="h-3.5 w-3.5" />
            Restore to board
          </Button>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={`Edit "${task.title}"`}
              onClick={() => openEdit(task)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:bg-destructive/10"
              aria-label={`Delete "${task.title}"`}
              onClick={() => setDeleting(task)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const showSkeleton = dataLoading && tasks.length === 0

  return (
    <section aria-label="Tasks board" className="space-y-4">
      {/* Section header: title left, the filter row right (wraps on phones). */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-2">
          <KanbanSquare className="mt-1 h-5 w-5 text-muted-foreground" aria-hidden />
          <div>
            <h2 className="text-base font-semibold leading-tight">Tasks Board</h2>
            <p className="text-sm text-muted-foreground">Drag tasks between stages. Keep it simple and focused.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Worker filter (cross-team, for managers/admins) */}
          {canViewAll && (
            <Select value={filters.worker} onValueChange={(v) => patch({ worker: v })}>
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="All team members" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All team members</SelectItem>
                {workersWithTasks.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <ClientSelect
            value={filters.client}
            onValueChange={(v) => patch({ client: v })}
            includeAll
            className="w-[150px]"
          />

          <Select value={filters.priority} onValueChange={(v) => patch({ priority: v as 'all' | TaskPriority })}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="All priorities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All priorities</SelectItem>
              {(['high', 'medium', 'low'] as TaskPriority[]).map((p) => (
                <SelectItem key={p} value={p}>{TaskPriorityNames[p]}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={filters.stage} onValueChange={(v) => patch({ stage: v as 'all' | TaskStatus })}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="All stages" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stages</SelectItem>
              {TASK_STATUSES.map((st) => (
                <SelectItem key={st} value={st}>{TaskStatusNames[st]}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="relative w-full sm:w-[200px]" role="search">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={filters.search}
              onChange={(e) => patch({ search: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') patch({ search: '' })
              }}
              placeholder="Search tasks…"
              aria-label="Search tasks by title"
              className="pl-9 pr-9"
            />
            {filters.search && (
              <button
                type="button"
                aria-label="Clear task search"
                onClick={() => patch({ search: '' })}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>

          {filtersActive && (
            <Button variant="ghost" onClick={() => clearAllFilters()}>
              Clear filters
            </Button>
          )}

          <Button onClick={() => openNew('todo')}>
            <Plus className="mr-2 h-4 w-4" /> New task
          </Button>
        </div>
      </div>

      {showArchive ? (
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'board' | 'archive')} className="space-y-4">
          <TabsList>
            <TabsTrigger value="board" className="gap-2">
              <KanbanSquare className="h-4 w-4" />
              <span>Board</span>
              <Badge variant="muted" className="text-[10px]">
                {totalActiveCount}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="archive" className="gap-2">
              <Archive className="h-4 w-4" />
              <span>Archive</span>
              {totalArchivedCount > 0 && (
                <Badge variant="muted" className="text-[10px]">
                  {totalArchivedCount}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {/* Board Tab Content */}
          <TabsContent value="board" className="mt-0 space-y-4">
            {showSkeleton ? (
              <div className="rounded-2xl border bg-muted/30 p-2 sm:p-3">
                <div className="flex gap-2 overflow-hidden">
                  {TASK_STATUSES.map((s) => (
                    <Skeleton key={s} className="h-56 flex-[1_0_15.5rem] rounded-xl" />
                  ))}
                </div>
              </div>
            ) : shownTaskCount === 0 && searchActive ? (
              <EmptyState
                icon={Search}
                title="No tasks found"
                description={
                  filtersActive
                    ? `No task titles matching “${filters.search.trim()}” were found with the current filters.`
                    : `No task titles match “${filters.search.trim()}”. Try a different title or clear the search.`
                }
                action={<Button variant="outline" onClick={() => patch({ search: '' })}>Clear search</Button>}
              />
            ) : activeTasks.length === 0 && filtersActive ? (
              // The board is not empty — the filters just hide everything.
              <EmptyState
                icon={KanbanSquare}
                title="No tasks match these filters"
                description="Nothing on the board fits the client, priority, worker or stage you picked."
                action={
                  <Button
                    variant="outline"
                    onClick={() =>
                      clearAllFilters()
                    }
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : activeTasks.length === 0 ? (
              <EmptyState
                icon={KanbanSquare}
                title="No active tasks"
                description={
                  totalArchivedCount > 0
                    ? 'All tasks are in the archive. Switch to the Archive tab to view or restore them, or create a new task.'
                    : canManageAll
                    ? 'Add a task and assign it to a worker. It shows up on their board straight away.'
                    : 'Add your first task, then drag it across the board as you make progress.'
                }
                action={<Button onClick={() => openNew('todo')}><Plus className="mr-2 h-4 w-4" /> New task</Button>}
              />
            ) : (
              // Horizontal board: the stages sit side by side in a single row inside
              // one framed board. When the row is wider than the screen it scrolls
              // sideways, one snapped lane at a time.
              <div className="rounded-2xl border bg-muted/30 p-2 sm:p-3">
                <div
                  ref={rowRef}
                  onDragOver={edgeScroll}
                  className="flex snap-x snap-mandatory gap-2 overflow-x-auto"
                >
                  {shownStages.map((status) => renderColumn(status))}
                </div>
              </div>
            )}
          </TabsContent>

          {/* Archive Tab Content */}
          <TabsContent value="archive" className="mt-0 space-y-4">
            {archivedTasks.length === 0 && searchActive ? (
              <EmptyState
                icon={Search}
                title="No archived tasks found"
                description={
                  filtersActive
                    ? `No archived tasks matching “${filters.search.trim()}” were found with the current filters.`
                    : `No archived tasks match “${filters.search.trim()}”. Try a different title or clear the search.`
                }
                action={<Button variant="outline" onClick={() => patch({ search: '' })}>Clear search</Button>}
              />
            ) : archivedTasks.length === 0 && filtersActive ? (
              <EmptyState
                icon={Archive}
                title="No archived tasks match these filters"
                description="Nothing in the archive fits the client, priority or worker you picked."
                action={
                  <Button
                    variant="outline"
                    onClick={() =>
                      clearAllFilters()
                    }
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : archivedTasks.length === 0 ? (
              <EmptyState
                icon={Archive}
                title="No archived tasks yet"
                description={
                  canManageAll
                    ? 'Completed tasks that you or your team archive from the board will appear here.'
                    : 'Completed tasks you archive from your board will appear here for safe keeping.'
                }
              />
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    Showing {archivedTasks.length} archived {archivedTasks.length === 1 ? 'task' : 'tasks'}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setConfirmRestoreAll(true)}
                  >
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                    Restore all visible
                  </Button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {archivedTasks.map((t) => renderArchivedCard(t))}
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      ) : showSkeleton ? (
        <div className="rounded-2xl border bg-muted/30 p-2 sm:p-3">
          <div className="flex gap-2 overflow-hidden">
            {TASK_STATUSES.map((s) => (
              <Skeleton key={s} className="h-56 flex-[1_0_15.5rem] rounded-xl" />
            ))}
          </div>
        </div>
      ) : shownTaskCount === 0 && searchActive ? (
        <EmptyState
          icon={Search}
          title="No tasks found"
          description={
            filtersActive
              ? `No task titles matching “${filters.search.trim()}” were found with the current filters.`
              : `No task titles match “${filters.search.trim()}”. Try a different title or clear the search.`
          }
          action={<Button variant="outline" onClick={() => patch({ search: '' })}>Clear search</Button>}
        />
      ) : activeTasks.length === 0 && filtersActive ? (
        // The board is not empty — the filters just hide everything.
        <EmptyState
          icon={KanbanSquare}
          title="No tasks match these filters"
          description="Nothing on the board fits the client, priority, worker or stage you picked."
          action={
            <Button
              variant="outline"
              onClick={() =>
                clearAllFilters()
              }
            >
              Clear filters
            </Button>
          }
        />
      ) : activeTasks.length === 0 ? (
        <EmptyState
          icon={KanbanSquare}
          title="No active tasks"
          description={
            totalArchivedCount > 0
              ? 'All tasks are in the archive. Switch to the Archive tab to view or restore them, or create a new task.'
              : canManageAll
              ? 'Add a task and assign it to a worker. It shows up on their board straight away.'
              : 'Add your first task, then drag it across the board as you make progress.'
          }
          action={<Button onClick={() => openNew('todo')}><Plus className="mr-2 h-4 w-4" /> New task</Button>}
        />
      ) : (
        // Horizontal board: the stages sit side by side in a single row inside
        // one framed board, divided by hairlines. When the row is wider than the
        // screen it scrolls sideways, one snapped lane at a time.
        <div className="rounded-2xl border bg-muted/30 p-2 sm:p-3">
          <div
            ref={rowRef}
            onDragOver={edgeScroll}
            className="flex snap-x snap-mandatory gap-2 overflow-x-auto"
          >
            {shownStages.map((status) => renderColumn(status))}
          </div>
        </div>
      )}

      <TaskFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        task={editing}
        defaultStatus={formStatus}
        defaultWorkerId={canManageAll && filters.worker !== 'all' ? filters.worker : undefined}
        defaultClientId={filters.client !== 'all' ? filters.client : undefined}
      />

      {/* QA scoring: accept → Completed, or send back → Rework (§10). */}
      <QaReviewDialog open={!!reviewing} onOpenChange={(v) => !v && setReviewing(null)} task={reviewing} />

      {/* Delete task dialog */}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="Delete this task?"
        description={deleting ? `"${deleting.title}" will be permanently removed. This cannot be undone.` : ''}
        onConfirm={async () => {
          if (deleting) {
            await deleteTask(deleting.id)
            toast.success('Task deleted.')
          }
          setDeleting(null)
        }}
      />

      {/* Bulk archive dialog */}
      <ConfirmDialog
        open={confirmArchiveAll}
        onOpenChange={setConfirmArchiveAll}
        title="Archive all completed tasks?"
        description={`This will move ${columns.completed.length} completed task(s) to the Archive tab. You can view or restore them at any time.`}
        confirmLabel="Archive all"
        destructive={false}
        onConfirm={handleArchiveAllCompleted}
      />

      {/* Bulk restore dialog */}
      <ConfirmDialog
        open={confirmRestoreAll}
        onOpenChange={setConfirmRestoreAll}
        title="Restore all archived tasks?"
        description={`This will restore ${archivedTasks.length} task(s) back to the Completed column on the active board.`}
        confirmLabel="Restore all"
        destructive={false}
        onConfirm={handleRestoreAllArchived}
      />
    </section>
  )
}
