/**
 * Ad-hoc verification of subscription occurrence limits in demo mode (local
 * storage):
 *  - creating a subscription with a limit stores it; validation refuses bad ones
 *  - "billed" = due date rolled forward: the count climbs
 *  - moving the date back (a correction) never counts
 *  - reaching the limit pauses the subscription by itself
 *  - a subscription with no limit keeps billing until switched off
 *  - the limit can be changed or cleared later
 *
 * Run: npx tsx scripts/verify-subscription-occurrences-local.ts
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

async function main() {
  const { localBackend, ADMIN_EMAIL, ADMIN_PASSWORD } = await import('../src/lib/localDb')

  const admin = await localBackend.signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')

  const today = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const inMonths = (n: number) => {
    const d = new Date(today.getFullYear(), today.getMonth() + n, 5)
    return iso(d)
  }

  // ---- 1. creating with a limit -------------------------------------------
  const bad = await localBackend.createFinanceItem({
    kind: 'subscription', name: 'Bad limit', amount: 10, cycle: 'monthly', due_date: iso(today), max_occurrences: 0,
  })
  assert(!!bad.error, 'a limit below 1 is refused')
  const bad2 = await localBackend.createFinanceItem({
    kind: 'subscription', name: 'Bad limit', amount: 10, cycle: 'monthly', due_date: iso(today), max_occurrences: 2.5,
  })
  assert(!!bad2.error, 'a fractional limit is refused')

  const sub = (await localBackend.createFinanceItem({
    kind: 'subscription', name: 'Occurrence verify', amount: 10, cycle: 'monthly', due_date: iso(today),
    max_occurrences: 3,
  })).data!
  assert(sub.max_occurrences === 3 && sub.billed_count === 0, 'creating with a limit stores it, counter at zero')

  const open = (await localBackend.createFinanceItem({
    kind: 'subscription', name: 'Open-ended verify', amount: 10, cycle: 'monthly', due_date: iso(today),
  })).data!
  assert(open.max_occurrences === null, 'omitting the limit means "runs until switched off"')

  // ---- 2. billing counts forward moves ------------------------------------
  const b1 = (await localBackend.updateFinanceItem(sub.id, { due_date: inMonths(1) })).data!
  assert(b1.billed_count === 1 && b1.status === 'active', 'first billing counts 1, still active')
  const back = (await localBackend.updateFinanceItem(sub.id, { due_date: iso(today) })).data!
  assert(back.billed_count === 1, 'moving the due date back (a correction) does not count')
  const b2 = (await localBackend.updateFinanceItem(sub.id, { due_date: inMonths(2) })).data!
  assert(b2.billed_count === 2 && b2.status === 'active', 'second billing counts 2, still active')

  // ---- 3. the last bill pauses it by itself -------------------------------
  const b3 = (await localBackend.updateFinanceItem(sub.id, { due_date: inMonths(3) })).data!
  assert(b3.billed_count === 3, 'third billing counts 3')
  assert(b3.status === 'paused', 'reaching the limit pauses the subscription by itself')

  // ---- 4. unlimited subscriptions never self-pause ------------------------
  const o1 = (await localBackend.updateFinanceItem(open.id, { due_date: inMonths(9) })).data!
  assert(o1.billed_count === 1 && o1.status === 'active', 'a subscription with no limit keeps billing')

  // ---- 5. the limit can be changed or cleared later -----------------------
  const extended = (await localBackend.updateFinanceItem(sub.id, { status: 'active', max_occurrences: 5 })).data!
  assert(extended.max_occurrences === 5 && extended.status === 'active', 'raising the limit re-activates the subscription')
  const cleared = (await localBackend.updateFinanceItem(sub.id, { max_occurrences: null })).data!
  assert(cleared.max_occurrences === null && cleared.status === 'active', 'clearing the limit returns it to "until switched off"')

  // ---- 6. payroll and bills ignore the limit entirely ---------------------
  const billRefused = await localBackend.createFinanceItem({
    kind: 'bill', name: 'Occurrence bill', amount: 5, due_date: iso(today), max_occurrences: 4,
  })
  assert(!!billRefused.error, 'a bill cannot carry an occurrence limit (only subscriptions can)')
  const bill = (await localBackend.createFinanceItem({
    kind: 'bill', name: 'Occurrence bill', amount: 5, due_date: iso(today),
  })).data!
  assert(bill.max_occurrences === null && bill.billed_count === 0, 'non-subscription lines never carry a limit')

  // Clean up so other scripts' assumptions (finance totals) stay stable.
  await localBackend.deleteFinanceItem(sub.id)
  await localBackend.deleteFinanceItem(open.id)
  await localBackend.deleteFinanceItem(bill.id)

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
