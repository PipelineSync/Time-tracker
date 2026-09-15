import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useStore } from '@/lib/store'
import { PageHeader } from '@/components/PageHeader'
import { TicketFormDialog } from '@/components/TicketFormDialog'
import { TicketDetailPanel } from '@/components/TicketDetailPanel'
import { EmptyState } from '@/components/EmptyState'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ArrowLeft, Inbox, Plus, Search, ShieldAlert, Ticket as TicketIcon } from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import {
  TICKET_PRIORITY_BADGE,
  TICKET_STATUSES,
  TICKET_STATUS_BADGE,
  openTicketCount,
  ticketCategoryLabel,
  ticketPriorityLabel,
  ticketRef,
  ticketStatusLabel,
} from '@/lib/tickets'
import type { Ticket, TicketAssignee, TicketStatus, TicketThread } from '@/lib/types'

/**
 * **IT Support** — the support desk.
 *
 * Who sees what, and why:
 *  - **IT Support** (a worker the admin granted it to — never the admin by
 *    default) sees the whole queue, triages it and replies.
 *  - **anyone else** sees no queue at all. They can still *submit* a ticket from
 *    the button in the header, and when the desk replies or moves their ticket
 *    the bell notification opens **that one ticket** here (`?ticket=<id>`), so
 *    the conversation is two-sided without handing out the team's queue.
 *
 * The gate is `isItSupport` from the store, never `can('it_support.manage')`:
 * the admin holds every `can()` capability, and the whole point of this section
 * is that the owner does not hold this one.
 */
