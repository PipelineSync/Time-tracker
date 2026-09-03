import { useMemo } from 'react'
import { useStore } from '@/lib/store'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/EmptyState'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useState } from 'react'
import { toast } from 'sonner'
import { Wallet, Trash2, Pencil, Banknote, QrCode, CreditCard, Check } from 'lucide-react'
import type { Payment, PaymentMethod, PaymentStatus, Worker } from '@/lib/types'
import { cn } from '@/lib/utils'
import { money, formatMinutes, formatDate } from '@/lib/utils'
import { AvatarBubble } from '@/components/AvatarBubble'

const statusBadge: Record<PaymentStatus, 'muted' | 'success' | 'outline'> = {
  unpaid: 'muted',
  pending: 'outline',
  paid: 'success',
}

const methodLabel: Record<PaymentMethod, string> = { cash: 'Cash', qr: 'QR Code' }

/** Small "Cash" / "QR Code" pill, used in the history table and dialogs. */
function MethodBadge({ method, className }: { method: PaymentMethod; className?: string }) {
  return method === 'cash' ? (
    <Badge variant="success" className={cn('gap-1', className)}><Banknote className="h-3 w-3" /> Cash</Badge>
  ) : (
    <Badge variant="secondary" className={cn('gap-1', className)}><QrCode className="h-3 w-3" /> QR Code</Badge>
  )
}

