import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Building2,
  KanbanSquare,
  Plus,
  Pencil,
  Trash2,
  CalendarDays,
  GripVertical,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  CheckCircle2,
  Circle,
  Loader2,
  PauseCircle,
  BadgeCheck,
  Search,
  X,
  Archive,
  ArchiveRestore,
  RotateCcw,
} from 'lucide-react'
import { useStore } from '@/lib/store'
import type { Task, TaskPriority, TaskStatus } from '@/lib/types'
import { TASK_STATUSES, TaskPriorityNames, TaskStatusNames } from '@/lib/types'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/EmptyState'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TaskFormDialog } from '@/components/TaskFormDialog'
import { ManageClientsDialog } from '@/components/ManageClientsDialog'
import { ClientBadge } from '@/components/ClientBadge'
import { ClientSelect } from '@/components/ClientSelect'
import { AvatarBubble } from '@/components/AvatarBubble'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { cn, formatDate } from '@/lib/utils'
import { toast } from 'sonner'

/** Column accents — the board reads at a glance without a legend. */
const columnStyles: Record<TaskStatus, { icon: typeof Circle; dot: string; ring: string }> = {
  todo: { icon: Circle, dot: 'bg-slate-400', ring: 'ring-slate-400/40' },
  in_progress: { icon: Loader2, dot: 'bg-amber-500', ring: 'ring-amber-500/40' },
  waiting: { icon: PauseCircle, dot: 'bg-orange-500', ring: 'ring-orange-500/40' },
  approval: { icon: BadgeCheck, dot: 'bg-violet-500', ring: 'ring-violet-500/40' },
  completed: { icon: CheckCircle2, dot: 'bg-emerald-500', ring: 'ring-emerald-500/40' },
}

const priorityBadge: Record<TaskPriority, { variant: 'muted' | 'outline' | 'destructive'; label: string }> = {
  low: { variant: 'muted', label: TaskPriorityNames.low },
  medium: { variant: 'outline', label: TaskPriorityNames.medium },
  high: { variant: 'destructive', label: TaskPriorityNames.high },
}

/** True when a not-yet-completed task's due date has passed. */
function isOverdue(task: Task): boolean {
  if (!task.due_date || task.status === 'completed') return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return new Date(`${task.due_date.slice(0, 10)}T00:00:00`) < today
}