export function ItSupportPage() {
  const { tickets, isItSupport, openTicket, listItSupportAssignees, refreshTickets, dataLoading } = useStore()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = searchParams.get('ticket')

  const [thread, setThread] = useState<TicketThread | null>(null)
  const [assignees, setAssignees] = useState<TicketAssignee[]>([])
  const [loadingThread, setLoadingThread] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'all' | TicketStatus>('all')
  const [query, setQuery] = useState('')
  const [formOpen, setFormOpen] = useState(false)

  const selectTicket = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(searchParams)
      if (id) next.set('ticket', id)
      else next.delete('ticket')
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  // The queue, and — for the desk — the people a ticket can be assigned to.
  useEffect(() => {
    void refreshTickets()
    if (isItSupport) void listItSupportAssignees().then(setAssignees)
  }, [refreshTickets, listItSupportAssignees, isItSupport])

  // Whatever is in the URL is what gets opened: the queue's selection, or the
  // requester's own ticket reached from a notification.
  useEffect(() => {
    if (!selectedId) {
      setThread(null)
      return
    }
    let cancelled = false
    setLoadingThread(true)
    void openTicket(selectedId).then((res) => {
      if (cancelled) return
      setThread(res)
      setLoadingThread(false)
    })
    return () => {
      cancelled = true
    }
  }, [selectedId, openTicket])

  /** Re-read the detail after a change (status, assignee, new reply). */
  const reloadThread = useCallback(() => {
    void refreshTickets()
    if (selectedId) void openTicket(selectedId).then(setThread)
  }, [refreshTickets, openTicket, selectedId])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return tickets.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false
      if (!q) return true
      return (
        t.subject.toLowerCase().includes(q) ||
        t.requester_name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        String(t.number) === q.replace('#', '')
      )
    })
  }, [tickets, statusFilter, query])

  const openCount = openTicketCount(tickets)

  // ---- The requester's side: one ticket, reached from the bell -------------
  if (!isItSupport) {
    const own = thread?.ticket ?? null
    return (
      <div className="space-y-6">
        <PageHeader title="IT Support" description="Your ticket and its conversation." />
        {selectedId ? (
          <div className="space-y-3">
            <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => selectTicket(null)}>
              <ArrowLeft className="mr-1 h-4 w-4" /> Back
            </Button>
            {loadingThread ? (
              <Skeleton className="h-64" />
            ) : own ? (
              <TicketDetailPanel
                ticket={own}
                replies={thread?.replies ?? []}
                assignees={[]}
                canManage={false}
                onChanged={reloadThread}
                className="mx-auto max-w-3xl"
              />
            ) : (
              <Card className="mx-auto max-w-xl">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ShieldAlert className="h-4 w-4" /> That ticket is not yours to open
                  </CardTitle>
                  <CardDescription>
                    Tickets are visible to the person who submitted them and to IT Support. If you need to
                    report something new, use the button below.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button onClick={() => setFormOpen(true)}>
                    <Plus className="mr-1 h-4 w-4" /> Submit a Ticket
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        ) : (
          <Card className="mx-auto max-w-xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldAlert className="h-4 w-4" /> The support desk is closed to you
              </CardTitle>
              <CardDescription>
                Nobody sees the IT Support queue unless the administrator grants it — it is not part of the
                admin account either. You can still report a problem: your ticket goes straight to whoever is
                running support, and they will answer you here.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => setFormOpen(true)}>
                <Plus className="mr-1 h-4 w-4" /> Submit a Ticket
              </Button>
            </CardContent>
          </Card>
        )}
        <TicketFormDialog open={formOpen} onOpenChange={setFormOpen} onSubmitted={(t) => selectTicket(t.id)} />
      </div>
    )
  }

  // ---- IT Support: the queue + the ticket in front of them -----------------
  return (
    <div className="space-y-6">
      <PageHeader
        title="IT Support"
        description="Every ticket submitted from the app — triage, assign and answer them here."
      >
        <Button onClick={() => setFormOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> Submit a Ticket
        </Button>
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        {/* Queue */}
        <div className={cn('space-y-3', selectedId && 'hidden lg:block')}>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tickets…"
                className="pl-8"
                aria-label="Search tickets"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | TicketStatus)}
              aria-label="Filter by status"
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="all">All ({tickets.length})</option>
              {TICKET_STATUSES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label} ({tickets.filter((t) => t.status === s.key).length})
                </option>
              ))}
            </select>
          </div>

          {openCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {openCount} ticket{openCount === 1 ? '' : 's'} still open.
            </p>
          )}

          {dataLoading && tickets.length === 0 ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title={tickets.length === 0 ? 'No tickets yet' : 'Nothing matches'}
              description={
                tickets.length === 0
                  ? 'Anything submitted from the app lands here, and you get a notification the moment it does.'
                  : 'Try another search or clear the status filter.'
              }
            />
          ) : (
            <div className="space-y-2">
              {visible.map((t) => (
                <TicketRow
                  key={t.id}
                  ticket={t}
                  active={t.id === selectedId}
                  onClick={() => selectTicket(t.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Detail */}
        <div className={cn('space-y-3', !selectedId && 'hidden lg:block')}>
          {selectedId && (
            <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => selectTicket(null)}>
              <ArrowLeft className="mr-1 h-4 w-4" /> Back to the queue
            </Button>
          )}
          {!selectedId ? (
            <Card className="hidden h-full items-center justify-center lg:flex">
              <CardContent className="py-16 text-center text-sm text-muted-foreground">
                <TicketIcon className="mx-auto mb-3 h-6 w-6" />
                Pick a ticket to see the report and the conversation.
              </CardContent>
            </Card>
          ) : loadingThread ? (
            <Skeleton className="h-64" />
          ) : thread ? (
            <TicketDetailPanel
              ticket={thread.ticket}
              replies={thread.replies}
              assignees={assignees}
              canManage
              onChanged={reloadThread}
            />
          ) : (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                That ticket could not be opened.
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <TicketFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        onSubmitted={(t) => {
          void refreshTickets()
          selectTicket(t.id)
        }}
      />
    </div>
  )
}

/** One queue row: what it is, who reported it, how urgent, how far along. */
function TicketRow({ ticket, active, onClick }: { ticket: Ticket; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={cn(
        'w-full rounded-lg border p-3 text-left transition-colors',
        active ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 text-sm font-medium">{ticket.subject}</p>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{ticketRef(ticket)}</span>
      </div>
      <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
        {ticket.requester_name} · {formatDate(ticket.created_at)} · {ticketCategoryLabel(ticket.category)}
        {ticket.reply_count > 0 && ` · ${ticket.reply_count} repl${ticket.reply_count === 1 ? 'y' : 'ies'}`}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge className={cn('font-medium', TICKET_STATUS_BADGE[ticket.status])}>{ticketStatusLabel(ticket.status)}</Badge>
        <Badge className={cn('font-medium', TICKET_PRIORITY_BADGE[ticket.priority])}>{ticketPriorityLabel(ticket.priority)}</Badge>
        {ticket.assignee_name && <Badge variant="muted" className="font-medium">{ticket.assignee_name}</Badge>}
      </div>
    </button>
  )
}
