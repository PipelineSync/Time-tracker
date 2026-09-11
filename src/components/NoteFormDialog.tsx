import { useEffect, useState } from 'react'
import { Pin } from 'lucide-react'
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
import type { Note, NoteColor } from '@/lib/types'
import { DEFAULT_NOTE_COLOR, NOTE_COLORS, NoteColorStyles } from '@/lib/types'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

interface FormState {
  title: string
  body: string
  color: NoteColor
  pinned: boolean
}

/**
 * Create / edit a notepad note: a title and a free-text body, an optional
 * colour tint and a pin. The note is the signed-in user's own — the dialog
 * never touches anyone else's notepad because the store and backend do not
 * let it.
 */
export function NoteFormDialog({
  open,
  onOpenChange,
  note,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** The note being edited, or null when writing a new one. */
  note: Note | null
}) {
  const { createNote, updateNote } = useStore()
  const [form, setForm] = useState<FormState>({ title: '', body: '', color: DEFAULT_NOTE_COLOR, pinned: false })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (note) {
      setForm({ title: note.title, body: note.body, color: note.color, pinned: note.pinned })
    } else {
      setForm({ title: '', body: '', color: DEFAULT_NOTE_COLOR, pinned: false })
    }
  }, [open, note])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim() && !form.body.trim()) {
      toast.error('Write something in the note first.')
      return
    }
    setSaving(true)
    try {
      const saved = note
        ? await updateNote(note.id, { title: form.title, body: form.body, color: form.color, pinned: form.pinned })
        : await createNote({ title: form.title, body: form.body, color: form.color, pinned: form.pinned })
      if (saved) onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const tint = NoteColorStyles[form.color].card

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-lg', tint)}>
        <DialogHeader>
          <DialogTitle>{note ? 'Edit note' : 'New note'}</DialogTitle>
          <DialogDescription>
            {note ? 'Change the note — only you can see it.' : 'Jot something down. Your notepad is private: only you can see it.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="note-title">Title</Label>
            <Input
              id="note-title"
              value={form.title}
              maxLength={200}
              placeholder="Title (optional)"
              autoFocus={!note}
              onChange={(e) => set('title', e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="note-body">Note</Label>
            <Textarea
              id="note-body"
              value={form.body}
              maxLength={10000}
              rows={8}
              placeholder="Write your note…"
              autoFocus={!!note}
              className="resize-y whitespace-pre-line"
              onChange={(e) => set('body', e.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Note colour">
              {NOTE_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={form.color === color}
                  aria-label={`${NoteColorStyles[color].label} colour`}
                  title={NoteColorStyles[color].label}
                  onClick={() => set('color', color)}
                  className={cn(
                    'h-7 w-7 rounded-full border transition hover:scale-110',
                    NoteColorStyles[color].swatch,
                    form.color === color ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : 'opacity-70',
                  )}
                />
              ))}
            </div>

            <Button
              type="button"
              variant={form.pinned ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={form.pinned}
              onClick={() => set('pinned', !form.pinned)}
            >
              <Pin className={cn('mr-2 h-4 w-4', form.pinned && 'fill-current')} />
              {form.pinned ? 'Pinned' : 'Pin to top'}
            </Button>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : note ? 'Save changes' : 'Add note'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
