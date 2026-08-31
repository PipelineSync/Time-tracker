import type { TimeEntry, Worker } from './types'
import { minutesToHours } from './utils'

export function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

export function startOfWeek(): Date {
  // Week starts Monday.
  const d = startOfToday()
  const day = d.getDay() // 0=Sun
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d
}

export function startOfMonth(): Date {
  const d = startOfToday()
  d.setDate(1)
  return d
}

export function dateRangeFor(period: 'today' | 'week' | 'month' | 'custom', from?: string, to?: string) {
  switch (period) {
    case 'today': {
      const s = startOfToday()
      return { from: s, to: new Date(s.getTime() + 24 * 60 * 60 * 1000 - 1) }
    }
    case 'week': {
      const s = startOfWeek()
      return { from: s, to: new Date(s.getTime() + 7 * 24 * 60 * 60 * 1000 - 1) }
    }
    case 'month': {
      const s = startOfMonth()
      return { from: s, to: new Date(s.getTime() + 30 * 24 * 60 * 60 * 1000 - 1) }
    }
    case 'custom': {
      const f = from ? new Date(from) : startOfToday()
      f.setHours(0, 0, 0, 0)
      const t = to ? new Date(to) : new Date()
      t.setHours(23, 59, 59, 999)
      return { from: f, to: t }
    }
  }
}

export function filterEntriesInRange(entries: TimeEntry[], from: Date, to: Date): TimeEntry[] {
  return entries.filter((e) => {
    const t = new Date(e.start_time).getTime()
    return t >= from.getTime() && t <= to.getTime()
  })
}

export function summarizeEntries(entries: TimeEntry[]) {
  let totalMinutes = 0
  let earnings = 0
  for (const e of entries) {
    totalMinutes += e.total_minutes
    earnings += e.earnings
  }
  const hours = minutesToHours(totalMinutes)
  const avgRate = totalMinutes > 0 ? earnings / hours : 0
  return {
    totalMinutes,
    hours,
    earnings,
    sessions: entries.length,
    avgRate,
  }
}

export function hoursByWorker(entries: TimeEntry[], workers: Worker[]) {
  const map = new Map<string, { hours: number; earnings: number; sessions: number }>()
  for (const e of entries) {
    const cur = map.get(e.worker_id) || { hours: 0, earnings: 0, sessions: 0 }
    cur.hours += minutesToHours(e.total_minutes)
    cur.earnings += e.earnings
    cur.sessions += 1
    map.set(e.worker_id, cur)
  }
  return workers
    .map((w) => ({
      worker: w,
      hours: map.get(w.id)?.hours || 0,
      earnings: map.get(w.id)?.earnings || 0,
      sessions: map.get(w.id)?.sessions || 0,
    }))
    .filter((x) => x.sessions > 0)
    .sort((a, b) => b.hours - a.hours)
}

export function hoursByProject(entries: TimeEntry[]) {
  const map = new Map<string, { hours: number; earnings: number; sessions: number }>()
  for (const e of entries) {
    const key = e.project || 'Untitled'
    const cur = map.get(key) || { hours: 0, earnings: 0, sessions: 0 }
    cur.hours += minutesToHours(e.total_minutes)
    cur.earnings += e.earnings
    cur.sessions += 1
    map.set(key, cur)
  }
  return Array.from(map.entries())
    .map(([project, v]) => ({ project, ...v }))
    .sort((a, b) => b.hours - a.hours)
}
