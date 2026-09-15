import type { Permission, Ticket, TicketCategory, TicketPriority, TicketStatus } from './types'

/**
 * IT Support tickets — the vocabulary of the feature, in one place.
 *
 * WHY IT SUPPORT IS DIFFERENT FROM EVERY OTHER SECTION
 * ---------------------------------------------------
 * Every other capability in this app is a *slice of the admin's own power*
 * handed to a worker: the admin holds all of them (`can()` says yes to
 * everything for an admin, and `has_permission()` in SQL says the same), so a
 * grant only ever widens what a worker can reach.
 *
 * IT Support is deliberately **not** like that. Support is a job someone on the
 * team does — often the person who knows the printers — and the ticket queue is
 * meant to be *theirs*, not another admin chore. So the grant is worker-only:
 *
 *   - the admin **does not** hold it and cannot see the queue (see
 *     `isItSupport()`, which is what every gate must use — never `can()`),
 *   - the admin (or anyone) can still *submit* a ticket, and
 *   - the SQL side mirrors it with `public.is_it_support()`, which checks the
 *     worker row and ignores the admin flag entirely.
 *
 * Using `can('it_support.manage')` anywhere as a gate would silently hand the
 * section to the admin, which is exactly what this feature must not do. Both
 * backends refuse the admin too, so the UI is never the only thing stopping it.
 */
export const IT_SUPPORT_PERMISSION: Permission = 'it_support.manage'

/**
 * Does this account run IT Support?
 *
 * Worker-only by construction: the admin returns false however many
 * capabilities `can()` would grant them. `permissions` is the signed-in
 * worker's own grant list (see `AuthUser.permissions`), so a plain worker —
 * the admin included — is never IT Support by accident.
 */
export function isItSupport(
  role: 'admin' | 'worker' | null | undefined,
  permissions: Permission[] | null | undefined
): boolean {
  if (role !== 'worker') return false
  return (permissions ?? []).includes(IT_SUPPORT_PERMISSION)
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const TICKET_CATEGORIES: { key: TicketCategory; label: string; hint: string }[] = [
  { key: 'hardware', label: 'Hardware', hint: 'A device, printer, cable, monitor or peripherals.' },
  { key: 'software', label: 'Software', hint: 'An app, a website, an error message or something crashing.' },
  { key: 'account', label: 'Account & access', hint: 'Signing in, a password, a permission or an invitation.' },
  { key: 'other', label: 'Something else', hint: 'Anything that does not fit above — say it in your own words.' },
]

export const TICKET_PRIORITIES: { key: TicketPriority; label: string; hint: string }[] = [
  { key: 'low', label: 'Low', hint: 'A nuisance, not blocking anyone.' },
  { key: 'medium', label: 'Medium', hint: 'Slowing someone down.' },
  { key: 'high', label: 'High', hint: 'Blocking work right now.' },
]

export const TICKET_STATUSES: { key: TicketStatus; label: string; hint: string }[] = [
  { key: 'open', label: 'Open', hint: 'Submitted, nobody has picked it up yet.' },
  { key: 'in_progress', label: 'In progress', hint: 'Being worked on.' },
  { key: 'resolved', label: 'Resolved', hint: 'Done — reopen it if it comes back.' },
]

export function ticketCategoryLabel(category: TicketCategory | null | undefined): string {
  return TICKET_CATEGORIES.find((c) => c.key === category)?.label ?? 'Something else'
}

export function ticketPriorityLabel(priority: TicketPriority | null | undefined): string {
  return TICKET_PRIORITIES.find((p) => p.key === priority)?.label ?? 'Low'
}

export function ticketStatusLabel(status: TicketStatus | null | undefined): string {
  return TICKET_STATUSES.find((s) => s.key === status)?.label ?? 'Open'
}

/**
 * Priority badge styling. High reads as a warning, low as calm, and the middle
 * is the neutral case — the same idea as the invoices' overdue badge.
 */
export const TICKET_PRIORITY_BADGE: Record<TicketPriority, string> = {
  low: 'bg-muted text-muted-foreground',
  medium: 'bg-[#36B7C9]/15 text-[#0d7c8c] dark:text-[#7fdbe8]',
  high: 'bg-destructive/15 text-destructive',
}

/** Status badge styling — resolved goes quiet, open is the loud one. */
export const TICKET_STATUS_BADGE: Record<TicketStatus, string> = {
  open: 'bg-[#F77A0A]/15 text-[#b85c05] dark:text-[#ffb066]',
  in_progress: 'bg-[#36B7C9]/15 text-[#0d7c8c] dark:text-[#7fdbe8]',
  resolved: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
}

// ---------------------------------------------------------------------------
// Ordering & small helpers
// ---------------------------------------------------------------------------

/** Highest first — a high-priority ticket is the one to look at. */
const PRIORITY_RANK: Record<TicketPriority, number> = { high: 0, medium: 1, low: 2 }
/** Unfinished work first: open, then in progress, then the resolved pile. */
const STATUS_RANK: Record<TicketStatus, number> = { open: 0, in_progress: 1, resolved: 2 }

/**
 * Queue order. Priority and status decide the shape of the list; within a group
 * the newest ticket is on top, so a fresh report is never buried under old
 * resolved ones.
 */
export function sortTickets(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) => {
    const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    if (byStatus !== 0) return byStatus
    const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    if (byPriority !== 0) return byPriority
    return b.created_at.localeCompare(a.created_at)
  })
}

/** Only the categories / priorities / statuses we recognise survive a write. */
export function normalizeTicketCategory(value: unknown): TicketCategory {
  return TICKET_CATEGORIES.some((c) => c.key === value) ? (value as TicketCategory) : 'other'
}

export function normalizeTicketPriority(value: unknown): TicketPriority {
  return TICKET_PRIORITIES.some((p) => p.key === value) ? (value as TicketPriority) : 'low'
}

export function normalizeTicketStatus(value: unknown): TicketStatus {
  return TICKET_STATUSES.some((s) => s.key === value) ? (value as TicketStatus) : 'open'
}

/** `#12` — the short handle people quote in chat ("ticket #12"). */
export function ticketRef(ticket: Pick<Ticket, 'number'>): string {
  return `#${ticket.number}`
}

/** How many screenshots one ticket may carry. Kept small on purpose. */
export const MAX_TICKET_ATTACHMENTS = 3

/**
 * "Needs attention" count for the queue header: nothing about a ticket is
 * finished until it is resolved, so open and in-progress both count. Resolved
 * tickets never nag.
 */
export function openTicketCount(tickets: Ticket[]): number {
  return tickets.filter((t) => t.status !== 'resolved').length
}
