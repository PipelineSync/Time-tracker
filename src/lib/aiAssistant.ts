/**
 * Browser side of the AI assistant (server: netlify/functions/ai-chat.ts).
 *
 * The conversation is kept exactly as the server returns it — the server
 * needs it unchanged — and saved per device and per account in this browser
 * only. Nothing about the chat is stored on the server.
 */
import { getSupabaseAccessToken } from './supabaseDb'
import { storage } from './storage'

/** A Claude API message, kept opaque: the server owns its shape. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ChatBlock[]
}

export interface ChatBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
  [key: string]: unknown
}

export interface PendingAction {
  id: string
  name: string
  title: string
  input: Record<string, unknown>
}

export type StepResponse =
  | { status: 'continue'; messages: ChatMessage[] }
  | { status: 'done'; messages: ChatMessage[]; notice?: string }
  | { status: 'approval'; messages: ChatMessage[]; pending: PendingAction[] }

export class AssistantError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

const KEY = (userId: string) => `wt_ai_chat:${userId}`

export function loadChat(userId: string): ChatMessage[] {
  try {
    const raw = storage.getItem(KEY(userId))
    const parsed = raw ? (JSON.parse(raw) as { messages?: ChatMessage[] }) : null
    return Array.isArray(parsed?.messages) ? parsed!.messages : []
  } catch {
    return []
  }
}

export function saveChat(userId: string, messages: ChatMessage[]): void {
  try {
    if (messages.length === 0) storage.removeItem(KEY(userId))
    else storage.setItem(KEY(userId), JSON.stringify({ messages }))
  } catch {
    /* storage full or blocked — the chat simply is not remembered */
  }
}

/** One step of the conversation on the server. */
export async function sendStep(
  messages: ChatMessage[],
  decisions?: Record<string, 'approve' | 'reject'>,
): Promise<StepResponse> {
  const token = await getSupabaseAccessToken()
  if (!token) throw new AssistantError('Sign in again to use the assistant.', 'unauthorized')
  let res: Response
  try {
    res = await fetch('/.netlify/functions/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages, decisions }),
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    throw new AssistantError("Couldn't reach the assistant. Check your connection and try again.", 'network')
  }
  const body = (await res.json().catch(() => null)) as (StepResponse & { error?: string; message?: string }) | null
  if (!res.ok || !body || body.error) {
    throw new AssistantError(body?.message || 'The assistant could not answer. Try again.', body?.error || 'http_' + res.status)
  }
  return body
}

/** Is this user message a typed message (not tool results)? */
export function isTypedUserMessage(m: ChatMessage): boolean {
  return m.role === 'user' && (typeof m.content === 'string' || m.content.every((b) => b.type === 'text'))
}

export function messageText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content
  return m.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n')
}

/** "list_time_entries" → "List time entries". */
export function toolLabel(name: string): string {
  const words = name.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
