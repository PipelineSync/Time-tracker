import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, MessageSquare, RefreshCw, Send, Smile, SmilePlus, UserRound, Users, X } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { AvatarBubble } from '@/components/AvatarBubble'
import { ChatMembersDialog } from '@/components/ChatMembersDialog'
import { EmojiPicker } from '@/components/EmojiPicker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/EmptyState'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  chatDayLabel,
  resolveChatAuthor,
  roleLabel,
  splitChatBody,
  stickerLabel,
  stickerSlugsIn,
  stickerToken,
  stripStickerTokens,
} from '@/lib/chat'
import { CHAT_MAX_LENGTH, CHAT_PAGE_SIZE } from '@/lib/backend'
import { useStore } from '@/lib/store'
import type { ChatMember, ChatMessage, ChatReaction } from '@/lib/types'
import { findChatSticker, type ChatSticker } from '@/lib/stickers'
import { cn, formatTime } from '@/lib/utils'
import { toast } from 'sonner'

/**
 * Team chat: one shared room for the admin and every worker. Each message carries
 * the sender's profile picture, name and role, and the members button lists the
 * whole workspace (admin included) for both roles.
 *
 * Both roles get the same composer: emoji from the picker (inserted as text) and
 * the bundled sticker pack (sent as a `[sticker:slug]` token), plus emoji
 * reactions on any message.
 */
