/**
 * Verification of the festive "Claim your bonus" prank button:
 *  - it stays desktop-only (`hidden lg:block`), so phones — where every "hover"
 *    is a finger and the escaping button is pure tap-bait over the clock
 *    controls — never render it
 *  - "desktop" means the app shell's own breakpoint: the same `lg` at which the
 *    sidebar appears and the bottom tab bar disappears
 *  - hidden below `lg` is also inert below `lg`: no dodge maths, no taunt
 *    toasts, nothing to measure
 *  - the button is still decoration: no click handler, not focusable, and
 *    still gated behind the Christmas theme
 *
 * Static-source checks (the component is DOM-driven and has no testable pure
 * core); they guard the one thing that regresses silently — the breakpoint and
 * the display rule drifting apart.
 *
 * Run: npx tsx scripts/verify-claim-bonus.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

/** Body of a plain top-level CSS rule, or '' when the selector is missing. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) return ''
  const end = css.indexOf('}', start)
  return end === -1 ? '' : css.slice(start, end)
}

const button = read('src/components/ClaimBonusButton.tsx')
const layout = read('src/components/AppLayout.tsx')
const tracker = read('src/pages/TrackerPage.tsx')
const css = read('src/index.css')

console.log('--- Mobile is hidden ---')
assert(
  /className="xmas-bonus-anchor hidden lg:block"/.test(button),
  'Anchor is `xmas-bonus-anchor hidden lg:block` (hidden on mobile, shown from lg)',
)
assert(
  button.includes('if (bw === 0 || bh === 0) return null'),
  'pickSpot bails when the hidden anchor measures 0, so mobile runs no dodge maths',
)
assert(
  !ruleBody(css, '.xmas-bonus-anchor').includes('display:'),
  'The .xmas-bonus-anchor CSS rule declares no `display`, so Tailwind `hidden` is not overridden',
)

console.log('--- lg is the shell\'s own mobile/desktop split ---')
assert(layout.includes('lg:hidden'), 'The mobile chrome (bottom nav / header) is `lg:hidden`')
assert(layout.includes('hidden w-64 flex-col bg-sidebar lg:flex'), 'The desktop sidebar appears at `lg`')
assert(button.includes('hidden lg:block') && !/\bmd:block\b/.test(button), 'The button uses the same `lg` breakpoint, not `md`')

console.log('--- Still inert, still festive ---')
assert(button.includes('tabIndex={-1}'), 'Not focusable by keyboard')
assert(!/onClick=/.test(button), 'No click handler — the bonus is decoration, never an action')
assert(button.includes('aria-hidden'), 'Hidden from assistive tech')

console.log('--- Wiring ---')
assert(tracker.includes('isChristmasTheme() && <ClaimBonusButton'), 'TrackerPage renders it only with the Christmas theme')
assert(tracker.includes('containerRef={sectionRef}'), 'TrackerPage still hands it the clock in/out section as its playground')

if (process.exitCode) {
  console.error('\n"Claim your bonus" verification FAILED')
} else {
  console.log('\n"Claim your bonus" verification passed successfully!')
}
