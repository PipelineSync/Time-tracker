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
import { Square } from 'lucide-react'

/**
 * Shown when a worker clocks out: confirms the action and lets them attach an
 * optional note to the time entry being created.
 */
export function ClockOutDialog({
  open,
  onOpenChange,
  workedLabel,
  breakLabel,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** Pre-formatted "time worked" summary, e.g. "3h 12m". */
  workedLabel: string
  /** Pre-formatted break summary, e.g. "25m" — shown only when there was a break. */
  breakLabel?: string | null
  onConfirm: (note: string) => Promise<void> | void
}) {
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)

  // Start with an empty note every time the dialog opens.
  useEffect(() => {
    if (open) setNote('')
  }, [open])

  async function handleConfirm() {
    setLoading(true)
    try {
      await onConfirm(note.trim())
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!loading) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clock out?</DialogTitle>
          <DialogDescription>
            You've worked <span className="font-medium text-foreground">{workedLabel}</span>
            {breakLabel ? (
              <> with <span className="font-medium text-foreground">{breakLabel}</span> on break</>
            ) : null}
            . You can leave a note for your admin before clocking out — it's saved on the time entry.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="clock-out-note">Note (optional)</Label>
          <Textarea
            id="clock-out-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What did you work on? Any issues or details for your admin…"
            maxLength={2000}
            rows={4}
            autoFocus
          />
        </div>
        <DialogFooter className="mt-2 gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Keep working
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={loading}
            className="gap-2 bg-[#06245B] hover:bg-[#0a306e] dark:bg-white dark:text-[#06245B] dark:hover:bg-white/90"
          >
            <Square className="h-4 w-4" />
            {loading ? 'Saving…' : 'Clock Out'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
