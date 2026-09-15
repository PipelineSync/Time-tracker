import { useEffect, useState } from 'react'
import { useStore } from '@/lib/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { CheckCircle2, CornerUpLeft, MessageSquare, Paperclip, Send, UserRound } from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
import {
  TICKET_STATUSES,
  TICKET_STATUS_BADGE,
  TICKET_PRIORITY_BADGE,
  ticketCategoryLabel,
  ticketPriorityLabel,
  ticketRef,
  ticketStatusLabel,
} from '@/lib/tickets'
import type { Ticket, TicketAssignee, TicketReply, TicketStatus } from '@/lib/types'

/**
 * One ticket, opened: what was reported, who is handling it, the controls that
 * move it along, and the conversation.
 *
 * Two readers, on purpose:
 *  - **IT Support** gets the triage controls (status, assignee) and the queue.
 *  - **the requester** gets the same thread without the controls, so a reply
 *    from the desk is answered rather than shouted into the void.
 */
export function TicketDetailPanel({
  ticket,
  replies,
  assignees,
  canManage,
  onChanged,
  className,
}: {
  ticket: Ticket
  replies: TicketReply[]
  assignees: TicketAssignee[]
  canManage: boolean
  onChanged: () => void
  className?: string
}) {
  const { updateTicket, replyToTicket } = useStore()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [savingStatus, setSavingStatus] = useState(false)

  // A different ticket opened → a different draft.
  useEffect(() => setBody(''), [ticket.id])

  async function changeStatus(status: TicketStatus) {
    setSavingStatus(true)
    const res = await updateTicket(ticket.id, { status })
    setSavingStatus(false)
    if (res) onChanged()
  }

  async function changeAssignee(value: string) {
    const assignee = assignees.find((a) => a.user_id === value) ?? null
    setSavingStatus(true)
    const res = await updateTicket(ticket.id, {
      assignee_user_id: assignee ? assignee.user_id : null,
      assignee_name: assignee ? assignee.name : null,
    })
    setSavingStatus(false)
    if (res) onChanged()
  }

  async function sendReply() {
    if (!body.trim()) return
    setBusy(true)
    const res = await replyToTicket(ticket.id, body.trim())
    setBusy(false)
    if (!res) return
    setBody('')
    onChanged()
  }

  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{ticketRef(ticket)}</span>
          <Badge className={cn('font-medium', TICKET_STATUS_BADGE[ticket.status])}>{ticketStatusLabel(ticket.status)}</Badge>
          <Badge className={cn('font-medium', TICKET_PRIORITY_BADGE[ticket.priority])}>{ticketPriorityLabel(ticket.priority)}</Badge>
          <Badge variant="muted" className="font-medium">{ticketCategoryLabel(ticket.category)}</Badge>
        </div>
        <CardTitle className="text-lg leading-snug">{ticket.subject}</CardTitle>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><UserRound className="h-3 w-3" /> {ticket.requester_name} (requester)</span>
          <span className="flex items-center gap-1">
            <CornerUpLeft className="h-3 w-3" /> {ticket.assignee_name ? `Assigned to ${ticket.assignee_name}` : 'Unassigned'}
          </span>
          <span>Submitted {formatDateTime(ticket.created_at)}</span>
          {ticket.resolved_at && <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Resolved {formatDateTime(ticket.resolved_at)}</span>}
        </div>
      </CardHeader>

      <CardContent className="flex-1 space-y-5">
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{ticket.description}</p>

        {ticket.attachments.length > 0 && (
          <div className="space-y-2">
            <p className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Paperclip className="h-3 w-3" /> {ticket.attachments.length} screenshot{ticket.attachments.length === 1 ? '' : 's'}
            </p>
            <div className="flex flex-wrap gap-2">
              {ticket.attachments.map((src, i) => (
                <a key={i} href={src} target="_blank" rel="noreferrer" title="Open full size">
                  <img src={src} alt={`Screenshot ${i + 1}`} className="h-24 w-24 rounded-md border object-cover" />
                </a>
              ))}
            </div>
          </div>
        )}

        {canManage && (
          <div className="grid gap-4 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`t-status-${ticket.id}`}>Status</Label>
              <select
                id={`t-status-${ticket.id}`}
                value={ticket.status}
                disabled={savingStatus}
                onChange={(e) => void changeStatus(e.target.value as TicketStatus)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              >
                {TICKET_STATUSES.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`t-assignee-${ticket.id}`}>Handled by</Label>
              <select
                id={`t-assignee-${ticket.id}`}
                value={ticket.assignee_user_id ?? ''}
                disabled={savingStatus}
                onChange={(e) => void changeAssignee(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              >
                <option value="">Unassigned</option>
                {assignees.map((a) => (
                  <option key={a.user_id} value={a.user_id}>{a.name}</option>
                ))}
                {/* The assignee list comes from the grant holders; if a ticket
                    was assigned by someone since, keep that name visible. */}
                {ticket.assignee_user_id && !assignees.some((a) => a.user_id === ticket.assignee_user_id) && (
                  <option value={ticket.assignee_user_id}>{ticket.assignee_name ?? 'IT Support'}</option>
                )}
              </select>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Moving the status or replying tells the requester through their notification bell.
            </p>
          </div>
        )}

        {/* The conversation: the requester's report, then every reply. */}
        <div className="space-y-3">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <MessageSquare className="h-3 w-3" /> Conversation
          </p>
          {replies.length === 0 ? (
            <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
              No replies yet.
            </p>
          ) : (
            <div className="space-y-3">
              {replies.map((r) => (
                <div
                  key={r.id}
                  className={cn(
                    'rounded-lg border p-3',
                    r.from_support ? 'border-primary/30 bg-primary/5' : 'bg-muted/30'
                  )}
                >
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{r.author_name}</span>
                    {r.from_support && ' · IT Support'} · {formatDateTime(r.created_at)}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{r.body}</p>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder={canManage ? 'Reply to the requester…' : 'Add an update to your ticket…'}
              aria-label="Reply"
            />
            <div className="flex justify-end">
              <Button type="button" onClick={sendReply} disabled={busy || !body.trim()}>
                <Send className="mr-1 h-4 w-4" /> {busy ? 'Sending…' : 'Send reply'}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
