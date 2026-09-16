/**
 * Section transition policy — which navigations count as "changing a section",
 * and how long the entrance animation lasts.
 *
 * Deliberately plain data + one pure function, so the rule that matters can be
 * read and tested on its own (`scripts/verify-section-transition-local.ts`):
 * moving Dashboard → Time Entries is a section change and animates, while
 * switching a *tab inside* a section (Finance → Payroll is `/finance?tab=payroll`,
 * an IT Support ticket is `/it-support?ticket=…`) is not — re-playing the
 * animation there would make the page flicker every time someone clicks a tab
 * or opens a row.
 *
 * `SectionTransition` (`@/components/SectionTransition`) uses the key returned
 * here as its React `key`, so the wrapper remounts — and the CSS animation
 * replays — exactly when this function says the section changed.
 */

/** Entrance duration in ms. Mirrors `--section-transition` in `src/index.css`. */
export const SECTION_TRANSITION_MS = 220

/**
 * The animation key for a location. Only the *path* matters: the query string
 * and the hash are in-section state (tabs, selected rows, filters), and the
 * trailing slash is noise (`/entries` and `/entries/` are the same section).
 */
export function sectionKeyFor(pathname: string): string {
  const path = (pathname || '/').split('?')[0].split('#')[0]
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * True when moving from one location to another should replay the entrance
 * animation. Same section (only the tab/query/hash moved) → no animation.
 */
export function isSectionChange(fromPathname: string, toPathname: string): boolean {
  return sectionKeyFor(fromPathname) !== sectionKeyFor(toPathname)
}
