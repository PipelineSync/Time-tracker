import { useEffect, useState } from 'react'
import { Briefcase, Building2, Folder } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ClientSelect } from '@/components/ClientSelect'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import type { Invoice, InvoiceBasis, InvoiceStage } from '@/lib/types'
import { INVOICE_BASES, INVOICE_STAGES, InvoiceBasisNames, InvoiceStageNames } from '@/lib/types'
import { toast } from 'sonner'

interface FormState {
  clientId: string
  basis: InvoiceBasis
  projectName: string
  amount: string
  billOn: string // 'YYYY-MM-DD' (local) — regular clients only
  dueDate: string // 'YYYY-MM-DD' (local)
  autoBill: boolean // regular clients only
  stage: InvoiceStage
  notes: string
}

/** Local 'YYYY-MM-DD' of a Date, for pre-filling the date inputs. */
function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const BASIS_ICONS: Record<InvoiceBasis, typeof Building2> = {
  client: Building2,
  project: Folder,
  upwork: Briefcase,
}

/** What each billing target means, in the words the form uses. */
const BASIS_HINTS: Record<InvoiceBasis, string> = {
  client:
    'Regular client — billed every month. While auto-bill is on, each cycle goes out on its bill-on date and the next month is queued behind it.',
  project:
    'Project-based — a one-off or milestone invoice for the project named above. Raised by hand. Naming a client is optional: it only says whose project it is.',
  upwork: 'Upwork client — raised by hand, and counted in the same monthly totals as everything else.',
}

/**
 * Raise / edit an invoice: what it bills (a regular client, a named project —
 * which may name the client it belongs to — or an Upwork client), an optional
 * amount (an invoice can go on the board before its figure is known), the
 * dates, the column and notes. A regular client also carries its bill-on date
 * and the client's auto-bill switch. The column picker doubles as "record it
 * straight into another column", so an invoice already paid needs no drag.
 */
