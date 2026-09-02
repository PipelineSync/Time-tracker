import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Coffee, Radio, UserRound } from 'lucide-react'
import { cn, formatDateTime, formatMsShort, initials, timerBreakMs, timerElapsedMs } from '@/lib/utils'
import type { ActiveTimer, Worker } from '@/lib/types'

interface Row {
  timer: ActiveTimer
  worker: Worker | null
  name: string
  onBreak: boolean
  workedMs: number
  breakMs: number
}

/**
 * Live "who is on the clock right now" panel for the admin: every worker with a
 * running timer, whether they are working or on a break, and for how long.
 */
export function ActiveWorkersPanel() {
  const { activeTimers, workers, dataLoading } = useStore()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const rows: Row[] = useMemo(() => {
    const d = new Date(now)
    return activeTimers
      .map((timer) => {
        const worker = workers.find((w) => w.id === timer.worker_id) || null
        return {
          timer,
          worker,
          name: worker?.name || 'Unknown worker',
          onBreak: !!timer.paused,
          workedMs: timerElapsedMs(timer, d),
          breakMs: timerBreakMs(timer, d),
        }
      })
      // On break first (they need attention), then longest on the clock.
      .sort((a, b) => {
        if (a.onBreak !== b.onBreak) return a.onBreak ? -1 : 1
        return a.timer.start_time.localeCompare(b.timer.start_time)
      })
  }, [activeTimers, workers, now])

  const workingCount = rows.filter((r) => !r.onBreak).length
  const breakCount = rows.filter((r) => r.onBreak).length

  return (
    <Card className={cn(rows.length > 0 && 'border-primary/40 bg-primary/5')}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Radio className="h-4 w-4" /> On the clock now
        </CardTitle>
        <div className="flex items-center gap-2">
          {workingCount > 0 && (
            <Badge className="gap-1 border-transparent bg-[#F77A0A] text-white">
              {workingCount} working
            </Badge>
          )}
          {breakCount > 0 && (
            <Badge className="gap-1 border-transparent bg-[#36B7C9] text-white">
              <Coffee className="h-3 w-3" /> {breakCount} on break
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {dataLoading && rows.length === 0 ? (
          <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : rows.length === 0 ? (
          <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <UserRound className="h-4 w-4" /> Nobody is clocked in right now.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r) => (
              <div key={r.timer.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="relative flex h-3 w-3 shrink-0" title={r.onBreak ? 'On break' : 'Working'}>
                    <span
                      className={cn(
                        'absolute inline-flex h-full w-full animate-ping rounded-full opacity-75',
                        r.onBreak ? 'bg-[#36B7C9]' : 'bg-[#F77A0A]'
                      )}
                    />
                    <span className={cn('relative inline-flex h-3 w-3 rounded-full', r.onBreak ? 'bg-[#36B7C9]' : 'bg-[#F77A0A]')} />
                  </span>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {initials(r.worker?.name)}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-semibold">{r.name}</p>
                      {r.onBreak ? (
                        <Badge className="gap-1 border-transparent bg-[#36B7C9]/15 text-[#0d7c8c] dark:text-[#7fdbe8]">
                          <Coffee className="h-3 w-3" /> On break
                        </Badge>
                      ) : (
                        <Badge className="border-transparent bg-[#F77A0A]/15 text-[#b85c05] dark:text-[#ffb066]">Working</Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      Since {formatDateTime(r.timer.start_time)}
                      {r.timer.project ? ` · ${r.timer.project}` : ''}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-mono text-sm font-semibold">{formatMsShort(r.workedMs)}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.onBreak ? `On break ${formatMsShort(r.breakMs)}` : r.breakMs >= 60000 ? `Breaks ${formatMsShort(r.breakMs)}` : 'No breaks yet'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      {rows.length > 0 && (
        <CardContent className="pt-0">
          <Link to="/workers"><Button variant="outline" size="sm">Manage workers</Button></Link>
        </CardContent>
      )}
    </Card>
  )
}
