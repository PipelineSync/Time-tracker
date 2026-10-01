import { useEffect, useState } from 'react'
import { useStore } from '@/lib/store'
import type { Task, TaskPriority, TaskRepeats, TaskStatus, WaitingReason } from '@/lib/types'
import { TASK_REPEATS, TASK_STATUSES, TaskPriorityNames, TaskRepeatNames, TaskStatusNames, WAITING_REASONS, WaitingReasonNames } from '@/lib/types'
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
import { ClientSelect } from '@/components/ClientSelect'
import { ManageClientsDialog } from '@/components/ManageClientsDialog'
import { DEFAULT_QA_REQUIRED, DEFAULT_RECURRING_QA_REQUIRED, defaultQaRequired, isQaCompletionBlocked } from '@/lib/taskWorkflow'
import { todayISO } from '@/lib/utils'
import { toast } from 'sonner'

interface FormState {
  workerId: string
  clientId: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  startDate: string
  dueDate: string
  /** Estimated hours — drives schedule-aware workload on the Team KPI page. */
  estimatedHours: string
  /** Recurrence interval — 'none' = one-off task. */
  repeats: TaskRepeats
  /** Optional end date for the series ('' = no end). */
  repeatUntil: string
  /** Why the work is blocked (only meaningful on the Waiting column). */
  waitingReason: WaitingReason | ''
  /** "QA Required?" — only the Owner / KPI access ever see or change it. */
  qaRequired: boolean
}

