import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
  LineChart,
  Line,
} from 'recharts'
import type { ClientHoursRow, EmployeeKpi } from '@/lib/kpi'
import { fmtHours, fmtPct, monthShortLabel, WORKLOAD_LABELS } from '@/lib/kpi'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/** First name (or a sensible slice) so axis labels stay short. */
function shortName(name: string): string {
  const first = name.split(' ')[0]
  return first && first.length <= 10 ? first : name.slice(0, 10)
}

function scoreColor(score: number | null): string {
  if (score === null) return '#94a3b8'
  if (score >= 90) return '#10b981'
  if (score >= 75) return '#f59e0b'
  return '#ef4444'
}

const WORKLOAD_HEX: Record<string, string> = {
  available: '#10b981',
  normal: '#3b82f6',
  high: '#f59e0b',
  overloaded: '#ef4444',
}

/** Bar chart: KPI Score by Employee (§7 left chart). */
export function KpiScoreByEmployeeChart({ employees }: { employees: EmployeeKpi[] }) {
  const data = employees.map((e) => ({
    name: shortName(e.worker.name),
    score: e.score ?? 0,
    has: e.score !== null,
  }))
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">KPI Score by Employee</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No employees in scope.</p>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis dataKey="name" fontSize={12} interval={0} />
              <YAxis domain={[0, 100]} fontSize={12} />
              <Tooltip formatter={(v: number) => [`${v}`, 'KPI score']} />
              <Bar dataKey="score" radius={[4, 4, 0, 0]}>
                {data.map((d, i) => (
                  <Cell key={i} fill={d.has ? scoreColor(d.score) : '#94a3b8'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
        <p className="mt-1 text-center text-[11px] text-muted-foreground">
          30% on-time · 30% QA · 25% goal · 15% rework — green ≥90, amber 75–89, red &lt;75
        </p>
      </CardContent>
    </Card>
  )
}

/** Bar chart: schedule-aware Workload by Employee (§5/§7 right chart). */
export function WorkloadByEmployeeChart({ employees }: { employees: EmployeeKpi[] }) {
  const data = employees.map((e) => ({
    name: shortName(e.worker.name),
    pct: e.workload.pct ?? 0,
    has: e.workload.pct !== null,
    level: e.workload.level,
  }))
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Workload by Employee</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No employees in scope.</p>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis dataKey="name" fontSize={12} interval={0} />
              <YAxis domain={[0, 'dataMax']} fontSize={12} unit="%" />
              <Tooltip formatter={(v: number, _n, item) => {
                const level = item?.payload?.level
                const label = level && level in WORKLOAD_LABELS ? WORKLOAD_LABELS[level as keyof typeof WORKLOAD_LABELS].label : 'Workload'
                return [`${v}%`, label]
              }} />
              <Bar dataKey="pct" radius={[4, 4, 0, 0]}>
                {data.map((d, i) => (
                  <Cell
                    key={i}
                    fill={d.has ? WORKLOAD_HEX[String(d.level)] ?? '#3b82f6' : '#94a3b8'}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
        <p className="mt-1 text-center text-[11px] text-muted-foreground">
          Open estimated hours ÷ available hours on each person’s own workweek — &lt;60% available · 60–80 normal · 81–100 high · &gt;100 overloaded
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * Grouped bar chart: Estimated vs Logged hours per client over everything
 * currently in scope (open + completed tasks, logged time of scoped
 * employees). Clicking a bar drills into that client's source tasks.
 */
export function HoursByClientChart({
  rows,
  onDrill,
  className,
}: {
  rows: ClientHoursRow[]
  /** Pass a clientId (null = unassigned) for a per-client drill. */
  onDrill?: (clientId: string | null) => void
  className?: string
}) {
  const data = rows.map((r) => ({
    clientId: r.clientId,
    name: shortName(r.name),
    estimated: r.estimated,
    actual: r.actual,
  }))
  const empty = data.length === 0 || data.every((d) => d.estimated <= 0 && d.actual <= 0)
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">Hours by Client</CardTitle>
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No hours in scope yet.</p>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis dataKey="name" fontSize={12} interval={0} />
              <YAxis fontSize={12} />
              <Tooltip formatter={(v: number, name: string) => [fmtHours(v), name === 'estimated' ? 'Estimated' : 'Logged']} />
              <Bar dataKey="estimated" name="estimated" radius={[4, 4, 0, 0]} cursor={onDrill ? 'pointer' : undefined}>
                {data.map((d, i) => (
                  <Cell
                    key={i}
                    fill="#8b5cf6"
                    onClick={onDrill ? () => onDrill(d.clientId) : undefined}
                  />
                ))}
              </Bar>
              <Bar dataKey="actual" name="actual" radius={[4, 4, 0, 0]} cursor={onDrill ? 'pointer' : undefined}>
                {data.map((d, i) => (
                  <Cell
                    key={i}
                    fill="#3b82f6"
                    onClick={onDrill ? () => onDrill(d.clientId) : undefined}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
        <p className="mt-1 text-center text-[11px] text-muted-foreground">
          <span className="text-violet-500">■</span> Estimated = task-board estimates (open + completed in scope)
          &nbsp; <span className="text-blue-500">■</span> Logged = time entries of the scoped team
          {onDrill ? ' · click a bar for that client’s tasks' : ''}
        </p>
      </CardContent>
    </Card>
  )
}

export interface TrendPoint {
  month: string
  score: number | null
  onTime: number | null
}

/** Monthly KPI Trend — team score + on-time over the last months. */
export function MonthlyKpiTrendChart({ points }: { points: TrendPoint[] }) {
  const data = points.map((p) => ({
    label: monthShortLabel(p.month),
    score: p.score ?? 0,
    onTime: p.onTime ?? 0,
    hasScore: p.score !== null,
    hasOnTime: p.onTime !== null,
  }))
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Monthly KPI Trend</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No history yet.</p>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis dataKey="label" fontSize={12} />
              <YAxis domain={[0, 100]} fontSize={12} unit="%" />
              <Tooltip formatter={(v: number, name: string) => [fmtPct(v), name === 'score' ? 'Team KPI score' : 'On-time']} />
              <Line type="monotone" dataKey="score" stroke="#22c55e" strokeWidth={2} dot={{ r: 3 }} name="score" />
              <Line type="monotone" dataKey="onTime" stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} name="onTime" />
            </LineChart>
          </ResponsiveContainer>
        )}
        <p className="mt-1 text-center text-[11px] text-muted-foreground">
          <span className="text-emerald-600">●</span> Team KPI score &nbsp;
          <span className="text-sky-600">●</span> On-time completion
        </p>
      </CardContent>
    </Card>
  )
}
