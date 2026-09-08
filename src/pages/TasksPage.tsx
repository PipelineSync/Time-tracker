import { useMemo, useState } from 'react'
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
  // Admin-only filter: one worker's board, or everyone's.
  const [workerFilter, setWorkerFilter] = useState<string>('all')
  // Drag state. `dragging` is the card under the pointer; `dropTarget` is the
  // column (and index) it would land in — used to draw the placeholder.
  const [dragging, setDragging] = useState<Task | null>(null)
  const [dropTarget, setDropTarget] = useState<{ status: TaskStatus; index: number } | null>(null)

  const workerName = (id: string) => workers.find((w) => w.id === id)?.name || 'Worker'
  const workerAvatar = (id: string) => workers.find((w) => w.id === id)?.avatar_url ?? null

  // Workers only ever receive their own tasks from the backend; this keeps the
  // UI honest even if a stale row slipped into the cache.
  const visible = useMemo(() => {
    const mine = isAdmin ? tasks : tasks.filter((t) => t.worker_id === user?.workerId)
    return workerFilter === 'all' ? mine : mine.filter((t) => t.worker_id === workerFilter)
  }, [tasks, isAdmin, user?.workerId, workerFilter])

  const columns = useMemo(() => {
    const grouped: Record<TaskStatus, Task[]> = { todo: [], in_progress: [], completed: [] }
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
          'flex min-h-[9rem] flex-col rounded-2xl border bg-muted/40 p-3 transition',
          dragging && 'border-dashed',
          isTarget && cn('bg-muted ring-2', style.ring)
        )}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={cn('h-2.5 w-2.5 rounded-full', style.dot)} aria-hidden />
            <h2 className="text-sm font-semibold">{TaskStatusNames[status]}</h2>
            <Badge variant="muted" className="text-[10px]">{items.length}</Badge>
          </div>
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
              className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-dashed p-5 text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
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
        {isAdmin && workersWithTasks.length > 0 && (
          <Select value={workerFilter} onValueChange={setWorkerFilter}>
            <SelectTrigger className="w-[190px]">
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
        <Button onClick={() => openNew('todo')}>
          <Plus className="mr-2 h-4 w-4" /> New task
        </Button>
      </PageHeader>

      {showSkeleton ? (
        <div className="flex flex-col gap-4">
          {TASK_STATUSES.map((s) => (
            <Skeleton key={s} className="h-40 rounded-2xl" />
          ))}
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
        // Vertical board: the three stages stack top-to-bottom, each one a
        // full-width lane you scroll through and drag between.
        <div className="flex flex-col gap-4">
          {TASK_STATUSES.map((status) => (
            <Column key={status} status={status} />
          ))}
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
