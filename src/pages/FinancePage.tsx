import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CreditCard,
  HandCoins,
  Pencil,
  Plus,
  Receipt,
  RefreshCw,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useStore } from '@/lib/store'
import { PageHeader } from '@/components/PageHeader'
import { PaymentsPanel } from '@/components/PaymentsPanel'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/EmptyState'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatCard } from '@/components/StatCard'
import { SubscriptionFormDialog, PayrollFormDialog, BillFormDialog } from '@/components/FinanceFormDialogs'
import { toast } from 'sonner'
import type { FinanceItem } from '@/lib/types'
import { FinanceKindNames } from '@/lib/types'
import { cn, money, formatDate } from '@/lib/utils'
import {
  advanceCycle,
  buildDueRows,
  currentMonthKey,
  daysUntil,
  dueLabel,
  earningsByWorkerAndMonth,
  monthLabel,
  summarizeFinance,
} from '@/lib/finance'

const kindIcon = { subscription: CreditCard, payroll: HandCoins, bill: Receipt } as const

function KindBadge({ kind }: { kind: FinanceItem['kind'] }) {
  const Icon = kindIcon[kind]
  return (
    <Badge variant={kind === 'subscription' ? 'secondary' : kind === 'payroll' ? 'outline' : 'muted'} className="gap-1 whitespace-nowrap">
      <Icon className="h-3 w-3" />
      {FinanceKindNames[kind]}
    </Badge>
  )
}

/** "Due in 3 days" / "2 days overdue" chip. Red past the date, amber soon. */
function DueChip({ dueDate }: { dueDate: string }) {
  const days = daysUntil(dueDate)
  const overdue = days < 0
  const soon = days >= 0 && days <= 3
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium',
        overdue ? 'text-destructive' : soon ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
      )}
    >
      {overdue && <AlertTriangle className="h-3.5 w-3.5" />}
      {dueLabel(days)}
    </span>
  )
}

function FinanceStatusLabel({ item }: { item: FinanceItem }) {
  if (item.kind === 'subscription') {
    return item.status === 'paused' ? <Badge variant="muted">Paused</Badge> : <Badge variant="outline">Active</Badge>
  }
  return item.status === 'paid' ? (
    <Badge variant="success" className="gap-1"><Check className="h-3 w-3" /> Paid</Badge>
  ) : (
    <Badge variant="muted">Unpaid</Badge>
  )
}

/**
 * The Finance section — subscriptions, worker payroll and bill due dates,
 * plus the former standalone Payments section, now under the Payroll tab.
 *
 * Admin-only content unless the admin grants a worker `finance.view` (Workers
 * → Access → Finance); `finance.manage` additionally opens the edit controls.
 * A viewer without manage gets the same screens with every write action
 * hidden — the backends and the database policies refuse the writes anyway.
 * Anyone the admin has NOT granted Finance access still lands here on the
 * Payroll tab, showing only their own payment history (the nav labels that
 * entry "Payroll" instead of "Finance").
 */
