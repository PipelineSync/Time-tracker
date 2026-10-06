import { useMemo, useRef, useState } from 'react'
import {
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
import { useStore } from '@/lib/store'
import type { Invoice, InvoiceStage } from '@/lib/types'
import { INVOICE_STAGES, InvoiceStageNames, InvoiceStageStyles } from '@/lib/types'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { StatCard } from '@/components/StatCard'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { InvoiceFormDialog } from '@/components/InvoiceFormDialog'
import { ClientBadge } from '@/components/ClientBadge'
import {
  INVOICE_BASIS_FILTERS,
  InvoiceBasisFilterLabels,
  countInvoicesByBasis,
  filterInvoicesByBasis,
  readInvoiceBasisFilter,
  writeInvoiceBasisFilter,
  type InvoiceBasisFilter,
} from '@/lib/invoices'
import { cn, formatDate, money } from '@/lib/utils'

/** Local 'YYYY-MM-DD' for "today" on the device viewing the board. */
function todayISO(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * The client invoicing board: every invoice sits in one of three fixed
 * columns — Pending, Awaiting, Paid. Dragging a card into a column is the
 * whole workflow and it is free movement: forwards to progress an invoice,
 * backwards to undo a mistake. Each drop patches the invoice's stage through
 * the store — the board "saves automatically" because there is nothing to
 * save: the rows ARE the board. There is no ranking inside a column; cards
 * sort by due date, so the invoice that needs attention first is on top.
 *
 * Access mirrors the priority board: admin-only until the admin grants
 * `invoices.view` — a granted worker sees and runs the very same board.
 *
 * The **basis switch** above the board narrows it to one billing target —
 * everything, client based or project based. It is a view of the same rows,
 * not a second board: the columns and totals all follow the choice, and it is
 * remembered per device (`src/lib/invoices`). Raising an invoice while the
 * board is narrowed starts it on that basis.
 */
export function ClientInvoicingPage() {
  const { invoices, clients, settings, dataLoading, updateInvoice, deleteInvoice } = useStore()
  const currency = settings?.currency || 'USD'
  const today = todayISO()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Invoice | null>(null)
  const [defaultStage, setDefaultStage] = useState<InvoiceStage>('pending')
  const [deleting, setDeleting] = useState<Invoice | null>(null)

  // Which billing target the board shows. Read once from storage, then
  // written back on every change so the next visit opens on the same board.
  const [basisFilter, setBasisFilterState] = useState<InvoiceBasisFilter>(readInvoiceBasisFilter)
  function setBasisFilter(next: InvoiceBasisFilter) {
    writeInvoiceBasisFilter(next)
    setBasisFilterState(next)
  }
  /** The rows behind the board: everything, or just one billing target. */
  const visibleInvoices = useMemo(() => filterInvoicesByBasis(invoices, basisFilter), [invoices, basisFilter])

  // Drag state — identical to the priority board: `dragging` is the card
  // under the pointer, `dropTarget` the column it would land in. The ref
  // mirrors `dragging` synchronously because dragover fires before React has
  // re-rendered, and a background poll landing mid-drag must not make the
  // handlers think nothing is being dragged.
  const draggingRef = useRef<Invoice | null>(null)
  const [dragging, setDragging] = useState<Invoice | null>(null)
  const [dropTarget, setDropTarget] = useState<InvoiceStage | null>(null)

  function startDrag(invoice: Invoice) {
    draggingRef.current = invoice
    setDragging(invoice)
  }

  function endDrag() {
    draggingRef.current = null
    setDragging(null)
    setDropTarget(null)
  }

  // The lane row scrolls sideways when the columns do not all fit; dragging a
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

  /** What the board shows: the filtered invoices by column, due soonest on top. */
  const lanes = useMemo(() => {
    const result = Object.fromEntries(INVOICE_STAGES.map((s) => [s, [] as Invoice[]])) as Record<InvoiceStage, Invoice[]>
    for (const inv of visibleInvoices) {
      if (result[inv.stage]) result[inv.stage].push(inv)
    }
    for (const stage of INVOICE_STAGES) {
      result[stage].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.created_at.localeCompare(b.created_at))
    }
    return result
  }, [visibleInvoices])

  /** Commit a drop: the invoice moves to `stage` (a no-op if it is already there). */
  function commitDrop(stage: InvoiceStage) {
    const invoice = draggingRef.current
    endDrag()
    if (!invoice || invoice.stage === stage) return
    void updateInvoice(invoice.id, { stage })
  }

  /** Keyboard / touch fallback: one column left or right (free movement). */
  function nudge(invoice: Invoice, direction: -1 | 1) {
    const i = INVOICE_STAGES.indexOf(invoice.stage)
    const next = INVOICE_STAGES[i + direction]
    if (!next) return
    void updateInvoice(invoice.id, { stage: next })
  }

  // A project-based invoice has no client — only client-based ones look one up.
  const clientOf = (clientId: string | null) => (clientId ? clients.find((c) => c.id === clientId) ?? null : null)

  /** Is payment overdue? Unpaid stages only, compared as plain dates. */
  const isOverdue = (invoice: Invoice) => invoice.stage !== 'paid' && invoice.due_date < today

  /** What the invoice is billed to, in words — the client, or the project. */
  const billedTo = (invoice: Invoice) =>
    invoice.basis === 'project'
      ? invoice.project_name || 'project'
      : clientOf(invoice.client_id)?.name ?? 'client'

  function openNew(stage: InvoiceStage) {
    setEditing(null)
    setDefaultStage(stage)
    setFormOpen(true)
  }
  /** The basis a new invoice starts on: the one the board is narrowed to. */
  const newInvoiceBasis = basisFilter === 'all' ? 'client' : basisFilter

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
  function renderCard({ invoice, stage }: { invoice: Invoice; stage: InvoiceStage }) {
    const style = InvoiceStageStyles[stage]
    const overdue = isOverdue(invoice)
    const stageIndex = INVOICE_STAGES.indexOf(stage)
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
          setDropTarget(stage)
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          commitDrop(stage)
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
            {/* The billing target is the card's identity: a project-based
                invoice bills the named project, a client-based one the
                client. A project may also name the client it belongs to —
                shown next to the project, never instead of it. */}
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
              <div className="flex items-center gap-1.5">
                <ClientBadge client={clientOf(invoice.client_id)} showInactive={false} />
              </div>
            )}
            {invoice.amount > 0 ? (
              <p className="mt-1 text-lg font-bold leading-tight tracking-tight">{money(invoice.amount, currency)}</p>
            ) : (
              // No amount yet — the invoice went on the board before its
              // figure was known.
              <p className="mt-1 text-sm font-medium italic leading-tight text-muted-foreground">No amount yet</p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <Badge variant={overdue ? 'destructive' : 'muted'} className="gap-1 text-[10px]">
                <CalendarDays className="h-3 w-3" />
                {overdue ? `Overdue · ${formatDate(`${invoice.due_date}T00:00:00`)}` : invoice.due_date === today ? 'Due today' : `Due ${formatDate(`${invoice.due_date}T00:00:00`)}`}
              </Badge>
            </div>
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
              aria-label={`Move the ${billedTo(invoice)} invoice to the previous column`}
              onClick={() => nudge(invoice, -1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={stageIndex === INVOICE_STAGES.length - 1}
              aria-label={`Move the ${billedTo(invoice)} invoice to the next column`}
              onClick={() => nudge(invoice, 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={`Edit the ${billedTo(invoice)} invoice`}
              onClick={() => openEdit(invoice)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-destructive"
              aria-label={`Delete the ${billedTo(invoice)} invoice`}
              onClick={() => setDeleting(invoice)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    )
  }

  function renderLane(stage: InvoiceStage) {
    const style = InvoiceStageStyles[stage]
    const items = lanes[stage]
    const total = items.reduce((sum, inv) => sum + inv.amount, 0)
    const isTarget = dropTarget === stage
    return (
      <div
        key={stage}
        onDragOver={(e) => {
          if (!draggingRef.current) return
          e.preventDefault()
          if (!isTarget) setDropTarget(stage)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDropTarget((prev) => (prev === stage ? null : prev))
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          commitDrop(stage)
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
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{InvoiceStageNames[stage]}</h2>
          <Badge variant="muted" className="text-[10px]">{items.length}</Badge>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label={`Add an invoice straight into ${InvoiceStageNames[stage]}`}
            onClick={() => openNew(stage)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex flex-1 flex-col gap-2">
          {items.map((invoice) => (
            <div key={invoice.id}>{renderCard({ invoice, stage })}</div>
          ))}

          {items.length === 0 && !isTarget && (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">
              {dragging ? 'Drop the invoice here' : emptyLabel}
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

  // Header totals — the board at a glance: how much is still to be billed,
  // how much is out for payment, and how much has come in.
  const stageTotal = (stage: InvoiceStage) => lanes[stage].reduce((sum, inv) => sum + inv.amount, 0)
  const overdueCount = visibleInvoices.filter(isOverdue).length

  const showSkeleton = dataLoading && invoices.length === 0
  // Words for the empty board: a narrowed board says what it is narrowed to.
  const emptyLabel =
    basisFilter === 'all' ? 'No invoices here yet' : `No ${InvoiceBasisFilterLabels[basisFilter].toLowerCase()} invoices here yet`

  return (
    <div className="space-y-6">
      <PageHeader
        title="Client invoicing"
        description="Drag invoices between Pending, Awaiting and Paid — forwards to progress them, backwards to undo. Saves automatically."
      >
        <Button onClick={() => openNew('pending')}>
          <Plus className="mr-2 h-4 w-4" /> New invoice
        </Button>
      </PageHeader>

      {/* Which billing target the board shows — client based, project based or
          both. One switch for the whole page: the columns, the totals above
          them and the empty lanes all follow it, and the choice is remembered
          per device. The counts are of the whole board, so the size of the
          other half stays visible while one is showing. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="flex w-fit flex-wrap gap-1 rounded-lg border bg-muted/50 p-1"
          role="group"
          aria-label="Show all invoices, or only client based or project based ones"
        >
          {INVOICE_BASIS_FILTERS.map((option) => (
            <Button
              key={option}
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={basisFilter === option}
              onClick={() => setBasisFilter(option)}
              className={cn('gap-1.5 px-3 text-muted-foreground', basisFilter === option && 'bg-background text-foreground shadow-sm')}
            >
              {option === 'client' && <Building2 className="h-3.5 w-3.5" />}
              {option === 'project' && <Folder className="h-3.5 w-3.5" />}
              {InvoiceBasisFilterLabels[option]}
              <span className="text-xs text-muted-foreground">{countInvoicesByBasis(invoices, option)}</span>
            </Button>
          ))}
        </div>
        {basisFilter !== 'all' && (
          <p className="text-xs text-muted-foreground">
            Showing {visibleInvoices.length} of {invoices.length} invoices — {InvoiceBasisFilterLabels[basisFilter].toLowerCase()} only.
          </p>
        )}
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
              {INVOICE_STAGES.map((stage) => (
                <Skeleton key={stage} className="h-56 flex-[1_0_15.5rem] rounded-xl" />
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label="Pending"
              value={money(stageTotal('pending'), currency)}
              sub={`${lanes.pending.length} ${lanes.pending.length === 1 ? 'invoice' : 'invoices'} still to bill`}
              icon={Clock}
              loading={dataLoading && invoices.length === 0}
            />
            <StatCard
              label="Awaiting payment"
              value={money(stageTotal('awaiting'), currency)}
              sub={
                overdueCount > 0
                  ? `${lanes.awaiting.length} ${lanes.awaiting.length === 1 ? 'invoice' : 'invoices'} out · ${overdueCount} overdue`
                  : `${lanes.awaiting.length} ${lanes.awaiting.length === 1 ? 'invoice' : 'invoices'} out`
              }
              icon={ReceiptText}
            />
            <StatCard
              label="Paid"
              value={money(stageTotal('paid'), currency)}
              sub={`${lanes.paid.length} ${lanes.paid.length === 1 ? 'invoice' : 'invoices'} settled`}
              icon={CheckCircle2}
            />
          </div>

          {/* Horizontal board: the three lanes sit side by side inside one
              framed board. When the row is wider than the screen it scrolls
              sideways, one snapped lane at a time. */}
          <div className="rounded-2xl border bg-muted/30 p-2 sm:p-3">
            <div
              ref={rowRef}
              onDragOver={edgeScroll}
              className="flex snap-x snap-mandatory gap-2 overflow-x-auto"
            >
              {INVOICE_STAGES.map((stage) => renderLane(stage))}
            </div>
          </div>
        </>
      )}

      <InvoiceFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        invoice={editing}
        defaultStage={defaultStage}
        defaultBasis={editing ? undefined : newInvoiceBasis}
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
