/**
 * Ad-hoc verification of the navigation plan (`src/lib/nav.ts`):
 *  - a plain worker reaches their **own time** ("My Time" → /entries) and their
 *    **own tasks** with nothing granted — the thing that must never disappear
 *    again (their entries are theirs to read; both backends and the RLS
 *    policies scope the rows to their own worker_id)
 *  - a grant ADDS the team-wide screen under "Access Granted" and *replaces*
 *    its "my own" twin, instead of leaving two links to the same route
 *  - the admin keeps the single, full, heading-less section
 *  - the IT Support *desk* is the granted worker's alone — the admin never gets
 *    it, even when the flag is passed in — while **Submit a Ticket is not a
 *    destination at all**: it lives in the FAQs dialog, so no account has a nav
 *    entry for it (`FaqButton` renders the button)
 *
 * The keys are what `AppLayout` turns into icons + labels; its
 * `Record<NavKey, NavItem>` map means a key the plan emits without a matching
 * destination fails `npm run typecheck`.
 *
 * Run: npx tsx scripts/verify-nav-local.ts
 */
import { buildNavPlan, type NavKey } from '../src/lib/nav'
import type { Permission } from '../src/lib/types'

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`ok: ${msg}`)
  }
}

/** The `can()` a signed-in account gets: admin true, else the granted keys. */
function canFor(grants: Permission[]): (p: Permission) => boolean {
  return (p) => grants.includes(p)
}

/** Every key the nav shows, in order, across all sections. */
function keysOf(sections: { items: NavKey[] }[]): NavKey[] {
  return sections.flatMap((s) => s.items)
}

