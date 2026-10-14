import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

/**
 * A witch hat, drawn as an SVG so it stays crisp at any size and can be
 * tilted over a logo mark without shipping a second set of raster assets.
 *
 * The viewBox is 100x100 with the brim along the bottom edge (y≈94), so a
 * caller can position it by its bottom-left corner and know the brim is what
 * lands on the logo.
 */
export function WitchHat({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn('pointer-events-none select-none', className)}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {/* Cone: rises from the brim and kinks over at the tip. */}
      <path
        d="M22 80
           C 30 62, 36 44, 44 28
           C 50 16, 58 8, 72 6
           C 66 12, 62 20, 62 30
           C 62 46, 66 64, 72 80
           Z"
        fill="#4b2a7d"
        stroke="#c4b5fd"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* Light edge on the cone, for a bit of depth. */}
      <path d="M44 28 C 50 16, 58 8, 72 6 C 64 10, 56 18, 50 30 C 46 40, 42 54, 38 66 C 40 52, 42 40, 44 28 Z" fill="#8b5cf6" opacity="0.75" />
      {/* Pumpkin-orange band. */}
      <path d="M26 72 C 40 68, 56 68, 70 72 L 72 80 C 56 76, 40 76, 24 80 Z" fill="#ff7a1a" />
      <rect x="44" y="70" width="9" height="9" rx="1.5" fill="none" stroke="#ffd166" strokeWidth="2" />
      {/* Brim. */}
      <ellipse cx="48" cy="86" rx="46" ry="8" fill="#2a1747" stroke="#c4b5fd" strokeWidth="2.5" />
      <ellipse cx="48" cy="84" rx="43" ry="5" fill="#4b2a7d" />
    </svg>
  )
}
