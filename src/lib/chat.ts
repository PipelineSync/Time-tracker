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
