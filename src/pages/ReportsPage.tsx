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
import { Download, BarChart3, Clock, DollarSign, Hash, Landmark, TrendingUp } from 'lucide-react'
import { money, formatMinutes, formatDate } from '@/lib/utils'
import { dateRangeFor, filterEntriesInRange, summarizeEntries, hoursByWorker, hoursByClient } from '@/lib/stats'
import { ClientColorStyles } from '@/lib/types'
import { ClientDot } from '@/components/ClientBadge'
import { daysUntil, dueLabel, financeByMonth, financeChartMonths, monthKeysBetween, subscriptionsPerMonth } from '@/lib/finance'
import { Badge } from '@/components/ui/badge'

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16']

type Period = 'today' | 'week' | 'month' | 'custom'

export function ReportsPage() {
  const { entries, workers, clients, settings, financeItems, can, dataLoading, loadOlderEntries, oldestEntryTime } = useStore()
  // The finance ledger only reaches users the Finance section is open to
  // (`finance.view`) — both backends hand everyone else an empty list — so the
  // section is gated on the same permission and never leaks numbers.
  const showFinance = can('finance.view')
  const currency = settings?.currency || 'USD'
  const [period, setPeriod] = useState<Period>('week')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [loadingOlder, setLoadingOlder] = useState(false)

  // The store keeps a bounded newest-entries window in memory; a custom range
  // that starts before the oldest loaded entry needs older pages pulled in.
  const rangeStartsEarlier =
    period === 'custom' && !!fromDate && !!oldestEntryTime &&
    new Date(`${fromDate}T00:00:00`).getTime() < new Date(oldestEntryTime).getTime()

  async function loadOlderForRange() {
    if (!fromDate) return
    setLoadingOlder(true)
    try {
      const target = `${fromDate}T00:00:00`
      // Pull pages until the range start is covered or the backend runs out.
      for (let i = 0; i < 10; i++) {
        const { added, oldest } = await loadOlderEntries()
        if (added === 0 || !oldest) break
        if (new Date(oldest).getTime() <= new Date(target).getTime()) break
      }
    } finally {
      setLoadingOlder(false)
    }
  }

  const range = useMemo(() => dateRangeFor(period, fromDate || undefined, toDate || undefined), [period, fromDate, toDate])
  const filtered = useMemo(() => filterEntriesInRange(entries, range.from, range.to), [entries, range])
  const summary = useMemo(() => summarizeEntries(filtered), [filtered])

  const byWorker = useMemo(() => hoursByWorker(filtered, workers), [filtered, workers])
  const byClient = useMemo(() => hoursByClient(filtered, clients), [filtered, clients])

  // ---- Finance for the same range (subscriptions + payroll + bills) ----
  // Only ever computed when the Finance section is visible to this account;
  // the ledger arrives empty for everyone else anyway.
  const finance = useMemo(() => {
    if (!showFinance) return null
    const monthsInRange = monthKeysBetween(range.from, range.to)
    const fromT = range.from.getTime()
    const toT = range.to.getTime()
    const dueInRange = (iso: string) => {
      const t = new Date(`${iso.slice(0, 10)}T12:00:00`).getTime()
      return t >= fromT && t <= toT
    }
    let subsBilled = 0
    let payrollTotal = 0
    let billsTotal = 0
    let paidTotal = 0
    let unpaidTotal = 0
    const agenda: typeof financeItems = []
    for (const item of financeItems) {
      if (item.kind === 'subscription') {
        // Active subs bill once per cycle; count the ones whose next bill
        // date falls in the range, plus the standing monthly run-rate.
        if (item.status === 'active' && dueInRange(item.due_date)) {
          subsBilled += item.amount
          unpaidTotal += item.amount
          agenda.push(item)
        }
      } else if (item.kind === 'payroll') {
        if (item.period_month && monthsInRange.includes(item.period_month)) {
          payrollTotal += item.amount
          if (item.status === 'paid') paidTotal += item.amount
          else unpaidTotal += item.amount
          if (item.status !== 'paid') agenda.push(item)
        }
      } else if (dueInRange(item.due_date)) {
        billsTotal += item.amount
        if (item.status === 'paid') paidTotal += item.amount
        else unpaidTotal += item.amount
        agenda.push(item)
      }
    }
    agenda.sort((a, b) => a.due_date.localeCompare(b.due_date))
    const chartMonths = financeChartMonths(range)
    const chart = financeByMonth(financeItems, chartMonths).map((r) => ({
      ...r,
      label: r.month.slice(5) + '/' + r.month.slice(2, 4),
    }))
    return {
      subsPerMonth: subscriptionsPerMonth(financeItems),
      subsBilled: Math.round(subsBilled * 100) / 100,
      payrollTotal: Math.round(payrollTotal * 100) / 100,
      billsTotal: Math.round(billsTotal * 100) / 100,
      grandTotal: Math.round((subsBilled + payrollTotal + billsTotal) * 100) / 100,
      paidTotal: Math.round(paidTotal * 100) / 100,
      unpaidTotal: Math.round(unpaidTotal * 100) / 100,
      agenda,
      chart,
    }
  }, [showFinance, financeItems, range])

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

  // Each slice keeps its client's colour tag, so the chart matches the badges
  // on the board and the entries list.
  const clientChartData = useMemo(
    () =>
      byClient.map((c) => ({
        name: c.label,
        hours: Math.round(c.hours * 100) / 100,
        fill: c.client ? ClientColorStyles[c.client.color].chart : '#94a3b8',
      })),
    [byClient]
  )

  const workerChartData = useMemo(
    () => byWorker.map((w) => ({ name: w.worker.name.split(' ')[0], hours: Math.round(w.hours * 100) / 100, earnings: Math.round(w.earnings * 100) / 100 })),
    [byWorker]
  )

  function exportCSV() {
    // Escape a value for CSV: quote it and double any embedded quotes so
    // notes with commas/quotes/newlines survive the round-trip.
    const cell = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const line = (cells: (string | number)[]) => cells.map(cell).join(',')

    const rangeLabel = `${range.from.toLocaleDateString()} - ${range.to.toLocaleDateString()}`

    // ---- Per-worker totals (time + earnings), plus a grand total ----
    const perWorker = byWorker.map((w) => ({
      name: w.worker.name,
      sessions: w.sessions,
      minutes: Math.round(w.hours * 60),
      hours: w.hours,
      earnings: w.earnings,
      rate: w.hours > 0 ? w.earnings / w.hours : 0,
    }))
    const totalMinutes = perWorker.reduce((a, w) => a + w.minutes, 0)
    const totalHours = perWorker.reduce((a, w) => a + w.hours, 0)
    const totalEarnings = perWorker.reduce((a, w) => a + w.earnings, 0)
    const totalSessions = perWorker.reduce((a, w) => a + w.sessions, 0)

    const lines: string[] = []
    lines.push(line([`${settings?.business_name || 'Work Tracker'} — Time & Earnings Report`]))
    lines.push(line([`Period: ${period}`, rangeLabel]))
    lines.push(line([`Currency: ${currency}`]))
    lines.push('')

    lines.push(line(['TOTALS PER WORKER']))
    lines.push(line(['Worker', 'Sessions', 'Total Time', 'Total Hours', 'Avg Rate', 'Total Earnings']))
    for (const w of perWorker) {
      lines.push(line([
        w.name,
        w.sessions,
        formatMinutes(w.minutes),
        w.hours.toFixed(2),
        w.rate.toFixed(2),
        w.earnings.toFixed(2),
      ]))
    }
    lines.push(line([
      'ALL WORKERS (TOTAL)',
      totalSessions,
      formatMinutes(totalMinutes),
      totalHours.toFixed(2),
      (totalHours > 0 ? totalEarnings / totalHours : 0).toFixed(2),
      totalEarnings.toFixed(2),
    ]))
    lines.push('')

    // ---- Detailed entries ----
    lines.push(line(['DETAILED ENTRIES']))
    lines.push(line(['Date', 'Worker', 'Client', 'Start', 'End', 'Break (min)', 'Hours', 'Rate', 'Earnings', 'Notes']))
    const sorted = [...filtered].sort((a, b) => a.start_time.localeCompare(b.start_time))
    for (const e of sorted) {
      const w = workers.find((x) => x.id === e.worker_id)?.name || 'Unknown'
      lines.push(line([
        new Date(e.start_time).toLocaleDateString(),
        w,
        clients.find((c) => c.id === e.client_id)?.name || e.project || '',
        new Date(e.start_time).toLocaleTimeString(),
        new Date(e.end_time).toLocaleTimeString(),
        e.break_minutes,
        (e.total_minutes / 60).toFixed(2),
        e.hourly_rate.toFixed(2),
        e.earnings.toFixed(2),
        (e.notes || '').replace(/\r?\n/g, ' '),
      ]))
    }
    lines.push(line(['', 'TOTAL', '', '', '', '', totalHours.toFixed(2), '', totalEarnings.toFixed(2), '']))

    // ---- Finance (only when the Finance section is open to this account) ----
    if (finance && financeItems.length > 0) {
      lines.push('')
      lines.push(line(['FINANCE — SUBSCRIPTIONS']))
      lines.push(line(['Name', 'Amount', 'Cycle', 'Next due', 'Status']))
      for (const s of financeItems.filter((f) => f.kind === 'subscription')) {
        lines.push(line([s.name || '', s.amount.toFixed(2), s.cycle || 'monthly', s.due_date, s.status]))
      }
      lines.push(line(['Subscriptions per month (annual divided by 12)', finance.subsPerMonth.toFixed(2)]))
      lines.push(line(['Billed in period', finance.subsBilled.toFixed(2)]))
      lines.push('')
      lines.push(line(['FINANCE — PAYROLL & BILLS']))
      lines.push(line(['Type', 'Who / what', 'Month', 'Due', 'Amount', 'Status']))
      const ledgerRows = financeItems
        .filter((f) => f.kind === 'payroll' || f.kind === 'bill')
        .sort((a, b) => a.due_date.localeCompare(b.due_date))
      for (const f of ledgerRows) {
        lines.push(line([
          f.kind,
          f.kind === 'payroll' ? workers.find((w) => w.id === f.worker_id)?.name || 'Worker' : f.name || '',
          f.period_month || '',
          f.due_date,
          f.amount.toFixed(2),
          f.status,
        ]))
      }
      lines.push(line(['Payroll in period', '', '', '', finance.payrollTotal.toFixed(2), '']))
      lines.push(line(['Bills due in period', '', '', '', finance.billsTotal.toFixed(2), '']))
      lines.push(line(['TOTAL FINANCE IN PERIOD', '', '', '', finance.grandTotal.toFixed(2), '']))
    }

    // BOM so Excel opens UTF-8 (currency/accents) correctly.
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
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
          {rangeStartsEarlier && oldestEntryTime && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              <span className="text-amber-700 dark:text-amber-400">
                Only entries from {new Date(oldestEntryTime).toLocaleDateString()} are loaded — totals would be incomplete.
              </span>
              <Button size="sm" variant="outline" onClick={loadOlderForRange} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : 'Load older entries'}
              </Button>
            </div>
          )}
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

        {/* Hours by client */}
        <Card>
          <CardHeader><CardTitle className="text-base">Hours by client</CardTitle></CardHeader>
          <CardContent>
            {dataLoading ? <Skeleton className="h-64" /> : clientChartData.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">No data for this period.</p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie data={clientChartData} dataKey="hours" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                    {clientChartData.map((c, i) => <Cell key={i} fill={c.fill} />)}
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
              <h4 className="mb-2 text-sm font-semibold">Hours &amp; earnings per client</h4>
              {byClient.length === 0 ? (
                <p className="text-sm text-muted-foreground">No data.</p>
              ) : (
                <div className="space-y-1.5 text-sm">
                  {byClient.map((c) => (
                    <div key={c.key} className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
                      <span className="flex min-w-0 items-center gap-2 font-medium">
                        <ClientDot client={c.client} />
                        <span className="truncate">{c.label}</span>
                      </span>
                      <span className="whitespace-nowrap text-muted-foreground">{formatMinutes(c.hours * 60)} · {money(c.earnings, currency)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Finance — subscriptions, payroll and bills for the same period.
            Only rendered when the Finance section is open to this account
            and there is actually a ledger to summarize. */}
        {finance && financeItems.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Landmark className="h-4 w-4" /> Finance
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Subscriptions</p>
                  <p className="font-semibold">{money(finance.subsBilled, currency)}</p>
                  <p className="text-xs text-muted-foreground">{money(finance.subsPerMonth, currency)} / month run-rate</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Payroll</p>
                  <p className="font-semibold">{money(finance.payrollTotal, currency)}</p>
                  <p className="text-xs text-muted-foreground">runs covering these months</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Bills</p>
                  <p className="font-semibold">{money(finance.billsTotal, currency)}</p>
                  <p className="text-xs text-muted-foreground">due inside the period</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Total out</p>
                  <p className="font-semibold">{money(finance.grandTotal, currency)}</p>
                  <p className="text-xs text-muted-foreground">{money(finance.unpaidTotal, currency)} still open</p>
                </div>
              </div>

              {finance.chart.length > 0 && (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={finance.chart}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="label" fontSize={12} />
                    <YAxis fontSize={12} />
                    <Tooltip formatter={(v: number, key: string) => [money(v, currency), key === 'subscriptions' ? 'Subscriptions' : key === 'payroll' ? 'Payroll' : 'Bills']} />
                    <Legend />
                    <Bar dataKey="subscriptions" stackId="costs" fill="#8b5cf6" />
                    <Bar dataKey="payroll" stackId="costs" fill="#3b82f6" />
                    <Bar dataKey="bills" stackId="costs" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}

              <div>
                <h4 className="mb-2 text-sm font-semibold">Lines due or billed in the period</h4>
                {finance.agenda.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing due in this period.</p>
                ) : (
                  <div className="space-y-1.5 text-sm">
                    {finance.agenda.map((f) => {
                      const days = daysUntil(f.due_date)
                      return (
                        <div key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2">
                          <span className="flex min-w-0 items-center gap-2 font-medium">
                            <span className="truncate">{f.kind === 'payroll' ? `${workers.find((w) => w.id === f.worker_id)?.name || 'Worker'} — payroll` : f.name || f.kind}</span>
                            <Badge variant="muted" className="capitalize">{f.kind}</Badge>
                          </span>
                          <span className="whitespace-nowrap text-muted-foreground">
                            {money(f.amount, currency)} · {formatDate(f.due_date)}
                            <span className={days < 0 ? 'text-destructive' : ''}> ({dueLabel(days).toLowerCase()})</span>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
