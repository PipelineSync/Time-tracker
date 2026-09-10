import { useEffect, useState } from 'react'
import type { TimeEntry } from '@/lib/types'
import { useStore } from '@/lib/store'
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
import { toast } from 'sonner'
import { computeEarnings, computeTotalMinutes, formatMinutes } from '@/lib/utils'
import { money } from '@/lib/utils'

interface FormState {
  workerId: string
  date: string
  startTime: string
  endTime: string
  breakMin: string
  /** Which client the time is booked to (replaces the old free-text project). */
  clientId: string
  notes: string
  rate: string
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function timeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function EntryFormDialog({
  open,
  onOpenChange,
  entry,
  defaultWorkerId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  entry: TimeEntry | null
  defaultWorkerId?: string
}) {
  const { workers, activeClients, createEntry, updateEntry, settings } = useStore()
  const activeWorkers = workers.filter((w) => w.status === 'active')
  const pickable = activeWorkers.length > 0 ? activeWorkers : workers
  const noClients = activeClients.length === 0
  const [clientsOpen, setClientsOpen] = useState(false)

  const [form, setForm] = useState<FormState>({
    workerId: '',
    date: toLocalInput(new Date()),
    startTime: '09:00',
    endTime: '17:00',
    breakMin: '0',
    clientId: '',
    notes: '',
    rate: '20',
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      if (entry) {
        const start = new Date(entry.start_time)
        const end = new Date(entry.end_time)
        setForm({
          workerId: entry.worker_id,
          date: toLocalInput(start),
          startTime: timeInput(start),
          endTime: timeInput(end),
          breakMin: String(entry.break_minutes),
          clientId: entry.client_id || '',
          notes: entry.notes || '',
          rate: String(entry.hourly_rate),
        })
      } else {
        const workerId = defaultWorkerId || (pickable[0]?.id || '')
        const w = workers.find((x) => x.id === workerId)
        setForm({
          workerId,
          date: toLocalInput(new Date()),
          startTime: '09:00',
          endTime: '17:00',
          breakMin: '0',
          // One client on the list is not a choice — pre-pick it.
          clientId: activeClients.length === 1 ? activeClients[0].id : '',
          notes: '',
          rate: String(w?.hourly_rate ?? settings?.default_hourly_rate ?? 20),
        })
      }
    }
  }, [open, entry, defaultWorkerId]) // eslint-disable-line react-hooks/exhaustive-deps


  function set(key: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function handleWorkerChange(id: string) {
    const w = workers.find((x) => x.id === id)
    // The client stays as picked — it describes the work, not the worker.
    setForm((f) => ({ ...f, workerId: id, rate: String(w?.hourly_rate ?? f.rate) }))
  }

  const totalMinutes = (() => {
    if (!form.date || !form.startTime || !form.endTime) return 0
    const start = new Date(`${form.date}T${form.startTime}`)
    const end = new Date(`${form.date}T${form.endTime}`)
    const brk = parseInt(form.breakMin || '0', 10) || 0
    return computeTotalMinutes(start, end, brk)
  })()

  const rateNum = parseFloat(form.rate) || 0
  const earnings = computeEarnings(totalMinutes, rateNum)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.workerId) {
      toast.error('Please select a worker.')
      return
    }
    const start = new Date(`${form.date}T${form.startTime}`)
    const end = new Date(`${form.date}T${form.endTime}`)
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      toast.error('Please enter a valid start and end time.')
      return
    }
    const brk = parseInt(form.breakMin || '0', 10) || 0
    const computed = computeTotalMinutes(start, end, brk)
    if (computed <= 0) {
      toast.error('End time must be after start time (or cross midnight).')
      return
    }
    if (brk < 0) {
      toast.error('Break cannot be negative.')
      return
    }
    if (brk > computed + brk) {
      toast.error('Break cannot be longer than the total work duration.')
      return
    }
    if (!form.clientId && !noClients) {
      toast.error('Choose the client this time was worked for.')
      return
    }
    setSaving(true)
    const payload = {
      worker_id: form.workerId,
      client_id: form.clientId || null,
      // Legacy free-text scope: preserved on entries that already have one,
      // never set on new ones (the client replaced it).
      project: entry?.project ?? null,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      break_minutes: brk,
      notes: form.notes.trim() || null,
      hourly_rate: rateNum,
      total_minutes: computed,
      earnings,
    }
    if (entry) {
      const res = await updateEntry(entry.id, payload)
      if (!res) toast.error('Failed to update entry.')
      else toast.success('Entry updated.')
    } else {
      const res = await createEntry(payload)
      if (!res) toast.error('Failed to create entry.')
      else toast.success('Entry added.')
    }
    setSaving(false)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{entry ? 'Edit entry' : 'Manual time entry'}</DialogTitle>
          <DialogDescription>Record work time for a worker.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="e-worker">Worker *</Label>
            <Select value={form.workerId} onValueChange={handleWorkerChange}>
              <SelectTrigger id="e-worker"><SelectValue placeholder="Select a worker" /></SelectTrigger>
              <SelectContent>
                {pickable.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="e-date">Date *</Label>
            <Input id="e-date" type="date" value={form.date} onChange={(e) => set('date', e.target.value)} required />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="e-start">Start time *</Label>
              <Input id="e-start" type="time" value={form.startTime} onChange={(e) => set('startTime', e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="e-end">End time *</Label>
              <Input id="e-end" type="time" value={form.endTime} onChange={(e) => set('endTime', e.target.value)} required />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="e-break">Break (minutes)</Label>
              <Input id="e-break" type="number" min="0" step="1" value={form.breakMin} onChange={(e) => set('breakMin', e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="e-rate">Hourly rate *</Label>
              <Input id="e-rate" type="number" min="0" step="0.01" value={form.rate} onChange={(e) => set('rate', e.target.value)} required />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="e-client">Client</Label>
              <button
                type="button"
                onClick={() => setClientsOpen(true)}
                className="text-xs font-medium text-primary underline-offset-2 hover:underline"
              >
                Manage clients
              </button>
            </div>
            <ClientSelect
              id="e-client"
              value={form.clientId}
              onValueChange={(v) => set('clientId', v)}
              disabled={noClients}
              placeholder={noClients ? 'No active clients yet' : 'Choose a client'}
            />
            {noClients && (
              <p className="text-xs text-muted-foreground">Add a client first — time is booked against one.</p>
            )}
            {entry?.project && (
              <p className="text-xs text-muted-foreground">
                Logged before clients existed as “{entry.project}”.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="e-notes">Notes</Label>
            <Textarea id="e-notes" value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Optional notes about this session" />
          </div>

          <div className="rounded-lg bg-muted p-4 text-sm">
            <div className="flex justify-between py-0.5"><span className="text-muted-foreground">Total hours</span><span className="font-semibold">{formatMinutes(totalMinutes)}</span></div>
            <div className="flex justify-between py-0.5"><span className="text-muted-foreground">Rate</span><span className="font-semibold">{money(rateNum, settings?.currency || 'USD')}/hr</span></div>
            <div className="mt-1 flex justify-between border-t pt-1.5"><span className="text-muted-foreground">Earnings</span><span className="font-semibold">{money(earnings, settings?.currency || 'USD')}</span></div>
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : entry ? 'Save changes' : 'Save entry'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>

      <ManageClientsDialog open={clientsOpen} onOpenChange={setClientsOpen} />
    </Dialog>
  )
}
