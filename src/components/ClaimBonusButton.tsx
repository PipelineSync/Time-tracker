import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Gift } from 'lucide-react'
import { toast } from 'sonner'
import { SantaHat } from '@/components/SantaHat'

/**
 * Festive "Claim your bonus" prank for the Clock In / Out screen.
 *
 * The button spawns at a random spot in the section and is deliberately
 * impossible to catch: when the pointer gets within {@link TRIGGER_PX} it
 * leans away (a rotation in its escape direction) and springs to a new
 * random spot that is both far from the cursor and clear of the real
 * clock-in/out controls, so the joke never blocks actual work. Touch and
 * pen are handled the same way via pointerdown, and the element has no
 * click handler at all — it cannot be activated by keyboard or AT either.
 *
 * Christmas-only: the caller renders it behind `isChristmasTheme()`.
 */

/** How close (px) the cursor may get to the button's edge before it flees. */
const TRIGGER_PX = 104
/** Keep this much breathing room from the section edges. */
const EDGE_PAD = 10
/** Candidate positions sampled per escape — the best one wins. */
const SAMPLES = 60
/** Escape counts at which the button taunts the worker. */
const TAUNTS_AT = [3, 5, 8, 12, 16]
const TAUNTS = [
  'Nice try — the elf ran off with the bonus!',
  'Ho ho ho! You\u2019ll have to be quicker than that!',
  'So close… it slipped behind the tinsel.',
  'This bonus moves faster than a Friday clock-out!',
  'Even the reindeer gave up chasing that one.',
]

interface Point {
  x: number
  y: number
}

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/** Distance from a point to a rectangle's nearest edge (0 when inside). */
function edgeDistance(x: number, y: number, r: Rect): number {
  const dx = Math.max(r.left - x, 0, x - r.right)
  const dy = Math.max(r.top - y, 0, y - r.bottom)
  return Math.hypot(dx, dy)
}

