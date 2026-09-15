import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowDownLeft, ArrowLeft, ArrowLeftRight, ArrowUpRight, Building2, Check, Download, LayoutDashboard, List, Plus, RefreshCw, Settings, Trash2, WalletCards } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { NotificationsBell } from '@/components/NotificationsBell'
import { cn } from '@/lib/utils'
import { accountBalance, buildInstallments, currentPeriod, daysDifference, deleteRecurringPayment, emptyPFData, formatShortDate, getOverdueRecurringPayments, getScheduledPayments, loadPersonalFinance, money, normalizePFData, pfId, savePersonalFinance, scheduledPaymentLabel, today, type PFData, type PFAccount, type PFOverduePayment, type PFScheduledPayment } from '@/lib/personalFinance'

type View = 'dashboard' | 'accounts' | 'activity' | 'recurring' | 'reports' | 'settings'
type EntryKind = 'income' | 'expense' | 'transfer'
const monthStart = () => `${currentPeriod()}-01`
const NAV: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Overview', icon: LayoutDashboard }, { id: 'accounts', label: 'Accounts', icon: WalletCards },
  { id: 'activity', label: 'Transactions', icon: List }, { id: 'recurring', label: 'Recurring', icon: RefreshCw },
  { id: 'reports', label: 'Reports', icon: Building2 }, { id: 'settings', label: 'Manage lists', icon: Settings },
]