function main() {
  const something = canFor([])

  // ---- 1. a plain worker: own time + own tasks, no grants ----------------
  const plain = buildNavPlan(false, something)
  const plainKeys = keysOf(plain)
  assert(plainKeys.includes('entriesMine'), 'a worker with no grants gets "My Time" in the nav')
  assert(plainKeys.includes('tracker'), 'a worker with no grants gets the clock-in screen')
  assert(plainKeys.includes('tasksMine'), 'a worker with no grants gets their own tasks')
  assert(!plainKeys.includes('entriesAll'), 'a worker with no grants does NOT get the team-wide time entries')
  assert(plain.length === 1 && plain[0].title === '', 'with nothing granted there is no "Access Granted" heading')

  // ---- 2. the team-wide read replaces the personal item, not the reverse --
  const teamTime = buildNavPlan(false, canFor(['entries.view_all']))
  const timeKeys = keysOf(teamTime)
  assert(timeKeys.includes('entriesAll'), 'entries.view_all adds "Time Entries"')
  assert(!timeKeys.includes('entriesMine'), '"My Time" is replaced by the team-wide "Time Entries" (one link, one route)')
  const grantedSection = teamTime.find((s) => s.title === 'Access Granted')
  assert(!!grantedSection?.items.includes('entriesAll'), 'the team-wide screen sits under "Access Granted"')
  assert(!!teamTime[0].items.includes('tracker'), 'the worker still keeps their own tools above the divider')
  assert(!grantedSection?.items.includes('entriesMine'), '"Access Granted" does not re-list the personal item')

  // Reports implies the team-wide read in both backends and the RLS policy,
  // so a worker holding it is in the same shape.
  const reports = keysOf(buildNavPlan(false, canFor(['reports.view'])))
  assert(reports.includes('reports'), 'reports.view adds "Reports"')
  // (reports.view alone does not tick entries.view_all in the plan — the Access
  // form ticks both, and canViewAllEntries() is what the pages use.)
  assert(reports.includes('tasksMine'), 'a Reports viewer still gets their own tasks')

  // Same replacement rule for tasks.
  const teamTasks = keysOf(buildNavPlan(false, canFor(['tasks.view_all'])))
  assert(teamTasks.includes('tasksAll') && !teamTasks.includes('tasksMine'), 'tasks.view_all replaces "My Tasks" with "Tasks"')

  // ---- 3. several grants: every destination, still no duplicates ---------
  const lead = keysOf(buildNavPlan(false, canFor([
    'dashboard.view',
    'workers.view',
    'entries.view_all',
    'tasks.view_all',
    'tasks.manage_all',
    'priority_board.view',
    'meetings.view',
    'invoices.view',
    'reports.view',
  ])))
  for (const key of ['dashboard', 'workers', 'entriesAll', 'tasksAll', 'priorityBoard', 'meetings', 'invoicing', 'reports'] as NavKey[]) {
    assert(lead.includes(key), `a supervisor/manager grant adds "${key}"`)
  }
  assert(!lead.includes('entriesMine') && !lead.includes('tasksMine'), 'granted worker has no duplicate personal items')
  assert(new Set(lead).size === lead.length, 'no destination is listed twice')

  // Money access keeps the worker's own Payroll entry, and adds Finance.
  const financed = keysOf(buildNavPlan(false, canFor(['finance.view'])))
  assert(financed.includes('finance'), 'finance.view adds "Finance"')
  assert(financed.includes('payroll'), 'a worker keeps their own "Payroll" (own payments) alongside Finance')

  // ---- 4. the admin: one full section, no headings, nothing personal -----
  const admin = buildNavPlan(true, () => true)
  const adminKeys = keysOf(admin)
  assert(admin.length === 1 && admin[0].title === '', 'the admin gets a single heading-less section')
  for (const key of ['dashboard', 'entriesAll', 'tasksAll', 'priorityBoard', 'meetings', 'invoicing', 'notepad', 'finance', 'workers', 'reports', 'settings'] as NavKey[]) {
    assert(adminKeys.includes(key), `the admin keeps "${key}"`)
  }
  assert(!adminKeys.includes('entriesMine') && !adminKeys.includes('tasksMine'), 'the admin nav has no worker-only twins')
  assert(new Set(adminKeys).size === adminKeys.length, 'the admin nav has no duplicates either')

  // ---- 5. a worker never sees an admin-only destination ------------------
  const workerAdminScreens: NavKey[] = ['dashboard', 'workers', 'reports', 'priorityBoard', 'meetings', 'invoicing', 'finance']
  assert(
    workerAdminScreens.every((k) => !plainKeys.includes(k)),
    'a worker with no grants sees no admin-only destination',
  )

  // ---- 6. Submit a Ticket for everyone; the IT Support desk for the desk --  // ---- 6. the IT Support desk, and only for the desk --------------------
  assert(!plainKeys.includes('itSupport'), 'a worker with no grants gets no IT Support desk')

  const desk = buildNavPlan(false, canFor(['it_support.manage']), true)
  const deskKeys = keysOf(desk)
  assert(deskKeys.includes('itSupport'), 'the IT Support grant adds the desk')
  assert(!!desk.find((s) => s.title === 'Access Granted')?.items.includes('itSupport'), 'the desk sits under "Access Granted" — it is a granted job, not a personal tool')

  const adminQ = buildNavPlan(true, () => true, true)
  const adminQKeys = keysOf(adminQ)
  assert(!adminQKeys.includes('itSupport'), 'the admin gets NO IT Support desk, even when the flag is passed in')

  // Submitting a ticket is help, not a section: it is rendered by the FAQs
  // dialog (`FaqButton`), so no plan — worker, admin, desk — may grow a
  // destination for it.
  for (const [label, keys] of [['a plain worker', plainKeys], ['the desk', deskKeys], ['the admin', adminQKeys]] as [string, NavKey[]][]) {
    assert(
      !keys.some((k) => String(k).toLowerCase().includes('ticket')),
      `${label} has no Submit a Ticket destination — it lives in the FAQs`,
    )
  }

  console.log(process.exitCode ? '\nSome navigation checks FAILED.' : '\nAll navigation checks passed.')
}

main()
