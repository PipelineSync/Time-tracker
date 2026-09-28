import { useEffect, useState } from 'react'
import { CheckCircle2, Star } from 'lucide-react'
import { useStore } from '@/lib/store'
import type { QaScore, Task } from '@/lib/types'
import { QA_SCORE_NAMES } from '@/lib/types'
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
import { Badge } from '@/components/ui/badge'
import { cn, formatDate } from '@/lib/utils'
import { toast } from 'sonner'

/**
 * QA review dialog: the Owner/PM scores a card that reached For Review.
 * Submitting a review completes the task; tasks are no longer sent back to a
 * separate Rework stage. Existing QA classifications remain available to KPI
 * reporting for historical records.
 */
export function QaReviewDialog({
  open,
  onOpenChange,
  task,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  task: Task | null
}) {
  const { updateTask, workers, clients } = useStore()
  const [score, setScore] = useState<QaScore | ''>('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  // Fresh state per task: reopening the dialog must not keep the last review.
  useEffect(() => {
    if (!open) return
    setScore('')
    setNotes(task?.rework_notes ?? '')
  }, [open, task])

  if (!task) return null

  const assignee = workers.find((w) => w.id === task.worker_id)?.name ?? 'the assignee'
  const client = clients.find((c) => c.id === task.client_id)?.name ?? null

  async function submit() {
    if (score === '') {
      toast.error('Pick a QA score first (5 = excellent … 1 = major correction).')
      return
    }
    setSaving(true)
    try {
      const saved = await updateTask(task!.id, {
        qa_score: score,
        rework_required: false,
        rework_type: null,
        rework_notes: notes.trim() || null,
        status: 'completed',
      })
      if (!saved) return
      toast.success(`Reviewed & completed — QA ${score}/5 recorded.`)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="space-y-1 border-b px-5 py-4 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2">
            Review task
            <Badge variant="muted" className="text-[10px]">For Review</Badge>
          </DialogTitle>
          <DialogDescription>
            QA for “{task.title}” — assigned to {assignee}
            {client ? ` · ${client}` : ''}
            {task.start_date ? ` · started ${formatDate(task.start_date)}` : ''}
            {task.due_date ? ` · due ${formatDate(task.due_date)}` : ' · legacy (no due date)'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="space-y-2">
            <Label>QA score *</Label>
            <div className="grid grid-cols-5 gap-1.5">
              {([5, 4, 3, 2, 1] as QaScore[]).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setScore(n)}
                  title={QA_SCORE_NAMES[n]}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-xl border px-1 py-2.5 text-center transition',
                    score === n
                      ? 'border-primary bg-primary/10 ring-2 ring-primary/40'
                      : 'hover:border-primary/40 hover:bg-muted/60'
                  )}
                >
                  <span className="flex items-center gap-0.5 text-sm font-bold tabular-nums">
                    {n}
                    <Star className={cn('h-3 w-3', score === n && n >= 4 ? 'fill-current text-amber-500' : 'text-muted-foreground/50')} />
                  </span>
                  <span className="text-[9px] leading-tight text-muted-foreground">
                    {n === 5 ? 'Excellent' : n === 4 ? 'Good' : n === 3 ? 'Acceptable' : n === 2 ? 'Significant' : 'Major'}
                  </span>
                </button>
              ))}
            </div>
            {score !== '' && (
              <p className="text-xs text-muted-foreground">{QA_SCORE_NAMES[score]}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="qa-notes">QA notes (optional)</Label>
            <Textarea
              id="qa-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add any feedback worth keeping with this review…"
              rows={3}
            />
          </div>
          <p className="text-xs text-muted-foreground">Submitting the QA score marks this task as Completed.</p>
        </div>

        <DialogFooter className="gap-2 border-t bg-background px-5 py-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={saving}>
            <CheckCircle2 className="mr-1.5 h-4 w-4" />
            {saving ? 'Saving…' : 'Save review & complete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