export function PaymentsPage() {
  const { payments, workers, settings, isAdmin, dataLoading, updatePaymentStatus, updatePaymentNote, deletePayment } = useStore()
  const currency = settings?.currency || 'USD'
  const [statusFilter, setStatusFilter] = useState<'all' | PaymentStatus>('all')
  const [deleting, setDeleting] = useState<Payment | null>(null)
  const [editing, setEditing] = useState<Payment | null>(null)
  const [editNote, setEditNote] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  // QR code being viewed full-size (worker's own, or from the Mark paid dialog).
  const [qrViewer, setQrViewer] = useState<{ worker: Worker; url: string } | null>(null)
  // "Mark paid" flow: the admin sees the worker's accepted methods and picks
  // the one they are paying with before the payment is marked paid.
  const [paying, setPaying] = useState<Payment | null>(null)
  const [payMethod, setPayMethod] = useState<PaymentMethod | null>(null)
  const [paySaving, setPaySaving] = useState(false)

  const workerName = (id: string) => workers.find((w) => w.id === id)?.name || 'Worker'
  const workerById = (id: string) => workers.find((w) => w.id === id) ?? null
  const payingWorker = paying ? workerById(paying.worker_id) : null
  const payingMethods: PaymentMethod[] = payingWorker?.payment_methods ?? []

  const filtered = useMemo(() => {
    const list = statusFilter === 'all' ? payments : payments.filter((p) => p.status === statusFilter)
    return [...list].sort((a, b) => b.created_at.localeCompare(a.created_at))
  }, [payments, statusFilter])

  const totals = useMemo(() => {
    const byStatus: Record<PaymentStatus, { amount: number; count: number }> = {
      unpaid: { amount: 0, count: 0 },
      pending: { amount: 0, count: 0 },
      paid: { amount: 0, count: 0 },
    }
    for (const p of payments) {
      byStatus[p.status].amount += p.amount
      byStatus[p.status].count += 1
    }
    return byStatus
  }, [payments])

  async function setStatus(p: Payment, status: PaymentStatus) {
    const res = await updatePaymentStatus(p.id, status)
    if (!res) toast.error('Failed to update status.')
    else toast.success(`Payment marked ${status}.`)
  }

  function openMarkPaid(p: Payment) {
    const methods = workerById(p.worker_id)?.payment_methods ?? []
    // Pre-select when the worker only accepts one method.
    setPayMethod(methods.length === 1 ? methods[0] : null)
    setPaying(p)
  }

  async function confirmMarkPaid() {
    if (!paying) return
    if (payingMethods.length > 0 && !payMethod) {
      toast.error('Choose the payment method you used.')
      return
    }
    setPaySaving(true)
    const res = await updatePaymentStatus(paying.id, 'paid', payMethod)
    setPaySaving(false)
    if (!res) {
      toast.error('Failed to mark the payment as paid.')
      return
    }
    toast.success(payMethod ? `Payment marked paid via ${methodLabel[payMethod]}.` : 'Payment marked paid.')
    setPaying(null)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description={isAdmin ? 'Settlements from worker time, with payment status.' : 'Your payment history.'}
      />

      {/* Workers see the payment methods they have enabled. The admin picks the
          method when marking a payment as paid instead of browsing a list. */}
      {!isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              Your payment methods
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Manage how you get paid from Settings → Payment methods.
            </p>
          </CardHeader>
          <CardContent>
            {(() => {
              const me = workers[0]
              if (!me) return <p className="text-sm text-muted-foreground">Your profile is not available.</p>
              const methods = me.payment_methods ?? []
              if (methods.length === 0) {
                return <p className="text-sm text-muted-foreground">You have not set up a payment method yet. Open Settings → Payment methods.</p>
              }
              return (
                <div className="flex flex-wrap items-center gap-3">
                  {methods.includes('cash') && (
                    <Badge variant="success" className="gap-1"><Banknote className="h-3.5 w-3.5" /> Cash</Badge>
                  )}
                  {methods.includes('qr') && me.qr_code_url && (
                    <button
                      type="button"
                      onClick={() => setQrViewer({ worker: me, url: me.qr_code_url! })}
                      className="flex items-center gap-2 rounded-lg border p-1.5 pr-3 hover:bg-muted/50"
                    >
                      <span className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-md border bg-white">
                        <img src={me.qr_code_url} alt="Your payment QR code" className="h-full w-full object-contain" />
                      </span>
                      <span className="flex items-center gap-1 text-xs font-medium text-primary">
                        <QrCode className="h-3.5 w-3.5" /> View your QR code
                      </span>
                    </button>
                  )}
                  {methods.includes('qr') && !me.qr_code_url && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">QR Code is enabled but your image is missing — re-upload it in Settings.</p>
                  )}
                </div>
              )
            })()}
          </CardContent>
        </Card>
      )}

      {/* Summary by status */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {(['unpaid', 'pending', 'paid'] as PaymentStatus[]).map((s) => (
          <Card key={s} className={statusFilter === s ? 'border-primary/50 bg-primary/5' : ''}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium capitalize text-muted-foreground">{s}</span>
                <Badge variant={statusBadge[s]}>{totals[s].count}</Badge>
              </div>
              <p className="mt-2 text-2xl font-bold">{money(totals[s].amount, currency)}</p>
              <button
                className="mt-1 text-xs text-primary hover:underline"
                onClick={() => setStatusFilter(statusFilter === s ? 'all' : s)}
              >
                {statusFilter === s ? 'Show all' : `View ${s}`}
              </button>
            </CardContent>
          </Card>
        ))}
      </div>

      {dataLoading && payments.length === 0 ? (
        <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="No payments"
          description={
            isAdmin
              ? 'Settle a worker’s unsettled time to create an unpaid payment. Their time entries are kept and marked as settled.'
              : 'You don’t have any payments yet.'
          }
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payment history</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Worker</th>
                  <th className="px-3 py-2 font-medium">Hours</th>
                  <th className="px-3 py-2 font-medium">Amount</th>
                  <th className="px-3 py-2 font-medium">Note</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Paid via</th>
                  {isAdmin && <th className="px-3 py-2 text-right font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-muted/40">
                    <td className="px-3 py-3">{formatDate(p.created_at)}</td>
                    <td className="px-3 py-3 font-medium">{workerName(p.worker_id)}</td>
                    <td className="px-3 py-3">{formatMinutes(p.hours * 60)}</td>
                    <td className="px-3 py-3 font-semibold">{money(p.amount, currency)}</td>
                    <td className="px-3 py-3 max-w-[200px]">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs text-muted-foreground" title={p.note || ''}>
                          {p.note || <span className="italic text-muted-foreground/60">—</span>}
                        </span>
                        {isAdmin && (
                          <button
                            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
                            onClick={() => { setEditing(p); setEditNote(p.note || '') }}
                            aria-label="Edit note"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant={statusBadge[p.status]} className="capitalize">{p.status}</Badge>
                    </td>
                    <td className="px-3 py-3">
                      {p.status === 'paid' && p.payment_method ? (
                        <MethodBadge method={p.payment_method} />
                      ) : (
                        <span className="text-xs italic text-muted-foreground/60">—</span>
                      )}
                    </td>
                    {isAdmin && (
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          {p.status !== 'paid' && (
                            <Button variant="outline" size="sm" onClick={() => openMarkPaid(p)}>Mark paid</Button>
                          )}
                          {p.status === 'unpaid' && (
                            <Button variant="outline" size="sm" onClick={() => setStatus(p, 'pending')}>Mark pending</Button>
                          )}
                          {p.status === 'pending' && (
                            <Button variant="outline" size="sm" onClick={() => setStatus(p, 'unpaid')}>Back to unpaid</Button>
                          )}
                          <Button variant="ghost" size="iconSm" className="text-destructive" onClick={() => setDeleting(p)} aria-label="Delete payment">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {deleting && (
        <ConfirmDialog
          open={!!deleting}
          onOpenChange={(v) => { if (!v) setDeleting(null); }}
          title="Delete payment?"
          description={`Delete this ${money(deleting.amount, currency)} payment for ${workerName(deleting.worker_id)}? This cannot be undone.`}
          confirmLabel="Delete payment"
          onConfirm={async () => {
            const ok = await deletePayment(deleting.id)
            if (ok) toast.success('Payment deleted.')
            else toast.error('Failed to delete payment.')
          }}
        />
      )}

      <Dialog open={!!editing} onOpenChange={(v) => { if (!v) setEditing(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit settlement note</DialogTitle>
            <DialogDescription>
              Update the note for the {money(editing?.amount || 0, currency)} payment to {editing ? workerName(editing.worker_id) : ''}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">Note</label>
            <Textarea
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              placeholder="e.g. Weekly settlement, bonus adjustment…"
              className="min-h-[80px]"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditing(null)} disabled={editSaving}>Cancel</Button>
            <Button
              onClick={async () => {
                if (!editing) return
                setEditSaving(true)
                const res = await updatePaymentNote(editing.id, editNote.trim() || null)
                setEditSaving(false)
                if (res) {
                  toast.success('Note updated.')
                  setEditing(null)
                } else {
                  toast.error('Failed to update note.')
                }
              }}
              disabled={editSaving}
            >
              {editSaving ? 'Saving…' : 'Save note'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mark paid — shows the worker's accepted methods; the admin picks one */}
      <Dialog open={!!paying} onOpenChange={(v) => { if (!v && !paySaving) setPaying(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5" />
              Mark payment as paid
            </DialogTitle>
            <DialogDescription>
              {money(paying?.amount || 0, currency)} to {paying ? workerName(paying.worker_id) : ''}
              {paying ? ` for ${formatMinutes(paying.hours * 60)}` : ''}. Choose the payment method you used.
            </DialogDescription>
          </DialogHeader>

          {paying && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
                <AvatarBubble name={payingWorker?.name || 'Worker'} avatarUrl={payingWorker?.avatar_url ?? null} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{payingWorker?.name || workerName(paying.worker_id)}</p>
                  <p className="text-xs text-muted-foreground">
                    {payingMethods.length === 0
                      ? 'Has not set up a payment method yet.'
                      : `Accepts ${payingMethods.map((m) => methodLabel[m]).join(' and ')}.`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  {payingMethods.map((m) => <MethodBadge key={m} method={m} />)}
                </div>
              </div>

              {payingMethods.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {payingWorker?.name || 'This worker'} hasn’t chosen how they want to be paid (Settings → Payment methods on their account).
                  You can still mark the payment as paid without a method.
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Pay with</p>
                  <div className={cn('grid gap-2', payingMethods.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
                    {payingMethods.includes('cash') && (
                      <button
                        type="button"
                        onClick={() => setPayMethod('cash')}
                        aria-pressed={payMethod === 'cash'}
                        className={cn(
                          'relative flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors hover:bg-muted/50',
                          payMethod === 'cash' && 'border-primary bg-primary/5 ring-1 ring-primary'
                        )}
                      >
                        {payMethod === 'cash' && (
                          <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <Check className="h-3 w-3" />
                          </span>
                        )}
                        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                          <Banknote className="h-6 w-6" />
                        </span>
                        <span className="font-medium">Cash</span>
                        <span className="text-xs text-muted-foreground">Hand the money over in person</span>
                      </button>
                    )}
                    {payingMethods.includes('qr') && (
                      <button
                        type="button"
                        onClick={() => setPayMethod('qr')}
                        aria-pressed={payMethod === 'qr'}
                        className={cn(
                          'relative flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors hover:bg-muted/50',
                          payMethod === 'qr' && 'border-primary bg-primary/5 ring-1 ring-primary'
                        )}
                      >
                        {payMethod === 'qr' && (
                          <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <Check className="h-3 w-3" />
                          </span>
                        )}
                        {payingWorker?.qr_code_url ? (
                          <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-md border bg-white">
                            <img src={payingWorker.qr_code_url} alt={`${payingWorker.name}'s payment QR code`} className="h-full w-full object-contain" />
                          </span>
                        ) : (
                          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                            <QrCode className="h-6 w-6" />
                          </span>
                        )}
                        <span className="font-medium">QR Code</span>
                        <span className="text-xs text-muted-foreground">
                          {payingWorker?.qr_code_url ? 'Scan with your payment app' : 'QR image missing'}
                        </span>
                      </button>
                    )}
                  </div>

                  {payMethod === 'qr' && payingWorker?.qr_code_url && (
                    <div className="flex flex-col items-center gap-2 rounded-lg border bg-white p-3">
                      <img
                        src={payingWorker.qr_code_url}
                        alt={`${payingWorker.name}'s payment QR code`}
                        className="max-h-[220px] w-auto max-w-full object-contain"
                      />
                      <button
                        type="button"
                        onClick={() => setQrViewer({ worker: payingWorker, url: payingWorker.qr_code_url! })}
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        View full size
                      </button>
                    </div>
                  )}
                  {payMethod === 'qr' && !payingWorker?.qr_code_url && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      QR Code is enabled but the worker hasn’t uploaded their QR image yet — ask them to re-upload it in Settings.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPaying(null)} disabled={paySaving}>Cancel</Button>
            <Button onClick={confirmMarkPaid} disabled={paySaving || (payingMethods.length > 0 && !payMethod)}>
              {paySaving ? 'Saving…' : payMethod ? `Mark paid via ${methodLabel[payMethod]}` : 'Mark paid'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Full-size QR code viewer — scan to pay that worker */}
      <Dialog open={!!qrViewer} onOpenChange={(v) => { if (!v) setQrViewer(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5" />
              {qrViewer?.worker.name}'s QR code
            </DialogTitle>
            <DialogDescription>
              Scan this code with your payment app to pay {qrViewer?.worker.name}.
            </DialogDescription>
          </DialogHeader>
          {qrViewer && (
            <div className="flex flex-col items-center gap-3">
              <div className="flex w-full items-center justify-center rounded-xl border bg-white p-4">
                <img
                  src={qrViewer.url}
                  alt={`${qrViewer.worker.name}'s payment QR code`}
                  className="max-h-[320px] w-auto max-w-full object-contain"
                />
              </div>
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                {(qrViewer.worker.payment_methods ?? []).includes('cash') && (
                  <Badge variant="success" className="gap-1"><Banknote className="h-3 w-3" /> Cash</Badge>
                )}
                {(qrViewer.worker.payment_methods ?? []).includes('qr') && (
                  <Badge variant="secondary" className="gap-1"><QrCode className="h-3 w-3" /> QR Code</Badge>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
