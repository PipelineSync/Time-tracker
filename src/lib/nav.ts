import type { Permission } from './types'

/**
 * The navigation **plan** — which destinations an account gets, in what order,
 * and under which heading ("Access Granted").
 *
 * Deliberately plain data: no icons, no React. The *policy* is the part that
 * has to stay right — a plain worker always reaches their **own** time and
 * their **own** tasks with nothing granted, while a grant adds the team-wide
 * screen next to them — so it lives where it can be read and tested on its own
 * (`scripts/verify-nav-local.ts`). `AppLayout` turns each key into its
 * icon + label; its `Record<NavKey, NavItem>` map makes a key added here fail
 * `npm run typecheck` until it is given one.
 */
export type NavKey =
  | 'dashboard'
  | 'tracker'
  | 'entriesAll'
  | 'entriesMine'
  | 'tasksAll'
  | 'tasksMine'
  | 'priorityBoard'
  | 'meetings'
  | 'invoicing'
  | 'notepad'
  | 'payroll'
  | 'finance'
  | 'workers'
  | 'reports'
  | 'settings'

export interface NavPlanSection {
  /** Heading shown above the group. Empty = no heading (admin / default block). */
  title: string
  items: NavKey[]
}

/**
 * Capabilities that *replace* their personal twin rather than being added next
 * to it. Both point at the same route, and once the team-wide read is granted
 * that route already shows every worker's rows — the viewer's own included —
 * so keeping "My Time" beside "Time Entries" would just be two links to the
 * same page.
 */
const TEAM_TWIN: Partial<Record<NavKey, NavKey>> = {
  entriesAll: 'entriesMine',
  tasksAll: 'tasksMine',
}

/**
 * Worker accounts always see their own tools first. A worker's own time needs
 * **no** grant: the entries are theirs (both backends and — on Supabase — the
 * RLS policies scope the rows to their own `worker_id`), which is why "My Time"
 * sits in the default block. Extra admin screens the owner granted them sit
 * under an "Access Granted" divider so the two kinds of access stay obvious.
 */
export function buildNavPlan(isAdmin: boolean, can: (permission: Permission) => boolean): NavPlanSection[] {
  if (isAdmin) {
    return [{
      title: '',
      items: [
        'dashboard',
        'entriesAll',
        'tasksAll',
        'priorityBoard',
        'meetings',
        'invoicing',
        'notepad',
        'finance',
        'workers',
        'reports',
        'settings',
      ],
    }]
  }

  const defaults: NavKey[] = [
    'tracker',
    // Their own recorded time — every worker gets this, granted or not.
    'entriesMine',
    'tasksMine',
    'notepad',
    'payroll',
    'settings',
  ]

  const granted: NavKey[] = []
  if (can('dashboard.view')) granted.push('dashboard')
  if (can('entries.view_all')) granted.push('entriesAll')
  if (can('tasks.view_all')) granted.push('tasksAll')
  if (can('priority_board.view')) granted.push('priorityBoard')
  if (can('meetings.view')) granted.push('meetings')
  if (can('invoices.view')) granted.push('invoicing')
  const hasFinance = can('finance.view') || can('finance.subscription') || can('finance.payroll')
  if (hasFinance) granted.push('finance')
  if (can('workers.view')) granted.push('workers')
  if (can('reports.view')) granted.push('reports')

  const items = defaults.filter((key) => !granted.some((g) => TEAM_TWIN[g] === key))

  const sections: NavPlanSection[] = [{ title: '', items }]
  if (granted.length > 0) sections.push({ title: 'Access Granted', items: granted })
  return sections
}
