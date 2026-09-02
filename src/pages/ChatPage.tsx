import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, MessageSquare, RefreshCw, Send, UserRound, Users } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { AvatarBubble } from '@/components/AvatarBubble'
import { ChatMembersDialog } from '@/components/ChatMembersDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/EmptyState'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { chatDayLabel, resolveChatAuthor, roleLabel } from '@/lib/chat'
import { CHAT_MAX_LENGTH, CHAT_PAGE_SIZE } from '@/lib/backend'
import { useStore } from '@/lib/store'
import type { ChatMember, ChatMessage } from '@/lib/types'
import { cn, formatTime } from '@/lib/utils'
import { toast } from 'sonner'

/**
 * Team chat: one shared room for the admin and every worker. Each message carries
 * the sender's profile picture, name and role, and the members button lists the
 * whole workspace (admin included) for both roles.
 */
export function ChatPage() {
  const { user, isAdmin, settings, workers, listChatMessages, sendChatMessage, listChatMembers } = useStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [members, setMembers] = useState<ChatMember[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true)
      const [msgs, mems] = await Promise.all([
        listChatMessages(CHAT_PAGE_SIZE).catch(() => ({ messages: [], error: 'network' })),
        listChatMembers().catch(() => ({ members: [], error: 'network' })),
      ])
      if (msgs.error) {
        // Keep whatever is already on screen; explain what went wrong (a missing
        // chat table, a signed-out session, a network blip).
        setLoadError(msgs.error === 'network' ? 'Could not load the team chat. Check your connection and try again.' : msgs.error)
      } else {
        setLoadError(null)
        setMessages(msgs.messages)
      }
      if (!mems.error) setMembers(mems.members)
      setLoading(false)
    },
    [listChatMessages, listChatMembers]
  )

  useEffect(() => {
    void load()
  }, [load])

  // New messages from other accounts arrive without a reload — poll while the
  // tab is visible, and refresh immediately on focus (same approach the app uses
  // for entries and notifications).
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'hidden') return
      setRefreshing(true)
      void load({ silent: true }).finally(() => setRefreshing(false))
    }
    const interval = window.setInterval(tick, 8000)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [load])

  // Keep the newest message in view, unless the reader scrolled up on purpose.
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }
  useEffect(() => {
    if (!stickToBottom.current) return
    bottomRef.current?.scrollIntoView({ behavior: loading ? 'auto' : 'smooth' })
  }, [messages.length, loading])

  const memberByUserId = useMemo(() => {
    const map = new Map<string, ChatMember>()
    for (const m of members) if (m.user_id) map.set(m.user_id, m)
    return map
  }, [members])

  // The signed-in user's own identity, shown next to the composer.
  const myWorker = useMemo(
    () => workers.find((w) => w.id === user?.workerId) ?? null,
    [workers, user?.workerId]
  )
  const meMember = memberByUserId.get(user?.id ?? '')
  const myName = meMember?.name ?? (isAdmin ? 'Admin' : myWorker?.name ?? 'You')
  const myAvatar = meMember?.avatar_url ?? (isAdmin ? settings?.avatar_url ?? null : myWorker?.avatar_url ?? null)

  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault()
    const text = body.trim()
    if (!text || sending) return
    setSending(true)
    const { message, error } = await sendChatMessage(text)
    setSending(false)
    if (!message) {
      toast.error(error || 'Failed to send message.')
      return
    }
    stickToBottom.current = true
    setBody('')
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
  }

  async function handleRetry() {
    setRefreshing(true)
    await load({ silent: true })
    setRefreshing(false)
  }

  const grouped = useMemo(() => {
    const out: { day: string; items: ChatMessage[] }[] = []
    for (const m of messages) {
      const day = chatDayLabel(m.created_at)
      const last = out[out.length - 1]
      if (last && last.day === day) last.items.push(m)
      else out.push({ day, items: [m] })
    }
    return out
  }, [messages])

  const roomName = settings?.business_name?.trim() || 'Team chat'

  return (
    <div className="space-y-4">
      <PageHeader
        title="Chat"
        description={`The shared room for ${roomName}. Every message shows who sent it — picture, name and role.`}
      >
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleRetry} disabled={refreshing}>
            <RefreshCw className={cn('mr-1 h-4 w-4', refreshing && 'animate-spin')} /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMembersOpen(true)}>
            <Users className="mr-1 h-4 w-4" /> See all members{members.length > 0 ? ` (${members.length})` : ''}
          </Button>
        </div>
      </PageHeader>

      {loadError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <span className="text-destructive">{loadError}</span>
          <Button variant="outline" size="sm" onClick={handleRetry}>
            Try again
          </Button>
        </div>
      )}

      <Card className="flex h-[calc(100svh-13.5rem)] min-h-[26rem] flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <MessageSquare className="h-4 w-4 shrink-0 text-primary" />
            <p className="truncate text-sm font-semibold">Team chat</p>
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">· {roomName}</span>
            <Badge variant="muted" className="shrink-0">
              {members.length > 0
                ? `${members.length} ${members.length === 1 ? 'member' : 'members'}`
                : 'Members'}
            </Badge>
            {refreshing && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          {/* Everyone in the room at a glance — the full list is one click away. */}
          <button
            type="button"
            onClick={() => setMembersOpen(true)}
            className="group flex items-center gap-2 rounded-full border px-2 py-1 transition-colors hover:bg-muted"
            aria-label="See all members"
          >
            <span className="flex -space-x-2">
              {members.slice(0, 5).map((m) => (
                <AvatarBubble
                  key={m.id}
                  name={m.name}
                  avatarUrl={m.avatar_url}
                  size="sm"
                  className="ring-2 ring-background"
                />
              ))}
            </span>
            <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground">
              {members.length > 5 ? `+${members.length - 5} members` : 'All members'}
            </span>
          </button>
        </div>

        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {loading ? (
              <div className="space-y-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex gap-3">
                    <Skeleton className="h-9 w-9 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3 w-40" />
                      <Skeleton className="h-10 w-full max-w-md" />
                    </div>
                  </div>
                ))}
              </div>
            ) : messages.length === 0 ? (
              <EmptyState
                icon={MessageSquare}
                title="No messages yet"
                description={
                  isAdmin
                    ? 'Say hello — your team sees this in their Chat section. Everyone in the workspace can reply.'
                    : 'Introduce yourself or ask a question. Your manager and the rest of the team can reply here.'
                }
                action={
                  <Button variant="outline" onClick={() => setMembersOpen(true)}>
                    <UserRound className="mr-1 h-4 w-4" /> See all members
                  </Button>
                }
                className="border-0 py-8"
              />
            ) : (
              grouped.map((group) => (
                <div key={group.day} className="space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="h-px flex-1 bg-border" />
                    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {group.day}
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  {group.items.map((m) => {
                    const author = resolveChatAuthor(m, members)
                    const mine = m.author_id === user?.id
                    return (
                      <div
                        key={m.id}
                        data-chat-message={m.id}
                        data-author-role={author.role}
                        className={cn('flex gap-3 rounded-lg p-2', mine && 'bg-primary/5')}
                      >
                        <AvatarBubble name={author.name} avatarUrl={author.avatarUrl} size="md" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span data-author-name className="truncate text-sm font-semibold">
                              {author.name}
                            </span>
                            <Badge
                              data-role-badge
                              className={cn(
                                'px-2 py-0 text-[10px]',
                                author.role === 'admin'
                                  ? 'border-transparent bg-primary text-primary-foreground'
                                  : 'border-transparent bg-[#36B7C9]/15 text-[#0d7c8c] dark:text-[#7fdbe8]'
                              )}
                            >
                              {roleLabel(author.role, author.position)}
                            </Badge>
                            <span className="text-[11px] text-muted-foreground">{formatTime(m.created_at)}</span>
                            {mine && <span className="text-[11px] text-muted-foreground">· you</span>}
                          </div>
                          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{m.body}</p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>

          <form onSubmit={handleSend} className="flex items-end gap-2 border-t bg-background p-3">
            <AvatarBubble name={myName} avatarUrl={myAvatar} size="md" className="mb-0.5" />
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, CHAT_MAX_LENGTH))}
              placeholder={isAdmin ? 'Message the whole team…' : 'Message your team and manager…'}
              className="max-h-32 min-h-[44px] flex-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend(e)
                }
              }}
            />
            <div className="flex shrink-0 flex-col items-end gap-1">
              {body.length > CHAT_MAX_LENGTH - 300 && (
                <span className={cn('text-[11px]', body.length >= CHAT_MAX_LENGTH ? 'text-destructive' : 'text-muted-foreground')}>
                  {body.length}/{CHAT_MAX_LENGTH}
                </span>
              )}
              <Button type="submit" size="icon" className="h-11 w-11" aria-label="Send message" disabled={sending || !body.trim()}>
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        Everyone in the workspace can post and read here. Enter sends, Shift+Enter adds a line.
      </p>

      <ChatMembersDialog
        open={membersOpen}
        onOpenChange={setMembersOpen}
        members={members}
        loading={loading}
        currentUserId={user?.id ?? null}
        currentWorkerId={user?.workerId ?? null}
        isAdmin={isAdmin}
      />
    </div>
  )
}
