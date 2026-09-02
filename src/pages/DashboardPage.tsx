import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/store'
import { StatCard } from '@/components/StatCard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/EmptyState'
import { ActiveWorkersPanel } from '@/components/ActiveWorkersPanel'
import {
  Clock, DollarSign, CalendarRange, Wallet, Plus, Users, ListChecks,
} from 'lucide-react'
import { money, formatMinutes, formatDate } from '@/lib/utils'
import { dateRangeFor, filterEntriesInRange, summarizeEntries, hoursByWorker } from '@/lib/stats'

export function DashboardPage() {
  const { entries, workers, settings, dataLoading } = useStore()
  const navigate = useNavigate()
  const currency = settings?.currency || 'USD'

  const today = useMemo(() => {
    const { from, to } = dateRangeFor('today')
    return filterEntriesInRange(entries, from, to)
  }, [entries])

  const week = useMemo(() => {
    const { from, to } = dateRangeFor('week')
    return filterEntriesInRange(entries, from, to)
  }, [entries])

  const todaySum = useMemo(() => summarizeEntries(today), [today])
  const weekSum = useMemo(() => summarizeEntries(week), [week])

  const byWorker = useMemo(() => hoursByWorker(week, workers), [week, workers])

  const recent = useMemo(() => [...entries].sort((a, b) => b.start_time.localeCompare(a.start_time)).slice(0, 6), [entries])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Overview of your team’s time and earnings.</p>
      </div>

      {/* Everyone currently on the clock (working or on break) */}
      <ActiveWorkersPanel />

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4">
        <StatCard label="Today's Hours" value={formatMinutes(todaySum.totalMinutes)} icon={Clock} loading={dataLoading} accent />
        <StatCard label="Today's Earnings" value={money(todaySum.earnings, currency)} icon={DollarSign} loading={dataLoading} accent />
        <StatCard label="This Week" value={formatMinutes(weekSum.totalMinutes)} icon={CalendarRange} loading={dataLoading} />
        <StatCard label="Week's Earnings" value={money(weekSum.earnings, currency)} icon={Wallet} loading={dataLoading} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* By worker */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Users className="h-4 w-4" /> By worker <span className="ml-auto text-sm font-normal text-muted-foreground">{workers.length} worker{workers.length === 1 ? '' : 's'}</span></CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {dataLoading ? (
              <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : byWorker.length === 0 ? (
              <p className="text-sm text-muted-foreground">No hours recorded this week.</p>
            ) : (
              byWorker.map((w) => (
                <div key={w.worker.id} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {w.worker.name.split(' ').map((n) => n[0]).slice(0, 2).join('')}
                    </div>
                    <span className="font-medium">{w.worker.name}</span>
                  </div>
                  <div className="text-right">
                    <p className="font-medium">{formatMinutes(w.hours * 60)}</p>
                    <p className="text-xs text-muted-foreground">{money(w.earnings, currency)}</p>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Recent entries */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base"><ListChecks className="h-4 w-4" /> Recent entries</CardTitle>
            <Link to="/entries"><Button variant="ghost" size="sm">View all</Button></Link>
          </CardHeader>
          <CardContent>
            {dataLoading ? (
              <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : recent.length === 0 ? (
              <EmptyState icon={ListChecks} title="No entries yet" description="Add time for your workers." />
            ) : (
              <div className="divide-y divide-border">
                {recent.map((e) => {
                  const w = workers.find((x) => x.id === e.worker_id)
                  return (
                    <div key={e.id} className="flex items-center justify-between py-2.5 text-sm">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                          {w?.name?.split(' ').map((n) => n[0]).slice(0, 2).join('') || '?'}
                        </div>
                        <div>
                          <p className="font-medium">{w?.name || 'Unknown'}</p>
                          <p className="text-xs text-muted-foreground">{formatDate(e.start_time)} · {e.project || 'No project'}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">{formatMinutes(e.total_minutes)}</p>
                        <p className="text-xs text-muted-foreground">{money(e.earnings, currency)}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {!dataLoading && workers.length > 0 && (
        <Button className="w-full sm:w-auto" onClick={() => navigate('/entries?new=1')}>
          <Plus className="mr-1 h-4 w-4" /> Add time
        </Button>
      )}
    </div>
  )
}
