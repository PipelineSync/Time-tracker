import { useMemo, useRef, useState } from 'react'
import {
  Briefcase,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Folder,
  GripVertical,
  Pencil,
  Plus,
  ReceiptText,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '@/lib/store'
import type { Invoice, InvoiceBasis, InvoiceStage, InvoiceStatus } from '@/lib/types'
import {
  INVOICE_BASES,
  INVOICE_STAGES,
  INVOICE_STATUSES,
  InvoiceStageNames,
  InvoiceStatusNames,
  InvoiceStatusStyles,
} from '@/lib/types'
import { invoiceStatus } from '@/lib/invoiceCycles'
import { monthLabel, monthShortLabel, todayISO } from '@/lib/finance'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { StatCard } from '@/components/StatCard'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { InvoiceFormDialog } from '@/components/InvoiceFormDialog'
import { ClientBadge } from '@/components/ClientBadge'
import { MonthPicker } from '@/components/MonthPicker'
import {
  InvoiceBasisLabels,
  countInvoicesByBasis,
  filterInvoicesByBasis,
  groupInvoicesByStatus,
  invoiceMonthKey,
  invoiceMonthOptions,
  invoicesOnMonthBoard,
  monthlyInvoiceTotals,
  readInvoiceBasis,
  regularChain,
  writeInvoiceBasis,
} from '@/lib/invoices'
import { cn, formatDate, money } from '@/lib/utils'

const BASIS_ICONS: Record<InvoiceBasis, typeof Building2> = {
  client: Building2,
  project: Folder,
  upwork: Briefcase,
}

/** What each lane says when it is empty. */
const LANE_EMPTY: Record<InvoiceStatus, string> = {
  pending: 'Nothing waiting to be billed',
  awaiting: 'Nothing out for payment',
  overdue: 'Nothing overdue. Invoices land here by themselves once a due date passes unpaid.',
  paid: 'No payments confirmed yet',
}

/** A date for the card and the totals, in the words the board uses. */
const shortDate = (iso: string) => formatDate(`${iso}T00:00:00`)

/**
 * The client invoicing board. Every invoice sits in one of four lanes, worked
 * out from its column and its due date: Pending, Awaiting, Overdue and Paid.
 * Overdue is automatic — an unpaid invoice lands there once its due date has
 * passed — so it is the one lane you cannot drop into. Paid is a deliberate
 * confirmation. Dragging moves an invoice between the other lanes (forwards to
 * progress it, backwards to undo); each drop saves through the store.
 *
 * Three kinds of invoice share the board, switched above it:
 *  - regular clients: recurring. Each client's card shows when it was last
 *    billed, when auto-bill next raises a cycle, and the auto-bill switch;
 *  - project-based: one-off and milestone invoices, raised by hand;
 *  - Upwork clients: raised by hand.
 * The switch narrows the lanes to one kind; the monthly totals above always
 * cover all three. The choice is remembered per device (`src/lib/invoices`).
 *
 * Access mirrors the priority board: admin-only until the admin grants
 * `invoices.view` — a granted worker sees and runs the very same board.
 */
export function ClientInvoicingPage() {
  const { invoices, clients, settings, dataLoading, updateInvoice, deleteInvoice } = useStore()
  const currency = settings?.currency || 'USD'
  const today = todayISO()
  const currentMonth = today.slice(0, 7)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Invoice | null>(null)
  const [defaultStage, setDefaultStage] = useState<InvoiceStage>('pending')
  const [deleting, setDeleting] = useState<Invoice | null>(null)

  // Which kind of invoice the lanes show. Read once from storage, then written
  // back on every change so the next visit opens on the same view.
  const [basis, setBasisState] = useState<InvoiceBasis>(readInvoiceBasis)
  function setBasis(next: InvoiceBasis) {
    writeInvoiceBasis(next)
    setBasisState(next)
  }

  /**
   * The month the board shows: 'current' (this month, moving on by itself when
   * a new month starts) or one 'YYYY-MM' picked from the month chooser.
   */
  const [month, setMonth] = useState<string>('current')
  const boardMonth = month === 'current' ? currentMonth : month

  /** The rows behind the lanes: one kind of invoice, for the month shown. */
  const visibleInvoices = useMemo(() => filterInvoicesByBasis(invoices, basis), [invoices, basis])
  const monthInvoices = useMemo(() => invoicesOnMonthBoard(visibleInvoices, boardMonth), [visibleInvoices, boardMonth])
  const lanes = useMemo(() => groupInvoicesByStatus(monthInvoices, today), [monthInvoices, today])
  const totals = useMemo(() => monthlyInvoiceTotals(invoices, boardMonth, today), [invoices, boardMonth, today])
  const monthChoices = useMemo(() => invoiceMonthOptions(invoices, today), [invoices, today])

  // Drag state — the same pattern as the priority board: `dragging` is the card
  // under the pointer, `dropTarget` the lane it would land in. The ref mirrors
  // `dragging` synchronously because dragover fires before React has
  // re-rendered, and a background poll landing mid-drag must not make the
  // handlers think nothing is being dragged.
  const draggingRef = useRef<Invoice | null>(null)
  const [dragging, setDragging] = useState<Invoice | null>(null)
  const [dropTarget, setDropTarget] = useState<InvoiceStatus | null>(null)

  function startDrag(invoice: Invoice) {
    draggingRef.current = invoice
    setDragging(invoice)
  }

  function endDrag() {
    draggingRef.current = null
    setDragging(null)
    setDropTarget(null)
  }

  // The lane row scrolls sideways when the lanes do not all fit; dragging a
  // card to either edge nudges it along so cross-board drops stay possible.
  const rowRef = useRef<HTMLDivElement | null>(null)
  function edgeScroll(e: React.DragEvent<HTMLDivElement>) {
    const row = rowRef.current
    if (!row || !draggingRef.current) return
    const box = row.getBoundingClientRect()
    const edge = 72
    if (e.clientX < box.left + edge) row.scrollLeft -= 18
    else if (e.clientX > box.right - edge) row.scrollLeft += 18
  }

  // A project-based invoice may have no client; a regular or Upwork one always does.
  const clientOf = (clientId: string | null) => (clientId ? clients.find((c) => c.id === clientId) ?? null : null)

  /** What the invoice is billed to, in words — the client, or the project. */
  const billedTo = (invoice: Invoice) =>
    invoice.basis === 'project' ? invoice.project_name || 'project' : clientOf(invoice.client_id)?.name ?? 'client'

  /**
   * Move an invoice to a column (a no-op when it is already there). If it is
   * still past its due date after the move, say so: moving it to Awaiting does
   * not make it on time, and the card stays in Overdue until it is paid.
   */
  function moveTo(invoice: Invoice, stage: InvoiceStage) {
    if (invoice.stage === stage) return
    void updateInvoice(invoice.id, { stage }).then((saved) => {
      if (saved && stage !== 'paid' && invoiceStatus(stage, invoice.due_date, today) === 'overdue') {
        toast.info('Still past its due date, so it stays in Overdue until it is paid.')
      }
    })
  }

  /** Commit a drop onto a lane. Overdue is automatic, so a drop there is refused. */
  function commitDrop(lane: InvoiceStatus) {
    const invoice = draggingRef.current
    endDrag()
    if (!invoice) return
    if (lane === 'overdue') {
      if (invoiceStatus(invoice.stage, invoice.due_date, today) !== 'overdue') {
        toast.error('Overdue is automatic. An invoice lands here by itself once its due date passes unpaid.')
      }
      return
    }
    moveTo(invoice, lane)
  }

  /** Keyboard / touch fallback: one column left or right (free movement). */
  function nudge(invoice: Invoice, direction: -1 | 1) {
    const next = INVOICE_STAGES[INVOICE_STAGES.indexOf(invoice.stage) + direction]
    if (next) moveTo(invoice, next)
  }

  /** The auto-bill switch belongs to the client: it covers every regular invoice they have. */
  function setAutoBill(invoice: Invoice, on: boolean) {
    const name = billedTo(invoice)
    void updateInvoice(invoice.id, { auto_bill: on }).then((saved) => {
      if (saved) {
        toast.success(
          on
            ? `Auto-bill is on for ${name}. Each cycle goes out on its bill-on date.`
            : `Auto-bill is off for ${name}. Its invoices are raised by hand from now on.`,
        )
      }
    })
  }

  function openNew(stage: InvoiceStage) {
    setEditing(null)
    setDefaultStage(stage)
    setFormOpen(true)
  }

  function openEdit(invoice: Invoice) {
    setEditing(invoice)
    setFormOpen(true)
  }

  /**
   * A card, rendered as a plain function call rather than a nested component
   * (same reason as the Tasks board: a nested component type would be
   * re-created every render and unmount the very node the browser is
   * dragging, killing the drag on the first attempt).
   */
  function renderCard({ invoice, lane }: { invoice: Invoice; lane: InvoiceStatus }) {
    const style = InvoiceStatusStyles[lane]
    const overdue = lane === 'overdue'
    const stageIndex = INVOICE_STAGES.indexOf(invoice.stage)
    const name = billedTo(invoice)
    const regular = invoice.basis === 'client' && invoice.client_id !== null
    const chain = regular && invoice.client_id ? regularChain(invoices, invoice.client_id) : null
    const nextAutoBill = chain === null ? null : !chain.autoBill ? 'Off' : chain.nextAutoBill ? shortDate(chain.nextAutoBill) : '—'
    // Pending cards say why auto-bill will not send them, if it will not.
    const hint =
      chain === null || lane !== 'pending'
        ? null
        : !chain.autoBill
          ? 'Auto-bill is off, so bill this one by hand.'
          : invoice.auto_billed
            ? 'Auto-bill won’t send this cycle, so bill it by hand.'
            : null
    return (
      <div
        draggable
        onDragStart={(e) => {
          startDrag(invoice)
          e.dataTransfer.effectAllowed = 'move'
          // Firefox refuses to start a drag without data on the transfer.
          e.dataTransfer.setData('text/plain', invoice.id)
        }}
        onDragEnd={endDrag}
        onDragOver={(e) => {
          if (!draggingRef.current) return
          e.preventDefault()
          e.stopPropagation()
          if (lane !== 'overdue') setDropTarget(lane)
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          commitDrop(lane)
        }}
        className={cn(
          'group cursor-grab select-none rounded-lg border border-l-4 bg-card px-2.5 py-2 shadow-sm transition active:cursor-grabbing',
          'hover:shadow-md',
          style.accent,
          dragging?.id === invoice.id && 'opacity-40',
        )}
      >
        <div className="flex items-start gap-2">
          <GripVertical className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden />
          <div className="min-w-0 flex-1">
            {/* The billing target is the card's identity: a regular or Upwork
                invoice bills the client, a project-based one the named project
                — which may also name the client it belongs to. */}
            {invoice.basis === 'project' ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="muted" className="gap-1 text-[11px]">
                  <Folder className="h-3 w-3" />
                  <span className="max-w-[14rem] truncate font-medium">{invoice.project_name || 'Project'}</span>
                </Badge>
                {clientOf(invoice.client_id) && (
                  <ClientBadge client={clientOf(invoice.client_id)} showInactive={false} className="text-[10px]" />
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                <ClientBadge client={clientOf(invoice.client_id)} showInactive={false} />
                {invoice.basis === 'upwork' && (
                  <Badge variant="outline" className="gap-1 text-[10px]">
                    <Briefcase className="h-3 w-3" />
                    Upwork
                  </Badge>
                )}
              </div>
            )}

            <div className="mt-1 flex items-start justify-between gap-2">
              {invoice.amount > 0 ? (
                <p className="text-lg font-bold leading-tight tracking-tight">{money(invoice.amount, currency)}</p>
              ) : (
                // No amount yet — the invoice went on the board before its
                // figure was known.
                <p className="text-sm font-medium italic leading-tight text-muted-foreground">No amount yet</p>
              )}
              {chain !== null && (
                <Badge variant={overdue ? 'destructive' : lane === 'paid' ? 'success' : 'muted'} className="shrink-0 text-[10px]">
                  {InvoiceStatusNames[lane]}
                </Badge>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <Badge variant={overdue ? 'destructive' : 'muted'} className="gap-1 text-[10px]">
                <CalendarDays className="h-3 w-3" />
                {overdue
                  ? `Overdue · ${shortDate(invoice.due_date)}`
                  : invoice.due_date === today
                    ? 'Due today'
                    : `Due ${shortDate(invoice.due_date)}`}
              </Badge>
              {/* Still owed from an earlier month: it is carried onto this board. */}
              {lane !== 'paid' && invoiceMonthKey(invoice) < boardMonth && (
                <Badge variant="outline" className="text-[10px]">
                  From {monthShortLabel(invoiceMonthKey(invoice))}
                </Badge>
              )}
            </div>

            {/* A regular client's recurring billing, the same on every card of
                that client: when it was last billed, when the next cycle goes
                out, and the switch that runs it. */}
            {chain !== null && (
              <div className="mt-2 grid gap-1 rounded-md border bg-muted/40 px-2 py-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Last billed</span>
                  <span className="font-medium">{chain.lastBilled ? shortDate(chain.lastBilled) : 'Not yet'}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Next auto-bill</span>
                  <span className="font-medium">{nextAutoBill}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`auto-bill-${invoice.id}`} className="text-[11px] font-normal text-muted-foreground">
                    Auto-bill
                  </Label>
                  <Switch
                    id={`auto-bill-${invoice.id}`}
                    checked={chain.autoBill}
                    onCheckedChange={(on) => setAutoBill(invoice, on)}
                    aria-label={`Auto-bill for ${name}`}
                    className="scale-75"
                  />
                </div>
              </div>
            )}
            {hint && <p className="mt-1.5 text-[11px] text-muted-foreground">{hint}</p>}

            {invoice.notes && (
              <p className="mt-1.5 line-clamp-2 break-words text-xs text-muted-foreground">{invoice.notes}</p>
            )}
          </div>
        </div>

        {/* Touch-friendly alternatives to dragging — the same pattern as the
            Tasks board: chevrons move a column over, and every card can be
            edited or deleted without a drag. */}
        <div className="mt-1.5 flex items-center justify-between gap-1 border-t pt-1">
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={stageIndex === 0}
              aria-label={`Move the ${name} invoice back to ${stageIndex > 0 ? InvoiceStageNames[INVOICE_STAGES[stageIndex - 1]] : 'the first column'}`}
              onClick={() => nudge(invoice, -1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={stageIndex === INVOICE_STAGES.length - 1}
              aria-label={`Move the ${name} invoice on to ${stageIndex < INVOICE_STAGES.length - 1 ? InvoiceStageNames[INVOICE_STAGES[stageIndex + 1]] : 'the last column'}`}
              onClick={() => nudge(invoice, 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="h-6 w-6" aria-label={`Edit the ${name} invoice`} onClick={() => openEdit(invoice)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-destructive"
              aria-label={`Delete the ${name} invoice`}
              onClick={() => setDeleting(invoice)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    )
  }

  function renderLane(lane: InvoiceStatus) {
    const style = InvoiceStatusStyles[lane]
    const items = lanes[lane]
    const total = items.reduce((sum, inv) => sum + inv.amount, 0)
    const automatic = lane === 'overdue'
    const isTarget = dropTarget === lane && !automatic
    return (
      <div
        key={lane}
        onDragOver={(e) => {
          if (!draggingRef.current) return
          e.preventDefault()
          if (!automatic && dropTarget !== lane) setDropTarget(lane)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDropTarget((prev) => (prev === lane ? null : prev))
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          commitDrop(lane)
        }}
        className={cn(
          // One lane of the row: its own framed card, sharing the board evenly
          // when there is room, scrolling sideways (one snapped lane at a time)
          // when there is not.
          'flex min-h-[14rem] flex-[1_0_15.5rem] snap-start flex-col rounded-xl border bg-background/70 px-2.5 py-2 transition',
          dragging && 'bg-muted/40',
          isTarget && cn('bg-muted ring-2', style.ring),
        )}
      >
        <div className="mb-3 flex items-center gap-2 px-1 pt-1">
          <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', style.dot)} aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{InvoiceStatusNames[lane]}</h2>
          <Badge variant="muted" className="text-[10px]">{items.length}</Badge>
          {!automatic && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={`Add an invoice straight into ${InvoiceStatusNames[lane]}`}
              onClick={() => openNew(lane as InvoiceStage)}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-2">
          {items.map((invoice) => (
            <div key={invoice.id}>{renderCard({ invoice, lane })}</div>
          ))}

          {items.length === 0 && !isTarget && (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">
              {dragging ? (automatic ? 'Overdue fills in by itself' : 'Drop the invoice here') : LANE_EMPTY[lane]}
            </div>
          )}

          {items.length > 0 && (
            <div className="mt-1 flex items-center justify-between border-t px-1 pt-2 text-xs text-muted-foreground">
              <span>{items.length === 1 ? '1 invoice' : `${items.length} invoices`}</span>
              <span className="font-medium text-foreground/80">{money(total, currency)}</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  const showSkeleton = dataLoading && invoices.length === 0
  const monthName = monthLabel(boardMonth)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Client invoicing"
        description="Regular clients bill themselves every month while auto-bill is on. Project-based and Upwork invoices are raised by hand. Overdue fills in by itself once a due date passes unpaid, and Paid is confirmed by you."
      >
        <Button onClick={() => openNew('pending')}>
          <Plus className="mr-2 h-4 w-4" /> New invoice
        </Button>
      </PageHeader>

      {/* Which kind of invoice the lanes show. The counts are of the whole
          board, so the size of the other kinds stays visible while one shows. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="flex w-fit flex-wrap gap-1 rounded-lg border bg-muted/50 p-1"
          role="group"
          aria-label="Show regular clients, project-based clients or Upwork clients"
        >
          {INVOICE_BASES.map((option) => {
            const Icon = BASIS_ICONS[option]
            return (
              <Button
                key={option}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={basis === option}
                onClick={() => setBasis(option)}
                className={cn('gap-1.5 px-3 text-muted-foreground', basis === option && 'bg-background text-foreground shadow-sm')}
              >
                <Icon className="h-3.5 w-3.5" />
                {InvoiceBasisLabels[option]}
                <span className="text-xs text-muted-foreground">{countInvoicesByBasis(invoices, option)}</span>
              </Button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {monthInvoices.length} {InvoiceBasisLabels[basis].toLowerCase()} invoices on {monthName}&rsquo;s board ·{' '}
          {visibleInvoices.length} in all months.
        </p>
      </div>

      {showSkeleton ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-32 rounded-2xl" />
            ))}
          </div>
          <div className="rounded-2xl border bg-muted/30 p-2 sm:p-3">
            <div className="flex gap-2 overflow-hidden">
              {INVOICE_STATUSES.map((lane) => (
                <Skeleton key={lane} className="h-56 flex-[1_0_15.5rem] rounded-xl" />
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          {/* The month's money, across every kind of invoice. Each month starts
              from zero; what is still owed from earlier months is counted as
              carried over. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Totals for {monthName}</p>
            <MonthPicker
              label="Invoice month"
              value={boardMonth}
              current={currentMonth}
              options={monthChoices}
              onChange={(next) => setMonth(next === currentMonth ? 'current' : next)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label={`Billed in ${monthName}`}
              value={money(totals.billed, currency)}
              sub={`${totals.billedCount} ${totals.billedCount === 1 ? 'invoice' : 'invoices'} · Regular ${money(totals.billedBy.client, currency)} · Project-based ${money(totals.billedBy.project, currency)} · Upwork ${money(totals.billedBy.upwork, currency)}`}
              icon={ReceiptText}
              loading={dataLoading && invoices.length === 0}
            />
            <StatCard
              label="Outstanding"
              value={money(totals.outstanding, currency)}
              sub={`${totals.outstandingCount} ${totals.outstandingCount === 1 ? 'invoice' : 'invoices'} awaiting payment · ${totals.overdueCount} overdue · ${totals.carriedCount} carried over`}
              icon={Clock}
              accent={totals.overdueCount > 0}
            />
            <StatCard
              label={`Paid in ${monthName}`}
              value={money(totals.paid, currency)}
              sub={`${totals.paidCount} ${totals.paidCount === 1 ? 'invoice' : 'invoices'} settled · ${totals.dueSettledCount} of ${totals.dueCount} due this month paid`}
              icon={CheckCircle2}
            />
          </div>

          {/* Horizontal board: the four lanes sit side by side inside one
              framed board. When the row is wider than the screen it scrolls
              sideways, one snapped lane at a time. */}
          <div className="rounded-2xl border bg-muted/30 p-2 sm:p-3">
            <div ref={rowRef} onDragOver={edgeScroll} className="flex snap-x snap-mandatory gap-2 overflow-x-auto">
              {INVOICE_STATUSES.map((lane) => renderLane(lane))}
            </div>
          </div>
        </>
      )}

      <InvoiceFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        invoice={editing}
        defaultStage={defaultStage}
        defaultBasis={editing ? undefined : basis}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="Delete this invoice?"
        description={
          deleting
            ? `The ${deleting.amount > 0 ? `${money(deleting.amount, currency)} ` : ''}invoice for ${billedTo(deleting)} comes off the board. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete invoice"
        onConfirm={() => (deleting ? deleteInvoice(deleting.id).then(() => undefined) : Promise.resolve())}
      />
    </div>
  )
}
