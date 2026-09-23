import type { Worker, TimeEntry, Settings, Client, ClientPriority, Meeting, Invoice, Task, TaskStatus, FinanceItem, MonthlyGoal, BonusDecision, QaScore, WaitingReason, TaskStageEvent, ReworkType } from './types'
import { PERMISSION_PRESETS, DEFAULT_WEEKLY_CAPACITY_HOURS, DEFAULT_WORKDAYS } from './types'
import { toISODate } from './finance'
import { uid } from './utils'
import { availableWorkHours, currentMonthKey, monthRange, shiftMonthKey } from './kpi'

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
    `<rect x="${fx + 2}" y="${fy + 2}" width="3" height="3" fill="black"/>` +
    `<rect x="${fx + 3}" y="${fy + 3}" width="1" height="1" fill="black"/>`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="white"/>` +
    `<g fill="black">${rects}${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}</g>` +
    `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Fill every KPI-era field so seed rows are full Task objects. */
function seedTask(p: {
  id: string
  worker_id: string
  client_id: string | null
  title: string
  description?: string | null
  status: TaskStatus
  priority?: Task['priority']
  due_date: string | null
  estimated_hours?: number | null
  created_at: string
  updated_at: string
  completed_at?: string | null
  archived_at?: string | null
  position?: number
  created_by_role?: 'admin' | 'worker'
  original_due_date?: string | null
  assigned_at?: string | null
  started_at?: string | null
  waiting_since?: string | null
  waiting_reason?: WaitingReason | null
  submitted_for_review_at?: string | null
  rework_started_at?: string | null
  qa_score?: QaScore | null
  qa_reviewed_at?: string | null
  qa_reviewed_by?: string | null
  rework_required?: boolean | null
  rework_type?: ReworkType | null
  rework_notes?: string | null
  stage_history?: TaskStageEvent[]
}): Task {
  const status = p.status
  const history: TaskStageEvent[] = p.stage_history ?? [
    { from: null, to: 'todo', at: p.created_at, by: 'Owner' },
    ...(status !== 'todo' ? [{ from: 'todo' as const, to: status, at: p.updated_at, by: 'Owner' }] : []),
  ]
  return {
    id: p.id,
    worker_id: p.worker_id,
    client_id: p.client_id,
    title: p.title,
    description: p.description ?? null,
    status,
    priority: p.priority ?? 'medium',
    due_date: p.due_date,
    original_due_date: p.original_due_date ?? null,
    estimated_hours: p.estimated_hours ?? null,
    assigned_at: p.assigned_at ?? p.created_at,
    started_at: p.started_at ?? (status === 'in_progress' || status === 'completed' ? p.created_at : null),
    waiting_since: p.waiting_since ?? (status === 'waiting' ? p.updated_at : null),
    waiting_reason: p.waiting_reason ?? (status === 'waiting' ? 'other' : null),
    submitted_for_review_at: p.submitted_for_review_at ?? (status === 'for_review' ? p.updated_at : null),
    rework_started_at: p.rework_started_at ?? null,
    qa_score: p.qa_score ?? null,
    qa_reviewed_at: p.qa_reviewed_at ?? null,
    qa_reviewed_by: p.qa_reviewed_by ?? null,
    rework_required: p.rework_required ?? null,
    rework_type: p.rework_type ?? null,
    rework_notes: p.rework_notes ?? null,
    stage_history: history,
    position: p.position ?? 0,
    created_by_role: p.created_by_role ?? 'admin',
    completed_at: status === 'completed' ? (p.completed_at ?? p.updated_at) : null,
    archived_at: status === 'completed' ? (p.archived_at ?? null) : null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }
}

