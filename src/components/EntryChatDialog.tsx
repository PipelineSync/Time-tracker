import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/lib/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatTime } from '@/lib/utils'
import type { TimeEntryComment } from '@/lib/types'

export function EntryChatDialog({
  entryId,
  entryLabel,
  open,
  onOpenChange,
}: {
  entryId: string
  entryLabel: string
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { listEntryComments, addEntryComment, user } = useStore()
  const [comments, setComments] = useState<TimeEntryComment[]>([])
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (open && entryId) {
      setBody('')
      listEntryComments(entryId).then((c) => setComments(c))
    }
  }, [open, entryId, listEntryComments])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [comments])

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!body.trim()) return
    setSending(true)
    const comment = await addEntryComment(entryId, body.trim())
    setSending(false)
    if (!comment) {
      toast.error('Failed to send note.')
      return
    }
    setComments((prev) => [...prev, comment])
    setBody('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">Notes · {entryLabel}</DialogTitle>
          <DialogDescription>Discuss this work session. Admin and worker replies appear here.</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-[260px] flex-col gap-3 rounded-lg bg-muted/40 p-3">
          {comments.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              No notes yet. Start the conversation.
            </div>
          ) : (
            comments.map((c) => {
              const mine = c.author_id === user?.id
              return (
                <div key={c.id} className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
                  <div
                    className={cn(
                      'max-w-[85%] rounded-2xl px-3 py-2 text-sm',
                      mine ? 'bg-primary text-primary-foreground' : 'bg-background shadow-sm'
                    )}
                  >
                    <p className="whitespace-pre-wrap break-words">{c.body}</p>
                  </div>
                  <p className="mt-0.5 px-1 text-[11px] text-muted-foreground">
                    {c.author_name} · {formatTime(c.created_at)}
                  </p>
                </div>
              )
            })
          )}
          <div ref={endRef} />
        </div>

        <form onSubmit={handleSend} className="flex items-end gap-2">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={user?.role === 'admin' ? 'Reply to this worker…' : 'Add a note about your work…'}
            className="min-h-[56px] max-h-32 flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend(e)
              }
            }}
          />
          <Button type="submit" size="icon" className="h-10 w-10" aria-label="Send" disabled={sending || !body.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
