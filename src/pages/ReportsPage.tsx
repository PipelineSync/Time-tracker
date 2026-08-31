import { useMemo, useState } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  LineChart, Line, PieChart, Pie, Cell, Legend,
} from 'recharts'
import { useStore } from '@/lib/store'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatCard } from '@/components/StatCard'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { Download, BarChart3, Clock, DollarSign, Hash, TrendingUp } from 'lucide-react'
import { money, formatMinutes } from '@/lib/utils'
import { dateRangeFor, filterEntriesInRange, summarizeEntries, hoursByWorker, hoursByProject } from '@/lib/stats'

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16']

type Period = 'today' | 'week' | 'month' | 'custom'

export function ReportsPage() {
  const { entries, workers, settings, dataLoading } = useStore()
  const currency = settings?.currency || 'USD'
  const [period, setPeriod] = useState<Period>('week')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  const range = useMemo(() => dateRangeFor(period, fromDate || undefined, toDate || undefined), [period, fromDate, toDate])
  const filtered = useMemo(() => filterEntriesInRange(entries, range.from, range.to), [entries, range])
  const summary = useMemo(() => summarizeEntries(filtered), [filtered])

  const byWorker = useMemo(() => hoursByWorker(filtered, workers), [filtered, workers])
  const byProject = useMemo(() => hoursByProject(filtered), [filtered])

  // Group by day for over-time charts
  const overTime = useMemo(() => {
    const map = new Map<string, { hours: number; earnings: number }>()
    for (const e of filtered) {
      const day = new Date(e.start_time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      const cur = map.get(day) || { hours: 0, earnings: 0 }
      cur.hours += e.total_minutes / 60
      cur.earnings += e.earnings
      map.set(day, cur)
    }
    return Array.from(map.entries())
      .map(([day, v]) => ({ day, hours: Math.round(v.hours * 100) / 100, earnings: Math.round(v.earnings * 100) / 100 }))
      .sort((a, b) => a.day.localeCompare(b.day, undefined, { numeric: true }))
  }, [filtered])

  const workerChartData = useMemo(
    () => byWorker.map((w) => ({ name: w.worker.name.split(' ')[0], hours: Math.round(w.hours * 100) / 100, earnings: Math.round(w.earnings * 100) / 100 })),
    [byWorker]
  )

  function exportCSV() {
    const header = ['Date', 'Worker', 'Project', 'Start', 'End', 'Break (min)', 'Hours', 'Rate', 'Earnings', 'Notes']
    const rows = filtered.map((e) => {
      const w = workers.find((x) => x.id === e.worker_id)?.name || 'Unknown'
      return [
        new Date(e.start_time).toLocaleDateString(),
        w,
        e.project || '',
        new Date(e.start_time).toLocaleTimeString(),
        new Date(e.end_time).toLocaleTimeString(),
        e.break_minutes,
        (e.total_minutes / 60).toFixed(2),
        e.hourly_rate.toFixed(2),
        e.earnings.toFixed(2),
        (e.notes || '').replace(/[",\n]/g, ' '),
      ]
    })
    const csv = [header, ...rows].map((r) => r.map((c) => `"${c}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `work-tracker-report-${period}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Report exported as CSV.')
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Reports" description="Analyze hours and earnings over time.">
        <Button onClick={exportCSV} disabled={filtered.length === 0}>
          <Download className="mr-1 h-4 w-4" /> Export CSV
        </Button>
      </PageHeader>

      {/* Controls */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="week">This week</SelectItem>
                <SelectItem value="month">This month</SelectItem>
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
            {period === 'custom' && (
              <>
                <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-40" />
                <span className="text-muted-foreground">to</span>
                <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-40" />
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-4">
        <StatCard label="Total Hours" value={formatMinutes(summary.totalMinutes)} icon={Clock} loading={dataLoading} accent />
        <StatCard label="Total Earnings" value={money(summary.earnings, currency)} icon={DollarSign} loading={dataLoading} accent />
        <StatCard label="Avg Hourly Rate" value={money(summary.avgRate, currency)} icon={TrendingUp} loading={dataLoading} />
        <StatCard label="Work Sessions" value={String(summary.sessions)} icon={Hash} loading={dataLoading} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Hours over time */}
        <Card>
          <CardHeader><CardTitle className="text-base">Hours over time</CardTitle></CardHeader>
          <CardContent>
            {dataLoading ? <Skeleton className="h-64" /> : overTime.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">No data for this period.</p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={overTime}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="day" fontSize={12} />
                  <YAxis fontSize={12} />
                  <Tooltip formatter={(v: number) => [`${v}h`, 'Hours']} />
                  <Bar dataKey="hours" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Earnings over time */}
        <Card>
          <CardHeader><CardTitle className="text-base">Earnings over time</CardTitle></CardHeader>
          <CardContent>
            {dataLoading ? <Skeleton className="h-64" /> : overTime.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">No data for this period.</p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={overTime}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="day" fontSize={12} />
                  <YAxis fontSize={12} />
                  <Tooltip formatter={(v: number) => [money(v, currency), 'Earnings']} />
                  <Line type="monotone" dataKey="earnings" stroke="#22c55e" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Hours by worker */}
        <Card>
          <CardHeader><CardTitle className="text-base">Hours by worker</CardTitle></CardHeader>
          <CardContent>
            {dataLoading ? <Skeleton className="h-64" /> : workerChartData.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">No data for this period.</p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie data={workerChartData} dataKey="hours" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                    {workerChartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Legend />
                  <Tooltip formatter={(v: number) => [`${v}h`, 'Hours']} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Detail tables */}
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><BarChart3 className="h-4 w-4" /> Breakdown</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <div>
              <h4 className="mb-2 text-sm font-semibold">Hours & earnings per worker</h4>
              {byWorker.length === 0 ? (
                <p className="text-sm text-muted-foreground">No data.</p>
              ) : (
                <div className="space-y-1.5 text-sm">
                  {byWorker.map((w) => (
                    <div key={w.worker.id} className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
                      <span className="font-medium">{w.worker.name}</span>
                      <span className="text-muted-foreground">{formatMinutes(w.hours * 60)} · {money(w.earnings, currency)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <h4 className="mb-2 text-sm font-semibold">Hours per project</h4>
              {byProject.length === 0 ? (
                <p className="text-sm text-muted-foreground">No data.</p>
              ) : (
                <div className="space-y-1.5 text-sm">
                  {byProject.map((p) => (
                    <div key={p.project} className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
                      <span className="font-medium">{p.project}</span>
                      <span className="text-muted-foreground">{formatMinutes(p.hours * 60)} · {money(p.earnings, currency)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
