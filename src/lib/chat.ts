import type { ChatMember, ChatMessage, Role } from './types'
import { formatDate } from './utils'

/** Role label shown next to a member's name: the admin, or a worker's trade. */
export function roleLabel(role: Role, position?: string | null): string {
  if (role === 'admin') return 'Admin'
  const trade = position?.trim()
  return trade && trade.length > 0 ? trade : 'Worker'
}

/**
 * Who sent a chat message, for display: profile picture, name and role.
 *
 * Messages snapshot the author's identity when they were posted, but the member
 * list is fresher (it is re-read with the chat), so a worker who uploads a new
 * profile picture is shown with it on every message — including older ones.
 */
export function resolveChatAuthor(
  message: ChatMessage,
  members: ChatMember[]
): { name: string; role: Role; position: string | null; avatarUrl: string | null } {
  const member =
    members.find((m) => m.user_id && m.user_id === message.author_id) ??
    (message.worker_id ? members.find((m) => m.worker_id === message.worker_id) : undefined)
  if (member) {
    return { name: member.name, role: member.role, position: member.position, avatarUrl: member.avatar_url }
  }
  return {
    name: message.author_name,
    role: message.author_role,
    position: message.author_position,
    avatarUrl: message.author_avatar_url,
  }
}

// ---------- Sticker messages ----------
/**
 * A sticker message is ordinary chat text that happens to be a token:
 * `[sticker:side-eye-cat]`.
 *
 * Storing a token instead of an image is deliberate: the chat table stays
 * exactly as it is (no migration, no upload bucket, no signed URLs), it works
 * identically in the local demo backend and offline, and the raw body still
 * reads sensibly anywhere the token is not rendered — the notification bell, a
 * search, an export. The picture behind a slug is resolved by the client from
 * the bundled sticker pack (see `lib/stickers.ts`); an unknown slug simply
 * stays visible as its label, so a message never turns into a broken image.
 */
// Underscores are accepted too, so a hand-written token still resolves to a
// label instead of showing raw markup.
const STICKER_TOKEN_SOURCE = '\\[sticker:([a-z0-9]+(?:[-_][a-z0-9]+)*)\\]'
const STICKER_TOKEN_GLOBAL = new RegExp(STICKER_TOKEN_SOURCE, 'g')

/** A sticker slug: lowercase words joined by single hyphens. */
export function stickerSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** The body a sticker message is sent with. */
export function stickerToken(slug: string): string {
  return `[sticker:${slug}]`
}

/** "side-eye-cat" -> "Side eye cat" — the label used in previews and alt text. */
export function stickerLabel(slug: string): string {
  const words = slug.split(/[-_]+/).filter(Boolean)
  if (words.length === 0) return 'Sticker'
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')
}

export function isStickerToken(body: string): boolean {
  return new RegExp(`^${STICKER_TOKEN_SOURCE}$`).test(body.trim())
}

/** True when the body is a lone sticker and nothing else. */
export function isLoneSticker(body: string): boolean {
  return isStickerToken(body)
}

/** The body with every sticker token removed — what is left of the typing. */
export function stripStickerTokens(body: string): string {
  return body.replace(new RegExp(STICKER_TOKEN_SOURCE, 'g'), ' ').replace(/\s+/g, ' ').trim()
}

/**
 * A message body split into plain-text and sticker parts, in order, for
 * rendering. Text between tokens is kept (so "[sticker:x] thanks!" renders the
 * sticker and the words).
 */
export type ChatSegment = { kind: 'text'; text: string } | { kind: 'sticker'; slug: string }

export function splitChatBody(body: string): ChatSegment[] {
  const re = new RegExp(STICKER_TOKEN_SOURCE, 'g')
  const out: ChatSegment[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) {
    if (match.index > last) out.push({ kind: 'text', text: body.slice(last, match.index) })
    out.push({ kind: 'sticker', slug: match[1] })
    last = match.index + match[0].length
  }
  if (last < body.length) out.push({ kind: 'text', text: body.slice(last) })
  return out
}

/** Every slug referenced by a body, in order of appearance, without duplicates. */
export function stickerSlugsIn(body: string): string[] {
  const seen: string[] = []
  for (const seg of splitChatBody(body)) {
    if (seg.kind === 'sticker' && !seen.includes(seg.slug)) seen.push(seg.slug)
  }
  return seen
}

/**
 * The body as it should read where images cannot be shown: each sticker token
 * becomes its label in brackets, and leftover whitespace is tidied.
 */
export function chatPlainText(body: string): string {
  const flat = body
    .replace(STICKER_TOKEN_GLOBAL, (_, slug: string) => ` [${stickerLabel(slug)}] `)
    .replace(/\s+/g, ' ')
    .trim()
  return flat
}

/** Longest message preview kept in a chat notification. */
export const CHAT_NOTIFICATION_PREVIEW = 120

/**
 * The text of the notification other members get when someone posts in the team
 * chat: "John Smith: On site now." Kept in one place so the local and Supabase
 * backends (and the SQL function) all word it the same way. A sticker is
 * announced by its label rather than by its raw token.
 */
export function chatNotificationText(message: Pick<ChatMessage, 'author_name' | 'body'>): string {
  const flat = chatPlainText(message.body)
  const preview =
    flat.length > CHAT_NOTIFICATION_PREVIEW
      ? `${flat.slice(0, CHAT_NOTIFICATION_PREVIEW - 1)}…`
      : flat
  return `${message.author_name}: ${preview}`
}

/** Day separator label for the chat timeline. */
export function chatDayLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const startOfThatDay = new Date(d)
  startOfThatDay.setHours(0, 0, 0, 0)
  const days = Math.round((startOfToday.getTime() - startOfThatDay.getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return formatDate(d)
}
