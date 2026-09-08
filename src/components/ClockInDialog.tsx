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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { LogIn } from 'lucide-react'
import { useStore } from '@/lib/store'
import { ClientSelect } from '@/components/ClientSelect'

/**
 * Shown when a worker clocks in: they pick the client they are working for and
 * can leave a note. Both are stored on the running timer and carried over to
 * the time entry when they clock out, so every hour is attributed.
 *
 * The client is pre-filled with the one from their last shift (or the only
 * active client), so the common case is still just "Clock In".
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
  onConfirm: (input: { clientId: string; notes: string }) => Promise<void> | void
}) {
  const { activeClients } = useStore()
  const [clientId, setClientId] = useState('')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)

  const noClients = activeClients.length === 0

  // Every time the dialog opens, start from the worker's usual client (their
  // last shift, or the only one there is) and a clean note.
  useEffect(() => {
    if (!open) return
    const stillActive = activeClients.some((c) => c.id === defaultClientId)
    setClientId(stillActive ? defaultClientId! : activeClients.length === 1 ? activeClients[0].id : '')
    setNotes('')
  }, [open, defaultClientId, activeClients])

  async function handleConfirm() {
    setLoading(true)
    try {
      await onConfirm({ clientId, notes: notes.trim() })
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
            Pick who you're working for. The client and note are saved on this shift and appear on the
            time entry when you clock out.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="clock-in-client">Client</Label>
            <ClientSelect
              id="clock-in-client"
              value={clientId}
              onValueChange={setClientId}
              disabled={noClients}
              placeholder={noClients ? 'No active clients yet' : 'Choose a client'}
            />
            {noClients && (
              <p className="text-xs text-muted-foreground">
                Your admin hasn't added any clients yet — you can still clock in, and they can tag this
                shift later.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="clock-in-note">Note (optional)</Label>
            <Textarea
              id="clock-in-note"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What are you starting on? Anything your admin should know…"
              maxLength={2000}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter className="mt-2 gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={loading || (!clientId && !noClients)}
            title={!clientId && !noClients ? 'Choose a client first' : undefined}
            className="gap-2 bg-[#06245B] hover:bg-[#0a306e] dark:bg-white dark:text-[#06245B] dark:hover:bg-white/90"
          >
            <LogIn className="h-4 w-4" />
            {loading ? 'Clocking in…' : 'Clock In'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
