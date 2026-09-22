import type {
  Worker,
  TimeEntry,
  ActiveTimer,
  Settings,
  SlackSettings,
  AuthUser,
  TimeEntryComment,
  AppNotification,
  Payment,
  PaymentMethod,
  Role,
  WorkerAvatar,
  Task,
  TaskStatus,
  TaskPriority,
  Client,
  ClientColor,
  ClientStatus,
  ClientPriority,
  ClientPriorityLane,
  Meeting,
  Note,
  NoteColor,
  Permission,
  Invoice,
  InvoiceStage,
  InvoiceBasis,
  FinanceItem,
  FinanceKind,
  FinanceStatus,
  Ticket,
  TicketReply,
  TicketAssignee,
  CreateTicketInput,
  UpdateTicketInput,
  BillingCycle,
  MonthlyGoal,
  BonusDecision,
  KpiAuditEvent,
} from './types'
import {
  CLIENT_PRIORITY_LANES,
  INVOICE_STAGES,
  DEFAULT_CLIENT_COLOR,
  DEFAULT_NOTE_COLOR,
  DEFAULT_SLACK_SETTINGS,
  FINANCE_KINDS,
  NOTE_COLORS,
  PERMISSIONS,
  TEAM_VIEW_PERMISSIONS,
  ALL_ENTRIES_VIEW_PERMISSIONS,
  normalizePermissions,
  isValidClientColor,
  normalizeTaskStage,
  normalizeWeeklyCapacity,
  normalizeWorkdays,
  UNASSIGNED_CLIENT_NAME,
} from './types'
import type { DataBackend, CreateWorkerInput, CreateTaskInput, CreateClientInput, CreateFinanceItemInput, CreateMeetingInput, CreateNoteInput, CreateInvoiceInput, CreateMonthlyGoalInput, SaveBonusDecisionInput } from './backend'
import { ACCOUNT_DEACTIVATED_MESSAGE } from './backend'
import { buildDemoSeed } from './demoSeed'
import {
  applyDueDateChange,
  applyStageTransition,
  initialStageFields,
  normalizeEstimatedHours,
  normalizeQaScore,
  normalizeReworkType,
  normalizeWaitingReason,
  patchTouchesQa,
  stageActorName,
} from './taskWorkflow'
import {
  IT_SUPPORT_PERMISSION,
  MAX_TICKET_ATTACHMENTS,
  isItSupport as isItSupportGrant,
  normalizeTicketCategory,
  normalizeTicketPriority,
  normalizeTicketStatus,
  sortTickets,
  ticketRef,
  ticketStatusLabel,
} from './tickets'
import { uid, computeEarnings, formatMinutes, formatDate } from './utils'
import { storage } from './storage'

export const ADMIN_EMAIL = 'admin'
export const ADMIN_PASSWORD = 'admin.pipelinesync'

interface StoredUser {
  id: string
  email: string
  password: string
  role: Role
  workerId?: string | null
}

interface UserData {
  workers: Worker[]
  entries: TimeEntry[]
  /** Every timer currently running — one per worker, many at the same time. */
  activeTimers: ActiveTimer[]
  /** @deprecated legacy single-timer field, migrated into `activeTimers`. */
  activeTimer?: ActiveTimer | null
  settings: Settings | null
  comments: TimeEntryComment[]
  notifications: AppNotification[]
  payments: Payment[]
  /** Kanban tasks (see the Tasks page). */
  tasks: Task[]
  /** Client master list (admin-managed, see the Tasks page → Clients). */
  clients: Client[]
  /**
   * The client priority board's rows — which column + rank each ranked client
   * sits in. Clients without a row here are unranked (bottom of Low Priority).
   */
  clientPriorities: ClientPriority[]
  /** The meetings schedule (see the Meetings page). */
  meetings: Meeting[]
  /** IT Support tickets (see the IT Support page). */
  tickets: Ticket[]
  /** Replies on those tickets, oldest first per ticket. */
  ticketReplies: TicketReply[]
  /** Every account's private notepad notes — rows carry `owner_id` (see the Notepad page). */
  notes: Note[]
  /** The client invoicing board's cards (see the Client Invoicing page). */
  invoices: Invoice[]
  /** Finance ledger: subscriptions, payroll runs and bills (see the Finance page). */
  financeItems: FinanceItem[]
  /** Monthly KPI goals per employee (Team KPI dashboard). */
  monthlyGoals: MonthlyGoal[]
  /** Manual bonus decisions per employee per month (Owner-only edits). */
  bonusDecisions: BonusDecision[]
  /** Append-only QA / due-date / bonus audit trail for the KPI history. */
  kpiAudit: KpiAuditEvent[]
}

const USERS_KEY = 'wt_users'
const SESSION_KEY = 'wt_session'
const dataKey = (userId: string) => `wt_data_${userId}`
const slackKey = (userId: string) => `wt_slack_${userId}`

function read<T>(key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  storage.setItem(key, JSON.stringify(value))
}

function readUsers(): StoredUser[] {
  return read<StoredUser[]>(USERS_KEY, [])
}

function writeUsers(users: StoredUser[]) {
  write(USERS_KEY, users)
}

function emptyData(): UserData {
  return { workers: [], entries: [], activeTimers: [], settings: null, comments: [], notifications: [], payments: [], tasks: [], clients: [], clientPriorities: [], meetings: [], notes: [], invoices: [], financeItems: [], tickets: [], ticketReplies: [], monthlyGoals: [], bonusDecisions: [], kpiAudit: [] }
}

/** The method the admin paid a settlement with, or null when unknown/invalid. */
function normalizePaidMethod(method: unknown): PaymentMethod | null {
  return method === 'cash' || method === 'qr' ? method : null
}

function paymentMethodLabel(method: PaymentMethod): string {
  return method === 'cash' ? 'Cash' : 'QR Code'
}

/**
 * The reference / transaction number the admin typed when paying — trimmed,
 * capped (a GCash or bank reference is well under this) and null when blank,
 * so an empty box never saves an empty string.
 */
function normalizeReferenceNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, 64)
}

/** Payment methods a worker accepts — normalized for rows saved before this feature. */
function normalizePaymentMethods(methods: unknown): PaymentMethod[] {
  if (!Array.isArray(methods)) return []
  return methods.filter((m): m is PaymentMethod => m === 'cash' || m === 'qr')
}

/** Normalize a worker row loaded from storage (or the demo seed) to the current shape. */
function normalizeWorker(w: Worker): Worker {
  const payment_methods = normalizePaymentMethods(w.payment_methods)
  return {
    ...w,
    payment_methods,
    permissions: normalizePermissions(w.permissions),
    // Rows saved before the schedule columns existed load with the defaults
    // (Mon–Fri, 40h) so workload math never sees an empty schedule.
    workdays: normalizeWorkdays(w.workdays),
    weekly_capacity_hours: normalizeWeeklyCapacity(w.weekly_capacity_hours),
    // A QR image only makes sense while the worker accepts QR payments.
    qr_code_url: payment_methods.includes('qr') ? (w.qr_code_url ?? null) : null,
  }
}

/** Valid board column, defaulting anything unknown/legacy to To Do.
 *  (`approval` reads as `for_review` — see normalizeTaskStage.) */
function normalizeTaskStatus(status: unknown): TaskStatus {
  return normalizeTaskStage(status)
}

function normalizeTaskPriority(priority: unknown): TaskPriority {
  return priority === 'low' || priority === 'high' ? priority : 'medium'
}

/** Normalize a task row loaded from storage to the current shape. */
function normalizeTask(t: Task): Task {
  const status = normalizeTaskStatus(t.status)
  return {
    ...t,
    status,
    priority: normalizeTaskPriority(t.priority),
    description: t.description ?? null,
    client_id: t.client_id ?? null,
    due_date: t.due_date ?? null,
    // KPI-era fields: rows written before they existed simply load as nulls
    // (legacy due dates keep their "Legacy / No Due Date" handling).
    original_due_date: t.original_due_date ?? null,
    estimated_hours: normalizeEstimatedHours(t.estimated_hours),
    assigned_at: t.assigned_at ?? t.created_at ?? null,
    started_at: t.started_at ?? null,
    waiting_since: t.waiting_since ?? (status === 'waiting' ? (t.updated_at ?? null) : null),
    waiting_reason: t.waiting_reason ?? null,
    submitted_for_review_at: t.submitted_for_review_at ?? (status === 'for_review' ? (t.updated_at ?? null) : null),
    rework_started_at: t.rework_started_at ?? null,
    qa_score: normalizeQaScore(t.qa_score),
    qa_reviewed_at: t.qa_reviewed_at ?? null,
    qa_reviewed_by: t.qa_reviewed_by ?? null,
    rework_required: typeof t.rework_required === 'boolean' ? t.rework_required : null,
    rework_type: normalizeReworkType(t.rework_type),
    rework_notes: t.rework_notes ?? null,
    stage_history: Array.isArray(t.stage_history) ? t.stage_history.filter((e) => e && e.to) : [],
    position: Number.isFinite(t.position) ? t.position : 0,
    created_by_role: t.created_by_role === 'admin' ? 'admin' : 'worker',
    completed_at: status === 'completed' ? (t.completed_at ?? t.updated_at ?? null) : null,
    archived_at: status === 'completed' ? (t.archived_at ?? null) : null,
  }
}

/** Board order: by column position, then newest first as a tiebreaker. */
function sortTasks(rows: Task[]): Task[] {
  return [...rows].sort((a, b) => a.position - b.position || b.created_at.localeCompare(a.created_at))
}

/**
 * Re-number one worker's column so `movedId` sits at `index` and every other
 * card keeps its relative order with a gap-free position.
 */
function reindexTaskColumn(tasks: Task[], workerId: string, status: TaskStatus, movedId: string, index: number) {
  const column = sortTasks(tasks.filter((t) => t.worker_id === workerId && t.status === status && t.id !== movedId))
  const moved = tasks.find((t) => t.id === movedId)
  if (!moved) return
  const at = Math.max(0, Math.min(index, column.length))
  column.splice(at, 0, moved)
  column.forEach((t, i) => { t.position = i })
}

/** Valid colour tag — a built-in preset or a custom #hex — defaulting anything else to the default. */
function normalizeClientColor(color: unknown): ClientColor {
  return isValidClientColor(color) ? color : DEFAULT_CLIENT_COLOR
}

function normalizeClientStatus(status: unknown): ClientStatus {
  return status === 'inactive' ? 'inactive' : 'active'
}

function normalizeClient(c: Client): Client {
  return {
    ...c,
    name: (c.name ?? '').trim() || 'Client',
    color: normalizeClientColor(c.color),
    status: normalizeClientStatus(c.status),
  }
}

/** Clients A→Z with the inactive ones last — the order every list shows. */
function sortClients(rows: Client[]): Client[] {
  return [...rows].sort(
    (a, b) =>
      Number(a.status === 'inactive') - Number(b.status === 'inactive') ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )
}

/** The client's display name, or null when there is none / it is unknown. */
function clientName(d: UserData, clientId: string | null | undefined): string | null {
  if (!clientId) return null
  return d.clients.find((c) => c.id === clientId)?.name ?? null
}

// ---- Client priority board --------------------------------------------------
// One row per ranked client: which column (`lane`) and how high (`position`,
// smaller = higher). Clients without a row are unranked — the UI shows them at
// the bottom of Low Priority — so "reset the board" is just "delete every
// row", and brand-new clients appear on the board automatically.

/** Valid board column, defaulting anything unknown/legacy to Low Priority. */
function normalizeClientPriorityLane(lane: unknown): ClientPriorityLane {
  return CLIENT_PRIORITY_LANES.includes(lane as ClientPriorityLane) ? (lane as ClientPriorityLane) : 'low'
}

/** Normalize a priority row loaded from storage (or the demo seed). */
function normalizeClientPriority(p: ClientPriority): ClientPriority {
  return {
    ...p,
    lane: normalizeClientPriorityLane(p.lane),
    position: Number.isFinite(p.position) ? p.position : 0,
  }
}

/** Board order within a lane: by position, then newest first as a tiebreaker. */
function sortClientPriorities(rows: ClientPriority[]): ClientPriority[] {
  return [...rows].sort((a, b) => a.position - b.position || b.updated_at.localeCompare(a.updated_at))
}

/**
 * Re-number one lane so `clientId` sits at `index` and every other ranked
 * client keeps its relative order with a gap-free position.
 */
function reindexClientPriorityLane(rows: ClientPriority[], lane: ClientPriorityLane, clientId: string, index: number) {
  const laneRows = sortClientPriorities(rows.filter((p) => p.lane === lane && p.client_id !== clientId))
  const moved = rows.find((p) => p.client_id === clientId)
  if (!moved) return
  const at = Math.max(0, Math.min(index, laneRows.length))
  laneRows.splice(at, 0, moved)
  laneRows.forEach((p, i) => { p.position = i })
}

// ---- Meetings ---------------------------------------------------------------
// The schedule is one workspace-wide list. `meetings.view` opens it — the
// admin holds it by definition, a worker only when the admin ticks it.

/** Normalize a meeting loaded from storage (or the demo seed). */
function normalizeMeeting(m: Meeting): Meeting {
  // An invalid/missing start falls back to "now" rather than NaN-ing every
  // sort; the title is trimmed so blank rows cannot render as empty cards.
  const start = Number.isFinite(new Date(m.start_time).getTime()) ? m.start_time : new Date().toISOString()
  return {
    ...m,
    title: (m.title ?? '').trim() || 'Meeting',
    start_time: start,
    notes: m.notes ?? null,
  }
}

/** Upcoming ascending (soonest first); past descending (newest first). */
function sortMeetings(rows: Meeting[], now: number): Meeting[] {
  const upcoming = rows.filter((m) => new Date(m.start_time).getTime() >= now)
  const past = rows.filter((m) => new Date(m.start_time).getTime() < now)
  upcoming.sort((a, b) => a.start_time.localeCompare(b.start_time))
  past.sort((a, b) => b.start_time.localeCompare(a.start_time))
  return [...upcoming, ...past]
}

