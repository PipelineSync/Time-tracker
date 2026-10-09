import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CreditCard,
  Folder,
  HandCoins,
  Pencil,
  Plus,
  Receipt,
  Tag,
  RefreshCw,
  Trash2,
  Undo2,
  Wallet,
} from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useStore } from '@/lib/store'
import { PageHeader } from '@/components/PageHeader'
import { PaymentsPanel } from '@/components/PaymentsPanel'
import { ClientBadge } from '@/components/ClientBadge'
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
import { SubscriptionFormDialog, PayrollFormDialog, BillFormDialog, ExpenseFormDialog } from '@/components/FinanceFormDialogs'
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
  expenseCategoryTotals,
  expensesInMonth,
  monthLabel,
  monthShortLabel,
  monthlyFinanceSummary,
  subscriptionBillsIn,
  summarizeFinance,
} from '@/lib/finance'

const kindIcon = { subscription: CreditCard, payroll: HandCoins, bill: Receipt, expense: Receipt } as const

const expenseAccentColors = [
  'bg-violet-500',
  'bg-sky-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-indigo-500',
  'bg-orange-500',
]

function expenseAccent(category: string) {
  const hash = [...category].reduce((value, char) => value + char.charCodeAt(0), 0)
  return expenseAccentColors[hash % expenseAccentColors.length]
}

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

/** "3/6 billed" chip for subscriptions that run for a set number of bills. */
function OccurrencesChip({ item }: { item: FinanceItem }) {
  if (item.kind !== 'subscription' || item.max_occurrences == null) return null
  return (
    <Badge variant="muted" className="whitespace-nowrap text-[10px]">
      {Math.min(item.billed_count, item.max_occurrences)}/{item.max_occurrences} billed
    </Badge>
  )
}

