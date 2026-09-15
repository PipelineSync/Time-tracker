import { useEffect, useRef, useState } from 'react'
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
import { Paperclip, Send, Ticket as TicketIcon, X } from 'lucide-react'
import { toast } from 'sonner'
import { imageFileToDataUrl, validateImageFile } from '@/lib/image'
import {
  MAX_TICKET_ATTACHMENTS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  ticketRef,
} from '@/lib/tickets'
import type { Ticket, TicketCategory, TicketPriority } from '@/lib/types'

/**
 * **Submit a Ticket** — the way in for everyone.
 *
 * Open to every signed-in account: a plain worker, the admin, or IT Support
 * itself (raising one on someone's behalf). Submitting does **not** grant access
 * to the queue — the ticket goes to whoever holds IT Support, and the requester
 * hears back through the notification bell.
 */
export function TicketFormDialog({
  open,
  onOpenChange,
  onSubmitted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmitted?: (ticket: Ticket) => void
}) {
  const { submitTicket } = useStore()
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<TicketCategory>('hardware')
  const [priority, setPriority] = useState<TicketPriority>('medium')
  const [attachments, setAttachments] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // A fresh form every time it is opened — a half-written ticket from last
  // time reappearing would be worse than retyping it.
  useEffect(() => {
    if (!open) return
    setSubject('')
    setDescription('')
    setCategory('hardware')
    setPriority('medium')
    setAttachments([])
    setSubmitting(false)
  }, [open])

  /** Screenshots are downscaled before they are stored (see lib/image). */
  async function onPickAttachments(files: FileList | null) {
    if (!files || files.length === 0) return
    const room = MAX_TICKET_ATTACHMENTS - attachments.length
    if (room <= 0) {
      toast.error(`A ticket can carry up to ${MAX_TICKET_ATTACHMENTS} images.`)
      return
    }
    const picked = Array.from(files).slice(0, room)
    const next: string[] = []
    for (const file of picked) {
      const err = validateImageFile(file)
      if (err) {
        toast.error(err)
        continue
      }
      try {
        next.push(await imageFileToDataUrl(file, 1000))
      } catch {
        toast.error(`Could not read “${file.name}”.`)
      }
    }
    if (next.length > 0) setAttachments((prev) => [...prev, ...next].slice(0, MAX_TICKET_ATTACHMENTS))
  }

  async function submit() {
    if (!subject.trim()) {
      toast.error('Give the ticket a subject.')
      return
    }
    if (!description.trim()) {
      toast.error('Describe what is going wrong.')
      return
    }
    setSubmitting(true)
    const ticket = await submitTicket({
      subject: subject.trim(),
      description: description.trim(),
      category,
      priority,
      attachments,
    })
    setSubmitting(false)
    if (!ticket) return
    toast.success(`Ticket ${ticketRef(ticket)} submitted — IT Support has been notified.`, { duration: 6000 })
    onOpenChange(false)
    onSubmitted?.(ticket)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TicketIcon className="h-4 w-4" /> Submit a Ticket
          </DialogTitle>
          <DialogDescription>
            Tell IT Support what is wrong. They see every ticket submitted here; you keep the thread from
            the notification bell.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="t-subject">Subject</Label>
            <Input
              id="t-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="The printer on the 2nd floor won't print"
              maxLength={120}
              autoFocus
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="t-category">What kind of problem?</Label>
              <select
                id="t-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as TicketCategory)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {TICKET_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {TICKET_CATEGORIES.find((c) => c.key === category)?.hint}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="t-priority">How urgent is it?</Label>
              <select
                id="t-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as TicketPriority)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {TICKET_PRIORITIES.map((p) => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {TICKET_PRIORITIES.find((p) => p.key === priority)?.hint}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="t-description">What happened?</Label>
            <Textarea
              id="t-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What you were doing, what you expected, and what happened instead."
              rows={5}
            />
          </div>

          <div className="space-y-2">
            <Label>Screenshots <span className="font-normal text-muted-foreground">(optional, up to {MAX_TICKET_ATTACHMENTS})</span></Label>
            <div className="flex flex-wrap items-center gap-2">
              {attachments.map((src, i) => (
                <div key={i} className="relative">
                  <img src={src} alt={`Attachment ${i + 1}`} className="h-16 w-16 rounded-md border object-cover" />
                  <button
                    type="button"
                    aria-label={`Remove attachment ${i + 1}`}
                    onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                    className="absolute -right-1.5 -top-1.5 rounded-full border bg-background p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {attachments.length < MAX_TICKET_ATTACHMENTS && (
                <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                  <Paperclip className="mr-1 h-4 w-4" /> Add image
                </Button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  void onPickAttachments(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Images are downscaled before they are saved, so a full-screen screenshot travels light.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={submitting}>
            <Send className="mr-1 h-4 w-4" /> {submitting ? 'Submitting…' : 'Submit ticket'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