export function FinancePage() {
  const { financeItems, workers, entries, settings, can, dataLoading, updateFinanceItem, deleteFinanceItem } = useStore()
  const canManage = can('finance.manage')
  const canFinance = can('finance.view')
  const currency = settings?.currency || 'USD'

  const [params, setParams] = useSearchParams()
  const urlTab = params.get('tab')
  const [tab, setTab] = useState<'due' | 'subscriptions' | 'payroll'>(
    urlTab === 'payroll' || urlTab === 'subscriptions' || urlTab === 'due' ? urlTab : 'due'
  )
  function changeTab(v: 'due' | 'subscriptions' | 'payroll') {
    setTab(v)
    // Keep the URL honest so the Payroll deep link (nav, PWA, /payments
    // redirect) and the visible tab agree after a reload or a share.
    const next = new URLSearchParams(params)
    next.set('tab', v)
    setParams(next, { replace: true })
  }
  // Follow navigations that happen outside the tab strip (nav link, redirect).
  useEffect(() => {
    const t = params.get('tab')
    if (t === 'due' || t === 'subscriptions' || t === 'payroll') setTab(t)
  }, [params])
  const [month, setMonth] = useState(currentMonthKey())
  const [subDialog, setSubDialog] = useState<{ open: boolean; item: FinanceItem | null }>({ open: false, item: null })
  const [payDialog, setPayDialog] = useState<{ open: boolean; item: FinanceItem | null }>({ open: false, item: null })
  const [billDialog, setBillDialog] = useState<{ open: boolean; item: FinanceItem | null }>({ open: false, item: null })
  const [deleting, setDeleting] = useState<FinanceItem | null>(null)

  const workerName = (id: string | null) => (id ? workers.find((w) => w.id === id)?.name || 'Former worker' : '—')

  const subscriptions = useMemo(() => financeItems.filter((f) => f.kind === 'subscription'), [financeItems])
  const payroll = useMemo(() => financeItems.filter((f) => f.kind === 'payroll'), [financeItems])
  const bills = useMemo(() => financeItems.filter((f) => f.kind === 'bill'), [financeItems])
  const dueRows = useMemo(() => buildDueRows(financeItems), [financeItems])
  const summary = useMemo(() => summarizeFinance(financeItems), [financeItems])

  const monthPayroll = useMemo(
    () => payroll.filter((f) => f.period_month === month).sort((a, b) => a.due_date.localeCompare(b.due_date)),
    [payroll, month]
  )
  const monthPayrollTotal = monthPayroll.reduce((s, f) => s + f.amount, 0)

  // What the team's tracked time earned that month — the reference the
  // payroll runs are set against. Only when the viewer can see everyone's
  // entries; a partial number would be misleading.
  const trackedEarningsTotal = useMemo(() => {
    if (!can('entries.view_all')) return null
    const map = earningsByWorkerAndMonth(entries)
    let total = 0
    for (const w of workers) total += map.get(`${month}|${w.id}`) || 0
    return Math.round(total * 100) / 100
  }, [can, entries, workers, month])

  const labelFor = (f: FinanceItem) =>
    f.kind === 'payroll'
      ? `${workerName(f.worker_id)} · ${f.period_month ? monthLabel(f.period_month) : 'pay'}`
      : f.name || 'Untitled'

  async function markPaid(item: FinanceItem, paid: boolean) {
    const res = await updateFinanceItem(item.id, { status: paid ? 'paid' : 'unpaid' })
    if (res) toast.success(paid ? `Marked paid — ${money(item.amount, currency)}.` : 'Moved back to unpaid.')
  }

  /** Subscription billed: roll the next due date forward one cycle. */
  async function recordBilling(item: FinanceItem) {
    const next = advanceCycle(item.due_date, item.cycle ?? 'monthly')
    const res = await updateFinanceItem(item.id, { due_date: next })
    if (res) toast.success(`Billed ${money(item.amount, currency)} — next due ${formatDate(next)}.`)
  }

  const loading = dataLoading && financeItems.length === 0
  const ledgerEmpty = financeItems.length === 0

  // No Finance access at all: this is the worker's "Payroll" screen — their
  // own payments only. The ledger tabs, the summary and other workers' rows
  // simply do not render (and the backends never send them anyway).
  if (!canFinance && !can('finance.subscription') && !can('finance.payroll')) {
    return (
      <div className="space-y-6">
        <PageHeader title="Payroll" description="Your payment history and how you get paid." />
        <PaymentsPanel />
      </div>
    )
  }

  const addButtons = canManage && (
    <>
      {can('finance.subscription') && tab === 'subscriptions' && (
        <Button size="sm" onClick={() => setSubDialog({ open: true, item: null })}>
          <Plus className="mr-1 h-4 w-4" /> Add subscription
        </Button>
      )}
      {can('finance.payroll') && tab === 'payroll' && (
        <Button size="sm" onClick={() => setPayDialog({ open: true, item: null })}>
          <Plus className="mr-1 h-4 w-4" /> Add payroll run
        </Button>
      )}
      {tab === 'due' && (
        <>
          {can('finance.subscription') && (
            <Button size="sm" variant="outline" onClick={() => setSubDialog({ open: true, item: null })}>
              <Plus className="mr-1 h-4 w-4" /> Subscription
            </Button>
          )}
          {can('finance.payroll') && (
            <Button size="sm" variant="outline" onClick={() => setPayDialog({ open: true, item: null })}>
              <Plus className="mr-1 h-4 w-4" /> Payroll
            </Button>
          )}
          {(!can('finance.subscription') && !can('finance.payroll')) && (
            <>
              <Button size="sm" variant="outline" onClick={() => setSubDialog({ open: true, item: null })}>
                <Plus className="mr-1 h-4 w-4" /> Subscription
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPayDialog({ open: true, item: null })}>
                <Plus className="mr-1 h-4 w-4" /> Payroll
              </Button>
            </>)}
          <Button size="sm" onClick={() => setBillDialog({ open: true, item: null })}>
            <Plus className="mr-1 h-4 w-4" /> Bill
          </Button>
        </>
      )}
    </>
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finance"
        description={
          canManage
            ? 'Subscriptions, worker payroll, due dates and settlements for the business.'
            : "Subscriptions, worker payroll, due dates and settlements. You can view the ledger; only the admin can change it."
        }
      >
        {addButtons}
      </PageHeader>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Subscriptions / month"
          value={money(summary.subsMonthly, currency)}
          sub={`${subscriptions.filter((s) => s.status === 'active').length} active`}
          icon={CreditCard}
          loading={loading}
        />
        <StatCard
          label="Payroll unpaid"
          value={money(summary.owedPayroll, currency)}
          sub={payroll.filter((p) => p.status !== 'paid').length + ' open run' + (payroll.filter((p) => p.status !== 'paid').length === 1 ? '' : 's')}
          icon={HandCoins}
          loading={loading}
        />
        <StatCard
          label="Due next 30 days"
          value={money(summary.next30Amount, currency)}
          sub={`${summary.next30Count} line${summary.next30Count === 1 ? '' : 's'}`}
          icon={CalendarClock}
          loading={loading}
        />
        <StatCard
          label="Overdue"
          value={money(summary.overdueAmount, currency)}
          sub={`${summary.overdueCount} line${summary.overdueCount === 1 ? '' : 's'}`}
          icon={AlertTriangle}
          loading={loading}
          className={cn(summary.overdueCount > 0 && 'border-destructive/40')}
        />
      </div>

      <Tabs value={tab} onValueChange={(v) => changeTab(v as 'due' | 'subscriptions' | 'payroll')}>
        <TabsList>
          <TabsTrigger value="due">Due dates</TabsTrigger>
          {can('finance.subscription') && (
            <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
          )}
          {can('finance.payroll') && (
            <TabsTrigger value="payroll">Payroll</TabsTrigger>
          )}
        </TabsList>

        {/* ---------------- Due dates ---------------- */}
        <TabsContent value="due" className="mt-4 space-y-4">
          {loading ? (
            <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
          ) : dueRows.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title={ledgerEmpty ? 'Nothing on the ledger yet' : 'Nothing due'}
              description={
                ledgerEmpty
                  ? 'Add subscriptions, payroll runs and bills to see their due dates here.'
                  : 'Every subscription is billed ahead and every bill and payroll run is settled. Enjoy the quiet.'
              }
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <CalendarClock className="h-4 w-4" /> Agenda
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Due</th>
                      <th className="px-3 py-2 font-medium">Line</th>
                      <th className="px-3 py-2 font-medium">Type</th>
                      <th className="px-3 py-2 font-medium">Amount</th>
                      {canManage && <th className="px-3 py-2 text-right font-medium">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {dueRows.map(({ item }) => (
                      <tr key={item.id} className={cn('hover:bg-muted/40', daysUntil(item.due_date) < 0 && 'bg-destructive/5')}>
                        <td className="px-3 py-3 align-top">
                          <p className="whitespace-nowrap font-medium">{formatDate(item.due_date)}</p>
                          <DueChip dueDate={item.due_date} />
                        </td>
                        <td className="px-3 py-3 align-top">
                          <p className="font-medium">{labelFor(item)}</p>
                          {item.note && <p className="max-w-[240px] truncate text-xs text-muted-foreground" title={item.note}>{item.note}</p>}
                        </td>
                        <td className="px-3 py-3 align-top"><KindBadge kind={item.kind} /></td>
                        <td className="px-3 py-3 align-top font-semibold whitespace-nowrap">{money(item.amount, currency)}</td>
                        {canManage && (
                          <td className="px-3 py-3 align-top">
                            <div className="flex items-center justify-end gap-1.5">
                              {item.kind === 'subscription' ? (
                                <Button variant="outline" size="sm" onClick={() => recordBilling(item)} title="Record this month's billing and roll to the next cycle">
                                  <RefreshCw className="mr-1 h-3.5 w-3.5" /> Billed
                                </Button>
                              ) : (
                                <Button variant="outline" size="sm" onClick={() => markPaid(item, true)}>
                                  <Check className="mr-1 h-3.5 w-3.5" /> Mark paid
                                </Button>
                              )}
                              <RowActions item={item} onEdit={openEditor} onDelete={() => setDeleting(item)} />
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
        </TabsContent>

        {/* ---------------- Subscriptions ---------------- */}
        <TabsContent value="subscriptions" className="mt-4">
          {loading ? (
            <Skeleton className="h-32" />
          ) : subscriptions.length === 0 ? (
            <EmptyState
              icon={CreditCard}
              title="No subscriptions"
              description={canManage ? 'Track the software and services the business pays for on a cycle.' : 'Nothing to show yet.'}
              action={canManage ? <Button size="sm" onClick={() => setSubDialog({ open: true, item: null })}><Plus className="mr-1 h-4 w-4" /> Add subscription</Button> : undefined}
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <CreditCard className="h-4 w-4" /> Subscriptions
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Name</th>
                      <th className="px-3 py-2 font-medium">Amount</th>
                      <th className="px-3 py-2 font-medium">Next due</th>
                      <th className="px-3 py-2 font-medium">Active</th>
                      {canManage && <th className="px-3 py-2 text-right font-medium">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {[...subscriptions].sort((a, b) => a.due_date.localeCompare(b.due_date)).map((item) => (
                      <tr key={item.id} className={cn('hover:bg-muted/40', item.status === 'active' && daysUntil(item.due_date) < 0 && 'bg-destructive/5')}>
                        <td className="px-3 py-3">
                          <p className="font-medium">{item.name}</p>
                          {item.note && <p className="max-w-[240px] truncate text-xs text-muted-foreground" title={item.note}>{item.note}</p>}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          <span className="font-semibold">{money(item.amount, currency)}</span>
                          <span className="text-xs text-muted-foreground"> / {item.cycle === 'yearly' ? 'yr' : 'mo'}</span>
                        </td>
                        <td className="px-3 py-3">
                          <p className="whitespace-nowrap">{formatDate(item.due_date)}</p>
                          {item.status === 'active' ? <DueChip dueDate={item.due_date} /> : <span className="text-xs text-muted-foreground">paused</span>}
                        </td>
                        <td className="px-3 py-3">
                          {canManage ? (
                            <Switch
                              checked={item.status === 'active'}
                              aria-label={`${item.status === 'active' ? 'Pause' : 'Resume'} ${item.name}`}
                              onCheckedChange={(on) => void updateFinanceItem(item.id, { status: on ? 'active' : 'paused' })}
                            />
                          ) : (
                            <FinanceStatusLabel item={item} />
                          )}
                        </td>
                        {canManage && (
                          <td className="px-3 py-3">
                            <div className="flex items-center justify-end gap-1.5">
                              <Button variant="ghost" size="sm" onClick={() => recordBilling(item)} title="Record this month's billing and roll to the next cycle">
                                <RefreshCw className="mr-1 h-3.5 w-3.5" /> Billed
                              </Button>
                              <RowActions item={item} onEdit={openEditor} onDelete={() => setDeleting(item)} />
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
        </TabsContent>

        {/* ---------------- Payroll ---------------- */}
        <TabsContent value="payroll" className="mt-4 space-y-4">
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-2">
                <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-40" aria-label="Payroll month" />
                {month !== currentMonthKey() && (
                  <Button variant="ghost" size="sm" onClick={() => setMonth(currentMonthKey())}>
                    <Undo2 className="mr-1 h-3.5 w-3.5" /> This month
                  </Button>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {monthLabel(month)} — <span className="font-semibold text-foreground">{money(monthPayrollTotal, currency)}</span> payroll
                {monthPayroll.filter((p) => p.status !== 'paid').length > 0 && (
                  <> · <span className="text-amber-600 dark:text-amber-400">{monthPayroll.filter((p) => p.status !== 'paid').length} unpaid</span></>
                )}
                {trackedEarningsTotal !== null && (
                  <> · {money(trackedEarningsTotal, currency)} earned from tracked time</>
                )}
              </p>
            </CardContent>
          </Card>

          {loading ? (
            <Skeleton className="h-32" />
          ) : monthPayroll.length === 0 ? (
            <EmptyState
              icon={HandCoins}
              title={`No payroll for ${monthLabel(month)}`}
              description={
                canManage
                  ? 'Add a run per worker for the month. The amount is pre-filled from what their tracked time earned.'
                  : 'The admin has not logged any payroll for this month yet.'
              }
              action={canManage ? <Button size="sm" onClick={() => setPayDialog({ open: true, item: null })}><Plus className="mr-1 h-4 w-4" /> Add payroll run</Button> : undefined}
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <HandCoins className="h-4 w-4" /> Payroll — {monthLabel(month)}
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Worker</th>
                      <th className="px-3 py-2 font-medium">Amount</th>
                      <th className="px-3 py-2 font-medium">Pay day</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      {canManage && <th className="px-3 py-2 text-right font-medium">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {monthPayroll.map((item) => (
                      <tr key={item.id} className={cn('hover:bg-muted/40', item.status !== 'paid' && daysUntil(item.due_date) < 0 && 'bg-destructive/5')}>
                        <td className="px-3 py-3 font-medium">{workerName(item.worker_id)}</td>
                        <td className="px-3 py-3 font-semibold whitespace-nowrap">{money(item.amount, currency)}</td>
                        <td className="px-3 py-3">
                          <p className="whitespace-nowrap">{formatDate(item.due_date)}</p>
                          {item.status !== 'paid' ? <DueChip dueDate={item.due_date} /> : (
                            <span className="text-xs text-muted-foreground">{item.paid_at ? `paid ${formatDate(item.paid_at)}` : 'paid'}</span>
                          )}
                        </td>
                        <td className="px-3 py-3"><FinanceStatusLabel item={item} /></td>
                        {canManage && (
                          <td className="px-3 py-3">
                            <div className="flex items-center justify-end gap-1.5">
                              {item.status !== 'paid' ? (
                                <Button variant="outline" size="sm" onClick={() => markPaid(item, true)}>
                                  <Check className="mr-1 h-3.5 w-3.5" /> Mark paid
                                </Button>
                              ) : (
                                <Button variant="ghost" size="sm" onClick={() => markPaid(item, false)}>
                                  <Undo2 className="mr-1 h-3.5 w-3.5" /> Unpay
                                </Button>
                              )}
                              <RowActions item={item} onEdit={openEditor} onDelete={() => setDeleting(item)} />
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

          {/* Bills live on the due-date agenda; give the tab set a home too. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Receipt className="h-4 w-4" /> Bills &amp; one-off due dates
                {canManage && (
                  <Button size="sm" variant="outline" className="ml-auto" onClick={() => setBillDialog({ open: true, item: null })}>
                    <Plus className="mr-1 h-3.5 w-3.5" /> Add bill
                  </Button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {bills.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No bills logged. Add rent, tax or invoice deadlines to track them here.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Bill</th>
                      <th className="px-3 py-2 font-medium">Amount</th>
                      <th className="px-3 py-2 font-medium">Due</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      {canManage && <th className="px-3 py-2 text-right font-medium">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {[...bills].sort((a, b) => (a.status === 'paid' ? 1 : 0) - (b.status === 'paid' ? 1 : 0) || a.due_date.localeCompare(b.due_date)).map((item) => (
                      <tr key={item.id} className={cn('hover:bg-muted/40', item.status !== 'paid' && daysUntil(item.due_date) < 0 && 'bg-destructive/5')}>
                        <td className="px-3 py-3 font-medium">{item.name}</td>
                        <td className="px-3 py-3 font-semibold whitespace-nowrap">{money(item.amount, currency)}</td>
                        <td className="px-3 py-3">
                          <p className="whitespace-nowrap">{formatDate(item.due_date)}</p>
                          {item.status !== 'paid' ? <DueChip dueDate={item.due_date} /> : (
                            <span className="text-xs text-muted-foreground">{item.paid_at ? `paid ${formatDate(item.paid_at)}` : 'paid'}</span>
                          )}
                        </td>
                        <td className="px-3 py-3"><FinanceStatusLabel item={item} /></td>
                        {canManage && (
                          <td className="px-3 py-3">
                            <div className="flex items-center justify-end gap-1.5">
                              {item.status !== 'paid' ? (
                                <Button variant="outline" size="sm" onClick={() => markPaid(item, true)}>
                                  <Check className="mr-1 h-3.5 w-3.5" /> Mark paid
                                </Button>
                              ) : (
                                <Button variant="ghost" size="sm" onClick={() => markPaid(item, false)}>
                                  <Undo2 className="mr-1 h-3.5 w-3.5" /> Unpay
                                </Button>
                              )}
                              <RowActions item={item} onEdit={openEditor} onDelete={() => setDeleting(item)} />
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
          {/* The former standalone Payments section, moved under Payroll:
              settlements from tracked time, mark-paid (cash/QR), notes. */}
          <div className="border-t pt-6">
            <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
              <HandCoins className="h-4 w-4 text-muted-foreground" />
              Payments &amp; settlements
              <span className="text-sm font-normal text-muted-foreground">
                — settled from tracked time, paid out separately from the payroll runs above
              </span>
            </h2>
            <PaymentsPanel />
          </div>
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <SubscriptionFormDialog open={subDialog.open} onOpenChange={(v) => setSubDialog((s) => ({ ...s, open: v }))} item={subDialog.item} />
      <PayrollFormDialog open={payDialog.open} onOpenChange={(v) => setPayDialog((s) => ({ ...s, open: v }))} item={payDialog.item} defaultMonth={month} />
      <BillFormDialog open={billDialog.open} onOpenChange={(v) => setBillDialog((s) => ({ ...s, open: v }))} item={billDialog.item} />

      {deleting && (
        <ConfirmDialog
          open={!!deleting}
          onOpenChange={(v) => { if (!v) setDeleting(null) }}
          title="Delete finance line?"
          description={`Remove "${labelFor(deleting)}" (${money(deleting.amount, currency)}) from the ledger? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            const done = await deleteFinanceItem(deleting.id)
            if (done) toast.success('Finance line deleted.')
          }}
        />
      )}
    </div>
  )

  function openEditor(item: FinanceItem) {
    if (item.kind === 'subscription') setSubDialog({ open: true, item })
    else if (item.kind === 'payroll') setPayDialog({ open: true, item })
    else setBillDialog({ open: true, item })
  }

  function RowActions({ item, onEdit, onDelete }: { item: FinanceItem; onEdit: (i: FinanceItem) => void; onDelete: () => void }) {
    return (
      <>
        <Button variant="ghost" size="iconSm" aria-label="Edit" onClick={() => onEdit(item)}>
          <Pencil className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="iconSm" className="text-destructive" aria-label="Delete" onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </>
    )
  }
}
