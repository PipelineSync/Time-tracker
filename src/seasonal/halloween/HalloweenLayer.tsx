import { useEffect, useMemo, useRef } from 'react'
import { onAppEvent } from '@/lib/appEvents'
import { Cobweb } from './Cobweb'

/**
 * Halloween atmosphere: a few bats flitting across the viewport and embers
 * rising from the bottom.
 *
 * Readability comes first, so this layer is deliberately restrained:
 *   * it is `pointer-events-none` and sits at a negative z-index, so it never
 *     intercepts a click and never paints over text — content scrolls above it;
 *   * bats are small and faint, embers are tiny and low-opacity, so they read
 *     as texture rather than competing with type;
 *   * it is `aria-hidden` and honours `prefers-reduced-motion` (index.css
 *     parks every bat and ember in place), so it is not a problem for anyone
 *     who finds movement distracting.
 */
const EMBER_COUNT = 26
const BAT_COUNT = 5

/** Deterministic PRNG so the layout is stable across re-renders. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

function makeEmbers() {
  const rand = rng(20251031)
  return Array.from({ length: EMBER_COUNT }, () => {
    const size = 2 + rand() * 4 // 2–6px
    return {
      left: rand() * 100,
      size,
      duration: 14 + rand() * 12,
      delay: -rand() * 26,
      opacity: 0.18 + (size / 6) * 0.3,
      drift: -50 + rand() * 100,
      rest: 15 + rand() * 70,
      slime: rand() < 0.22,
    }
  })
}

function makeBats() {
  const rand = rng(31102025)
  return Array.from({ length: BAT_COUNT }, () => ({
    top: 6 + rand() * 60,
    size: 18 + rand() * 16, // 18–34px wide
    duration: 22 + rand() * 18,
    delay: -rand() * 40,
    opacity: 0.12 + rand() * 0.14,
    restX: 10 + rand() * 80,
  }))
}

function Bat() {
  return (
    <svg viewBox="0 0 64 32" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M32 10c-1.6 0-2.6-2.4-3-4l-1.4 3.2C22 6 13 4 2 8c5 1 8 4 9 8 3-2 7-2 9 1 2-2 5-2 7 0l5 7 5-7c2-2 5-2 7 0 2-3 6-3 9-1 1-4 4-7 9-8-11-4-20-2-25.6 1.2L36 6c-.4 1.6-1.4 4-3 4h-1z"
      />
    </svg>
  )
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * A short trail of embers behind the mouse. Fine pointers only (never on
 * touch), throttled, and capped so it can never pile up.
 */
function useCursorSparks(host: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches) return
    let last = 0
    let alive = 0
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || reducedMotion() || !host.current) return
      const now = performance.now()
      if (now - last < 45 || alive >= 12) return
      last = now
      const spark = document.createElement('span')
      spark.className = 'halloween-spark'
      spark.style.left = `${e.clientX}px`
      spark.style.top = `${e.clientY}px`
      spark.style.setProperty('--dx', `${(Math.random() - 0.5) * 16}px`)
      spark.style.setProperty('--dy', `${6 + Math.random() * 12}px`)
      alive++
      spark.addEventListener('animationend', () => {
        spark.remove()
        alive--
      })
      host.current.appendChild(spark)
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [host])
}

const GHOST_SVG = `<svg viewBox="0 0 44 52" width="44" height="52" aria-hidden="true"><path fill="currentColor" d="M22 2C11 2 4 10 4 21v27l6-5 6 5 6-5 6 5 6-5 6 5V21C40 10 33 2 22 2z"/><ellipse cx="16" cy="21" rx="3" ry="4" fill="#1b0f30"/><ellipse cx="28" cy="21" rx="3" ry="4" fill="#1b0f30"/><ellipse cx="22" cy="31" rx="3.2" ry="2.4" fill="#1b0f30"/></svg>`

/**
 * On clock-out, a little ghost floats up from where you clicked and fades
 * away. Nothing else changes: the clock-out itself has already happened.
 */
function useClockOutGhost(host: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    let x = window.innerWidth / 2
    let y = window.innerHeight * 0.6
    const remember = (e: PointerEvent) => {
      x = e.clientX
      y = e.clientY
    }
    window.addEventListener('pointerdown', remember, { passive: true, capture: true })
    const off = onAppEvent('clock_out', () => {
      if (reducedMotion() || !host.current) return
      const ghost = document.createElement('span')
      ghost.className = 'halloween-ghost'
      ghost.style.left = `${x}px`
      ghost.style.top = `${y}px`
      ghost.innerHTML = GHOST_SVG
      ghost.addEventListener('animationend', () => ghost.remove())
      host.current.appendChild(ghost)
    })
    return () => {
      window.removeEventListener('pointerdown', remember, { capture: true })
      off()
    }
  }, [host])
}

export function HalloweenLayer() {
  const embers = useMemo(makeEmbers, [])
  const bats = useMemo(makeBats, [])
  const fx = useRef<HTMLDivElement>(null)
  useCursorSparks(fx)
  useClockOutGhost(fx)

  return (
    <>
    {/* Above content but click-through: cursor sparks and the clock-out ghost. */}
    <div ref={fx} className="halloween-cursor-layer" aria-hidden="true" />
    <div className="halloween-layer" aria-hidden="true">
      <Cobweb className="halloween-cobweb-page" />
      {embers.map((e, i) => (
        <span
          key={`e${i}`}
          className="halloween-ember"
          data-tone={e.slime ? 'slime' : undefined}
          style={{
            left: `${e.left}%`,
            width: `${e.size}px`,
            height: `${e.size}px`,
            ['--peak' as string]: e.opacity,
            animationDuration: `${e.duration}s`,
            animationDelay: `${e.delay}s`,
            ['--drift' as string]: `${e.drift}px`,
            ['--rest' as string]: e.rest,
          }}
        />
      ))}
      {bats.map((b, i) => (
        <span
          key={`b${i}`}
          className="halloween-bat"
          style={{
            top: `${b.top}%`,
            width: `${b.size}px`,
            height: `${b.size / 2}px`,
            opacity: b.opacity,
            animationDuration: `${b.duration}s`,
            animationDelay: `${b.delay}s`,
            ['--rest-x' as string]: `${b.restX}vw`,
          }}
        >
          <Bat />
        </span>
      ))}
    </div>
    </>
  )
}
