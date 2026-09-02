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
import { Wallet, Trash2, Pencil, Banknote, QrCode, CreditCard } from 'lucide-react'
import type { Payment, PaymentStatus, Worker } from '@/lib/types'
import { money, formatMinutes, formatDate } from '@/lib/utils'
import { AvatarBubble } from '@/components/AvatarBubble'

const statusBadge: Record<PaymentStatus, 'muted' | 'success' | 'outline'> = {
  unpaid: 'muted',
  pending: 'outline',
  paid: 'success',
}

export function PaymentsPage() {
  const { payments, workers, settings, isAdmin, dataLoading, updatePaymentStatus, updatePaymentNote, deletePayment } = useStore()
  const currency = settings?.currency || 'USD'
  const [statusFilter, setStatusFilter] = useState<'all' | PaymentStatus>('all')
  const [deleting, setDeleting] = useState<Payment | null>(null)
  const [editing, setEditing] = useState<Payment | null>(null)
  const [editNote, setEditNote] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  // QR code the admin is viewing full-size from the payment-methods section.
  const [qrViewer, setQrViewer] = useState<{ worker: Worker; url: string } | null>(null)

  const workerName = (id: string) => workers.find((w) => w.id === id)?.name || 'Worker'

  // The payment methods each worker has enabled (sorted A→Z; inactive last).
  const methodWorkers = useMemo(
    () =>
      [...workers]
        .filter((w) => (w.payment_methods ?? []).length > 0 || w.status === 'active')
        .sort((a, b) =>
          a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'active' ? -1 : 1
        ),
    [workers]
  )

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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description={isAdmin ? 'Settlements from worker time, with payment status.' : 'Your payment history.'}
      />

      {/* Payment methods enabled by the workers (how they can be paid) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            {isAdmin ? 'Worker payment methods' : 'Your payment methods'}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {isAdmin
              ? 'How each worker has asked to be paid. Click a QR code to view it full-size and scan it.'
              : 'Manage how you get paid from Settings → Payment methods.'}
          </p>
        </CardHeader>
        <CardContent>
          {isAdmin ? (
            methodWorkers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No workers yet.</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {methodWorkers.map((w) => {
                  const methods = w.payment_methods ?? []
                  const acceptsCash = methods.includes('cash')
                  const acceptsQr = methods.includes('qr')
                  return (
                    <div
                      key={w.id}
                      className={`flex items-start gap-3 rounded-lg border p-3 ${w.status === 'inactive' ? 'opacity-60' : ''}`}
                    >
                      {acceptsQr && w.qr_code_url ? (
                        <button
                          type="button"
                          onClick={() => setQrViewer({ worker: w, url: w.qr_code_url! })}
                          className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-white transition-transform hover:scale-[1.03]"
                          aria-label={`View ${w.name}'s QR code`}
                          title="View QR code"
                        >
                          <img src={w.qr_code_url} alt={`${w.name}'s payment QR code`} className="h-full w-full object-contain" />
                        </button>
                      ) : (
                        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                          <AvatarBubble name={w.name} avatarUrl={w.avatar_url} size="lg" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium">{w.name}</p>
                          {w.status === 'inactive' && (
                            <Badge variant="muted" className="shrink-0 text-[10px]">Inactive</Badge>
                          )}
                        </div>
                        {methods.length === 0 ? (
                          <p className="mt-1 text-xs text-muted-foreground">No payment method set up yet.</p>
                        ) : (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {acceptsCash && (
                              <Badge variant="success" className="gap-1">
                                <Banknote className="h-3 w-3" /> Cash
                              </Badge>
                            )}
                            {acceptsQr && (
                              <Badge variant="secondary" className="gap-1">
                                <QrCode className="h-3 w-3" /> QR Code
                              </Badge>
                            )}
                          </div>
                        )}
                        {acceptsQr && !w.qr_code_url && (
                          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">QR enabled — image missing</p>
                        )}
                        {acceptsQr && w.qr_code_url && (
                          <button
                            type="button"
                            onClick={() => setQrViewer({ worker: w, url: w.qr_code_url! })}
                            className="mt-1 text-xs text-primary hover:underline"
                          >
                            View QR code
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          ) : (
            (() => {
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
            })()
          )}
        </CardContent>
      </Card>

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
                    {isAdmin && (
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          {p.status !== 'paid' && (
                            <Button variant="outline" size="sm" onClick={() => setStatus(p, 'paid')}>Mark paid</Button>
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
