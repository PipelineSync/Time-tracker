import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { sectionKeyFor } from '@/lib/sectionTransition'
import { cn } from '@/lib/utils'

/**
 * Jose Mari Chan peeking / leaning half-body on the left side panel.
 *
 * Requirements:
 *  1. Desktop only (`hidden lg:block`).
 *  2. Sliding-left transition when changing sections:
 *     When navigating between sections (e.g. Dashboard → Time Entries → Finance),
 *     he slides left behind the panel, waits briefly as the new section settles in,
 *     and smoothly slides back out to peek again.
 *  3. In-section changes (switching tabs inside Finance or opening a ticket)
 *     do not trigger the animation (mirrors `sectionKeyFor(pathname)`).
 *  4. Respects `prefers-reduced-motion` so users who request less motion
 *     see a steady peek with no sudden movement.
 *  5. Marked `pointer-events-none select-none` so he never intercepts clicks
 *     or blocks workspace controls. Window-level pointer tracking slides him
 *     behind the sidebar while the pointer is over his stationary footprint,
 *     without flickering.
 */
export function JoseMariChan() {
  const { pathname } = useLocation()
  const sectionKey = sectionKeyFor(pathname)
  const isFirstMount = useRef(true)
  const prevSection = useRef(sectionKey)
  const [animKey, setAnimKey] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const [pointerOver, setPointerOver] = useState(false)

  useEffect(() => {
    const reset = () => setPointerOver(false)
    const trackPointer = (event: PointerEvent) => {
      const bounds = containerRef.current?.getBoundingClientRect()
      setPointerOver(
        event.pointerType !== 'touch' && !!bounds &&
        bounds.width > 0 && bounds.height > 0 &&
        event.clientX >= bounds.left && event.clientX <= bounds.right &&
        event.clientY >= bounds.top && event.clientY <= bounds.bottom
      )
    }

    // The decoration stays click-through; its unanimated wrapper keeps the
    // hover area stable even when the image is hidden or sliding away.
    window.addEventListener('pointermove', trackPointer, { passive: true })
    document.documentElement.addEventListener('pointerleave', reset)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('pointermove', trackPointer)
      document.documentElement.removeEventListener('pointerleave', reset)
      window.removeEventListener('blur', reset)
    }
  }, [])

  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false
      return
    }
    if (prevSection.current !== sectionKey) {
      prevSection.current = sectionKey
      setAnimKey((k) => k + 1)
    }
  }, [sectionKey])

  return (
    <div
      ref={containerRef}
      className={cn(
        'pointer-events-none fixed bottom-24 left-[220px] z-20 hidden select-none lg:block'
      )}
      aria-hidden="true"
    >
      <div
        key={animKey}
        className={cn(
          'jmc-peeking-motion',
          animKey === 0 ? 'jmc-anim-enter' : 'jmc-anim-section-change'
        )}
      >
        <img
          src="/jose-mari-chan/classic-peeking.png"
          alt="Jose Mari Chan"
          className={cn(
            'jmc-hover-image h-auto w-20 drop-shadow-sm md:w-24',
            pointerOver && 'jmc-hover-hide'
          )}
          draggable={false}
          loading="eager"
        />
      </div>
    </div>
  )
}
