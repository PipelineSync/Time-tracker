/**
 * The PipelineSync atmosphere: blurred drifting orbs (orange top-left, blue
 * top-right, faint cyan lower down), a 64px grid that fades out from the top
 * and a faint noise grain. All of it is CSS (`.ps-ambient` in index.css),
 * fixed behind the app at a negative z-index with no pointer events, and
 * dimmed in the app so data stays readable. The orbs stop drifting for
 * `prefers-reduced-motion`.
 *
 * Also hosts the shared SVG gradients the charts fill with (`url(#ps-bar)`),
 * so every recharts chart can use the brand orange → blue without repeating
 * <defs>. The stops read CSS variables, so seasonal skins re-colour them.
 */
export function AmbientBackground() {
  return (
    <>
      <div className="ps-ambient" aria-hidden="true">
        <div className="ps-orb ps-orb-a" />
        <div className="ps-orb ps-orb-b" />
        <div className="ps-orb ps-orb-c" />
        <div className="ps-grid" />
        <div className="ps-noise" />
      </div>
      <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
        <defs>
          {/* Vertical bars: orange at the top fading into blue. */}
          <linearGradient id="ps-bar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--chart-a)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--chart-b)' }} />
          </linearGradient>
          {/* Horizontal bars and lines: orange → blue left to right. */}
          <linearGradient id="ps-line" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" style={{ stopColor: 'var(--chart-a)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--chart-b)' }} />
          </linearGradient>
          {/* Area fill: orange at 28% fading to transparent. */}
          <linearGradient id="ps-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--chart-a)', stopOpacity: 0.28 }} />
            <stop offset="100%" style={{ stopColor: 'var(--chart-a)', stopOpacity: 0 }} />
          </linearGradient>
        </defs>
      </svg>
    </>
  )
}
