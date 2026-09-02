import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { MessagesSquare } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '@/lib/store'

/**
 * Raises a toast when a teammate posts in the team chat, so a new message is
 * noticed from anywhere in the app. The notification bell and the badge on the
 * Chat item in the sidebar carry the same information for anyone who missed the
 * toast.
 *
 * Mounted once, from AppLayout. The notifications already present when someone
 * signs in only seed the "already seen" set — the backlog is not replayed.
 */
export function ChatNotifications() {
  const { user, notifications } = useStore()
  const { pathname } = useLocation()
  const seen = useRef<Set<string> | null>(null)
  // Reading the chat already tells the reader about the message.
  const inChat = pathname.startsWith('/chat')

  useEffect(() => {
    if (!user) {
      seen.current = null
      return
    }
    const chat = notifications.filter((n) => n.type === 'chat')
    if (!seen.current) {
      seen.current = new Set(chat.map((n) => n.id))
      return
    }
    const fresh = chat.filter((n) => !n.read && !seen.current!.has(n.id))
    if (fresh.length === 0) return
    for (const n of fresh) seen.current!.add(n.id)
    if (inChat) return
    if (fresh.length === 1) {
      toast(fresh[0].message, {
        description: 'New message in the team chat',
        icon: <MessagesSquare className="h-4 w-4" />,
      })
      return
    }
    toast(`${fresh.length} new messages in the team chat`, {
      description: fresh[0].message,
      icon: <MessagesSquare className="h-4 w-4" />,
    })
  }, [notifications, user, inChat])

  return null
}
