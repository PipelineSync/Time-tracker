/**
 * Pointer-following spotlight for `.ps-card` (see index.css).
 *
 * One passive listener for the whole app instead of one per card: it finds
 * the card under a mouse/pen pointer, writes the pointer position into the
 * card's --mx/--my, and flags it with `data-spot` so the glow and the
 * gradient border fade in. Touch pointers and reduced-motion users get no
 * effect at all.
 */
export function installCardSpotlight(): void {
  if (typeof window === 'undefined') return
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
  let current: HTMLElement | null = null

  const clear = () => {
    current?.removeAttribute('data-spot')
    current = null
  }

  document.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch' || reduce.matches) return clear()
      const card = (e.target as Element | null)?.closest?.<HTMLElement>('.ps-card') ?? null
      if (card !== current) {
        clear()
        current = card
      }
      if (!card) return
      const r = card.getBoundingClientRect()
      card.style.setProperty('--mx', `${e.clientX - r.left}px`)
      card.style.setProperty('--my', `${e.clientY - r.top}px`)
      card.setAttribute('data-spot', '')
    },
    { passive: true }
  )
  document.addEventListener('pointerleave', clear, { passive: true })
}