// ---- Notepad ------------------------------------------------------------------
// Every account's notes live in the same workspace blob, but each carries an
// `owner_id` and every read/write filters on the session user — a strictly
// private scratchpad per person.

/** Normalize a note loaded from storage. */
function normalizeNote(n: Note): Note {
  return {
    ...n,
    owner_id: n.owner_id ?? '',
    title: n.title ?? '',
    body: n.body ?? '',
    color: NOTE_COLORS.includes(n.color) ? n.color : DEFAULT_NOTE_COLOR,
    pinned: !!n.pinned,
  }
}

/** Notepad order: pinned first, then newest edit first. */
function sortNotes(rows: Note[]): Note[] {
  return [...rows].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at))
}

// ---- Client invoicing -------------------------------------------------------
// One board for the whole workspace: every invoice sits in Pending, Awaiting
// or Paid, and dragging between the columns is the entire workflow. There is
// no ranking inside a column — cards sort by due date — so a drag is one row
// patch, not a re-index.

/** Valid board column, defaulting anything unknown/legacy to Pending. */
function normalizeInvoiceStage(stage: unknown): InvoiceStage {
  return INVOICE_STAGES.includes(stage as InvoiceStage) ? (stage as InvoiceStage) : 'pending'
}

/**
 * What the invoice bills: 'client' (the whole client) or 'project' (one named
 * project). Anything unknown — pre-basis invoices, bad values — is client
 * based, which is what every invoice was before the choice existed.
 */
function normalizeInvoiceBasis(basis: unknown): InvoiceBasis {
  return basis === 'project' ? 'project' : 'client'
}

/** The project name, kept only when the invoice actually bills a project. */
function normalizeInvoiceProjectName(basis: InvoiceBasis, projectName: unknown): string | null {
  if (basis !== 'project') return null
  return typeof projectName === 'string' && projectName.trim() ? projectName.trim() : null
}

/** Local 'YYYY-MM-DD', the invoice due-date format (a date, not an instant). */
function toISODateOnly(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Normalize an invoice loaded from storage (or the demo seed). */
function normalizeInvoice(inv: Invoice): Invoice {
  const amount = Number(inv.amount)
  const basis = normalizeInvoiceBasis(inv.basis)
  return {
    ...inv,
    // A project-based invoice bills the project, not a client — it carries
    // no client at all. Client-based ones keep theirs.
    client_id: basis === 'project' ? null : String(inv.client_id ?? ''),
    basis,
    project_name: normalizeInvoiceProjectName(basis, inv.project_name),
    amount: Number.isFinite(amount) ? Math.max(0, amount) : 0,
    due_date: typeof inv.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(inv.due_date) ? inv.due_date : toISODateOnly(new Date()),
    stage: normalizeInvoiceStage(inv.stage),
    notes: typeof inv.notes === 'string' && inv.notes.trim() ? inv.notes.trim() : null,
  }
}

/** Board order within a column: due soonest on top, then oldest-created. */
function sortInvoices(rows: Invoice[]): Invoice[] {
  return [...rows].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.created_at.localeCompare(b.created_at))
}

// ---- IT Support tickets -----------------------------------------------------

/**
 * Repair a stored ticket (and one written by an older build): unknown
 * categories/priorities/statuses fall back to the safe value rather than
 * disappearing from the queue, and `attachments` is always a list.
 */
function normalizeTicket(ticket: Ticket): Ticket {
  const number = Number(ticket.number)
  return {
    ...ticket,
    number: Number.isFinite(number) && number > 0 ? Math.floor(number) : 0,
    subject: String(ticket.subject ?? ''),
    description: String(ticket.description ?? ''),
    category: normalizeTicketCategory(ticket.category),
    priority: normalizeTicketPriority(ticket.priority),
    status: normalizeTicketStatus(ticket.status),
    attachments: Array.isArray(ticket.attachments) ? ticket.attachments.filter((a) => typeof a === 'string') : [],
    reply_count: Number.isFinite(Number(ticket.reply_count)) ? Math.max(0, Math.floor(Number(ticket.reply_count))) : 0,
    resolved_at: ticket.resolved_at ?? null,
  }
}

function normalizeTicketReply(reply: TicketReply): TicketReply {
  return {
    ...reply,
    body: String(reply.body ?? ''),
    author_name: String(reply.author_name ?? 'A teammate'),
    from_support: !!reply.from_support,
  }
}

// ---- Finance ledger ---------------------------------------------------------
// One list of due-dated lines (subscription / payroll / bill). Rows are owned
// by the admin workspace like everything else; `finance.view` opens the read,
// `finance.manage` the writes — both admin-only until the admin grants them.

function normalizeFinanceKind(kind: unknown): FinanceKind | null {
  return FINANCE_KINDS.includes(kind as FinanceKind) ? (kind as FinanceKind) : null
}

function normalizeFinanceCycle(cycle: unknown): BillingCycle {
  return cycle === 'yearly' ? 'yearly' : 'monthly'
}

/** A status that fits the row's kind; anything else falls back to the default. */
function normalizeFinanceStatus(kind: FinanceKind, status: unknown): FinanceStatus {
  if (kind === 'subscription') return status === 'paused' ? 'paused' : 'active'
  return status === 'paid' ? 'paid' : 'unpaid'
}

/** 'YYYY-MM-DD' calendar date, or null when unparseable. */
function normalizeFinanceDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  return value
}

/** 'YYYY-MM' month bucket, or null. */
function normalizeFinanceMonth(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return null
  return value
}

/** Normalize a finance row loaded from storage to the current shape. */
function normalizeFinanceItem(f: FinanceItem): FinanceItem {
  const kind = normalizeFinanceKind(f.kind) ?? 'bill'
  const status = normalizeFinanceStatus(kind, f.status)
  // Only subscriptions carry an occurrence limit; a whole number of 1+.
  const max = kind === 'subscription' && Number.isFinite(f.max_occurrences) ? Math.floor(f.max_occurrences!) : null
  return {
    ...f,
    kind,
    name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : null,
    worker_id: kind === 'payroll' ? f.worker_id : null,
    amount: Number.isFinite(f.amount) ? Math.max(0, Math.round(f.amount * 100) / 100) : 0,
    cycle: kind === 'subscription' ? normalizeFinanceCycle(f.cycle) : null,
    period_month: kind === 'payroll' ? (normalizeFinanceMonth(f.period_month) ?? null) : null,
    due_date: normalizeFinanceDate(f.due_date) ?? new Date().toISOString().slice(0, 10),
    status,
    // The paid stamp only describes a completed payment.
    paid_at: status === 'paid' ? (f.paid_at ?? f.updated_at ?? new Date().toISOString()) : null,
    note: typeof f.note === 'string' && f.note.trim() ? f.note.trim() : null,
    max_occurrences: max !== null && max > 0 ? max : null,
    billed_count: Number.isFinite(f.billed_count) && f.billed_count > 0 ? Math.floor(f.billed_count) : 0,
  }
}

/**
 * A subscription whose due date was rolled forward has been billed once more.
 * Moving the date back (a correction) never counts, and when the count
 * reaches the limit the subscription pauses by itself.
 */
function applyBillingCount(current: FinanceItem, patch: Partial<FinanceItem>, next: FinanceItem): FinanceItem {
  if (current.kind !== 'subscription') return next
  const moved = patch.due_date !== undefined && (normalizeFinanceDate(patch.due_date) ?? '') > current.due_date
  if (!moved) return next
  const billedCount = current.billed_count + 1
  return {
    ...next,
    billed_count: billedCount,
    // The last bill on the counter ends the subscription — no one has to
    // remember to come back and switch it off.
    status: next.max_occurrences !== null && billedCount >= next.max_occurrences ? 'paused' : next.status,
  }
}

/** Oldest due dates first — the order of the ledger's agenda; tabs re-sort. */
function sortFinanceItems(rows: FinanceItem[]): FinanceItem[] {
  return [...rows].sort((a, b) => a.due_date.localeCompare(b.due_date) || b.created_at.localeCompare(a.created_at))
}

/** Keep a client reference only when it actually points at a known client. */
function resolveClientId(d: UserData, clientId: string | null | undefined): string | null {
  if (!clientId) return null
  return d.clients.some((c) => c.id === clientId) ? clientId : null
}

/**
 * Append one KPI audit row (QA scores, rework classification, due-date
 * changes, bonus decisions — §15). The list is append-only and newest-first
 * reads simply reverse it; capped so a busy workspace can't grow it forever.
 */
function pushKpiAudit(
  d: UserData,
  event: Omit<KpiAuditEvent, 'id' | 'created_at'>,
): KpiAuditEvent {
  const row: KpiAuditEvent = { id: uid(), created_at: new Date().toISOString(), ...event }
  d.kpiAudit = [row, ...(d.kpiAudit ?? [])].slice(0, 2000)
  return row
}

/** Who is acting — the Owner, or the signed-in worker's name. */
function actorLabel(c: { user: AuthUser; data: UserData }): string {
  return stageActorName(c.user.role, c.data.workers.find((w) => w.id === c.user.workerId), c.user.email)
}

/**
 * One-time migration for workspaces that predate clients: everything without a
 * client is attached to a single "Unassigned" client so no task or entry is
 * left dangling (the admin can rename it, re-tag the work, or retire it).
 * Returns true when something changed and the workspace needs saving.
 */
function backfillClients(d: UserData): boolean {
  const orphanTasks = d.tasks.filter((t) => !t.client_id)
  const orphanEntries = d.entries.filter((e) => !e.client_id)
  if (orphanTasks.length === 0 && orphanEntries.length === 0) return false
  const now = new Date().toISOString()
  let fallback = d.clients.find((c) => c.name.trim().toLowerCase() === UNASSIGNED_CLIENT_NAME.toLowerCase())
  if (!fallback) {
    fallback = {
      id: uid(),
      name: UNASSIGNED_CLIENT_NAME,
      color: 'slate',
      status: 'active',
      created_at: now,
      updated_at: now,
    }
    d.clients.push(fallback)
  }
  for (const t of orphanTasks) t.client_id = fallback.id
  for (const e of orphanEntries) e.client_id = fallback.id
  return true
}

function readData(userId: string): UserData {
  const d = read<UserData>(dataKey(userId), emptyData())
  d.workers = (d.workers || []).map(normalizeWorker)
  d.entries = d.entries || []
  d.activeTimers = d.activeTimers || []
  // Migrate workspaces saved before multi-worker timers existed.
  if (d.activeTimer) {
    if (!d.activeTimers.some((t) => t.id === d.activeTimer!.id)) d.activeTimers.push(d.activeTimer)
    d.activeTimer = null
  }
  d.settings = d.settings || null
  d.comments = d.comments || []
  d.notifications = d.notifications || []
  d.payments = d.payments || []
  d.tasks = (d.tasks || []).map(normalizeTask)
  d.clients = (d.clients || []).map(normalizeClient)
  // Workspaces saved before the priority board simply load with no client
  // ranked — everything sits unranked at the bottom of Low Priority.
  d.clientPriorities = (d.clientPriorities || []).map(normalizeClientPriority)
  // Workspaces saved before the Meetings section simply load an empty schedule.
  d.meetings = (d.meetings || []).map(normalizeMeeting)
  // Workspaces saved before the Notepad simply load no notes.
  d.notes = (d.notes || []).map(normalizeNote)
  // Workspaces saved before the invoicing section simply load an empty board.
  d.invoices = (d.invoices || []).map(normalizeInvoice)
  // Workspaces saved before Team KPI simply load empty KPI collections.
  d.monthlyGoals = (d.monthlyGoals || []).filter((g) => g && g.worker_id && g.month)
  d.bonusDecisions = (d.bonusDecisions || []).filter((b) => b && b.worker_id && b.month)
  d.kpiAudit = d.kpiAudit || []
  // Workspaces saved before IT Support simply load an empty ticket queue.
  d.tickets = (d.tickets || []).map(normalizeTicket)
  d.ticketReplies = (d.ticketReplies || []).map(normalizeTicketReply)
  // Notifications written before tickets existed have no ticket target.
  // Also prune duplicate overdue recurring notices for the same bill and due date.
  const seenOverdue = new Set<string>()
  d.notifications = (d.notifications || [])
    .map((n) => ({ ...n, ticket_id: n.ticket_id ?? null }))
    .filter((n) => {
      if (n.type === 'payment' && n.message.toLowerCase().includes('overdue recurring payment')) {
        const nameMatch = n.message.match(/Overdue recurring payment:\s*"([^"]+)"/i)
        const dueMatch = n.message.match(/was due on\s+(\d{4}-\d{2}-\d{2})/i)
        if (nameMatch && dueMatch) {
          const key = `${n.user_id}:${nameMatch[1].toLowerCase()}:${dueMatch[1]}`
          if (seenOverdue.has(key)) return false
          seenOverdue.add(key)
        }
      }
      return true
    })
  // A client that was deleted should not keep a phantom place on the board.
  const clientIds = new Set(d.clients.map((c) => c.id))
  const beforePrune = d.clientPriorities.length
  d.clientPriorities = d.clientPriorities.filter((p) => clientIds.has(p.client_id))
  if (d.clientPriorities.length !== beforePrune) d.clientPriorities = d.clientPriorities.map((p) => ({ ...p }))
  // Same for invoices — a client-based invoice for a deleted client has
  // nobody to bill. Project-based ones bill a named project, not a client,
  // so they stay on the board.
  d.invoices = d.invoices.filter((i) => (i.client_id ? clientIds.has(i.client_id) : i.basis === 'project'))
  // Workspaces saved before the Finance section simply load an empty ledger.
  d.financeItems = (d.financeItems || []).map(normalizeFinanceItem)
  d.entries = d.entries.map((e) => ({ ...e, client_id: e.client_id ?? null }))
  // Workspaces saved before clients existed get their work attached to the
  // "Unassigned" client the first time they are read.
  if (backfillClients(d)) write(dataKey(userId), d)
  return d
}

function writeData(userId: string, data: UserData) {
  write(dataKey(userId), data)
}