/**
 * The Finance section — subscriptions, worker payroll, bill due dates and
 * tagged one-time expenses, plus the former standalone Payments section under Payroll.
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
  const { financeItems, workers, clients, entries, settings, can, dataLoading, updateFinanceItem, deleteFinanceItem } = useStore()
  const canManage = can('finance.manage')
  const canFinance = can('finance.view')
  const currency = settings?.currency || 'USD'

  const [params, setParams] = useSearchParams()
  const urlTab = params.get('tab')
  const [tab, setTab] = useState<'due' | 'subscriptions' | 'payroll' | 'expenses'>(
    urlTab === 'payroll' || urlTab === 'subscriptions' || urlTab === 'due' || (urlTab === 'expenses' && canFinance) ? urlTab : 'due'
  )
  function changeTab(v: 'due' | 'subscriptions' | 'payroll' | 'expenses') {
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
    if (t === 'due' || t === 'subscriptions' || t === 'payroll' || (t === 'expenses' && canFinance)) setTab(t)
  }, [params, canFinance])
  // The month the summary and every tab below it cover. It follows the calendar,
  // so a new month starts with a fresh view, until someone picks another month.
  const [pickedMonth, setPickedMonth] = useState<string | null>(null)
  const month = pickedMonth ?? currentMonthKey()
  function pickMonth(value: string) {
    setPickedMonth(!value || value === currentMonthKey() ? null : value)
  }
  const [subDialog, setSubDialog] = useState<{ open: boolean; item: FinanceItem | null }>({ open: false, item: null })
  const [payDialog, setPayDialog] = useState<{ open: boolean; item: FinanceItem | null }>({ open: false, item: null })
  const [billDialog, setBillDialog] = useState<{ open: boolean; item: FinanceItem | null }>({ open: false, item: null })
  const [expenseDialog, setExpenseDialog] = useState<{ open: boolean; item: FinanceItem | null }>({ open: false, item: null })
  const [deleting, setDeleting] = useState<FinanceItem | null>(null)

  const workerName = (id: string | null) => (id ? workers.find((w) => w.id === id)?.name || 'Former worker' : '—')

  const subscriptions = useMemo(() => financeItems.filter((f) => f.kind === 'subscription'), [financeItems])
  const payroll = useMemo(() => financeItems.filter((f) => f.kind === 'payroll'), [financeItems])
  const bills = useMemo(() => financeItems.filter((f) => f.kind === 'bill'), [financeItems])
  // Expenses for the selected month only: a month's list hides the others until
  // it is picked from the month control.
  const monthExpenses = useMemo(
    () =>
      expensesInMonth(financeItems, month).sort(
        (a, b) => b.due_date.localeCompare(a.due_date) || b.created_at.localeCompare(a.created_at)
      ),
    [financeItems, month]
  )
  const monthExpenseCategories = useMemo(() => expenseCategoryTotals(monthExpenses), [monthExpenses])
  // The four summary cards and the subscriptions list column: all for `month`.
  const monthSummary = useMemo(() => monthlyFinanceSummary(financeItems, month), [financeItems, month])
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
    let payment_method: 'cash' | 'qr' | null = null
    if (paid && item.kind === 'payroll') {
      const worker = workers.find((w) => w.id === item.worker_id)
      const options = worker?.payment_methods?.length ? worker.payment_methods.join(' / ') : 'cash / qr'
      const choice = window.prompt(`Payment method for ${worker?.name || 'this worker'} (${options}):`, worker?.payment_methods?.length === 1 ? worker.payment_methods[0] : 'cash')?.trim().toLowerCase()
      if (choice !== 'cash' && choice !== 'qr') {
        toast.error('Choose Cash or QR Code to mark payroll paid.')
        return
      }
      payment_method = choice
    }
    const res = await updateFinanceItem(item.id, { status: paid ? 'paid' : 'unpaid', payment_method })
    if (res) toast.success(paid ? `Marked paid — ${money(item.amount, currency)}.` : 'Moved back to unpaid.')
  }

  /** Subscription billed: roll the next due date forward one cycle. */
  async function recordBilling(item: FinanceItem) {
    const next = advanceCycle(item.due_date, item.cycle ?? 'monthly')
    const res = await updateFinanceItem(item.id, { due_date: next })
    if (!res) return
    // The backend counts the billing; when it was the last one on the
    // subscription's limit, it has paused itself — say so instead of
    // pointing at a next due date that will never bill.
    const final = item.max_occurrences != null && item.billed_count + 1 >= item.max_occurrences
    if (final) toast.success(`Final bill (${item.billed_count + 1} of ${item.max_occurrences}) — "${labelFor(item)}" is now paused.`)
    else toast.success(`Billed ${money(item.amount, currency)} — next due ${formatDate(next)}.`)
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
      {canFinance && tab === 'expenses' && (
        <Button size="sm" onClick={() => setExpenseDialog({ open: true, item: null })}>
          <Plus className="mr-1 h-4 w-4" /> Add expense
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
            ? 'Subscriptions, worker payroll, upcoming bills and one-time expenses for the business.'
            : "Subscriptions, worker payroll, upcoming bills and one-time expenses. You can view the ledger; only a finance manager can change it."
        }
      >
        {addButtons}
      </PageHeader>

      {/* Monthly summary: the month control drives the four cards and every tab below. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Input
            type="month"
            value={month}
            onChange={(e) => pickMonth(e.target.value)}
            className="w-40"
            aria-label="Month to summarise"
          />
          {pickedMonth !== null && (
            <Button variant="ghost" size="sm" onClick={() => setPickedMonth(null)}>
              <Undo2 className="mr-1 h-3.5 w-3.5" /> This month
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Monthly summary for <span className="font-medium text-foreground">{monthLabel(month)}</span>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Subscriptions"
          value={money(monthSummary.subscriptions, currency)}
          sub={`${monthSummary.subscriptionCount} billed in ${monthShortLabel(month)}`}
          icon={CreditCard}
          loading={loading}
        />
        <StatCard
          label="Payroll"
          value={money(monthSummary.payroll, currency)}
          sub={`${monthSummary.payrollCount} run${monthSummary.payrollCount === 1 ? '' : 's'}${
            monthSummary.payrollUnpaidCount > 0 ? ` · ${monthSummary.payrollUnpaidCount} unpaid` : ''
          }`}
          icon={HandCoins}
          loading={loading}
        />
        <StatCard
          label="One-Time Expenses"
          value={money(monthSummary.expenses, currency)}
          sub={`${monthSummary.expenseCount} recorded in ${monthShortLabel(month)}`}
          icon={Receipt}
          loading={loading}
        />
        <StatCard
          label="Total Monthly Expenses"
          value={money(monthSummary.total, currency)}
          sub={`Subscriptions, payroll and expenses for ${monthShortLabel(month)}`}
          icon={Wallet}
          loading={loading}
        />
      </div>

      <Tabs value={tab} onValueChange={(v) => changeTab(v as 'due' | 'subscriptions' | 'payroll' | 'expenses')}>
        <TabsList>
          <TabsTrigger value="due">Due dates</TabsTrigger>
          {can('finance.subscription') && (
            <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
          )}
          {can('finance.payroll') && (
            <TabsTrigger value="payroll">Payroll</TabsTrigger>
          )}
          {canFinance && <TabsTrigger value="expenses">One Time Expenses</TabsTrigger>}
        </TabsList>

        {/* ---------------- Due dates ---------------- */}
        <TabsContent value="due" className="mt-4 space-y-4">
          {/* Due dates cover every open line, whatever month they fall in. */}
          <p className="text-sm text-muted-foreground">
            <span className={cn(summary.overdueCount > 0 && 'font-medium text-destructive')}>
              Overdue: {money(summary.overdueAmount, currency)} across {summary.overdueCount} line{summary.overdueCount === 1 ? '' : 's'}
            </span>
            {' · '}
            Due in the next 30 days: <span className="font-medium text-foreground">{money(summary.next30Amount, currency)}</span> across{' '}
            {summary.next30Count} line{summary.next30Count === 1 ? '' : 's'}
          </p>
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
                          <div className="flex items-center gap-1.5">
                            <p className="font-medium">{labelFor(item)}</p>
                            <OccurrencesChip item={item} />
                          </div>
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
                      <th className="px-3 py-2 font-medium" title={`Billed in ${monthLabel(month)}`}>
                        Billed {monthShortLabel(month)}
                      </th>
                      <th className="px-3 py-2 font-medium">Next due</th>
                      <th className="px-3 py-2 font-medium">Active</th>
                      {canManage && <th className="px-3 py-2 text-right font-medium">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {[...subscriptions].sort((a, b) => a.due_date.localeCompare(b.due_date)).map((item) => (
                      <tr key={item.id} className={cn('hover:bg-muted/40', item.status === 'active' && daysUntil(item.due_date) < 0 && 'bg-destructive/5')}>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1.5">
                            <p className="font-medium">{item.name}</p>
                            <OccurrencesChip item={item} />
                          </div>
                          {item.note && <p className="max-w-[240px] truncate text-xs text-muted-foreground" title={item.note}>{item.note}</p>}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          <span className="font-semibold">{money(item.amount, currency)}</span>
                          <span className="text-xs text-muted-foreground"> / {item.cycle === 'yearly' ? 'yr' : 'mo'}</span>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          {subscriptionBillsIn(item, month) ? (
                            <span className="font-semibold">{money(item.amount, currency)}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">not this month</span>
                          )}
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
                      <th className="px-3 py-2 font-medium">Paid via</th>
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
                        <td className="px-3 py-3 text-sm">{item.status === 'paid' && item.payment_method ? (item.payment_method === 'qr' ? 'QR Code' : 'Cash') : <span className="text-muted-foreground">—</span>}</td>
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
        {canFinance && (
          <TabsContent value="expenses" className="mt-4 space-y-4">
            {loading ? (
              <div className="grid gap-4 lg:grid-cols-3">
                <Skeleton className="h-64" />
                <Skeleton className="h-64 lg:col-span-2" />
              </div>
            ) : (
              <div className="grid items-start gap-4 lg:grid-cols-3">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Tag className="h-4 w-4" /> Expense categories
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">Spend recorded in {monthLabel(month)}</p>
                  </CardHeader>
                  <CardContent>
                    {monthExpenseCategories.length === 0 ? (
                      <p className="py-5 text-center text-sm text-muted-foreground">Categories will appear here when you log an expense.</p>
                    ) : (
                      <div className="space-y-4">
                        {monthExpenseCategories.map((row) => {
                          const share = monthSummary.expenses > 0 ? Math.round((row.amount / monthSummary.expenses) * 100) : 0
                          const accent = expenseAccent(row.category)
                          return (
                            <div key={row.category} className="space-y-1.5">
                              <div className="flex items-center justify-between gap-3 text-sm">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', accent)} aria-hidden />
                                  <span className="truncate font-medium">{row.category}</span>
                                  <span className="shrink-0 text-xs text-muted-foreground">{row.count}</span>
                                </div>
                                <span className="shrink-0 text-right font-semibold">{money(row.amount, currency)}</span>
                              </div>
                              <div
                                className="h-1.5 overflow-hidden rounded-full bg-muted"
                                role="progressbar"
                                aria-label={`${row.category}: ${share}% of expenses`}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={share}
                              >
                                <div className={cn('h-full rounded-full transition-all', accent)} style={{ width: `${share}%` }} />
                              </div>
                            </div>
                          )
                        })}
                        <div className="border-t pt-3 text-sm">
                          <div className="flex items-center justify-between font-semibold">
                            <span>Total for the month</span>
                            <span>{money(monthSummary.expenses, currency)}</span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{monthExpenses.length} expense{monthExpenses.length === 1 ? '' : 's'}</p>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="lg:col-span-2">
                  <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                    <div className="space-y-1.5">
                      <CardTitle className="text-base">Expenses</CardTitle>
                      <p className="text-xs text-muted-foreground">Newest first · {monthExpenses.length} recorded in {monthLabel(month)}</p>
                    </div>
                  </CardHeader>
                  <CardContent className="overflow-x-auto">
                    {monthExpenses.length === 0 ? (
                      <EmptyState
                        icon={Receipt}
                        title={`No expenses in ${monthLabel(month)}`}
                        description="Log one-time purchases to see spending by category and client or project. Pick another month above to see earlier spend."
                        action={canManage ? <Button size="sm" onClick={() => setExpenseDialog({ open: true, item: null })}><Plus className="mr-1 h-4 w-4" /> Add expense</Button> : undefined}
                      />
                    ) : (
                      <table className="w-full text-sm">
                        <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 font-medium">Date</th>
                            <th className="px-3 py-2 font-medium">Expense</th>
                            <th className="px-3 py-2 font-medium">Category</th>
                            <th className="px-3 py-2 font-medium">Client / project</th>
                            <th className="px-3 py-2 text-right font-medium">Amount</th>
                            {canManage && <th className="px-3 py-2 text-right font-medium">Actions</th>}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {monthExpenses.map((item) => {
                            const client = item.client_id ? clients.find((candidate) => candidate.id === item.client_id) : null
                            return (
                              <tr key={item.id} className="hover:bg-muted/40">
                                <td className="whitespace-nowrap px-3 py-3 align-top text-muted-foreground">{formatDate(item.due_date)}</td>
                                <td className="max-w-[220px] px-3 py-3 align-top">
                                  <p className="truncate font-medium" title={item.name || 'Untitled expense'}>{item.name || 'Untitled expense'}</p>
                                  {item.note && <p className="truncate text-xs text-muted-foreground" title={item.note}>{item.note}</p>}
                                </td>
                                <td className="px-3 py-3 align-top"><Badge variant="secondary" className="whitespace-nowrap">{item.expense_category || 'Other'}</Badge></td>
                                <td className="px-3 py-3 align-top">
                                  {client ? (
                                    <ClientBadge client={client} />
                                  ) : item.project_name ? (
                                    <Badge variant="outline" className="max-w-[180px] gap-1 whitespace-nowrap">
                                      <Folder className="h-3 w-3 shrink-0" />
                                      <span className="truncate">{item.project_name}</span>
                                    </Badge>
                                  ) : (
                                    <span className="text-muted-foreground">General</span>
                                  )}
                                </td>
                                <td className="whitespace-nowrap px-3 py-3 text-right align-top font-semibold">{money(item.amount, currency)}</td>
                                {canManage && (
                                  <td className="px-3 py-2 align-top">
                                    <div className="flex justify-end gap-1">
                                      <RowActions item={item} onEdit={openEditor} onDelete={() => setDeleting(item)} />
                                    </div>
                                  </td>
                                )}
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>
        )}
      </Tabs>

      {/* Dialogs */}
      <SubscriptionFormDialog open={subDialog.open} onOpenChange={(v) => setSubDialog((s) => ({ ...s, open: v }))} item={subDialog.item} />
      <PayrollFormDialog open={payDialog.open} onOpenChange={(v) => setPayDialog((s) => ({ ...s, open: v }))} item={payDialog.item} defaultMonth={month} />
      <BillFormDialog open={billDialog.open} onOpenChange={(v) => setBillDialog((s) => ({ ...s, open: v }))} item={billDialog.item} />
      <ExpenseFormDialog open={expenseDialog.open} onOpenChange={(v) => setExpenseDialog((s) => ({ ...s, open: v }))} item={expenseDialog.item} />

      {deleting && (
        <ConfirmDialog
          open={!!deleting}
          onOpenChange={(v) => { if (!v) setDeleting(null) }}
          title={deleting.kind === 'expense' ? 'Delete expense?' : 'Delete finance line?'}
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
    else if (item.kind === 'expense') setExpenseDialog({ open: true, item })
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
