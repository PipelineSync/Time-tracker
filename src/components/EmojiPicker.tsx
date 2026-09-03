import { useEffect, useMemo, useRef, useState } from 'react'
import { History, Image as ImageIcon, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { EMOJI_GROUPS, QUICK_REACTIONS, readEmojiRecents, rememberEmoji, searchEmoji } from '@/lib/emoji'
import { CHAT_STICKERS, hasChatStickers, type ChatSticker } from '@/lib/stickers'
import { cn } from '@/lib/utils'

interface EmojiPickerProps {
  /**
   * `message` inserts into the composer and stays open for several picks;
   * `reaction` leads with the quick set and closes as soon as one is chosen.
   */
  mode?: 'message' | 'reaction'
  onPickEmoji: (emoji: string) => void
  /** Omitted when stickers cannot be used (e.g. reacting to a message). */
  onPickSticker?: (sticker: ChatSticker) => void
  onClose: () => void
  className?: string
}

const RECENTS_TAB = 'recents'
const STICKERS_TAB = 'stickers'

/**
 * The emoji (and sticker) panel used by the team chat — the same one for admins
 * and workers. Emoji are inserted as plain text into the message, stickers as a
 * `[sticker:slug]` token, so the picker never has to know how a message is
 * stored; see `lib/chat.ts`.
 */
export function EmojiPicker({ mode = 'message', onPickEmoji, onPickSticker, onClose, className }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [query, setQuery] = useState('')
  const [recents, setRecents] = useState(() => readEmojiRecents())
  const [tab, setTab] = useState<string>(() => (mode === 'reaction' ? 'reaction' : 'smileys'))

  // Click away or Escape dismisses the panel. The listeners are attached a tick
  // later so the click that opened the picker does not immediately close it.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      // The button that opens this panel is marked data-emoji-toggle: clicking it
      // is the owner's business (it toggles us), not an outside click to ignore.
      if (target?.closest?.('[data-emoji-toggle]')) return
      if (ref.current && !ref.current.contains(target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown)
      window.addEventListener('keydown', onKeyDown)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const stickersOn = Boolean(onPickSticker) && hasChatStickers
  const groups = useMemo(() => EMOJI_GROUPS.filter((g) => g.items.length > 0), [])

  const items = useMemo(() => {
    const q = query.trim()
    if (q) return searchEmoji(q)
    if (tab === 'reaction') {
      const quick = QUICK_REACTIONS.map((char) => EMOJI_GROUPS.flatMap((g) => g.items).find((e) => e.char === char) ?? { char, name: 'react', keywords: '' })
      return quick
    }
    if (tab === RECENTS_TAB) return recents
    return groups.find((g) => g.id === tab)?.items ?? groups[0]?.items ?? []
  }, [query, tab, recents, groups])

  function pickEmoji(char: string) {
    onPickEmoji(char)
    if (mode === 'message') setRecents(rememberEmoji(char))
    else onClose()
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={mode === 'reaction' ? 'React with an emoji' : 'Pick an emoji'}
      className={cn('flex flex-col gap-2 rounded-xl border bg-popover p-2 text-popover-foreground shadow-lg', className)}
    >
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emoji…"
            aria-label="Search emoji"
            className="h-8 pl-7 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close emoji picker"
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tabs: recents + every emoji group (+ the sticker pack when there is one). */}
      <div className="flex items-center gap-0.5 overflow-x-auto pb-0.5">
        {recents.length > 0 && !query && (
          <TabButton active={tab === RECENTS_TAB && !query} onClick={() => setTab(RECENTS_TAB)} label="Recently used">
            <History className="h-3.5 w-3.5" />
          </TabButton>
        )}
        {groups.map((g) => (
          <TabButton key={g.id} active={tab === g.id && !query} onClick={() => setTab(g.id)} label={g.label}>
            <span className="text-sm leading-none">{g.icon}</span>
          </TabButton>
        ))}
        {stickersOn && (
          <TabButton active={tab === STICKERS_TAB && !query} onClick={() => setTab(STICKERS_TAB)} label="Stickers">
            <ImageIcon className="h-3.5 w-3.5" />
          </TabButton>
        )}
      </div>

      <div className="min-h-[9.5rem] max-h-56 overflow-y-auto px-0.5">
        {tab === STICKERS_TAB && !query ? (
          <div className="grid grid-cols-3 gap-1.5">
            {CHAT_STICKERS.map((sticker) => (
              <button
                key={sticker.slug}
                type="button"
                title={sticker.label}
                aria-label={`Send the ${sticker.label} sticker`}
                onClick={() => {
                  onPickSticker?.(sticker)
                  if (mode === 'reaction') onClose()
                }}
                className="group rounded-lg border border-transparent p-1 transition-colors hover:border-input hover:bg-muted"
              >
                <img src={sticker.url} alt="" loading="lazy" className="mx-auto h-14 w-14 object-contain" />
                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground group-hover:text-foreground">
                  {sticker.label}
                </span>
              </button>
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            No emoji match “{query.trim()}”.
          </p>
        ) : (
          <div className="grid grid-cols-8 gap-0.5">
            {items.map((item) => (
              <button
                key={item.char}
                type="button"
                title={item.name || undefined}
                aria-label={item.name ? `Insert ${item.name}` : 'Insert emoji'}
                onClick={() => pickEmoji(item.char)}
                className="flex h-8 w-full items-center justify-center rounded-md text-lg leading-none transition-colors hover:bg-muted active:scale-95"
              >
                {item.char}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
        active ? 'bg-primary/10 text-primary ring-1 ring-primary/30' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}