/** Ensure the single admin account exists (bootstrap). Returns the admin user. */
export function ensureAdmin(): StoredUser {
  const users = readUsers()
  const existing = users.find((u) => u.role === 'admin')
  if (existing) return existing
  const admin: StoredUser = {
    id: uid(),
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    role: 'admin',
  }
  users.push(admin)
  writeUsers(users)
  return admin
}

/** Workspace owner is always the admin. */
function getAdmin(): StoredUser {
  return ensureAdmin()
}

/** True while the worker row behind a login account still exists. */
function workerAccountStillValid(userId: string): boolean {
  const u = readUsers().find((x) => x.id === userId)
  if (!u) return false
  if (u.role !== 'worker') return true
  return readData(getAdmin().id).workers.some((w) => w.id === u.workerId)
}

export function getSessionUser(): AuthUser | null {
  ensureAdmin()
  const session = read<{ userId: string } | null>(SESSION_KEY, null)
  if (!session) return null
  const users = readUsers()
  const u = users.find((x) => x.id === session.userId)
  if (!u) return null
  if (!workerAccountStillValid(u.id)) return null
  return { id: u.id, email: u.email, role: u.role, workerId: u.workerId ?? null, permissions: permissionsOf(u) }
}

/** Current user + admin workspace. All data lives in the admin's workspace. */
function ctx(): { user: AuthUser; admin: StoredUser; data: UserData } | null {
  const user = getSessionUser()
  if (!user) return null
  const admin = getAdmin()
  return { user, admin, data: readData(admin.id) }
}

function save(data: UserData) {
  const admin = getAdmin()
  writeData(admin.id, data)
}

function toAuth(u: StoredUser): AuthUser {
  return { id: u.id, email: u.email, role: u.role, workerId: u.workerId ?? null, permissions: permissionsOf(u) }
}

/**
 * Capabilities this account has. The admin owns the workspace and therefore
 * holds all of them; a worker holds exactly what the admin ticked on their row.
 */
function permissionsOf(u: { role: Role; workerId?: string | null }): Permission[] {
  if (u.role === 'admin') return [...PERMISSIONS]
  if (!u.workerId) return []
  const w = readData(getAdmin().id).workers.find((x) => x.id === u.workerId)
  return w ? normalizePermissions(w.permissions) : []
}

/** Does the signed-in account hold this capability? */
function can(c: { user: AuthUser }, permission: Permission): boolean {
  if (c.user.role === 'admin') return true
  return (c.user.permissions ?? []).includes(permission)
}

/** Anyone who sees team-wide data also needs the names behind it. */
function canSeeTeam(c: { user: AuthUser }): boolean {
  return TEAM_VIEW_PERMISSIONS.some((p) => can(c, p))
}

/**
 * Can this account read every worker's time entries? `reports.view` counts as
 * well as `entries.view_all`: a report is drawn from the team's entries, so
 * handing someone Reports means handing them the team's time (read-only).
 */
function canSeeAllEntries(c: { user: AuthUser }): boolean {
  return ALL_ENTRIES_VIEW_PERMISSIONS.some((p) => can(c, p))
}

/** Standard refusal, phrased for a worker who was not granted the capability. */
function denied(what: string) {
  return { data: null, error: `You do not have permission to ${what}.` }
}

/** Auth user id for a worker row, or null if no account linked. */
function workerUserId(workerId: string): string | null {
  return readUsers().find((u) => u.workerId === workerId)?.id ?? null
}

function pushNotification(
  data: UserData,
  recipientUserId: string,
  // `ticket_id` is optional here so the many entry/timer notification call
  // sites stay short; only IT Support notifications carry a ticket.
  n: Omit<AppNotification, 'id' | 'user_id' | 'read' | 'created_at' | 'ticket_id'> & { ticket_id?: string | null }
) {
  data.notifications.push({
    id: uid(),
    user_id: recipientUserId,
    entry_id: n.entry_id,
    ticket_id: n.ticket_id ?? null,
    type: n.type,
    message: n.message,
    read: false,
    created_at: new Date().toISOString(),
  })
}

// ---- IT Support tickets ----------------------------------------------------

/**
 * Auth ids of the accounts that run IT Support — the only people who see the
 * queue. Note what is *missing*: the admin. The grant is worker-only by design
 * (see `isItSupport()` in ./tickets), so the admin is never a recipient here
 * unless they were somehow given a worker row with the grant.
 */
function itSupportUserIds(data: UserData): string[] {
  return data.workers
    .filter((w) => (w.permissions ?? []).includes(IT_SUPPORT_PERMISSION))
    .map((w) => workerUserId(w.id))
    .filter((id): id is string => !!id)
}

/** Display name for the account doing something: the worker's name, else "Admin". */
function actorName(c: { user: AuthUser; data: UserData }): string {
  if (c.user.role === 'admin') return 'Admin'
  return c.data.workers.find((w) => w.id === c.user.workerId)?.name || c.user.email
}

/** Everyone who should hear about a ticket: the assignee, else all of IT Support. */
function ticketAudience(data: UserData, ticket: Ticket): string[] {
  if (ticket.assignee_user_id) return [ticket.assignee_user_id]
  return itSupportUserIds(data)
}

/** The signed-in user's own timer (admin: the most recently started one). */
function ownTimer(c: { user: AuthUser; data: UserData }): ActiveTimer | null {
  if (c.user.role === 'worker') {
    return c.data.activeTimers.find((t) => t.worker_id === c.user.workerId) || null
  }
  return [...c.data.activeTimers].sort((a, b) => b.start_time.localeCompare(a.start_time))[0] || null
}

/** Resolve a timer by id, falling back to the caller's own timer. */
function findTimer(c: { user: AuthUser; data: UserData }, timerId?: string): ActiveTimer | null {
  if (timerId) return c.data.activeTimers.find((t) => t.id === timerId) || null
  return ownTimer(c)
}

/**
 * Re-adopt a running timer left on a STALE worker row.
 *
 * A worker login is tied to a `workers` row. When the admin re-creates that
 * row mid-shift (delete + re-add re-links the login to a new id), the timer
 * keeps ticking on the OLD row while the account — and every ownership check
 * — now point at the NEW one: break, switch client and clock out all die on
 * "Not your timer." and the timer never closes. This mirrors
 * `reclaim_my_timers()` in the Supabase backend: the stale timer is moved to
 * the caller's current worker row only when it is provably theirs (the old
 * row carries the same login email and no other account claims it). If the
 * current row already runs a timer, the leftover duplicate is dropped, the
 * same rule the Supabase reclaim applies.
 */
function reclaimStaleTimers(c: { user: AuthUser; data: UserData }): void {
  const u = c.user
  if (u.role !== 'worker' || !u.workerId) return
  const myEmail = (u.email || '').toLowerCase()
  if (!myEmail) return
  const claimedElsewhere = new Set(
    readUsers()
      .filter((x) => x.id !== u.id && x.workerId)
      .map((x) => x.workerId as string)
  )
  let mineTaken = c.data.activeTimers.some((t) => t.worker_id === u.workerId)
  let moved = false
  for (const t of [...c.data.activeTimers]) {
    if (t.worker_id === u.workerId) continue
    const w = c.data.workers.find((x) => x.id === t.worker_id)
    if (!w || (w.email || '').toLowerCase() !== myEmail) continue
    if (claimedElsewhere.has(t.worker_id)) continue
    if (mineTaken) {
      c.data.activeTimers = c.data.activeTimers.filter((x) => x.id !== t.id)
    } else {
      t.worker_id = u.workerId
      mineTaken = true
    }
    moved = true
  }
  if (moved) save(c.data)
}

function workerName(data: UserData, workerId: string): string {
  return data.workers.find((w) => w.id === workerId)?.name || 'A worker'
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(amount)
  } catch {
    return `$${amount.toFixed(2)}`
  }
}

// Auto-seed the admin workspace on first login so the app isn't empty.
function maybeAutoSeed(data: UserData) {
  if (data.workers.length === 0 && data.entries.length === 0 && !data.settings) {
    const seed = buildDemoSeed()
    const users = readUsers()
    const seededWorkers: Worker[] = seed.workers.map((w) => ({ ...w, id: uid() }))
    const idMap = new Map(seed.workers.map((w, i) => [w.id, seededWorkers[i].id]))
    // Create a login account for each seeded worker so admin can demo worker logins.
    for (const w of seededWorkers) {
      if (!users.some((u) => u.email === w.email)) {
        users.push({
          id: uid(),
          email: w.email!,
          password: 'worker123',
          role: 'worker',
          workerId: w.id,
        })
      }
    }
    writeUsers(users)
    const seededClients: Client[] = seed.clients.map((cl) => ({ ...cl, id: uid() }))
    const clientMap = new Map(seed.clients.map((cl, i) => [cl.id, seededClients[i].id]))
    data.workers = seededWorkers
    data.clients = seededClients
    data.entries = seed.entries.map((e) => ({
      ...e,
      worker_id: idMap.get(e.worker_id) || e.worker_id,
      client_id: e.client_id ? clientMap.get(e.client_id) ?? null : null,
      id: uid(),
    }))
    data.tasks = seed.tasks.map((t) => ({
      ...t,
      worker_id: idMap.get(t.worker_id) || t.worker_id,
      client_id: t.client_id ? clientMap.get(t.client_id) ?? null : null,
      id: uid(),
    }))
    // Team KPI seed: monthly targets + bonus rows remap onto the new worker ids.
    data.monthlyGoals = (seed.monthlyGoals ?? []).map((g) => ({ ...g, worker_id: idMap.get(g.worker_id) || g.worker_id, id: uid() }))
    data.bonusDecisions = (seed.bonusDecisions ?? []).map((b) => ({ ...b, worker_id: idMap.get(b.worker_id) || b.worker_id, id: uid() }))
    data.kpiAudit = []
    data.financeItems = seed.financeItems.map((f) => ({
      ...f,
      worker_id: f.worker_id ? idMap.get(f.worker_id) ?? null : null,
      id: uid(),
    }))
    // The boards and the schedule are workspace-wide, so the first login
    // seeds them too — an admin opening the app fresh should see every
    // section populated, not just the worker/entry lists.
    data.clientPriorities = (seed.clientPriorities ?? []).map((p) => ({
      ...p,
      client_id: clientMap.get(p.client_id) ?? p.client_id,
      id: uid(),
    }))
    data.meetings = (seed.meetings ?? []).map((m) => ({ ...m, id: uid() }))
    data.invoices = (seed.invoices ?? []).map((i) => ({
      ...i,
      client_id: i.client_id ? clientMap.get(i.client_id) ?? i.client_id : null,
      id: uid(),
    }))
    data.settings = seed.settings
  }
}

