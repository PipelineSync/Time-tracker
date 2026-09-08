import { useEffect, useState } from 'react'
import { useStore } from '@/lib/store'
import type { Task, TaskPriority, TaskStatus } from '@/lib/types'
import { TASK_STATUSES, TaskPriorityNames, TaskStatusNames } from '@/lib/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'

interface FormState {
  workerId: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  dueDate: string
}

const emptyForm = (status: TaskStatus): FormState => ({
  workerId: '',
  title: '',
  description: '',
  status,
  priority: 'medium',
  dueDate: '',
})

/**
 * Add / edit a task. The admin picks who the task is for; a worker's tasks are
 * always their own, so they never see the assignee field (the backend and RLS
 * enforce that regardless of what the client sends).
 */
export function TaskFormDialog({
  open,
  onOpenChange,
  task,
  defaultStatus = 'todo',
  defaultWorkerId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  task: Task | null
  /** Column the "Add task" button belongs to. */
  defaultStatus?: TaskStatus
  defaultWorkerId?: string
}) {
  const { workers, user, isAdmin, createTask, updateTask } = useStore()
  const [form, setForm] = useState<FormState>(emptyForm(defaultStatus))
  const [saving, setSaving] = useState(false)

  const activeWorkers = workers.filter((w) => w.status === 'active')
  const pickable = activeWorkers.length > 0 ? activeWorkers : workers

  useEffect(() => {
    if (!open) return
    if (task) {
      setForm({
        workerId: task.worker_id,
        title: task.title,
        description: task.description || '',
        status: task.status,
        priority: task.priority,
        dueDate: task.due_date ? task.due_date.slice(0, 10) : '',
      })
    } else {
      setForm({
        ...emptyForm(defaultStatus),
        workerId: isAdmin ? defaultWorkerId || pickable[0]?.id || '' : user?.workerId || '',
      })
    }
    // `pickable` is derived from workers; re-running on its identity would
    // reset the form on every background refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task, defaultStatus, defaultWorkerId, isAdmin, user?.workerId])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const title = form.title.trim()
    if (!title) {
      toast.error('Give the task a title.')
      return
    }
    if (isAdmin && !form.workerId) {
      toast.error('Choose who the task is for.')
      return
    }
    setSaving(true)
    try {
      if (task) {
        const saved = await updateTask(task.id, {
          title,
          description: form.description.trim() || null,
          status: form.status,
          priority: form.priority,
          due_date: form.dueDate || null,
          ...(isAdmin ? { worker_id: form.workerId } : {}),
        })
        if (!saved) return
        toast.success('Task updated.')
      } else {
        const created = await createTask({
          worker_id: isAdmin ? form.workerId : undefined,
          title,
          description: form.description.trim() || null,
          status: form.status,
          priority: form.priority,
          due_date: form.dueDate || null,
        })
        if (!created) return
        toast.success('Task added.')
      }
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{task ? 'Edit task' : 'New task'}</DialogTitle>
            <DialogDescription>
              {isAdmin
                ? 'Assign work to a team member and track it on the board.'
                : 'Add something to your own board and drag it across as you go.'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {isAdmin && (
              <div className="grid gap-2">
                <Label htmlFor="task-worker">Assign to</Label>
                <Select value={form.workerId} onValueChange={(v) => set('workerId', v)}>
                  <SelectTrigger id="task-worker">
                    <SelectValue placeholder="Choose a worker" />
                  </SelectTrigger>
                  <SelectContent>
                    {pickable.map((w) => (
                      <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="task-title">Title</Label>
              <Input
                id="task-title"
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder="e.g. Replace the pump seal"
                maxLength={200}
                autoFocus
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="task-description">Details (optional)</Label>
              <Textarea
                id="task-description"
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="Anything worth remembering about this task…"
                rows={3}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor="task-status">Stage</Label>
                <Select value={form.status} onValueChange={(v) => set('status', v as TaskStatus)}>
                  <SelectTrigger id="task-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TASK_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>{TaskStatusNames[s]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="task-priority">Priority</Label>
                <Select value={form.priority} onValueChange={(v) => set('priority', v as TaskPriority)}>
                  <SelectTrigger id="task-priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(['low', 'medium', 'high'] as TaskPriority[]).map((p) => (
                      <SelectItem key={p} value={p}>{TaskPriorityNames[p]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="task-due">Due date</Label>
                <Input
                  id="task-due"
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => set('dueDate', e.target.value)}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : task ? 'Save changes' : 'Add task'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
