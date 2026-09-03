import { useMemo, useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useStore } from '@/lib/store'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EntryFormDialog } from '@/components/EntryFormDialog'
import { EntryChatDialog } from '@/components/EntryChatDialog'
import { EmptyState } from '@/components/EmptyState'
import { toast } from 'sonner'
import { Plus, ListChecks, Pencil, Trash2, Copy, Search, X, MessageSquare } from 'lucide-react'
import type { TimeEntry } from '@/lib/types'
import { money, formatMinutes, formatDate, formatTime } from '@/lib/utils'
import { startOfWeek, startOfMonth } from '@/lib/stats'

type SortKey = 'date' | 'worker' | 'hours' | 'earnings'
type SortDir = 'asc' | 'desc'

export function EntriesPage() {
  const { workers, entries, deleteEntry, duplicateEntry, settings, dataLoading, isAdmin } = useStore()
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState<TimeEntry | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [deleting, setDeleting] = useState<TimeEntry | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [chatEntry, setChatEntry] = useState<TimeEntry | null>(null)
  const [chatOpen, setChatOpen] = useState(false)

  const [workerFilter, setWorkerFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [settleFilter, setSettleFilter] = useState<'all' | 'unsettled' | 'settled'>('all')
  const [dateFilter, setDateFilter] = useState('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  // Render at most this many rows at a time — the store may hold thousands of
  // entries in memory, but a phone shouldn't render all of them as DOM.
  const [visibleCount, setVisibleCount] = useState(200)
  const PAGE_RENDER_STEP = 200

  const currency = settings?.currency || 'USD'

  useEffect(() => {
    const next = new URLSearchParams(params)
    const newParam = params.get('new')
    const workerParam = params.get('worker')
    const entryParam = params.get('entry')
    let changed = false

    if (newParam === '1') {
      setFormOpen(true)
      next.delete('new')
      changed = true
    }
    if (workerParam) {
      setWorkerFilter(workerParam)
      next.delete('worker')
      changed = true
    }
    if (entryParam) {
      const e = entries.find((x) => x.id === entryParam)
      if (e) {
        setChatEntry(e)
        setChatOpen(true)
        next.delete('entry')
        changed = true
      }
      // If the entries are still loading, keep the entry param so the chat can
      // open as soon as the worker/admin data arrives from Supabase.
    }
    if (changed) setParams(next, { replace: true })
  }, [params, setParams, entries])

  const projects = useMemo(() => {
    const set = new Set<string>()
    for (const e of entries) if (e.project) set.add(e.project)
    return Array.from(set).sort()
  }, [entries])

  const workerName = (id: string) => workers.find((w) => w.id === id)?.name || 'Unknown'

  const filtered = useMemo(() => {
    let list = entries
    if (workerFilter !== 'all') list = list.filter((e) => e.worker_id === workerFilter)
    if (projectFilter !== 'all') list = list.filter((e) => e.project === projectFilter)
    // Settling keeps the entries, so the admin can still narrow down to the time
    // that has (or has not) been paid out yet.
    if (settleFilter === 'settled') list = list.filter((e) => Boolean(e.settled_at))
    else if (settleFilter === 'unsettled') list = list.filter((e) => !e.settled_at)
    if (dateFilter === 'week') {
      const s = startOfWeek().getTime()
      list = list.filter((e) => new Date(e.start_time).getTime() >= s)
    } else if (dateFilter === 'month') {
      const s = startOfMonth().getTime()
      list = list.filter((e) => new Date(e.start_time).getTime() >= s)
    } else if (dateFilter === 'custom') {
      list = list.filter((e) => {
        const t = new Date(e.start_time).getTime()
        if (fromDate && t < new Date(`${fromDate}T00:00:00`).getTime()) return false
        if (toDate && t > new Date(`${toDate}T23:59:59`).getTime()) return false
        return true
      })
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter((e) =>
        workerName(e.worker_id).toLowerCase().includes(q) ||
        (e.project || '').toLowerCase().includes(q) ||
        (e.notes || '').toLowerCase().includes(q)
      )
    }
    const sorted = [...list]
    sorted.sort((a, b) => {
      let cmp = 0
      if (sortKey === 'date') cmp = a.start_time.localeCompare(b.start_time)
      else if (sortKey === 'worker') cmp = workerName(a.worker_id).localeCompare(workerName(b.worker_id))
      else if (sortKey === 'hours') cmp = a.total_minutes - b.total_minutes
      else if (sortKey === 'earnings') cmp = a.earnings - b.earnings
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [entries, workerFilter, projectFilter, settleFilter, dateFilter, fromDate, toDate, search, sortKey, sortDir]) // eslint-disable-line react-hooks/exhaustive-deps

  // A new filter means a new list — start it at the first page again.
  useEffect(() => {
    setVisibleCount(200)
  }, [workerFilter, projectFilter, settleFilter, dateFilter, search, fromDate, toDate, sortKey, sortDir])

  const visible = filtered.slice(0, visibleCount)

  const totals = useMemo(() => {
    let min = 0
    let earn = 0
    let open = 0
    for (const e of filtered) {
      min += e.total_minutes
      earn += e.earnings
      if (!e.settled_at) open += e.earnings
    }
    return { min, earn, open }
  }, [filtered])

  const hasFilters =
    workerFilter !== 'all' ||
    projectFilter !== 'all' ||
    settleFilter !== 'all' ||
    dateFilter !== 'all' ||
    search !== '' ||
    fromDate !== '' ||
    toDate !== ''

  function clearFilters() {
    setWorkerFilter('all')
    setProjectFilter('all')
    setSettleFilter('all')
    setDateFilter('all')
    setFromDate('')
    setToDate('')
    setSearch('')
  }

  async function handleDuplicate(e: TimeEntry) {
    const ok = await duplicateEntry(e)
    if (ok) toast.success('Entry duplicated.')
    else toast.error('Failed to duplicate entry.')
  }

  const TableRow = ({ e }: { e: TimeEntry }) => (
    <>
      <td className="px-4 py-3 align-middle">{formatDate(e.start_time)}</td>
      <td className="px-4 py-3 align-middle font-medium">
        <span className="flex flex-wrap items-center gap-1.5">
          {workerName(e.worker_id)}
          {/* Settling keeps the entry — the badge says it has been paid out. */}
          {e.settled_at && (
            <Badge variant="muted" className="px-1.5 py-0 text-[10px]" title={`Settled ${formatDate(e.settled_at)}`}>
              Settled
            </Badge>
          )}
        </span>
      </td>
      <td className="px-4 py-3 align-middle">{e.project || '—'}</td>
      <td className="px-4 py-3 align-middle whitespace-nowrap">{formatTime(e.start_time)}</td>
      <td className="px-4 py-3 align-middle whitespace-nowrap">{formatTime(e.end_time)}</td>
      <td className="px-4 py-3 align-middle">{e.break_minutes > 0 ? `${e.break_minutes}m` : '—'}</td>
      <td className="px-4 py-3 align-middle font-medium">{formatMinutes(e.total_minutes)}</td>
      <td className="px-4 py-3 align-middle">{money(e.hourly_rate, currency)}/hr</td>
      <td className="px-4 py-3 align-middle font-semibold">{money(e.earnings, currency)}</td>
      <td className="px-4 py-3 align-middle max-w-[180px]"><span className="line-clamp-2 text-muted-foreground">{e.notes || '—'}</span></td>
      <td className="px-4 py-3 align-middle">
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="iconSm" onClick={() => { setChatEntry(e); setChatOpen(true); }} aria-label="Notes"><MessageSquare className="h-4 w-4" /></Button>
          {isAdmin && (
            <>
              <Button variant="ghost" size="iconSm" onClick={() => { setEditing(e); setFormOpen(true); }} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>
              <Button variant="ghost" size="iconSm" onClick={() => handleDuplicate(e)} aria-label="Duplicate"><Copy className="h-4 w-4" /></Button>
              <Button variant="ghost" size="iconSm" className="text-destructive" onClick={() => { setDeleting(e); setConfirmDelete(true); }} aria-label="Delete"><Trash2 className="h-4 w-4" /></Button>
            </>
          )}
        </div>
      </td>
    </>
  )

  return (
    <div className="space-y-6">
      <PageHeader title="Time Entries" description="Review and manage all recorded time.">
        {isAdmin && (
          <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
            <Plus className="mr-1" /> Manual entry
          </Button>
        )}
      </PageHeader>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <div className="lg:col-span-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-9" placeholder="Search worker, project, notes…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            </div>
            <Select value={workerFilter} onValueChange={setWorkerFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All workers</SelectItem>
                {workers.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={projectFilter} onValueChange={setProjectFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {projects.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={dateFilter} onValueChange={setDateFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All dates</SelectItem>
                <SelectItem value="week">This week</SelectItem>
                <SelectItem value="month">This month</SelectItem>
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
            <Select value={settleFilter} onValueChange={(v) => setSettleFilter(v as 'all' | 'unsettled' | 'settled')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Settled & unsettled</SelectItem>
                <SelectItem value="unsettled">Unsettled only</SelectItem>
                <SelectItem value="settled">Settled only</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="date">Sort: Date</SelectItem>
                <SelectItem value="worker">Sort: Worker</SelectItem>
                <SelectItem value="hours">Sort: Hours</SelectItem>
                <SelectItem value="earnings">Sort: Earnings</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {dateFilter === 'custom' && (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">From</label>
                <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-40" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">To</label>
                <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-40" />
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}>
                  {sortDir === 'asc' ? 'Ascending' : 'Descending'}
                </Button>
                {hasFilters && (
                  <Button variant="ghost" size="sm" onClick={clearFilters}><X className="mr-1 h-4 w-4" /> Clear</Button>
                )}
              </div>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span><span className="font-semibold text-foreground">{filtered.length}</span> entries</span>
            <span><span className="font-semibold text-foreground">{formatMinutes(totals.min)}</span> hours</span>
            <span><span className="font-semibold text-foreground">{money(totals.earn, currency)}</span> earnings</span>
            <span title="Earnings that have not been settled yet">
              <span className="font-semibold text-foreground">{money(totals.open, currency)}</span> unsettled
            </span>
          </div>
        </CardContent>
      </Card>

      {dataLoading && entries.length === 0 ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No time entries"
          description={hasFilters ? 'No entries match your filters.' : 'Track time with the timer or add a manual entry.'}
          action={!hasFilters && isAdmin ? <Button onClick={() => { setEditing(null); setFormOpen(true); }}><Plus className="mr-1" /> Add entry</Button> : undefined}
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-xl border md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium">Worker</th>
                    <th className="px-4 py-3 font-medium">Project</th>
                    <th className="px-4 py-3 font-medium">Start</th>
                    <th className="px-4 py-3 font-medium">End</th>
                    <th className="px-4 py-3 font-medium">Break</th>
                    <th className="px-4 py-3 font-medium">Hours</th>
                    <th className="px-4 py-3 font-medium">Rate</th>
                    <th className="px-4 py-3 font-medium">Earnings</th>
                    <th className="px-4 py-3 font-medium">Notes</th>
                    <th className="px-4 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visible.map((e) => (
                    <tr key={e.id} className="hover:bg-muted/40"><TableRow e={e} /></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {visible.map((e) => (
              <Card key={e.id}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="flex flex-wrap items-center gap-1.5 font-semibold">
                        {workerName(e.worker_id)}
                        {e.settled_at && (
                          <Badge variant="muted" className="px-1.5 py-0 text-[10px]" title={`Settled ${formatDate(e.settled_at)}`}>
                            Settled
                          </Badge>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatDate(e.start_time)} · {formatTime(e.start_time)}–{formatTime(e.end_time)}</p>
                    </div>
                    <span className="font-semibold">{money(e.earnings, currency)}</span>
                  </div>
                  {e.project && <p className="mt-2 text-sm">{e.project}</p>}
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>⏱ {formatMinutes(e.total_minutes)}</span>
                    {e.break_minutes > 0 && <span>Break {e.break_minutes}m</span>}
                    <span>{money(e.hourly_rate, currency)}/hr</span>
                  </div>
                  {e.notes && <p className="mt-2 text-sm text-muted-foreground">{e.notes}</p>}
                  <div className="mt-3 flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1 gap-1" onClick={() => { setChatEntry(e); setChatOpen(true); }}><MessageSquare className="h-3.5 w-3.5" /> Notes</Button>
                    {isAdmin && (
                      <>
                        <Button variant="outline" size="sm" className="flex-1 gap-1" onClick={() => { setEditing(e); setFormOpen(true); }}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                        <Button variant="outline" size="sm" className="flex-1 gap-1" onClick={() => handleDuplicate(e)}><Copy className="h-3.5 w-3.5" /> Duplicate</Button>
                        <Button variant="ghost" size="iconSm" className="text-destructive" onClick={() => { setDeleting(e); setConfirmDelete(true); }}><Trash2 className="h-4 w-4" /></Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Only the newest page is rendered; older rows stay in memory. */}
          {visible.length < filtered.length && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => setVisibleCount((c) => c + PAGE_RENDER_STEP)}>
                Show more ({filtered.length - visible.length} older entries)
              </Button>
            </div>
          )}
        </>
      )}

      <EntryFormDialog open={formOpen} onOpenChange={setFormOpen} entry={editing} />
      {chatEntry && (
        <EntryChatDialog
          entryId={chatEntry.id}
          entryLabel={`${workerName(chatEntry.worker_id)} · ${formatDate(chatEntry.start_time)}`}
          open={chatOpen}
          onOpenChange={setChatOpen}
        />
      )}
      {deleting && (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title="Delete entry?"
          description={`Delete this entry for ${workerName(deleting.worker_id)}? This cannot be undone.`}
          confirmLabel="Delete entry"
          onConfirm={async () => {
            const ok = await deleteEntry(deleting.id)
            if (ok) toast.success('Entry deleted.')
            else toast.error('Failed to delete entry.')
          }}
        />
      )}
    </div>
  )
}
