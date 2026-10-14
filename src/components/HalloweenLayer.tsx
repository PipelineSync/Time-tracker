import { useMemo } from 'react'

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

export function HalloweenLayer() {
  const embers = useMemo(makeEmbers, [])
  const bats = useMemo(makeBats, [])

  return (
    <div className="halloween-layer" aria-hidden="true">
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
  )
}
