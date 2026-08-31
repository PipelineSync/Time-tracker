import { useEffect, useMemo, useState } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { formatMinutes, money } from '@/lib/utils'
import type { Worker } from '@/lib/types'

export function SettleWorkerDialog({
  worker,
  open,
  onOpenChange,
}: {
  worker: Worker
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { entries, settings, settleWorker } = useStore()
  const currency = settings?.currency || 'USD'
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const stats = useMemo(() => {
    let minutes = 0
    let earnings = 0
    let count = 0
    for (const e of entries) {
      if (e.worker_id === worker.id) {
        minutes += e.total_minutes
        earnings += e.earnings
        count++
      }
    }
    return { minutes, earnings, count }
  }, [entries, worker.id])

  useEffect(() => {
    if (open) setNote('')
  }, [open])

  async function handleSettle() {
    if (stats.count === 0) {
      toast.error('This worker has no tracked time to settle.')
      return
    }
    setSaving(true)
    const payment = await settleWorker(worker.id, note.trim() || undefined)
    setSaving(false)
    if (!payment) {
      toast.error('Failed to settle.')
      return
    }
    toast.success(`Settled ${formatMinutes(payment.hours * 60)} · ${money(payment.amount, currency)}. Payment created as unpaid.`)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset & settle {worker.name}</DialogTitle>
          <DialogDescription>
            This creates an <b>unpaid</b> payment from the worker's current tracked time, then resets their time & earnings to zero.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg bg-muted p-4 text-sm">
          <div className="flex justify-between py-0.5"><span className="text-muted-foreground">Tracked hours</span><span className="font-semibold">{formatMinutes(stats.minutes)}</span></div>
          <div className="flex justify-between py-0.5"><span className="text-muted-foreground">Total earnings</span><span className="font-semibold">{money(stats.earnings, currency)}</span></div>
          <div className="flex justify-between py-0.5"><span className="text-muted-foreground">Time entries</span><span>{stats.count}</span></div>
          {stats.count === 0 && <p className="mt-2 text-xs text-destructive">No tracked time for this worker.</p>}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Note (optional)</label>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Weekly settlement" className="min-h-[64px]" />
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSettle} disabled={saving || stats.count === 0}>
            {saving ? 'Settling…' : 'Settle & Reset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
