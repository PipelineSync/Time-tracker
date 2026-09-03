import type { ActiveTimer } from './types'

/** `01:23:45` — the live timer in the popup. */
export function formatDurationFromMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/** `8h 05m` — same wording the web app uses for a finished entry. */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const rem = m % 60
  return `${h}h ${rem}m`
}

/** `2h 04m` for a duration in milliseconds (live break counter). */
export function formatMsShort(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000))
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `$${amount.toFixed(2)}`
  }
}

export function formatClockTime(d: string | Date): string {
  return new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Worked time on a running timer, breaks excluded (frozen while on break). */
export function timerElapsedMs(timer: ActiveTimer, now: Date): number {
  const start = new Date(timer.start_time).getTime()
  const banked = timer.total_pause_ms || 0
  if (timer.paused && timer.pause_start) {
    return Math.max(0, new Date(timer.pause_start).getTime() - start - banked)
  }
  return Math.max(0, now.getTime() - start - banked)
}

/** Total break time, including a break that is still running. */
export function timerBreakMs(timer: ActiveTimer, now: Date): number {
  let ms = timer.total_pause_ms || 0
  if (timer.paused && timer.pause_start) {
    ms += Math.max(0, now.getTime() - new Date(timer.pause_start).getTime())
  }
  return Math.max(0, ms)
}

/** Minutes worked on a finished session, the same way the web app rounds. */
export function computeEarnings(totalMinutes: number, hourlyRate: number): number {
  return Math.round((totalMinutes / 60) * hourlyRate * 100) / 100
}
