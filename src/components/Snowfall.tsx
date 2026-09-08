import { useMemo } from 'react'

/**
 * Semi-transparent falling snow, painted across the whole viewport.
 *
 * Readability comes first, so this layer is deliberately restrained:
 *   * it is `pointer-events-none` and sits at a negative z-index, so it never
 *     intercepts a click and never paints over text — content scrolls above it;
 *   * flakes are small and low-opacity (12–38%), so they read as texture
 *     rather than competing with type;
 *   * it is `aria-hidden` and honours `prefers-reduced-motion` (the CSS in
 *     index.css freezes the animation), so it is not a problem for anyone who
 *     finds movement distracting.
 */
const FLAKE_COUNT = 40

interface Flake {
  left: number
  size: number
  duration: number
  delay: number
  opacity: number
  drift: number
}

/** Deterministic PRNG so the flake layout is stable across re-renders. */
function makeFlakes(): Flake[] {
  let seed = 20251225
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
  return Array.from({ length: FLAKE_COUNT }, () => {
    const size = 3 + rand() * 6 // 3–9px
    return {
      left: rand() * 100,
      size,
      // Bigger flakes fall a little faster — cheap sense of depth.
      duration: 16 - (size / 9) * 6 + rand() * 6,
      delay: -rand() * 22,
      // Small flakes stay fainter, so the layer never muddies the text.
      opacity: 0.12 + (size / 9) * 0.26,
      drift: -40 + rand() * 80,
    }
  })
}

export function Snowfall() {
  const flakes = useMemo(makeFlakes, [])

  return (
    <div className="snowfall" aria-hidden="true">
      {flakes.map((f, i) => (
        <span
          key={i}
          className="snowflake"
          style={{
            left: `${f.left}%`,
            width: `${f.size}px`,
            height: `${f.size}px`,
            opacity: f.opacity,
            animationDuration: `${f.duration}s`,
            animationDelay: `${f.delay}s`,
            ['--drift' as string]: `${f.drift}px`,
          }}
        />
      ))}
    </div>
  )
}