export const localBackend: DataBackend = {
  kind: 'local',
  isAdminConfigured: () => true,

  async signIn(email, password) {
    ensureAdmin()
    const users = readUsers()
    const normalized = email.trim().toLowerCase()
    const u = users.find((x) => x.email === normalized && x.password === password)
    if (!u) return { data: null, error: 'Invalid username or password.' }
    if (!workerAccountStillValid(u.id)) {
      // The worker row was deleted (or data was reset) — the login must no
      // longer work.
      return { data: null, error: ACCOUNT_DEACTIVATED_MESSAGE }
    }
    write(SESSION_KEY, { userId: u.id })
    if (u.role === 'admin') {
      const data = readData(getAdmin().id)
      maybeAutoSeed(data)
      save(data)
    }
    return { data: toAuth(u), error: null }
  },

  async signOut() {
    storage.removeItem(SESSION_KEY)
  },

  async getSession() {
    ensureAdmin()
    const u = getSessionUser()
    if (u?.role === 'admin') {
      const data = readData(getAdmin().id)
      maybeAutoSeed(data)
      save(data)
    }
    return { data: u, error: null }
  },

  async resetPassword() {
    return { data: null, error: null }
  },

  async changePassword(currentPassword, newPassword) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const users = readUsers()
    const me = users.find((u) => u.id === c.user.id)
    if (!me) return { data: null, error: 'Account not found.' }
    if (me.password !== currentPassword) return { data: null, error: 'Current password is incorrect.' }
    if (newPassword === currentPassword) return { data: null, error: 'New password must be different.' }
    if (!newPassword || newPassword.length < 6) return { data: null, error: 'New password must be at least 6 characters.' }
    me.password = newPassword
    writeUsers(users)
    return { data: null, error: null }
  },

  async resetWorkerPassword(workerId, newPassword) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'workers.manage')) return denied('reset worker passwords')
    const users = readUsers()
    const acc = users.find((u) => u.workerId === workerId)
    if (!acc) return { data: null, error: 'No login account linked to this worker.' }
    if (!newPassword || newPassword.length < 6) return { data: null, error: 'New password must be at least 6 characters.' }
    acc.password = newPassword
    writeUsers(users)
    return { data: null, error: null }
  },

  async updateOwnProfile(patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'worker') return { data: null, error: 'Only workers can update their own profile here.' }
    if (!c.user.workerId) return { data: null, error: 'No worker account is linked to this user.' }
    const idx = c.data.workers.findIndex((w) => w.id === c.user.workerId)
    if (idx === -1) return { data: null, error: 'Worker not found.' }
    const next: Worker = {
      ...c.data.workers[idx],
      // Only ever touch the profile picture — never the worker's rate, status,
      // name, etc., which are managed by the admin.
      avatar_url: patch.avatar_url === undefined ? c.data.workers[idx].avatar_url : patch.avatar_url,
      updated_at: new Date().toISOString(),
    }
    c.data.workers[idx] = next
    save(c.data)
    return { data: next, error: null }
  },

  async updateOwnPaymentMethods(patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'worker') return { data: null, error: 'Only workers can update their payment methods here.' }
    if (!c.user.workerId) return { data: null, error: 'No worker account is linked to this user.' }
    const idx = c.data.workers.findIndex((w) => w.id === c.user.workerId)
    if (idx === -1) return { data: null, error: 'Worker not found.' }
    // Only ever touch payment fields — never the worker's rate, status,
    // name, avatar, etc., which are managed by the admin.
    const methods = normalizePaymentMethods(patch.payment_methods)
    if (methods.length === 0) return { data: null, error: 'Choose at least one payment method.' }
    const qrEnabled = methods.includes('qr')
    const qrCodeUrl = qrEnabled ? (patch.qr_code_url === undefined ? c.data.workers[idx].qr_code_url : patch.qr_code_url) : null
    if (qrEnabled && !qrCodeUrl) {
      return { data: null, error: 'Upload your QR code image to accept QR Code payments.' }
    }
    const next: Worker = {
      ...c.data.workers[idx],
      payment_methods: methods,
      qr_code_url: qrCodeUrl,
      updated_at: new Date().toISOString(),
    }
    c.data.workers[idx] = next
    save(c.data)
    return { data: normalizeWorker(next), error: null }
  },

  async listWorkers() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    // The background poll excludes the image columns (avatar + QR data URLs
    // are the heaviest fields on the row). The UI merges the separately
    // fetched snapshot from listWorkerAvatars() back in.
    const stripImages = (w: Worker): Worker => ({ ...w, avatar_url: null, qr_code_url: null })
    // A worker with no team-wide capability only ever sees their own row.
    if (!canSeeTeam(c)) {
      const w = c.data.workers.find((x) => x.id === c.user.workerId)
      return { data: w ? [stripImages(w)] : [], error: null }
    }
    return { data: [...c.data.workers].sort((a, b) => a.name.localeCompare(b.name)).map(stripImages), error: null }
  },

  async listWorkerAvatars() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const rows: WorkerAvatar[] = canSeeTeam(c)
      ? c.data.workers
      : c.data.workers.filter((w) => w.id === c.user.workerId)
    return {
      data: rows.map((w) => ({ id: w.id, avatar_url: w.avatar_url ?? null, qr_code_url: w.qr_code_url ?? null })),
      error: null,
    }
  },

  async createWorker(input: CreateWorkerInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'workers.manage')) return denied('add workers')
    const now = new Date().toISOString()
    const worker: Worker = {
      id: uid(),
      name: input.name,
      email: input.email || input.accountEmail || null,
      hourly_rate: input.hourly_rate,
      status: input.status || 'active',
      position: input.position || null,
      avatar_url: null,
      payment_methods: [],
      qr_code_url: null,
      permissions: normalizePermissions(input.permissions),
      workdays: normalizeWorkdays(input.workdays),
      weekly_capacity_hours: normalizeWeeklyCapacity(input.weekly_capacity_hours),
      created_at: now,
      updated_at: now,
    }
    c.data.workers.push(worker)
    // Create the worker's login account.
    const accountEmail = (input.accountEmail || input.email || '').trim().toLowerCase()
    if (accountEmail) {
      const users = readUsers()
      if (users.some((u) => u.email === accountEmail)) {
        return { data: null, error: 'A login account with that email already exists.' }
      }
      users.push({
        id: uid(),
        email: accountEmail,
        password: input.accountPassword || 'worker123',
        role: 'worker',
        workerId: worker.id,
      })
      writeUsers(users)
    }
    save(c.data)
    return { data: worker, error: null }
  },

  async updateWorker(id, patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'workers.manage')) return denied('edit workers')
    const idx = c.data.workers.findIndex((w) => w.id === id)
    if (idx === -1) return { data: null, error: 'Worker not found.' }
    const merged: Worker = { ...c.data.workers[idx], ...patch, updated_at: new Date().toISOString() }
    if (patch.permissions) merged.permissions = normalizePermissions(patch.permissions)
    // Schedule fields always come back usable — the form may send junk.
    if (patch.workdays !== undefined) merged.workdays = normalizeWorkdays(patch.workdays)
    if (patch.weekly_capacity_hours !== undefined) merged.weekly_capacity_hours = normalizeWeeklyCapacity(patch.weekly_capacity_hours)
    c.data.workers[idx] = merged
    // If admin set a new password, update the linked account.
    const newPassword = (patch as { newPassword?: string }).newPassword
    if (newPassword) {
      const users = readUsers()
      const acc = users.find((u) => u.workerId === id)
      if (acc) {
        acc.password = newPassword
        writeUsers(users)
      }
    }
    save(c.data)
    return { data: c.data.workers[idx], error: null }
  },

  async getWorkerLogin(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'workers.manage')) return denied('view login details')
    const worker = c.data.workers.find((w) => w.id === id)
    if (!worker) return { data: null, error: 'Worker not found.' }
    const acc = readUsers().find((u) => u.workerId === id)
    return { data: { email: acc?.email ?? worker.email ?? null, password: acc?.password ?? null }, error: null }
  },

  async deleteWorker(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'workers.manage')) return denied('delete workers')
    c.data.workers = c.data.workers.filter((w) => w.id !== id)
    c.data.entries = c.data.entries.filter((e) => e.worker_id !== id)
    c.data.activeTimers = c.data.activeTimers.filter((t) => t.worker_id !== id)
    c.data.tasks = c.data.tasks.filter((t) => t.worker_id !== id)
    // Payroll lines die with the worker (mirrors the Supabase FK cascade).
    c.data.financeItems = c.data.financeItems.filter((f) => !(f.kind === 'payroll' && f.worker_id === id))
    const entryIds = new Set(c.data.entries.map((e) => e.id))
    c.data.comments = c.data.comments.filter((cm) => entryIds.has(cm.entry_id))
    // Delete the worker's login account.
    const users = readUsers()
    writeUsers(users.filter((u) => u.workerId !== id))
    save(c.data)
    return { data: null, error: null }
  },

  async listEntries(opts) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    // Scoped to the worker's own rows unless they read the whole team's time
    // — either outright (`entries.view_all`) or because they were granted
    // Reports, which is built out of everyone's entries (`reports.view`).
    let rows = !canSeeAllEntries(c)
      ? c.data.entries.filter((e) => e.worker_id === c.user.workerId)
      : c.data.entries
    // Incremental sync: rows created or updated since the last sync.
    if (opts?.since) {
      const since = opts.since
      rows = rows.filter((e) => e.created_at >= since || e.updated_at >= since)
    }
    rows = [...rows].sort((a, b) => b.start_time.localeCompare(a.start_time))
    if (opts?.limit) rows = rows.slice(0, opts.limit)
    return { data: rows, error: null }
  },

  async listOlderEntries(before, limit = 500) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    let rows = c.data.entries.filter((e) => e.start_time <= before)
    if (!canSeeAllEntries(c)) rows = rows.filter((e) => e.worker_id === c.user.workerId)
    rows = [...rows].sort((a, b) => b.start_time.localeCompare(a.start_time))
    return { data: rows.slice(0, limit), error: null }
  },

  async createEntry(input) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'entries.manage')) return denied('add manual entries')
    const now = new Date().toISOString()
    const entry: TimeEntry = {
      id: uid(),
      worker_id: input.worker_id,
      client_id: resolveClientId(c.data, input.client_id),
      project: input.project || null,
      start_time: input.start_time,
      end_time: input.end_time,
      break_minutes: input.break_minutes,
      notes: input.notes || null,
      hourly_rate: input.hourly_rate,
      total_minutes: input.total_minutes,
      earnings: input.earnings,
      created_at: now,
      updated_at: now,
    }
    c.data.entries.push(entry)
    // Notify the worker that the admin added time for them.
    const wid = workerUserId(entry.worker_id)
    if (wid) {
      pushNotification(c.data, wid, {
        entry_id: entry.id,
        type: 'time_added',
        message: `${workerName(c.data, entry.worker_id)} — the admin added time for you (${formatMinutes(entry.total_minutes)})`,
      })
    }
    save(c.data)
    return { data: entry, error: null }
  },

  async updateEntry(id, patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'entries.manage')) return denied('edit time entries')
    const idx = c.data.entries.findIndex((e) => e.id === id)
    if (idx === -1) return { data: null, error: 'Entry not found.' }
    c.data.entries[idx] = { ...c.data.entries[idx], ...patch, updated_at: new Date().toISOString() }
    save(c.data)
    return { data: c.data.entries[idx], error: null }
  },

  async deleteEntry(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'entries.manage')) return denied('delete time entries')
    c.data.entries = c.data.entries.filter((e) => e.id !== id)
    c.data.comments = c.data.comments.filter((cm) => cm.entry_id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  async getActiveTimer() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    // A worker re-linked mid-shift may own a stale timer — adopt it before the
    // "which timer is mine" lookup so the on-screen clock never resets on the
    // person until their own action (or this read) closes the shift properly.
    reclaimStaleTimers(c)
    return { data: ownTimer(c), error: null }
  },

  async listActiveTimers() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role === 'worker') {
      const mine = c.data.activeTimers.filter((t) => t.worker_id === c.user.workerId)
      return { data: mine, error: null }
    }
    // The admin sees everyone that is currently on the clock.
    const all = [...c.data.activeTimers].sort((a, b) => b.start_time.localeCompare(a.start_time))
    return { data: all, error: null }
  },

  async startTimer(input) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    reclaimStaleTimers(c)
    let workerId = input.worker_id
    let rate = input.hourly_rate
    if (c.user.role === 'worker') {
      // Workers can only clock in for themselves, at their admin-set rate.
      workerId = c.user.workerId || ''
      const w = c.data.workers.find((x) => x.id === workerId)
      if (!w) return { data: null, error: 'No worker profile linked to this account.' }
      rate = w.hourly_rate
      // Every shift is booked to a client. A worker calling startTimer without
      // a client_id means the UI skipped the dialog — refuse the clock-in so
      // untagged hours never land in the ledger.
      if (!input.client_id) {
        return { data: null, error: 'Choose a client before clocking in.' }
      }
    } else {
      const w = c.data.workers.find((x) => x.id === workerId)
      if (!w) return { data: null, error: 'Select a worker.' }
      rate = rate ?? w.hourly_rate
    }
    // Only one timer per worker — other workers may be clocked in at the same time.
    const existing = c.data.activeTimers.find((t) => t.worker_id === workerId)
    if (existing) {
      if (c.user.role === 'worker') return { data: existing, error: null }
      return { data: null, error: 'That worker already has a running timer.' }
    }
    const startedAt = input.start_time || new Date().toISOString()
    const timer: ActiveTimer = {
      id: uid(),
      worker_id: workerId,
      client_id: resolveClientId(c.data, input.client_id),
      project: input.project || null,
      start_time: startedAt,
      // Whole-shift anchors — stay put across client switches so the UI clock
      // does not reset while each client still gets its own allocated minutes.
      session_start: startedAt,
      prior_worked_ms: 0,
      notes: input.notes || null,
      hourly_rate: rate ?? 0,
      paused: false,
      pause_start: null,
      total_pause_ms: 0,
      created_at: new Date().toISOString(),
    }
    c.data.activeTimers.push(timer)
    // Notify the admin when a worker clocks in.
    if (c.user.role === 'worker') {
      const detail = [
        clientName(c.data, timer.client_id) || timer.project,
        timer.notes ? timer.notes.replace(/\s+/g, ' ').slice(0, 140) : null,
      ].filter(Boolean).join(' · ')
      pushNotification(c.data, c.admin.id, {
        entry_id: null,
        type: 'time_in',
        message: `${workerName(c.data, workerId)} clocked in${detail ? ` — ${detail}` : ''}`,
      })
    }
    save(c.data)
    return { data: timer, error: null }
  },

  async pauseTimer(timerId) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    reclaimStaleTimers(c)
    const t = findTimer(c, timerId)
    if (!t) return { data: null, error: 'No active timer.' }
    if (c.user.role === 'worker' && t.worker_id !== c.user.workerId) return { data: null, error: 'Not your timer.' }
    if (t.paused) return { data: t, error: null }
    t.paused = true
    t.pause_start = new Date().toISOString()
    // Let the admin know the worker went on break.
    if (c.user.role === 'worker') {
      pushNotification(c.data, c.admin.id, {
        entry_id: null,
        type: 'break_start',
        message: `${workerName(c.data, t.worker_id)} started a break`,
      })
    }
    save(c.data)
    return { data: t, error: null }
  },

  async resumeTimer(timerId) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    reclaimStaleTimers(c)
    const t = findTimer(c, timerId)
    if (!t) return { data: null, error: 'No active timer.' }
    if (c.user.role === 'worker' && t.worker_id !== c.user.workerId) return { data: null, error: 'Not your timer.' }
    if (!t.paused) return { data: t, error: null }
    if (t.pause_start) {
      t.total_pause_ms += new Date().getTime() - new Date(t.pause_start).getTime()
    }
    t.paused = false
    t.pause_start = null
    if (c.user.role === 'worker') {
      pushNotification(c.data, c.admin.id, {
        entry_id: null,
        type: 'break_end',
        message: `${workerName(c.data, t.worker_id)} is back from break`,
      })
    }
    save(c.data)
    return { data: t, error: null }
  },

  async stopTimer(timerId, note) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    reclaimStaleTimers(c)
    const timer = c.data.activeTimers.find((t) => t.id === timerId)
    if (!timer) return { data: null, error: 'No active timer found.' }
    if (c.user.role === 'worker' && timer.worker_id !== c.user.workerId) return { data: null, error: 'Not your timer.' }
    const clockOutNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : null
    const end = new Date()
    let totalPause = timer.total_pause_ms || 0
    if (timer.paused && timer.pause_start) {
      totalPause += end.getTime() - new Date(timer.pause_start).getTime()
    }
    const workingMs = Math.max(0, end.getTime() - new Date(timer.start_time).getTime() - totalPause)
    const totalMinutes = Math.max(0, Math.round(workingMs / 60000))
    const breakMinutes = Math.max(0, Math.round(totalPause / 60000))
    const rate = timer.hourly_rate ?? 0
    const entry: TimeEntry = {
      id: uid(),
      worker_id: timer.worker_id,
      client_id: timer.client_id ?? null,
      project: timer.project || null,
      start_time: timer.start_time,
      end_time: end.toISOString(),
      break_minutes: breakMinutes,
      notes: [timer.notes, clockOutNote].filter(Boolean).join('\n') || null,
      hourly_rate: rate,
      total_minutes: totalMinutes,
      earnings: computeEarnings(totalMinutes, rate),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    c.data.entries.push(entry)
    c.data.activeTimers = c.data.activeTimers.filter((t) => t.id !== timer.id)
    // Notify the admin when a worker clocks out.
    // Always notify on clock out — with or without a note.
    if (c.user.role === 'worker') {
      const parts = [formatMinutes(entry.total_minutes)]
      const scope = clientName(c.data, entry.client_id) || entry.project
      if (scope) parts.push(scope)
      parts.push(clockOutNote ? 'added a note' : 'no note')
      pushNotification(c.data, c.admin.id, {
        entry_id: entry.id,
        type: 'time_out',
        message: `${workerName(c.data, entry.worker_id)} clocked out — ${parts.join(' · ')}`,
      })
    }
    save(c.data)
    return { data: entry, error: null }
  },

  async switchClient(input) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    reclaimStaleTimers(c)
    if (c.user.role !== 'worker') return { data: null, error: 'Only workers can switch the client they are working for.' }
    const workerId = c.user.workerId
    if (!workerId) return { data: null, error: 'No worker profile linked to this account.' }
    const timer = c.data.activeTimers.find((t) => t.worker_id === workerId)
    if (!timer) return { data: null, error: 'No active timer.' }
    const newClientId = resolveClientId(c.data, input.client_id)
    if (!newClientId) return { data: null, error: 'Choose a client.' }
    if (timer.client_id === newClientId) {
      return { data: null, error: "You're already working for that client." }
    }
    const now = new Date()
    // Close the old segment exactly like a clock-out would (an in-progress
    // break is folded in, so a switch while paused ends the break).
    let totalPause = timer.total_pause_ms || 0
    if (timer.paused && timer.pause_start) {
      totalPause += now.getTime() - new Date(timer.pause_start).getTime()
    }
    // Minutes for THIS client only (from the current segment start).
    const workingMs = Math.max(0, now.getTime() - new Date(timer.start_time).getTime() - totalPause)
    const totalMinutes = Math.max(0, Math.round(workingMs / 60000))
    const breakMinutes = Math.max(0, Math.round(totalPause / 60000))
    // The finished stretch is booked to the client the worker was on before
    // the switch; it carries the shift's original note.
    const entry: TimeEntry = {
      id: uid(),
      worker_id: timer.worker_id,
      client_id: timer.client_id ?? null,
      project: timer.project || null,
      start_time: timer.start_time,
      end_time: now.toISOString(),
      break_minutes: breakMinutes,
      notes: timer.notes || null,
      hourly_rate: timer.hourly_rate ?? 0,
      total_minutes: totalMinutes,
      earnings: computeEarnings(totalMinutes, timer.hourly_rate ?? 0),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }
    c.data.entries.push(entry)
    c.data.activeTimers = c.data.activeTimers.filter((t) => t.id !== timer.id)
    // Keep the on-screen shift clock continuous: carry forward the original
    // clock-in and the worked ms already saved to previous clients.
    const sessionStart = timer.session_start || timer.start_time
    const priorWorkedMs = Math.max(0, (timer.prior_worked_ms || 0) + workingMs)
    const next: ActiveTimer = {
      id: uid(),
      worker_id: timer.worker_id,
      client_id: newClientId,
      project: null,
      start_time: now.toISOString(),
      session_start: sessionStart,
      prior_worked_ms: priorWorkedMs,
      notes: typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : null,
      hourly_rate: timer.hourly_rate ?? 0,
      paused: false,
      pause_start: null,
      total_pause_ms: 0,
      created_at: now.toISOString(),
    }
    c.data.activeTimers.push(next)
    save(c.data)
    return { data: next, error: null }
  },

  async deleteTimer(timerId) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    reclaimStaleTimers(c)
    const t = c.data.activeTimers.find((x) => x.id === timerId)
    if (!t) return { data: null, error: null }
    if (c.user.role === 'worker' && t.worker_id !== c.user.workerId) return { data: null, error: 'Not your timer.' }
    c.data.activeTimers = c.data.activeTimers.filter((x) => x.id !== timerId)
    save(c.data)
    return { data: null, error: null }
  },

  async getSettings() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!c.data.settings) {
      c.data.settings = {
        id: 'settings-1',
        business_name: 'My Business',
        currency: 'USD',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        default_hourly_rate: 20,
        avatar_url: null,
        // No server in demo mode, so no scheduled sync — the UI uses the bundled
        // fallback rate and marks it approximate.
      }
      save(c.data)
    }
    return { data: c.data.settings, error: null }
  },

  async saveSettings(patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'settings.manage')) return denied('change business settings')
    if (!c.data.settings) c.data.settings = { id: 'settings-1', business_name: 'My Business', currency: 'USD', timezone: 'UTC', default_hourly_rate: 20, avatar_url: null }
    c.data.settings = { ...c.data.settings, ...patch }
    save(c.data)
    return { data: c.data.settings, error: null }
  },

  // Slack integration config. Kept in its own storage slot (keyed by the
  // workspace admin) so it survives "Delete all data", which wipes the main
  // blob. In demo mode there is no server, so notifySlack() posts to Slack
  // straight from the browser using this webhook URL.
  async getSlackSettings() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'settings.manage')) return denied('view the Slack settings')
    // Merge over the defaults so rows saved before a field existed (e.g. the
    // approval webhook) still read back with every toggle set.
    return { data: { ...DEFAULT_SLACK_SETTINGS, ...read<SlackSettings>(slackKey(c.admin.id), { ...DEFAULT_SLACK_SETTINGS }) }, error: null }
  },

  async saveSlackSettings(patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'settings.manage')) return denied('change the Slack settings')
    const next: SlackSettings = { ...DEFAULT_SLACK_SETTINGS, ...read<SlackSettings>(slackKey(c.admin.id), { ...DEFAULT_SLACK_SETTINGS }), ...patch }
    next.webhook_url = next.webhook_url?.trim() ? next.webhook_url.trim() : null
    next.task_webhook_url = next.task_webhook_url?.trim() ? next.task_webhook_url.trim() : null
    next.approval_webhook_url = next.approval_webhook_url?.trim() ? next.approval_webhook_url.trim() : null
    write(slackKey(c.admin.id), next)
    return { data: next, error: null }
  },

  async listEntryComments(entryId) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const entry = c.data.entries.find((e) => e.id === entryId)
    if (!entry) return { data: null, error: 'Entry not found.' }
    if (c.user.role === 'worker' && entry.worker_id !== c.user.workerId) return { data: null, error: 'Not your entry.' }
    const comments = c.data.comments
      .filter((cm) => cm.entry_id === entryId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
    return { data: comments, error: null }
  },

  async addEntryComment(entryId, body) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const entry = c.data.entries.find((e) => e.id === entryId)
    if (!entry) return { data: null, error: 'Entry not found.' }
    if (c.user.role === 'worker' && entry.worker_id !== c.user.workerId) return { data: null, error: 'Not your entry.' }
    const comment: TimeEntryComment = {
      id: uid(),
      entry_id: entryId,
      author_id: c.user.id,
      author_name: c.user.role === 'admin' ? 'Admin' : workerName(c.data, entry.worker_id),
      author_role: c.user.role,
      body,
      created_at: new Date().toISOString(),
    }
    c.data.comments.push(comment)
    // Notify the other party.
    if (c.user.role === 'admin') {
      const wid = workerUserId(entry.worker_id)
      if (wid) {
        pushNotification(c.data, wid, {
          entry_id: entry.id,
          type: 'note',
          message: `Admin replied to your note on ${formatDate(entry.start_time)}`,
        })
      }
    } else {
      pushNotification(c.data, c.admin.id, {
        entry_id: entry.id,
        type: 'note',
        message: `${workerName(c.data, entry.worker_id)} added a note on ${formatDate(entry.start_time)}`,
      })
    }
    save(c.data)
    return { data: comment, error: null }
  },

  async listNotifications(limit) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const mine = c.data.notifications
      .filter((n) => n.user_id === c.user.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    return { data: limit ? mine.slice(0, limit) : mine, error: null }
  },

  async countUnreadNotifications() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    return { data: c.data.notifications.filter((n) => n.user_id === c.user.id && !n.read).length, error: null }
  },

  async markNotificationsRead() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    for (const n of c.data.notifications) {
      if (n.user_id === c.user.id) n.read = true
    }
    save(c.data)
    return { data: null, error: null }
  },

  async createNotification(recipientUserId: string, n: { entry_id?: string | null; ticket_id?: string | null; type: AppNotification['type']; message: string }) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }

    // Deduplication guard: an overdue recurring payment notice for a given bill and due date
    // should only be delivered once, even if called multiple times or concurrently.
    const isOverdueNotice = n.type === 'payment' && n.message.toLowerCase().includes('overdue recurring payment')
    if (isOverdueNotice) {
      const nameMatch = n.message.match(/Overdue recurring payment:\s*"([^"]+)"/i)
      const dueMatch = n.message.match(/was due on\s+(\d{4}-\d{2}-\d{2})/i)
      if (nameMatch && dueMatch) {
        const billName = nameMatch[1].toLowerCase()
        const dueDate = dueMatch[1]
        const existing = c.data.notifications.find((existing) => {
          if (existing.user_id !== recipientUserId || existing.type !== 'payment') return false
          if (!existing.message.toLowerCase().includes('overdue recurring payment')) return false
          const eName = existing.message.match(/Overdue recurring payment:\s*"([^"]+)"/i)
          const eDue = existing.message.match(/was due on\s+(\d{4}-\d{2}-\d{2})/i)
          return (
            (eName && eName[1].toLowerCase() === billName && eDue && eDue[1] === dueDate) ||
            (existing.message.includes(`"${nameMatch[1]}"`) && existing.message.includes(dueDate))
          )
        })
        if (existing) {
          return { data: existing, error: null }
        }
      }
    }

    const notif: AppNotification = {
      id: uid(),
      user_id: recipientUserId,
      entry_id: n.entry_id ?? null,
      ticket_id: n.ticket_id ?? null,
      type: n.type,
      message: n.message,
      read: false,
      created_at: new Date().toISOString(),
    }
    c.data.notifications.push(notif)
    save(c.data)
    return { data: notif, error: null }
  },

  async listPayments(limit) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    let rows = !can(c, 'payments.view_all')
      ? c.data.payments.filter((p) => p.worker_id === c.user.workerId)
      : c.data.payments
    rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))
    return { data: limit ? rows.slice(0, limit) : rows, error: null }
  },

  async settleWorker(workerId, note) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'payments.manage')) return denied('settle worker time')
    const worker = c.data.workers.find((w) => w.id === workerId)
    if (!worker) return { data: null, error: 'Worker not found.' }
    // Settling never deletes time entries. It pays out the worker's unsettled
    // entries and stamps them, so they stay in Time Entries (with their notes)
    // until someone deletes one by hand, and the next settlement only covers
    // time worked since.
    const unsettled = c.data.entries.filter((e) => e.worker_id === workerId && !e.settled_at)
    if (unsettled.length === 0) {
      return { data: null, error: 'This worker has no unsettled time to settle.' }
    }
    let totalMinutes = 0
    let earnings = 0
    let periodStart = unsettled[0].start_time
    let periodEnd = unsettled[0].end_time
    for (const e of unsettled) {
      totalMinutes += e.total_minutes
      earnings += e.earnings
      if (e.start_time < periodStart) periodStart = e.start_time
      if (e.end_time > periodEnd) periodEnd = e.end_time
    }
    const now = new Date()
    const payment: Payment = {
      id: uid(),
      worker_id: workerId,
      amount: Math.round(earnings * 100) / 100,
      hours: Math.round((totalMinutes / 60) * 100) / 100,
      status: 'unpaid',
      period_start: periodStart,
      period_end: periodEnd,
      created_at: now.toISOString(),
      paid_at: null,
      note: note || null,
      // Filled in when the admin marks the payment as paid.
      payment_method: null,
      reference_number: null,
    }
    c.data.payments.push(payment)
    // Mark the paid-for time as settled — the rows themselves are kept.
    const settledAt = now.toISOString()
    for (const e of unsettled) {
      e.settled_at = settledAt
      e.updated_at = settledAt
    }
    // Notify the worker.
    const wid = workerUserId(workerId)
    if (wid) {
      pushNotification(c.data, wid, {
        entry_id: null,
        type: 'payment',
        message: `A payment of ${formatMoney(payment.amount, c.data.settings?.currency || 'USD')} has been created for you`,
      })
    }
    save(c.data)
    return { data: payment, error: null }
  },

  async updatePaymentStatus(id, status, paymentMethod, referenceNumber) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'payments.manage')) return denied('update payment status')
    const p = c.data.payments.find((x) => x.id === id)
    if (!p) return { data: null, error: 'Payment not found.' }
    const method = normalizePaidMethod(paymentMethod)
    if (status === 'paid' && paymentMethod && !method) {
      return { data: null, error: 'Choose Cash or QR Code as the payment method.' }
    }
    const reference = normalizeReferenceNumber(referenceNumber)
    p.status = status
    p.paid_at = status === 'paid' ? new Date().toISOString() : null
    // The method and reference only describe a completed payment.
    p.payment_method = status === 'paid' ? method : null
    p.reference_number = status === 'paid' ? reference : null
    // Notify the worker on status change.
    const wid = workerUserId(p.worker_id)
    if (wid) {
      pushNotification(c.data, wid, {
        entry_id: null,
        type: 'payment',
        message:
          `Your payment of ${formatMoney(p.amount, c.data.settings?.currency || 'USD')} is now ${status}` +
          (status === 'paid' && method ? ` (${paymentMethodLabel(method)})` : '') +
          (status === 'paid' && reference ? ` · Ref ${reference}` : ''),
      })
    }
    save(c.data)
    return { data: p, error: null }
  },

  async updatePaymentNote(id, note) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'payments.manage')) return denied('edit payment notes')
    const p = c.data.payments.find((x) => x.id === id)
    if (!p) return { data: null, error: 'Payment not found.' }
    p.note = note
    save(c.data)
    return { data: p, error: null }
  },

  async deletePayment(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'payments.manage')) return denied('delete payments')
    c.data.payments = c.data.payments.filter((p) => p.id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  // ---- Finance (subscriptions, payroll, bills) ------------------------------
  // The ledger belongs to the whole workspace, so a worker without
  // `finance.view` simply gets an empty list (never an error — the store
  // fetches it on every sync). `finance.manage` gates the writes.

  async listFinanceItems() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'finance.view')) return { data: [] as FinanceItem[], error: null }
    return { data: sortFinanceItems(c.data.financeItems), error: null }
  },

  async createFinanceItem(input: CreateFinanceItemInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'finance.manage')) return denied('add finance lines')
    const kind = normalizeFinanceKind(input.kind)
    if (!kind) return { data: null, error: 'Choose what kind of finance line this is.' }
    const amount = Number(input.amount)
    if (!Number.isFinite(amount) || amount < 0) return { data: null, error: 'Enter an amount of 0 or more.' }
    const dueDate = normalizeFinanceDate(input.due_date)
    if (!dueDate) return { data: null, error: 'Pick a due date.' }
    const name = input.name?.trim() || null
    const workerId = input.worker_id || null
    const periodMonth = normalizeFinanceMonth(input.period_month)
    if (kind === 'subscription' || kind === 'bill') {
      if (!name) return { data: null, error: kind === 'subscription' ? 'Give the subscription a name.' : 'Give the bill a label.' }
      if (name.length > 80) return { data: null, error: 'Names are limited to 80 characters.' }
    }
    if (kind === 'payroll') {
      if (!workerId) return { data: null, error: 'Choose the worker being paid.' }
      if (!c.data.workers.some((w) => w.id === workerId)) return { data: null, error: 'Worker not found.' }
      if (!periodMonth) return { data: null, error: 'Choose the month this pay covers.' }
      // One run per worker per month — settle it, or edit the existing line.
      const dupe = c.data.financeItems.some(
        (f) => f.kind === 'payroll' && f.worker_id === workerId && f.period_month === periodMonth
      )
      if (dupe) return { data: null, error: 'That worker already has a payroll line for this month — edit it instead.' }
    }
    const now = new Date().toISOString()
    const status = normalizeFinanceStatus(kind, input.status)
    if (input.max_occurrences != null && (kind !== 'subscription' || !Number.isFinite(input.max_occurrences) || input.max_occurrences < 1 || Math.floor(input.max_occurrences) !== input.max_occurrences)) {
      return { data: null, error: 'The number of times a subscription bills must be a whole number of 1 or more.' }
    }
    const item: FinanceItem = normalizeFinanceItem({
      id: uid(),
      kind,
      name: kind === 'payroll' ? null : name,
      worker_id: workerId,
      amount,
      cycle: input.cycle ?? null,
      period_month: periodMonth,
      due_date: dueDate,
      status,
      paid_at: status === 'paid' ? now : null,
      note: input.note ?? null,
      max_occurrences: kind === 'subscription' ? (input.max_occurrences ?? null) : null,
      billed_count: 0,
      created_at: now,
      updated_at: now,
    })
    c.data.financeItems.push(item)
    save(c.data)
    return { data: item, error: null }
  },

  async updateFinanceItem(id, patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'finance.manage')) return denied('edit finance lines')
    const idx = c.data.financeItems.findIndex((f) => f.id === id)
    if (idx === -1) return { data: null, error: 'Finance line not found.' }
    const current = c.data.financeItems[idx]
    if (patch.worker_id && !c.data.workers.some((w) => w.id === patch.worker_id)) {
      return { data: null, error: 'Worker not found.' }
    }
    if (patch.due_date !== undefined && !normalizeFinanceDate(patch.due_date)) {
      return { data: null, error: 'Pick a due date.' }
    }
    if (patch.amount !== undefined && (!Number.isFinite(Number(patch.amount)) || Number(patch.amount) < 0)) {
      return { data: null, error: 'Enter an amount of 0 or more.' }
    }
    if (patch.period_month !== undefined && current.kind === 'payroll') {
      const pm = normalizeFinanceMonth(patch.period_month)
      const dupe = pm && c.data.financeItems.some(
        (f) => f.id !== id && f.kind === 'payroll' && f.worker_id === (patch.worker_id ?? current.worker_id) && f.period_month === pm
      )
      if (dupe) return { data: null, error: 'That worker already has a payroll line for this month — edit it instead.' }
    }
    if (patch.max_occurrences !== undefined && patch.max_occurrences !== null && (current.kind !== 'subscription' || !Number.isFinite(patch.max_occurrences) || patch.max_occurrences < 1 || Math.floor(patch.max_occurrences) !== patch.max_occurrences)) {
      return { data: null, error: 'The number of times a subscription bills must be a whole number of 1 or more.' }
    }
    const at = new Date().toISOString()
    // Marking paid stamps the time (keeping an existing stamp); moving back
    // to unpaid clears it. normalizeFinanceItem enforces the same invariant.
    // Rolling a subscription's due date forward is a billing: the counter
    // goes up and a reached limit pauses the subscription by itself.
    const next = applyBillingCount(current, patch, normalizeFinanceItem({
      ...current,
      ...patch,
      // The kind is fixed once created — it decides the row's shape.
      kind: current.kind,
      id: current.id,
      created_at: current.created_at,
      updated_at: at,
      paid_at: patch.status === 'paid' ? (current.paid_at ?? at) : patch.status ? null : current.paid_at,
    }))
    c.data.financeItems[idx] = next
    save(c.data)
    return { data: next, error: null }
  },

  async deleteFinanceItem(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'finance.manage')) return denied('delete finance lines')
    c.data.financeItems = c.data.financeItems.filter((f) => f.id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  // ---- Clients (master list) ----------------------------------------------
  // Both roles read the list (a worker needs the name/colour of the clients on
  // their own board and in their filters); only the admin may change it.
  // Inactive clients stay in the list so historical work keeps its label — the
  // UI is what limits new work to the active ones.

  async listClients() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    return { data: sortClients(c.data.clients), error: null }
  },

  async createClient(input: CreateClientInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'clients.manage')) return denied('manage clients')
    const name = input.name.trim()
    if (!name) return { data: null, error: 'Give the client a name.' }
    if (name.length > 80) return { data: null, error: 'Client names are limited to 80 characters.' }
    if (c.data.clients.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      return { data: null, error: `"${name}" is already on the list.` }
    }
    const now = new Date().toISOString()
    const client: Client = {
      id: uid(),
      name,
      color: normalizeClientColor(input.color),
      status: normalizeClientStatus(input.status),
      created_at: now,
      updated_at: now,
    }
    c.data.clients.push(client)
    save(c.data)
    return { data: client, error: null }
  },

  async updateClient(id, patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'clients.manage')) return denied('manage clients')
    const idx = c.data.clients.findIndex((x) => x.id === id)
    if (idx === -1) return { data: null, error: 'Client not found.' }
    const current = c.data.clients[idx]
    const name = patch.name !== undefined ? patch.name.trim() : current.name
    if (!name) return { data: null, error: 'Give the client a name.' }
    if (c.data.clients.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) {
      return { data: null, error: `"${name}" is already on the list.` }
    }
    const next: Client = normalizeClient({
      ...current,
      ...patch,
      name,
      id: current.id,
      created_at: current.created_at,
      updated_at: new Date().toISOString(),
    })
    c.data.clients[idx] = next
    save(c.data)
    return { data: next, error: null }
  },

  async deleteClient(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'clients.manage')) return denied('manage clients')
    // Deleting would strip the label off work that has already happened, so a
    // client in use can only be marked inactive.
    const usedByTasks = c.data.tasks.some((t) => t.client_id === id)
    const usedByEntries = c.data.entries.some((e) => e.client_id === id)
    if (usedByTasks || usedByEntries) {
      return { data: null, error: 'This client is used by existing tasks or time entries. Mark it inactive instead.' }
    }
    c.data.clients = c.data.clients.filter((x) => x.id !== id)
    // The board is derived from the master list — a deleted client loses its place.
    c.data.clientPriorities = c.data.clientPriorities.filter((p) => p.client_id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  // ---- Client priority board ----------------------------------------------
  // One board for the whole workspace. The admin runs it by default; a worker
  // the admin granted `priority_board.view` sees and drags the very same
  // board. Clients without a row are unranked (bottom of Low Priority), so
  // new clients land on the board by themselves and reset = delete all rows.

  async listClientPriorities() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'priority_board.view')) return denied('use the client priority board')
    return { data: sortClientPriorities(c.data.clientPriorities), error: null }
  },

  async moveClientPriority(clientId, lane, position) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'priority_board.view')) return denied('use the client priority board')
    if (!c.data.clients.some((x) => x.id === clientId)) return { data: null, error: 'Client not found.' }
    const target = normalizeClientPriorityLane(lane)
    const now = new Date().toISOString()
    let row = c.data.clientPriorities.find((p) => p.client_id === clientId)
    if (!row) {
      row = { id: uid(), client_id: clientId, lane: target, position: 0, created_at: now, updated_at: now }
      c.data.clientPriorities.push(row)
    }
    row.lane = target
    row.updated_at = now
    reindexClientPriorityLane(c.data.clientPriorities, target, clientId, position)
    save(c.data)
    return { data: row, error: null }
  },

  async resetClientPriorities() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'priority_board.view')) return denied('use the client priority board')
    c.data.clientPriorities = []
    save(c.data)
    return { data: null, error: null }
  },

  // ---- Meetings -------------------------------------------------------------
  // One schedule for the whole workspace. The admin runs it by default; a
  // worker the admin granted `meetings.view` sees and manages the very same
  // list. No attendees or invites — whoever can open the page can run it.

  async listMeetings() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'meetings.view')) return denied('use the meetings section')
    return { data: sortMeetings(c.data.meetings, Date.now()), error: null }
  },

  async createMeeting(input: CreateMeetingInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'meetings.view')) return denied('use the meetings section')
    const title = input.title.trim()
    if (!title) return { data: null, error: 'Give the meeting a title.' }
    if (title.length > 200) return { data: null, error: 'Meeting titles are limited to 200 characters.' }
    const start = new Date(input.start_time)
    if (!Number.isFinite(start.getTime())) return { data: null, error: 'Pick a valid date and time.' }
    const now = new Date().toISOString()
    const meeting: Meeting = {
      id: uid(),
      title,
      start_time: start.toISOString(),
      notes: input.notes?.trim() || null,
      created_at: now,
      updated_at: now,
    }
    c.data.meetings.push(meeting)
    save(c.data)
    return { data: meeting, error: null }
  },

  async updateMeeting(id, patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'meetings.view')) return denied('use the meetings section')
    const idx = c.data.meetings.findIndex((m) => m.id === id)
    if (idx === -1) return { data: null, error: 'Meeting not found.' }
    const current = c.data.meetings[idx]
    const title = patch.title !== undefined ? patch.title.trim() : current.title
    if (!title) return { data: null, error: 'Give the meeting a title.' }
    const start = patch.start_time !== undefined ? new Date(patch.start_time) : new Date(current.start_time)
    if (!Number.isFinite(start.getTime())) return { data: null, error: 'Pick a valid date and time.' }
    const next: Meeting = normalizeMeeting({
      ...current,
      ...patch,
      title,
      start_time: start.toISOString(),
      notes: patch.notes !== undefined ? patch.notes?.trim() || null : current.notes,
      id: current.id,
      created_at: current.created_at,
      updated_at: new Date().toISOString(),
    })
    c.data.meetings[idx] = next
    save(c.data)
    return { data: next, error: null }
  },

  async deleteMeeting(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'meetings.view')) return denied('use the meetings section')
    c.data.meetings = c.data.meetings.filter((m) => m.id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  // ---- Notepad -------------------------------------------------------------
  // STRICTLY PRIVATE scratchpad: the admin and every worker have their own
  // notepad. `owner_id` is the session user's id and every query filters on
  // it, so nobody ever reads another person's notes — no permission gate,
  // because nothing is shared.

  async listNotes() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    return { data: sortNotes(c.data.notes.filter((n) => n.owner_id === c.user.id)), error: null }
  },

  async createNote(input: CreateNoteInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const title = input.title.trim()
    const body = input.body.trim()
    if (title.length > 200) return { data: null, error: 'Note titles are limited to 200 characters.' }
    if (body.length > 10000) return { data: null, error: 'Notes are limited to 10,000 characters.' }
    if (!title && !body) return { data: null, error: 'Write something in the note first.' }
    const now = new Date().toISOString()
    const note: Note = {
      id: uid(),
      owner_id: c.user.id,
      title,
      body,
      color: NOTE_COLORS.includes(input.color as NoteColor) ? (input.color as NoteColor) : DEFAULT_NOTE_COLOR,
      pinned: !!input.pinned,
      created_at: now,
      updated_at: now,
    }
    c.data.notes.push(note)
    save(c.data)
    return { data: note, error: null }
  },

  async updateNote(id, patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    // Owner-scoped lookup: another account's note answers "not found".
    const idx = c.data.notes.findIndex((n) => n.id === id && n.owner_id === c.user.id)
    if (idx === -1) return { data: null, error: 'Note not found.' }
    const current = c.data.notes[idx]
    const title = patch.title !== undefined ? patch.title.trim() : current.title
    const body = patch.body !== undefined ? patch.body.trim() : current.body
    if (title.length > 200) return { data: null, error: 'Note titles are limited to 200 characters.' }
    if (body.length > 10000) return { data: null, error: 'Notes are limited to 10,000 characters.' }
    if (!title && !body) return { data: null, error: 'Write something in the note first.' }
    // Pin/colour toggles are not "edits": they must not make the card jump to
    // newest-first. Only title/body changes re-stamp updated_at.
    const contentChanged = patch.title !== undefined || patch.body !== undefined
    const next: Note = normalizeNote({
      ...current,
      ...patch,
      title,
      body,
      id: current.id,
      owner_id: current.owner_id,
      created_at: current.created_at,
      updated_at: contentChanged ? new Date().toISOString() : current.updated_at,
    })
    c.data.notes[idx] = next
    save(c.data)
    return { data: next, error: null }
  },

  async deleteNote(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    c.data.notes = c.data.notes.filter((n) => !(n.id === id && n.owner_id === c.user.id))
    save(c.data)
    return { data: null, error: null }
  },

  // ---- Client invoicing -----------------------------------------------------
  // One board for the whole workspace. The admin runs it by default; a worker
  // the admin granted `invoices.view` sees and manages the very same board.
  // Whoever can open the page can run it — the stage IS the status, so there
  // is no separate manage key (same shape as the meetings section).

  async listInvoices() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'invoices.view')) return denied('use the invoicing board')
    return { data: sortInvoices(c.data.invoices), error: null }
  },

  async createInvoice(input: CreateInvoiceInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'invoices.view')) return denied('use the invoicing board')
    // Client and project are different billing targets: a client-based
    // invoice bills a client from the master list, a project-based one bills
    // a named project and carries no client at all.
    const basis = normalizeInvoiceBasis(input.basis)
    let client_id: string | null = null
    if (basis === 'client') {
      client_id = input.client_id
      if (!client_id || !c.data.clients.some((cl) => cl.id === client_id)) return { data: null, error: 'Pick a client to bill.' }
    }
    const project_name = normalizeInvoiceProjectName(basis, input.project_name)
    if (basis === 'project' && !project_name) return { data: null, error: 'Name the project this invoice bills.' }
    const amount = Number(input.amount)
    if (!Number.isFinite(amount) || amount < 0) return { data: null, error: 'Give the invoice a valid amount — or leave it at zero while the figure is unknown.' }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.due_date) || Number.isNaN(new Date(`${input.due_date}T00:00:00`).getTime())) {
      return { data: null, error: 'Pick the date payment is due.' }
    }
    const now = new Date().toISOString()
    const invoice: Invoice = {
      id: uid(),
      client_id,
      basis,
      project_name,
      amount: Math.round(amount * 100) / 100,
      due_date: input.due_date,
      stage: normalizeInvoiceStage(input.stage),
      notes: input.notes?.trim() || null,
      created_at: now,
      updated_at: now,
    }
    c.data.invoices.push(invoice)
    save(c.data)
    return { data: invoice, error: null }
  },

  async updateInvoice(id, patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'invoices.view')) return denied('use the invoicing board')
    const idx = c.data.invoices.findIndex((i) => i.id === id)
    if (idx === -1) return { data: null, error: 'Invoice not found.' }
    const current = c.data.invoices[idx]
    const basis = patch.basis !== undefined ? normalizeInvoiceBasis(patch.basis) : current.basis
    // Switching basis re-targets the billing: project based drops the client,
    // client based must end up with one from the master list.
    let client_id = patch.client_id !== undefined ? patch.client_id : current.client_id
    if (basis === 'project') {
      client_id = null
    } else if (!client_id || !c.data.clients.some((cl) => cl.id === client_id)) {
      return { data: null, error: 'Pick a client to bill.' }
    }
    const project_name = patch.project_name !== undefined
      ? normalizeInvoiceProjectName(basis, patch.project_name)
      : normalizeInvoiceProjectName(basis, current.project_name)
    if (basis === 'project' && !project_name) return { data: null, error: 'Name the project this invoice bills.' }
    const amount = patch.amount !== undefined ? Number(patch.amount) : current.amount
    if (!Number.isFinite(amount) || amount < 0) return { data: null, error: 'Give the invoice a valid amount — or leave it at zero while the figure is unknown.' }
    const due_date = patch.due_date !== undefined ? patch.due_date : current.due_date
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due_date) || Number.isNaN(new Date(`${due_date}T00:00:00`).getTime())) {
      return { data: null, error: 'Pick the date payment is due.' }
    }
    const next: Invoice = normalizeInvoice({
      ...current,
      ...patch,
      client_id,
      basis,
      project_name,
      amount: Math.round(amount * 100) / 100,
      due_date,
      stage: normalizeInvoiceStage(patch.stage !== undefined ? patch.stage : current.stage),
      notes: patch.notes !== undefined ? patch.notes?.trim() || null : current.notes,
      id: current.id,
      created_at: current.created_at,
      updated_at: new Date().toISOString(),
    })
    c.data.invoices[idx] = next
    save(c.data)
    return { data: next, error: null }
  },

  async deleteInvoice(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'invoices.view')) return denied('use the invoicing board')
    c.data.invoices = c.data.invoices.filter((i) => i.id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  // ---- Tasks (kanban board) ----------------------------------------------
  // A worker only ever sees and touches their own tasks; the admin sees and
  // manages every worker's. Both roles can add tasks — a worker's new task is
  // always assigned to themselves, whatever the caller passes.

  async listTasks() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const rows = !can(c, 'tasks.view_all')
      ? c.data.tasks.filter((t) => t.worker_id === c.user.workerId)
      : c.data.tasks
    return { data: sortTasks(rows), error: null }
  },

  async createTask(input: CreateTaskInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const title = input.title.trim()
    if (!title) return { data: null, error: 'Give the task a title.' }
    // Every NEW work task needs a due date (§4). Legacy rows predating the
    // rule are read-only on this rule — they simply never go through here.
    if (!input.due_date) return { data: null, error: 'Every new task needs a due date.' }
    // Workers can only ever create tasks for themselves.
    // Only a task manager may put a card on someone else's board. A manager
    // who doesn't pass a worker_id is treated as creating a task for
    // themselves — same end result as a regular worker, just without the
    // assignment UI step.
    const workerId = can(c, 'tasks.manage_all')
      ? (input.worker_id || c.user.workerId || '')
      : c.user.workerId
    if (!workerId) return { data: null, error: 'Choose who the task is for.' }
    if (!c.data.workers.some((w) => w.id === workerId)) return { data: null, error: 'Worker not found.' }
    const status = normalizeTaskStatus(input.status)
    const now = new Date().toISOString()
    const actor = stageActorName(c.user.role, c.data.workers.find((w) => w.id === c.user.workerId), c.user.email)
    const task: Task = {
      id: uid(),
      worker_id: workerId,
      client_id: resolveClientId(c.data, input.client_id),
      title,
      description: input.description?.trim() || null,
      status,
      priority: normalizeTaskPriority(input.priority),
      due_date: input.due_date || null,
      // Stage timestamps + history for the brand-new card (§3).
      ...initialStageFields(status, now, actor),
      estimated_hours: normalizeEstimatedHours(input.estimated_hours),
      // New tasks land at the very top of their column.
      position: 0,
      created_by_role: c.user.role,
      completed_at: status === 'completed' ? now : null,
      archived_at: null,
      created_at: now,
      updated_at: now,
    }
    c.data.tasks.push(task)
    // Renumber the column so the new card sits on top and the rest keep
    // their relative order one slot lower.
    reindexTaskColumn(c.data.tasks, workerId, status, task.id, 0)
    // Tell the worker when the admin assigns them something.
    if (c.user.role === 'admin') {
      const recipient = workerUserId(workerId)
      if (recipient) {
        pushNotification(c.data, recipient, { entry_id: null, type: 'note', message: `New task assigned: "${title}"` })
      }
    }
    save(c.data)
    return { data: task, error: null }
  },

  async updateTask(id, patch) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const idx = c.data.tasks.findIndex((t) => t.id === id)
    if (idx === -1) return { data: null, error: 'Task not found.' }
    const current = c.data.tasks[idx]
    if (!can(c, 'tasks.manage_all') && current.worker_id !== c.user.workerId) {
      return { data: null, error: 'You can only change your own tasks.' }
    }
    // QA/rework decisions belong to the Owner and the Project Manager (§10).
    if (patchTouchesQa(patch) && !can(c, 'team_kpi.view')) {
      return { data: null, error: 'Only the Owner or Project Manager can score QA.' }
    }
    // Only a task manager may hand a task to a different worker.
    const workerId = can(c, 'tasks.manage_all') && patch.worker_id ? patch.worker_id : current.worker_id
    const now = new Date().toISOString()
    const actor = stageActorName(c.user.role, c.data.workers.find((w) => w.id === c.user.workerId), c.user.email)

    // Due date: preserve the original deadline when one was already missed.
    const due =
      patch.due_date !== undefined
        ? applyDueDateChange(current, patch.due_date || null)
        : { due_date: current.due_date, original_due_date: current.original_due_date, changed: false, missedDeadline: false }

    const status = patch.status ? normalizeTaskStatus(patch.status) : normalizeTaskStatus(current.status)
    const stageFields =
      patch.status && status !== normalizeTaskStatus(current.status)
        ? applyStageTransition(current, status, now, actor)
        : { status, completed_at: status === 'completed' ? (current.completed_at ?? now) : null, stage_history: current.stage_history ?? [] }

    const qaTouched = patchTouchesQa(patch)
    const next: Task = normalizeTask({
      ...current,
      ...patch,
      worker_id: workerId,
      client_id: patch.client_id !== undefined ? resolveClientId(c.data, patch.client_id) : current.client_id,
      title: patch.title !== undefined ? String(patch.title).trim() || current.title : current.title,
      due_date: due.due_date,
      original_due_date: due.original_due_date,
      estimated_hours: patch.estimated_hours !== undefined ? normalizeEstimatedHours(patch.estimated_hours) : current.estimated_hours,
      waiting_reason: patch.waiting_reason !== undefined ? normalizeWaitingReason(patch.waiting_reason) : current.waiting_reason,
      qa_score: patch.qa_score !== undefined ? normalizeQaScore(patch.qa_score) : current.qa_score,
      rework_type: patch.rework_type !== undefined ? normalizeReworkType(patch.rework_type) : current.rework_type,
      // Stage machinery wins over any stray patch fields for timestamps.
      ...stageFields,
      completed_at: stageFields.completed_at ?? null,
      qa_reviewed_at: qaTouched && patch.qa_score !== undefined && patch.qa_score !== null
        ? (patch.qa_reviewed_at ?? now)
        : patch.qa_reviewed_at !== undefined ? (patch.qa_reviewed_at ?? null) : current.qa_reviewed_at ?? null,
      qa_reviewed_by: qaTouched && patch.qa_score !== undefined
        ? (patch.qa_reviewed_by ?? actor)
        : patch.qa_reviewed_by !== undefined ? (patch.qa_reviewed_by ?? null) : current.qa_reviewed_by ?? null,
      archived_at: status === 'completed' ? (patch.archived_at !== undefined ? patch.archived_at : (current.archived_at ?? null)) : null,
      id: current.id,
      created_at: current.created_at,
      updated_at: now,
    })
    c.data.tasks[idx] = next

    // ---- audit trail (KPI history must be traceable, §15) ----
    const audit = (action: string, detail: string) =>
      pushKpiAudit(c.data, {
        entity_type: 'task',
        entity_id: current.id,
        worker_id: current.worker_id,
        action,
        detail,
        actor,
      })
    if (due.changed && due.missedDeadline) {
      audit('due_date_changed', `Due date on “${current.title}” pushed from ${current.due_date ?? 'none'} to ${due.due_date ?? 'none'} after the deadline was missed — the original ${due.original_due_date} is kept for on-time KPI.`)
    } else if (due.changed) {
      audit('due_date_changed', `Due date on “${current.title}” changed from ${current.due_date ?? 'none (legacy)'} to ${due.due_date ?? 'none'}.`)
    }
    if (status === 'completed' && normalizeTaskStatus(current.status) !== 'completed') {
      audit('completed', `“${current.title}” completed by ${actor}.`)
    }
    if (qaTouched) {
      const scored = patch.qa_score !== undefined ? normalizeQaScore(patch.qa_score) : current.qa_score
      if (scored !== current.qa_score) {
        audit('qa_scored', `QA on “${current.title}” set to ${scored ?? '—'}/5.`)
      }
      const reworkType = patch.rework_type !== undefined ? normalizeReworkType(patch.rework_type) : current.rework_type
      const reworkReq = patch.rework_required !== undefined ? patch.rework_required : current.rework_required
      if (reworkType !== current.rework_type || reworkReq !== current.rework_required) {
        audit('rework_classified', `Rework on “${current.title}”: ${reworkReq ? `required (${reworkType ?? 'unclassified'})` : 'not required'}.`)
      }
    }

    // Moving column (or worker), or restoring from archive, puts it at the top of the column.
    if (status !== normalizeTaskStatus(current.status) || workerId !== current.worker_id || (current.archived_at && !next.archived_at)) {
      reindexTaskColumn(c.data.tasks, workerId, status, id, 0)
    }
    save(c.data)
    return { data: next, error: null }
  },

  async moveTask(id, status, position) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const task = c.data.tasks.find((t) => t.id === id)
    if (!task) return { data: null, error: 'Task not found.' }
    if (!can(c, 'tasks.manage_all') && task.worker_id !== c.user.workerId) {
      return { data: null, error: 'You can only move your own tasks.' }
    }
    const target = normalizeTaskStatus(status)
    const now = new Date().toISOString()
    const actor = stageActorName(c.user.role, c.data.workers.find((w) => w.id === c.user.workerId), c.user.email)
    // Stage hop: stamps Waiting Since / Submitted for Review / Completed At
    // and appends to the stage history (§3).
    Object.assign(task, applyStageTransition(task, target, now, actor))
    if (target !== 'completed') {
      task.archived_at = null
    }
    task.updated_at = now
    reindexTaskColumn(c.data.tasks, task.worker_id, target, id, position)
    save(c.data)
    return { data: task, error: null }
  },

  async deleteTask(id) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const task = c.data.tasks.find((t) => t.id === id)
    if (!task) return { data: null, error: null }
    if (!can(c, 'tasks.manage_all') && task.worker_id !== c.user.workerId) {
      return { data: null, error: 'You can only delete your own tasks.' }
    }
    c.data.tasks = c.data.tasks.filter((t) => t.id !== id)
    save(c.data)
    return { data: null, error: null }
  },

  // ---- Team KPI: monthly goals, bonus decisions, audit trail ---------------

  async listMonthlyGoals() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    // Management data: the Owner and anyone the Owner granted Team KPI.
    if (!can(c, 'team_kpi.view')) return { data: [], error: null }
    return { data: [...(c.data.monthlyGoals ?? [])].sort((a, b) => b.month.localeCompare(a.month)), error: null }
  },

  async saveMonthlyGoal(input: CreateMonthlyGoalInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'team_kpi.view')) return { data: null, error: 'Only the Owner or Project Manager can set monthly targets.' }
    if (!input.worker_id || !input.month) return { data: null, error: 'A worker and a month are required.' }
    if (!c.data.workers.some((w) => w.id === input.worker_id)) return { data: null, error: 'Worker not found.' }
    const now = new Date().toISOString()
    const clean = (n: unknown): number | null => {
      const v = Number(n)
      return Number.isFinite(v) && v >= 0 ? v : null
    }
    const existing = (c.data.monthlyGoals ?? []).find((g) => g.worker_id === input.worker_id && g.month === input.month)
    const next: MonthlyGoal = {
      id: existing?.id ?? uid(),
      worker_id: input.worker_id,
      month: input.month,
      target: input.target !== undefined ? clean(input.target) : (existing?.target ?? null),
      on_time_target: input.on_time_target !== undefined ? clean(input.on_time_target) : (existing?.on_time_target ?? null),
      qa_target: input.qa_target !== undefined ? clean(input.qa_target) : (existing?.qa_target ?? null),
      note: input.note !== undefined ? (input.note?.trim() || null) : (existing?.note ?? null),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    }
    if (existing) {
      c.data.monthlyGoals = (c.data.monthlyGoals ?? []).map((g) => (g.id === existing.id ? next : g))
    } else {
      c.data.monthlyGoals = [next, ...(c.data.monthlyGoals ?? [])]
    }
    pushKpiAudit(c.data, {
      entity_type: 'goal',
      entity_id: next.id,
      worker_id: next.worker_id,
      action: 'goal_saved',
      detail: `Monthly targets for ${next.month} updated (target ${next.target ?? '—'}, on-time ${next.on_time_target ?? '90'}%).`,
      actor: actorLabel(c),
    })
    save(c.data)
    return { data: next, error: null }
  },

  async listBonusDecisions() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'team_kpi.view')) return { data: [], error: null }
    return { data: [...(c.data.bonusDecisions ?? [])].sort((a, b) => b.month.localeCompare(a.month)), error: null }
  },

  async saveBonusDecision(input: SaveBonusDecisionInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    // Bonus decisions are Owner-only — a Project Manager may read, never edit.
    if (c.user.role !== 'admin') return { data: null, error: 'Only the Owner can change bonus decisions.' }
    if (!input.worker_id || !input.month) return { data: null, error: 'A worker and a month are required.' }
    const now = new Date().toISOString()
    const existing = (c.data.bonusDecisions ?? []).find((b) => b.worker_id === input.worker_id && b.month === input.month)
    const eligible = input.eligible === 'yes' || input.eligible === 'no' || input.eligible === 'pending'
      ? input.eligible
      : (existing?.eligible ?? 'pending')
    const next: BonusDecision = {
      id: existing?.id ?? uid(),
      worker_id: input.worker_id,
      month: input.month,
      eligible,
      approved_amount:
        input.approved_amount !== undefined
          ? input.approved_amount !== null && Number.isFinite(Number(input.approved_amount))
            ? Math.max(0, Number(input.approved_amount))
            : null
          : (existing?.approved_amount ?? null),
      approved_by: input.eligible !== undefined ? actorLabel(c) : (existing?.approved_by ?? null),
      note: input.note !== undefined ? (input.note?.trim() || null) : (existing?.note ?? null),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    }
    if (eligible !== 'yes') next.approved_amount = eligible === 'pending' ? next.approved_amount : null
    if (existing) {
      c.data.bonusDecisions = (c.data.bonusDecisions ?? []).map((b) => (b.id === existing.id ? next : b))
    } else {
      c.data.bonusDecisions = [next, ...(c.data.bonusDecisions ?? [])]
    }
    pushKpiAudit(c.data, {
      entity_type: 'bonus',
      entity_id: next.id,
      worker_id: next.worker_id,
      action: 'bonus_decided',
      detail: `Bonus for ${next.month}: ${next.eligible}${next.approved_amount != null ? ` (approved ${next.approved_amount})` : ''}.`,
      actor: actorLabel(c),
    })
    save(c.data)
    return { data: next, error: null }
  },

  async listKpiAudit(limit = 200) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!can(c, 'team_kpi.view')) return { data: [], error: null }
    return { data: (c.data.kpiAudit ?? []).slice(0, Math.max(1, limit)), error: null }
  },

  async resetAll() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can delete data.' }
    save(emptyData())
    // Slack settings survive main blob deletion by design, so clear it explicitly on full reset.
    storage.removeItem(slackKey(c.admin.id))
    // Personal finance data is per-auth-user and strictly private — do NOT delete it on workspace reset.
    // Worker login accounts are gone along with their worker rows — drop them
    // so reset workers cannot sign in again. The admin account is kept.
    writeUsers(readUsers().filter((u) => u.role !== 'worker'))
    return { data: null, error: null }
  },

  // ---- IT Support tickets -------------------------------------------------

  async listTickets() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    // The queue is for IT Support. Everyone else gets their own submissions
    // only — which is how a requester's ticket is found from a notification —
    // and the admin is *not* IT Support (the grant is worker-only).
    const support = isItSupportGrant(c.user.role, c.user.permissions)
    const rows = support ? c.data.tickets : c.data.tickets.filter((t) => t.requester_user_id === c.user.id)
    // Attachments are the heavy column: the list read leaves them out and
    // `getTicket` brings them for the one ticket being opened.
    return { data: sortTickets(rows).map((t) => ({ ...t, attachments: [] as string[] })), error: null }
  },

  async getTicket(ticketId: string) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const ticket = c.data.tickets.find((t) => t.id === ticketId)
    if (!ticket) return { data: null, error: 'That ticket no longer exists.' }
    // Readable by IT Support, and by the person who submitted it.
    if (!isItSupportGrant(c.user.role, c.user.permissions) && ticket.requester_user_id !== c.user.id) {
      return denied('read that ticket')
    }
    const replies = c.data.ticketReplies
      .filter((r) => r.ticket_id === ticket.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
    return { data: { ticket, replies }, error: null }
  },

  async createTicket(input: CreateTicketInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const subject = input.subject?.trim()
    if (!subject) return { data: null, error: 'Give the ticket a subject.' }
    const description = input.description?.trim()
    if (!description) return { data: null, error: 'Describe what is going wrong.' }
    const now = new Date().toISOString()
    const ticket: Ticket = {
      id: uid(),
      number: c.data.tickets.reduce((max, t) => Math.max(max, t.number), 0) + 1,
      subject,
      description,
      category: normalizeTicketCategory(input.category),
      priority: normalizeTicketPriority(input.priority),
      status: 'open',
      requester_user_id: c.user.id,
      requester_name: actorName(c),
      assignee_user_id: null,
      assignee_name: null,
      attachments: (input.attachments ?? []).slice(0, MAX_TICKET_ATTACHMENTS),
      reply_count: 0,
      created_at: now,
      updated_at: now,
      resolved_at: null,
    }
    c.data.tickets.push(ticket)
    // Alert the desk. Anyone can submit (including the admin), but the alert
    // only ever goes to the accounts holding the IT Support grant.
    for (const userId of itSupportUserIds(c.data)) {
      if (userId === c.user.id) continue
      pushNotification(c.data, userId, {
        entry_id: null,
        ticket_id: ticket.id,
        type: 'ticket',
        message: `${ticket.requester_name} submitted ticket ${ticketRef(ticket)} — ${ticket.subject}`,
      })
    }
    save(c.data)
    return { data: ticket, error: null }
  },

  async updateTicket(ticketId: string, patch: UpdateTicketInput) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!isItSupportGrant(c.user.role, c.user.permissions)) return denied('change a ticket')
    const ticket = c.data.tickets.find((t) => t.id === ticketId)
    if (!ticket) return { data: null, error: 'That ticket no longer exists.' }
    const now = new Date().toISOString()

    if (patch.status !== undefined) {
      const status = normalizeTicketStatus(patch.status)
      if (status !== ticket.status) {
        ticket.status = status
        ticket.resolved_at = status === 'resolved' ? now : null
        // Tell the requester their ticket moved — this is the loop closing for
        // whoever reported the problem.
        if (ticket.requester_user_id !== c.user.id) {
          pushNotification(c.data, ticket.requester_user_id, {
            entry_id: null,
            ticket_id: ticket.id,
            type: 'ticket',
            message: `${ticketRef(ticket)} is now ${ticketStatusLabel(status)} — ${ticket.subject}`,
          })
        }
      }
    }

    if (patch.assignee_user_id !== undefined) {
      if (patch.assignee_user_id && !itSupportUserIds(c.data).includes(patch.assignee_user_id)) {
        return { data: null, error: 'Tickets can only be assigned to someone with IT Support access.' }
      }
      ticket.assignee_user_id = patch.assignee_user_id
      ticket.assignee_name = patch.assignee_user_id ? patch.assignee_name?.trim() || 'IT Support' : null
    }

    ticket.updated_at = now
    save(c.data)
    return { data: ticket, error: null }
  },

  async addTicketReply(ticketId: string, body: string) {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    const text = body?.trim()
    if (!text) return { data: null, error: 'Write a message first.' }
    const ticket = c.data.tickets.find((t) => t.id === ticketId)
    if (!ticket) return { data: null, error: 'That ticket no longer exists.' }
    const support = isItSupportGrant(c.user.role, c.user.permissions)
    if (!support && ticket.requester_user_id !== c.user.id) return denied('reply on that ticket')

    const now = new Date().toISOString()
    const reply: TicketReply = {
      id: uid(),
      ticket_id: ticket.id,
      author_user_id: c.user.id,
      author_name: actorName(c),
      from_support: support,
      body: text,
      created_at: now,
    }
    c.data.ticketReplies.push(reply)
    ticket.reply_count += 1
    ticket.updated_at = now

    // The reply goes to the other side: the requester hears from the desk, and
    // the desk hears from the requester (the assignee when there is one, all of
    // IT Support while the ticket is still unclaimed).
    const recipients = support ? [ticket.requester_user_id] : ticketAudience(c.data, ticket)
    for (const userId of recipients) {
      if (userId === c.user.id) continue
      pushNotification(c.data, userId, {
        entry_id: null,
        ticket_id: ticket.id,
        type: 'ticket',
        message: support
          ? `IT Support replied on ${ticketRef(ticket)} — ${ticket.subject}`
          : `${reply.author_name} replied on ${ticketRef(ticket)} — ${ticket.subject}`,
      })
    }

    save(c.data)
    return { data: reply, error: null }
  },

  async listItSupportAssignees() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (!isItSupportGrant(c.user.role, c.user.permissions)) return denied('see the IT Support team')
    const rows: TicketAssignee[] = c.data.workers
      .filter((w) => (w.permissions ?? []).includes(IT_SUPPORT_PERMISSION))
      .map((w) => {
        const userId = workerUserId(w.id)
        return userId ? { user_id: userId, name: w.name } : null
      })
      .filter((r): r is TicketAssignee => r !== null)
    return { data: rows, error: null }
  },

  async seedDemo() {
    const c = ctx()
    if (!c) return { data: null, error: 'Not signed in.' }
    if (c.user.role !== 'admin') return { data: null, error: 'Only the admin can load sample data.' }
    const seed = buildDemoSeed()
    const seededWorkers: Worker[] = seed.workers.map((w) => ({ ...w, id: uid() }))
    const idMap = new Map(seed.workers.map((w, i) => [w.id, seededWorkers[i].id]))
    const seedClients: Client[] = seed.clients.map((cl) => ({ ...cl, id: uid() }))
    const seedClientMap = new Map(seed.clients.map((cl, i) => [cl.id, seedClients[i].id]))
    const users = readUsers()
    for (const w of seededWorkers) {
      if (w.email && !users.some((u) => u.email === w.email)) {
        users.push({ id: uid(), email: w.email, password: 'worker123', role: 'worker', workerId: w.id })
      }
    }
    writeUsers(users)
    const next: UserData = {
      workers: seededWorkers,
      entries: seed.entries.map((e) => ({
        ...e,
        worker_id: idMap.get(e.worker_id) || e.worker_id,
        client_id: e.client_id ? seedClientMap.get(e.client_id) ?? null : null,
        id: uid(),
      })),
      activeTimers: [],
      settings: seed.settings,
      comments: [],
      notifications: [],
      payments: [],
      tasks: seed.tasks.map((t) => ({
        ...t,
        worker_id: idMap.get(t.worker_id) || t.worker_id,
        client_id: t.client_id ? seedClientMap.get(t.client_id) ?? null : null,
        id: uid(),
      })),
      clients: seedClients,
      clientPriorities: (seed.clientPriorities ?? []).map((p) => ({
        ...p,
        client_id: seedClientMap.get(p.client_id) ?? p.client_id,
        id: uid(),
      })),
      meetings: (seed.meetings ?? []).map((m) => ({ ...m, id: uid() })),
      notes: [],
      invoices: (seed.invoices ?? []).map((i) => ({
        ...i,
        client_id: i.client_id ? seedClientMap.get(i.client_id) ?? i.client_id : null,
        id: uid(),
      })),
      financeItems: seed.financeItems.map((f) => ({
        ...f,
        worker_id: f.worker_id ? idMap.get(f.worker_id) ?? null : null,
        id: uid(),
      })),
      monthlyGoals: (seed.monthlyGoals ?? []).map((g) => ({ ...g, worker_id: idMap.get(g.worker_id) || g.worker_id, id: uid() })),
      bonusDecisions: (seed.bonusDecisions ?? []).map((b) => ({ ...b, worker_id: idMap.get(b.worker_id) || b.worker_id, id: uid() })),
      kpiAudit: [],
      // Sample data deliberately ships no tickets: a fresh desk is the honest
      // starting state, and the first ticket anyone submits is what proves the
      // whole path (submit → notify the grant holder) end to end.
      tickets: [],
      ticketReplies: [],
    }
    save(next)
    return { data: null, error: null }
  },
}
