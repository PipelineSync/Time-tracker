import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowDownLeft, ArrowLeft, ArrowLeftRight, ArrowUpRight, Building2, Check, Download, LayoutDashboard, List, Plus, RefreshCw, Settings, WalletCards } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { accountBalance, currentPeriod, emptyPFData, loadPersonalFinance, money, normalizePFData, pfId, recordRecurringRun, savePersonalFinance, today, type PFData, type PFAccount } from '@/lib/personalFinance'

type View = 'dashboard' | 'accounts' | 'activity' | 'recurring' | 'reports' | 'settings'
type EntryKind = 'income' | 'expense' | 'transfer'
const monthStart = () => `${currentPeriod()}-01`
const NAV: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Overview', icon: LayoutDashboard }, { id: 'accounts', label: 'Accounts', icon: WalletCards },
  { id: 'activity', label: 'Transactions', icon: List }, { id: 'recurring', label: 'Recurring', icon: RefreshCw },
  { id: 'reports', label: 'Reports', icon: Building2 }, { id: 'settings', label: 'Manage lists', icon: Settings },
]

export function PersonalFinancePage() {
  const { user, workers, settings } = useStore()
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
  const [editAccount, setEditAccount] = useState<PFAccount | null>(null)
  const [reconcileAccount, setReconcileAccount] = useState<PFAccount | null>(null)
  const [deleteTx, setDeleteTx] = useState<{ type: 'income' | 'expense' | 'transfer'; id: string } | null>(null)
  const [payRecurring, setPayRecurring] = useState<PFData['recurring'][number] | null>(null)
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [accountFilter, setAccountFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [kindFilter, setKindFilter] = useState('all')
  const [paidFilter, setPaidFilter] = useState('all')

  useEffect(() => {
    if (!user) return
    setReady(false)
    loadPersonalFinance(user.id)
      .then(res => { setData(res.data); setStale(res.stale) })
      .catch(e => toast.error(e instanceof Error ? e.message : 'Could not load your personal tracker.'))
      .finally(() => setReady(true))
  }, [user])
  const commit = async (next: PFData) => { const normalized = normalizePFData(next); setData(normalized); if (!user) return; try { await savePersonalFinance(user.id, normalized) } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save') } }
  const workerName = user?.workerId ? workers.find(w => w.id === user?.workerId)?.name : null
  const displayName = workerName || user?.email.split('@')[0] || 'My'
  const activeAccounts = data.accounts.filter(a => !a.archived)
  const activeRecurring = data.recurring.filter(r => r.active)
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
  const setRecurringActive = (id: string, active: boolean) => {
    void commit({
      ...data,
      recurring: data.recurring.map(item => item.id === id ? { ...item, active } : item),
    })
  }
  if (!ready) return <div className="py-20 text-center text-muted-foreground">Loading your private tracker…</div>

  return <div className="min-h-screen bg-background"><header className="border-b bg-card"><div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6"><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground"><WalletCards className="h-5 w-5"/></span><div><p className="font-bold">{displayName}'s Personal Tracker</p><p className="text-xs text-muted-foreground">Private finance workspace</p></div></div><Button variant="outline" size="sm" onClick={()=>navigate('/')}><ArrowLeft className="mr-2 h-4 w-4"/>Work tracker</Button></div></header>
    {stale && <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">Couldn't reach the server just now — you're looking at your last saved data, not necessarily the latest.</div>}
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 pb-24 sm:px-6">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold uppercase tracking-[.2em] text-primary">Private workspace</p><h1 className="text-3xl font-bold tracking-tight">{displayName}'s Personal Tracker</h1><p className="text-muted-foreground">Your accounts, spending and income—all in one place.</p></div><div className="flex flex-wrap gap-2"><Button onClick={()=>setEntry('expense')}><ArrowUpRight className="mr-2 h-4 w-4"/>Expense</Button><Button variant="outline" onClick={()=>setEntry('income')}><ArrowDownLeft className="mr-2 h-4 w-4"/>Income</Button><Button variant="outline" onClick={()=>setEntry('transfer')}><ArrowLeftRight className="mr-2 h-4 w-4"/>Transfer</Button></div></div>
    <div className="flex gap-1 overflow-x-auto rounded-xl border bg-card p-1">{NAV.map(n=><Button key={n.id} variant={view===n.id?'default':'ghost'} size="sm" onClick={()=>setView(n.id)} className="shrink-0"><n.icon className="mr-2 h-4 w-4"/>{n.label}</Button>)}</div>

    {view==='dashboard' && <><div className="grid gap-4 md:grid-cols-3"><Metric label="Total balance" value={m(total)} tone="blue"/><Metric label="Money in this month" value={m(moneyIn)} tone="green"/><Metric label="Money out this month" value={m(moneyOut)} tone="orange"/></div><div className="grid gap-6 lg:grid-cols-3"><Card className="lg:col-span-2"><CardHeader className="flex-row items-center justify-between"><CardTitle>Your accounts</CardTitle><Button size="sm" variant="outline" onClick={()=>setAccountOpen(true)}><Plus className="mr-1 h-4 w-4"/>Add</Button></CardHeader><CardContent><AccountGrid data={data} currency={currency}/>{!activeAccounts.length&&<Empty text="Add your first bank or e-wallet account."/>}</CardContent></Card><Card><CardHeader><CardTitle>Recurring this month</CardTitle></CardHeader><CardContent className="space-y-3">{activeRecurring.slice(0,6).map(r=><RecurringRow key={r.id} r={r} data={data} currency={currency} onPay={()=>setPayRecurring(r)}/>)}{!activeRecurring.length&&<Empty text="No active recurring payments."/>}</CardContent></Card></div></>}

    {view==='accounts' && <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Accounts</CardTitle><p className="text-sm text-muted-foreground">Balances calculate automatically from paid transactions and transfers.</p></div><Button onClick={()=>setAccountOpen(true)}><Plus className="mr-2 h-4 w-4"/>Add account</Button></CardHeader><CardContent><AccountGrid data={data} currency={currency} manage onArchive={(id)=>commit({...data,accounts:data.accounts.map(a=>a.id===id?{...a,archived:!a.archived}:a)})} onEdit={(id)=>{const a=data.accounts.find(x=>x.id===id);if(a)setEditAccount(a)}} onReconcile={(id)=>{const a=data.accounts.find(x=>x.id===id);if(a)setReconcileAccount(a)}}/><div className="mt-6 rounded-xl bg-primary p-5 text-primary-foreground"><p className="text-sm opacity-80">Total available</p><p className="text-3xl font-bold">{m(total)}</p></div></CardContent></Card>}

    {view==='activity' && <Card><CardHeader><CardTitle>Transactions</CardTitle></CardHeader><CardContent className="space-y-2">{[...data.incomes.map(x=>({id:x.id,date:x.date,title:data.sources.find(s=>s.id===x.sourceId)?.name||'Income',amount:x.amount,type:'income' as const})),...data.expenses.map(x=>({id:x.id,date:x.date,title:x.name,amount:-x.amount,type:'expense' as const})),...data.transfers.map(x=>({id:x.id,date:x.date,title:`${data.accounts.find(a=>a.id===x.fromId)?.name} → ${data.accounts.find(a=>a.id===x.toId)?.name}`,amount:0,type:'transfer' as const}))].sort((a,b)=>b.date.localeCompare(a.date)).map(x=><div key={`${x.type}-${x.id}`} className="flex items-center justify-between rounded-lg border p-3"><div><p className="font-medium">{x.title}</p><p className="text-xs text-muted-foreground">{x.date} · {x.type}</p></div><div className="flex items-center gap-3"><span className={x.amount>0?'text-emerald-600':x.amount<0?'text-rose-600':'text-muted-foreground'}>{x.amount?m(x.amount):'Internal'}</span><Button size="sm" variant="ghost" onClick={()=>setDeleteTx({type:x.type,id:x.id})}>Delete</Button></div></div>)}{!data.incomes.length&&!data.expenses.length&&!data.transfers.length&&<Empty text="No transactions match these filters."/>}</CardContent></Card>}

    {view==='recurring' && <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Recurring payments</CardTitle><p className="text-sm text-muted-foreground">Marking one paid creates an expense and counts one run.</p></div><Button onClick={()=>setRecurringOpen(true)}><Plus className="mr-2 h-4 w-4"/>Add</Button></CardHeader><CardContent className="space-y-3">{data.recurring.map(r=><RecurringRow key={r.id} r={r} data={data} currency={currency} detailed onPay={()=>setPayRecurring(r)} onToggle={active=>setRecurringActive(r.id,active)}/>)}{!data.recurring.length&&<Empty text="Add bills, loans, and subscriptions you pay regularly."/>}</CardContent></Card>}

    {view==='reports' && <div className="space-y-5"><Card><CardContent className="pt-6"><AccountGrid data={data} currency={currency}/><div className="mt-4 flex justify-between rounded-lg bg-muted p-4 font-semibold"><span>Total across accounts</span><span>{m(total)}</span></div></CardContent></Card><Card><CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-6"><Field label="From"><Input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></Field><Field label="To"><Input type="date" value={to} onChange={e=>setTo(e.target.value)}/></Field><Filter value={accountFilter} set={setAccountFilter} label="Account" items={data.accounts}/><Filter value={categoryFilter} set={setCategoryFilter} label="Category" items={data.categories}/><Filter value={kindFilter} set={setKindFilter} label="Type" items={[{id:'income',name:'Income'},{id:'expense',name:'Expense'}]}/><Filter value={paidFilter} set={setPaidFilter} label="Paid status" items={[{id:'true',name:'Paid'},{id:'false',name:'Unpaid'}]}/></CardContent></Card><div className="grid gap-4 md:grid-cols-3"><Metric label="Money in" value={m(moneyIn)} tone="green"/><Metric label="Money out" value={m(moneyOut)} tone="orange"/><Metric label="Net" value={m(moneyIn-moneyOut)} tone="blue"/></div><Card><CardHeader className="flex-row items-center justify-between"><CardTitle>Spending by category</CardTitle><Button variant="outline" onClick={exportCsv}><Download className="mr-2 h-4 w-4"/>Export CSV</Button></CardHeader><CardContent className="space-y-4">{categories.filter(c=>c.total>0).map(c=><div key={c.id}><div className="mb-1 flex justify-between text-sm"><span>{c.name}</span><b>{m(c.total)}</b></div><div className="h-3 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{width:`${moneyOut?Math.max(3,c.total/moneyOut*100):0}%`}}/></div></div>)}{!moneyOut&&<Empty text="No spending matches these filters."/>}</CardContent></Card></div>}

    {view==='settings' && <div className="grid gap-6 md:grid-cols-2"><ListManager title="Expense categories" items={data.categories} onAdd={name=>commit({...data,categories:[...data.categories,{id:pfId(),name}]})} onRemove={id=>removeListItem('categories',id)}/><ListManager title="Income sources" items={data.sources} onAdd={name=>commit({...data,sources:[...data.sources,{id:pfId(),name}]})} onRemove={id=>removeListItem('sources',id)}/></div>}
    <AccountDialog open={accountOpen} close={()=>setAccountOpen(false)} data={data} commit={commit}/>
    <EntryDialog kind={entry} close={()=>setEntry(null)} data={data} commit={commit}/>
    <RecurringDialog open={recurringOpen} close={()=>setRecurringOpen(false)} data={data} commit={commit}/>
    {editAccount && <EditAccountDialog account={editAccount} close={()=>setEditAccount(null)} data={data} commit={commit}/>}
    {reconcileAccount && <ReconcileDialog account={reconcileAccount} data={data} currency={currency} close={()=>setReconcileAccount(null)} commit={commit}/>}
    <ConfirmDialog open={!!deleteTx} onOpenChange={v=>{if(!v)setDeleteTx(null)}} title={deleteTxTitle} description="The transaction will be removed from your tracker. This cannot be undone." confirmLabel="Delete" onConfirm={doDeleteTx}/>
    {payRecurring && <PayRecurringDialog recurring={payRecurring} data={data} close={()=>setPayRecurring(null)} commit={commit}/>}
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
function PayRecurringDialog({recurring,data,close,commit}:{recurring:PFData['recurring'][number];data:PFData;close:()=>void;commit:(d:PFData)=>void}) {
  const accounts = data.accounts.filter(a => !a.archived)
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!recurring.active) {
      toast.error('Turn this recurring payment on before recording another run.')
      return
    }
    if (data.expenses.some(expense => expense.recurringId === recurring.id && expense.period === currentPeriod())) {
      toast.error('This recurring payment is already recorded for the current month.')
      close()
      return
    }
    const form = new FormData(e.currentTarget)
    const accountId = String(form.get('account'))
    if (!data.accounts.some(account => account.id === accountId && !account.archived)) {
      toast.error('Choose an active account.')
      return
    }
    const amount = Number(form.get('amount'))
    if (!(amount > 0)) {
      toast.error('Enter an amount greater than zero.')
      return
    }

    const nextRecurring = recordRecurringRun(recurring)
    void commit({
      ...data,
      recurring: data.recurring.map(item => item.id === recurring.id ? nextRecurring : item),
      expenses: [...data.expenses, {
        id: pfId(),
        date: today(),
        name: recurring.name,
        categoryId: recurring.categoryId,
        amount,
        accountId,
        paid: true,
        note: 'Recurring payment',
        recurringId: recurring.id,
        period: currentPeriod(),
      }],
    })

    if (recurring.maxOccurrences !== null && nextRecurring.runCount >= recurring.maxOccurrences) {
      toast.success(`Final payment (${nextRecurring.runCount} of ${recurring.maxOccurrences}) recorded — “${recurring.name}” is now off.`)
    } else {
      toast.success(`Payment ${nextRecurring.runCount} recorded.`)
    }
    close()
  }

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent>
        <DialogHeader><DialogTitle>Pay {recurring.name}</DialogTitle></DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <Picker name="account" label="Pay from" items={accounts} initial={recurring.accountId}/>
          <Field label="Amount paid">
            <Input name="amount" type="number" min="0.01" step="0.01" required defaultValue={String(recurring.expectedAmount || '')}/>
          </Field>
          {recurring.maxOccurrences !== null && (
            <p className="text-xs text-muted-foreground">
              This will be run {Math.min(recurring.runCount + 1, recurring.maxOccurrences)} of {recurring.maxOccurrences}.
              {recurring.runCount + 1 >= recurring.maxOccurrences && ' It will turn off after this payment.'}
            </p>
          )}
          <Button className="w-full" disabled={!accounts.length}>Mark paid</Button>
          {!accounts.length && <p className="text-xs text-destructive">Add an account first.</p>}
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
  const accounts = data.accounts.filter(account => !account.archived)

  useEffect(() => {
    if (!open) return
    setLimitMode('off')
    setOccurrences('12')
  }, [open])

  const occurrenceValue = (() => {
    if (limitMode !== 'count') return null
    const value = Number(occurrences)
    return Number.isInteger(value) && value >= 1 ? value : null
  })()

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
      return toast.error('Enter how many runs will occur — a whole number of 1 or more.')
    }

    const amountText = String(form.get('amount') ?? '')
    const expectedAmount = amountText ? Number(amountText) : null
    if (expectedAmount !== null && !(expectedAmount > 0)) return toast.error('Enter an expected amount greater than zero.')
    const dayText = String(form.get('day') ?? '')
    const dueDay = dayText ? Number(dayText) : null
    if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)) {
      return toast.error('Enter a due day from 1 to 31.')
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
      }],
    })
    toast.success('Recurring payment added.')
    close()
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add recurring payment</DialogTitle>
          <DialogDescription>Track a monthly payment and choose when its runs should end.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <Field label="Name"><Input name="name" required autoFocus/></Field>
          <CategoryField categories={data.categories}/>
          <Picker name="account" label="Usual account" items={accounts}/>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Expected amount"><Input name="amount" type="number" min="0.01" step="0.01"/></Field>
            <Field label="Due day"><Input name="day" type="number" min="1" max="31" step="1"/></Field>
          </div>
          <Field label="Runs">
            <Select value={limitMode} onValueChange={value => setLimitMode(value as 'off' | 'count')}>
              <SelectTrigger aria-label="Recurring payment run limit"><SelectValue/></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Until switched off</SelectItem>
                <SelectItem value="count">For a set number of payments</SelectItem>
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
                  aria-label="How many recurring payment runs"
                />
                <span className="text-xs text-muted-foreground">
                  {occurrenceValue === 1 ? 'payment, then it turns off' : 'payments, then it turns off'}
                </span>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">It stays active until you switch it off.</p>
            )}
            <p className="text-xs text-muted-foreground">The first payment you mark paid counts as run 1.</p>
          </Field>
          <Button className="w-full" disabled={!accounts.length}>Add recurring payment</Button>
          {!accounts.length && <p className="text-xs text-destructive">Add an account first.</p>}
        </form>
      </DialogContent>
    </Dialog>
  )
}
function RecurringRow({r,data,currency,detailed,onPay,onToggle}:{r:PFData['recurring'][number];data:PFData;currency:string;detailed?:boolean;onPay:()=>void;onToggle?:(active:boolean)=>void}) {
  const paid = data.expenses.some(expense => expense.recurringId === r.id && expense.period === currentPeriod())
  const finished = r.maxOccurrences !== null && r.runCount >= r.maxOccurrences
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="font-medium">{r.name}</p>
          {r.maxOccurrences !== null && (
            <Badge variant="muted" className="whitespace-nowrap text-[10px]">
              {Math.min(r.runCount, r.maxOccurrences)}/{r.maxOccurrences} paid
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {r.expectedAmount ? money(r.expectedAmount, currency) : 'Variable'}
          {r.dueDay ? ` · due day ${r.dueDay}` : ''}
          {r.maxOccurrences === null ? ' · until switched off' : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {detailed && onToggle && (
          <Switch
            checked={r.active}
            disabled={finished}
            title={finished ? 'All configured runs are complete.' : undefined}
            aria-label={finished ? `${r.name} completed all configured runs` : `${r.active ? 'Switch off' : 'Switch on'} ${r.name}`}
            onCheckedChange={onToggle}
          />
        )}
        {paid ? (
          <span className="flex items-center text-sm text-emerald-600"><Check className="mr-1 h-4 w-4"/>Paid</span>
        ) : r.active ? (
          <Button size="sm" variant={detailed ? 'default' : 'outline'} onClick={onPay}>Mark paid</Button>
        ) : (
          <Badge variant="muted">Off</Badge>
        )}
      </div>
    </div>
  )
}