export function ClaimBonusButton({ containerRef }: { containerRef: RefObject<HTMLElement> }) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const posRef = useRef<Point>({ x: 0, y: 0 })
  const cursorRef = useRef<Point | null>(null)
  const escapesRef = useRef(0)
  const tauntRef = useRef(0)
  const settleTimer = useRef<number | undefined>(undefined)
  const rafRef = useRef<number | undefined>(undefined)
  const [pos, setPos] = useState<Point | null>(null)
  const [tilt, setTilt] = useState(0)

  /**
   * Choose a random resting spot inside the section. Candidates are scored
   * by distance from the cursor and distance from the current spot, and
   * penalised heavily for overlapping real controls, so the button only
   * ever lands on top of something when the section is genuinely too small
   * to avoid it.
   */
  const pickSpot = useCallback((cursor: Point | null): Point | null => {
    const container = containerRef.current
    const anchor = anchorRef.current
    if (!container || !anchor) return null
    const c = container.getBoundingClientRect()
    const bw = anchor.offsetWidth
    const bh = anchor.offsetHeight
    const maxX = c.width - bw - EDGE_PAD * 2
    // Never rest below the fold: the section can run taller than the viewport
    // on phones, and a bonus the worker never sees is no joke at all. Sample
    // only the band currently on screen (section-relative coordinates).
    const viewH = (window.visualViewport?.height ?? window.innerHeight) * 0.9
    const visibleTop = Math.max(0, window.scrollY + (window.visualViewport?.offsetTop ?? 0) - c.top)
    const visibleBottom = Math.min(c.height, visibleTop + viewH)
    const minY = Math.min(visibleTop, Math.max(EDGE_PAD, c.height - bh - EDGE_PAD))
    const maxY = Math.max(minY, visibleBottom - bh - EDGE_PAD)
    if (maxX <= 0 || maxY - minY < 0) return null

    // The real, functional controls in the section — the bonus must never
    // camp on top of Clock In / Out, client selects, dialog triggers, etc.
    const blocked: Rect[] = []
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [role="button"]'))) {
      if (el.closest('.xmas-bonus-anchor')) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      blocked.push({
        left: r.left - c.left - 8,
        top: r.top - c.top - 8,
        right: r.right - c.left + 8,
        bottom: r.bottom - c.top + 8,
      })
    }

    const current = posRef.current
    let best: Point | null = null
    let bestScore = -Infinity
    for (let i = 0; i < SAMPLES; i++) {
      const x = EDGE_PAD + Math.random() * maxX
      const y = minY + Math.random() * (maxY - minY)
      const box: Rect = { left: x, top: y, right: x + bw, bottom: y + bh }

      // Stay well outside the cursor's grab radius when fleeing.
      const fromCursor = cursor ? edgeDistance(cursor.x, cursor.y, box) : Infinity
      if (cursor && fromCursor < TRIGGER_PX + 24) continue

      const overlaps = blocked.some((r) => intersects(box, r))
      const wander = Math.hypot(x - current.x, y - current.y)
      const score = fromCursor + wander * 0.15 + Math.random() * 120 - (overlaps ? 100000 : 0)
      if (score > bestScore) {
        bestScore = score
        best = { x, y }
      }
    }

    // Very small / cramped section: relax the control-avoidance rule rather
    // than disappearing, but still keep clear of the cursor.
    if (!best) {
      for (let i = 0; i < SAMPLES; i++) {
        const x = EDGE_PAD + Math.random() * maxX
        const y = minY + Math.random() * (maxY - minY)
        const box: Rect = { left: x, top: y, right: x + bw, bottom: y + bh }
        const fromCursor = cursor ? edgeDistance(cursor.x, cursor.y, box) : Infinity
        if (cursor && fromCursor < TRIGGER_PX) continue
        const wander = Math.hypot(x - current.x, y - current.y)
        const score = fromCursor + wander * 0.15 + Math.random() * 120
        if (score > bestScore) {
          bestScore = score
          best = { x, y }
        }
      }
    }
    return best
  }, [containerRef])

  /** Lean in the escape direction, spring to the new spot, then straighten. */
  const flee = useCallback((clientX: number, clientY: number) => {
    const container = containerRef.current
    if (!container) return
    const c = container.getBoundingClientRect()
    const cursor = { x: clientX - c.left, y: clientY - c.top }
    cursorRef.current = cursor
    const next = pickSpot(cursor)
    if (!next) return

    const prev = posRef.current
    posRef.current = next
    setPos(next)

    // Lean away: horizontal escape drives the rotation, capped at a lively
    // but readable 22°.
    const dx = next.x - prev.x
    const lean = Math.max(-22, Math.min(22, dx * 0.09))
    setTilt(lean || (Math.random() > 0.5 ? 10 : -10))
    window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => setTilt(0), 240)

    const count = ++escapesRef.current
    const tauntIndex = TAUNTS_AT.indexOf(count)
    if (tauntIndex !== -1 && tauntRef.current < TAUNTS.length) {
      const message = TAUNTS[tauntRef.current]
      tauntRef.current += 1
      toast(message, { icon: <Gift className="h-4 w-4 text-[hsl(355_72%_42%)]" /> })
    }
  }, [containerRef, pickSpot])

  // Pick the initial random resting spot once everything is measured.
  useLayoutEffect(() => {
    const spot = pickSpot(null)
    if (spot) {
      posRef.current = spot
      setPos(spot)
    }
  }, [pickSpot])

  // Track the mouse across the whole section and flee before a hover can
  // land. rAF-throttled because pointermove fires at device rate. Native
  // listener (rather than JSX) keeps TrackerPage free of dodge logic.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      const anchor = anchorRef.current
      if (!anchor) return
      if (rafRef.current != null) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = undefined
        const r = anchor.getBoundingClientRect()
        if (edgeDistance(e.clientX, e.clientY, { left: r.left, top: r.top, right: r.right, bottom: r.bottom }) < TRIGGER_PX) {
          flee(e.clientX, e.clientY)
        }
      })
    }
    container.addEventListener('pointermove', onMove)
    return () => {
      container.removeEventListener('pointermove', onMove)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      window.clearTimeout(settleTimer.current)
    }
  }, [containerRef, flee])

  // Re-pick when the section changes shape (clock in vs. running timer cards
  // are very different heights), and stay inside if merely resized.
  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    let lastH = container.getBoundingClientRect().height
    const observer = new ResizeObserver(() => {
      const h = container.getBoundingClientRect().height
      const reshaped = Math.abs(h - lastH) > 48
      lastH = h
      const next = pickSpot(reshaped ? null : cursorRef.current)
      if (next) {
        posRef.current = next
        setPos(next)
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef, pickSpot])

  return (
    <div
      ref={anchorRef}
      className="xmas-bonus-anchor"
      aria-hidden="true"
      style={{
        visibility: pos ? 'visible' : 'hidden',
        transform: pos ? `translate3d(${pos.x}px, ${pos.y}px, 0)` : undefined,
      }}
    >
      <div className="xmas-bonus-tilt" style={{ transform: `rotate(${tilt}deg)` }}>
        {/* No click handler and tabIndex -1: the bonus is decoration, never an action. */}
        <button
          type="button"
          tabIndex={-1}
          className="xmas-bonus"
          onPointerEnter={(e) => {
            // Safety net for fast mouse sweeps that skip the proximity check.
            if (e.pointerType === 'mouse') flee(e.clientX, e.clientY)
          }}
          onPointerDown={(e) => {
            // Touch / pen: move before the tap can become a click.
            e.preventDefault()
            flee(e.clientX, e.clientY)
          }}
          onFocus={(e) => e.currentTarget.blur()}
        >
          <SantaHat className="xmas-bonus-hat" />
          <span className="xmas-bonus-bob">
            <Gift className="h-4 w-4" />
            Claim your bonus
          </span>
        </button>
      </div>
    </div>
  )
}
