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
import { useStore } from '@/lib/store'
import type { Meeting } from '@/lib/types'
import { toast } from 'sonner'

interface FormState {
  title: string
  date: string // 'YYYY-MM-DD' (local)
  time: string // 'HH:mm' (local)
  notes: string
}

/** Local date/time parts of a Date, for pre-filling the inputs. */
function localParts(d: Date): { date: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

/**
 * Schedule / edit a meeting: title, when it starts, optional notes. The date
 * and time inputs are the browser's own pickers (the same pattern as the time
 * entry form); they combine into one local instant which is stored as ISO.
 */
export function MeetingFormDialog({
  open,
  onOpenChange,
  meeting,
  defaultDate,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** The meeting being edited, or null when scheduling a new one. */
  meeting: Meeting | null
  /** Pre-selected day (the page's "new meeting for this day" affordance). */
  defaultDate?: Date
}) {
  const { createMeeting, updateMeeting } = useStore()
  const [form, setForm] = useState<FormState>({ title: '', date: '', time: '', notes: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (meeting) {
      const parts = localParts(new Date(meeting.start_time))
      setForm({ title: meeting.title, date: parts.date, time: parts.time, notes: meeting.notes || '' })
    } else {
      // A new meeting defaults to the next full hour today (or the day the
      // caller asked about), which is the common "quick, let's book it" case.
      const seed = defaultDate ?? new Date()
      if (!defaultDate) seed.setHours(seed.getHours() + 1, 0, 0, 0)
      const parts = localParts(seed)
      setForm({ title: '', date: parts.date, time: parts.time, notes: '' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, meeting, defaultDate])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const title = form.title.trim()
    if (!title) {
      toast.error('Give the meeting a title.')
      return
    }
    if (!form.date || !form.time) {
      toast.error('Pick when the meeting starts.')
      return
    }
    // 'YYYY-MM-DD' + 'HH:mm' interpreted in the viewer's own timezone — the
    // same convention the time entry form uses.
    const start = new Date(`${form.date}T${form.time}`)
    if (Number.isNaN(start.getTime())) {
      toast.error('Pick a valid date and time.')
      return
    }
    setSaving(true)
    try {
      if (meeting) {
        const saved = await updateMeeting(meeting.id, {
          title,
          start_time: start.toISOString(),
          notes: form.notes.trim() || null,
        })
        if (!saved) return
        toast.success('Meeting updated.')
      } else {
        const created = await createMeeting({
          title,
          start_time: start.toISOString(),
          notes: form.notes.trim() || null,
        })
        if (!created) return
        toast.success('Meeting scheduled.')
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
            <DialogTitle>{meeting ? 'Edit meeting' : 'New meeting'}</DialogTitle>
            <DialogDescription>
              {meeting ? 'Change the title, when it starts, or its notes.' : 'Put it on the schedule — the team sees it on the Meetings page.'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="meeting-title">Title</Label>
              <Input
                id="meeting-title"
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder="e.g. Weekly team stand-up"
                maxLength={200}
                autoFocus
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="meeting-date">Date</Label>
                <Input
                  id="meeting-date"
                  type="date"
                  value={form.date}
                  onChange={(e) => set('date', e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="meeting-time">Starts at</Label>
                <Input
                  id="meeting-time"
                  type="time"
                  value={form.time}
                  onChange={(e) => set('time', e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="meeting-notes">Notes (optional)</Label>
              <Textarea
                id="meeting-notes"
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
                placeholder="Agenda, links, anything worth remembering…"
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : meeting ? 'Save changes' : 'Schedule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
