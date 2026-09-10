import { useMemo, useState } from 'react'
import { CalendarClock, CalendarDays, Pencil, Plus, Trash2 } from 'lucide-react'
import { useStore } from '@/lib/store'
import type { Meeting } from '@/lib/types'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/EmptyState'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { MeetingFormDialog } from '@/components/MeetingFormDialog'
import { cn, formatDate, formatTime } from '@/lib/utils'

/** Same calendar day, no time component. */
function startOfDay(d: Date): number {
  const copy = new Date(d)
  copy.setHours(0, 0, 0, 0)
  return copy.getTime()
}

/**
 * A friendly label for the day a meeting falls on, relative to today — the
 * agenda reads at a glance without a calendar.
 */
function dayLabel(start: string, today: number): string {
  const day = startOfDay(new Date(start))
  const diff = Math.round((day - today) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return formatDate(start)
}

/**
 * The meetings schedule: one workspace-wide agenda, split into upcoming
 * (soonest first) and past (newest first). Admin-only until the admin grants
 * `meetings.view` — a granted worker sees and manages the very same list.
 * Deliberately basic: a title, when it starts, optional notes.
 */
export function MeetingsPage() {
  const { meetings, dataLoading, deleteMeeting } = useStore()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Meeting | null>(null)
  const [deleting, setDeleting] = useState<Meeting | null>(null)

  // Recomputed whenever the data moves so "upcoming vs past" follows the
  // clock on the device the page is open on.
  const { upcoming, past, today } = useMemo(() => {
    const now = Date.now()
    const rows = [...meetings].sort((a, b) => a.start_time.localeCompare(b.start_time))
    return {
      upcoming: rows.filter((m) => new Date(m.start_time).getTime() >= now),
      past: [...rows].filter((m) => new Date(m.start_time).getTime() < now).reverse(),
      today: startOfDay(new Date()),
    }
  }, [meetings])

  const showSkeleton = dataLoading && meetings.length === 0

  function renderRow(meeting: Meeting, isPast: boolean) {
    const startsToday = startOfDay(new Date(meeting.start_time)) === today
    const soon = !isPast && startsToday
    return (
      <div
        key={meeting.id}
        className={cn(
          'flex items-start gap-3 rounded-xl border bg-card p-3 shadow-sm transition hover:shadow-md',
          soon && 'border-primary/40',
        )}
      >
        {/* The date block anchors the row the way a calendar strip would. */}
        <div
          className={cn(
            'flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-lg border text-center leading-tight',
            soon ? 'border-primary/40 bg-primary/10 text-primary' : 'bg-muted/50 text-muted-foreground',
          )}
          aria-hidden
        >
          <span className="text-[10px] font-medium uppercase">
            {new Date(meeting.start_time).toLocaleDateString(undefined, { month: 'short' })}
          </span>
          <span className="text-base font-semibold">{new Date(meeting.start_time).getDate()}</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className={cn('break-words text-sm font-medium', isPast && 'text-muted-foreground')}>{meeting.title}</p>
            {soon && <Badge className="text-[10px]">Today</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {dayLabel(meeting.start_time, today)} · {formatTime(meeting.start_time)}
          </p>
          {meeting.notes && (
            <p className="mt-1 whitespace-pre-line break-words text-xs text-muted-foreground">{meeting.notes}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={`Edit "${meeting.title}"`}
            onClick={() => {
              setEditing(meeting)
              setFormOpen(true)
            }}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive"
            aria-label={`Delete "${meeting.title}"`}
            onClick={() => setDeleting(meeting)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Meetings"
        description="The team's schedule. Upcoming first, then the archive of past meetings."
      >
        <Button
          onClick={() => {
            setEditing(null)
            setFormOpen(true)
          }}
        >
          <Plus className="mr-2 h-4 w-4" /> New meeting
        </Button>
      </PageHeader>

      {showSkeleton ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : meetings.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No meetings scheduled"
          description="Schedule the first one — it shows up here for everyone the section is open to."
          action={
            <Button
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              <Plus className="mr-2 h-4 w-4" /> New meeting
            </Button>
          }
        />
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <CalendarClock className="h-4 w-4" />
              Upcoming
              <Badge variant="muted" className="text-[10px]">{upcoming.length}</Badge>
            </h2>
            {upcoming.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
                Nothing scheduled — add a meeting and it will appear here.
              </p>
            ) : (
              <div className="space-y-2">{upcoming.map((m) => renderRow(m, false))}</div>
            )}
          </section>

          {past.length > 0 && (
            <section className="space-y-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                <CalendarDays className="h-4 w-4" />
                Past
                <Badge variant="muted" className="text-[10px]">{past.length}</Badge>
              </h2>
              <div className="space-y-2 opacity-90">{past.map((m) => renderRow(m, true))}</div>
            </section>
          )}
        </>
      )}

      <MeetingFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        meeting={editing}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="Delete this meeting?"
        description={deleting ? `"${deleting.title}" will be removed from the schedule. This cannot be undone.` : ''}
        onConfirm={async () => {
          if (deleting) await deleteMeeting(deleting.id)
          setDeleting(null)
        }}
      />
    </div>
  )
}
