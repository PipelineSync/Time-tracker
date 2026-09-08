import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

/**
 * A Santa hat, drawn as an SVG so it stays crisp at any size and can be
 * tilted over a logo mark without shipping a second set of raster assets.
 *
 * The viewBox is 100x100 with the hat's brim sitting along the bottom edge,
 * so a caller can position it by its bottom-left corner and know the fluffy
 * white brim is what lands on the logo.
 */
export function SantaHat({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn('pointer-events-none select-none', className)}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {/* Red cap: sweeps up from the brim and flops over to the right. */}
      <path
        d="M8 74
           C 6 50, 20 22, 44 14
           C 62 8, 78 14, 84 26
           C 88 34, 84 41, 76 42
           C 62 44, 52 52, 46 62
           C 42 69, 40 74, 40 74
           Z"
        fill="#D42B2B"
      />
      {/* Darker underside of the flop, for a bit of depth. */}
      <path
        d="M84 26 C 88 34, 84 41, 76 42 C 66 43, 58 47, 52 53 C 62 46, 74 44, 79 38 C 83 33, 85 29, 84 26 Z"
        fill="#A81F1F"
        opacity="0.85"
      />
      {/* White fur brim across the bottom. */}
      <rect x="2" y="70" width="52" height="24" rx="12" fill="#FFFFFF" />
      <rect x="2" y="70" width="52" height="24" rx="12" fill="#E3EAF2" opacity="0.5" />
      <rect x="2" y="70" width="52" height="17" rx="8.5" fill="#FFFFFF" />
      {/* Pompom at the tip of the flop. */}
      <circle cx="82" cy="36" r="13" fill="#FFFFFF" />
      <circle cx="79" cy="33" r="9" fill="#F7FAFF" />
    </svg>
  )
}
