import type { Worker, TimeEntry, Settings, Client, ClientPriority, Meeting, Task, FinanceItem } from './types'
import { PERMISSION_PRESETS } from './types'
import { toISODate } from './finance'
import { uid } from './utils'

/** Local 'YYYY-MM-DD' for a date, `at` days from today. */
function dateOffset(at: number): string {
  return toISODate(new Date(Date.now() + at * 24 * 60 * 60 * 1000))
}

/** 'YYYY-MM' `shift` months before/after the current one. */
function monthOffset(shift: number): { ym: string; label: string } {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth() + shift, 1)
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { ym, label: toISODate(lastDay) }
}

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

  // Sarah doubles as the permissions demo: the admin has given her the
  // Supervisor set, so signing in as her shows the team board and team time
  // without any of the money screens.
  const workers: Worker[] = [
    { id: 'w-seed-1', name: 'John Smith', email: 'john@example.com', hourly_rate: 20, status: 'active', position: 'Team member', avatar_url: null, payment_methods: ['cash'], qr_code_url: null, permissions: [], created_at: daysAgo(40).toISOString(), updated_at: daysAgo(40).toISOString() },
    { id: 'w-seed-2', name: 'Sarah Johnson', email: 'sarah@example.com', hourly_rate: 25, status: 'active', position: 'Team member', avatar_url: null, payment_methods: ['cash', 'qr'], qr_code_url: demoQrDataUrl('sarah@example.com'), permissions: [...PERMISSION_PRESETS.supervisor.permissions], created_at: daysAgo(30).toISOString(), updated_at: daysAgo(30).toISOString() },
    { id: 'w-seed-3', name: 'Mike Brown', email: 'mike@example.com', hourly_rate: 18, status: 'inactive', position: 'Team member', avatar_url: null, payment_methods: ['qr'], qr_code_url: demoQrDataUrl('mike@example.com'), permissions: [], created_at: daysAgo(20).toISOString(), updated_at: daysAgo(20).toISOString() },
  ]

  // A small master list so the client dropdowns, filters and the "Hours by
  // client" chart all have something to show in demo mode.
  const clients: Client[] = [
    { id: 'c-seed-1', name: 'Acme Corp', color: 'blue', status: 'active', created_at: daysAgo(40).toISOString(), updated_at: daysAgo(40).toISOString() },
    { id: 'c-seed-2', name: 'Northwind Traders', color: 'aqua', status: 'active', created_at: daysAgo(38).toISOString(), updated_at: daysAgo(38).toISOString() },
    { id: 'c-seed-3', name: 'Globex', color: 'violet', status: 'active', created_at: daysAgo(25).toISOString(), updated_at: daysAgo(25).toISOString() },
    { id: 'c-seed-4', name: 'Internal', color: 'slate', status: 'active', created_at: daysAgo(25).toISOString(), updated_at: daysAgo(25).toISOString() },
    { id: 'c-seed-5', name: 'Initech (past project)', color: 'amber', status: 'inactive', created_at: daysAgo(60).toISOString(), updated_at: daysAgo(10).toISOString() },
  ]

  function entry(worker_id: string, start: Date, end: Date, client_id: string, project: string | null, break_minutes: number, notes: string | null, hourly_rate: number): TimeEntry {
    const totalMinutes = Math.round((end.getTime() - start.getTime()) / 60000) - break_minutes
    const earnings = Math.round((Math.max(0, totalMinutes) / 60) * hourly_rate * 100) / 100
    const created = start.toISOString()
    return {
      id: 'e-' + uid(),
      worker_id,
      client_id,
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
    entry('w-seed-1', at(0, 8, 0), at(0, 12, 0), 'c-seed-1', 'Website Redesign', 15, 'Morning block on landing page', 20),
    entry('w-seed-1', at(0, 13, 0), at(0, 16, 30), 'c-seed-1', 'Website Redesign', 30, 'Afternoon – build components', 20),
    entry('w-seed-2', at(0, 9, 0), at(0, 13, 0), 'c-seed-2', 'Client Meeting Prep', 0, 'Prep and call with client', 25),
    // Yesterday
    entry('w-seed-1', at(-1, 9, 0), at(-1, 13, 0), 'c-seed-1', 'Website Redesign', 30, 'Wireframes', 20),
    entry('w-seed-2', at(-1, 10, 0), at(-1, 14, 0), 'c-seed-3', 'Marketing Content', 15, 'Wrote blog drafts', 25),
    // Earlier this week
    entry('w-seed-3', at(-3, 8, 30), at(-3, 15, 0), 'c-seed-4', 'Inventory Audit', 45, 'Counted stock', 18),
    entry('w-seed-1', at(-4, 8, 0), at(-4, 12, 30), 'c-seed-2', 'Support Tickets', 0, 'Resolved customer issues', 20),
    // Last month
    entry('w-seed-2', at(-20, 9, 0), at(-20, 17, 0), 'c-seed-5', 'Q3 Report', 60, 'Compiled quarterly numbers', 25),
    entry('w-seed-1', at(-22, 10, 0), at(-22, 14, 30), 'c-seed-4', 'Training', 30, 'Onboarding session', 20),
  ]

  // A few board tasks so the Tasks page is populated in demo mode. One has a
  // long description on purpose: it exercises the card's "See more" clamp.
  const tasks: Task[] = [
    {
      id: 't-seed-1',
      worker_id: 'w-seed-1',
      client_id: 'c-seed-1',
      title: 'Redesign the landing page hero section',
      description:
        'Rebuild the hero with the new copy from the marketing brief. The headline should sit over the product screenshot, with the primary CTA left-aligned. Add the trust logos row below the fold, keep the section under 100 KB, and make sure it holds up at 320 px wide before we hand it to QA for a pass on the main browsers.',
      status: 'in_progress',
      priority: 'high',
      due_date: at(2, 9).toISOString().slice(0, 10),
      position: 0,
      created_by_role: 'admin',
      completed_at: null,
      created_at: daysAgo(3).toISOString(),
      updated_at: daysAgo(1).toISOString(),
    },
    {
      id: 't-seed-2',
      worker_id: 'w-seed-2',
      client_id: 'c-seed-2',
      title: 'Draft Q3 summary report',
      description: 'Compile hours and earnings by project for the quarter.',
      status: 'todo',
      priority: 'medium',
      due_date: at(6, 9).toISOString().slice(0, 10),
      position: 0,
      created_by_role: 'worker',
      completed_at: null,
      created_at: daysAgo(2).toISOString(),
      updated_at: daysAgo(2).toISOString(),
    },
    {
      id: 't-seed-3',
      worker_id: 'w-seed-1',
      client_id: 'c-seed-4',
      title: 'Fix flaky invoice export test',
      description: null,
      status: 'waiting',
      priority: 'low',
      due_date: null,
      position: 0,
      created_by_role: 'worker',
      completed_at: null,
      created_at: daysAgo(1).toISOString(),
      updated_at: daysAgo(1).toISOString(),
    },
    {
      id: 't-seed-4',
      worker_id: 'w-seed-2',
      client_id: 'c-seed-3',
      title: 'Publish the two April blog posts',
      description: 'Copy is final, just schedule and share the links in the team channel.',
      status: 'completed',
      priority: 'medium',
      due_date: at(-2, 9).toISOString().slice(0, 10),
      position: 0,
      created_by_role: 'admin',
      completed_at: daysAgo(2).toISOString(),
      created_at: daysAgo(8).toISOString(),
      updated_at: daysAgo(2).toISOString(),
    },
  ]

  const settings: Settings = {
    id: 'settings-1',
    business_name: 'My Business',
    currency: 'USD',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    default_hourly_rate: 20,
    avatar_url: null,
  }

  // Finance: a couple of subscriptions, a paid + an unpaid payroll run per
  // active worker, and one-off bills — enough that the Finance page and the
  // reports finance card show overdue / upcoming / paid states at once.
  const lastMonth = monthOffset(-1)
  const thisMonth = monthOffset(0)
  const financeItems: FinanceItem[] = [
    {
      id: 'f-seed-1', kind: 'subscription', name: 'Adobe Creative Cloud', worker_id: null,
      amount: 59.99, cycle: 'monthly', period_month: null, due_date: dateOffset(3),
      status: 'active', paid_at: null, note: 'Design tools, 3 seats',
      created_at: daysAgo(120).toISOString(), updated_at: daysAgo(24).toISOString(),
    },
    {
      id: 'f-seed-2', kind: 'subscription', name: 'QuickBooks', worker_id: null,
      amount: 38, cycle: 'monthly', period_month: null, due_date: dateOffset(-2),
      status: 'active', paid_at: null, note: null,
      created_at: daysAgo(300).toISOString(), updated_at: daysAgo(32).toISOString(),
    },
    {
      id: 'f-seed-3', kind: 'subscription', name: 'Microsoft 365', worker_id: null,
      amount: 149.99, cycle: 'yearly', period_month: null, due_date: dateOffset(46),
      status: 'active', paid_at: null, note: 'Annual licence',
      created_at: daysAgo(320).toISOString(), updated_at: daysAgo(320).toISOString(),
    },
    {
      id: 'f-seed-4', kind: 'payroll', name: null, worker_id: 'w-seed-1',
      amount: 1180, cycle: null, period_month: lastMonth.ym, due_date: lastMonth.label,
      status: 'paid', paid_at: lastMonth.label + 'T09:00:00.000Z', note: 'Cash, settled in person',
      created_at: lastMonth.ym + '-27T09:00:00.000Z', updated_at: lastMonth.label + 'T09:00:00.000Z',
    },
    {
      id: 'f-seed-5', kind: 'payroll', name: null, worker_id: 'w-seed-2',
      amount: 1450, cycle: null, period_month: lastMonth.ym, due_date: lastMonth.label,
      status: 'paid', paid_at: lastMonth.label + 'T09:00:00.000Z', note: null,
      created_at: lastMonth.ym + '-27T09:00:00.000Z', updated_at: lastMonth.label + 'T09:00:00.000Z',
    },
    {
      id: 'f-seed-6', kind: 'payroll', name: null, worker_id: 'w-seed-1',
      amount: 1240, cycle: null, period_month: thisMonth.ym, due_date: dateOffset(9),
      status: 'unpaid', paid_at: null, note: 'Payday on the 25th',
      created_at: thisMonth.ym + '-01T09:00:00.000Z', updated_at: thisMonth.ym + '-01T09:00:00.000Z',
    },
    {
      id: 'f-seed-7', kind: 'payroll', name: null, worker_id: 'w-seed-2',
      amount: 1520, cycle: null, period_month: thisMonth.ym, due_date: dateOffset(-1),
      status: 'unpaid', paid_at: null, note: null,
      created_at: thisMonth.ym + '-01T09:00:00.000Z', updated_at: thisMonth.ym + '-01T09:00:00.000Z',
    },
    {
      id: 'f-seed-8', kind: 'bill', name: 'Office rent', worker_id: null,
      amount: 900, cycle: null, period_month: null, due_date: dateOffset(12),
      status: 'unpaid', paid_at: null, note: 'Ground floor unit',
      created_at: daysAgo(20).toISOString(), updated_at: daysAgo(20).toISOString(),
    },
    {
      id: 'f-seed-9', kind: 'bill', name: 'Electricity', worker_id: null,
      amount: 118.4, cycle: null, period_month: null, due_date: dateOffset(5),
      status: 'unpaid', paid_at: null, note: null,
      created_at: daysAgo(6).toISOString(), updated_at: daysAgo(6).toISOString(),
    },
    {
      id: 'f-seed-10', kind: 'bill', name: 'Public liability insurance', worker_id: null,
      amount: 320, cycle: null, period_month: null, due_date: dateOffset(-40),
      status: 'paid', paid_at: daysAgo(41).toISOString(), note: 'Renewed for 12 months',
      created_at: daysAgo(45).toISOString(), updated_at: daysAgo(41).toISOString(),
    },
  ]

  // A starting ranking so the Client priority board is populated in demo
  // mode. Only some clients are ranked on purpose: Internal stays unranked at
  // the bottom of Low Priority, the way a real board looks mid-week.
  const clientPriorities: ClientPriority[] = [
    { id: 'cp-seed-1', client_id: 'c-seed-1', lane: 'me', position: 0, created_at: daysAgo(9).toISOString(), updated_at: daysAgo(9).toISOString() },
    { id: 'cp-seed-2', client_id: 'c-seed-2', lane: 'delegated', position: 0, created_at: daysAgo(9).toISOString(), updated_at: daysAgo(7).toISOString() },
    { id: 'cp-seed-3', client_id: 'c-seed-3', lane: 'waiting', position: 0, created_at: daysAgo(6).toISOString(), updated_at: daysAgo(6).toISOString() },
  ]

  // A partly-filled schedule so the Meetings page shows both halves: two
  // upcoming (one later today, one next week) and two past.
  const meetings: Meeting[] = [
    { id: 'm-seed-1', title: 'Weekly team stand-up', start_time: at(0, 16, 0).toISOString(), notes: 'Quick round-up: blockers, priorities for the rest of the week.', created_at: daysAgo(3).toISOString(), updated_at: daysAgo(3).toISOString() },
    { id: 'm-seed-2', title: 'Acme Corp — kick-off call', start_time: at(7, 10, 30).toISOString(), notes: 'Scope the redesign phases. Bring the wireframes.', created_at: daysAgo(2).toISOString(), updated_at: daysAgo(2).toISOString() },
    { id: 'm-seed-3', title: 'Northwind Traders — monthly review', start_time: at(-6, 14, 0).toISOString(), notes: 'Reviewed the month\u2019s hours. They asked about the report export.', created_at: daysAgo(8).toISOString(), updated_at: daysAgo(5).toISOString() },
    { id: 'm-seed-4', title: 'Payroll prep', start_time: at(-1, 17, 0).toISOString(), notes: null, created_at: daysAgo(4).toISOString(), updated_at: daysAgo(4).toISOString() },
  ]

  return { workers, clients, entries, tasks, settings, financeItems, clientPriorities, meetings }
}

// Re-export uid for convenience
export { uid }
