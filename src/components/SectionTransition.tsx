import { useLocation } from 'react-router-dom'
import { sectionKeyFor } from '@/lib/sectionTransition'

/**
 * Plays a short fade + slide-up whenever the user moves to a different
 * section (Dashboard → Time Entries → Finance …).
 *
 * How it works: the wrapper's React `key` is the section key for the current
 * route (`@/lib/sectionTransition`), so React unmounts the old page and mounts
 * a fresh element — which restarts the CSS animation. Switching a *tab inside*
 * a section (`/finance?tab=payroll`, `/it-support?ticket=…`) keeps the same
 * key, so those in-page switches stay instant instead of flickering the whole
 * screen on every click.
 *
 * It is CSS, not a motion library: one keyframe in `src/index.css` that
 * `@media (prefers-reduced-motion: reduce)` turns off, so people who ask their
 * OS for less motion get the plain, instant switch and the bundle gains
 * nothing.
 */
export function SectionTransition({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  return (
    <div key={sectionKeyFor(pathname)} className="section-enter">
      {children}
    </div>
  )
}