export function ChatPage() {
  const { user, isAdmin, settings, workers, listChatMessages, sendChatMessage, listChatMembers, listChatReactions, toggleChatReaction } = useStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [members, setMembers] = useState<ChatMember[]>([])
  const [reactions, setReactions] = useState<Record<string, ChatReaction[]>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  /** Which emoji panel is open, and for what. */
  const [picker, setPicker] = useState<{ target: 'composer' } | { target: 'reaction'; messageId: string } | null>(null)
  const [reactionBusy, setReactionBusy] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const stickToBottom = useRef(true)

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true)
      const [msgs, mems, reacts] = await Promise.all([
        listChatMessages(CHAT_PAGE_SIZE).catch(() => ({ messages: [], error: 'network' })),
        listChatMembers().catch(() => ({ members: [], error: 'network' })),
        // Reactions are decoration: a failure here must never hide the messages.
        listChatReactions().catch(() => ({ reactions: [], error: 'network' })),
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
      if (!reacts.error) {
        const byMessage: Record<string, ChatReaction[]> = {}
        for (const r of reacts.reactions) {
          ;(byMessage[r.message_id] ??= []).push(r)
        }
        setReactions(byMessage)
      }
      setLoading(false)
    },
    [listChatMessages, listChatMembers, listChatReactions]
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
    setPicker(null)
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
  }

  async function handleRetry() {
    setRefreshing(true)
    await load({ silent: true })
    setRefreshing(false)
  }

  /**
   * Put `text` where the caret is (or at the end), then put the caret back after
   * it — so emoji can be dropped into the middle of a sentence, and a sticker
   * token can be typed around.
   */
  function insertAtCursor(text: string) {
    const el = textareaRef.current
    const start = el?.selectionStart ?? body.length
    const end = el?.selectionEnd ?? body.length
    const next = body.slice(0, start) + text + body.slice(end)
    setBody(next.slice(0, CHAT_MAX_LENGTH))
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      node.focus()
      const caret = Math.min(start + text.length, CHAT_MAX_LENGTH)
      node.setSelectionRange(caret, caret)
    })
  }

  function handlePickEmoji(emoji: string) {
    insertAtCursor(emoji)
  }

  function handlePickSticker(sticker: ChatSticker) {
    const token = stickerToken(sticker.slug)
    if (body.length + token.length > CHAT_MAX_LENGTH) {
      toast.error(`A message is limited to ${CHAT_MAX_LENGTH} characters.`)
      return
    }
    insertAtCursor(token)
  }

  /**
   * Add or take back the caller's emoji on a message. Applied to the row
   * straight away and corrected from the backend's answer, so tapping a reaction
   * feels instant even though it is a round trip.
   */
  async function handleToggleReaction(messageId: string, emoji: string) {
    if (!user || reactionBusy) return
    const current = reactions[messageId] ?? []
    const mine = current.find((r) => r.author_id === user.id && r.emoji === emoji)
    const optimistic = mine
      ? current.filter((r) => r !== mine)
      : [
          ...current,
          {
            id: `pending-${emoji}`,
            message_id: messageId,
            author_id: user.id,
            author_name: myName,
            emoji,
            created_at: new Date().toISOString(),
          } as ChatReaction,
        ]
    const previous = reactions
    setReactions({ ...previous, [messageId]: optimistic })
    setReactionBusy(messageId)
    const { reactions: saved, error } = await toggleChatReaction(messageId, emoji)
    setReactionBusy(null)
    if (error) {
      setReactions(previous)
      toast.error(error)
      return
    }
    setReactions((prev) => ({ ...prev, [messageId]: saved }))
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

  const pendingStickers = useMemo(() => stickerSlugsIn(body), [body])
  const roomName = settings?.business_name?.trim() || 'Team chat'

  return (
    <div className="space-y-4">
      <PageHeader title="Chat">
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
                    const forThis = reactions[m.id] ?? []
                    const chips = reactionChips(forThis, user?.id)
                    const reactingTo = picker?.target === 'reaction' && picker.messageId === m.id
                    return (
                      <div
                        key={m.id}
                        data-chat-message={m.id}
                        data-author-role={author.role}
                        className={cn('group/message rounded-lg p-2 transition-colors', mine && 'bg-primary/5')}
                      >
                        <div className="flex gap-3">
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
                            <ChatBody body={m.body} />
                            {(chips.length > 0 || reactingTo) && (
                              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                                {chips.map((chip) => (
                                  <button
                                    key={chip.emoji}
                                    type="button"
                                    onClick={() => void handleToggleReaction(m.id, chip.emoji)}
                                    title={chip.names}
                                    aria-label={`${chip.count} ${chip.emoji} reaction${chip.count === 1 ? '' : 's'}${chip.mine ? ' — yours included, tap to take it back' : ', tap to react'}`}
                                    className={cn(
                                      'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] transition-colors',
                                      chip.mine
                                        ? 'border-primary/40 bg-primary/10 text-primary'
                                        : 'border-input bg-background hover:bg-muted'
                                    )}
                                  >
                                    <span className="text-xs leading-none">{chip.emoji}</span>
                                    {chip.count > 1 && <span className="font-medium tabular-nums">{chip.count}</span>}
                                  </button>
                                ))}
                              </div>
                            )}
                            {reactingTo && (
                              <div className="mt-2">
                                <EmojiPicker
                                  mode="reaction"
                                  className="w-full max-w-md"
                                  onPickEmoji={(emoji) => {
                                    setPicker(null)
                                    void handleToggleReaction(m.id, emoji)
                                  }}
                                  onClose={() => setPicker(null)}
                                />
                              </div>
                            )}
                          </div>
                          {/* React to any message, from anyone. Kept subtle until
                              hovered on a pointer device, always tappable on touch. */}
                          <button
                            type="button"
                            data-emoji-toggle={`reaction-${m.id}`}
                            onClick={() => setPicker(picker?.target === 'reaction' && picker.messageId === m.id ? null : { target: 'reaction', messageId: m.id })}
                            aria-label={mine ? 'React to your message' : `React to ${author.name}'s message`}
                            aria-pressed={reactingTo}
                            className={cn(
                              'h-7 w-7 shrink-0 self-start rounded-md text-muted-foreground transition-all hover:bg-muted hover:text-foreground',
                              'opacity-100 sm:opacity-0 sm:group-hover/message:opacity-100 sm:focus-visible:opacity-100',
                              reactingTo && 'bg-muted text-foreground opacity-100'
                            )}
                          >
                            {reactionBusy === m.id ? (
                              <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                            ) : (
                              <SmilePlus className="mx-auto h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>

          <div className="relative border-t bg-background p-3">
            {picker?.target === 'composer' && (
              <EmojiPicker
                mode="message"
                onPickEmoji={handlePickEmoji}
                onPickSticker={handlePickSticker}
                onClose={() => setPicker(null)}
                className="absolute bottom-full left-3 right-3 z-20 mb-2 sm:left-auto sm:right-3 sm:w-[23rem]"
              />
            )}

            <form onSubmit={handleSend} className="flex items-end gap-2">
              <AvatarBubble name={myName} avatarUrl={myAvatar} size="md" className="mb-0.5" />
              <button
                type="button"
                data-emoji-toggle="composer"
                onClick={() => setPicker(picker?.target === 'composer' ? null : { target: 'composer' })}
                aria-label="Add emoji or a sticker"
                aria-pressed={picker?.target === 'composer'}
                title="Add emoji or a sticker"
                className={cn(
                  'mb-0.5 h-11 w-11 shrink-0 rounded-lg border border-input text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                  picker?.target === 'composer' && 'border-primary/40 bg-primary/10 text-primary'
                )}
              >
                <Smile className="mx-auto h-5 w-5" />
              </button>
              <div className="min-w-0 flex-1">
                {pendingStickers.length > 0 && (
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-1.5">
                    <span className="pl-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Sticker
                    </span>
                    {pendingStickers.map((slug) => (
                      <StickerThumb key={slug} slug={slug} size="sm" />
                    ))}
                    <button
                      type="button"
                      onClick={() => setBody(stripStickerTokens(body))}
                      aria-label="Remove the sticker from this message"
                      className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                <Textarea
                  ref={textareaRef}
                  value={body}
                  onChange={(e) => setBody(e.target.value.slice(0, CHAT_MAX_LENGTH))}
                  placeholder={isAdmin ? 'Message the whole team…' : 'Message your team and manager…'}
                  className="max-h-32 min-h-[44px] w-full"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void handleSend(e)
                    }
                  }}
                />
              </div>
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
          </div>
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        Everyone in the workspace can post and read here. Enter sends, Shift+Enter adds a line. Use the smiley for emoji
        and stickers, and react to any message with the smile icon beside it.
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

/**
 * A message body, with any `[sticker:slug]` tokens rendered as the picture they
 * stand for. Text around a token is kept, so "nice one [sticker:x]" shows both,
 * and a lone sticker gets a larger, frame-free rendering.
 */
function ChatBody({ body }: { body: string }) {
  const segments = useMemo(() => splitChatBody(body), [body])
  const loneSticker = segments.length === 1 && segments[0].kind === 'sticker'
  const nodes = segments.flatMap((seg, i) => {
    if (seg.kind === 'sticker') return [<StickerThumb key={`s-${seg.slug}-${i}`} slug={seg.slug} size={loneSticker ? 'lg' : 'md'} />]
    return seg.text.trim()
      ? [
          <p key={`t-${i}`} className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {seg.text}
          </p>,
        ]
      : []
  })
  return (
    <div className={cn('mt-1 flex flex-wrap items-start gap-2', loneSticker && 'gap-0')}>
      {nodes.length > 0 ? nodes : <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{body}</p>}
    </div>
  )
}

function StickerThumb({ slug, size }: { slug: string; size: 'sm' | 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-28 w-28' : size === 'sm' ? 'h-10 w-10' : 'h-16 w-16'
  const sticker = findChatSticker(slug)
  if (!sticker) {
    // A message whose sticker image is no longer shipped: show the label it
    // would have had rather than a broken image.
    return (
      <span className="rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground">
        {stickerLabel(slug)}
      </span>
    )
  }
  return (
    <span className={cn('inline-flex items-center justify-center rounded-lg bg-muted/40', box)} title={sticker.label}>
      <img src={sticker.url} alt={sticker.label} loading="lazy" className="h-full w-full object-contain" />
    </span>
  )
}

/**
 * Reaction rows grouped by emoji, in the order they first appear, each with how
 * many people used it and whether the viewer is one of them.
 */
function reactionChips(list: ChatReaction[], viewerId?: string | null) {
  const out: { emoji: string; count: number; mine: boolean; names: string }[] = []
  for (const r of list) {
    const found = out.find((c) => c.emoji === r.emoji)
    if (found) {
      found.count += 1
      found.mine = found.mine || r.author_id === viewerId
      found.names = `${found.names}, ${r.author_name}`
    } else {
      out.push({ emoji: r.emoji, count: 1, mine: r.author_id === viewerId, names: r.author_name })
    }
  }
  return out
}
