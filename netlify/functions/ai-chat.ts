/**
 * POST /ai-chat — the in-app AI assistant (the chat widget in the app).
 *
 * The browser sends the signed-in user's own Supabase access token, the
 * conversation so far, and — when an action is waiting — the user's
 * Approve / Cancel decisions. This function performs one step of the
 * conversation (see lib/ai/assistant.ts) and returns the updated history.
 *
 * It needs ANTHROPIC_API_KEY (server-only — never a VITE_* variable) in
 * Netlify → Site configuration → Environment variables. The admin can turn
 * the assistant off for the whole workspace in Settings → Appearance.
 */
import Anthropic from '@anthropic-ai/sdk'
import { AuthError, callerFromSupabaseToken } from './lib/mcp/session'
import { step, type Decision, type Message } from './lib/ai/assistant'

/** Largest request body accepted, in characters (the history travels in it). */
const MAX_BODY_CHARS = 1_500_000

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function fail(status: number, code: string, message: string): Response {
  return json({ error: code, message }, status)
}

function isMessageList(value: unknown): value is Message[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (m) =>
        m &&
        typeof m === 'object' &&
        ((m as Message).role === 'user' || (m as Message).role === 'assistant') &&
        (typeof (m as Message).content === 'string' || Array.isArray((m as Message).content)),
    ) &&
    (value[0] as Message).role === 'user'
  )
}

function readDecisions(value: unknown): Record<string, Decision> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, Decision> = {}
  for (const [id, d] of Object.entries(value as Record<string, unknown>)) {
    if (d === 'approve' || d === 'reject') out[id] = d
  }
  return out
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  if (!process.env.ANTHROPIC_API_KEY) {
    return fail(
      503,
      'not_configured',
      'The AI assistant is not set up yet. An admin needs to add ANTHROPIC_API_KEY in the Netlify environment variables.',
    )
  }

  const header = request.headers.get('authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (!token) return fail(401, 'unauthorized', 'Sign in to use the assistant.')

  const raw = await request.text()
  if (raw.length > MAX_BODY_CHARS) {
    return fail(413, 'too_large', 'This conversation is too long. Start a new chat.')
  }
  let body: { messages?: unknown; decisions?: unknown }
  try {
    body = JSON.parse(raw)
  } catch {
    return fail(400, 'bad_request', 'The request was not valid JSON.')
  }
  if (!isMessageList(body.messages)) return fail(400, 'bad_request', 'Send the conversation as "messages".')

  let caller
  try {
    caller = await callerFromSupabaseToken(token)
  } catch (error) {
    if (error instanceof AuthError) return fail(401, 'unauthorized', 'Your session expired. Sign in again.')
    throw error
  }

  // The workspace switch. Read through the user's own client, so this is the
  // same settings row the app shows them.
  const { data: settings } = await caller.sb.from('settings').select('*').maybeSingle()
  const row = (settings ?? {}) as { ai_assistant_enabled?: boolean | null; timezone?: string | null }
  if (row.ai_assistant_enabled === false) {
    return fail(403, 'disabled', 'The admin has turned the AI assistant off for this workspace.')
  }

  try {
    const result = await step(caller, body.messages, readDecisions(body.decisions), row.timezone ?? null)
    return json(result)
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return fail(429, 'rate_limited', 'The assistant is busy right now. Try again in a minute.')
    }
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      console.error('[ai-chat] Anthropic key rejected', error.status)
      return fail(503, 'not_configured', 'The AI assistant key is not valid. An admin needs to check ANTHROPIC_API_KEY.')
    }
    if (error instanceof Anthropic.BadRequestError) {
      console.error('[ai-chat] bad request', error.message)
      return fail(400, 'bad_request', 'The assistant could not read this conversation. Start a new chat.')
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return fail(504, 'timeout', 'The assistant took too long to answer. Try again, or ask something smaller.')
    }
    if (error instanceof Anthropic.APIError) {
      console.error('[ai-chat] Anthropic API error', error.status, error.message)
      return fail(502, 'upstream', 'The assistant is unavailable right now. Try again shortly.')
    }
    console.error('[ai-chat] failed', error)
    return fail(500, 'internal', 'Something went wrong. Try again.')
  }
}
