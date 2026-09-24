/**
 * Regression guard for the bug that broke the Claude Connector's sign-in.
 *
 * Work Tracker is an installable PWA. Its service worker precaches the app
 * shell, and it used to answer EVERY navigation from that cache — including
 * `/oauth/authorize`, the one connector route Claude opens in a real browser.
 * React Router then rendered the web app's own login page instead of the
 * connector's sign-in card, so signing in "did nothing": Claude never received
 * an authorization code. Server-side routing was correct the whole time, which
 * is exactly why curl-based checks passed — `/mcp` and `/.well-known/*` are
 * fetched server-to-server, with no service worker anywhere in the path.
 *
 * This harness pins the fix in place:
 *
 *   1. the connector routes are denied in `navigateFallbackDenylist` while
 *      `navigateFallback: '/index.html'` still serves the app on every other
 *      route,
 *   2. the denial is behavioural, not just textual: the patterns really match
 *      the connector paths and really do not match app routes,
 *   3. every connector rewrite in netlify.toml sits ABOVE the SPA catch-all
 *      (Netlify applies the first match) and still targets its function,
 *   4. registration stays `autoUpdate`, so one reload of the app after a
 *      deploy swaps the fixed worker in — no reinstall, no manual unregister.
 *
 * Run: npx tsx scripts/verify-pwa-denylist.ts
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8')

let checks = 0
let failures = 0
function assert(condition: boolean, message: string) {
  checks += 1
  if (condition) {
    console.log(`ok: ${message}`)
  } else {
    failures += 1
    console.error(`FAIL: ${message}`)
  }
}

// ===========================================================================
// vite.config.ts — the service worker's navigation denylist
// ===========================================================================

const viteConfig = read('vite.config.ts')

// The full denylist as it must read: the two Netlify entries predate the
// connector and stay, the three connector entries are the fix.
const EXPECTED_DENYLIST: RegExp[] = [
  /^\/netlify\//,
  /^\/\.netlify\//,
  /^\/oauth\//,
  /^\/mcp(-status)?\/?$/,
  /^\/\.well-known\//,
]

/**
 * Slice `navigateFallbackDenylist: [ ... ]` out of the config and return the
 * regex literals it contains, parsed back into real RegExp objects — so the
 * assertions below run the same matching Workbox will run in the browser.
 */
function readDenylist(source: string): RegExp[] | null {
  const key = source.indexOf('navigateFallbackDenylist:')
  if (key === -1) return null
  const open = source.indexOf('[', key)
  if (open === -1) return null
  const close = source.indexOf(']', open)
  if (close === -1) return null

  const body = source.slice(open + 1, close)

  // Walk the block token by token instead of stripping comments up front: a
  // line comment and the closing delimiter of a literal such as
  // `/^\/netlify\//` both end in `//`, so only a scan that knows whether it is
  // inside a literal can tell them apart.
  const patterns: RegExp[] = []
  let index = 0
  while (index < body.length) {
    const char = body[index]
    if (char === '/' && body[index + 1] === '/') {
      // Between tokens, `//` opens a comment — skip to the end of the line.
      const newline = body.indexOf('\n', index)
      index = newline === -1 ? body.length : newline + 1
      continue
    }
    if (char !== '/') {
      index += 1
      continue
    }
    let literal = ''
    let cursor = index + 1
    let closed = false
    while (cursor < body.length) {
      const next = body[cursor]
      if (next === '\\') {
        literal += next + (body[cursor + 1] ?? '')
        cursor += 2
        continue
      }
      if (next === '/') {
        closed = true
        cursor += 1
        break
      }
      if (next === '\n') break
      literal += next
      cursor += 1
    }
    if (closed) patterns.push(new RegExp(literal))
    index = cursor
  }
  return patterns
}

const denylist = readDenylist(viteConfig)

assert(denylist !== null, 'vite.config.ts still declares a navigateFallbackDenylist')
const patterns = denylist ?? []
const sources = patterns.map((pattern) => pattern.source)

/** Would the service worker refuse to serve the cached shell for this path? */
const denied = (pathname: string) => patterns.some((pattern) => pattern.test(pathname))

