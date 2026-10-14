import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * Nova AI's orb: a rotating globe of particles, orange in front and blue
 * behind, drawn on a canvas. No dependencies.
 *
 * The state tints and paces it:
 *   idle      — slow spin, a gentle breath
 *   thinking  — fast spin, no ripple (Nova is working)
 *   listening — blue glow (waiting for the person, e.g. an approval)
 *   complete  — green (an action just went through)
 *   error     — red (something failed)
 *
 * Reduced motion draws one still frame per state change instead of
 * animating. Small orbs use fewer particles, so the always-visible corner
 * button stays cheap; the browser pauses the loop in background tabs.
 */
export type OrbState = 'idle' | 'thinking' | 'listening' | 'complete' | 'error'

type RGB = readonly [number, number, number]

const PALETTE: Record<OrbState, { front: RGB; back: RGB; glow: RGB }> = {
  idle: { front: [255, 122, 26], back: [91, 140, 255], glow: [255, 122, 26] },
  listening: { front: [255, 122, 26], back: [91, 140, 255], glow: [91, 140, 255] },
  thinking: { front: [255, 171, 94], back: [91, 140, 255], glow: [255, 171, 94] },
  complete: { front: [52, 211, 153], back: [63, 208, 238], glow: [52, 211, 153] },
  error: { front: [248, 113, 113], back: [91, 140, 255], glow: [248, 113, 113] },
}
const SPIN: Record<OrbState, number> = { idle: 0.3, listening: 0.35, thinking: 1.6, complete: 0.45, error: 0.15 }

/** Points spread evenly over a unit sphere (Fibonacci lattice), cached per count. */
const lattices = new Map<number, [number, number, number][]>()
function lattice(n: number) {
  let pts = lattices.get(n)
  if (!pts) {
    pts = []
    for (let i = 0; i < n; i++) {
      const y = 1 - ((i + 0.5) / n) * 2
      const r = Math.sqrt(1 - y * y)
      const th = i * 2.39996
      pts.push([Math.cos(th) * r, y, Math.sin(th) * r])
    }
    lattices.set(n, pts)
  }
  return pts
}

function targetLevel(st: OrbState, t: number): number {
  if (st === 'thinking') return 0
  if (st === 'listening') return 0.1 + 0.05 * Math.sin(t * 2)
  if (st === 'complete') return 0.12 + 0.06 * Math.sin(t * 3)
  return 0.05 + 0.03 * Math.sin(t * 1.6)
}

export function NovaOrb({
  state = 'idle',
  size,
  className,
}: {
  state?: OrbState
  /** CSS pixel size of the square canvas. */
  size: number
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  // Kept across effect restarts so a state change never makes the globe jump.
  const motion = useRef({ spin: 0, level: 0 })

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    let g: CanvasRenderingContext2D | null = null
    try {
      g = cv.getContext('2d')
    } catch {
      g = null
    }
    if (!g) return
    const ctx = g
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const pts = lattice(size < 80 ? 220 : size < 160 ? 360 : 520)

    let raf = 0
    let last = 0
    const m = motion.current

    const draw = (nowMs: number) => {
      const st = stateRef.current
      const now = nowMs / 1000
      const dt = reduced || !last ? 0 : Math.min(0.05, now - last)
      last = now
      const t = reduced ? 4.2 : now
      const target = reduced ? (st === 'thinking' ? 0 : 0.25) : targetLevel(st, t)
      m.level += (target - m.level) * (reduced ? 1 : Math.min(1, dt * 12))
      m.spin += dt * SPIN[st]
      const level = m.level

      // Keep the backing store in step with the size and pixel density.
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const px = Math.round(size * dpr)
      if (cv.width !== px || cv.height !== px) {
        cv.width = px
        cv.height = px
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, size)

      const pal = PALETTE[st]
      const c = size / 2
      const R = size * 0.34
      // Soft glow behind the globe, tinted by state.
      const glow = ctx.createRadialGradient(c, c, R * 0.2, c, c, R * 1.45)
      glow.addColorStop(0, `rgba(${pal.glow.join(',')},${(0.16 + level * 0.18).toFixed(3)})`)
      glow.addColorStop(1, `rgba(${pal.glow.join(',')},0)`)
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(c, c, R * 1.45, 0, Math.PI * 2)
      ctx.fill()

      const wave = st === 'thinking' ? 0 : Math.min(1, level) * 0.28
      const cs = Math.cos(m.spin)
      const sn = Math.sin(m.spin)
      const ct = Math.cos(0.35)
      const stl = Math.sin(0.35)
      const dot = Math.max(0.6, R / 70)
      for (const p of pts) {
        const x = p[0] * cs - p[2] * sn
        let z = p[0] * sn + p[2] * cs
        const y = p[1] * ct - z * stl
        z = p[1] * stl + z * ct
        const d = 1 + wave * Math.sin(p[1] * 7 + t * 6) * Math.cos(p[0] * 5 - t * 3)
        const k = (z + 1) / 2 // 0 = back, 1 = front
        const [b0, b1, b2] = pal.back
        const [f0, f1, f2] = pal.front
        ctx.fillStyle = `rgba(${Math.round(b0 + (f0 - b0) * k)},${Math.round(b1 + (f1 - b1) * k)},${Math.round(
          b2 + (f2 - b2) * k,
        )},${(0.22 + 0.78 * k).toFixed(3)})`
        ctx.beginPath()
        ctx.arc(c + x * R * d, c + y * R * d, dot * (0.6 + 1.5 * k), 0, Math.PI * 2)
        ctx.fill()
      }
      if (!reduced) raf = window.requestAnimationFrame(draw)
    }

    raf = window.requestAnimationFrame(draw)
    return () => window.cancelAnimationFrame(raf)
    // Under reduced motion, redraw once whenever the state changes.
  }, [size, state])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn('block shrink-0', className)}
      style={{ width: size, height: size }}
    />
  )
}