export function TasksPage() {
  const {
    tasks,
    workers,
    clients,
    user,
    can,
    dataLoading,
    moveTask,
    deleteTask,
    archiveTask,
    restoreTask,
    archiveTasks,
  } = useStore()
  // Seeing everyone's board and running it are separate grants; the admin has
  // both, a worker has whatever was ticked on their row.
  const canViewAll = can('tasks.view_all')
  const canManageAll = can('tasks.manage_all')

  const [activeTab, setActiveTab] = useState<'board' | 'archive'>('board')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Task | null>(null)
  const [formStatus, setFormStatus] = useState<TaskStatus>('todo')
  const [deleting, setDeleting] = useState<Task | null>(null)
  const [confirmArchiveAll, setConfirmArchiveAll] = useState(false)
  const [confirmRestoreAll, setConfirmRestoreAll] = useState(false)
  const [clientsOpen, setClientsOpen] = useState(false)

  // Admin-only filters: one worker's board (or everyone's) and one stage (or
  // all of them). Both narrow the same board rather than changing its shape.
  const [workerFilter, setWorkerFilter] = useState<string>('all')
  const [stageFilter, setStageFilter] = useState<'all' | TaskStatus>('all')
  // Filters both roles get: narrow the board to one client and/or one priority.
  const [clientFilter, setClientFilter] = useState<string>('all')
  const [priorityFilter, setPriorityFilter] = useState<'all' | TaskPriority>('all')
  // Search is intentionally title-only so results stay predictable as task
  // descriptions, assignees and client labels change around the board.
  const [searchQuery, setSearchQuery] = useState('')

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
  const clientOf = (id: string | null) => (id ? clients.find((c) => c.id === id) ?? null : null)

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase()
  const searchActive = normalizedSearch.length > 0

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
  // Search composes with the existing filters and only considers task titles.
  const visible = useMemo(() => {
    let rows = canViewAll ? tasks : tasks.filter((t) => t.worker_id === user?.workerId)
    if (workerFilter !== 'all') rows = rows.filter((t) => t.worker_id === workerFilter)
    if (clientFilter !== 'all') rows = rows.filter((t) => t.client_id === clientFilter)
    if (priorityFilter !== 'all') rows = rows.filter((t) => t.priority === priorityFilter)
    if (normalizedSearch) rows = rows.filter((t) => t.title.toLocaleLowerCase().includes(normalizedSearch))
    return rows
  }, [tasks, canViewAll, user?.workerId, workerFilter, clientFilter, priorityFilter, normalizedSearch])

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

  const filtersActive =
    workerFilter !== 'all' ||
    (activeTab === 'board' && stageFilter !== 'all') ||
    clientFilter !== 'all' ||
    priorityFilter !== 'all'

  const clearFilters = () => {
    setWorkerFilter('all')
    setStageFilter('all')
    setClientFilter('all')
    setPriorityFilter('all')
    setSearchQuery('')
  }

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
  const shownStages = stageFilter === 'all' ? TASK_STATUSES : [stageFilter]
  const shownTaskCount = stageFilter === 'all' ? activeTasks.length : columns[stageFilter].length

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

  /** Restore all visible archived tasks */
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
   * A card, rendered as a plain function call rather than a nested component.
   */
  function renderTaskCard({ task, index, status }: { task: Task; index: number; status: TaskStatus }) {
    const overdue = isOverdue(task)
    const priority = priorityBadge[task.priority]
    const stageIndex = TASK_STATUSES.indexOf(task.status)
    const isExpanded = expandedIds.has(task.id)
    const isClipped = overflowIds.has(task.id)
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
        <div className="flex items-start gap-2">
          <GripVertical className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden />
          <div className="min-w-0 flex-1">
            <p
              ref={(el) => {
                if (el) clampRefs.current.set(`${task.id}|title`, el)
                else clampRefs.current.delete(`${task.id}|title`)
              }}
              className={cn(
                'break-words text-sm font-medium',
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
              {/* Every card names its client — the board is read across accounts. */}
              <ClientBadge client={clientOf(task.client_id)} showInactive={false} />
              <Badge variant={priority.variant} className="text-[10px]">{priority.label}</Badge>
              {task.due_date && (
                <Badge variant={overdue ? 'destructive' : 'muted'} className="gap-1 text-[10px]">
                  <CalendarDays className="h-3 w-3" />
                  {formatDate(task.due_date)}
                </Badge>
              )}
              {/* On a team-wide board every card names its owner. */}
              {canViewAll && (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <AvatarBubble name={workerName(task.worker_id)} avatarUrl={workerAvatar(task.worker_id)} size="sm" className="h-5 w-5 text-[9px]" />
                  {workerName(task.worker_id)}
                </span>
              )}
              {!canViewAll && task.created_by_role === 'admin' && (
                <span className="text-[11px] text-muted-foreground">Assigned by admin</span>
              )}
            </div>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between gap-1 border-t pt-2">
          {/* Touch-friendly alternative to dragging. */}
          <div className="flex items-center gap-0.5">
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
          dragging && 'bg-muted/40',
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
              <p
                ref={(el) => {
                  if (el) clampRefs.current.set(`${task.id}|title`, el)
                  else clampRefs.current.delete(`${task.id}|title`)
                }}
                className={cn(
                  'break-words text-sm font-medium text-muted-foreground line-through',
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
                <ClientBadge client={clientOf(task.client_id)} showInactive={false} />
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
                    <AvatarBubble name={workerName(task.worker_id)} avatarUrl={workerAvatar(task.worker_id)} size="sm" className="h-5 w-5 text-[9px]" />
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
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description={
          activeTab === 'archive'
            ? canViewAll
              ? 'Archive of completed tasks for all workers. Restore or delete as needed.'
              : 'Archive of your completed tasks. Restore or delete as needed.'
            : canViewAll
            ? "Every worker's board. Drag a card between stages to update it."
            : 'Your board. Drag a card between stages as you work through it.'
        }
      >
        <div className="relative w-full sm:w-[220px]" role="search">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSearchQuery('')
            }}
            placeholder="Search task titles…"
            aria-label="Search tasks by title"
            className="pl-9 pr-9"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label="Clear task search"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>

        {/* Worker filter (cross-team, for managers/admins) */}
        {canViewAll && (
          <Select value={workerFilter} onValueChange={setWorkerFilter}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="All workers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All workers</SelectItem>
              {workersWithTasks.map((w) => (
                <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Stage filter is relevant only on the kanban board */}
        {canViewAll && activeTab === 'board' && (
          <Select value={stageFilter} onValueChange={(v) => setStageFilter(v as 'all' | TaskStatus)}>
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
        )}

        <ClientSelect
          value={clientFilter}
          onValueChange={setClientFilter}
          includeAll
          className="w-[150px]"
        />

        <Select value={priorityFilter} onValueChange={(v) => setPriorityFilter(v as 'all' | TaskPriority)}>
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

        {filtersActive && (
          <Button variant="ghost" onClick={clearFilters}>
            Clear filters
          </Button>
        )}

        {can('clients.manage') && (
          <Button variant="outline" onClick={() => setClientsOpen(true)}>
            <Building2 className="mr-2 h-4 w-4" /> Clients
          </Button>
        )}
        <Button onClick={() => openNew('todo')}>
          <Plus className="mr-2 h-4 w-4" /> New task
        </Button>
      </PageHeader>

      {/* Tabs navigation: Kanban Board vs Archived Tasks */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'board' | 'archive')} className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
        </div>

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
                  ? `No task titles matching “${searchQuery.trim()}” were found with the current filters.`
                  : `No task titles match “${searchQuery.trim()}”. Try a different title or clear the search.`
              }
              action={<Button variant="outline" onClick={() => setSearchQuery('')}>Clear search</Button>}
            />
          ) : activeTasks.length === 0 && filtersActive ? (
            // The board is not empty — the filters just hide everything.
            <EmptyState
              icon={KanbanSquare}
              title="No tasks match these filters"
              description="Nothing on the board fits the client, priority, worker or stage you picked."
              action={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
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
                className="flex snap-x snap-mandatory divide-x overflow-x-auto"
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
                  ? `No archived tasks matching “${searchQuery.trim()}” were found with the current filters.`
                  : `No archived tasks match “${searchQuery.trim()}”. Try a different title or clear the search.`
              }
              action={<Button variant="outline" onClick={() => setSearchQuery('')}>Clear search</Button>}
            />
          ) : archivedTasks.length === 0 && filtersActive ? (
            <EmptyState
              icon={Archive}
              title="No archived tasks match these filters"
              description="Nothing in the archive fits the client, priority or worker you picked."
              action={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
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

      <TaskFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        task={editing}
        defaultStatus={formStatus}
        defaultWorkerId={canManageAll && workerFilter !== 'all' ? workerFilter : undefined}
        defaultClientId={clientFilter !== 'all' ? clientFilter : undefined}
      />

      {can('clients.manage') && <ManageClientsDialog open={clientsOpen} onOpenChange={setClientsOpen} />}

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
    </div>
  )
}
