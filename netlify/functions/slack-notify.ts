import { adminClient, json, requireUser, requireAdmin } from './lib/supabase'
import type { SlackEvent } from '../../src/lib/types'

// ============================================================================
// Slack notifications — server-side mirror of workspace activity.
//
// The frontend fires this fire-and-forget after a successful action:
//   clock in · clock out · break start · back from break · payment paid
//
// Why a server function? The Slack webhook URL is a secret: anyone who has it
// can post into the channel. Workers trigger clock events, so the URL must
// never reach the browser — this function reads it server-side (from the
// `slack_settings` row, falling back to the SLACK_WEBHOOK_URL env var) and
// builds the message from fresh database rows, so a client can never forge
// names or amounts.
//
// POST { type: 'event', event: 'clock_in' | ... , timer_id? entry_id? payment_id? }
//       — any signed-in member (workers clock in/out).
// POST { type: 'test' } — admin only: sends a sample message to verify setup.
// ============================================================================

const EVENTS: SlackEvent[] = ['clock_in', 'clock_out', 'break_start', 'break_end', 'payment_paid']

const FALLBACK_TIMEZONE = 'UTC'
const WEBHOOK_TIMEOUT_MS = 8_000

// ---------------------------------------------------------------------------
// Formatting helpers (workspace timezone + currency come from the settings row)
// ---------------------------------------------------------------------------

function tzFormatter(timezone: string, opts: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...opts })
  } catch {
    // Invalid IANA timezone in settings — fall back rather than throwing.
    return new Intl.DateTimeFormat('en-US', { timeZone: FALLBACK_TIMEZONE, ...opts })
  }
}

function fmtTime(iso: string, timezone: string): string {
  try {
    return tzFormatter(timezone, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
  } catch {
    return iso
  }
}

function fmtDate(iso: string, timezone: string): string {
  try {
    return tzFormatter(timezone, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso))
  } catch {
    return iso.slice(0, 10)
  }
}

/** 245 -> "4h 05m" */
function fmtDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h === 0) return `${rest}m`
  return `${h}h ${String(rest).padStart(2, '0')}m`
}

function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

// ---------------------------------------------------------------------------
// Slack message building (Block Kit; `text` is the plain-text fallback the
// notification preview shows)
// ---------------------------------------------------------------------------

interface SlackBlock {
  type: string
  [key: string]: unknown
}

