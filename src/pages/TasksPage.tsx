import { useMemo, useRef, useState } from 'react'
import {
  KanbanSquare,
  Plus,
  Pencil,
  Trash2,
  CalendarDays,
  GripVertical,
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  Circle,
  Loader2,
  PauseCircle,
  BadgeCheck,
} from 'lucide-react'
import { useStore } from '@/lib/store'
import type { Task, TaskPriority, TaskStatus } from '@/lib/types'
import { TASK_STATUSES, TaskPriorityNames, TaskStatusNames } from '@/lib/types'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/EmptyState'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TaskFormDialog } from '@/components/TaskFormDialog'
import { AvatarBubble } from '@/components/AvatarBubble'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn, formatDate } from '@/lib/utils'

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
  const { tasks, workers, user, isAdmin, dataLoading, moveTask, deleteTask } = useStore()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Task | null>(null)
  const [formStatus, setFormStatus] = useState<TaskStatus>('todo')
  const [deleting, setDeleting] = useState<Task | null>(null)
  // Admin-only filters: one worker's board (or everyone's) and one stage (or
  // all of them). Both narrow the same board rather than changing its shape.
  const [workerFilter, setWorkerFilter] = useState<string>('all')
  const [stageFilter, setStageFilter] = useState<'all' | TaskStatus>('all')
  // Drag state. `dragging` is the card under the pointer; `dropTarget` is the
  // column (and index) it would land in — used to draw the placeholder.
  const [dragging, setDragging] = useState<Task | null>(null)
  const [dropTarget, setDropTarget] = useState<{ status: TaskStatus; index: number } | null>(null)

  // The lane row scrolls sideways when the stages do not all fit; dragging a
  // card to either edge nudges it along so cross-board drops stay possible.
  const rowRef = useRef<HTMLDivElement | null>(null)
  function edgeScroll(e: React.DragEvent<HTMLDivElement>) {
    const row = rowRef.current
    if (!row || !dragging) return
    const box = row.getBoundingClientRect()
    const edge = 72
    if (e.clientX < box.left + edge) row.scrollLeft -= 18
    else if (e.clientX > box.right - edge) row.scrollLeft += 18
  }

  const workerName = (id: string) => workers.find((w) => w.id === id)?.name || 'Worker'
  const workerAvatar = (id: string) => workers.find((w) => w.id === id)?.avatar_url ?? null

  // Workers only ever receive their own tasks from the backend; this keeps the
  // UI honest even if a stale row slipped into the cache.
  const visible = useMemo(() => {
    const mine = isAdmin ? tasks : tasks.filter((t) => t.worker_id === user?.workerId)
    return workerFilter === 'all' ? mine : mine.filter((t) => t.worker_id === workerFilter)
  }, [tasks, isAdmin, user?.workerId, workerFilter])

  const columns = useMemo(() => {
    // Derived from TASK_STATUSES so adding a stage never needs a change here.
    const grouped = Object.fromEntries(TASK_STATUSES.map((s) => [s, [] as Task[]])) as Record<TaskStatus, Task[]>
    for (const t of visible) grouped[t.status]?.push(t)
    for (const status of TASK_STATUSES) {
      grouped[status].sort((a, b) => a.position - b.position || b.created_at.localeCompare(a.created_at))
    }
    return grouped
  }, [visible])

  const workersWithTasks = useMemo(
    () => workers.filter((w) => tasks.some((t) => t.worker_id === w.id)),
    [workers, tasks]
  )

  // Which lanes to render. Filtering by stage hides the other lanes entirely
  // rather than emptying them, so the board stays a board.
  const shownStages = stageFilter === 'all' ? TASK_STATUSES : [stageFilter]

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
    const task = dragging
    setDragging(null)
    setDropTarget(null)
    if (!task) return
    const column = columns[status].filter((t) => t.id !== task.id)
    const target = Math.max(0, Math.min(index, column.length))
    // Dropping a card exactly where it already sits is a no-op.
    if (task.status === status && columns[status].findIndex((t) => t.id === task.id) === target) return
    await moveTask(task.id, status, target)
  }

  /** Keyboard / touch fallback for dragging: nudge a card one column over. */
  async function shiftTask(task: Task, direction: -1 | 1) {
    const i = TASK_STATUSES.indexOf(task.status)
    const next = TASK_STATUSES[i + direction]
    if (!next) return
    await moveTask(task.id, next, columns[next].length)
  }

  const TaskCard = ({ task, index, status }: { task: Task; index: number; status: TaskStatus }) => {
    const overdue = isOverdue(task)
    const priority = priorityBadge[task.priority]
    const stageIndex = TASK_STATUSES.indexOf(task.status)
    return (
      <div
        draggable
        onDragStart={(e) => {
          setDragging(task)
          e.dataTransfer.effectAllowed = 'move'
          // Firefox refuses to start a drag without data on the transfer.
          e.dataTransfer.setData('text/plain', task.id)
        }}
        onDragEnd={() => {
          setDragging(null)
          setDropTarget(null)
        }}
        onDragOver={(e) => {
          if (!dragging) return
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
          'group cursor-grab rounded-xl border bg-card p-3 shadow-sm transition active:cursor-grabbing',
          'hover:border-primary/40 hover:shadow-md',
          dragging?.id === task.id && 'opacity-40',
          overdue && 'border-destructive/40'
        )}
      >
        <div className="flex items-start gap-2">
          <GripVertical className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className={cn('break-words text-sm font-medium', task.status === 'completed' && 'text-muted-foreground line-through')}>
              {task.title}
            </p>
            {task.description && (
              <p className="mt-1 break-words text-xs text-muted-foreground">{task.description}</p>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant={priority.variant} className="text-[10px]">{priority.label}</Badge>
              {task.due_date && (
                <Badge variant={overdue ? 'destructive' : 'muted'} className="gap-1 text-[10px]">
                  <CalendarDays className="h-3 w-3" />
                  {formatDate(task.due_date)}
                </Badge>
              )}
              {/* Admins work across everyone's cards, so each one names its owner. */}
              {isAdmin && (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <AvatarBubble name={workerName(task.worker_id)} avatarUrl={workerAvatar(task.worker_id)} size="sm" className="h-5 w-5 text-[9px]" />
                  {workerName(task.worker_id)}
                </span>
              )}
              {!isAdmin && task.created_by_role === 'admin' && (
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

  const Column = ({ status }: { status: TaskStatus }) => {
    const style = columnStyles[status]
    const items = columns[status]
    const isTarget = dropTarget?.status === status
    return (
      <div
        onDragOver={(e) => {
          if (!dragging) return
          e.preventDefault()
          // Empty space below the cards drops at the end of the column.
          if (!isTarget) setDropTarget({ status, index: items.length })
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDropTarget((prev) => (prev?.status === status ? null : prev))
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          void commitDrop(status, isTarget ? dropTarget.index : items.length)
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
        <div className="relative mb-3 flex items-center justify-center gap-2 px-7">
          <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', style.dot)} aria-hidden />
          <h2 className="truncate text-sm font-semibold">{TaskStatusNames[status]}</h2>
          <Badge variant="muted" className="text-[10px]">{items.length}</Badge>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-0 top-1/2 h-7 w-7 -translate-y-1/2"
            aria-label={`Add a task to ${TaskStatusNames[status]}`}
            onClick={() => openNew(status)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex flex-1 flex-col gap-2">
          {items.map((task, index) => (
            <div key={task.id}>
              {isTarget && dropTarget.index === index && (
                <div className="mb-2 h-1.5 rounded-full bg-primary/60" aria-hidden />
              )}
              <TaskCard task={task} index={index} status={status} />
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

  const showSkeleton = dataLoading && tasks.length === 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description={
          isAdmin
            ? "Every worker's board. Drag a card between stages to update it."
            : 'Your board. Drag a card between stages as you work through it.'
        }
      >
        {isAdmin && (
          <>
            <Select value={workerFilter} onValueChange={setWorkerFilter}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="All workers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All workers</SelectItem>
                {workersWithTasks.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={stageFilter} onValueChange={(v) => setStageFilter(v as 'all' | TaskStatus)}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="All stages" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stages</SelectItem>
                {TASK_STATUSES.map((st) => (
                  <SelectItem key={st} value={st}>{TaskStatusNames[st]}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {(workerFilter !== 'all' || stageFilter !== 'all') && (
              <Button
                variant="ghost"
                onClick={() => { setWorkerFilter('all'); setStageFilter('all') }}
              >
                Clear filters
              </Button>
            )}
          </>
        )}
        <Button onClick={() => openNew('todo')}>
          <Plus className="mr-2 h-4 w-4" /> New task
        </Button>
      </PageHeader>

      {showSkeleton ? (
        <div className="rounded-2xl border bg-muted/30 p-2 sm:p-3">
          <div className="flex gap-2 overflow-hidden">
            {TASK_STATUSES.map((s) => (
              <Skeleton key={s} className="h-56 flex-[1_0_15.5rem] rounded-xl" />
            ))}
          </div>
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={KanbanSquare}
          title="No tasks yet"
          description={
            isAdmin
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
            {shownStages.map((status) => (
              <Column key={status} status={status} />
            ))}
          </div>
        </div>
      )}

      <TaskFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        task={editing}
        defaultStatus={formStatus}
        defaultWorkerId={isAdmin && workerFilter !== 'all' ? workerFilter : undefined}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="Delete this task?"
        description={deleting ? `"${deleting.title}" will be removed from the board. This cannot be undone.` : ''}
        onConfirm={async () => {
          if (deleting) await deleteTask(deleting.id)
          setDeleting(null)
        }}
      />
    </div>
  )
}
