import { useEffect, useState } from 'react'
import { CheckCircle2, RotateCcw, Star } from 'lucide-react'
import { useStore } from '@/lib/store'
import type { QaScore, ReworkType, Task } from '@/lib/types'
import { QA_SCORE_NAMES, REWORK_TYPES, ReworkTypeNames, isEmployeeCausedRework } from '@/lib/types'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { cn, formatDate } from '@/lib/utils'
import { toast } from 'sonner'

/** The two employee-caused reasons kept separate from the "not their fault" group. */
const EMPLOYEE_REWORKS = REWORK_TYPES.filter((r) => isEmployeeCausedRework(r))
const EXTERNAL_REWORKS = REWORK_TYPES.filter((r) => !isEmployeeCausedRework(r))

/**
 * QA review dialog (§10): the Owner/PM scores a card that reached For Review.
 * Accept → Completed with the score recorded; Send back → Rework with a
 * classification (employee-caused vs not — only the former counts against the
 * employee's KPI) and notes for what to fix.
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
  const [decision, setDecision] = useState<'accept' | 'rework'>('accept')
  const [reworkType, setReworkType] = useState<ReworkType | ''>('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  // Fresh state per task: reopening the dialog must not keep the last review.
  useEffect(() => {
    if (!open) return
    setScore('')
    setDecision('accept')
    setReworkType('')
    setNotes(task?.rework_notes ?? '')
  }, [open, task])

  if (!task) return null

  const assignee = workers.find((w) => w.id === task.worker_id)?.name ?? 'the assignee'
  const client = clients.find((c) => c.id === task.client_id)?.name ?? null
  const external = decision === 'rework' && reworkType !== '' && !isEmployeeCausedRework(reworkType)

  async function submit(next: 'completed' | 'rework') {
    if (score === '') {
      toast.error('Pick a QA score first (5 = excellent … 1 = major rework).')
      return
    }
    if (next === 'rework' && reworkType === '') {
      toast.error('Choose why the work is going back — it decides whether it counts against the employee.')
      return
    }
    setSaving(true)
    try {
      const saved = await updateTask(task!.id, {
        qa_score: score as QaScore,
        rework_required: next === 'rework',
        rework_type: next === 'rework' ? (reworkType as ReworkType) : null,
        rework_notes: notes.trim() || null,
        status: next,
      })
      if (!saved) return
      toast.success(
        next === 'completed'
          ? `Reviewed & accepted — QA ${score}/5 recorded.`
          : `Sent back to Rework — ${ReworkTypeNames[reworkType as ReworkType].toLowerCase()}.`,
      )
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
            {task.due_date ? ` · due ${formatDate(task.due_date)}` : ' · legacy (no due date)'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* QA score: 5 → 1 with the scale's wording right on the option. */}
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

          {/* Decision: accept or send back. */}
          <div className="space-y-2">
            <Label>Decision</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={decision === 'accept' ? 'default' : 'outline'}
                onClick={() => setDecision('accept')}
                className="gap-1.5"
              >
                <CheckCircle2 className="h-4 w-4" /> Accept → Completed
              </Button>
              <Button
                type="button"
                variant={decision === 'rework' ? 'destructive' : 'outline'}
                onClick={() => setDecision('rework')}
                className="gap-1.5"
              >
                <RotateCcw className="h-4 w-4" /> Send back → Rework
              </Button>
            </div>
          </div>

          {decision === 'rework' && (
            <>
              <div className="space-y-2">
                <Label htmlFor="qa-rework-type">Rework type *</Label>
                <Select value={reworkType} onValueChange={(v) => setReworkType(v as ReworkType)}>
                  <SelectTrigger id="qa-rework-type">
                    <SelectValue placeholder="Why is it going back?" />
                  </SelectTrigger>
                  <SelectContent>
                    <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Counts against the employee
                    </div>
                    {EMPLOYEE_REWORKS.map((r) => (
                      <SelectItem key={r} value={r}>{ReworkTypeNames[r]}</SelectItem>
                    ))}
                    <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Does not count against the employee
                    </div>
                    {EXTERNAL_REWORKS.map((r) => (
                      <SelectItem key={r} value={r}>{ReworkTypeNames[r]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {external && (
                  <p className="text-xs text-emerald-700 dark:text-emerald-300">
                    This reason is outside the employee’s control — it will not lower their KPI.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="qa-notes">What needs fixing?</Label>
                <Textarea
                  id="qa-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Concrete corrections for the employee…"
                  rows={3}
                />
              </div>
            </>
          )}
        </div>

        <DialogFooter className="gap-2 border-t bg-background px-5 py-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          {decision === 'accept' ? (
            <Button type="button" onClick={() => void submit('completed')} disabled={saving}>
              {saving ? 'Saving…' : 'Accept & complete'}
            </Button>
          ) : (
            <Button type="button" variant="destructive" onClick={() => void submit('rework')} disabled={saving}>
              {saving ? 'Saving…' : 'Send to rework'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
