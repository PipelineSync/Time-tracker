/**
 * Ad-hoc verification of the Slack notifications feature in demo mode
 * (browser-local storage), plus the Slack message formatting used by the
 * slack-notify Netlify Function.
 *
 * Checks:
 *  - buildMessage() renders every event (clock in / break / clock out /
 *    payment paid) with the worker's name, durations, amounts and notes.
 *  - Slack settings round-trip through the local backend (admin only).
 *  - notifySlack() posts to the configured webhook and honours the per-event
 *    toggles; a worker's session can neither read nor save the webhook URL.
 *  - "Send test message" succeeds with a webhook and fails with a helpful
 *    message without one.
 *
 * Run: npx tsx scripts/verify-slack-local.ts
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

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

// ---------------------------------------------------------------------------
// Capture every POST that would go to Slack.
// ---------------------------------------------------------------------------
type CapturedCall = { url: string; body: any; contentType: string }
const slackCalls: CapturedCall[] = []
const realFetch = globalThis.fetch.bind(globalThis)
;(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input)
  if (url.startsWith('https://hooks.slack.com/')) {
    const headers = new Headers(init?.headers || {})
    slackCalls.push({
      url,
      body: init?.body ? JSON.parse(init.body) : null,
      contentType: headers.get('content-type') ?? '',
    })
    return new Response('ok', { status: 200 })
  }
  return realFetch(input, init)
}

// ---------------------------------------------------------------------------
// Load src/lib/slack.ts with the Supabase module replaced by the demo-mode
// mock (Vite's import.meta.env does not exist under Node).
// ---------------------------------------------------------------------------
const { readFileSync, writeFileSync, rmSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const path = await import('node:path')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcFile = path.join(root, 'src', 'lib', 'slack.ts')
const tmpFile = path.join(root, 'src', 'lib', '__test_slack_tmp.ts')

let slack: typeof import('../src/lib/slack')
try {
  const source = readFileSync(srcFile, 'utf8')
    .replaceAll(`from './supabaseDb'`, `from '../../scripts/slack-mock/mock-slack-supabase.mjs'`)
  writeFileSync(tmpFile, source)
  slack = await import('../src/lib/__test_slack_tmp')
} finally {
  rmSync(tmpFile, { force: true })
}

const { localBackend } = await import('../src/lib/localDb')
const { buildMessage } = await import('../netlify/functions/slack-notify')

const ctx = {
  businessName: 'Acme Co',
  workerName: 'Mike Johnson',
  timezone: 'Asia/Manila',
  currency: 'PHP',
  project: 'Site A',
  timerStart: '2026-01-05T01:30:00.000Z', // 9:30 AM in Manila
  workedMinutes: 260,
  breakMinutes: 30,
  breakLengthMinutes: 12,
  hourlyRate: 100,
  earnings: 108.33,
  note: 'Site cleaned up',
  endedAt: '2026-01-05T06:00:00.000Z',
  amount: 320,
  paidVia: 'Cash',
  periodStart: '2026-01-01T00:00:00.000Z',
  periodEnd: '2026-01-15T00:00:00.000Z',
}

const blocksText = (m: { text: string; blocks: any[] }) =>
  m.text + '\n' + m.blocks.map((b) => JSON.stringify(b)).join('\n')

async function main() {
  // ---- 1) Message formatting (shared with the Netlify Function) ----
  const clockIn = buildMessage('clock_in', ctx)
  assert(clockIn.text.includes('Mike Johnson'), 'clock_in fallback text names the worker')
  assert(blocksText(clockIn).includes('clocked in'), 'clock_in says "clocked in"')

  const breakStart = buildMessage('break_start', ctx)
  assert(blocksText(breakStart).includes('started a break'), 'break_start says "started a break"')
  assert(blocksText(breakStart).includes('4h 20m'), 'break_start shows time worked so far')

  const breakEnd = buildMessage('break_end', ctx)
  assert(blocksText(breakEnd).includes('back from break (12m)'), 'break_end includes the break length')

  const clockOut = buildMessage('clock_out', ctx)
  assert(blocksText(clockOut).includes('clocked out'), 'clock_out says "clocked out"')
  assert(blocksText(clockOut).includes('4h 20m'), 'clock_out shows worked time (break excluded)')
  assert(blocksText(clockOut).includes('₱108.33'), 'clock_out shows earnings in workspace currency')
  assert(blocksText(clockOut).includes('Site cleaned up'), 'clock_out quotes the worker note')

  const payment = buildMessage('payment_paid', ctx)
  assert(blocksText(payment).includes('was paid'), 'payment_paid says "was paid"')
  assert(blocksText(payment).includes('₱320.00'), 'payment_paid shows the amount')
  assert(blocksText(payment).includes('Paid via Cash'), 'payment_paid shows the payment method')

  // ---- 2) Settings round-trip (admin) ----
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const saved = await localBackend.saveSlackSettings({ webhook_url: 'https://hooks.slack.com/services/T000/B000/TEST ' })
  assert(!saved.error && saved.data?.webhook_url === 'https://hooks.slack.com/services/T000/B000/TEST', 'admin saves the webhook URL (trimmed)')
  const loaded = await localBackend.getSlackSettings()
  assert(!loaded.error && loaded.data?.webhook_url?.includes('hooks.slack.com'), 'admin reads the webhook URL back')
  assert(loaded.data?.notify_payment_paid === true, 'events default to enabled')

  // ---- 3) notifySlack sends for enabled events (demo transport) ----
  await slack.notifySlackAsync('clock_in', { demoText: '🟢 Mike Johnson just clocked in — Site A.' })
  assert(slackCalls.length === 1 && slackCalls[0].body?.text?.includes('Mike Johnson just clocked in'), 'clock_in posts the demo text to the webhook')
  assert(slackCalls[0].contentType.startsWith('text/plain'), 'browser posts use text/plain (application/json would die on the CORS preflight Slack never answers)')

  // ---- 4) Toggled-off events are not sent ----
  await localBackend.saveSlackSettings({ notify_break_end: false })
  await slack.notifySlackAsync('break_end', { demoText: '▶️ back from break' })
  assert(slackCalls.length === 1, 'break_end with its toggle OFF is not sent')

  await localBackend.saveSlackSettings({ notify_break_end: true })
  await slack.notifySlackAsync('break_end', { demoText: '▶️ Mike is back from break.' })
  assert(slackCalls.length === 2, 'break_end with its toggle ON is sent')

  // ---- 5) Test message ----
  const testErr = await slack.sendSlackTestMessage()
  assert(testErr === null && slackCalls.length === 3, 'sendSlackTestMessage posts a hello to the webhook')

  await localBackend.saveSlackSettings({ webhook_url: null })
  const noUrlErr = await slack.sendSlackTestMessage()
  assert(typeof noUrlErr === 'string' && noUrlErr.length > 0, 'test without a webhook returns a helpful error')
  await slack.notifySlackAsync('clock_out', { demoText: '✅ gone' })
  assert(slackCalls.length === 3, 'no webhook configured → nothing is sent')

  // ---- 6) Workers never see (or can change) the Slack webhook ----
  const created = await localBackend.createWorker({
    name: 'Mike Johnson',
    email: 'mike.slack@example.com',
    hourly_rate: 100,
    status: 'active',
    accountEmail: 'mike.slack@example.com',
    accountPassword: 'secret123',
  })
  assert(!created.error, 'test worker account created')
  await localBackend.signOut()
  const workerIn = await localBackend.signIn('mike.slack@example.com', 'secret123')
  assert(!workerIn.error && workerIn.data?.role === 'worker', 'worker signs in')
  const workerCfg = await localBackend.getSlackSettings()
  assert(Boolean(workerCfg.error), 'worker cannot read Slack settings')
  const workerSave = await localBackend.saveSlackSettings({ webhook_url: 'https://hooks.slack.com/services/EVIL' })
  assert(Boolean(workerSave.error), 'worker cannot change Slack settings')
  await slack.notifySlackAsync('clock_in', { demoText: '🟢 from worker' })
  assert(slackCalls.length === 3, 'worker sessions do not post to Slack directly')

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log('\nAll Slack notification checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
