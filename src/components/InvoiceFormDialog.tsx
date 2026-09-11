import { useEffect, useState } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ClientSelect } from '@/components/ClientSelect'
import { useStore } from '@/lib/store'
import type { Invoice, InvoiceBasis, InvoiceStage } from '@/lib/types'
import { INVOICE_BASES, INVOICE_STAGES, InvoiceBasisNames, InvoiceStageNames } from '@/lib/types'
import { toast } from 'sonner'

interface FormState {
  clientId: string
  basis: InvoiceBasis
  projectName: string
  amount: string
  dueDate: string // 'YYYY-MM-DD' (local)
  stage: InvoiceStage
  notes: string
}

/** Local 'YYYY-MM-DD' of a Date, for pre-filling the due-date input. */
function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Raise / edit an invoice: what is being billed (the whole client, or one
 * named project of it), an optional amount — an invoice can go on the board
 * before its figure is known and the amount filled in later — when payment
 * is due and optional notes. The stage picker doubles as the "record it
 * straight into another column" affordance, so logging an invoice that was
 * already paid needs no drag afterwards; a new invoice defaults to Pending
 * and the board is still where invoices move day to day.
 */
export function InvoiceFormDialog({
  open,
  onOpenChange,
  invoice,
  defaultStage,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** The invoice being edited, or null when raising a new one. */
  invoice: Invoice | null
  /** Column a new invoice starts in (the "＋" button of the lane it was raised from). */
  defaultStage?: InvoiceStage
}) {
  const { createInvoice, updateInvoice, settings } = useStore()
  const [form, setForm] = useState<FormState>({ clientId: '', basis: 'client', projectName: '', amount: '', dueDate: '', stage: 'pending', notes: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (invoice) {
      setForm({
        clientId: invoice.client_id,
        basis: invoice.basis,
        projectName: invoice.project_name || '',
        amount: String(invoice.amount),
        dueDate: invoice.due_date,
        stage: invoice.stage,
        notes: invoice.notes || '',
      })
    } else {
      // A new invoice is due in 14 days — long enough to be sensible, short
      // enough that nobody accidentally bills two months out.
      const due = new Date()
      due.setDate(due.getDate() + 14)
      setForm({ clientId: '', basis: 'client', projectName: '', amount: '', dueDate: localDate(due), stage: defaultStage ?? 'pending', notes: '' })
    }
  }, [open, invoice, defaultStage])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.clientId) {
      toast.error('Pick a client to bill.')
      return
    }
    // Project-based invoices must name the project; client-based ones carry
    // no project at all.
    const projectName = form.basis === 'project' ? form.projectName.trim() : ''
    if (form.basis === 'project' && !projectName) {
      toast.error('Name the project this invoice bills.')
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
      if (invoice) {
        const saved = await updateInvoice(invoice.id, {
          client_id: form.clientId,
          basis: form.basis,
          project_name: projectName || null,
          amount: Math.round(amount * 100) / 100,
          due_date: form.dueDate,
          stage: form.stage,
          notes: form.notes.trim() || null,
        })
        if (!saved) return
        toast.success(saved.stage !== invoice.stage ? `Invoice moved to ${InvoiceStageNames[saved.stage]}.` : 'Invoice updated.')
      } else {
        const created = await createInvoice({
          client_id: form.clientId,
          basis: form.basis,
          project_name: projectName || null,
          amount: Math.round(amount * 100) / 100,
          due_date: form.dueDate,
          stage: form.stage,
          notes: form.notes.trim() || null,
        })
        if (!created) return
        toast.success(created.stage === 'pending' ? 'Invoice raised — it is on the board as Pending.' : `Invoice raised — filed under ${InvoiceStageNames[created.stage]}.`)
      }
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{invoice ? 'Edit invoice' : 'New invoice'}</DialogTitle>
            <DialogDescription>
              {invoice
                ? 'Change what it bills, the amount, due date, column or notes.'
                : 'A card on the board: drag it to Awaiting once sent, and to Paid once settled.'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="invoice-client">Client</Label>
              <ClientSelect
                id="invoice-client"
                value={form.clientId}
                onValueChange={(v) => set('clientId', v)}
                placeholder="Choose a client"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="invoice-basis">Based on</Label>
              <Select value={form.basis} onValueChange={(v) => set('basis', v as InvoiceBasis)}>
                <SelectTrigger id="invoice-basis">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INVOICE_BASES.map((basis) => (
                    <SelectItem key={basis} value={basis}>
                      {InvoiceBasisNames[basis]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {form.basis === 'project'
                  ? 'Project based — this invoice bills one project of the client.'
                  : 'Client based — this invoice bills the client as a whole.'}
              </p>
            </div>

            {form.basis === 'project' && (
              <div className="grid gap-2">
                <Label htmlFor="invoice-project">Project name</Label>
                <Input
                  id="invoice-project"
                  value={form.projectName}
                  onChange={(e) => set('projectName', e.target.value)}
                  placeholder="e.g. Website redesign"
                  required
                />
              </div>
            )}

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

            <div className="grid gap-2">
              <Label htmlFor="invoice-stage">Column</Label>
              <Select value={form.stage} onValueChange={(v) => set('stage', v as InvoiceStage)}>
                <SelectTrigger id="invoice-stage">
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
