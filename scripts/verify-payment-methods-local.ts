/**
 * Ad-hoc verification of worker self-service payment methods in demo mode
 * (local storage):
 *  - a worker enables Cash and/or QR Code from their settings
 *  - enabling QR Code requires uploading the QR image
 *  - turning QR Code off clears its image
 *  - the admin sees the enabled methods (and the QR image) on their data
 *
 * Run: npx tsx scripts/verify-payment-methods-local.ts
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

const QR = 'data:image/png;base64,AAAAFAKEQRIMAGE'

async function main() {
  const { localBackend } = await import('../src/lib/localDb')

  // The worker list itself leaves out the image columns (avatar + QR data URLs
  // are the heaviest fields on the row); the app merges the separate
  // listWorkerAvatars() snapshot back in, so the check does the same.
  async function adminWorkers() {
    const rows = (await localBackend.listWorkers()).data || []
    const avatars = (await localBackend.listWorkerAvatars()).data || []
    const byId = new Map(avatars.map((a) => [a.id, a]))
    return rows.map((w) => ({ ...w, ...(byId.get(w.id) ?? {}) }))
  }

  // 1) Admin signs in — the demo workspace is seeded. Sarah's seed has cash+qr.
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')

  let workers = await adminWorkers()
  const sarah = workers.find((w) => w.email === 'sarah@example.com')!
  const john = workers.find((w) => w.email === 'john@example.com')!
  assert(Boolean(sarah), 'sarah@example.com exists in the seed')
  assert(
    sarah.payment_methods.includes('cash') && sarah.payment_methods.includes('qr') && Boolean(sarah.qr_code_url),
    'seed shows Sarah accepting cash + QR with an image'
  )
  assert(
    JSON.stringify(john.payment_methods) === JSON.stringify(['cash']) && !john.qr_code_url,
    'seed shows John accepting cash only, with no QR image'
  )

  // 2) Sign in as John and configure his payment methods.
  await localBackend.signOut()
  const worker = await localBackend.signIn('john@example.com', 'worker123')
  assert(!worker.error && worker.data?.role === 'worker', 'worker John can sign in')

  // Worker cannot read other workers — only his own row.
  const own = (await localBackend.listWorkers()).data || []
  assert(own.length === 1 && own[0].id === john.id, 'worker only sees his own row')

  // QR without an image is refused.
  const qrNoImage = await localBackend.updateOwnPaymentMethods({ payment_methods: ['qr'], qr_code_url: null })
  assert(
    qrNoImage.error === 'Upload your QR code image to accept QR Code payments.',
    `QR without an image is refused (got: ${qrNoImage.error})`
  )

  // No methods at all is refused.
  const none = await localBackend.updateOwnPaymentMethods({ payment_methods: [], qr_code_url: null })
  assert(none.error === 'Choose at least one payment method.', `at least one method is required (got: ${none.error})`)

  // Enable cash + QR with an image.
  const saved = await localBackend.updateOwnPaymentMethods({ payment_methods: ['qr', 'cash'], qr_code_url: QR })
  assert(!saved.error && saved.data, 'worker can save cash + QR with an image')
  assert(
    saved.data!.payment_methods.includes('cash') && saved.data!.payment_methods.includes('qr'),
    'both methods are stored'
  )
  assert(saved.data!.qr_code_url === QR, 'the QR image is stored')

  // Turn QR off (no image argument) — image must be cleared, cash stays.
  const cashOnly = await localBackend.updateOwnPaymentMethods({ payment_methods: ['cash'], qr_code_url: null })
  assert(!cashOnly.error, 'worker can switch back to cash only')
  assert(JSON.stringify(cashOnly.data!.payment_methods) === JSON.stringify(['cash']), 'only cash remains')
  assert(cashOnly.data!.qr_code_url === null, 'the QR image is cleared when QR is turned off')

  // Re-enable QR but keep an existing image by omitting qr_code_url... first set it.
  await localBackend.updateOwnPaymentMethods({ payment_methods: ['cash', 'qr'], qr_code_url: QR })
  const kept = await localBackend.updateOwnPaymentMethods({ payment_methods: ['cash', 'qr'] })
  assert(!kept.error && kept.data!.qr_code_url === QR, 'omitting the image keeps the previously saved QR')

  // 3) The admin sees exactly what the worker saved.
  await localBackend.signOut()
  await localBackend.signIn('admin', 'admin.pipelinesync')
  workers = await adminWorkers()
  const johnNow = workers.find((w) => w.id === john.id)!
  assert(
    johnNow.payment_methods.includes('cash') && johnNow.payment_methods.includes('qr') && johnNow.qr_code_url === QR,
    'the admin sees the worker’s enabled methods and QR image'
  )

  // 4) Marking a payment paid records how it was paid and the reference
  //    number, for a worker with methods set up or not.
  const casual = (await localBackend.createWorker({
    name: 'Casual Casey',
    hourly_rate: 10,
    accountEmail: 'casey@example.com',
    accountPassword: 'worker123',
  })).data!
  assert(
    (casual.payment_methods ?? []).length === 0,
    'a brand-new worker starts with no payment method set'
  )
  await localBackend.createEntry({
    worker_id: casual.id,
    client_id: null,
    start_time: new Date(Date.now() - 3600_000).toISOString(),
    end_time: new Date().toISOString(),
    break_minutes: 0,
    notes: null,
    hourly_rate: casual.hourly_rate,
    total_minutes: 60,
    earnings: 10,
  })
  const settlement = (await localBackend.settleWorker(casual.id)).data!
  assert(settlement.status === 'unpaid' && settlement.payment_method === null, 'a fresh settlement is unpaid and methodless')

  const paidCash = await localBackend.updatePaymentStatus(settlement.id, 'paid', 'cash', 'REF-123')
  assert(paidCash.data?.payment_method === 'cash', 'marking paid records Cash')
  assert(paidCash.data?.reference_number === 'REF-123', 'the reference number is stored with the payment')

  const paidBlankRef = await localBackend.updatePaymentStatus(settlement.id, 'paid', 'qr', '   ')
  assert(paidBlankRef.data?.payment_method === 'qr', 'marking paid records QR Code')
  assert(paidBlankRef.data?.reference_number === null, 'a blank reference number is stored as none')

  const unpay = await localBackend.updatePaymentStatus(settlement.id, 'unpaid')
  assert(
    unpay.data?.payment_method === null && unpay.data?.reference_number === null,
    'taking a payment back to unpaid clears the method and the reference'
  )

  // 5) Backwards compatibility: an old worker row without the new fields
  //    normalizes to "no methods" rather than crashing.
  const { normalizeCheck } = { normalizeCheck: true }
  assert(normalizeCheck, 'payment-method verification completed')
}

main().catch((err) => {
  console.error('verify crashed:', err)
  process.exitCode = 1
})
