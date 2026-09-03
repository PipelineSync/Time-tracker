/**
 * Validates the built extension without a browser.
 *
 * Catches the packaging mistakes that Chrome would reject or silently ignore:
 * files the manifest points at that were not emitted, remote scripts (banned
 * by the MV3 CSP), dynamic code evaluation, and missing icons.
 *
 * Run with:  npm run verify:build   (from the extension folder)
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, '..', 'dist')

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

async function exists(relative) {
  try {
    const info = await stat(join(dist, relative))
    return info.isFile()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
console.log('Manifest')
const manifestText = await readFile(join(dist, 'manifest.json'), 'utf8')
const manifest = JSON.parse(manifestText)

check('manifest_version is 3', manifest.manifest_version === 3, manifest.manifest_version)
check('has a name and version', Boolean(manifest.name && manifest.version))
check('declares a popup', typeof manifest.action?.default_popup === 'string')
check('declares an options page', typeof manifest.options_page === 'string')
check('requests only the storage permission', JSON.stringify(manifest.permissions) === '["storage"]', manifest.permissions)

const referenced = [
  manifest.action?.default_popup,
  manifest.options_page,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
].filter(Boolean)

for (const file of referenced) {
  check(`manifest file exists: ${file}`, await exists(file))
}

console.log('\nHTML entries')
for (const entry of [manifest.action.default_popup, manifest.options_page]) {
  const html = await readFile(join(dist, entry), 'utf8')
  const refs = [
    ...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]),
  ]
  check(`${entry} references local assets only`, refs.length > 0 && refs.every((r) => !/^https?:/i.test(r)), refs)
  for (const ref of refs) {
    check(`${entry} → ${ref}`, await exists(ref.replace(/^\.?\//, '')))
  }
}

console.log('\nCSP safety')
async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

const jsFiles = (await walk(dist)).filter((f) => f.endsWith('.js'))
check('bundle emitted JavaScript', jsFiles.length > 0, jsFiles.length)

const banned = [
  { pattern: /\beval\s*\(/, label: 'eval()' },
  { pattern: /new\s+Function\s*\(/, label: 'new Function()' },
  { pattern: /document\s*\.\s*write\s*\(/, label: 'document.write()' },
]

for (const file of jsFiles) {
  const source = await readFile(file, 'utf8')
  for (const { pattern, label } of banned) {
    check(`${file.slice(dist.length + 1)} has no ${label}`, !pattern.test(source))
  }
}

console.log('\nIcons')
for (const size of ['16', '32', '48', '128']) {
  const file = `icons/icon-${size}.png`
  const ok = await exists(file)
  let bytes = 0
  if (ok) bytes = (await stat(join(dist, file))).size
  check(`icon ${size}×${size} (${bytes} B)`, ok && bytes > 100)
}

console.log('\nSize')
const allFiles = await walk(dist)
let total = 0
for (const file of allFiles) total += (await stat(file)).size
console.log(`  ${allFiles.length} files, ${(total / 1024).toFixed(1)} kB unpacked`)
check('bundle stays under 2 MB', total < 2 * 1024 * 1024, total)

console.log(`\n${failures.length === 0 ? '✅' : '❌'} ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exit(1)
}
