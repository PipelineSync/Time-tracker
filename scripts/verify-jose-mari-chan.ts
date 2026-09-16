import { existsSync, readFileSync } from 'node:fs'
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

console.log('--- Jose Mari Chan asset exists ---')
assert(existsSync(join(root, 'public/jose-mari-chan/classic-peeking.png')), 'classic-peeking.png exists in public/')

console.log('--- Component implementation ---')
const jmc = read('src/components/JoseMariChan.tsx')
assert(jmc.includes('hidden') && jmc.includes('lg:block'), 'Visible on desktop only (hidden lg:block)')
assert(jmc.includes('sectionKeyFor'), 'Hooks into sectionKeyFor to detect section changes')
assert(jmc.includes('pointer-events-none'), 'pointer-events-none prevents blocking app interactions')
assert(jmc.includes('classic-peeking.png'), 'References classic-peeking.png image')
assert(jmc.includes('jmc-anim-section-change'), 'Applies section change animation')

console.log('--- AppLayout integration ---')
const layout = read('src/components/AppLayout.tsx')
assert(layout.includes('<JoseMariChan />') || layout.includes('<JoseMariChan'), 'JoseMariChan is mounted in AppLayout')
assert(layout.indexOf('<JoseMariChan') > layout.indexOf('</aside>'), 'Placed alongside the desktop sidebar')

console.log('--- CSS Animations ---')
const css = read('src/index.css')
assert(css.includes('@keyframes jmc-slide-hide-reappear'), 'Keyframe jmc-slide-hide-reappear is defined')
assert(css.includes('translateX(-120%)') || css.includes('translateX(-'), 'Slides left behind the panel during transition')
assert(
  /prefers-reduced-motion:\s*reduce[\s\S]*?\.jmc-anim-section-change[\s\S]*?animation:\s*none/.test(css),
  'prefers-reduced-motion turns off the animation',
)

if (process.exitCode) {
  console.error('\nJose Mari Chan verification FAILED')
} else {
  console.log('\nJose Mari Chan verification passed successfully!')
}
