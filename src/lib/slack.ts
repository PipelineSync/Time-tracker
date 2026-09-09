import type { SlackEvent } from './types'
import { SlackEventNames } from './types'
import { isSupabaseConfigured, getSupabaseAccessToken } from './supabaseDb'
import { localBackend } from './localDb'

// ============================================================================
// Slack notifications (client side).
//
// After a successful clock in / break / clock out / payment action the store
// calls notifySlack() fire-and-forget — it must never delay or break the
// action it mirrors, so every failure is swallowed (a warn in the console at
// most; Slack being down must not stop someone from clocking out).
//
// Two transports:
// - Supabase (deployed): POSTs just the event name + row id to the
//   slack-notify Netlify Function, which verifies the caller, reads the
//   webhook URL + toggles server-side, enriches the message from the database
//   and posts it. The webhook URL never reaches the browser.
// - Demo mode (no backend): posts a plain text message straight from the
//   browser to the webhook URL the admin saved in Settings → Slack, honouring
//   the per-event toggles. Fine for trying the integration locally.
// ============================================================================

export type SlackChannel = 'activity' | 'tasks' | 'approval'

export interface SlackEventRef {
  timer_id?: string
  entry_id?: string
  payment_id?: string
  task_id?: string
  previous_status?: string
  /** Plain-text fallback used by the demo-mode direct post only. */
  demoText?: string
}

/** Which configured webhook a Slack event is posted to. */
function webhookKeyForEvent(event: SlackEvent): 'webhook_url' | 'task_webhook_url' | 'approval_webhook_url' {
  if (event === 'task_created' || event === 'task_moved') return 'task_webhook_url'
  if (event === 'task_approval_created' || event === 'task_approval_moved') return 'approval_webhook_url'
  return 'webhook_url'
}

function toggleFor(settings: {
  notify_clock_in: boolean
  notify_clock_out: boolean
  notify_break_start: boolean
  notify_break_end: boolean
  notify_payment_paid: boolean
  notify_task_created: boolean
  notify_task_moved: boolean
  notify_task_approval_created: boolean
  notify_task_approval_moved: boolean
}, event: SlackEvent): boolean {
  switch (event) {
    case 'clock_in': return settings.notify_clock_in
    case 'clock_out': return settings.notify_clock_out
    case 'break_start': return settings.notify_break_start
    case 'break_end': return settings.notify_break_end
    case 'payment_paid': return settings.notify_payment_paid
    case 'task_created': return settings.notify_task_created
    case 'task_moved': return settings.notify_task_moved
    case 'task_approval_created': return settings.notify_task_approval_created
    case 'task_approval_moved': return settings.notify_task_approval_moved
  }
}

export function notifySlack(event: SlackEvent, ref: SlackEventRef): void {
  void notifySlackAsync(event, ref)
}

/** Awaitable core of notifySlack (exported for the verify scripts). */
export async function notifySlackAsync(event: SlackEvent, ref: SlackEventRef): Promise<void> {
  try {
    if (isSupabaseConfigured()) {
      const token = await getSupabaseAccessToken()
      if (!token) return
      const res = await fetch('/.netlify/functions/slack-notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type: 'event',
          event,
          timer_id: ref.timer_id,
          entry_id: ref.entry_id,
          payment_id: ref.payment_id,
          task_id: ref.task_id,
          previous_status: ref.previous_status,
        }),
        // Never let a slow Slack hold up the UI path that triggered this.
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) console.warn(`[work-tracker] Slack notification for ${event} failed:`, await res.text().catch(() => res.status))
      return
    }

      // Demo mode — post directly from the browser.
      // NOTE: the body is JSON, but the content type MUST be text/plain: a
      // browser POST with application/json triggers a CORS preflight that
      // hooks.slack.com does not answer, so the request fails before it is
      // ever sent ("Failed to fetch"). text/plain is CORS-safelisted (no
      // preflight) and Slack parses the JSON body all the same. The server
      // side keeps application/json — CORS does not apply there.
      const cfg = await localBackend.getSlackSettings()
      if (cfg.error || !cfg.data) return
      const url = cfg.data[webhookKeyForEvent(event)]?.trim()
      if (!url || !/^https:\/\/hooks\.slack\.com\//.test(url)) return
      if (!toggleFor(cfg.data, event)) return
      const text = ref.demoText || `${SlackEventNames[event]} happened.`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      })
    if (!res.ok) console.warn(`[work-tracker] Slack notification for ${event} failed:`, await res.text().catch(() => res.status))
  } catch (error) {
    console.warn(`[work-tracker] Slack notification for ${event} failed:`, error)
  }
}

/**
 * Admin "Send test message" button (Settings → Slack). Resolves with an error
 * string on failure, null on success — unlike notifySlack this one surfaces
 * problems so the admin can fix their setup.
 */
export async function sendSlackTestMessage(channel: SlackChannel = 'activity'): Promise<string | null> {
  try {
    if (isSupabaseConfigured()) {
      const token = await getSupabaseAccessToken()
      if (!token) return 'You are signed out — please sign in again.'
      const res = await fetch('/.netlify/functions/slack-notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: 'test', channel }),
        signal: AbortSignal.timeout(15_000),
      })
      const payload = await res.json().catch(() => ({})) as { error?: string; reason?: string }
      if (!res.ok) return payload.error || `Test failed (HTTP ${res.status}).`
      if (payload.reason) return payload.reason
      return null
    }
    // Demo mode: post a hello straight from the browser.
    const cfg = await localBackend.getSlackSettings()
    const url = channel === 'tasks'
      ? cfg.data?.task_webhook_url
      : channel === 'approval'
        ? cfg.data?.approval_webhook_url
        : cfg.data?.webhook_url
    const trimmed = url?.trim()
    const channelLabel = channel === 'tasks' ? 'task' : channel === 'approval' ? 'approval ' : ''
    if (!trimmed) return `Save the ${channelLabel}webhook URL first.`
    if (!/^https:\/\/hooks\.slack\.com\//.test(trimmed)) return 'That does not look like a Slack webhook URL (it should start with https://hooks.slack.com/).'
    const text = channel === 'tasks'
      ? '🧪 Task Slack automation is working! (demo mode)'
      : channel === 'approval'
        ? '🧪 Approval Slack automation is working! (demo mode)'
        : '👋 Slack notifications are working! (demo mode — sent from your browser)'
    const res = await fetch(trimmed, {
      method: 'POST',
      // text/plain, not application/json — see the CORS note in notifySlackAsync.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return `Slack responded ${res.status}. Check the webhook URL.`
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'Could not reach Slack.'
  }
}
