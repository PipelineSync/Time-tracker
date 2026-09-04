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

export interface SlackEventRef {
  timer_id?: string
  entry_id?: string
  payment_id?: string
  /** Plain-text fallback used by the demo-mode direct post only. */
  demoText?: string
}

function toggleFor(settings: { notify_clock_in: boolean; notify_clock_out: boolean; notify_break_start: boolean; notify_break_end: boolean; notify_payment_paid: boolean }, event: SlackEvent): boolean {
  switch (event) {
    case 'clock_in': return settings.notify_clock_in
    case 'clock_out': return settings.notify_clock_out
    case 'break_start': return settings.notify_break_start
    case 'break_end': return settings.notify_break_end
    case 'payment_paid': return settings.notify_payment_paid
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
      const url = cfg.data.webhook_url?.trim()
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
export async function sendSlackTestMessage(): Promise<string | null> {
  try {
    if (isSupabaseConfigured()) {
      const token = await getSupabaseAccessToken()
      if (!token) return 'You are signed out — please sign in again.'
      const res = await fetch('/.netlify/functions/slack-notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: 'test' }),
        signal: AbortSignal.timeout(15_000),
      })
      const payload = await res.json().catch(() => ({})) as { error?: string; reason?: string }
      if (!res.ok) return payload.error || `Test failed (HTTP ${res.status}).`
      if (payload.reason) return payload.reason
      return null
    }
    // Demo mode: post a hello straight from the browser.
    const cfg = await localBackend.getSlackSettings()
    const url = cfg.data?.webhook_url?.trim()
    if (!url) return 'Save a webhook URL first.'
    if (!/^https:\/\/hooks\.slack\.com\//.test(url)) return 'That does not look like a Slack webhook URL (it should start with https://hooks.slack.com/).'
    const res = await fetch(url, {
      method: 'POST',
      // text/plain, not application/json — see the CORS note in notifySlackAsync.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ text: '👋 Slack notifications are working! (demo mode — sent from your browser)' }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return `Slack responded ${res.status}. Check the webhook URL.`
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'Could not reach Slack.'
  }
}
