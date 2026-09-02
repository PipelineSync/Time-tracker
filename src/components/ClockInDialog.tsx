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

/**
 * Shown when a worker clocks in: lets them say which project/task they are
 * starting and leave a note. Both are stored on the running timer and carried
 * over to the time entry when they clock out.
 */
export function ClockInDialog({
  open,
  onOpenChange,
  workerName,
  /** Projects already used by this workspace — offered as quick suggestions. */
  projectSuggestions = [],
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  workerName?: string | null
  projectSuggestions?: string[]
  onConfirm: (input: { project: string; notes: string }) => Promise<void> | void
}) {
  const [project, setProject] = useState('')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)

  // Start from a clean slate every time the dialog opens.
  useEffect(() => {
    if (open) {
      setProject('')
      setNotes('')
    }
  }, [open])

  async function handleConfirm() {
    setLoading(true)
    try {
      await onConfirm({ project: project.trim(), notes: notes.trim() })
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
            Tell your admin what you're working on. The project/task and note are saved on this
            shift and appear on the time entry when you clock out.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="clock-in-project">Project / task</Label>
            <Input
              id="clock-in-project"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="e.g. Website redesign"
              maxLength={120}
              list="clock-in-project-suggestions"
              autoFocus
            />
            {projectSuggestions.length > 0 && (
              <>
                <datalist id="clock-in-project-suggestions">
                  {projectSuggestions.map((p) => <option key={p} value={p} />)}
                </datalist>
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {projectSuggestions.slice(0, 5).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setProject(p)}
                      className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </>
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
            disabled={loading}
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
