/**
 * Minimal mock of netlify/functions/lib/supabase.ts for verify-slack-function.ts.
 * It skips token verification and serves canned rows for the tables the
 * slack-notify function queries, so the handler is exercised for real
 * (config lookup, toggles, enrichment, Slack POST).
 *
 * State is a plain object the test script edits between scenarios.
 */
export const state = {
  // requireUser/requireAdmin result
  caller: { role: 'worker', workerId: 'w1', userId: 'auth-worker-1' },
  slackSettings: {
    user_id: 'admin-1',
    webhook_url: 'https://hooks.slack.com/services/T000/B000/TEST',
    notify_clock_in: true,
    notify_clock_out: true,
    notify_break_start: true,
    notify_break_end: true,
    notify_payment_paid: true,
  },
  settings: [{ user_id: 'admin-1', business_name: 'Acme Co', currency: 'PHP', timezone: 'Asia/Manila' }],
  workers: [{ id: 'w1', user_id: 'admin-1', name: 'Mike Johnson' }],
  timers: [
    {
      id: 't1',
      worker_id: 'w1',
      project: 'Site A',
      start_time: '2026-01-05T01:30:00.000Z',
      total_pause_ms: 15 * 60000,
      paused: false,
      pause_start: null,
      hourly_rate: 100,
    },
  ],
  entries: [
    {
      id: 'e1',
      worker_id: 'w1',
      project: 'Site A',
      total_minutes: 260,
      break_minutes: 30,
      hourly_rate: 100,
      earnings: 108.33,
      notes: 'Site cleaned up',
      end_time: '2026-01-05T06:00:00.000Z',
    },
  ],
  payments: [
    {
      id: 'p1',
      worker_id: 'w1',
      amount: 320,
      payment_method: 'cash',
      period_start: '2026-01-01T00:00:00.000Z',
      period_end: '2026-01-15T00:00:00.000Z',
      note: null,
    },
  ],
}

export function resetState() {
  state.caller = { role: 'worker', workerId: 'w1', userId: 'auth-worker-1' }
  state.slackSettings.notify_clock_in = true
  state.slackSettings.notify_clock_out = true
  state.slackSettings.notify_break_start = true
  state.slackSettings.notify_break_end = true
  state.slackSettings.notify_payment_paid = true
  state.slackSettings.webhook_url = 'https://hooks.slack.com/services/T000/B000/TEST'
}

export function json(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  })
}

const TABLES = {
  slack_settings: () => [state.slackSettings],
  settings: () => state.settings,
  workers: () => state.workers,
  active_timers: () => state.timers,
  time_entries: () => state.entries,
  payments: () => state.payments,
  profiles: () => [],
}

function from(table) {
  let rows = (TABLES[table] ? TABLES[table]() : []).map((r) => ({ ...r }))
  const builder = {
    select() {
      return builder
    },
    eq(col, val) {
      rows = rows.filter((r) => r[col] === val)
      return builder
    },
    order() {
      return builder
    },
    limit() {
      return builder
    },
    async maybeSingle() {
      return { data: rows[0] ?? null, error: null }
    },
    async single() {
      return { data: rows[0] ?? null, error: rows.length === 0 ? { message: 'row not found' } : null }
    },
    then(resolve, reject) {
      return builder.asyncAll().then(resolve, reject)
    },
    async asyncAll() {
      return { data: rows, error: null }
    },
  }
  return builder
}

export function adminClient() {
  return { from }
}

export async function requireUser() {
  return { sb: adminClient(), userId: state.caller.userId, role: state.caller.role, workerId: state.caller.workerId }
}

export async function requireAdmin() {
  if (state.caller.role !== 'admin') return { error: json(403, { error: 'Admin access required.' }) }
  return { sb: adminClient(), userId: 'admin-1', role: 'admin', workerId: null }
}
