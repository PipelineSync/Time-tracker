/**
 * Ad-hoc verification of the Finance section in demo mode (local storage):
 *  - the demo workspace ships a finance ledger with subscriptions, payroll
 *    runs and bills, each with a due date
 *  - the admin owns the ledger; a plain worker sees nothing and cannot write
 *  - `finance.view` opens the read (list only, never a mutation) — off by
 *    default, and revoking it closes the door again
 *  - `finance.manage` opens the writes; marking paid stamps and clears paid_at
 *  - kind shape rules: payroll needs a real worker + month and is unique per
 *    worker-month; subscriptions carry a cycle and advance by it
 *  - the permission list stays normalized (manage implies view)
 *
 * Run: npx tsx scripts/verify-finance-local.ts
 */
// Minimal browser stub so storage.ts works in Node.
const mem = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  },
}

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`ok: ${msg}`)
  }
}

function iso(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

async function main() {
  const { localBackend } = await import('../src/lib/localDb')
  const { PERMISSIONS, PERMISSION_PRESETS, normalizePermissions } = await import('../src/lib/types')
  const { advanceCycle, currentMonthKey, summarizeFinance, subscriptionsPerMonth } = await import('../src/lib/finance')

  // ---- 1. permission vocabulary -------------------------------------------
  assert(PERMISSIONS.includes('finance.view') && PERMISSIONS.includes('finance.manage'), 'finance permissions exist')
  assert(
    normalizePermissions(['finance.manage']).join(',') === 'finance.view,finance.manage',
    'finance.manage implies finance.view'
  )
  assert(
    PERMISSION_PRESETS.full.permissions.length === PERMISSIONS.length,
    'the Full access preset covers every capability (finance included)'
  )
  assert(
    PERMISSION_PRESETS.supervisor.permissions.every((p) => !p.startsWith('finance.')),
    'the Supervisor preset stays away from finance'
  )
  assert(PERMISSION_PRESETS.manager.permissions.includes('finance.view'), 'the Manager preset can read finance')
  assert(!PERMISSION_PRESETS.manager.permissions.includes('finance.manage'), 'the Manager preset cannot change finance')

  // ---- 2. the demo ledger ----------------------------------------------------
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')
  const items = (await localBackend.listFinanceItems()).data || []
  assert(items.length > 0, 'the demo seed ships a finance ledger')
  assert(
    items.some((f) => f.kind === 'subscription') && items.some((f) => f.kind === 'payroll') && items.some((f) => f.kind === 'bill'),
    'the seed covers all three kinds: subscriptions, payroll and bills'
  )
  assert(items.every((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.due_date)), 'every finance line carries a due date')
  const workers = (await localBackend.listWorkers()).data || []
  assert(
    items.filter((f) => f.kind === 'payroll').every((f) => f.worker_id && workers.some((w) => w.id === f.worker_id)),
    'seeded payroll lines point at seeded workers'
  )
  const summary = summarizeFinance(items)
  assert(subscriptionsPerMonth(items) > 0 && summary.owedPayroll > 0, 'the ledger summaries compute from the seed')

  // ---- 3. admin CRUD + the paid stamp ----------------------------------------
  const due = iso(new Date(Date.now() + 5 * 86400_000))
  const sub = (await localBackend.createFinanceItem({ kind: 'subscription', name: 'Figma', amount: 45, cycle: 'monthly', due_date: due })).data!
  assert(!!sub && sub.status === 'active' && sub.cycle === 'monthly', 'admin adds a subscription')
  const noName = await localBackend.createFinanceItem({ kind: 'subscription', name: '  ', amount: 1, due_date: due })
  assert(!!noName.error, 'a subscription without a name is refused')
  const noDue = await localBackend.createFinanceItem({ kind: 'bill', name: 'Mystery', amount: 10, due_date: '' })
  assert(!!noDue.error, 'a bill without a due date is refused')

  const billed = (await localBackend.updateFinanceItem(sub.id, { due_date: advanceCycle(due, 'monthly') })).data!
  assert(billed.due_date.startsWith(due.slice(0, 7)) === false, 'advancing a monthly subscription moves it to the next month')
  const feb = advanceCycle('2026-01-31', 'monthly')
  assert(feb === '2026-02-28', 'monthly rollover clamps to the end of short months')

  const bill = (await localBackend.createFinanceItem({ kind: 'bill', name: 'Rent', amount: 800, due_date: due })).data!
  const paid = (await localBackend.updateFinanceItem(bill.id, { status: 'paid' })).data!
  assert(paid.status === 'paid' && !!paid.paid_at, 'marking a bill paid stamps paid_at')
  const unpaid = (await localBackend.updateFinanceItem(bill.id, { status: 'unpaid' })).data!
  assert(unpaid.status === 'unpaid' && !unpaid.paid_at, 'marking it unpaid clears the stamp')

  // ---- 4. payroll shape rules --------------------------------------------------
  // Use a month the demo seed does not occupy (it seeds last month paid +
  // this month unpaid), so the uniqueness check below tests my row, not the seed's.
  const ym = '2021-03'
  assert(ym !== currentMonthKey(), 'the test month differs from the seeded one')
  const pay = (await localBackend.createFinanceItem({ kind: 'payroll', worker_id: workers[0].id, period_month: ym, amount: 1000, due_date: due })).data!
  assert(!!pay && pay.period_month === ym && pay.kind === 'payroll', 'admin logs a payroll run for a worker-month')
  const payDupe = await localBackend.createFinanceItem({ kind: 'payroll', worker_id: workers[0].id, period_month: ym, amount: 50, due_date: due })
  assert(!!payDupe.error && payDupe.error.includes('already has a payroll line'), 'one payroll run per worker per month')
  const payNoWorker = await localBackend.createFinanceItem({ kind: 'payroll', worker_id: 'nobody', period_month: ym, amount: 10, due_date: due })
  assert(!!payNoWorker.error, 'payroll must reference a real worker')
  await localBackend.deleteFinanceItem(pay.id)
  assert(
    (await localBackend.listFinanceItems()).data?.every((f) => f.id !== pay.id) === true,
    'admin can delete a finance line'
  )

  // ---- 5. a plain worker sees nothing of the ledger ----------------------------
  const pat = (await localBackend.createWorker({ name: 'Plain Pat', hourly_rate: 15, accountEmail: 'pat@example.com', accountPassword: 'worker123' })).data!
  await localBackend.signIn('pat@example.com', 'worker123')
  assert(((await localBackend.listFinanceItems()).data || []).length === 0, 'a plain worker gets an empty ledger (Finance is admin-only by default)')
  const patAdds = await localBackend.createFinanceItem({ kind: 'bill', name: 'Sneaky', amount: 1, due_date: due })
  assert(!!patAdds.error && patAdds.error.includes('permission'), 'they cannot add finance lines either')

  // ---- 6. finance.view opens the read, not the writes --------------------------
  await localBackend.signIn('admin', 'admin.pipelinesync')
  await localBackend.updateWorker(pat.id, { permissions: ['finance.view'] })
  await localBackend.signIn('pat@example.com', 'worker123')
  const viewed = await localBackend.listFinanceItems()
  assert(!viewed.error && (viewed.data || []).length >= 3, 'the grant takes effect without a re-sign-in and opens the whole ledger')
  const patAdds2 = await localBackend.createFinanceItem({ kind: 'bill', name: 'Still no', amount: 1, due_date: due })
  assert(!!patAdds2.error && patAdds2.error.includes('permission'), 'view access cannot write')
  const patPays = await localBackend.updateFinanceItem(sub.id, { due_date: due })
  assert(!!patPays.error, 'view access cannot edit either')
  assert((await localBackend.deleteFinanceItem(sub.id)).error !== null, 'view access cannot delete')

  // ---- 7. finance.manage opens the writes; revoking closes everything ----------
  await localBackend.signIn('admin', 'admin.pipelinesync')
  await localBackend.updateWorker(pat.id, { permissions: ['finance.view', 'finance.manage'] })
  await localBackend.signIn('pat@example.com', 'worker123')
  const managed = await localBackend.createFinanceItem({ kind: 'bill', name: 'Pat was here', amount: 3, due_date: due })
  assert(!managed.error && !!managed.data, 'finance.manage can add lines')
  const advanced = await localBackend.updateFinanceItem(sub.id, { due_date: iso(new Date(Date.now() + 40 * 86400_000)) })
  assert(!advanced.error, 'finance.manage can edit lines')
  assert(!(await localBackend.deleteFinanceItem(managed.data!.id)).error, 'finance.manage can delete lines')

  await localBackend.signIn('admin', 'admin.pipelinesync')
  await localBackend.updateWorker(pat.id, { permissions: [] })
  await localBackend.signIn('pat@example.com', 'worker123')
  assert(((await localBackend.listFinanceItems()).data || []).length === 0, 'revoking finance.view closes the ledger again')
  assert((await localBackend.deleteFinanceItem(sub.id)).error !== null, 'and the writes with it')

  // ---- 8. a finance viewer still resolves the worker names ----------------------
  await localBackend.signIn('admin', 'admin.pipelinesync')
  await localBackend.updateWorker(pat.id, { permissions: ['finance.view'] })
  await localBackend.signIn('pat@example.com', 'worker123')
  const seenWorkers = (await localBackend.listWorkers()).data || []
  assert(seenWorkers.length >= workers.length && seenWorkers.some((w) => w.id === pat.id), 'finance.view also opens the worker list (payroll is about people)')
  assert(((await localBackend.listPayments()).data || []).every((p) => p.worker_id === pat.id), '…but payments stay private without payments.view_all')

  console.log(process.exitCode ? '\nSome finance checks FAILED.' : '\nAll finance checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
