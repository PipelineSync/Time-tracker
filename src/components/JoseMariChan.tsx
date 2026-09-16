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
 *     or blocks workspace controls.
 */
export function JoseMariChan() {
  const { pathname } = useLocation()
  const sectionKey = sectionKeyFor(pathname)
  const isFirstMount = useRef(true)
  const prevSection = useRef(sectionKey)
  const [animKey, setAnimKey] = useState(0)

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
      className="pointer-events-none fixed bottom-24 left-[200px] z-20 hidden select-none lg:block"
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
          className="h-auto w-36 drop-shadow-md sm:w-40 md:w-44"
          draggable={false}
          loading="eager"
        />
      </div>
    </div>
  )
}
