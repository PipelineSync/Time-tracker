import type { Worker, TimeEntry, Settings } from './types'
import { uid } from './utils'

/**
 * A tiny fake QR-code image for demo data. It is not a scannable QR code —
 * just a deterministic QR-looking square so the admin payments page has a
 * picture to display in local demo mode (real uploads happen via Settings).
 */
export function demoQrDataUrl(seed: string): string {
  const n = 21 // QR-version-1 style grid
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const cell = (x: number, y: number) => {
    h = (h * 1103515245 + 12345 + x * 131 + y * 17) >>> 0
    return (h >> 8) & 1
  }
  const inFinder = (x: number, y: number) =>
    (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7)
  let rects = ''
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (inFinder(x, y)) continue
      if (cell(x, y)) rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`
    }
  }
  const finder = (fx: number, fy: number) =>
    `<rect x="${fx}" y="${fy}" width="7" height="7" fill="black"/>` +
    `<rect x="${fx + 1}" y="${fy + 1}" width="5" height="5" fill="white"/>` +
    `<rect x="${fx + 2}" y="${fy + 2}" width="3" height="3" fill="black"/>`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="white"/>` +
    `<g fill="black">${rects}${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}</g>` +
    `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/**
 * Builds a deterministic-ish set of demo data relative to "today" so the
 * dashboard and reports look populated. All hours are reasonable daytimes.
 */
export function buildDemoSeed() {
  const day = 24 * 60 * 60 * 1000

  function at(offsetDays: number, hour: number, minute = 0): Date {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    d.setHours(hour, minute, 0, 0)
    return d
  }

  const daysAgo = (n: number) => new Date(Date.now() - n * day)

  const nowIso = () => new Date().toISOString()

  const workers: Worker[] = [
    { id: 'w-seed-1', name: 'John Smith', email: 'john@example.com', hourly_rate: 20, status: 'active', position: 'Team member', avatar_url: null, payment_methods: ['cash'], qr_code_url: null, created_at: daysAgo(40).toISOString(), updated_at: daysAgo(40).toISOString() },
    { id: 'w-seed-2', name: 'Sarah Johnson', email: 'sarah@example.com', hourly_rate: 25, status: 'active', position: 'Team member', avatar_url: null, payment_methods: ['cash', 'qr'], qr_code_url: demoQrDataUrl('sarah@example.com'), created_at: daysAgo(30).toISOString(), updated_at: daysAgo(30).toISOString() },
    { id: 'w-seed-3', name: 'Mike Brown', email: 'mike@example.com', hourly_rate: 18, status: 'inactive', position: 'Team member', avatar_url: null, payment_methods: ['qr'], qr_code_url: demoQrDataUrl('mike@example.com'), created_at: daysAgo(20).toISOString(), updated_at: daysAgo(20).toISOString() },
  ]

  function entry(worker_id: string, start: Date, end: Date, project: string | null, break_minutes: number, notes: string | null, hourly_rate: number): TimeEntry {
    const totalMinutes = Math.round((end.getTime() - start.getTime()) / 60000) - break_minutes
    const earnings = Math.round((Math.max(0, totalMinutes) / 60) * hourly_rate * 100) / 100
    const created = start.toISOString()
    return {
      id: 'e-' + uid(),
      worker_id,
      project,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      break_minutes,
      notes,
      hourly_rate,
      total_minutes: Math.max(0, totalMinutes),
      earnings,
      created_at: created,
      updated_at: created,
    }
  }

  const entries: TimeEntry[] = [
    // Today
    entry('w-seed-1', at(0, 8, 0), at(0, 12, 0), 'Website Redesign', 15, 'Morning block on landing page', 20),
    entry('w-seed-1', at(0, 13, 0), at(0, 16, 30), 'Website Redesign', 30, 'Afternoon – build components', 20),
    entry('w-seed-2', at(0, 9, 0), at(0, 13, 0), 'Client Meeting Prep', 0, 'Prep and call with client', 25),
    // Yesterday
    entry('w-seed-1', at(-1, 9, 0), at(-1, 13, 0), 'Website Redesign', 30, 'Wireframes', 20),
    entry('w-seed-2', at(-1, 10, 0), at(-1, 14, 0), 'Marketing Content', 15, 'Wrote blog drafts', 25),
    // Earlier this week
    entry('w-seed-3', at(-3, 8, 30), at(-3, 15, 0), 'Inventory Audit', 45, 'Counted stock', 18),
    entry('w-seed-1', at(-4, 8, 0), at(-4, 12, 30), 'Support Tickets', 0, 'Resolved customer issues', 20),
    // Last month
    entry('w-seed-2', at(-20, 9, 0), at(-20, 17, 0), 'Q3 Report', 60, 'Compiled quarterly numbers', 25),
    entry('w-seed-1', at(-22, 10, 0), at(-22, 14, 30), 'Training', 30, 'Onboarding session', 20),
  ]

  const settings: Settings = {
    id: 'settings-1',
    business_name: 'My Business',
    currency: 'USD',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    default_hourly_rate: 20,
    avatar_url: null,
  }

  return { workers, entries, settings }
}

// Re-export uid for convenience
export { uid }
