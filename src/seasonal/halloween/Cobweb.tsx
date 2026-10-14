/**
 * A corner cobweb, anchored top-right (mirror it with CSS for a left corner).
 * Radial threads from the corner plus sagging rings between them.
 */
export function Cobweb({ className }: { className?: string }) {
  const threads = [0, 18, 36, 54, 72, 90].map((deg) => {
    const r = (deg * Math.PI) / 180
    return { x: 100 - Math.sin(r) * 100, y: Math.cos(r) * 100 }
  })
  const rings = [26, 46, 66, 86].map((radius) =>
    threads
      .slice(0, -1)
      .map((_, i) => {
        const a = (threads[i].x - 100) / 100
        const b = threads[i].y / 100
        const c = (threads[i + 1].x - 100) / 100
        const d = threads[i + 1].y / 100
        const x1 = 100 + a * radius
        const y1 = b * radius
        const x2 = 100 + c * radius
        const y2 = d * radius
        // Sag the strand toward the corner a little.
        const mx = (x1 + x2) / 2 + 4
        const my = (y1 + y2) / 2 - 4
        return `${i === 0 ? `M${x1} ${y1}` : ''} Q${mx} ${my} ${x2} ${y2}`
      })
      .join(' ')
  )
  return (
    <svg viewBox="0 0 100 100" className={`halloween-cobweb ${className ?? ''}`} aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="0.7" strokeLinecap="round">
        {threads.map((t, i) => (
          <line key={i} x1="100" y1="0" x2={t.x} y2={t.y} />
        ))}
        {rings.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
      {/* A tiny spider hanging off the second ring. */}
      <line x1="72" y1="0" x2="72" y2="34" stroke="currentColor" strokeWidth="0.5" />
      <circle cx="72" cy="37" r="3" fill="currentColor" />
    </svg>
  )
}
