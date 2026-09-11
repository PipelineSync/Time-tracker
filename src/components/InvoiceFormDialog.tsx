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
import type { Invoice, InvoiceStage } from '@/lib/types'
import { INVOICE_STAGES, InvoiceStageNames } from '@/lib/types'
import { toast } from 'sonner'

interface FormState {
  clientId: string
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
 * Raise / edit an invoice: the client, an amount, when payment is due and
 * optional notes — the whole data model. The stage picker doubles as the
 * "record it straight into another column" affordance, so logging an invoice
 * that was already paid needs no drag afterwards; a new invoice defaults to
 * Pending and the board is still where invoices move day to day.
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
  const [form, setForm] = useState<FormState>({ clientId: '', amount: '', dueDate: '', stage: 'pending', notes: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (invoice) {
      setForm({
        clientId: invoice.client_id,
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
      setForm({ clientId: '', amount: '', dueDate: localDate(due), stage: defaultStage ?? 'pending', notes: '' })
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
    const amount = Number(form.amount)
    if (!form.amount.trim() || !Number.isFinite(amount) || amount <= 0) {
      toast.error('Give the invoice an amount greater than zero.')
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
                ? 'Change the client, amount, due date, column or notes.'
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

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="invoice-amount">Amount ({settings?.currency || 'USD'})</Label>
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
                  required
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
