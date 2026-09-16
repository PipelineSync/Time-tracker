/**
 * Ad-hoc verification of the section transition policy
 * (`src/lib/sectionTransition.ts`):
 *  - moving between sections (Dashboard → Time Entries → Finance …) counts as
 *    a section change, so the entrance animation replays
 *  - switching a TAB inside a section does not: Finance → Payroll is
 *    `/finance?tab=payroll` and an opened ticket is `/it-support?ticket=…`,
 *    and re-playing the fade there would flicker the page on every click
 *  - the key ignores trailing slashes and hashes, so the native shells'
 *    HashRouter paths and `/entries` vs `/entries/` stay one section
 *  - the CSS the component relies on is actually present, and is switched off
 *    under `prefers-reduced-motion`
 *
 * Run: npx tsx scripts/verify-section-transition-local.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSectionChange, sectionKeyFor, SECTION_TRANSITION_MS } from '../src/lib/sectionTransition'

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`ok: ${msg}`)
  }
}

const root = join(import.meta.dirname ?? '.', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

console.log('--- changing section animates ---')
assert(isSectionChange('/', '/entries'), 'Dashboard → Time Entries is a section change')
assert(isSectionChange('/entries', '/finance'), 'Time Entries → Finance is a section change')
assert(isSectionChange('/tasks', '/settings'), 'Tasks → Settings is a section change')
assert(isSectionChange('/finance?tab=payroll', '/reports'), 'a tabbed section → another section still animates')

console.log('--- staying in a section does not ---')
assert(!isSectionChange('/finance', '/finance?tab=payroll'), 'Finance → its Payroll tab is not a section change')
assert(
  !isSectionChange('/finance?tab=payroll', '/finance?tab=subscriptions'),
  'switching between Finance tabs is not a section change',
)
assert(
  !isSectionChange('/it-support', '/it-support?ticket=abc123'),
  'opening a ticket inside IT Support is not a section change',
)
assert(!isSectionChange('/entries?worker=w1', '/entries?worker=w2'), 'refiltering Time Entries is not a section change')
assert(!isSectionChange('/entries', '/entries'), 'navigating to the same route is not a section change')

console.log('--- key normalisation ---')
assert(sectionKeyFor('/entries/') === '/entries', 'a trailing slash does not start a new section')
assert(sectionKeyFor('/') === '/', 'the dashboard key survives normalisation')
assert(sectionKeyFor('') === '/', 'an empty path falls back to the dashboard key')
assert(sectionKeyFor('/tasks#board') === '/tasks', 'a hash fragment is in-section state, not a new section')

console.log('--- the animation is wired up ---')
const css = read('src/index.css')
assert(css.includes('@keyframes section-enter'), 'src/index.css defines the section-enter keyframes')
assert(/\.section-enter\s*\{[^}]*animation:\s*section-enter/.test(css), '.section-enter plays those keyframes')
assert(
  /translate3d\(0,\s*8px,\s*0\)/.test(css) && /opacity:\s*0/.test(css),
  'the entrance is a fade plus a slide up (opacity 0 → 1, 8px → 0)',
)
assert(
  /prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\.section-enter\s*\{\s*animation:\s*none/.test(css),
  'prefers-reduced-motion: reduce turns the transition off',
)

const component = read('src/components/SectionTransition.tsx')
assert(
  component.includes('key={sectionKeyFor(pathname)}') && component.includes('section-enter'),
  'SectionTransition keys the wrapper by section so the animation replays on a section change',
)

const layout = read('src/components/AppLayout.tsx')
assert(
  /<SectionTransition>[\s\S]*<Outlet \/>[\s\S]*<\/SectionTransition>/.test(layout),
  'AppLayout wraps the routed page (the Outlet) in the transition',
)
assert(
  layout.indexOf('<SectionTransition>') > layout.indexOf('<nav'),
  'only the page content is wrapped — the sidebar nav stays outside and never re-animates',
)
assert(
  /<Suspense fallback=\{<SectionLoading \/>\}>/.test(layout),
  'a lazily loaded section falls back inside the shell, not to the full-screen splash',
)

assert(SECTION_TRANSITION_MS > 0 && SECTION_TRANSITION_MS <= 400, 'the transition is short enough to stay out of the way')

if (process.exitCode) {
  console.error('\nSection transition verification FAILED')
} else {
  console.log('\nSection transition verification passed')
}
