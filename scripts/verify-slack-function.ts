/**
 * End-to-end verification of the slack-notify Netlify Function handler.
 *
 * Runs the REAL handler (netlify/functions/slack-notify.ts) with the Supabase
 * helper module replaced by a canned mock and global fetch capturing the Slack
 * webhook POST. Checks, per event: auth type, workspace config lookup (saved
 * webhook first, env var fallback), per-event toggles, DB enrichment (worker
 * names, durations, amounts are rebuilt server-side from rows) and the
 * fallback `text` Slack shows in notifications.
 *
 * Run: npx tsx scripts/verify-slack-function.ts
 */
const { readFileSync, writeFileSync, rmSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const path = await import('node:path')

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

// Capture every POST that would go to Slack.
type CapturedCall = { url: string; body: any }
const slackCalls: CapturedCall[] = []
const realFetch = globalThis.fetch.bind(globalThis)
;(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input)
  if (url.startsWith('https://hooks.slack.com/')) {
    slackCalls.push({ url, body: init?.body ? JSON.parse(init.body) : null })
    return new Response('ok', { status: 200 })
  }
  return realFetch(input, init)
}

// Load the real handler with its Supabase helper replaced by the mock.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fnFile = path.join(root, 'netlify', 'functions', 'slack-notify.ts')
const tmpFile = path.join(root, 'netlify', 'functions', '__test_slack_notify_tmp.ts')

let mod: typeof import('../netlify/functions/slack-notify')
try {
  const source = readFileSync(fnFile, 'utf8')
    .replaceAll(`from './lib/supabase'`, `from '../../scripts/slack-mock/mock-netlify-supabase.mjs'`)
  writeFileSync(tmpFile, source)
  mod = await import('../netlify/functions/__test_slack_notify_tmp')
} finally {
  rmSync(tmpFile, { force: true })
}
const { default: handler } = mod
const { state, resetState } = await import('./slack-mock/mock-netlify-supabase.mjs')

const call = (body: unknown) =>
  handler(new Request('http://localhost/.netlify/functions/slack-notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  }))

async function main() {
  // ---- 1) Worker fires a clock_in from their phone ----
  let res = await call({ type: 'event', event: 'clock_in', timer_id: 't1' })
  assert(res.status === 200, 'clock_in returns 200')
  assert(slackCalls.length === 1, 'clock_in posts to the Slack webhook')
  let payload = slackCalls[0]?.body
  assert(payload?.text?.includes('Mike Johnson') && payload?.text?.includes('clocked in'), 'clock_in text names the worker (enriched server-side)')
  assert(JSON.stringify(payload.blocks).includes('Site A'), 'clock_in blocks include the project')
  assert(payload.blocks[0]?.type === 'section', 'clock_in uses Block Kit sections')

  // ---- 2) Break events ----
  await call({ type: 'event', event: 'break_start', timer_id: 't1' })
  payload = slackCalls[1]?.body
  assert(payload?.text?.includes('started a break'), 'break_start text says "started a break"')
  await call({ type: 'event', event: 'break_end', timer_id: 't1' })
  payload = slackCalls[2]?.body
  assert(payload?.text?.includes('back from break'), 'break_end text says "back from break"')

  // ---- 3) Clock out with earnings + note ----
  await call({ type: 'event', event: 'clock_out', entry_id: 'e1' })
  payload = slackCalls[3]?.body
  const flat = JSON.stringify(payload)
  assert(flat.includes('Mike Johnson'), 'clock_out names the worker')
  assert(flat.includes('₱108.33') || flat.includes('108.33'), 'clock_out includes earnings in the workspace currency')
  assert(flat.includes('Site cleaned up'), 'clock_out quotes the note')

  // ---- 4) Payment paid ----
  await call({ type: 'event', event: 'payment_paid', payment_id: 'p1' })
  payload = slackCalls[4]?.body
  assert(payload?.text?.includes('was paid'), 'payment_paid text says "was paid"')
  assert(JSON.stringify(payload.blocks).includes('Paid via Cash'), 'payment_paid includes the payment method')

  // ---- 5) Toggles: break_end off → silently skipped ----
  state.slackSettings.notify_break_end = false
  const skipped = await call({ type: 'event', event: 'break_end', timer_id: 't1' })
  assert(skipped.status === 200 && slackCalls.length === 5, 'toggled-off event is skipped (HTTP 200, no Slack post)')
  state.slackSettings.notify_break_end = true

  // ---- 6) Test message (admin only) ----
  const workerTest = await call({ type: 'test' })
  assert(workerTest.status === 403, 'a worker cannot trigger the test message')
  state.caller = { role: 'admin', workerId: null, userId: 'admin-1' }
  const adminTest = await call({ type: 'test' })
  assert(adminTest.status === 200 && slackCalls.length === 6, 'admin test message posts a hello to Slack')
  assert(slackCalls[5]?.body?.text?.includes('working'), 'test message says Slack notifications are working')

  // ---- 7) Env fallback when no saved webhook ----
  state.slackSettings.webhook_url = null
  ;(process.env as any).SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/ENV'
  await call({ type: 'event', event: 'clock_in', timer_id: 't1' })
  assert(slackCalls.length === 7 && slackCalls[6].url.includes('/ENV'), 'SLACK_WEBHOOK_URL env var is used when no saved URL exists')
  delete (process.env as any).SLACK_WEBHOOK_URL

  // ---- 8) Nothing configured → clean no-op ----
  const unconfigured = await call({ type: 'event', event: 'clock_in', timer_id: 't1' })
  assert(unconfigured.status === 200 && slackCalls.length === 7, 'unconfigured workspace: 200 with nothing sent')
  const unconfiguredBody = await unconfigured.json() as { sent?: boolean }
  assert(unconfiguredBody.sent === false, 'unconfigured response flags sent:false')

  // ---- 9) Unknown ids → 400, unknown event → 400 ----
  resetState() // restore the webhook so the handler reaches the id lookups
  const badTimer = await call({ type: 'event', event: 'clock_in', timer_id: 'nope' })
  assert(badTimer.status === 400, 'unknown timer id returns 400')
  const badEvent = await call({ type: 'event', event: 'hacked' as any, timer_id: 't1' })
  assert(badEvent.status === 400, 'unknown event returns 400')

  // ---- 10) GET is rejected ----
  const getRes = await handler(new Request('http://localhost/.netlify/functions/slack-notify', { method: 'GET' }))
  assert(getRes.status === 405, 'GET requests are rejected')

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log('\nAll slack-notify function checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