const emptyForm = (status: TaskStatus): FormState => ({
  workerId: '',
  clientId: '',
  title: '',
  description: '',
  status,
  priority: 'medium',
  startDate: todayISO(),
  dueDate: '',
  estimatedHours: '',
  repeats: 'none',
  repeatUntil: '',
  waitingReason: '',
  qaRequired: DEFAULT_QA_REQUIRED,
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
  defaultClientId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  task: Task | null
  /** Column the "Add task" button belongs to. */
  defaultStatus?: TaskStatus
  defaultWorkerId?: string
  /** Pre-selected client (the board's client filter, when one is active). */
  defaultClientId?: string
}) {
  const { workers, user, can, activeClients, createTask, updateTask } = useStore()
  // Only someone who runs the whole board can assign work to another person.
  const canAssign = can('tasks.manage_all')
  const canManageClients = can('clients.manage')
  // "QA Required?" belongs to the Owner and people with KPI access — the same
  // people who can complete a QA-required task. Everyone else never sees the
  // box: what they add is created with the default for its kind (Yes for a
  // one-off, No for a repeating task), and what they edit keeps the setting it
  // has.
  const canSetQa = can('team_kpi.view')
  const [form, setForm] = useState<FormState>(emptyForm(defaultStatus))
  const [saving, setSaving] = useState(false)
  const [clientsOpen, setClientsOpen] = useState(false)
  // Whether the QA Required box was ticked by hand in this sitting. Until it
  // is, the box follows the Repeats choice: a repeating task starts QA-free,
  // a one-off starts QA-required.
  const [qaTouched, setQaTouched] = useState(false)
  // A plain worker cannot take a QA-required task into Completed: a new task
  // gets the default for its kind (Yes one-off, No repeating), an existing one
  // is whatever it is now.
  const completionLocked =
    !canSetQa &&
    (task
      ? isQaCompletionBlocked({ qaRequired: task.qa_required, from: task.status, to: 'completed' }, false)
      // A card added from this dialog starts its own series (or is a one-off),
      // so only the Repeats choice decides the default.
      : defaultQaRequired({ repeats: form.repeats, series_id: null }))

  const activeWorkers = workers.filter((w) => w.status === 'active')
  const pickable = activeWorkers.length > 0 ? activeWorkers : workers
  // Every task belongs to a client. With an empty master list there is nothing
  // to pick, so the form says so instead of failing on save.
  const noClients = activeClients.length === 0

  useEffect(() => {
    if (!open) return
    setQaTouched(false)
    if (task) {
      setForm({
        workerId: task.worker_id,
        clientId: task.client_id || '',
        title: task.title,
        description: task.description || '',
        status: task.status,
        priority: task.priority,
        startDate: task.start_date ? task.start_date.slice(0, 10) : todayISO(),
        dueDate: task.due_date ? task.due_date.slice(0, 10) : '',
        estimatedHours: task.estimated_hours != null ? String(task.estimated_hours) : '',
        repeats: task.repeats,
        repeatUntil: task.repeat_until ?? '',
        waitingReason: task.waiting_reason ?? '',
        qaRequired: task.qa_required,
      })
    } else {
      // Seed the assignee. Managers (anyone with tasks.manage_all) may put a
      // card on someone else's board, so the field is pre-populated with the
      // first pickable worker. A regular worker's own id is the only valid
      // choice — fall back to that, even if `canAssign` flipped on a stale
      // render, so the form never opens with a missing assignee.
      const ownId = user?.workerId || ''
      const seedAssignee = canAssign
        ? defaultWorkerId || pickable[0]?.id || ownId
        : ownId
      setForm({
        ...emptyForm(!canSetQa && DEFAULT_QA_REQUIRED && defaultStatus === 'completed' ? 'todo' : defaultStatus),
        workerId: seedAssignee,
        // One client on the list is not a choice — pre-pick it.
        clientId: defaultClientId || (activeClients.length === 1 ? activeClients[0].id : ''),
      })
    }
    // `pickable` is derived from workers; re-running on its identity would
    // reset the form on every background refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task, defaultStatus, defaultWorkerId, defaultClientId, canAssign, canSetQa, user?.workerId])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  // A database that predates the QA migration accepts the task but has nowhere
  // to keep the flag — say so instead of silently not enforcing it.
  function warnIfQaNotStored(saved: Task) {
    if (canSetQa && form.qaRequired && !saved.qa_required) {
      toast.warning('QA Required could not be saved on this database.', {
        description: 'Run supabase/RUN-THIS-task-qa-required.sql once so QA is enforced.',
      })
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const title = form.title.trim()
    if (!title) {
      toast.error('Give the task a title.')
      return
    }
    // The assignee is the picked worker when the user can assign to others,
    // otherwise it's the signed-in worker themselves. Always pass it
    // explicitly: relying on a server-side fallback creates a race when the
    // form's view of `canAssign` is briefly out of sync with the backend's.
    const assignee = canAssign ? form.workerId : user?.workerId || ''
    if (!assignee) {
      if (canAssign) {
        toast.error('Choose who the task is for.')
      } else {
        // No Assign-to field is shown, so the worker is on their own — but
        // their profile is missing, which means the admin needs to fix the
        // account before this worker can add tasks.
        toast.error('Your worker profile is missing — please contact your administrator.')
      }
      return
    }
    if (!form.clientId) {
      toast.error(noClients ? 'Add a client first — every task belongs to one.' : 'Choose the client this task is for.')
      return
    }
    // §4: a due date is required for every NEW task — the on-time KPI depends
    // on it. Editing an old card may leave it blank (legacy stays excluded).
    if (!task && !form.dueDate) {
      toast.error('Every new task needs a due date.')
      return
    }
    // Every task records when it starts — the form pre-fills today, so this
    // only trips if the field was actively cleared.
    if (!form.startDate) {
      toast.error('Every task needs a start date.')
      return
    }
    const estimatedHours =
      form.estimatedHours.trim() === ''
        ? null
        : Number(form.estimatedHours)
    if (estimatedHours != null && (!Number.isFinite(estimatedHours) || estimatedHours < 0)) {
      toast.error('Estimated hours must be a positive number.')
      return
    }
    // A series with an end date but no due date has no anchor to advance
    // from, so "Recreate next" could never compute the next date.
    if (form.repeats !== 'none' && form.repeatUntil && !form.dueDate) {
      toast.error('A repeating task with an end date also needs a due date.')
      return
    }
    const repeatUntil = form.repeatUntil || null
    setSaving(true)
    try {
      if (task) {
        const saved = await updateTask(task.id, {
          client_id: form.clientId,
          title,
          description: form.description.trim() || null,
          status: form.status,
          priority: form.priority,
          start_date: form.startDate,
          due_date: form.dueDate || null,
          estimated_hours: estimatedHours,
          repeats: form.repeats,
          repeat_until: repeatUntil,
          ...(form.status === 'waiting' && form.waitingReason
            ? { waiting_reason: form.waitingReason }
            : {}),
          ...(canAssign ? { worker_id: form.workerId } : {}),
          // Only sent by those who may change it, so a plain worker's edit can
          // never touch the setting.
          ...(canSetQa ? { qa_required: form.qaRequired } : {}),
        })
        if (!saved) return
        toast.success('Task updated.')
        warnIfQaNotStored(saved)
      } else {
        const created = await createTask({
          worker_id: assignee,
          client_id: form.clientId,
          title,
          description: form.description.trim() || null,
          status: form.status,
          priority: form.priority,
          start_date: form.startDate,
          due_date: form.dueDate,
          estimated_hours: estimatedHours,
          repeats: form.repeats,
          repeat_until: repeatUntil,
          ...(form.status === 'waiting' && form.waitingReason
            ? { waiting_reason: form.waitingReason }
            : {}),
          // Left out for everyone else, so the task gets the default (Yes).
          ...(canSetQa ? { qa_required: form.qaRequired } : {}),
        })
        if (!created) return
        toast.success('Task added.')
        warnIfQaNotStored(created)
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
              {canAssign
                ? 'Assign work to a team member and track it on the board.'
                : 'Add something to your own board and drag it across as you go.'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {canAssign && (
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
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="task-client">Client</Label>
                {canManageClients && (
                  <button
                    type="button"
                    onClick={() => setClientsOpen(true)}
                    className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                  >
                    Manage clients
                  </button>
                )}
              </div>
              <ClientSelect
                id="task-client"
                value={form.clientId}
                onValueChange={(v) => set('clientId', v)}
                disabled={noClients}
                placeholder={noClients ? 'No active clients yet' : 'Choose a client'}
              />
              {noClients && (
                <p className="text-xs text-muted-foreground">
                  {canManageClients
                    ? 'Add a client first — every task is assigned to one.'
                    : 'Ask your admin to add a client before creating tasks.'}
                </p>
              )}
            </div>

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

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="task-status">Stage</Label>
                <Select value={form.status} onValueChange={(v) => set('status', v as TaskStatus)}>
                  <SelectTrigger id="task-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TASK_STATUSES.map((s) => {
                      const locked = s === 'completed' && completionLocked
                      return (
                        <SelectItem key={s} value={s} disabled={locked}>
                          {TaskStatusNames[s]}{locked ? ' — needs QA' : ''}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
                {completionLocked && (
                  <p className="text-[11px] text-muted-foreground">
                    QA is required: send it to For Review — the Owner or KPI reviewer completes it.
                  </p>
                )}
              </div>

              {/* self-start: when the Stage column grows a QA hint below its select, the
                  Priority select must stay level with it instead of stretching down. */}
              <div className="grid gap-2 self-start">
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
                <Label htmlFor="task-start">Start date *</Label>
                <Input
                  id="task-start"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => set('startDate', e.target.value)}
                  required
                />
                <p className="text-[11px] text-muted-foreground">Every task records when it starts.</p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="task-due">Due date{task ? '' : ' *'}</Label>
                <Input
                  id="task-due"
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => set('dueDate', e.target.value)}
                  required={!task}
                />
                {!task && (
                  <p className="text-[11px] text-muted-foreground">Required for the on-time KPI.</p>
                )}
              </div>
            </div>

            {canSetQa && (
              <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
                <input
                  id="task-qa-required"
                  type="checkbox"
                  checked={form.qaRequired}
                  onChange={(e) => {
                    setQaTouched(true)
                    set('qaRequired', e.target.checked)
                  }}
                  /* accent-[#0868D9]: brand blue, kept constant on purpose —
                     checkbox accents are tiny and don't need to re-skin with
                     the seasonal theme (same as the sign-in page). */
                  className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-border accent-[#0868D9]"
                />
                <div className="grid gap-0.5">
                  <Label htmlFor="task-qa-required" className="cursor-pointer">
                    QA Required?{' '}
                    <span className="font-semibold">{form.qaRequired ? 'Yes' : 'No'}</span>
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    {form.qaRequired
                      ? 'The worker can’t move this task to Completed — only the Owner or someone with KPI access can, after review.'
                      : 'The worker can move this task to Completed themselves.'}
                  </p>
                  {form.repeats !== 'none' && (
                    <p className="text-[11px] text-muted-foreground">
                      Repeating tasks start without QA — the worker completes each occurrence. Tick Yes
                      here only for a series that needs review.
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="task-est">Estimated hours</Label>
                <Input
                  id="task-est"
                  type="number"
                  min="0"
                  step="0.25"
                  value={form.estimatedHours}
                  onChange={(e) => set('estimatedHours', e.target.value)}
                  placeholder="e.g. 6.5"
                />
                <p className="text-[11px] text-muted-foreground">
                  Drives the schedule-aware workload view on Team KPI.
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="task-repeats">Repeats</Label>
                <Select
                  value={form.repeats}
                  onValueChange={(v) => {
                    const r = v as TaskRepeats
                    // The shelf follows the repeat choice: picking an interval
                    // parks a To-Do card on the Recurring shelf (its template);
                    // un-picking it brings a shelved card back to To Do. Cards
                    // already further along the board are left where they are.
                    setForm((f) => {
                      const wasRecurring = f.repeats !== 'none'
                      const nowRecurring = r !== 'none'
                      return {
                        ...f,
                        repeats: r,
                        status: nowRecurring
                          ? (f.status === 'todo' || f.status === 'recurring' ? 'recurring' : f.status)
                          : (f.status === 'recurring' ? 'todo' : f.status),
                        // QA Required follows the kind of card — unless the box
                        // was ticked by hand, or the interval merely changed
                        // (a series the Owner opted into keeps its Yes).
                        qaRequired:
                          qaTouched || wasRecurring === nowRecurring
                            ? f.qaRequired
                            : nowRecurring
                              ? DEFAULT_RECURRING_QA_REQUIRED
                              : DEFAULT_QA_REQUIRED,
                      }
                    })
                  }}
                >
                  <SelectTrigger id="task-repeats"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{TaskRepeatNames.none}</SelectItem>
                    {TASK_REPEATS.map((r) => (
                      <SelectItem key={r} value={r}>{TaskRepeatNames[r]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Repeating tasks sit on the Recurring shelf — start each occurrence from there in one click.
                </p>
              </div>

              {form.repeats !== 'none' && (
                <div className="grid gap-2">
                  <Label htmlFor="task-repeat-until">Repeats until (optional)</Label>
                  <Input
                    id="task-repeat-until"
                    type="date"
                    value={form.repeatUntil}
                    onChange={(e) => set('repeatUntil', e.target.value)}
                    placeholder="No end"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Once the next due date passes this, “Recreate next” stops.
                  </p>
                </div>
              )}

              {form.status === 'waiting' && (
                <div className="grid gap-2">
                  <Label htmlFor="task-wait">Why is it waiting?</Label>
                  <Select
                    value={form.waitingReason || 'client'}
                    onValueChange={(v) => set('waitingReason', v as WaitingReason)}
                  >
                    <SelectTrigger id="task-wait"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {WAITING_REASONS.map((r) => (
                        <SelectItem key={r} value={r}>{WaitingReasonNames[r]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    Client-caused waits don’t count against the employee.
                  </p>
                </div>
              )}
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

      {canManageClients && <ManageClientsDialog open={clientsOpen} onOpenChange={setClientsOpen} />}
    </Dialog>
  )
}