assert(
  /navigateFallback:\s*'\/index\.html'/.test(viteConfig),
  "the SPA catch-all is unchanged (navigateFallback: '/index.html')",
)

for (const expected of EXPECTED_DENYLIST) {
  assert(sources.includes(expected.source), `the denylist keeps ${expected}`)
}
assert(
  patterns.length === EXPECTED_DENYLIST.length,
  `the denylist has exactly ${EXPECTED_DENYLIST.length} entries (found ${patterns.length})`,
)

// --- Behaviour, not just text: the connector paths must hit the network -----

const CONNECTOR_PATHS = [
  '/oauth/authorize',
  '/oauth/register',
  '/oauth/token',
  '/mcp',
  '/mcp/',
  '/mcp-status',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
]
for (const pathname of CONNECTOR_PATHS) {
  assert(denied(pathname), `a navigation to ${pathname} bypasses the cached app shell`)
}

// --- ...and every other route must still be served by the app shell --------

const APP_ROUTES = ['/', '/dashboard', '/tracker', '/entries', '/settings', '/mcp-status-report']
for (const pathname of APP_ROUTES) {
  assert(!denied(pathname), `the app shell still answers ${pathname}`)
}

// --- Registration: one reload after deploy swaps the fixed worker in -------

assert(
  /registerType:\s*'autoUpdate'/.test(viteConfig),
  "registration stays registerType: 'autoUpdate' (installed workers self-update)",
)

// ===========================================================================
// netlify.toml — connector rewrites must outrank the SPA catch-all
// ===========================================================================

const netlifyToml = read('netlify.toml')

const redirects = [...netlifyToml.matchAll(/\[\[redirects\]\]([\s\S]*?)(?=\n\[\[redirects\]\]|\n\[functions|$)/g)].map(
  (match) => match[1],
)
const field = (block: string, name: string) =>
  block.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] ?? null
// `status = 200` is a bare TOML integer, not a string.
const numericField = (block: string, name: string) =>
  block.match(new RegExp(`^\\s*${name}\\s*=\\s*(\\d+)`, 'm'))?.[1] ?? null

const catchAllIndex = redirects.findIndex(
  (block) => field(block, 'from') === '/*' && field(block, 'to') === '/index.html',
)

assert(catchAllIndex !== -1, 'netlify.toml still ends with the /* → /index.html SPA catch-all')
assert(
  catchAllIndex === redirects.length - 1,
  'the SPA catch-all is still the LAST redirect rule (Netlify applies the first match)',
)

// Every connector route the site rewrites to a function. Derived from the file
// itself, so a new connector route added without a denylist entry fails here.
const connectorRewrites = redirects.filter((block) => {
  const from = field(block, 'from') ?? ''
  return from.startsWith('/oauth/') || from.startsWith('/.well-known/') || /^\/mcp(-status)?$/.test(from)
})

assert(
  connectorRewrites.length >= 7,
  `netlify.toml still rewrites all connector routes (found ${connectorRewrites.length})`,
)

for (const block of connectorRewrites) {
  const from = field(block, 'from') ?? ''
  assert(
    redirects.indexOf(block) < catchAllIndex,
    `the ${from} rewrite is above the SPA catch-all`,
  )
  assert(
    numericField(block, 'status') === '200',
    `the ${from} rewrite is a 200 rewrite, not a redirect (method and body survive)`,
  )
  assert(
    (field(block, 'to') ?? '').startsWith('/.netlify/functions/'),
    `the ${from} rewrite still targets its Netlify function`,
  )
  // The end-to-end guarantee: a route the server rewrites must also be denied
  // by the service worker, or a browser with the app installed never reaches
  // the function at all.
  assert(denied(from), `the service worker denies ${from} as well as the server rewriting it`)
}

const authorize = redirects.find((block) => field(block, 'from') === '/oauth/authorize')
assert(authorize !== undefined, 'the /oauth/authorize rewrite is present')
assert(
  field(authorize ?? '', 'to') === '/.netlify/functions/oauth-authorize',
  'the /oauth/authorize rewrite still points at the sign-in page function',
)

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exitCode = 1
}
