/**
 * Loads the built extension in real Chrome (headless) and drives the popup
 * against the mock Supabase: connect → sign in → clock in → break → clock out.
 *
 * This is the check that proves the parts a unit test cannot: MV3 module
 * loading under the extension CSP, chrome.storage, real fetches from a
 * chrome-extension:// origin, and the popup's own UI state machine.
 *
 * Run with:  npm run verify:chrome   (from the extension folder)
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDir = resolve(here, '..')
const require = createRequire(import.meta.url)

// Puppeteer is deliberately NOT a dependency — adding it would make every
// `npm install` download a copy of Chrome. Install it only when you want to
// run this check:  npm i -D puppeteer && npm run verify:chrome
let puppeteer
try {
  puppeteer = require('puppeteer')
} catch {
  console.error(
    'This check needs Puppeteer, which is not installed by default (it downloads Chrome).\n' +
      'Install it with:\n\n  npm i -D puppeteer\n\nThen run:  npm run verify:chrome',
  )
  process.exit(0)
}

const { startMockSupabase } = await import('./mock-supabase.mjs')

const distDir = join(extensionDir, 'dist')
if (!existsSync(join(distDir, 'manifest.json'))) {
  console.error('✗ No build found. Run `npm run build` first.')
  process.exit(1)
}

let passed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failures.push(label)
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Wait until `fn()` in the page returns a truthy value. */
async function waitForValue(page, fn, { timeout = 10_000, label = 'condition' } = {}) {
  const started = Date.now()
  for (;;) {
    const value = await page.evaluate(fn)
    if (value) return value
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`)
    await sleep(150)
  }
}

// ---------------------------------------------------------------------------
// A copy of the build with the mock's origin pre-granted as a host permission.
// (The shipped build asks for it at runtime via chrome.permissions.request,
// which cannot be answered by a headless browser.)
// ---------------------------------------------------------------------------
async function prepareTestBuild(mockUrl) {
  const target = join(tmpdir(), `work-tracker-ext-test-${Date.now()}`)
  await mkdir(target, { recursive: true })
  const { cp } = await import('node:fs/promises')
  await cp(distDir, target, { recursive: true })

  const manifestPath = join(target, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.host_permissions = [`${mockUrl}/*`]
  delete manifest.optional_host_permissions
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  return target
}

/**
 * Unpacked extension ids are a hash of the install path; Chrome also records
 * them in the profile's Preferences. Try the profile first, fall back to the
 * hash.
 */
async function findExtensionId(profileDir, path) {
  try {
    const prefs = JSON.parse(await readFile(join(profileDir, 'Default', 'Preferences'), 'utf8'))
    const ids = Object.keys(prefs?.extensions?.settings ?? {})
    if (ids.length === 1) return ids[0]
    if (ids.length > 1) {
      // More than one: take the one whose manifest name is ours.
      for (const id of ids) {
        if (prefs.extensions.settings[id]?.manifest?.name?.startsWith('Work Tracker')) return id
      }
    }
  } catch {
    /* fall through to the hash */
  }
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 32)
  return Array.from(hash)
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('')
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const mock = await startMockSupabase()
await mkdir(join(extensionDir, 'screenshots'), { recursive: true })
const testBuild = await prepareTestBuild(mock.url)
const profileDir = join(tmpdir(), `work-tracker-profile-${Date.now()}`)

let browser
try {
  browser = await puppeteer.launch({
    headless: true,
    userDataDir: profileDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--disable-extensions-except=${testBuild}`,
      `--load-extension=${testBuild}`,
    ],
  })
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/Could not find Chrome|Could not find browser|Failed to launch/i.test(message)) {
    console.error(
      'Chrome is not available on this machine. Install it with:\n\n  npx puppeteer browsers install chrome\n\nthen re-run:  npm run verify:chrome',
    )
    await mock.close()
    process.exit(0)
  }
  throw error
}

try {
  const extensionId = await findExtensionId(profileDir, testBuild)
  const origin = `chrome-extension://${extensionId}`
  console.log(`\nLoaded extension ${extensionId}\n`)

  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`console: ${msg.text()}`)
  })

  console.log('Options page')
  await page.goto(`${origin}/options.html`, { waitUntil: 'domcontentloaded' })
  await page.type('#cfg-url', mock.url)
  await page.type('#cfg-key', mock.anonKey)
  await page.click('#btn-save')
  const status = await waitForValue(
    page,
    () => {
      const node = document.getElementById('cfg-status')
      return node && !node.hidden && node.dataset.tone ? node.textContent : null
    },
    { label: 'connection result' },
  )
  check(`save reports "${status}"`, /Connected to/.test(status), status)

  console.log('\nPopup — sign in')
  await page.goto(`${origin}/popup.html`, { waitUntil: 'domcontentloaded' })
  await waitForValue(page, () => !document.getElementById('view-login').hidden, { label: 'login view' })
  await page.type('#login-email', 'ana@example.com')
  await page.type('#login-password', 'worker123')
  await page.click('#login-submit')
  await waitForValue(
    page,
    () => {
      const clock = document.getElementById('view-clock')
      return clock && !clock.hidden ? 'clock' : null
    },
    { label: 'clock view' },
  )
  const who = await page.$eval('#brand-sub', (n) => n.textContent)
  check(`signed in as ${who}`, who === 'Ana Reyes', who)
  check('status pill says clocked out', (await page.$eval('#status-text', (n) => n.textContent)) === 'Clocked out')

  console.log('\nPopup — clock in')
  await page.click('#btn-toggle-details')
  await page.type('#clockin-project', 'Site A')
  await page.click('#btn-clock-in')
  await waitForValue(page, () => document.getElementById('status-pill').dataset.state === 'working', {
    label: 'working status',
  })
  check('status is Working', (await page.$eval('#status-text', (n) => n.textContent)) === 'Working')
  check('a timer row exists', mock.db.active_timers.length === 1)
  await sleep(1200)
  const ticked = await page.$eval('#timer', (n) => n.textContent)
  check(`timer is counting (${ticked})`, ticked !== '00:00:00')

  console.log('\nPopup — break')
  await page.click('#btn-break')
  await waitForValue(page, () => document.getElementById('status-pill').dataset.state === 'break', {
    label: 'break status',
  })
  check('status is On break', (await page.$eval('#status-text', (n) => n.textContent)) === 'On break')
  const frozenA = await page.$eval('#timer', (n) => n.textContent)
  await sleep(1500)
  const frozenB = await page.$eval('#timer', (n) => n.textContent)
  check(`working timer freezes while on break (${frozenA} → ${frozenB})`, frozenA === frozenB)
  check('break button flips to End break', (await page.$eval('#btn-break', (n) => n.textContent)) === 'End break')

  await page.click('#btn-break')
  await waitForValue(page, () => document.getElementById('status-pill').dataset.state === 'working', {
    label: 'back to work',
  })
  check('back to Working', (await page.$eval('#status-text', (n) => n.textContent)) === 'Working')
  check('break time banked', mock.db.active_timers[0].total_pause_ms > 0, mock.db.active_timers[0])

  console.log('\nPopup — clock out')
  await page.click('#btn-clock-out')
  await waitForValue(page, () => !document.getElementById('view-confirm').hidden, { label: 'confirm view' })
  const summary = await page.$eval('#confirm-summary', (n) => n.textContent)
  check(`summary shows the shift (${summary})`, /Worked/.test(summary) && /Breaks/.test(summary))
  await page.type('#confirm-note', 'Called it a day')
  await page.click('#btn-confirm-clockout')
  await waitForValue(
    page,
    () => {
      const toast = document.getElementById('toast')
      return toast && !toast.hidden ? toast.textContent : null
    },
    { label: 'clock out toast' },
  )
  const toastText = await page.$eval('#toast', (n) => n.textContent)
  check(`toast confirms it (${toastText})`, /Clocked out/.test(toastText))
  check('time entry written', mock.db.time_entries.length === 1, mock.db.time_entries.length)
  check('note saved on the entry', /Called it a day/.test(mock.db.time_entries[0]?.notes ?? ''), mock.db.time_entries[0]?.notes)
  check('timer row removed', mock.db.active_timers.length === 0)
  check(
    'admin was notified',
    ['time_in', 'break_start', 'break_end', 'time_out'].every((type) => mock.db.notifications.some((n) => n.type === type)),
    mock.db.notifications.map((n) => n.type),
  )

  const today = await page.$eval('#today-time', (n) => n.textContent)
  console.log(`\n  today's total in the popup: ${today}`)

  console.log('\nPopup — session persists')
  const page2 = await browser.newPage()
  await page2.goto(`${origin}/popup.html`, { waitUntil: 'domcontentloaded' })
  const stillSignedIn = await waitForValue(
    page2,
    () => {
      const clock = document.getElementById('view-clock')
      return clock && !clock.hidden ? document.getElementById('brand-sub').textContent : null
    },
    { label: 'session restored in a fresh popup' },
  )
  check(`reopening the popup stays signed in (${stillSignedIn})`, stillSignedIn === 'Ana Reyes')

  // Screenshots for a visual check.
  await page2.setViewport({ width: 340, height: 420, deviceScaleFactor: 2 })
  await page2.goto(`${origin}/popup.html`, { waitUntil: 'domcontentloaded' })
  await waitForValue(page2, () => !document.getElementById('view-clock').hidden, { label: 'clock view again' })
  await page2.screenshot({ path: join(extensionDir, 'screenshots', 'popup-clocked-out.png') })
  await page2.click('#btn-clock-in')
  await waitForValue(page2, () => document.getElementById('status-pill').dataset.state === 'working', { label: 'working' })
  await sleep(1500)
  await page2.screenshot({ path: join(extensionDir, 'screenshots', 'popup-working.png') })
  await page2.click('#btn-break')
  await waitForValue(page2, () => document.getElementById('status-pill').dataset.state === 'break', { label: 'break' })
  await page2.screenshot({ path: join(extensionDir, 'screenshots', 'popup-on-break.png') })
  await page2.click('#btn-clock-out')
  await waitForValue(page2, () => !document.getElementById('view-confirm').hidden, { label: 'confirm' })
  await page2.screenshot({ path: join(extensionDir, 'screenshots', 'popup-confirm.png') })
  await page2.goto(`${origin}/options.html`, { waitUntil: 'domcontentloaded' })
  await page2.setViewport({ width: 720, height: 900, deviceScaleFactor: 2 })
  await page2.screenshot({ path: join(extensionDir, 'screenshots', 'options.png'), fullPage: true })

  check('no page errors in the extension', pageErrors.length === 0, pageErrors)
} finally {
  await browser.close()
  await mock.close()
  await rm(testBuild, { recursive: true, force: true })
  await rm(profileDir, { recursive: true, force: true })
}

console.log(`\n${failures.length === 0 ? '✅' : '❌'} ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exit(1)
}