export function InvoiceFormDialog({
  open,
  onOpenChange,
  invoice,
  defaultStage,
  defaultBasis,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** The invoice being edited, or null when raising a new one. */
  invoice: Invoice | null
  /** Column a new invoice starts in (the "＋" button of the lane it was raised from). */
  defaultStage?: InvoiceStage
  /**
   * What a new invoice bills, when the board is already narrowed to one kind
   * of invoice — raising from a narrowed board keeps the same kind.
   */
  defaultBasis?: InvoiceBasis
}) {
  const { createInvoice, updateInvoice, settings } = useStore()
  const [form, setForm] = useState<FormState>({
    clientId: '',
    basis: 'client',
    projectName: '',
    amount: '',
    billOn: '',
    dueDate: '',
    autoBill: true,
    stage: 'pending',
    notes: '',
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (invoice) {
      setForm({
        clientId: invoice.client_id ?? '',
        basis: invoice.basis,
        projectName: invoice.project_name || '',
        amount: String(invoice.amount),
        billOn: invoice.bill_on ?? localDate(new Date()),
        dueDate: invoice.due_date,
        // Only a regular client carries the switch; one that becomes regular
        // starts with auto-bill on, as a new regular client does.
        autoBill: invoice.basis === 'client' ? invoice.auto_bill : true,
        stage: invoice.stage,
        notes: invoice.notes || '',
      })
    } else {
      // A new invoice is due in 14 days — long enough to be sensible, short
      // enough that nobody accidentally bills two months out.
      const due = new Date()
      due.setDate(due.getDate() + 14)
      setForm({
        clientId: '',
        basis: defaultBasis ?? 'client',
        projectName: '',
        amount: '',
        billOn: localDate(new Date()),
        dueDate: localDate(due),
        autoBill: true,
        stage: defaultStage ?? 'pending',
        notes: '',
      })
    }
  }, [open, invoice, defaultStage, defaultBasis])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const regular = form.basis === 'client'
    const projectName = form.basis === 'project' ? form.projectName.trim() : ''
    const clientId = form.clientId || null
    // A regular or Upwork invoice bills a client and must pick one; a
    // project-based one must name the project and may also name its client.
    if (form.basis !== 'project' && !clientId) {
      toast.error('Pick a client to bill.')
      return
    }
    if (form.basis === 'project' && !projectName) {
      toast.error('Name the project this invoice bills.')
      return
    }
    if (regular && !form.billOn) {
      toast.error('Pick the day this invoice is billed.')
      return
    }
    // The amount is optional: left blank it is recorded as zero, to be
    // filled in once the figure is known.
    const amount = form.amount.trim() ? Number(form.amount) : 0
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error('Give the invoice a valid amount — or leave it blank for now.')
      return
    }
    if (!form.dueDate) {
      toast.error('Pick the date payment is due.')
      return
    }
    setSaving(true)
    try {
      const payload = {
        client_id: clientId,
        basis: form.basis,
        project_name: projectName || null,
        amount: Math.round(amount * 100) / 100,
        due_date: form.dueDate,
        stage: form.stage,
        notes: form.notes.trim() || null,
        bill_on: regular ? form.billOn : null,
        auto_bill: regular ? form.autoBill : false,
      }
      if (invoice) {
        const saved = await updateInvoice(invoice.id, payload)
        if (!saved) return
        toast.success(saved.stage !== invoice.stage ? `Invoice moved to ${InvoiceStageNames[saved.stage]}.` : 'Invoice updated.')
      } else {
        const created = await createInvoice(payload)
        if (!created) return
        toast.success(
          created.stage === 'pending'
            ? 'Invoice raised — it is on the board as Pending.'
            : `Invoice raised — filed under ${InvoiceStageNames[created.stage]}.`,
        )
      }
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const isRegular = form.basis === 'client'

  const columnField = (
    <div className="grid gap-2">
      <span className="text-sm font-medium leading-none">Column</span>
      <Select value={form.stage} onValueChange={(v) => set('stage', v as InvoiceStage)}>
        <SelectTrigger id="invoice-stage" aria-label="Column">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {INVOICE_STAGES.map((stage) => (
            <SelectItem key={stage} value={stage}>
              {InvoiceStageNames[stage]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{invoice ? 'Edit invoice' : 'New invoice'}</DialogTitle>
            <DialogDescription>
              {invoice
                ? 'Change what it bills, the amount, dates, column or notes.'
                : 'A card on the board: it starts in Pending, moves to Awaiting once billed and to Paid once settled.'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* What it bills — three kinds of invoice. Switching keeps whatever
                client is already chosen; a project may keep its client too. */}
            <div className="grid gap-2">
              <span className="text-sm font-medium leading-none">Bill to</span>
              <div className="grid gap-3 rounded-lg border bg-muted/30 p-2.5">
                <div className="flex w-fit flex-wrap gap-1 rounded-md bg-muted p-1" role="group" aria-label="What this invoice bills">
                  {INVOICE_BASES.map((basis) => {
                    const Icon = BASIS_ICONS[basis]
                    return (
                      <Button
                        key={basis}
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-pressed={form.basis === basis}
                        onClick={() => set('basis', basis)}
                        className={cn('gap-1.5 px-3 text-muted-foreground', form.basis === basis && 'bg-background text-foreground shadow-sm')}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {InvoiceBasisNames[basis]}
                      </Button>
                    )
                  })}
                </div>

                {form.basis === 'project' && (
                  <div className="grid gap-2">
                    <Label htmlFor="invoice-project" className="text-xs text-muted-foreground">
                      Project name
                    </Label>
                    <Input
                      id="invoice-project"
                      value={form.projectName}
                      onChange={(e) => set('projectName', e.target.value)}
                      placeholder="e.g. Website redesign"
                      required
                    />
                  </div>
                )}

                <div className="grid gap-2">
                  <Label htmlFor="invoice-client" className="text-xs text-muted-foreground">
                    {form.basis === 'project' ? 'Client (optional)' : 'Client'}
                  </Label>
                  <ClientSelect
                    id="invoice-client"
                    value={form.basis === 'project' ? form.clientId || 'none' : form.clientId}
                    onValueChange={(v) => set('clientId', v === 'none' ? '' : v)}
                    includeNone={form.basis === 'project'}
                    noneLabel="No client"
                    placeholder="Choose a client"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{BASIS_HINTS[form.basis]}</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="invoice-amount">Amount ({settings?.currency || 'USD'} · optional)</Label>
                <Input
                  id="invoice-amount"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={form.amount}
                  onChange={(e) => set('amount', e.target.value)}
                  placeholder="0.00"
                  autoFocus={!invoice}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="invoice-due">Due date</Label>
                <Input
                  id="invoice-due"
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => set('dueDate', e.target.value)}
                  required
                />
              </div>
            </div>

            {/* A regular client's cycle: the day it is billed, and whether
                auto-bill raises it and queues the next one. */}
            {isRegular && (
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="invoice-bill-on">Bill on</Label>
                  <Input
                    id="invoice-bill-on"
                    type="date"
                    value={form.billOn}
                    onChange={(e) => set('billOn', e.target.value)}
                    required
                  />
                </div>
                {columnField}
              </div>
            )}

            {isRegular && (
              <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="invoice-auto-bill">Auto-bill</Label>
                  <p className="text-xs text-muted-foreground">
                    Raised on its bill-on date, then next month is queued. The switch covers every invoice for this client.
                  </p>
                </div>
                <Switch id="invoice-auto-bill" checked={form.autoBill} onCheckedChange={(v) => set('autoBill', v)} aria-label="Auto-bill for this client" />
              </div>
            )}

            {!isRegular && columnField}

            <div className="grid gap-2">
              <Label htmlFor="invoice-notes">Notes (optional)</Label>
              <Textarea
                id="invoice-notes"
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
                placeholder="What it covers, when it was sent, who to chase…"
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : invoice ? 'Save changes' : 'Add invoice'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
