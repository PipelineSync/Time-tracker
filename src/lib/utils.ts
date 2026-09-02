import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { ActiveTimer } from './types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const rem = m % 60
  return `${h}h ${rem}m`
}

export function formatHoursDecimal(hours: number): string {
  return hours.toFixed(2)
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

export function formatDate(d: string | Date): string {
  return new Date(d).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function formatTime(d: string | Date): string {
  return new Date(d).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatDateTime(d: string | Date): string {
  return `${formatDate(d)} ${formatTime(d)}`
}

export function formatDurationFromMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/** Elapsed working time for an active timer, honoring pauses. */
export function timerElapsedMs(timer: ActiveTimer, now: Date): number {
  const start = new Date(timer.start_time).getTime()
  let elapsed = now.getTime() - start - (timer.total_pause_ms || 0)
  if (timer.paused && timer.pause_start) {
    // While paused, freeze at the moment the pause began.
    elapsed = new Date(timer.pause_start).getTime() - start - (timer.total_pause_ms || 0)
  }
  return Math.max(0, elapsed)
}

/** Total break time so far for an active timer, including a break in progress. */
export function timerBreakMs(timer: ActiveTimer, now: Date): number {
  let ms = timer.total_pause_ms || 0
  if (timer.paused && timer.pause_start) {
    ms += Math.max(0, now.getTime() - new Date(timer.pause_start).getTime())
  }
  return Math.max(0, ms)
}

/** Short "1h 05m" style label for a duration in milliseconds. */
export function formatMsShort(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000))
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** Initials for an avatar bubble. */
export function initials(name?: string | null): string {
  if (!name) return '?'
  return name.trim().split(/\s+/).map((n) => n[0]).slice(0, 2).join('').toUpperCase() || '?'
}

/** Compute total minutes for an entry, correctly handling sessions crossing midnight. */
export function computeTotalMinutes(start: Date, end: Date, breakMinutes: number): number {
  let diffMs = end.getTime() - start.getTime()
  // If end is before start (or zero-diff after midnight crossing), assume +1 day.
  if (diffMs < 0) diffMs += 24 * 60 * 60 * 1000
  let minutes = diffMs / 60000
  minutes -= Math.max(0, breakMinutes)
  return Math.max(0, minutes)
}

export function minutesToHours(minutes: number): number {
  return minutes / 60
}

export function computeEarnings(totalMinutes: number, hourlyRate: number): number {
  return Math.round(minutesToHours(totalMinutes) * hourlyRate * 100) / 100
}

export function toISO(d: Date): string {
  return d.toISOString()
}