export function buildMessage(event: SlackEvent, ctx: {
  businessName: string
  workerName: string
  timezone: string
  currency: string
  // clock events
  project?: string | null
  timerStart?: string | null
  workedMinutes?: number | null
  breakMinutes?: number | null
  breakLengthMinutes?: number | null
  hourlyRate?: number | null
  earnings?: number | null
  note?: string | null
  endedAt?: string | null
  // payment event
  amount?: number | null
  paidVia?: string | null
  periodStart?: string | null
  periodEnd?: string | null
}): { text: string; blocks: SlackBlock[] } {
  const project = ctx.project?.trim() || null
  const projectBit = project ? ` · ${project}` : ''
  const bizBit = ctx.businessName ? ` · ${ctx.businessName}` : ''

  const section = (text: string): SlackBlock => ({ type: 'section', text: { type: 'mrkdwn', text } })
  const context = (text: string): SlackBlock => ({
    type: 'context',
    elements: [{ type: 'mrkdwn', text }],
  })

  switch (event) {
    case 'clock_in': {
      const detail = [ctx.timerStart ? `since ${fmtTime(ctx.timerStart, ctx.timezone)}` : null, project]
        .filter(Boolean)
        .join(' · ')
      return {
        text: `🟢 ${ctx.workerName} just clocked in${bizBit}`,
        blocks: [
          section(`🟢 *${ctx.workerName}* just clocked in`),
          context([detail || null, bizBit.replace(/^ · /, '')].filter(Boolean).join(' · ') || '—'),
        ],
      }
    }
    case 'break_start': {
      const worked = ctx.workedMinutes != null ? `${fmtDuration(ctx.workedMinutes)} worked so far` : null
      const detail = [ctx.timerStart ? `on the clock since ${fmtTime(ctx.timerStart, ctx.timezone)}` : null, worked]
        .filter(Boolean)
        .join(' · ')
      return {
        text: `☕ ${ctx.workerName} started a break${bizBit}`,
        blocks: [
          section(`☕ *${ctx.workerName}* started a break`),
          context([detail || null, bizBit.replace(/^ · /, '')].filter(Boolean).join(' · ') || '—'),
        ],
      }
    }
    case 'break_end': {
      const brk = ctx.breakLengthMinutes != null ? ` (${fmtDuration(ctx.breakLengthMinutes)})` : ''
      return {
        text: `▶️ ${ctx.workerName} is back from break${bizBit}`,
        blocks: [
          section(`▶️ *${ctx.workerName}* is back from break${brk}`),
          context([ctx.timerStart ? `on the clock since ${fmtTime(ctx.timerStart, ctx.timezone)}` : null, bizBit.replace(/^ · /, '')].filter(Boolean).join(' · ') || '—'),
        ],
      }
    }
    case 'clock_out': {
      const parts = [
        ctx.workedMinutes != null ? `Worked *${fmtDuration(ctx.workedMinutes)}*` : null,
        ctx.breakMinutes ? `break ${fmtDuration(ctx.breakMinutes)}` : null,
        ctx.earnings != null ? `Earned *${fmtMoney(ctx.earnings, ctx.currency)}*` : null,
        ctx.hourlyRate != null ? `@ ${fmtMoney(ctx.hourlyRate, ctx.currency)}/hr` : null,
      ].filter(Boolean)
      if (ctx.endedAt) parts.push(`Clocked out at ${fmtTime(ctx.endedAt, ctx.timezone)}`)
      const blocks: SlackBlock[] = [
        section(`✅ *${ctx.workerName}* clocked out`),
        context([parts.join(' · '), project].filter(Boolean).join(' · ') || '—'),
      ]
      if (ctx.note?.trim()) blocks.push(section(`> _"${ctx.note.trim().slice(0, 300)}_"`))
      return {
        text: `✅ ${ctx.workerName} clocked out (${ctx.workedMinutes != null ? fmtDuration(ctx.workedMinutes) : '—'})${bizBit}`,
        blocks,
      }
    }
    case 'payment_paid': {
      const amount = ctx.amount != null ? `*${fmtMoney(ctx.amount, ctx.currency)}*` : 'a payment'
      const detail = [
        ctx.periodStart && ctx.periodEnd ? `${fmtDate(ctx.periodStart, ctx.timezone)} – ${fmtDate(ctx.periodEnd, ctx.timezone)}` : null,
        ctx.paidVia ? `Paid via ${ctx.paidVia}` : null,
      ].filter(Boolean).join(' · ')
      const blocks: SlackBlock[] = [
        section(`💸 *${ctx.workerName}* was paid ${amount}`),
      ]
      if (detail) blocks.push(context(`${detail}${bizBit.replace(/^ · /, ' · ')}`))
      if (ctx.note?.trim()) blocks.push(section(`> _"${ctx.note.trim().slice(0, 300)}_"`))
      return {
        text: `💸 ${ctx.workerName} was paid ${ctx.amount != null ? fmtMoney(ctx.amount, ctx.currency) : ''}${bizBit}`,
        blocks,
      }
    }
  }
}

async function postToSlack(webhookUrl: string, payload: { text: string; blocks: SlackBlock[] }): Promise<string | null> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })
    if (res.ok) return null
    const body = await res.text().catch(() => '')
    return `Slack responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`
  } catch (error) {
    return error instanceof Error ? error.message : 'Could not reach Slack.'
  }
}

// ---------------------------------------------------------------------------
// Database enrichment — build the message context from fresh rows so the
// client only ever sends ids (never names or amounts it could make up).
// ---------------------------------------------------------------------------

interface WorkspaceContext {
  businessName: string
  currency: string
  timezone: string
}

async function loadWorkspaceContext(sb: ReturnType<typeof adminClient>, ownerId: string): Promise<WorkspaceContext> {
  const { data } = await sb.from('settings').select('business_name, currency, timezone').eq('user_id', ownerId).maybeSingle()
  return {
    businessName: data?.business_name || 'Work Tracker',
    currency: data?.currency || 'USD',
    timezone: data?.timezone || FALLBACK_TIMEZONE,
  }
}

async function workerName(sb: ReturnType<typeof adminClient>, workerId: string | null | undefined): Promise<string> {
  if (!workerId) return 'Unknown'
  const { data } = await sb.from('workers').select('name').eq('id', workerId).maybeSingle()
  return data?.name || 'Unknown'
}

