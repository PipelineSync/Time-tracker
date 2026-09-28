import { BRAND_ACTION_BUTTON } from '@/lib/brand'
import { useEffect, useState } from 'react'
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
import { LogIn } from 'lucide-react'
import { useStore } from '@/lib/store'
import { ClientSelect } from '@/components/ClientSelect'
import { todayISO } from '@/lib/utils'

/** The task created from a clock-in / client switch — null when skipped. */
export interface ShiftTaskInput {
  title: string
  description: string
  dueDate: string
}

/**
 * Shown when a worker clocks in: they must pick the client they are working
 * for (every hour is attributed to a client) and can name the task they are
 * starting on — title + due date, with optional details. Confirming creates
 * that task on the worker's board (In Progress, for the chosen client);
 * "Skip — set up later" clocks in without a task and they can add one from
 * the board any time.
 *
 * The client is pre-filled with the one from their last shift (or the only
 * active one), and the due date with today, so the common case is still just
 * "Clock In". A worker cannot clock in without a client — the buttons stay
 * disabled until one is chosen, and if the workspace has no active clients
 * at all the dialog tells the worker to ask the admin to add one before they
 * can clock in.
 */
export function ClockInDialog({
  open,
  onOpenChange,
  workerName,
  /** Client to start from — usually the one from this worker's last shift. */
  defaultClientId,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  workerName?: string | null
  defaultClientId?: string | null
  onConfirm: (input: { clientId: string; task: ShiftTaskInput | null }) => Promise<void> | void
}) {
  const { activeClients } = useStore()
  const [clientId, setClientId] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDescription, setTaskDescription] = useState('')
  const [taskDueDate, setTaskDueDate] = useState('')
  const [loading, setLoading] = useState(false)

  const noClients = activeClients.length === 0

  // Every time the dialog opens, start from the worker's usual client (their
  // last shift, or the only one there is), clean task fields and today as
  // the due date.
  useEffect(() => {
    if (!open) return
    const stillActive = activeClients.some((c) => c.id === defaultClientId)
    setClientId(stillActive ? defaultClientId! : activeClients.length === 1 ? activeClients[0].id : '')
    setTaskTitle('')
    setTaskDescription('')
    setTaskDueDate(todayISO())
  }, [open, defaultClientId, activeClients])

  // Confirming needs the task filled in; skipping only needs the client.
  const taskReady = Boolean(taskTitle.trim() && taskDueDate)
  const ready = Boolean(clientId) && taskReady

  async function handleConfirm(withTask: boolean) {
    // Hard guard — the buttons are already disabled without their required
    // fields, but never let a clock-in proceed without the client.
    if (!clientId || (withTask && !taskReady)) return
    setLoading(true)
    try {
      await onConfirm({
        clientId,
        task: withTask
          ? { title: taskTitle.trim(), description: taskDescription.trim(), dueDate: taskDueDate }
          : null,
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!loading) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clock in{workerName ? `, ${workerName}` : ''}?</DialogTitle>
          <DialogDescription>
            {noClients
              ? 'A client is required to clock in. Ask your admin to add one, then try again.'
              : "Pick who you're working for and what you're starting on — a task is created on your board for this shift, already In Progress. Not sure yet? Skip it and set the task up later."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="clock-in-client">
              Client <span className="text-destructive" aria-hidden>*</span>
            </Label>
            <ClientSelect
              id="clock-in-client"
              value={clientId}
              onValueChange={setClientId}
              disabled={noClients}
              placeholder={noClients ? 'No active clients yet' : 'Choose a client'}
            />
            {noClients && (
              <p className="text-xs text-muted-foreground">
                Your admin hasn't added any clients yet. Once they add at least one, you can clock in.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="clock-in-task">
              What are you starting on? <span className="text-destructive" aria-hidden>*</span>
            </Label>
            <Input
              id="clock-in-task"
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              placeholder="e.g. Replace the pump seal"
              maxLength={200}
              disabled={noClients}
            />
            <Textarea
              id="clock-in-details"
              value={taskDescription}
              onChange={(e) => setTaskDescription(e.target.value)}
              placeholder="Details (optional) — anything worth remembering about this task…"
              maxLength={2000}
              rows={2}
              className="mt-2"
              disabled={noClients}
            />
            <p className="text-[11px] text-muted-foreground">
              Becomes a task on your board for the chosen client — In Progress from today.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="clock-in-due">
              Due date <span className="text-destructive" aria-hidden>*</span>
            </Label>
            <Input
              id="clock-in-due"
              type="date"
              value={taskDueDate}
              onChange={(e) => setTaskDueDate(e.target.value)}
              required
              disabled={noClients}
            />
          </div>
        </div>

        <DialogFooter className="mt-2 gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleConfirm(false)}
            disabled={loading || !clientId || noClients}
            title="Clock in without a task — add one from your board any time"
          >
            Skip — set up later
          </Button>
          <Button
            onClick={() => void handleConfirm(true)}
            disabled={loading || !ready || noClients}
            title={!ready ? 'Choose a client, name the task and pick a due date — or skip the task' : undefined}
            className={`gap-2 ${BRAND_ACTION_BUTTON}`}
          >
            <LogIn className="h-4 w-4" />
            {loading ? 'Clocking in…' : 'Clock In'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
