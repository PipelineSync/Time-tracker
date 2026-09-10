import { useEffect, useState } from 'react'
import { formatDurationFromMs, timerElapsedMs } from '@/lib/utils'
import type { ActiveTimer } from '@/lib/types'

/**
 * Big monospace clock readout.
 *
 * Two modes:
 * - `ms` (and optional `running`): static — the parent computes and passes
 *   the value.
 * - `timer`: self-ticking — the component owns a 1 s interval (only while
 *   the timer is actually running, i.e. not on break), so the PARENT never
 *   re-renders every second. TrackerPage used to tick page-level state each
 *   second, re-rendering the whole screen (buttons, dialogs, client badge)
 *   60× a minute on a phone; only this readout actually needed the tick.
 */
export function TimerDisplay({ ms, running, timer }: { ms?: number; running?: boolean; timer?: ActiveTimer | null }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // No interval while paused: the worked time is frozen at the pause
    // moment (timerElapsedMs already clamps to pause_start), so ticking
    // would just burn battery redrawing the same number.
    if (!timer || timer.paused) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [timer])

  const displayMs = timer ? timerElapsedMs(timer, new Date(now)) : (ms ?? 0)

  return (
    <div className="relative">
      {(running ?? !!(timer && !timer.paused)) && (
        <span className="absolute -left-5 top-1/2 h-3 w-3 -translate-y-1/2 animate-pulse rounded-full bg-[#F77A0A]" aria-hidden />
      )}
      <div className="font-mono text-5xl font-bold tracking-tight tabular-nums sm:text-6xl">
        {formatDurationFromMs(displayMs)}
      </div>
    </div>
  )
}
