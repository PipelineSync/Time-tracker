import { BRAND_ACTION_BUTTON } from '@/lib/brand'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { Repeat } from 'lucide-react'
import { useStore } from '@/lib/store'
import { ClientSelect } from '@/components/ClientSelect'
import { todayISO } from '@/lib/utils'
import type { ShiftTaskInput } from '@/components/ClockInDialog'

/**
 * Shown while a worker is on the clock so they can move to a different client
 * without clocking out. The time already worked is split into a finished entry
 * for the previous client (so each client is billed correctly), while the
 * on-screen shift clock keeps counting — it does not reset. Only ACTIVE
 * clients (other than the one they're currently on) are offered.
 *
 * Like clocking in, the worker can name the task they are moving on to
 * (title + due date, optional details) — confirming creates it on their board
 * for the newly chosen client, In Progress. "Skip — set up later" switches
 * without a task; the shift itself keeps no note.
 */
export function SwitchClientDialog({
  open,
  onOpenChange,
  workerName,
  /** The client the worker is currently on (shown for context, not selectable). */
  currentClientId,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  workerName?: string | null
  currentClientId?: string | null
  onConfirm: (input: { clientId: string; task: ShiftTaskInput | null }) => Promise<void> | void
}) {
  const { clients, activeClients } = useStore()
  const [clientId, setClientId] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDescription, setTaskDescription] = useState('')
  const [taskDueDate, setTaskDueDate] = useState('')
  const [loading, setLoading] = useState(false)

  const currentClientName = clients.find((c) => c.id === currentClientId)?.name || null
  // Other active clients to switch to (not the one already being worked on).
  const others = useMemo(() => activeClients.filter((c) => c.id !== currentClientId), [activeClients, currentClientId])
  const noOtherClients = others.length === 0
  const openingOptions = useRef({ others })
  useEffect(() => {
    openingOptions.current = { others }
  }, [others])

  // Initialize once per opening. Updating store data must not restart the form
  // or erase task text while the dialog remains open.
  useEffect(() => {
    if (!open) return
    const availableClients = openingOptions.current.others
    setClientId(availableClients.length === 1 ? availableClients[0].id : '')
    setTaskTitle('')
    setTaskDescription('')
    setTaskDueDate(todayISO())
  }, [open])

  // Confirming needs the task filled in; skipping only needs the client.
  const taskReady = Boolean(taskTitle.trim() && taskDueDate)
  const ready = Boolean(clientId) && taskReady

  async function handleConfirm(withTask: boolean) {
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
          <DialogTitle>Switch client{workerName ? `, ${workerName}` : ''}?</DialogTitle>
          <DialogDescription>
            {currentClientName
              ? `You're currently on ${currentClientName}. Switching keeps your clock running (it will not reset) — the time you've already worked stays with ${currentClientName}, and new time is allocated to the client you pick below.`
              : 'Switching keeps your clock running (it will not reset). Pick the client to move to — time already worked stays with the previous client.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="switch-client">
              Switch to client <span className="text-destructive" aria-hidden>*</span>
            </Label>
            <ClientSelect
              id="switch-client"
              value={clientId}
              onValueChange={setClientId}
              disabled={noOtherClients}
              excludeId={currentClientId || undefined}
              placeholder={noOtherClients ? 'No other active clients' : 'Choose a client'}
            />
            {noOtherClients && (
              <p className="text-xs text-muted-foreground">
                There are no other active clients to switch to. Your admin has to add one first.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="switch-task">
              What are you moving on to? <span className="text-destructive" aria-hidden>*</span>
            </Label>
            <Input
              id="switch-task"
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              placeholder="e.g. Monthly report for the new client"
              maxLength={200}
              disabled={noOtherClients}
            />
            <Textarea
              id="switch-details"
              value={taskDescription}
              onChange={(e) => setTaskDescription(e.target.value)}
              placeholder="Details (optional) — anything worth remembering about this task…"
              maxLength={2000}
              rows={2}
              className="mt-2"
              disabled={noOtherClients}
            />
            <p className="text-[11px] text-muted-foreground">
              Becomes a task on your board for the chosen client — In Progress from today.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="switch-due">
              Due date <span className="text-destructive" aria-hidden>*</span>
            </Label>
            <Input
              id="switch-due"
              type="date"
              value={taskDueDate}
              onChange={(e) => setTaskDueDate(e.target.value)}
              required
              disabled={noOtherClients}
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
            disabled={loading || !clientId || noOtherClients}
            title="Switch without a task — add one from your board any time"
          >
            Skip — set up later
          </Button>
          <Button
            onClick={() => void handleConfirm(true)}
            disabled={loading || !ready || noOtherClients}
            title={!ready ? 'Choose a client, name the task and pick a due date — or skip the task' : undefined}
            className={`gap-2 ${BRAND_ACTION_BUTTON}`}
          >
            <Repeat className="h-4 w-4" />
            {loading ? 'Switching…' : 'Switch client'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
