import { stickerLabel, stickerSlug } from './chat'

/**
 * The bundled sticker pack behind `[sticker:slug]` chat messages.
 *
 * Every image dropped into `src/assets/chat-stickers` becomes a sticker with no
 * code change: the file name stem is the slug (`side-eye-cat.png` →
 * `side-eye-cat`) and the label shown in previews and alt text is derived from
 * it ("Side eye cat"). Because the pack is resolved from the bundle rather than
 * from a manifest, a sticker is available offline and inside the native shells
 * exactly as it is on the web, and a message whose image was later removed still
 * renders its label instead of a broken thumbnail.
 */
export interface ChatSticker {
  slug: string
  label: string
  url: string
}

const assets = import.meta.glob('../assets/chat-stickers/*.{png,jpg,jpeg,webp,gif,svg}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

export const CHAT_STICKERS: ChatSticker[] = Object.entries(assets)
  .map(([path, url]) => {
    const file = path.split('/').pop() ?? ''
    const slug = stickerSlug(file.replace(/\.[a-z0-9]+$/i, ''))
    return slug ? { slug, label: stickerLabel(slug), url } : null
  })
  .filter((s): s is ChatSticker => s !== null)
  .sort((a, b) => a.label.localeCompare(b.label))

const BY_SLUG = new Map(CHAT_STICKERS.map((s) => [s.slug, s]))

/** The image for a slug, or null when the pack no longer ships it. */
export function findChatSticker(slug: string): ChatSticker | null {
  return BY_SLUG.get(slug) ?? null
}

export const hasChatStickers = CHAT_STICKERS.length > 0