export function PersonalFinancePage() {
  const { user, workers, settings, checkOverdueRecurring } = useStore()
  const navigate = useNavigate()
  // The personal tracker follows the workspace currency when one is set, and
  // defaults to PHP (the tracker was built for PHP) otherwise.
  const currency = settings?.currency || 'PHP'
  const m = (n: number) => money(n, currency)
  const [data, setData] = useState<PFData>(emptyPFData())
  const [ready, setReady] = useState(false)
  const [stale, setStale] = useState(false)
  const [view, setView] = useState<View>('dashboard')
  const [entry, setEntry] = useState<EntryKind | null>(null)
  const [accountOpen, setAccountOpen] = useState(false)
  const [recurringOpen, setRecurringOpen] = useState(false)
  const [recurringDetails, setRecurringDetails] = useState<PFData['recurring'][number] | null>(null)
  const [editAccount, setEditAccount] = useState<PFAccount | null>(null)
  const [reconcileAccount, setReconcileAccount] = useState<PFAccount | null>(null)
  const [deleteTx, setDeleteTx] = useState<{ type: 'income' | 'expense' | 'transfer'; id: string } | null>(null)
  const [deleteRecurring, setDeleteRecurring] = useState<PFData['recurring'][number] | null>(null)
  const [payRecurring, setPayRecurring] = useState<{
    r: PFData['recurring'][number]
    i?: { id: string; dueDate: string; number: number }
    overduePayment?: PFOverduePayment
  } | null>(null)
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [scheduleBill, setScheduleBill] = useState('all')
  const [showPaidRows, setShowPaidRows] = useState(true)
  const [accountFilter, setAccountFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [kindFilter, setKindFilter] = useState('all')
  const [paidFilter, setPaidFilter] = useState('all')

  useEffect(() => {
    if (!user) return
    setReady(false)
    loadPersonalFinance(user.id)
      .then(res => {
        setData(res.data)
        setStale(res.stale)
        void checkOverdueRecurring?.()
      })
      .catch(e => toast.error(e instanceof Error ? e.message : 'Could not load your personal tracker.'))
      .finally(() => setReady(true))
  }, [user, checkOverdueRecurring])
  const commit = async (next: PFData) => {
    const normalized = normalizePFData(next)
    setData(normalized)
    if (!user) return
    try {
      await savePersonalFinance(user.id, normalized)
      void checkOverdueRecurring?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    }
  }
  const workerName = user?.workerId ? workers.find(w => w.id === user?.workerId)?.name : null
  const displayName = workerName || user?.email.split('@')[0] || 'My'
  const activeAccounts = data.accounts.filter(a => !a.archived)
  const activeRecurring = data.recurring.filter(r => r.active)
  const overduePayments = useMemo(() => getOverdueRecurringPayments(data), [data])
  // One row per dated payment across every bill, nearest date first — a
  // 10-month plan contributes all ten of its rows, and a newly added bill
  // merges its rows into the same ordering.
  const scheduledPayments = useMemo(() => getScheduledPayments(data), [data])
  const visibleSchedule = scheduledPayments.filter(row =>
    (scheduleBill === 'all' || row.recurringId === scheduleBill) && (showPaidRows || !row.paid))
  /** The next payment still owed on a bill — its nearest dated row. */
  const nextRowFor = (recurringId: string) => scheduledPayments.find(row => row.recurringId === recurringId && !row.paid)
  const billsByNextDue = activeRecurring.slice().sort((a, b) =>
    (nextRowFor(a.id)?.dueDate ?? '9999-12-31').localeCompare(nextRowFor(b.id)?.dueDate ?? '9999-12-31'))
  // The schedule is grouped per bill: the bill with the nearest unpaid date
  // leads, and bills with everything settled follow by name.
  const scheduleBills = useMemo(() => {
    const nextDue = (id: string) => scheduledPayments.find(row => row.recurringId === id && !row.paid)?.dueDate
    return data.recurring
      .filter(r => scheduleBill === 'all' || r.id === scheduleBill)
      .slice()
      .sort((a, b) => {
        const an = nextDue(a.id)
        const bn = nextDue(b.id)
        if (an && bn) return an.localeCompare(bn)
        if (an) return -1
        if (bn) return 1
        return a.name.localeCompare(b.name)
      })
  }, [data.recurring, scheduleBill, scheduledPayments])
  const total = activeAccounts.reduce((s, a) => s + accountBalance(data, a.id), 0)
  const filteredIncome = data.incomes.filter(x => x.date >= from && x.date <= to && (accountFilter === 'all' || x.accountId === accountFilter) && (kindFilter === 'all' || kindFilter === 'income'))
  const filteredExpenses = data.expenses.filter(x => x.date >= from && x.date <= to && (accountFilter === 'all' || x.accountId === accountFilter) && (categoryFilter === 'all' || x.categoryId === categoryFilter) && (kindFilter === 'all' || kindFilter === 'expense') && (paidFilter === 'all' || String(x.paid) === paidFilter))
  const moneyIn = filteredIncome.reduce((s, x) => s + x.amount, 0), moneyOut = filteredExpenses.reduce((s, x) => s + x.amount, 0)
  const categories = useMemo(() => data.categories.map(c => ({ ...c, total: filteredExpenses.filter(e => e.categoryId === c.id).reduce((s, e) => s + e.amount, 0) })).sort((a, b) => b.total - a.total), [data.categories, filteredExpenses])

  const removeListItem = (kind: 'categories' | 'sources', id: string) => {
    const used = kind === 'categories' ? data.expenses.some(x => x.categoryId === id) || data.recurring.some(x => x.categoryId === id) : data.incomes.some(x => x.sourceId === id)
    if (used) return toast.error('This item is already in use and cannot be removed.')
    commit({ ...data, [kind]: data[kind].filter(x => x.id !== id) })
  }
  const exportCsv = () => {
    const rows = [['Type','Date','Description','Account','Category','Amount','Paid','Note'], ...filteredIncome.map(x => ['Income',x.date,data.sources.find(s=>s.id===x.sourceId)?.name||'',data.accounts.find(a=>a.id===x.accountId)?.name||'','',String(x.amount),'Yes',x.note]), ...filteredExpenses.map(x => ['Expense',x.date,x.name,data.accounts.find(a=>a.id===x.accountId)?.name||'',data.categories.find(c=>c.id===x.categoryId)?.name||'',String(x.amount),x.paid?'Yes':'No',x.note])]
    const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n'); const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download=`personal-finance-${from}-${to}.csv`; a.click(); URL.revokeObjectURL(a.href)
  }
  const deleteTxTitle = deleteTx ? (deleteTx.type === 'income' ? 'Delete this income entry?' : deleteTx.type === 'expense' ? 'Delete this expense?' : 'Delete this transfer?') : ''
  const doDeleteTx = () => {
    const t = deleteTx
    if (!t) return
    commit({
      ...data,
      incomes: t.type === 'income' ? data.incomes.filter(i => i.id !== t.id) : data.incomes,
      expenses: t.type === 'expense' ? data.expenses.filter(i => i.id !== t.id) : data.expenses,
      transfers: t.type === 'transfer' ? data.transfers.filter(i => i.id !== t.id) : data.transfers,
    })
    setDeleteTx(null)
  }
  const doDeleteRecurring = () => {
    const target = deleteRecurring
    if (!target) return
    void commit(deleteRecurringPayment(data, target.id))
    toast.success('Recurring payment deleted.')
    setDeleteRecurring(null)
    if (recurringDetails?.id === target.id) {
      setRecurringDetails(null)
    }
  }
  const setRecurringActive = (id: string, active: boolean) => {
    void commit({
      ...data,
      recurring: data.recurring.map(item => item.id === id ? { ...item, active } : item),
    })
  }
  if (!ready) return <div className="py-20 text-center text-muted-foreground">Loading your private tracker…</div>

  return <div className="min-h-screen bg-background"><header className="border-b bg-card"><div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6"><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground"><WalletCards className="h-5 w-5"/></span><div><p className="font-bold">{displayName}'s Personal Tracker</p><p className="text-xs text-muted-foreground">Private finance workspace</p></div></div><div className="flex items-center gap-2"><NotificationsBell /><Button variant="outline" size="sm" onClick={()=>navigate('/')}><ArrowLeft className="mr-2 h-4 w-4"/>Work tracker</Button></div></div></header>
    {stale && <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">Couldn't reach the server just now — you're looking at your last saved data, not necessarily the latest.</div>}
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 pb-24 sm:px-6">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold uppercase tracking-[.2em] text-primary">Private workspace</p><h1 className="text-3xl font-bold tracking-tight">{displayName}'s Personal Tracker</h1><p className="text-muted-foreground">Your accounts, spending and income—all in one place.</p></div><div className="flex flex-wrap gap-2"><Button onClick={()=>setEntry('expense')}><ArrowUpRight className="mr-2 h-4 w-4"/>Expense</Button><Button variant="outline" onClick={()=>setEntry('income')}><ArrowDownLeft className="mr-2 h-4 w-4"/>Income</Button><Button variant="outline" onClick={()=>setEntry('transfer')}><ArrowLeftRight className="mr-2 h-4 w-4"/>Transfer</Button></div></div>
    <div className="flex gap-1 overflow-x-auto rounded-xl border bg-card p-1">{NAV.map(n=><Button key={n.id} variant={view===n.id?'default':'ghost'} size="sm" onClick={()=>setView(n.id)} className="shrink-0"><n.icon className="mr-2 h-4 w-4"/>{n.label}</Button>)}</div>

    {view==='dashboard' && <><div className="grid gap-4 md:grid-cols-3"><Metric label="Total balance" value={m(total)} tone="blue"/><Metric label="Money in this month" value={m(moneyIn)} tone="green"/><Metric label="Money out this month" value={m(moneyOut)} tone="orange"/></div><div className="grid gap-6 lg:grid-cols-3"><Card className="lg:col-span-2"><CardHeader className="flex-row items-center justify-between"><CardTitle>Your accounts</CardTitle><Button size="sm" variant="outline" onClick={()=>setAccountOpen(true)}><Plus className="mr-1 h-4 w-4"/>Add</Button></CardHeader><CardContent><AccountGrid data={data} currency={currency}/>{!activeAccounts.length&&<Empty text="Add your first bank or e-wallet account."/>}</CardContent></Card><Card><CardHeader className="flex-row items-center justify-between"><CardTitle>Recurring this month</CardTitle>{overduePayments.length > 0 && <Badge variant="destructive" className="gap-1 text-[10px]"><AlertTriangle className="h-3 w-3" />{overduePayments.length} overdue</Badge>}</CardHeader><CardContent className="space-y-3">{billsByNextDue.slice(0,6).map(r=>{const itemOverdue = overduePayments.filter(op => op.recurringId === r.id); const nextOverdue = itemOverdue[0]; const nextRow = nextRowFor(r.id); const target = nextRow ? { id: nextRow.installmentId ?? '', dueDate: nextRow.dueDate, number: nextRow.installmentNumber, paid: false } : undefined; return <RecurringRow key={r.id} r={r} installment={target} isOverdue={Boolean(nextOverdue)} daysOverdue={nextOverdue?.daysOverdue} overdueCount={itemOverdue.length} dueLabel={nextRow ? scheduledPaymentLabel(nextRow) : undefined} data={data} currency={currency} onPay={()=>setPayRecurring({r, i: target, overduePayment: nextOverdue})}/>})}{!activeRecurring.length&&<Empty text="No active recurring payments."/>}</CardContent></Card></div></>}

    {view==='accounts' && <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Accounts</CardTitle><p className="text-sm text-muted-foreground">Balances calculate automatically from paid transactions and transfers.</p></div><Button onClick={()=>setAccountOpen(true)}><Plus className="mr-2 h-4 w-4"/>Add account</Button></CardHeader><CardContent><AccountGrid data={data} currency={currency} manage onArchive={(id)=>commit({...data,accounts:data.accounts.map(a=>a.id===id?{...a,archived:!a.archived}:a)})} onEdit={(id)=>{const a=data.accounts.find(x=>x.id===id);if(a)setEditAccount(a)}} onReconcile={(id)=>{const a=data.accounts.find(x=>x.id===id);if(a)setReconcileAccount(a)}}/><div className="mt-6 rounded-xl bg-primary p-5 text-primary-foreground"><p className="text-sm opacity-80">Total available</p><p className="text-3xl font-bold">{m(total)}</p></div></CardContent></Card>}

    {view==='activity' && <Card><CardHeader><CardTitle>Transactions</CardTitle></CardHeader><CardContent className="space-y-2">{[...data.incomes.map(x=>({id:x.id,date:x.date,title:data.sources.find(s=>s.id===x.sourceId)?.name||'Income',amount:x.amount,type:'income' as const})),...data.expenses.map(x=>({id:x.id,date:x.date,title:x.name,amount:-x.amount,type:'expense' as const})),...data.transfers.map(x=>({id:x.id,date:x.date,title:`${data.accounts.find(a=>a.id===x.fromId)?.name} → ${data.accounts.find(a=>a.id===x.toId)?.name}`,amount:0,type:'transfer' as const}))].sort((a,b)=>b.date.localeCompare(a.date)).map(x=><div key={`${x.type}-${x.id}`} className="flex items-center justify-between rounded-lg border p-3"><div><p className="font-medium">{x.title}</p><p className="text-xs text-muted-foreground">{x.date} · {x.type}</p></div><div className="flex items-center gap-3"><span className={x.amount>0?'text-emerald-600':x.amount<0?'text-rose-600':'text-muted-foreground'}>{x.amount?m(x.amount):'Internal'}</span><Button size="sm" variant="ghost" onClick={()=>setDeleteTx({type:x.type,id:x.id})}>Delete</Button></div></div>)}{!data.incomes.length&&!data.expenses.length&&!data.transfers.length&&<Empty text="No transactions match these filters."/>}</CardContent></Card>}

    {view==='recurring' && <>
      {overduePayments.length > 0 && (
        <Card className="border-rose-300 bg-rose-50/50 dark:border-rose-900 dark:bg-rose-950/20">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-100 text-rose-600 dark:bg-rose-900/50 dark:text-rose-400">
                  <AlertTriangle className="h-4 w-4" />
                </span>
                <div>
                  <CardTitle className="text-base text-rose-900 dark:text-rose-100">
                    {overduePayments.length} Overdue Recurring Payment{overduePayments.length === 1 ? '' : 's'}
                  </CardTitle>
                  <CardDescription className="text-xs text-rose-700 dark:text-rose-300">
                    Past due date and pending payment. Mark them paid to record the expense and keep accounts accurate.
                  </CardDescription>
                </div>
              </div>
              <Badge variant="destructive" className="font-semibold">Action needed</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {overduePayments.map((op) => {
              const r = data.recurring.find(item => item.id === op.recurringId)
              if (!r) return null
              return (
                <div key={`${op.recurringId}-${op.dueDate}-${op.installmentNumber ?? ''}`} className="flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-card p-3 shadow-sm dark:border-rose-800">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold">{op.recurringName}</p>
                      <Badge variant="destructive" className="gap-1 text-[10px]">
                        <AlertTriangle className="h-3 w-3" />
                        {op.daysOverdue} day{op.daysOverdue === 1 ? '' : 's'} overdue
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Due {new Date(`${op.dueDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      {op.amount ? ` · ${m(op.amount)}` : ' · Variable'}
                      {op.installmentNumber ? ` · Installment ${op.installmentNumber}${r.maxOccurrences ? ` of ${r.maxOccurrences}` : ''}` : ''}
                    </p>
                  </div>
                  <Button size="sm" variant="destructive" onClick={() => setPayRecurring({ r, i: op.installmentId ? { id: op.installmentId, dueDate: op.dueDate, number: op.installmentNumber! } : undefined, overduePayment: op })}>
                    Mark paid
                  </Button>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Payment schedule</CardTitle>
            <p className="text-sm text-muted-foreground">Every payment of every bill as its own dated row, grouped by bill — nearest date first.</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Select value={scheduleBill} onValueChange={setScheduleBill}>
              <SelectTrigger className="w-40" aria-label="Filter the schedule by bill"><SelectValue/></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All bills</SelectItem>
                {data.recurring.map(r=><SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button onClick={()=>setRecurringOpen(true)}><Plus className="mr-2 h-4 w-4"/>Add</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {visibleSchedule.filter(row=>!row.paid).length} payment{visibleSchedule.filter(row=>!row.paid).length===1?'':'s'} still due
              {showPaidRows && visibleSchedule.length ? ` · ${visibleSchedule.length} rows listed` : ''}
            </span>
            <label className="flex cursor-pointer items-center gap-2">
              <Switch checked={showPaidRows} onCheckedChange={setShowPaidRows} aria-label="Show paid payments in the schedule"/>
              Show paid
            </label>
          </div>
          {scheduleBills.map(r=>(
            <BillScheduleGroup
              key={r.id}
              r={r}
              rows={visibleSchedule.filter(row=>row.recurringId===r.id)}
              overdueCount={overduePayments.filter(op=>op.recurringId===r.id).length}
              data={data}
              currency={currency}
              onPayRow={row=>setPayRecurring({ r, i: { id: row.installmentId ?? '', dueDate: row.dueDate, number: row.installmentNumber } })}
              onToggle={active=>setRecurringActive(r.id,active)}
              onDetails={()=>setRecurringDetails(r)}
              onDelete={()=>setDeleteRecurring(r)}
            />
          ))}
          {!scheduleBills.length && <Empty text="Add bills, loans, and subscriptions you pay regularly."/>}
        </CardContent>
      </Card>
      <Dialog open={!!recurringDetails} onOpenChange={open=>{if(!open)setRecurringDetails(null)}}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>{recurringDetails?.name} payment schedule</DialogTitle><DialogDescription>Paid months, upcoming installments, and the remaining balance.</DialogDescription></DialogHeader>{recurringDetails&&(()=>{
        const allInst = (recurringDetails.installments || []).slice().sort((a,b)=>a.dueDate.localeCompare(b.dueDate))
        const overdueInst = allInst.filter(i => !i.paid && i.dueDate < today())
        const upcomingInst = allInst.filter(i => !i.paid && i.dueDate >= today())
        return <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Paid</p>
              <p className="font-semibold">{recurringDetails.runCount}{recurringDetails.maxOccurrences?` of ${recurringDetails.maxOccurrences}`:''}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Total balance to pay</p>
              <p className="font-semibold">{recurringDetails.expectedAmount&&recurringDetails.maxOccurrences?money(recurringDetails.expectedAmount*(recurringDetails.maxOccurrences-recurringDetails.runCount),currency):'Variable'}</p>
            </div>
          </div>
          <div>
            <p className="mb-2 font-medium">Paid months</p>
            {data.expenses.filter(x=>x.recurringId===recurringDetails.id).sort((a,b)=>(b.dueDate||b.date).localeCompare(a.dueDate||a.date)).map(x=><p key={x.id} className="text-sm text-muted-foreground">{new Date(`${x.dueDate||x.date}T00:00:00`).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})} · paid {new Date(`${x.date}T00:00:00`).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})} · {money(x.amount,currency)}</p>)}
            {!data.expenses.some(x=>x.recurringId===recurringDetails.id)&&<p className="text-sm text-muted-foreground">No paid months yet.</p>}
          </div>
          {overdueInst.length > 0 && (
            <div>
              <p className="mb-2 font-medium text-destructive flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4" />
                Overdue payments ({overdueInst.length})
              </p>
              <div className="space-y-2">
                {overdueInst.map(i=><RecurringRow key={i.id} r={recurringDetails} installment={i} isOverdue daysOverdue={daysDifference(i.dueDate, today())} data={data} currency={currency} onPay={()=>{setRecurringDetails(null);setPayRecurring({r:recurringDetails,i})}}/> )}
              </div>
            </div>
          )}
          <div>
            <p className="mb-2 font-medium">Upcoming payments</p>
            <div className="space-y-2">
              {upcomingInst.map(i=><RecurringRow key={i.id} r={recurringDetails} installment={i} data={data} currency={currency} onPay={()=>{setRecurringDetails(null);setPayRecurring({r:recurringDetails,i})}}/> )}
              {upcomingInst.length === 0 && overdueInst.length === 0 && <p className="text-sm text-muted-foreground">No pending payments.</p>}
            </div>
          </div>
          <div className="flex items-center justify-between border-t pt-3">
            <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={()=>{const t=recurringDetails;setRecurringDetails(null);setDeleteRecurring(t)}}><Trash2 className="mr-1.5 h-4 w-4"/>Delete recurring payment</Button>
            <Button variant="outline" size="sm" onClick={()=>setRecurringDetails(null)}>Close</Button>
          </div>
        </div>
      })()}</DialogContent></Dialog>
    </>}

    {view==='reports' && <div className="space-y-5"><Card><CardContent className="pt-6"><AccountGrid data={data} currency={currency}/><div className="mt-4 flex justify-between rounded-lg bg-muted p-4 font-semibold"><span>Total across accounts</span><span>{m(total)}</span></div></CardContent></Card><Card><CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-6"><Field label="From"><Input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></Field><Field label="To"><Input type="date" value={to} onChange={e=>setTo(e.target.value)}/></Field><Filter value={accountFilter} set={setAccountFilter} label="Account" items={data.accounts}/><Filter value={categoryFilter} set={setCategoryFilter} label="Category" items={data.categories}/><Filter value={kindFilter} set={setKindFilter} label="Type" items={[{id:'income',name:'Income'},{id:'expense',name:'Expense'}]}/><Filter value={paidFilter} set={setPaidFilter} label="Paid status" items={[{id:'true',name:'Paid'},{id:'false',name:'Unpaid'}]}/></CardContent></Card><div className="grid gap-4 md:grid-cols-3"><Metric label="Money in" value={m(moneyIn)} tone="green"/><Metric label="Money out" value={m(moneyOut)} tone="orange"/><Metric label="Net" value={m(moneyIn-moneyOut)} tone="blue"/></div><Card><CardHeader className="flex-row items-center justify-between"><CardTitle>Spending by category</CardTitle><Button variant="outline" onClick={exportCsv}><Download className="mr-2 h-4 w-4"/>Export CSV</Button></CardHeader><CardContent className="space-y-4">{categories.filter(c=>c.total>0).map(c=><div key={c.id}><div className="mb-1 flex justify-between text-sm"><span>{c.name}</span><b>{m(c.total)}</b></div><div className="h-3 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{width:`${moneyOut?Math.max(3,c.total/moneyOut*100):0}%`}}/></div></div>)}{!moneyOut&&<Empty text="No spending matches these filters."/>}</CardContent></Card></div>}

    {view==='settings' && <div className="grid gap-6 md:grid-cols-2"><ListManager title="Expense categories" items={data.categories} onAdd={name=>commit({...data,categories:[...data.categories,{id:pfId(),name}]})} onRemove={id=>removeListItem('categories',id)}/><ListManager title="Income sources" items={data.sources} onAdd={name=>commit({...data,sources:[...data.sources,{id:pfId(),name}]})} onRemove={id=>removeListItem('sources',id)}/></div>}
    <AccountDialog open={accountOpen} close={()=>setAccountOpen(false)} data={data} commit={commit}/>
    <EntryDialog kind={entry} close={()=>setEntry(null)} data={data} commit={commit}/>
    <RecurringDialog open={recurringOpen} close={()=>setRecurringOpen(false)} data={data} commit={commit}/>
    {editAccount && <EditAccountDialog account={editAccount} close={()=>setEditAccount(null)} data={data} commit={commit}/>}
    {reconcileAccount && <ReconcileDialog account={reconcileAccount} data={data} currency={currency} close={()=>setReconcileAccount(null)} commit={commit}/>}
    <ConfirmDialog open={!!deleteTx} onOpenChange={v=>{if(!v)setDeleteTx(null)}} title={deleteTxTitle} description="The transaction will be removed from your tracker. This cannot be undone." confirmLabel="Delete" onConfirm={doDeleteTx}/>
    <ConfirmDialog open={!!deleteRecurring} onOpenChange={v=>{if(!v)setDeleteRecurring(null)}} title={deleteRecurring ? `Delete ${deleteRecurring.name}?` : 'Delete recurring payment?'} description="This recurring payment will be removed from your tracker. Past transactions already recorded will be kept." confirmLabel="Delete" onConfirm={doDeleteRecurring}/>
    {payRecurring && <PayRecurringDialog recurring={payRecurring.r} installment={payRecurring.i} overduePayment={payRecurring.overduePayment} data={data} close={()=>setPayRecurring(null)} commit={commit}/>}
  </main></div>
}

function Metric({label,value,tone}:{label:string;value:string;tone:string}) { return <Card className={tone==='green'?'border-emerald-200':tone==='orange'?'border-orange-200':'border-blue-200'}><CardContent className="pt-6"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-bold">{value}</p></CardContent></Card> }
function Empty({text}:{text:string}) { return <p className="py-8 text-center text-sm text-muted-foreground">{text}</p> }
function Field({label,children}:{label:string;children:ReactNode}) { return <div className="space-y-1.5"><Label>{label}</Label>{children}</div> }
function AccountGrid({data,manage,currency,onArchive,onEdit,onReconcile}:{data:PFData;manage?:boolean;currency:string;onArchive?:(id:string)=>void;onEdit?:(id:string)=>void;onReconcile?:(id:string)=>void}) { return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{data.accounts.map(a=><div key={a.id} className={`rounded-xl border p-4 ${a.archived?'opacity-50':''}`}><div className="flex justify-between"><div><p className="font-semibold">{a.name}</p><p className="text-xs text-muted-foreground">{a.purpose||'No label'}</p></div><WalletCards className="h-5 w-5 text-primary"/></div><p className="mt-5 text-xl font-bold">{money(accountBalance(data,a.id),currency)}</p>{manage&&<div className="mt-2 flex flex-wrap gap-1"><Button size="sm" variant="ghost" onClick={()=>onEdit?.(a.id)}>Edit</Button><Button size="sm" variant="ghost" onClick={()=>onReconcile?.(a.id)}>Reconcile</Button><Button size="sm" variant="ghost" onClick={()=>onArchive?.(a.id)}>{a.archived?'Restore':'Archive'}</Button></div>}</div>)}</div> }
function Filter({value,set,label,items}:{value:string;set:(v:string)=>void;label:string;items:{id:string;name:string}[]}) { return <Field label={label}><Select value={value} onValueChange={set}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">All</SelectItem>{items.map(x=><SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}</SelectContent></Select></Field> }

function AccountDialog({open,close,data,commit}:{open:boolean;close:()=>void;data:PFData;commit:(d:PFData)=>void}) { const submit=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const f=new FormData(e.currentTarget);commit({...data,accounts:[...data.accounts,{id:pfId(),name:String(f.get('name')),purpose:String(f.get('purpose')),startingBalance:Number(f.get('balance')),archived:false}]});close()}; return <Dialog open={open} onOpenChange={close}><DialogContent><DialogHeader><DialogTitle>Add account</DialogTitle></DialogHeader><form className="space-y-4" onSubmit={submit}><Field label="Bank or e-wallet name"><Input name="name" required autoFocus/></Field><Field label="Purpose / label"><Input name="purpose" placeholder="For bills, salary, savings…"/></Field><Field label="Starting balance"><Input name="balance" type="number" step="0.01" required defaultValue="0"/></Field><Button className="w-full">Add account</Button></form></DialogContent></Dialog> }
function EditAccountDialog({account,close,data,commit}:{account:PFAccount;close:()=>void;data:PFData;commit:(d:PFData)=>void}) { const submit=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const f=new FormData(e.currentTarget);commit({...data,accounts:data.accounts.map(x=>x.id===account.id?{...x,name:String(f.get('name'))||x.name,purpose:String(f.get('purpose'))}:x)});close()}; return <Dialog open onOpenChange={close}><DialogContent><DialogHeader><DialogTitle>Edit account</DialogTitle></DialogHeader><form className="space-y-4" onSubmit={submit}><Field label="Bank or e-wallet name"><Input name="name" required defaultValue={account.name}/></Field><Field label="Purpose / label"><Input name="purpose" defaultValue={account.purpose} placeholder="For bills, salary, savings…"/></Field><Button className="w-full">Save changes</Button></form></DialogContent></Dialog> }
function ReconcileDialog({account,data,currency,close,commit}:{account:PFAccount;data:PFData;currency:string;close:()=>void;commit:(d:PFData)=>void}) { const current=accountBalance(data,account.id); const submit=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const desired=Number(new FormData(e.currentTarget).get('balance'));if(!Number.isFinite(desired))return;commit({...data,accounts:data.accounts.map(x=>x.id===account.id?{...x,startingBalance:x.startingBalance+(desired-current)}:x)});close()}; return <Dialog open onOpenChange={close}><DialogContent><DialogHeader><DialogTitle>Reconcile {account.name}</DialogTitle></DialogHeader><p className="text-sm text-muted-foreground">The tracker currently calculates a balance of <b>{money(current,currency)}</b>.</p><form className="space-y-4" onSubmit={submit}><Field label="Enter the correct current balance"><Input name="balance" type="number" step="0.01" required defaultValue={String(current)}/></Field><p className="text-xs text-muted-foreground">The difference is folded into the account's starting balance, so history stays intact.</p><Button className="w-full">Reconcile</Button></form></DialogContent></Dialog> }
function PayRecurringDialog({recurring,installment,overduePayment,data,close,commit}:{recurring:PFData['recurring'][number];installment?:{id:string;dueDate:string;number:number};overduePayment?:PFOverduePayment;data:PFData;close:()=>void;commit:(d:PFData)=>void}) {
  const accounts = data.accounts.filter(a => !a.archived)
  const target = (() => {
    if (installment) return { id: installment.id, dueDate: installment.dueDate, number: installment.number }
    if (overduePayment) {
      return {
        id: overduePayment.installmentId || pfId(),
        dueDate: overduePayment.dueDate,
        number: overduePayment.installmentNumber ?? (recurring.runCount + 1),
      }
    }
    const nextUnpaid = recurring.installments?.find(i => !i.paid)
    if (nextUnpaid) {
      return { id: nextUnpaid.id, dueDate: nextUnpaid.dueDate, number: nextUnpaid.number }
    }
    const parsedDay = recurring.startDate ? Number(recurring.startDate.slice(8, 10)) : 1
    const dueDay = (recurring.dueDay ?? parsedDay) || 1
    const safeDueDay = Math.max(1, Math.min(28, dueDay))
    const dueDate = `${currentPeriod()}-${String(safeDueDay).padStart(2, '0')}`
    return {
      id: pfId(),
      dueDate,
      number: recurring.runCount + 1,
    }
  })()

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const accountId = String(form.get('account'))
    const amount = Number(form.get('amount'))
    if (!accounts.some(a => a.id === accountId) || !(amount > 0)) {
      return toast.error('Choose an active account and enter a valid amount.')
    }

    if (recurring.installments && recurring.installments.length > 0) {
      if (data.expenses.some(x => x.recurringId === recurring.id && (x.installmentNumber === target.number || (x.dueDate === target.dueDate && x.paid)))) {
        return toast.error('This installment is already paid.')
      }
    } else {
      const period = target.dueDate.slice(0, 7)
      if (data.expenses.some(x => x.recurringId === recurring.id && (x.period === period || x.dueDate === target.dueDate) && x.paid)) {
        return toast.error('This payment is already paid for this period.')
      }
    }

    const next = {
      ...data,
      recurring: data.recurring.map(r => r.id === recurring.id ? {
        ...r,
        runCount: r.runCount + 1,
        active: r.maxOccurrences === null || r.runCount + 1 < r.maxOccurrences,
        installments: r.installments ? r.installments.map(i => (i.id === target.id || i.number === target.number) ? { ...i, paid: true } : i) : [],
      } : r),
      expenses: [
        ...data.expenses,
        {
          id: pfId(),
          date: today(),
          dueDate: target.dueDate,
          name: recurring.name,
          categoryId: recurring.categoryId,
          amount,
          accountId,
          paid: true,
          note: `Recurring payment — ${recurring.maxOccurrences ? `installment ${target.number} of ${recurring.maxOccurrences}` : `payment ${target.number}`}`,
          recurringId: recurring.id,
          installmentNumber: target.number,
          period: target.dueDate.slice(0, 7),
        }
      ]
    }
    void commit(next)
    toast.success(`Payment for ${recurring.name} marked paid.`)
    close()
  }

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pay {recurring.name}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <p className="text-sm text-muted-foreground">
            Due {target.dueDate}
            {recurring.maxOccurrences ? ` · installment ${target.number} of ${recurring.maxOccurrences}` : ` · payment ${target.number}`}
          </p>
          <Picker name="account" label="Pay from" items={accounts} initial={recurring.accountId}/>
          <Field label="Amount paid">
            <Input name="amount" type="number" min="0.01" step="0.01" required defaultValue={String(recurring.expectedAmount || '')}/>
          </Field>
          <Button className="w-full" disabled={!accounts.length}>Mark paid</Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
function EntryDialog({kind,close,data,commit}:{kind:EntryKind|null;close:()=>void;data:PFData;commit:(d:PFData)=>void}) { const submit=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const f=new FormData(e.currentTarget),base={id:pfId(),date:String(f.get('date')),amount:Number(f.get('amount')),note:String(f.get('note')||'')};if(kind==='income'){const sourceName=String(f.get('source')).trim();const existing=data.sources.find(s=>s.name.toLowerCase()===sourceName.toLowerCase());const source=existing||{id:pfId(),name:sourceName};commit({...data,sources:existing?data.sources:[...data.sources,source],incomes:[...data.incomes,{...base,sourceId:source.id,accountId:String(f.get('account'))}]})};if(kind==='expense'){const categoryName=String(f.get('category')).trim();const existing=data.categories.find(c=>c.name.toLowerCase()===categoryName.toLowerCase());const category=existing||{id:pfId(),name:categoryName};commit({...data,categories:existing?data.categories:[...data.categories,category],expenses:[...data.expenses,{...base,name:String(f.get('name')),categoryId:category.id,accountId:String(f.get('account')),paid:f.get('paid')==='on'}]})};if(kind==='transfer')commit({...data,transfers:[...data.transfers,{...base,fromId:String(f.get('from')),toId:String(f.get('to'))}]});close()};return <Dialog open={!!kind} onOpenChange={close}><DialogContent><DialogHeader><DialogTitle>Add {kind}</DialogTitle></DialogHeader><form className="space-y-4" onSubmit={submit}><div className="grid grid-cols-2 gap-3"><Field label="Date"><Input name="date" type="date" defaultValue={today()} required/></Field><Field label="Amount"><Input name="amount" type="number" min="0.01" step="0.01" required/></Field></div>{kind==='income'&&<><Field label="Income source"><Input name="source" list="personal-income-sources" placeholder="Choose or type a new source" required/><datalist id="personal-income-sources">{data.sources.map(s=><option key={s.id} value={s.name}/>)}</datalist><p className="text-xs text-muted-foreground">Select an existing source or type a new one. New sources are saved automatically.</p></Field><Picker name="account" label="Into account" items={data.accounts.filter(a=>!a.archived)}/></>}{kind==='expense'&&<><Field label="Name / description"><Input name="name" required/></Field><CategoryField categories={data.categories}/><Picker name="account" label="From account" items={data.accounts.filter(a=>!a.archived)}/><label className="flex items-center gap-2 text-sm"><input name="paid" type="checkbox" defaultChecked/> Paid / cleared</label></>}{kind==='transfer'&&<><Picker name="from" label="From account" items={data.accounts.filter(a=>!a.archived)}/><Picker name="to" label="To account" items={data.accounts.filter(a=>!a.archived)}/></>}<Field label="Note (optional)"><Input name="note"/></Field><Button className="w-full" disabled={!data.accounts.length}>Save {kind}</Button>{!data.accounts.length&&<p className="text-xs text-destructive">Add an account first.</p>}</form></DialogContent></Dialog> }
function CategoryField({categories}:{categories:{id:string;name:string}[]}) { return <Field label="Category"><Input name="category" list="personal-expense-categories" placeholder="Choose or type a new category" required/><datalist id="personal-expense-categories">{categories.map(c=><option key={c.id} value={c.name}/>)}</datalist><p className="text-xs text-muted-foreground">Select an existing category or type a new one. New categories are saved automatically.</p></Field> }
function Picker({name,label,items,initial}:{name:string;label:string;items:{id:string;name:string}[];initial?:string}) { return <Field label={label}><select name={name} required className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" defaultValue={initial&&items.some(x=>x.id===initial)?initial:''}><option value="">Choose…</option>{items.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></Field> }
function ListManager({title,items,onAdd,onRemove}:{title:string;items:{id:string;name:string}[];onAdd:(s:string)=>void;onRemove:(id:string)=>void}) { const [name,setName]=useState('');return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent><form className="mb-4 flex gap-2" onSubmit={e=>{e.preventDefault();if(name.trim()){onAdd(name.trim());setName('')}}}><Input value={name} onChange={e=>setName(e.target.value)} placeholder="Add new…" aria-label={`Add ${title}`}/><Button size="icon" type="submit" aria-label={`Add ${title}`}><Plus className="h-4 w-4" aria-hidden/></Button></form><div className="space-y-2">{items.map(x=><div key={x.id} className="flex items-center justify-between rounded-lg border px-3 py-2"><span>{x.name}</span><Button size="sm" variant="ghost" onClick={()=>onRemove(x.id)}>Remove</Button></div>)}</div></CardContent></Card> }
function RecurringDialog({open,close,data,commit}:{open:boolean;close:()=>void;data:PFData;commit:(d:PFData)=>void}) {
  const [limitMode, setLimitMode] = useState<'off' | 'count'>('off')
  const [occurrences, setOccurrences] = useState('12')
  const [startDate, setStartDate] = useState(today())
  const [dueDay, setDueDay] = useState('')
  const accounts = data.accounts.filter(account => !account.archived)

  useEffect(() => {
    if (!open) return
    setLimitMode('off')
    setOccurrences('12')
    setStartDate(today())
    setDueDay('')
  }, [open])

  const occurrenceValue = (() => {
    if (limitMode !== 'count') return null
    const value = Number(occurrences)
    return Number.isInteger(value) && value >= 1 ? value : null
  })()

  // The dated rows this bill will add to the payment schedule, previewed
  // before saving: 10 months means 10 rows, one per month from the first
  // payment date. Run through the same builder the schedule itself uses, so
  // the preview can never disagree with what the list ends up showing.
  const dueDayValue = limitMode === 'off' && dueDay ? Number(dueDay) : null
  const preview = useMemo(() => {
    const draft = {
      id: 'preview', name: '', categoryId: '', accountId: '', expectedAmount: null,
      dueDay: dueDayValue, active: true, maxOccurrences: occurrenceValue, runCount: 0, startDate,
      installments: buildInstallments(startDate, occurrenceValue ?? 0),
    }
    return getScheduledPayments({ ...emptyPFData(), recurring: [draft] })
  }, [dueDayValue, occurrenceValue, startDate])

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const name = String(form.get('name')).trim()
    const categoryName = String(form.get('category')).trim()
    const accountId = String(form.get('account'))
    if (!name) return toast.error('Give the recurring payment a name.')
    if (!categoryName) return toast.error('Choose or add a category.')
    if (!accounts.some(account => account.id === accountId)) return toast.error('Choose an active account.')
    if (limitMode === 'count' && occurrenceValue === null) {
      return toast.error('Enter how many monthly payments there are — a whole number of 1 or more.')
    }

    const amountText = String(form.get('amount') ?? '')
    const expectedAmount = amountText ? Number(amountText) : null
    if (expectedAmount !== null && !(expectedAmount > 0)) return toast.error('Enter an expected amount greater than zero.')
    const dayText = String(form.get('day') ?? '')
    const dueDay = dayText ? Number(dayText) : null
    // Capped at 28 so a projected month always exists (there is no 30 February).
    if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28)) {
      return toast.error('Enter a due day from 1 to 28.')
    }

    const existing = data.categories.find(category => category.name.toLowerCase() === categoryName.toLowerCase())
    const category = existing || { id: pfId(), name: categoryName }
    void commit({
      ...data,
      categories: existing ? data.categories : [...data.categories, category],
      recurring: [...data.recurring, {
        id: pfId(),
        name,
        categoryId: category.id,
        accountId,
        expectedAmount,
        dueDay,
        active: true,
        maxOccurrences: occurrenceValue,
        runCount: 0,
        startDate,
        installments: buildInstallments(startDate, occurrenceValue ?? 0),
      }],
    })
    toast.success(occurrenceValue
      ? `${name} added — ${occurrenceValue} dated payment${occurrenceValue === 1 ? '' : 's'} added to your schedule.`
      : `${name} added to your recurring bills.`)
    close()
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add recurring payment</DialogTitle>
          <DialogDescription>A monthly bill, loan or subscription. A fixed number of months creates one dated row per payment in your schedule.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <Field label="Name"><Input name="name" required autoFocus placeholder="e.g. Home Credit"/></Field>
          <CategoryField categories={data.categories}/>
          <Picker name="account" label="Usual account" items={accounts}/>
          <div className="grid grid-cols-2 gap-3">
            <Field label="First payment date"><Input name="startDate" type="date" value={startDate} onChange={event => setStartDate(event.target.value)} required/></Field><Field label="Expected amount"><Input name="amount" type="number" min="0.01" step="0.01"/></Field>
            {limitMode === 'off' && (
              <Field label="Due day of month">
                <Input name="day" type="number" min="1" max="28" step="1" value={dueDay} onChange={event => setDueDay(event.target.value)} placeholder="e.g. 15"/>
                <p className="text-xs text-muted-foreground">Dates are projected on this day each month. Left blank, the day of the first payment date is used.</p>
              </Field>
            )}
          </div>
          <Field label="How long does it run?">
            <Select value={limitMode} onValueChange={value => setLimitMode(value as 'off' | 'count')}>
              <SelectTrigger aria-label="Recurring payment run limit"><SelectValue/></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Until switched off</SelectItem>
                <SelectItem value="count">For a set number of months</SelectItem>
              </SelectContent>
            </Select>
            {limitMode === 'count' ? (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={occurrences}
                  onChange={event => setOccurrences(event.target.value)}
                  className="w-24"
                  aria-label="How many monthly payments"
                />
                <span className="text-xs text-muted-foreground">
                  {occurrenceValue === 1 ? 'monthly payment, then it turns off' : 'monthly payments, then it turns off'}
                </span>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">It stays active until you switch it off — its upcoming dates are projected month by month.</p>
            )}
            <p className="text-xs text-muted-foreground">The first payment you mark paid counts as run 1.</p>
          </Field>
          {preview.length > 0 && (
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-xs font-medium">
                {occurrenceValue
                  ? `${preview.length} row${preview.length === 1 ? '' : 's'} will be added to your payment schedule`
                  : `The next ${preview.length} dates will show in your payment schedule`}
              </p>
              <ol className="mt-2 max-h-36 space-y-1 overflow-y-auto pr-1 text-xs text-muted-foreground">
                {preview.map(row => (
                  <li key={row.key} className="flex items-center justify-between gap-2">
                    <span>{occurrenceValue ? `Payment ${row.installmentNumber}` : scheduledPaymentLabel(row)}</span>
                    <span className="font-medium text-foreground">{formatShortDate(row.dueDate)}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-[11px] text-muted-foreground">
                One payment per month from the first payment date — listed nearest date first.
              </p>
            </div>
          )}
          <Button className="w-full" disabled={!accounts.length}>Add recurring payment</Button>
          {!accounts.length && <p className="text-xs text-destructive">Add an account first.</p>}
        </form>
      </DialogContent>
    </Dialog>
  )
}
/**
 * One bill's block in the payment schedule: a header with its progress and
 * controls, then a row per payment — nearest date first, paid ones below.
 */
function BillScheduleGroup({
  r,
  rows,
  overdueCount,
  data,
  currency,
  onPayRow,
  onToggle,
  onDetails,
  onDelete,
}: {
  r: PFData['recurring'][number]
  rows: PFScheduledPayment[]
  overdueCount: number
  data: PFData
  currency: string
  onPayRow: (row: PFScheduledPayment) => void
  onToggle: (active: boolean) => void
  onDetails: () => void
  onDelete: () => void
}) {
  const paidCount = rows.filter(row => row.paid).length
  const nextRow = rows.find(row => !row.paid)
  const finished = r.maxOccurrences !== null && r.runCount >= r.maxOccurrences
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate font-semibold">{r.name}</p>
            {overdueCount > 0 && (
              <Badge variant="destructive" className="gap-1 whitespace-nowrap text-[10px]">
                <AlertTriangle className="h-3 w-3"/>
                {overdueCount} overdue
              </Badge>
            )}
            {r.maxOccurrences !== null && (
              <Badge variant="muted" className="whitespace-nowrap text-[10px]">
                {Math.min(r.runCount, r.maxOccurrences)}/{r.maxOccurrences} paid
              </Badge>
            )}
            {!r.active && <Badge variant="muted" className="whitespace-nowrap text-[10px]">Off</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">
            {r.expectedAmount ? `${money(r.expectedAmount, currency)} a month` : 'Variable amount'}
            {` · ${rows.length} payment${rows.length === 1 ? '' : 's'} listed · ${paidCount} paid`}
            {nextRow ? ` · next ${formatShortDate(nextRow.dueDate)}` : r.active ? '' : ' · nothing left due'}
            {r.maxOccurrences === null ? ' · until switched off' : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={r.active}
            disabled={finished}
            title={finished ? 'All configured runs are complete.' : undefined}
            aria-label={finished ? `${r.name} completed all configured runs` : `${r.active ? 'Switch off' : 'Switch on'} ${r.name}`}
            onCheckedChange={onToggle}
          />
          <Button size="iconSm" variant="ghost" onClick={onDetails} title={`See ${r.name} details`} aria-label={`See ${r.name} details`}>
            <List className="h-4 w-4"/>
          </Button>
          <Button
            size="iconSm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onDelete}
            title={`Delete ${r.name}`}
            aria-label={`Delete ${r.name}`}
          >
            <Trash2 className="h-4 w-4"/>
          </Button>
        </div>
      </div>
      {rows.map(row => (
        <RecurringRow
          key={row.key}
          r={row.recurring}
          installment={{ id: row.installmentId ?? '', dueDate: row.dueDate, number: row.installmentNumber, paid: row.paid }}
          isOverdue={row.status === 'overdue'}
          daysOverdue={row.status === 'overdue' ? Math.abs(row.daysFromReference) : undefined}
          dueLabel={scheduledPaymentLabel(row)}
          projected={row.projected}
          showName={false}
          showCountBadge={false}
          data={data}
          currency={currency}
          onPay={() => onPayRow(row)}
        />
      ))}
      {!rows.length && (
        <p className="px-1 text-xs text-muted-foreground">
          No payments listed here right now — switch &quot;Show paid&quot; on to see the ones already settled.
        </p>
      )}
    </div>
  )
}

function RecurringRow({
  r,
  installment,
  isOverdue,
  daysOverdue,
  overdueCount,
  dueLabel,
  projected,
  showName = true,
  showCountBadge = true,
  data,
  currency,
  onPay,
}: {
  r: PFData['recurring'][number]
  installment?: { id: string; dueDate: string; number: number; paid: boolean }
  isOverdue?: boolean
  daysOverdue?: number
  overdueCount?: number
  /** Wording for the due date relative to today — "Due in 20 days", "3 days overdue". */
  dueLabel?: string
  /** True when the date is projected for an open-ended bill with no stored schedule. */
  projected?: boolean
  /** Set false when the row sits under a bill header that already names it. */
  showName?: boolean
  /** Set false when the bill header already carries the "x/y paid" badge. */
  showCountBadge?: boolean
  data: PFData
  currency: string
  onPay: () => void
}) {
  // A scheduled row is paid only when that exact installment is paid.
  // Never infer payment from the current month: future installments may be paid early.
  const paid = installment ? installment.paid : data.expenses.some(expense => expense.recurringId === r.id && expense.period === currentPeriod())
  const showOverdue = Boolean(isOverdue && !paid && r.active)

  return (
    <div className={cn(
      "flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors",
      showOverdue && "border-rose-300 bg-rose-50/50 dark:border-rose-900 dark:bg-rose-950/20"
    )}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {showName && <p className="font-medium">{r.name}</p>}
          {showOverdue && (
            <Badge variant="destructive" className="gap-1 whitespace-nowrap text-[10px]">
              <AlertTriangle className="h-3 w-3" />
              {overdueCount && overdueCount > 1 ? `${overdueCount} overdue` : 'Overdue'}
            </Badge>
          )}
          {installment && (
            <p className={cn("text-sm", showOverdue ? "text-rose-600 dark:text-rose-400 font-medium" : "text-muted-foreground")}>
              {formatShortDate(installment.dueDate)}
              {dueLabel
                ? ` · ${dueLabel}`
                : showOverdue && daysOverdue ? ` (${daysOverdue}d overdue)` : ''}
            </p>
          )}
          {showCountBadge && r.maxOccurrences !== null && (
            <Badge variant="muted" className="whitespace-nowrap text-[10px]">
              {Math.min(r.runCount, r.maxOccurrences)}/{r.maxOccurrences} paid
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {r.expectedAmount ? money(r.expectedAmount, currency) : 'Variable'}
          {installment && (r.maxOccurrences !== null
            ? ` · Installment ${installment.number} of ${r.maxOccurrences}`
            : ` · Payment ${installment.number}`)}
          {projected ? ' · projected' : ''}
          {r.dueDay ? ` · due day ${r.dueDay}` : ''}
          {r.maxOccurrences === null && !installment ? ' · until switched off' : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {paid ? (
          <span className="flex items-center text-sm text-emerald-600"><Check className="mr-1 h-4 w-4"/>Paid</span>
        ) : r.active ? (
          <Button size="sm" variant={showOverdue ? 'destructive' : 'outline'} onClick={onPay}>
            Mark paid
          </Button>
        ) : (
          <Badge variant="muted">Off</Badge>
        )}
      </div>
    </div>
  )
}