export default async function handler(request: Request) {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })

  const body = await request.json().catch(() => ({})) as {
    type?: 'event' | 'test'
    event?: SlackEvent
    timer_id?: string
    entry_id?: string
    payment_id?: string
  }
  const type = body.type === 'test' ? 'test' : 'event'

  // ---- auth ----
  const auth = type === 'test' ? await requireAdmin(request) : await requireUser(request)
  if ('error' in auth) return auth.error
  const { sb, userId, role, workerId } = auth

  try {
    // ---- resolve the workspace owner (the admin whose config applies) ----
    let ownerId = userId
    if (role === 'worker') {
      const { data: worker } = await sb.from('workers').select('user_id').eq('id', workerId ?? '').maybeSingle()
      if (!worker?.user_id) return json(400, { error: 'Worker not found.' })
      ownerId = worker.user_id
    }

    // ---- load config: saved webhook first, SLACK_WEBHOOK_URL env as fallback ----
    const { data: cfg } = await sb.from('slack_settings').select('*').eq('user_id', ownerId).maybeSingle()
    const webhookUrl =
      (cfg?.webhook_url || '').trim() ||
      (process.env.SLACK_WEBHOOK_URL || '').trim()
    if (!webhookUrl) return json(200, { ok: false, sent: false, reason: 'Slack is not configured yet.' })

    if (type === 'test') {
      const ws = await loadWorkspaceContext(sb, ownerId)
      const blocks: SlackBlock[] = [
        { type: 'section', text: { type: 'mrkdwn', text: `👋 Slack notifications are working!` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Clock ins, clock outs, breaks and payments will be posted here · ${ws.businessName}` }] },
      ]
      const err = await postToSlack(webhookUrl, { text: `👋 Slack notifications are working! (${ws.businessName})`, blocks })
      if (err) return json(502, { error: err })
      return json(200, { ok: true, sent: true })
    }

    // ---- event toggle check ----
    const event = body.event
    if (!event || !EVENTS.includes(event)) return json(400, { error: 'Unknown event type.' })
    const enabled: Record<SlackEvent, boolean | undefined> = {
      clock_in: cfg?.notify_clock_in,
      clock_out: cfg?.notify_clock_out,
      break_start: cfg?.notify_break_start,
      break_end: cfg?.notify_break_end,
      payment_paid: cfg?.notify_payment_paid,
    }
    // No saved row at all => every event defaults to enabled.
    if (cfg && enabled[event] === false) {
      return json(200, { ok: true, sent: false, reason: `${event} notifications are turned off.` })
    }

    // ---- enrich + build ----
    const ws = await loadWorkspaceContext(sb, ownerId)
    let message: { text: string; blocks: SlackBlock[] } | null = null

    if (event === 'clock_in' || event === 'break_start' || event === 'break_end') {
      const { data: timer } = await sb.from('active_timers').select('*').eq('id', body.timer_id ?? '').maybeSingle()
      if (!timer) return json(400, { error: 'Timer not found.' })
      const name = await workerName(sb, timer.worker_id)
      const breakSoFarMin = Math.round((timer.total_pause_ms ?? 0) / 60000) + (timer.paused && timer.pause_start ? Math.round((Date.now() - new Date(timer.pause_start).getTime()) / 60000) : 0)
      message = buildMessage(event, {
        businessName: ws.businessName,
        workerName: name,
        timezone: ws.timezone,
        currency: ws.currency,
        project: timer.project,
        timerStart: timer.start_time,
        workedMinutes: event === 'break_start'
          ? Math.max(0, Math.round((Date.now() - new Date(timer.start_time).getTime()) / 60000) - breakSoFarMin)
          : null,
        breakLengthMinutes: event === 'break_end' && timer.pause_start
          ? Math.max(0, Math.round((Date.now() - new Date(timer.pause_start).getTime()) / 60000))
          : null,
        hourlyRate: timer.hourly_rate,
      })
    } else if (event === 'clock_out') {
      const { data: entry } = await sb.from('time_entries').select('*').eq('id', body.entry_id ?? '').maybeSingle()
      if (!entry) return json(400, { error: 'Time entry not found.' })
      const name = await workerName(sb, entry.worker_id)
      message = buildMessage('clock_out', {
        businessName: ws.businessName,
        workerName: name,
        timezone: ws.timezone,
        currency: ws.currency,
        project: entry.project,
        workedMinutes: entry.total_minutes,
        breakMinutes: entry.break_minutes,
        hourlyRate: entry.hourly_rate,
        earnings: entry.earnings,
        note: entry.notes,
        endedAt: entry.end_time,
      })
    } else if (event === 'payment_paid') {
      const { data: payment } = await sb.from('payments').select('*').eq('id', body.payment_id ?? '').maybeSingle()
      if (!payment) return json(400, { error: 'Payment not found.' })
      const name = await workerName(sb, payment.worker_id)
      message = buildMessage('payment_paid', {
        businessName: ws.businessName,
        workerName: name,
        timezone: ws.timezone,
        currency: ws.currency,
        amount: payment.amount,
        paidVia: payment.payment_method === 'qr' ? 'QR code' : payment.payment_method === 'cash' ? 'Cash' : null,
        periodStart: payment.period_start,
        periodEnd: payment.period_end,
        note: payment.note,
      })
    }

    if (!message) return json(400, { error: 'Nothing to send.' })

    const err = await postToSlack(webhookUrl, message)
    if (err) return json(502, { error: err })
    return json(200, { ok: true, sent: true })
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : 'Server error.' })
  }
}