/**
 * Builds a deterministic-ish set of demo data relative to "today" so the
 * dashboard, reports and the Team KPI page all look populated. All hours are
 * reasonable daytimes.
 *
 * Besides the original three demo workers, this seeds the PipelineSync team
 * (Jasper, Matthew, Jea, April, Mary) with their real roles, their own
 * workweeks (Mon–Fri vs Tue–Sat) and a few months of task history so KPI
 * scores, the trend chart and Needs Attention all have something honest to
 * show in demo mode.
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

  const MON_FRI = [...DEFAULT_WORKDAYS]           // Mon–Fri
  const TUE_SAT = [2, 3, 4, 5, 6]                 // no Monday, Saturday counts

  // Sarah doubles as the permissions demo: the admin has given her the
  // Supervisor set, so signing in as her shows the team board and team time
  // without any of the money screens.
  const workers: Worker[] = [
    { id: 'w-seed-1', name: 'John Smith', email: 'john@example.com', hourly_rate: 20, status: 'active', position: 'Team member', avatar_url: null, payment_methods: ['cash'], qr_code_url: null, permissions: [], workdays: [...MON_FRI], weekly_capacity_hours: DEFAULT_WEEKLY_CAPACITY_HOURS, color: null, created_at: daysAgo(40).toISOString(), updated_at: daysAgo(40).toISOString() },
    { id: 'w-seed-2', name: 'Sarah Johnson', email: 'sarah@example.com', hourly_rate: 25, status: 'active', position: 'Team member', avatar_url: null, payment_methods: ['cash', 'qr'], qr_code_url: demoQrDataUrl('sarah@example.com'), permissions: [...PERMISSION_PRESETS.supervisor.permissions], workdays: [...MON_FRI], weekly_capacity_hours: DEFAULT_WEEKLY_CAPACITY_HOURS, color: 'emerald', created_at: daysAgo(30).toISOString(), updated_at: daysAgo(30).toISOString() },
    { id: 'w-seed-3', name: 'Mike Brown', email: 'mike@example.com', hourly_rate: 18, status: 'inactive', position: 'Team member', avatar_url: null, payment_methods: ['qr'], qr_code_url: demoQrDataUrl('mike@example.com'), permissions: [], workdays: [...MON_FRI], weekly_capacity_hours: DEFAULT_WEEKLY_CAPACITY_HOURS, color: null, created_at: daysAgo(20).toISOString(), updated_at: daysAgo(20).toISOString() },
    // ---- The PipelineSync team (roles & schedules per the KPI spec) ----
    { id: 'w-jasper', name: 'Jasper Maristela', email: 'jasper@example.com', hourly_rate: 30, status: 'active', position: 'Senior HubSpot / Zapier / AI Specialist', avatar_url: null, payment_methods: ['cash'], qr_code_url: null, permissions: [], workdays: [...MON_FRI], weekly_capacity_hours: 40, color: 'blue', created_at: daysAgo(120).toISOString(), updated_at: daysAgo(120).toISOString() },
    { id: 'w-matthew', name: 'Matthew Luzung', email: 'matthew@example.com', hourly_rate: 28, status: 'active', position: 'Senior HubSpot / Web Development', avatar_url: null, payment_methods: ['cash'], qr_code_url: null, permissions: [], workdays: [...TUE_SAT], weekly_capacity_hours: 40, color: 'violet', created_at: daysAgo(115).toISOString(), updated_at: daysAgo(115).toISOString() },
    { id: 'w-jea', name: 'Jea Crizel Pineda', email: 'jea@example.com', hourly_rate: 18, status: 'active', position: 'Outreach Strategist / HubSpot Junior', avatar_url: null, payment_methods: ['cash'], qr_code_url: null, permissions: [], workdays: [...TUE_SAT], weekly_capacity_hours: 40, color: 'aqua', created_at: daysAgo(110).toISOString(), updated_at: daysAgo(110).toISOString() },
    { id: 'w-april', name: 'April Joy Manabat', email: 'april@example.com', hourly_rate: 16, status: 'active', position: 'Outreach / HubSpot Junior', avatar_url: null, payment_methods: ['cash'], qr_code_url: null, permissions: [], workdays: [...TUE_SAT], weekly_capacity_hours: 40, color: 'amber', created_at: daysAgo(105).toISOString(), updated_at: daysAgo(105).toISOString() },
    { id: 'w-mary', name: 'Mary Gracelyn', email: 'mary@example.com', hourly_rate: 22, status: 'active', position: 'Social Media Manager', avatar_url: null, payment_methods: ['cash', 'qr'], qr_code_url: demoQrDataUrl('mary@example.com'), permissions: [], workdays: [...MON_FRI], weekly_capacity_hours: 40, color: 'rose', created_at: daysAgo(130).toISOString(), updated_at: daysAgo(130).toISOString() },
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
    // Row metadata is "when this row was written", never the (possibly
    // future) shift start — a future stamp would make a freshly-seeded
    // workspace look changed on every delta sync that follows.
    const created = new Date(Math.min(start.getTime(), Date.now())).toISOString()
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
    // The KPI team this week (light — logged hours are not a KPI input)
    entry('w-jasper', at(-1, 9, 0), at(-1, 17, 0), 'c-seed-1', 'HubSpot workflows', 45, 'Rebuilt the lead-scoring workflow', 30),
    entry('w-matthew', at(-2, 10, 0), at(-2, 18, 0), 'c-seed-2', 'Client portal', 30, 'Portal build — sprint 3', 28),
    entry('w-jea', at(-2, 9, 30), at(-2, 17, 30), 'c-seed-3', 'Outreach', 30, 'Prospect sequences', 18),
    entry('w-april', at(-3, 9, 0), at(-3, 17, 0), 'c-seed-3', 'Outreach', 30, 'Follow-up cadence', 16),
    entry('w-mary', at(-1, 8, 30), at(-1, 16, 30), 'c-seed-1', 'Content calendar', 30, 'October calendar drafted', 22),
    // Earlier this week
    entry('w-seed-3', at(-3, 8, 30), at(-3, 15, 0), 'c-seed-4', 'Inventory Audit', 45, 'Counted stock', 18),
    entry('w-seed-1', at(-4, 8, 0), at(-4, 12, 30), 'c-seed-2', 'Support Tickets', 0, 'Resolved customer issues', 20),
    // Last month
    entry('w-seed-2', at(-20, 9, 0), at(-20, 17, 0), 'c-seed-5', 'Q3 Report', 60, 'Compiled quarterly numbers', 25),
    entry('w-seed-1', at(-22, 10, 0), at(-22, 14, 30), 'c-seed-4', 'Training', 30, 'Onboarding session', 20),
  ]

  // A few board tasks so the Tasks page is populated in demo mode. One has a
  // long description on purpose: it exercises the card's "See more" clamp.
  // The John task with NO due date is the "Legacy / No Due Date" example.
  const tasks: Task[] = [
    seedTask({
      id: 't-seed-1',
      worker_id: 'w-seed-1',
      client_id: 'c-seed-1',
      title: 'Redesign the landing page hero section',
      description:
        'Rebuild the hero with the new copy from the marketing brief. The headline should sit over the product screenshot, with the primary CTA left-aligned. Add the trust logos row below the fold, keep the section under 100 KB, and make sure it holds up at 320 px wide before we hand it to QA for a pass on the main browsers.',
      status: 'in_progress',
      priority: 'high',
      due_date: at(2, 9).toISOString().slice(0, 10),
      estimated_hours: 10,
      created_at: daysAgo(3).toISOString(),
      updated_at: daysAgo(1).toISOString(),
    }),
    seedTask({
      id: 't-seed-2',
      worker_id: 'w-seed-2',
      client_id: 'c-seed-2',
      title: 'Draft Q3 summary report',
      description: 'Compile hours and earnings by project for the quarter.',
      status: 'todo',
      priority: 'medium',
      due_date: at(6, 9).toISOString().slice(0, 10),
      estimated_hours: 5,
      created_by_role: 'worker',
      created_at: daysAgo(2).toISOString(),
      updated_at: daysAgo(2).toISOString(),
    }),
    seedTask({
      id: 't-seed-3',
      worker_id: 'w-seed-1',
      client_id: 'c-seed-4',
      title: 'Fix flaky invoice export test',
      description: 'Legacy card from before due dates were required — excluded from on-time KPI.',
      status: 'waiting',
      priority: 'low',
      due_date: null,
      created_by_role: 'worker',
      waiting_reason: 'teammate',
      created_at: daysAgo(1).toISOString(),
      updated_at: daysAgo(1).toISOString(),
    }),
    seedTask({
      id: 't-seed-4',
      worker_id: 'w-seed-2',
      client_id: 'c-seed-3',
      title: 'Publish the two April blog posts',
      description: 'Copy is final, just schedule and share the links in the team channel.',
      status: 'completed',
      priority: 'medium',
      due_date: at(-2, 9).toISOString().slice(0, 10),
      estimated_hours: 3,
      completed_at: daysAgo(2).toISOString(),
      qa_score: 5,
      qa_reviewed_at: daysAgo(2).toISOString(),
      qa_reviewed_by: 'Owner',
      rework_required: false,
      created_at: daysAgo(8).toISOString(),
      updated_at: daysAgo(2).toISOString(),
    }),
  ]

  // ---- Team KPI demo data --------------------------------------------------
  // Open work per member (statuses, priorities, due dates, waiting reasons),
  // then estimated hours are fitted so each member lands on the workload % the
  // spec's example table shows — schedule-aware, exactly like the real calc.
  type OpenSpec = {
    title: string
    status: TaskStatus
    priority?: Task['priority']
    dueInDays: number
    /** Share of the member's target open hours (sums to 1). */
    weight: number
    waitingReason?: WaitingReason
    waitingSinceDays?: number
    submittedDaysAgo?: number
    client?: string
  }
  type MemberSpec = { id: string; targetPct: number; open: OpenSpec[] }

  const memberSpecs: MemberSpec[] = [
    {
      id: 'w-jasper',
      targetPct: 82,
      open: [
        { title: 'Rebuild lead-scoring workflow in HubSpot', status: 'in_progress', priority: 'high', dueInDays: 2, weight: 0.34 },
        { title: 'Zapier sync for the new billing tool', status: 'in_progress', dueInDays: 4, weight: 0.28 },
        { title: 'AI enrichment step for outreach lists', status: 'todo', dueInDays: 7, weight: 0.22, client: 'Globex' },
        { title: 'Waiting on API keys from Northwind', status: 'waiting', dueInDays: 5, weight: 0.16, waitingReason: 'access', waitingSinceDays: 4 },
        { title: 'Review April’s sequence copy', status: 'waiting', dueInDays: 1, weight: 0, waitingReason: 'teammate', waitingSinceDays: 1 },
      ],
    },
    {
      id: 'w-matthew',
      targetPct: 54,
      open: [
        { title: 'Client portal — dashboard build', status: 'in_progress', priority: 'high', dueInDays: 3, weight: 0.55 },
        { title: 'HubSpot theme: pricing page', status: 'todo', dueInDays: 6, weight: 0.3, client: 'Globex' },
        { title: 'Waiting on copy for the case study', status: 'waiting', dueInDays: 4, weight: 0.15, waitingReason: 'client', waitingSinceDays: 3 },
      ],
    },
    {
      id: 'w-jea',
      targetPct: 72,
      open: [
        { title: 'Q4 prospect list — wave 1 enrichment', status: 'in_progress', dueInDays: 2, weight: 0.38 },
        { title: 'Follow-up sequence for webinar signups', status: 'in_progress', dueInDays: 5, weight: 0.3, client: 'Globex' },
        { title: 'Waiting on approved list from client', status: 'waiting', dueInDays: 3, weight: 0.2, waitingReason: 'client', waitingSinceDays: 5 },
        { title: 'Overdue: HubSpot inbox cleanup', status: 'todo', priority: 'medium', dueInDays: -2, weight: 0.12 },
      ],
    },
    {
      id: 'w-april',
      targetPct: 48,
      open: [
        { title: 'Outreach batch — warm leads (due today)', status: 'in_progress', dueInDays: 0, weight: 0.5 },
        { title: 'LinkedIn comment replies', status: 'todo', dueInDays: 4, weight: 0.5, client: 'Globex' },
      ],
    },
    {
      id: 'w-mary',
      targetPct: 96,
      open: [
        { title: 'October content calendar (overdue, high)', status: 'in_progress', priority: 'high', dueInDays: -3, weight: 0.16 },
        { title: 'Reels script pack — wave 2 (overdue)', status: 'todo', priority: 'high', dueInDays: -1, weight: 0.12 },
        { title: 'Chase brand assets for launch posts', status: 'todo', dueInDays: -5, weight: 0.1 },
        { title: 'Hashtag research refresh (overdue)', status: 'todo', dueInDays: -4, weight: 0.1 },
        { title: 'Waiting on product photos from client', status: 'waiting', dueInDays: 2, weight: 0.14, waitingReason: 'client', waitingSinceDays: 8 },
        { title: 'Waiting for manager sign-off on giveaway', status: 'waiting', dueInDays: 3, weight: 0.1, waitingReason: 'manager', waitingSinceDays: 4 },
        { title: 'Waiting on design templates', status: 'waiting', dueInDays: 4, weight: 0.08, waitingReason: 'teammate', waitingSinceDays: 2 },
        { title: 'Carousel draft for the product launch', status: 'for_review', dueInDays: 1, weight: 0.1, submittedDaysAgo: 1 },
        { title: 'Fix caption typos from last review', status: 'rework', dueInDays: 1, weight: 0.06, client: 'Acme Corp' },
        { title: 'Schedule week-2 community replies', status: 'in_progress', dueInDays: 5, weight: 0.04, client: 'Northwind Traders' },
      ],
    },
  ]

  const byId = new Map(workers.map((w) => [w.id, w]))
  const clientIdByName = new Map(clients.map((c) => [c.name, c.id]))
  const month0 = currentMonthKey()

  for (const spec of memberSpecs) {
    const worker = byId.get(spec.id)!
    const targetHours = (spec.targetPct / 100) * availableWorkHours(worker, month0)
    let allocated = 0
    const usable = spec.open.filter((o) => o.weight > 0)
    let wi = 0
    for (const o of spec.open) {
      wi += 1
      const isLast = wi === usable.length || spec.open.filter((x) => x.weight > 0).slice(wi).every((x) => x.weight === 0)
      let hours: number
      if (o.weight === 0) {
        hours = 2 // small extra card outside the fitted total
      } else if (isLast) {
        hours = Math.max(0.5, Math.round((targetHours - allocated) * 100) / 100)
      } else {
        hours = Math.max(0.5, Math.round(targetHours * o.weight * 100) / 100)
        allocated += hours
      }
      const created = daysAgo(6 + wi)
      tasks.push(
        seedTask({
          id: `t-kpi-${spec.id}-${wi}`,
          worker_id: spec.id,
          client_id: clientIdByName.get(o.client ?? (wi % 2 ? 'Acme Corp' : 'Northwind Traders')) ?? 'c-seed-1',
          title: o.title,
          status: o.status,
          priority: o.priority ?? 'medium',
          due_date: dateOffset(o.dueInDays),
          estimated_hours: hours,
          waiting_reason: o.waitingReason ?? null,
          waiting_since: o.waitingSinceDays != null ? daysAgo(o.waitingSinceDays).toISOString() : null,
          submitted_for_review_at: o.submittedDaysAgo != null ? daysAgo(o.submittedDaysAgo).toISOString() : null,
          created_at: created.toISOString(),
          updated_at: daysAgo(Math.max(0, o.waitingSinceDays ?? o.submittedDaysAgo ?? 1)).toISOString(),
        }),
      )
    }
  }

  // ---- Completed history ---------------------------------------------------
  // This month + the previous five, so On-Time, QA, rework and the Monthly KPI
  // Trend all have honest source tasks to trace back to.
  const qaPctByMember: Record<string, number> = {
    'w-jasper': 93,
    'w-matthew': 91,
    'w-jea': 94,
    'w-april': 96,
    'w-mary': 89,
    'w-seed-1': 90,
    'w-seed-2': 92,
  }
  /** How many of this month's completions were late (drives On-Time %). */
  const lateThisMonth: Record<string, number> = {
    'w-jasper': 1,
    'w-matthew': 1,
    'w-jea': 1,
    'w-april': 0,
    'w-mary': 3,
    'w-seed-1': 1,
    'w-seed-2': 0,
  }
  const doneThisMonth: Record<string, number> = {
    'w-jasper': 12,
    'w-matthew': 9,
    'w-jea': 13,
    'w-april': 10,
    'w-mary': 12,
    'w-seed-1': 4,
    'w-seed-2': 5,
  }

  const titles = [
    'Workflow fix & QA pass',
    'Client deliverable — batch update',
    'Landing page section shipped',
    'Prospect sequence live',
    'Report export cleaned up',
    'Automation health check',
    'Content pack delivered',
    'Inbox zero sweep',
    'Tracking parameters audit',
    'Campaign brief drafted',
    'Creative revisions applied',
    'Data hygiene pass on contacts',
    'Integration smoke test',
    'Weekly client update sent',
    'Form + notification wiring',
    'Outreach copy A/B ready',
    'Dashboard widget rebuilt',
    'Monthly performance recap',
  ]
  const reworkReasons: ReworkType[] = ['qa_correction', 'missing_requirement', 'incorrect_work', 'incomplete_work', 'did_not_follow_instructions']

  /** QA score (1–5) hitting the member's target % on average. */
  function scoreFor(memberId: string, i: number): QaScore {
    const target = qaPctByMember[memberId] ?? 90
    // mostly 5s; sprinkle 4s (and the odd 3 for Mary) to land near target
    const cycle = i % 10
    if (memberId === 'w-mary') return cycle < 5 ? 5 : cycle < 8 ? 4 : 3
    if (target >= 95) return cycle < 8 ? 5 : 4
    if (target >= 92) return cycle < 7 ? 5 : 4
    return cycle < 6 ? 5 : 4
  }

  let taskSeq = 0
  function completedTask(
    workerId: string,
    opts: {
      dueDate: string
      completedAt: string
      title?: string
      qa?: QaScore | null
      rework?: boolean
      reworkType?: ReworkType
      client?: string
      createdAt: string
      updatedAt: string
    },
  ): Task {
    taskSeq += 1
    const late = opts.completedAt.slice(0, 10) > opts.dueDate
    return seedTask({
      id: `t-done-${taskSeq}`,
      worker_id: workerId,
      client_id: clientIdByName.get(opts.client ?? ['Acme Corp', 'Northwind Traders', 'Globex', 'Internal'][taskSeq % 4]) ?? 'c-seed-4',
      title: opts.title ?? titles[taskSeq % titles.length],
      status: 'completed',
      priority: taskSeq % 5 === 0 ? 'high' : 'medium',
      due_date: opts.dueDate,
      original_due_date: late && taskSeq % 3 === 0 ? dateOffset(-40) : null,
      estimated_hours: [2, 3, 4, 5, 6, 8][taskSeq % 6],
      qa_score: opts.qa ?? scoreFor(workerId, taskSeq),
      qa_reviewed_at: opts.completedAt,
      qa_reviewed_by: taskSeq % 4 === 0 ? 'Project Manager' : 'Owner',
      rework_required: opts.rework ?? false,
      rework_type: opts.rework ? (opts.reworkType ?? reworkReasons[taskSeq % reworkReasons.length]) : null,
      rework_notes: opts.rework ? 'Corrections noted in the QA review.' : null,
      completed_at: opts.completedAt,
      assigned_at: opts.createdAt,
      started_at: opts.createdAt,
      created_at: opts.createdAt,
      updated_at: opts.updatedAt,
      stage_history: [
        { from: null, to: 'todo', at: opts.createdAt, by: 'Owner' },
        { from: 'todo', to: 'in_progress', at: opts.createdAt, by: 'Owner' },
        { from: 'in_progress', to: 'for_review', at: opts.completedAt, by: 'Owner' },
        { from: 'for_review', to: 'completed', at: opts.completedAt, by: opts.qa === undefined ? 'Owner' : 'Owner' },
      ],
    })
  }

  // -- Past five months: 4–6 completions each, mixed on-time/late, QA kept --
  for (let shift = -5; shift <= -1; shift++) {
    const { ym, label: lastDay } = monthOffset(shift)
    const lastDayNum = Number(lastDay.slice(8, 10))
    const pattern = [6, 11, 15, 19, 23, 27]
    for (const w of workers) {
      if (w.status !== 'active') continue
      const count = 4 + ((w.id.length + Math.abs(shift)) % 3) // 4–6
      for (let i = 0; i < count; i++) {
        const doneDay = Math.min(pattern[i], lastDayNum - 1)
        const late = i === 1 && shift % 2 !== 0 // a predictable sprinkle of late ones
        const dueDay = Math.min(late ? doneDay - 3 : doneDay + 2, lastDayNum)
        const createdAt = `${ym}-${String(Math.max(1, doneDay - 5)).padStart(2, '0')}T09:00:00.000Z`
        const completedAt = `${ym}-${String(doneDay).padStart(2, '0')}T16:30:00.000Z`
        tasks.push(
          completedTask(w.id, {
            dueDate: `${ym}-${String(Math.max(1, dueDay)).padStart(2, '0')}`,
            completedAt,
            createdAt,
            updatedAt: completedAt,
            // one rework per member in some months, employee-caused
            rework: i === 2 && shift >= -3,
            reworkType: shift === -2 && w.id === 'w-jea' ? 'scope_changed' : undefined,
          }),
        )
      }
    }
  }

  // -- This month: enough completions to land each member's On-Time target --
  const now = new Date()
  const cur = monthRange(month0)
  const startDay = Number(cur.from.slice(8, 10))
  const endDay = Number(cur.to.slice(8, 10))
  const latestDay = Math.max(startDay, Math.min(endDay, now.getDate() - 1))
  if (latestDay >= startDay) {
    for (const w of workers) {
      if (w.status !== 'active') continue
      const n = doneThisMonth[w.id] ?? 6
      const lateN = lateThisMonth[w.id] ?? 1
      for (let i = 0; i < n; i++) {
        // Spread completions across the elapsed days of the month.
        const frac = n === 1 ? 1 : i / (n - 1)
        const doneDay = Math.round(startDay + frac * (latestDay - startDay))
        const isLate = i >= n - lateN
        const dueDay = isLate ? Math.max(startDay, doneDay - 2) : Math.min(endDay, doneDay + 1)
        const createdAtDate = daysAgo(Math.max(1, 10 + (i % 7)))
        const completedISO = `${month0}-${String(doneDay).padStart(2, '0')}T1${i % 6}:${(i * 7) % 60 < 10 ? '0' : ''}${(i * 7) % 60}:00.000Z`
        tasks.push(
          completedTask(w.id, {
            dueDate: `${month0}-${String(dueDay).padStart(2, '0')}`,
            completedAt: completedISO,
            createdAt: createdAtDate.toISOString(),
            updatedAt: completedISO,
            rework: w.id === 'w-mary' ? i === 1 || i === 5 : i === 3 && w.id !== 'w-april',
            // April's one rework (if any) is client-caused — doesn't count.
            reworkType: w.id === 'w-jea' && i === 3 ? 'client_requested_change' : undefined,
          }),
        )
      }
    }
  }

  // ---- Monthly goals (management input — the only number people type) -----
  const monthlyGoals: MonthlyGoal[] = []
  const goalSpecs: Record<string, { target: number; onTime?: number }> = {
    'w-jasper': { target: 12 },
    'w-matthew': { target: 10 },
    'w-jea': { target: 14 },
    'w-april': { target: 12 },
    'w-mary': { target: 14, onTime: 95 }, // Social Media Manager: 95% on-time
    'w-seed-1': { target: 6 },
    'w-seed-2': { target: 6 },
  }
  for (const shift of [-2, -1, 0]) {
    const m = shiftMonthKey(month0, shift)
    for (const [workerId, spec] of Object.entries(goalSpecs)) {
      monthlyGoals.push({
        id: `g-${workerId}-${m}`,
        worker_id: workerId,
        month: m,
        target: spec.target,
        on_time_target: spec.onTime ?? 90,
        qa_target: 90,
        note: shift === 0 && workerId === 'w-mary' ? 'Content planned with the Owner for the month.' : null,
        created_at: daysAgo(30).toISOString(),
        updated_at: daysAgo(20).toISOString(),
      })
    }
  }

  // ---- Bonus decisions (manual, Owner-only — never auto-set by KPI) -------
  const lastM = shiftMonthKey(month0, -1)
  const bonusDecisions: BonusDecision[] = [
    { id: 'b-1', worker_id: 'w-jasper', month: lastM, eligible: 'yes', approved_amount: 250, approved_by: 'Owner', note: 'Strong month on the automation work.', created_at: daysAgo(10).toISOString(), updated_at: daysAgo(10).toISOString() },
    { id: 'b-2', worker_id: 'w-april', month: lastM, eligible: 'yes', approved_amount: 120, approved_by: 'Owner', note: null, created_at: daysAgo(10).toISOString(), updated_at: daysAgo(10).toISOString() },
    { id: 'b-3', worker_id: 'w-mary', month: lastM, eligible: 'no', approved_amount: null, approved_by: 'Owner', note: 'Missed the on-time target — coaching done.', created_at: daysAgo(10).toISOString(), updated_at: daysAgo(10).toISOString() },
    { id: 'b-4', worker_id: 'w-matthew', month: month0, eligible: 'pending', approved_amount: null, approved_by: null, note: null, created_at: daysAgo(5).toISOString(), updated_at: daysAgo(5).toISOString() },
    { id: 'b-5', worker_id: 'w-jea', month: month0, eligible: 'pending', approved_amount: null, approved_by: null, note: null, created_at: daysAgo(5).toISOString(), updated_at: daysAgo(5).toISOString() },
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
      max_occurrences: null, billed_count: 0,
      created_at: daysAgo(120).toISOString(), updated_at: daysAgo(24).toISOString(),
    },
    {
      id: 'f-seed-2', kind: 'subscription', name: 'QuickBooks', worker_id: null,
      amount: 38, cycle: 'monthly', period_month: null, due_date: dateOffset(-2),
      status: 'active', paid_at: null, note: null,
      max_occurrences: null, billed_count: 0,
      created_at: daysAgo(300).toISOString(), updated_at: daysAgo(32).toISOString(),
    },
    {
      id: 'f-seed-3', kind: 'subscription', name: 'Microsoft 365', worker_id: null,
      amount: 149.99, cycle: 'yearly', period_month: null, due_date: dateOffset(46),
      status: 'active', paid_at: null, note: 'Annual licence',
      // A set number of bills on purpose: the demo shows the "3/12 billed"
      // chip and what a subscription that ends by itself looks like.
      max_occurrences: 12, billed_count: 3,
      created_at: daysAgo(320).toISOString(), updated_at: daysAgo(320).toISOString(),
    },
    {
      id: 'f-seed-4', kind: 'payroll', name: null, worker_id: 'w-seed-1',
      amount: 1180, cycle: null, period_month: lastMonth.ym, due_date: lastMonth.label,
      status: 'paid', paid_at: lastMonth.label + 'T09:00:00.000Z', note: 'Cash, settled in person',
      max_occurrences: null, billed_count: 0,
      created_at: lastMonth.ym + '-27T09:00:00.000Z', updated_at: lastMonth.label + 'T09:00:00.000Z',
    },
    {
      id: 'f-seed-5', kind: 'payroll', name: null, worker_id: 'w-seed-2',
      amount: 1450, cycle: null, period_month: lastMonth.ym, due_date: lastMonth.label,
      status: 'paid', paid_at: lastMonth.label + 'T09:00:00.000Z', note: null,
      max_occurrences: null, billed_count: 0,
      created_at: lastMonth.ym + '-27T09:00:00.000Z', updated_at: lastMonth.label + 'T09:00:00.000Z',
    },
    {
      id: 'f-seed-6', kind: 'payroll', name: null, worker_id: 'w-seed-1',
      amount: 1240, cycle: null, period_month: thisMonth.ym, due_date: dateOffset(9),
      status: 'unpaid', paid_at: null, note: 'Payday on the 25th',
      max_occurrences: null, billed_count: 0,
      created_at: thisMonth.ym + '-01T09:00:00.000Z', updated_at: thisMonth.ym + '-01T09:00:00.000Z',
    },
    {
      id: 'f-seed-7', kind: 'payroll', name: null, worker_id: 'w-seed-2',
      amount: 1520, cycle: null, period_month: thisMonth.ym, due_date: dateOffset(-1),
      status: 'unpaid', paid_at: null, note: null,
      max_occurrences: null, billed_count: 0,
      created_at: thisMonth.ym + '-01T09:00:00.000Z', updated_at: thisMonth.ym + '-01T09:00:00.000Z',
    },
    {
      id: 'f-seed-8', kind: 'bill', name: 'Office rent', worker_id: null,
      amount: 900, cycle: null, period_month: null, due_date: dateOffset(12),
      status: 'unpaid', paid_at: null, note: 'Ground floor unit',
      max_occurrences: null, billed_count: 0,
      created_at: daysAgo(20).toISOString(), updated_at: daysAgo(20).toISOString(),
    },
    {
      id: 'f-seed-9', kind: 'bill', name: 'Electricity', worker_id: null,
      amount: 118.4, cycle: null, period_month: null, due_date: dateOffset(5),
      status: 'unpaid', paid_at: null, note: null,
      max_occurrences: null, billed_count: 0,
      created_at: daysAgo(6).toISOString(), updated_at: daysAgo(6).toISOString(),
    },
    {
      id: 'f-seed-10', kind: 'bill', name: 'Public liability insurance', worker_id: null,
      amount: 320, cycle: null, period_month: null, due_date: dateOffset(-40),
      status: 'paid', paid_at: daysAgo(41).toISOString(), note: 'Renewed for 12 months',
      max_occurrences: null, billed_count: 0,
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

  // A partly-filled invoicing board so the Client Invoicing page shows all
  // three columns: one overdue (due date already past), one due soon, two
  // chasing payment and two already paid.
  const invoices: Invoice[] = [
    { id: 'inv-seed-1', client_id: null, basis: 'project', project_name: 'Landing page', amount: 1200, due_date: dateOffset(-2), stage: 'awaiting', notes: 'Phase 1 — landing page, billed per project. Payment overdue, chase on Monday.', created_at: daysAgo(20).toISOString(), updated_at: daysAgo(9).toISOString() },
    { id: 'inv-seed-2', client_id: 'c-seed-2', basis: 'client', project_name: null, amount: 850, due_date: dateOffset(3), stage: 'awaiting', notes: 'Monthly retainer — sent, awaiting their accounts payable.', created_at: daysAgo(12).toISOString(), updated_at: daysAgo(12).toISOString() },
    { id: 'inv-seed-3', client_id: 'c-seed-3', basis: 'client', project_name: null, amount: 640, due_date: dateOffset(10), stage: 'pending', notes: 'Draft — waiting for the scope change to be confirmed.', created_at: daysAgo(2).toISOString(), updated_at: daysAgo(2).toISOString() },
    { id: 'inv-seed-4', client_id: null, basis: 'project', project_name: 'Components build', amount: 2200, due_date: dateOffset(18), stage: 'pending', notes: 'Phase 2 — components build, billed per project at the end of the sprint.', created_at: daysAgo(1).toISOString(), updated_at: daysAgo(1).toISOString() },
    { id: 'inv-seed-5', client_id: 'c-seed-2', basis: 'client', project_name: null, amount: 150, due_date: dateOffset(-14), stage: 'paid', notes: 'Extra report export — settled in full.', created_at: daysAgo(30).toISOString(), updated_at: daysAgo(16).toISOString() },
    { id: 'inv-seed-6', client_id: 'c-seed-1', basis: 'client', project_name: null, amount: 980, due_date: dateOffset(-28), stage: 'paid', notes: null, created_at: daysAgo(45).toISOString(), updated_at: daysAgo(29).toISOString() },
  ]

  return { workers, clients, entries, tasks, settings, financeItems, clientPriorities, meetings, invoices, monthlyGoals, bonusDecisions }
}

// Re-export uid for convenience
export { uid }
