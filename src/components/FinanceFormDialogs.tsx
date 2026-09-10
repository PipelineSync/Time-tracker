import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/lib/store'
import type { BillingCycle, FinanceItem } from '@/lib/types'
import { BillingCycleNames } from '@/lib/types'
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
import { toast } from 'sonner'
import { money } from '@/lib/utils'
import { currentMonthKey, monthLabel, suggestedPayroll, earningsByWorkerAndMonth } from '@/lib/finance'

/** Shared helpers for the three finance dialogs. */
function useAmountField(initial: number) {
  const [amount, setAmount] = useState(initial ? String(initial) : '')
  useEffect(() => setAmount(initial ? String(initial) : ''), [initial])
  return {
    amount,
    setAmount,
    /** Parsed value, or null when blank/invalid. */
    value: (() => {
      const v = parseFloat(amount)
      return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null
    })(),
  }
}

function AmountField({ amount, setAmount, currency }: { amount: string; setAmount: (v: string) => void; currency: string }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor="fi-amount">Amount ({currency})</Label>
      <Input
        id="fi-amount"
        type="number"
        min="0"
        step="0.01"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0.00"
      />
    </div>
  )
}

/** New subscription / edit an existing one. */
export function SubscriptionFormDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** The subscription being edited, or null to create one. */
  item: FinanceItem | null
}) {
  const { settings, createFinanceItem, updateFinanceItem } = useStore()
  const currency = settings?.currency || 'USD'
  const [name, setName] = useState('')
  const [cycle, setCycle] = useState<BillingCycle>('monthly')
  const [dueDate, setDueDate] = useState('')
  const [note, setNote] = useState('')
  // Every subscription runs either until someone switches it off, or for a
  // set number of bills — the choice is required, not implied.
  const [limitMode, setLimitMode] = useState<'off' | 'count'>('off')
  const [occurrences, setOccurrences] = useState('12')
  const [saving, setSaving] = useState(false)
  const amount = useAmountField(item?.amount ?? 0)

  useEffect(() => {
    if (!open) return
    setName(item?.name ?? '')
    setCycle(item?.cycle ?? 'monthly')
    setDueDate(item?.due_date ?? '')
    setNote(item?.note ?? '')
    setLimitMode(item?.max_occurrences != null ? 'count' : 'off')
    setOccurrences(item?.max_occurrences != null ? String(item.max_occurrences) : '12')
  }, [open, item])

  /** The parsed occurrence count, or null when the chosen limit is invalid. */
  const occurrenceValue = (() => {
    if (limitMode !== 'count') return null
    const n = Number(occurrences)
    return Number.isFinite(n) && n >= 1 && Math.floor(n) === n ? Math.floor(n) : null
  })()

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const label = name.trim()
    if (!label) return toast.error('Give the subscription a name.')
    if (amount.value === null) return toast.error('Enter the amount it bills.')
    if (!dueDate) return toast.error('Pick the next due date.')
    if (limitMode === 'count' && occurrenceValue === null) {
      return toast.error('Enter how many times it bills — a whole number of 1 or more.')
    }
    setSaving(true)
    try {
      const shared = {
        name: label,
        amount: amount.value,
        cycle,
        due_date: dueDate,
        note: note.trim() || null,
        max_occurrences: occurrenceValue,
      }
      const res = item
        ? await updateFinanceItem(item.id, shared)
        : await createFinanceItem({ kind: 'subscription', ...shared })
      if (!res) return
      toast.success(item ? 'Subscription updated.' : 'Subscription added.')
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{item ? 'Edit subscription' : 'New subscription'}</DialogTitle>
            <DialogDescription>
              A recurring service the business pays for. Its next bill date drives the due-date list.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="sub-name">Name</Label>
              <Input id="sub-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. QuickBooks" maxLength={80} autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <AmountField amount={amount.amount} setAmount={amount.setAmount} currency={currency} />
              <div className="grid gap-2">
                <Label htmlFor="sub-cycle">Billed</Label>
                <Select value={cycle} onValueChange={(v) => setCycle(v as BillingCycle)}>
                  <SelectTrigger id="sub-cycle"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(BillingCycleNames) as BillingCycle[]).map((c) => (
                      <SelectItem key={c} value={c}>{BillingCycleNames[c]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sub-due">Next due</Label>
              <Input id="sub-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sub-limit">Runs</Label>
              <Select value={limitMode} onValueChange={(v) => setLimitMode(v as 'off' | 'count')}>
                <SelectTrigger id="sub-limit"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Until switched off</SelectItem>
                  <SelectItem value="count">For a set number of bills</SelectItem>
                </SelectContent>
              </Select>
              {limitMode === 'count' ? (
                <div className="flex items-center gap-2">
                  <Input
                    id="sub-occurrences"
                    type="number"
                    min="1"
                    step="1"
                    value={occurrences}
                    onChange={(e) => setOccurrences(e.target.value)}
                    className="w-24"
                    aria-label="How many times it bills"
                  />
                  <span className="text-xs text-muted-foreground">
                    {occurrenceValue === 1 ? 'time, then it pauses itself' : 'times, then it pauses itself'}
                    {item && item.billed_count > 0 ? ` — billed ${item.billed_count} so far` : ''}
                  </span>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  It keeps billing on its cycle until you pause it.
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sub-note">Note (optional)</Label>
              <Textarea id="sub-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Seats, contract, what it covers…" />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : item ? 'Save changes' : 'Add subscription'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Payroll run for one worker and one month. */
export function PayrollFormDialog({
  open,
  onOpenChange,
  item,
  defaultMonth,
  defaultWorkerId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** The run being edited, or null to create one. */
  item: FinanceItem | null
  /** Month pre-selected on the payroll tab ('YYYY-MM'). */
  defaultMonth: string
  defaultWorkerId?: string
}) {
  const { settings, workers, entries, can, createFinanceItem, updateFinanceItem } = useStore()
  const currency = settings?.currency || 'USD'
  const [workerId, setWorkerId] = useState('')
  const [month, setMonth] = useState(defaultMonth)
  const [dueDate, setDueDate] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const amount = useAmountField(item?.amount ?? 0)
  const [amountEdited, setAmountEdited] = useState(false)

  const activeWorkers = useMemo(() => {
    const list = workers.filter((w) => w.status === 'active')
    return list.length > 0 ? list : workers
  }, [workers])

  // The tracked time backs the suggested amount only when the viewer can see
  // every worker's entries; otherwise the number would be misleadingly small.
  const canSuggest = can('entries.view_all')
  const earningsByMonth = useMemo(() => earningsByWorkerAndMonth(entries), [entries])
  const suggestion = useMemo(() => {
    if (!canSuggest || !workerId || !month) return null
    return suggestedPayroll(earningsByMonth, workerId, month)
  }, [canSuggest, workerId, month, earningsByMonth])

  function monthEnd(ym: string): string {
    const [y, m] = ym.split('-').map(Number)
    if (!y || !m) return ym + '-28'
    const last = new Date(y, m, 0)
    return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`
  }

  useEffect(() => {
    if (!open) return
    if (item) {
      setWorkerId(item.worker_id ?? '')
      setMonth(item.period_month ?? defaultMonth)
      setDueDate(item.due_date)
      setNote(item.note ?? '')
      setAmountEdited(true)
    } else {
      const pre = defaultWorkerId || activeWorkers[0]?.id || ''
      setWorkerId(pre)
      setMonth(defaultMonth || currentMonthKey())
      setDueDate(monthEnd(defaultMonth || currentMonthKey()))
      setNote('')
      setAmountEdited(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item, defaultMonth, defaultWorkerId])

  // Pre-fill the amount from the month's tracked time until it is typed by hand.
  useEffect(() => {
    if (open && !item && !amountEdited && suggestion !== null) amount.setAmount(String(suggestion))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item, workerId, month, suggestion, amountEdited])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!workerId) return toast.error('Choose the worker being paid.')
    if (!/^\d{4}-\d{2}$/.test(month)) return toast.error('Choose the month this pay covers.')
    if (amount.value === null) return toast.error('Enter the amount to pay.')
    if (!dueDate) return toast.error('Pick the pay day.')
    setSaving(true)
    try {
      const res = item
        ? await updateFinanceItem(item.id, { worker_id: workerId, period_month: month, amount: amount.value, due_date: dueDate, note: note.trim() || null })
        : await createFinanceItem({ kind: 'payroll', worker_id: workerId, period_month: month, amount: amount.value, due_date: dueDate, note: note.trim() || null })
      if (!res) return
      toast.success(item ? 'Payroll run updated.' : 'Payroll run added.')
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const workerName = workers.find((w) => w.id === workerId)?.name

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{item ? 'Edit payroll run' : 'New payroll run'}</DialogTitle>
            <DialogDescription>
              What a worker is paid for one month — fixed pay, bonus, or a settlement to schedule.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="pay-worker">Worker</Label>
              <Select value={workerId} onValueChange={setWorkerId}>
                <SelectTrigger id="pay-worker">
                  <SelectValue placeholder={activeWorkers.length ? 'Choose a worker' : 'No workers yet'} />
                </SelectTrigger>
                <SelectContent>
                  {activeWorkers.map((w) => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="pay-month">For month</Label>
                <Input id="pay-month" type="month" value={month} onChange={(e) => { setMonth(e.target.value); if (!item) setDueDate(monthEnd(e.target.value)) }} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="pay-due">Pay day (due)</Label>
                <Input id="pay-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pay-amount">Amount ({currency})</Label>
              <Input
                id="pay-amount"
                type="number"
                min="0"
                step="0.01"
                value={amount.amount}
                onChange={(e) => { amount.setAmount(e.target.value); setAmountEdited(true) }}
                placeholder="0.00"
              />
              {suggestion !== null && (
                <p className="text-xs text-muted-foreground">
                  Tracked time for {workerName || 'this worker'} in {monthLabel(month)} earned{' '}
                  <span className="font-medium text-foreground">{money(suggestion, currency)}</span>
                  {!amountEdited && ' — used as the suggested amount.'}
                  {amountEdited && suggestion !== amount.value && (
                    <button type="button" className="ml-1 font-medium text-primary hover:underline" onClick={() => amount.setAmount(String(suggestion))}>
                      Use it
                    </button>
                  )}
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pay-note">Note (optional)</Label>
              <Textarea id="pay-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Salary + overtime, payment plan…" />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : item ? 'Save changes' : 'Add payroll run'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** One-off bill with a due date. */
export function BillFormDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  item: FinanceItem | null
}) {
  const { settings, createFinanceItem, updateFinanceItem } = useStore()
  const currency = settings?.currency || 'USD'
  const [name, setName] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const amount = useAmountField(item?.amount ?? 0)

  useEffect(() => {
    if (!open) return
    setName(item?.name ?? '')
    setDueDate(item?.due_date ?? new Date().toISOString().slice(0, 10))
    setNote(item?.note ?? '')
  }, [open, item])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const label = name.trim()
    if (!label) return toast.error('Give the bill a label.')
    if (amount.value === null) return toast.error('Enter the amount due.')
    if (!dueDate) return toast.error('Pick the due date.')
    setSaving(true)
    try {
      const res = item
        ? await updateFinanceItem(item.id, { name: label, amount: amount.value, due_date: dueDate, note: note.trim() || null })
        : await createFinanceItem({ kind: 'bill', name: label, amount: amount.value, due_date: dueDate, note: note.trim() || null })
      if (!res) return
      toast.success(item ? 'Bill updated.' : 'Bill added.')
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{item ? 'Edit bill' : 'New bill'}</DialogTitle>
            <DialogDescription>
              A one-off amount due on a date — rent, tax, insurance, an invoice to pay.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="bill-name">Label</Label>
              <Input id="bill-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Office rent" maxLength={80} autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <AmountField amount={amount.amount} setAmount={amount.setAmount} currency={currency} />
              <div className="grid gap-2">
                <Label htmlFor="bill-due">Due on</Label>
                <Input id="bill-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bill-note">Note (optional)</Label>
              <Textarea id="bill-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Reference, terms…" />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : item ? 'Save changes' : 'Add bill'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
