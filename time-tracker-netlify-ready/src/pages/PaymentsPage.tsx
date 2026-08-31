import { useMemo } from 'react'
import { useStore } from '@/lib/store'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/EmptyState'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useState } from 'react'
import { toast } from 'sonner'
import { Wallet, Trash2 } from 'lucide-react'
import type { Payment, PaymentStatus } from '@/lib/types'
import { money, formatMinutes, formatDate } from '@/lib/utils'

const statusBadge: Record<PaymentStatus, 'muted' | 'success' | 'outline'> = {
  unpaid: 'muted',
  pending: 'outline',
  paid: 'success',
}

export function PaymentsPage() {
  const { payments, workers, settings, isAdmin, dataLoading, updatePaymentStatus, deletePayment } = useStore()
  const currency = settings?.currency || 'USD'
  const [statusFilter, setStatusFilter] = useState<'all' | PaymentStatus>('all')
  const [deleting, setDeleting] = useState<Payment | null>(null)

  const workerName = (id: string) => workers.find((w) => w.id === id)?.name || 'Worker'

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
          description={isAdmin ? 'Reset a worker’s time & earnings to create an unpaid payment.' : 'You don’t have any payments yet.'}
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
    </div>
  )
}
